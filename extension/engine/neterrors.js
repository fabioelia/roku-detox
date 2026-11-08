// Why a request failed. fetch() only ever says "Failed to fetch"; Chrome tells the extension the
// real reason through webRequest. That tells "nothing is at that address" apart from "this computer
// stopped Chrome before the request left" (the Mac's Local Network setting, antivirus or a work VPN),
// which no amount of searching can get around.

const recent = new Map(); // "host:port" -> {error, at}
const MAX_KEPT = 1000;

// Chrome never got the request onto the network: something on this computer stopped it.
export const STOPPED_HERE = new Set([
  "net::ERR_SOCKET_NOT_CONNECTED",
  "net::ERR_NETWORK_ACCESS_DENIED",
  "net::ERR_ACCESS_DENIED",
  "net::ERR_BLOCKED_BY_ADMINISTRATOR",
  "net::ERR_BLOCKED_BY_PRIVATE_NETWORK_ACCESS_CHECKS",
  "net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS",
  "net::ERR_PROXY_CONNECTION_FAILED",
  "net::ERR_TUNNEL_CONNECTION_FAILED",
]);

let watching = false;

/** Start noting why the extension's own requests fail. Call once, at the service worker's top level. */
export function watchNetErrors() {
  const event = globalThis.chrome?.webRequest?.onErrorOccurred;
  if (watching || !event) return;
  watching = true;
  event.addListener((details) => {
    if (details.tabId !== -1) return; // only the extension's own requests, not the user's tabs
    if (details.error === "net::ERR_ABORTED") return; // we gave up waiting: not a reason
    let key;
    try {
      const url = new URL(details.url);
      key = `${url.hostname}:${url.port || "80"}`;
    } catch {
      return;
    }
    recent.delete(key);
    recent.set(key, { error: details.error, at: Date.now() });
    if (recent.size > MAX_KEPT) recent.delete(recent.keys().next().value);
  }, { urls: ["http://*/*"] });
}

/** For tests: pretend Chrome reported this error. */
export function noteNetError(host, port, error, at = Date.now()) {
  recent.set(`${host}:${port}`, { error, at });
}

/**
 * Chrome's reason the last request to host:port failed, if it failed at or after `since`.
 * The webRequest event can arrive a moment after fetch() rejects, so this waits briefly.
 */
export async function lastNetError(host, port, since, wait = 150) {
  const key = `${host}:${port}`;
  const until = Date.now() + (watching ? wait : 0);
  for (;;) {
    const hit = recent.get(key);
    if (hit && hit.at >= since) return hit.error;
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** How many requests since `since` were stopped on this computer, out of how many failed (and one such error). */
export function stoppedSince(since) {
  let stopped = 0;
  let failed = 0;
  let example = null;
  for (const { error, at } of recent.values()) {
    if (at < since) continue;
    failed++;
    if (STOPPED_HERE.has(error)) {
      stopped++;
      example = error;
    }
  }
  return { stopped, failed, error: example };
}

export function stoppedHereAdvice(error) {
  return `This computer stopped Chrome before it reached the TV (Chrome said ${error.replace("net::", "")}). `
    + "On a Mac: open System Settings, Privacy & Security, Local Network, and turn on Google Chrome "
    + "(if it's already on, turn it off and on again). Then quit Chrome completely (Command-Q) and open it again. "
    + "Antivirus or work security software can also block this; if this is a work computer, ask whoever manages it.";
}

/** Plain-language reason a request to the TV failed, from Chrome's error (or null when unknown). */
export function explainFailure(error, address) {
  if (error && STOPPED_HERE.has(error)) return stoppedHereAdvice(error);
  if (error === "net::ERR_BLOCKED_BY_CLIENT") {
    return "Another extension in this browser (an ad blocker or privacy tool) blocked the request to the TV. "
      + `Allow ${address} in that extension, or turn it off for this page.`;
  }
  if (error === "net::ERR_CONNECTION_REFUSED") {
    return `Something is at ${address}, but it isn't a Roku that's listening. Check the TV's address on the TV: `
      + "Settings, Network, About.";
  }
  if (error === "net::ERR_ADDRESS_UNREACHABLE") {
    return `Nothing answered at ${address}. Check the TV is on and the address is right (on the TV: Settings, Network, About). `
      + "If it is, the Mac may be blocking Chrome: System Settings, Privacy & Security, Local Network, turn on Google Chrome.";
  }
  return null;
}
