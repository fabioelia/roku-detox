// Roku Detox service worker: answers the page's API (ENGINE.md) from inside the browser.
// Listeners are registered at the top level so Chrome can wake the worker for them.

import { handleMessage } from "./engine/router.js";
import { installEcpHeaderRule } from "./engine/ecp.js";
import { initSniffer } from "./engine/video.js";
import { ALARM, ensureAlarm, runBurst } from "./engine/rules.js";
import { newRelayKey, relayInfo, startRelay } from "./engine/relay-host.js";
import { watchNetErrors } from "./engine/neterrors.js";
import { onSleepAlarm } from "./engine/sleep.js";
import { onCommand, onMenuClick, setUpMenus, setUpOmnibox } from "./engine/shortcuts.js";

const EXTERNAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

function fromOurPages(sender) {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

function fromAllowedSite(sender) {
  try {
    const url = new URL(sender.origin || sender.url);
    return url.protocol === "http:" && EXTERNAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function reply(promise, sendResponse) {
  promise.then(sendResponse, (err) => {
    console.error("Roku Detox:", err);
    sendResponse({ status: 500, data: { error: "Something went wrong inside the Roku Detox extension. Try again." } });
  });
  return true; // answer asynchronously
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!fromOurPages(sender)) return false;
  // The options page manages the phone relay.
  if (msg && msg.type === "relay-info") return reply(relayInfo(), sendResponse);
  if (msg && msg.type === "relay-new-key") return reply(newRelayKey(), sendResponse);
  return reply(handleMessage(msg, { internal: true }), sendResponse);
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!fromAllowedSite(sender)) {
    sendResponse({ status: 403, data: { error: "Forbidden." } });
    return false;
  }
  return reply(handleMessage(msg, { internal: false }), sendResponse);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith("detox-sleep:")) {
    onSleepAlarm(alarm);
    return;
  }
  if (alarm.name === ALARM) {
    runBurst();
    startRelay(); // reconnect the phone relay if the worker was asleep
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("relayUrl" in changes || "relayKey" in changes)) startRelay();
});

function setUp() {
  ensureAlarm();
  setUpMenus();
  installEcpHeaderRule();
}

// When the browser starts (or the extension is installed or updated), check the TVs right away.
chrome.runtime.onInstalled.addListener(() => { setUp(); runBurst(); });
chrome.runtime.onStartup.addListener(() => { setUp(); runBurst(); });

// Right-click menu, "tv" in the address bar, keyboard shortcuts.
chrome.contextMenus?.onClicked.addListener((info, tab) => { onMenuClick(info, tab); });
chrome.commands?.onCommand.addListener((command, tab) => { onCommand(command, tab); });
setUpOmnibox();

watchNetErrors();
initSniffer();
setUp();
startRelay();
