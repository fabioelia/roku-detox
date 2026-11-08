// Lets phones use this extension through the encrypted relay (relay/README.md).
// Off until a relay address is saved on the options page. The household key never leaves
// this browser except inside the phone link you choose to share.

import { RelayHost, relayOrigin } from "../relay/relay-client.js";
import { newHouseholdKey } from "../relay/relay-crypto.js";
import { handleMessage } from "./router.js";

let host = null;
let status = "stopped";

async function relaySettings() {
  const { relayUrl = "", relayKey = "" } = await chrome.storage.local.get(["relayUrl", "relayKey"]);
  return { relayUrl, relayKey };
}

export async function startRelay() {
  const { relayUrl, relayKey } = await relaySettings();
  if (!relayUrl) {
    stopRelay();
    return;
  }
  let key = relayKey;
  if (!key) {
    key = newHouseholdKey();
    await chrome.storage.local.set({ relayKey: key });
  }
  const origin = relayOrigin(relayUrl);
  if (host && host.relay === origin && host.key === key) {
    host.start(); // safe to call again; reconnects if the worker was asleep
    return;
  }
  stopRelay();
  host = new RelayHost({
    relay: origin,
    key,
    // Phones are outside callers: same rules as other web pages (no internal-only messages).
    handle: (msg) => handleMessage(msg, { internal: false }),
    onStatus: (next) => { status = next; },
  });
  host.start();
}

export function stopRelay() {
  if (host) host.stop();
  host = null;
  status = "stopped";
}

/** For the options page: {status, link}. */
export async function relayInfo() {
  const { relayUrl } = await relaySettings();
  return { status: relayUrl ? status : "off", relayUrl, link: host ? host.link() : null };
}

/** Makes a new household key, so every phone that had the old link stops working. */
export async function newRelayKey() {
  await chrome.storage.local.set({ relayKey: newHouseholdKey() });
  stopRelay();
  await startRelay();
  return relayInfo();
}
