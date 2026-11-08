// Finding TVs without SSDP (a browser can't send multicast): ask every address in the
// usual home ranges for :8060/query/device-info, a few dozen at a time.

import { ECP_PORT, fetchWithTimeout, isPlainObject, parseTarget } from "./util.js";
import { parseDeviceInfo, summarize } from "./ecp.js";
import { getLocal, readSettings, setLocal } from "./store.js";

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
const LOCAL_CONCURRENCY = 32;
const PROBE_TIMEOUT = 700;
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
export async function discover({ ranges = null, hosts = null, port = ECP_PORT, timeout = PROBE_TIMEOUT, includeKnown = true, remember = true } = {}) {
  const found = new Map();
  const seen = new Set();
  const run = async (targets, limit = CONCURRENCY) => {
    const fresh = targets.filter((t) => !seen.has(`${t.host}:${t.port}`));
    for (const t of fresh) seen.add(`${t.host}:${t.port}`);
    for (const tv of await pool(fresh, limit, (t) => probe(t, timeout))) {
      if (tv && !found.has(tv.address)) found.set(tv.address, tv);
    }
  };

  if (includeKnown) await run(targetsFor(await knownAddresses(), port));
  if (hosts) {
    await run(targetsFor(hosts, port));
  } else if (!found.size) {
    const candidates = ranges || COMMON_RANGES;
    const local = [];
    const flags = await Promise.all(candidates.map((range) => looksLocal(range)));
    candidates.forEach((range, i) => { if (flags[i]) local.push(range); });
    const rest = (ranges || HOME_RANGES).filter((range) => !local.includes(range));
    for (const group of [local, rest]) {
      for (const range of group) {
        const addresses = [];
        for (let i = 1; i < 255; i++) addresses.push(`${range}.${i}`);
        await run(targetsFor(addresses, port), group === local ? LOCAL_CONCURRENCY : CONCURRENCY);
      }
      if (found.size) break; // found on this computer's network: don't sweep the others
    }
  }

  const tvs = [...found.values()].sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (remember && tvs.length) await setLocal("discovered", tvs.slice(0, 20));
  return tvs;
}

/** The /24 range a TV's address is in, like "192.168.1". */
export function rangeOf(target) {
  return target.host.split(".").slice(0, 3).join(".");
}

