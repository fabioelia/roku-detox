// Finding TVs without SSDP (a browser can't send multicast): ask every address in the
// usual home ranges for :8060/query/device-info, a few dozen at a time.

import { ECP_PORT, fetchWithTimeout, isPlainObject, parseTarget } from "./util.js";
import { parseDeviceInfo, summarize } from "./ecp.js";
import { getLocal, readSettings, setLocal } from "./store.js";
import { STOPPED_HERE, lastNetError, stoppedHereAdvice, stoppedSince } from "./neterrors.js";

// Ranges scanned when none of the common ones looks like this computer's own network.
export const HOME_RANGES = ["192.168.0", "192.168.1", "10.0.0", "10.0.1"];
// Common home ranges, checked cheaply (two requests each) to find which one this computer is on.
export const COMMON_RANGES = [
  "192.168.0", "192.168.1", "192.168.2", "192.168.4", "192.168.8", "192.168.10", "192.168.50",
  "192.168.68", "192.168.86", "192.168.100", "10.0.0", "10.0.1", "10.1.1", "10.1.10", "172.16.0",
];
// Chrome only keeps so many connections open. Requests to empty addresses hang in the background
// even after we give up on them, so a big burst starves later ones (the TV's included).
const CONCURRENCY = 16;
// On this computer's own network, empty addresses fail fast (nothing answers the "who has this
// address?" question), so more can run at once without starving the connection limit.
const LOCAL_CONCURRENCY = 16;
// The TV answers in well under 0.2 s on its own, but a sweep floods the Wi-Fi with "who has this
// address?" broadcasts and its answer can then take a second or two.
const PROBE_TIMEOUT = 1500;
const ROUTER_HOSTS = [1, 254];
const QUIET = { cache: "no-store", credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer" };

/** One quick look: the TV's summary, or null when nothing Roku-like answers. */
export async function probe(target, timeout = PROBE_TIMEOUT) {
  try {
    const resp = await fetchWithTimeout(`http://${target.host}:${target.port}/query/device-info`, QUIET, timeout);
    if (resp.status !== 200) return null;
    return summarize(target, parseDeviceInfo(await resp.text()));
  } catch {
    return null; // no answer, a timeout, or not a Roku
  }
}

/**
 * Is this range probably the computer's own network? Its router answers its settings page (port 80)
 * at once, or refuses at once, while addresses on other networks just hang. (Port 80, not the TV's
 * port: many routers silently drop requests to ports they don't use.)
 */
export async function looksLocal(range) {
  const checks = ROUTER_HOSTS.map(async (n) => {
    const started = Date.now();
    try {
      await fetchWithTimeout(`http://${range}.${n}/`, QUIET, 600);
      return true;
    } catch {
      return Date.now() - started < 450;
    }
  });
  return (await Promise.all(checks)).some(Boolean);
}

/** Run fn over items with at most `limit` running at once. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Addresses this extension already knows: TVs found before and TVs with saved settings. */
async function knownAddresses() {
  const known = new Set();
  for (const tv of (await getLocal("discovered", [])) || []) if (tv && typeof tv.address === "string") known.add(tv.address);
  const tvs = (await readSettings()).tvs;
  if (isPlainObject(tvs)) for (const address of Object.keys(tvs)) known.add(address);
  const last = await getLocal("lastTv", null);
  if (last) known.add(last);
  return [...known];
}

function targetsFor(addresses, port) {
  const targets = new Map(); // "host:port" -> target
  for (const address of addresses) {
    try {
      const target = parseTarget(address.includes(":") ? address : `${address}:${port}`);
      targets.set(`${target.host}:${target.port}`, target);
    } catch { /* not a home address */ }
  }
  return [...targets.values()];
}

/**
 * Find Rokus, quickly:
 *   1. TVs seen before (usually the answer, in a fraction of a second);
 *   2. otherwise the range this computer is on, found by asking the usual router addresses;
 *   3. only if that finds nothing, the other likely ranges, one at a time.
 * Options (mostly for tests): ranges (like "192.168.1"), hosts (exact addresses to try instead of
 * ranges), port, timeout, includeKnown, remember (save what's found).
 */
export async function discover(options = {}) {
  return (await discoverReport(options)).tvs;
}

/**
 * discover(), plus a hint when nothing was found for a reason the user can fix: {tvs, hint}.
 * When this computer is stopping Chrome from reaching the home network, searching is pointless
 * (and hundreds of blocked requests look like an attack to security software), so it stops early.
 */
export async function discoverReport({ ranges = null, hosts = null, port = ECP_PORT, timeout = PROBE_TIMEOUT, includeKnown = true, remember = true } = {}) {
  let hint = null;
  const stoppedBy = async (targets, since) => {
    for (const t of targets) {
      const error = await lastNetError(t.host, String(t.port), since);
      if (error && STOPPED_HERE.has(error)) return error;
    }
    return null;
  };
  const found = new Map();
  const seen = new Set();
  const run = async (targets, limit = CONCURRENCY) => {
    const fresh = targets.filter((t) => !seen.has(`${t.host}:${t.port}`));
    for (const t of fresh) seen.add(`${t.host}:${t.port}`);
    for (const tv of await pool(fresh, limit, (t) => probe(t, timeout))) {
      if (tv && !found.has(tv.address)) found.set(tv.address, tv);
    }
  };

  const started = Date.now();
  const note = (text) => console.info(`Roku Detox search (${((Date.now() - started) / 1000).toFixed(1)} s): ${text}`);
  if (includeKnown) {
    const known = targetsFor(await knownAddresses(), port);
    if (known.length) {
      const since = Date.now();
      await run(known);
      note(`tried ${known.length} TV address(es) seen before: ${found.size ? "found" : "no answer"}.`);
      const error = found.size ? null : await stoppedBy(known, since);
      if (error) {
        hint = stoppedHereAdvice(error);
        note(`Chrome said ${error}: this computer is blocking Chrome from the home network, so there's no point searching.`);
      }
    }
  }
  if (hosts) {
    const since = Date.now();
    const targets = targetsFor(hosts, port);
    await run(targets);
    const error = found.size ? null : await stoppedBy(targets, since);
    if (error) hint = stoppedHereAdvice(error);
  } else if (!found.size && !hint) {
    // Ranges passed in come from a TV we knew (rules re-finding a TV that moved), so they're swept
    // as given. Otherwise only ranges that look like this computer's own network are swept:
    // sweeping a range that isn't (its addresses just hang) uses up Chrome's connection limit.
    let sweep = ranges;
    if (!sweep) {
      const since = Date.now();
      const flags = await Promise.all(COMMON_RANGES.map((range) => looksLocal(range)));
      sweep = COMMON_RANGES.filter((range, i) => flags[i]);
      const routers = targetsFor(sweep.flatMap((range) => ROUTER_HOSTS.map((n) => `${range}.${n}`)), 80);
      const error = await stoppedBy(routers, since);
      if (error) {
        hint = stoppedHereAdvice(error);
        note(`Chrome said ${error} for the router: this computer is blocking Chrome from the home network, so there's no point searching.`);
        sweep = [];
      } else {
        note(sweep.length ? `this computer looks to be on ${sweep.map((r) => `${r}.x`).join(", ")}.`
          : "couldn't tell which network this computer is on, so nothing was swept. Type the TV's address instead.");
      }
    }
    for (const range of sweep) {
      const sweepStarted = Date.now();
      const addresses = [];
      for (let i = 1; i < 255; i++) addresses.push(`${range}.${i}`);
      const targets = targetsFor(addresses, port);
      await run(targets, ranges ? CONCURRENCY : LOCAL_CONCURRENCY);
      note(`swept ${range}.1 to ${range}.254: ${found.size ? [...found.keys()].join(", ") : "no TV"}.`);
      const { stopped, failed, error } = stoppedSince(sweepStarted);
      if (!found.size && stopped && stopped >= failed / 2) {
        hint = stoppedHereAdvice(error);
        note(`${stopped} of ${failed} failed requests were stopped on this computer, not by the network.`);
        break;
      }
      if (!found.size) {
        // One more pass: the computer now remembers which addresses are empty, so they fail at
        // once and the TV's answer isn't crowded out.
        for (const t of targets) seen.delete(`${t.host}:${t.port}`);
        await run(targets, ranges ? CONCURRENCY : LOCAL_CONCURRENCY);
        note(`second pass over ${range}.x: ${found.size ? [...found.keys()].join(", ") : "no TV"}.`);
      }
      if (found.size) break;
    }
  }
  note(found.size ? `done, found ${[...found.keys()].join(", ")}.` : "done, no TV found.");

  const tvs = [...found.values()].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (remember && tvs.length) await setLocal("discovered", tvs.slice(0, 20));
  return { tvs, hint: tvs.length ? null : hint };
}

/** The /24 range a TV's address is in, like "192.168.1". */
export function rangeOf(target) {
  return target.host.split(".").slice(0, 3).join(".");
}

