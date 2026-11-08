// Finding TVs without SSDP (a browser can't send multicast): ask every address in the
// usual home ranges for :8060/query/device-info, a few dozen at a time.

import { ECP_PORT, fetchWithTimeout, isPlainObject, parseTarget } from "./util.js";
import { parseDeviceInfo, summarize } from "./ecp.js";
import { getLocal, readSettings, setLocal } from "./store.js";

export const HOME_RANGES = ["192.168.0", "192.168.1", "10.0.0", "10.0.1"];
const CONCURRENCY = 48;
const PROBE_TIMEOUT = 800;

/** One quick look: the TV's summary, or null when nothing Roku-like answers. */
export async function probe(target, timeout = PROBE_TIMEOUT) {
  try {
    const resp = await fetchWithTimeout(`http://${target.host}:${target.port}/query/device-info`, {
      cache: "no-store", credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer",
    }, timeout);
    if (resp.status !== 200) return null;
    return summarize(target, parseDeviceInfo(await resp.text()));
  } catch {
    return null; // no answer, a timeout, or not a Roku
  }
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

/**
 * Find Rokus. Options (mostly for tests): ranges (like "192.168.1"), hosts (exact
 * addresses to try instead of ranges), port, timeout, remember (save what's found).
 */
export async function discover({ ranges = HOME_RANGES, hosts = null, port = ECP_PORT, timeout = PROBE_TIMEOUT, includeKnown = true, remember = true } = {}) {
  const candidates = new Map(); // "host:port" -> target
  const add = (address) => {
    try {
      const target = parseTarget(address);
      candidates.set(`${target.host}:${target.port}`, target);
    } catch { /* not a home address */ }
  };
  if (includeKnown) for (const address of await knownAddresses()) add(address);
  if (hosts) {
    for (const host of hosts) add(host.includes(":") ? host : `${host}:${port}`);
  } else {
    for (const range of ranges) for (let i = 1; i < 255; i++) add(`${range}.${i}:${port}`);
  }
  const found = (await pool([...candidates.values()], CONCURRENCY, (t) => probe(t, timeout))).filter(Boolean);
  const unique = new Map();
  for (const tv of found) if (!unique.has(tv.address)) unique.set(tv.address, tv);
  const tvs = [...unique.values()].sort((a, b) => {
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

