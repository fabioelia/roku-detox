// Other ways in: the right-click menu, the "tv" keyword in the address bar, and keyboard shortcuts.
// They all act on the TV the extension used last (or the one picked on the options page), through the
// same API the page uses.

import { handleMessage } from "./router.js";
import { preferredTv } from "./store.js";

const NO_TV = "Pick your TV first: open Roku Detox from the toolbar button.";

function notify(message, title = "Roku Detox") {
  try {
    chrome.notifications.create("", {
      type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title, message, priority: 0,
    }, () => void chrome.runtime.lastError);
  } catch { /* not important */ }
}

/** One API call for the current TV. Resolves to the reply's data; rejects with a plain-English error. */
async function tvCall(method, path, fields = {}) {
  const tv = await preferredTv();
  if (!tv) throw new Error(NO_TV);
  const msg = method === "GET"
    ? { type: "api", method, path, query: { tv, ...fields }, body: null }
    : { type: "api", method, path, query: {}, body: { tv, ...fields } };
  const reply = await handleMessage(msg, { internal: true });
  if (!reply || reply.status >= 300) throw new Error(reply?.data?.error || "The TV didn't answer.");
  return reply.data;
}

async function attempt(work, done) {
  try {
    const result = await work();
    if (done) notify(typeof done === "function" ? done(result) : done);
  } catch (err) {
    notify(err.message, "Couldn't do that");
  }
}

const playingText = (result, fallback) => (result && result.app ? `Opening in ${result.app} on the TV.` : fallback);

// --- Right-click menu -----------------------------------------------------------------------

const MENU = [
  { id: "send-video", title: "Play this video on the TV", contexts: ["video"] },
  { id: "send-link", title: "Send this link to the TV", contexts: ["link"] },
  { id: "send-page", title: "Send this page's video to the TV", contexts: ["page"] },
  { id: "search-tv", title: "Search the TV for “%s”", contexts: ["selection"] },
];

export function setUpMenus() {
  const menus = globalThis.chrome?.contextMenus;
  if (!menus) return;
  menus.removeAll(() => {
    for (const item of MENU) {
      menus.create({ ...item, documentUrlPatterns: ["http://*/*", "https://*/*"] }, () => void chrome.runtime.lastError);
    }
  });
}

async function bestVideoFor(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return "";
  try {
    const sniffed = await handleMessage({ type: "sniffed", tabId }, { internal: true });
    return sniffed?.best?.url || "";
  } catch {
    return "";
  }
}

export async function onMenuClick(info, tab) {
  const title = tab?.title || "";
  if (info.menuItemId === "send-video") {
    const direct = info.srcUrl && /^https?:/.test(info.srcUrl) ? info.srcUrl : await bestVideoFor(tab?.id);
    await attempt(() => tvCall("POST", "/api/link", { url: info.pageUrl || tab?.url || "", video: direct, title }),
      (r) => playingText(r, "Playing on the TV."));
  } else if (info.menuItemId === "send-link") {
    await attempt(() => tvCall("POST", "/api/link", { url: info.linkUrl, video: "", title: "" }),
      (r) => playingText(r, "Playing on the TV."));
  } else if (info.menuItemId === "send-page") {
    const video = await bestVideoFor(tab?.id);
    await attempt(() => tvCall("POST", "/api/link", { url: info.pageUrl || tab?.url || "", video, title }),
      (r) => playingText(r, "Playing on the TV."));
  } else if (info.menuItemId === "search-tv") {
    const text = String(info.selectionText || "").trim().slice(0, 100);
    if (text) await attempt(() => tvCall("POST", "/api/search", { text }), `Searching the TV for “${text}”.`);
  }
}

// --- Keyboard shortcuts (set or change them at chrome://extensions/shortcuts) ----------------

const COMMAND_KEYS = {
  "play-pause": "Play",
  "volume-up": "VolumeUp",
  "volume-down": "VolumeDown",
  mute: "VolumeMute",
  "tv-home": "Home",
  "tv-back": "Back",
};

export async function onCommand(command, tab) {
  if (command === "send-tab") {
    const current = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!current || !/^https?:/.test(current.url || "")) {
      notify("There's nothing to send from this tab.", "Couldn't do that");
      return;
    }
    const video = await bestVideoFor(current.id);
    await attempt(() => tvCall("POST", "/api/link", { url: current.url, video, title: current.title || "" }),
      (r) => playingText(r, "Playing on the TV."));
    return;
  }
  const key = COMMAND_KEYS[command];
  if (key) await attempt(() => tvCall("POST", "/api/key", { key }), null); // quiet when it works: you'll see it on the TV
}

// --- "tv" in the address bar -----------------------------------------------------------------

const KEY_WORDS = [
  [["pause", "play", "resume"], "Play", "Play or pause"],
  [["home"], "Home", "Go to the home screen"],
  [["back"], "Back", "Go back"],
  [["mute", "unmute"], "VolumeMute", "Mute or unmute"],
  [["louder", "volume up", "vol up"], "VolumeUp", "Turn the volume up"],
  [["quieter", "softer", "volume down", "vol down"], "VolumeDown", "Turn the volume down"],
  [["off", "turn off", "power off"], "PowerOff", "Turn the TV off"],
  [["on", "turn on", "power on"], "PowerOn", "Turn the TV on"],
];

let appCache = { tv: null, at: 0, apps: [] };
let sceneCache = { scenes: [] }; // the last list read, to name the scene once it's picked

// Scenes are read fresh every time (they're kept on this computer), so a new one shows up at once.
async function scenesForOmnibox() {
  if (!(await preferredTv())) return [];
  try {
    const { scenes } = await tvCall("GET", "/api/settings");
    sceneCache = { scenes: Array.isArray(scenes) ? scenes : [] };
  } catch {
    sceneCache = { scenes: [] };
  }
  return sceneCache.scenes;
}

async function appsForOmnibox() {
  const tv = await preferredTv();
  if (!tv) return [];
  if (appCache.tv === tv && Date.now() - appCache.at < 5 * 60 * 1000) return appCache.apps;
  try {
    const { apps } = await tvCall("GET", "/api/apps");
    appCache = { tv, at: Date.now(), apps: Array.isArray(apps) ? apps : [] };
  } catch {
    appCache = { tv, at: Date.now(), apps: [] };
  }
  return appCache.apps;
}

/** What a numbered or input phrase will do, in words, or "" (the same patterns as phrases.js). */
function phraseLabel(folded) {
  let m = /^(?:sleep|sleep timer|turn off in|off in|sleep in)(?: for)? (\d{1,3})(?: ?(?:m|min|mins|minute|minutes))?$/.exec(folded);
  if (m) return Number(m[1]) ? `Turn the TV off in ${Number(m[1])} minutes` : "Turn the sleep timer off";
  if (["cancel sleep", "sleep off", "stop sleep timer", "cancel sleep timer"].includes(folded)) return "Turn the sleep timer off";
  m = /^(?:volume |turn it )?(up|down) (\d{1,2})$/.exec(folded);
  if (m) return `Volume ${m[1]} ${m[2]}`;
  m = /^(?:open |go to |switch to )?hdmi ?(\d)$/.exec(folded);
  if (m) return `Switch to HDMI ${m[1]}`;
  return "";
}

const xml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isLink = (text) => /^https?:\/\/\S+$/i.test(text);
const fold = (text) => text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]+/gu, "").replace(/\s+/g, " ").trim();

/** What "tv <text>" could mean, best first: [{content, description}]. */
export async function omniboxSuggestions(text) {
  const words = text.trim();
  if (!words) return [];
  const out = [];
  if (isLink(words)) {
    out.push({ content: `link:${words}`, description: `Send <url>${xml(words)}</url> to the TV` });
    return out;
  }
  const folded = fold(words);
  if (!folded) { // only punctuation: nothing to match, so don't let every scene and app match ""
    return [
      { content: `search:${words}`, description: `Search the TV for <match>${xml(words)}</match>` },
    ];
  }
  for (const [names, key, label] of KEY_WORDS) {
    if (names.some((n) => n === folded)) out.push({ content: `key:${key}`, description: `${xml(label)} <dim>on the TV</dim>` });
  }
  // Phrases with a number or an input ("sleep 30", "volume up 5", "hdmi 2", "cancel sleep").
  const said = phraseLabel(folded);
  if (said) out.push({ content: `do:${words}`, description: `${xml(said)} <dim>on the TV</dim>` });
  for (const scene of (await scenesForOmnibox()).filter((sc) => sc && typeof sc.name === "string" && fold(sc.name).includes(folded)).slice(0, 3)) {
    out.push({ content: `scene:${scene.id}`, description: `Run <match>${xml(scene.name)}</match> <dim>(your scene)</dim>` });
  }
  const apps = await appsForOmnibox();
  const matches = apps
    .filter((app) => app && typeof app.name === "string" && fold(app.name).includes(folded))
    .sort((a, b) => fold(a.name).indexOf(folded) - fold(b.name).indexOf(folded))
    .slice(0, 4);
  for (const app of matches) {
    out.push({ content: `open:${app.id}`, description: `Open <match>${xml(app.name)}</match> <dim>on the TV</dim>` });
  }
  out.push({ content: `find:${words}`, description: `Find <match>${xml(words)}</match> <dim>in Roku Detox: which of your apps has it</dim>` });
  out.push({ content: `search:${words}`, description: `Search the TV for <match>${xml(words)}</match>` });
  return out;
}

export function setUpOmnibox() {
  const omnibox = globalThis.chrome?.omnibox;
  if (!omnibox) return;
  omnibox.setDefaultSuggestion({ description: "Type a show, an app (Netflix), a scene, pause, home, louder, or paste a link" });
  omnibox.onInputChanged.addListener((text, suggest) => {
    omniboxSuggestions(text).then((list) => {
      // The first suggestion becomes the default action; the rest are listed below it.
      if (list.length) omnibox.setDefaultSuggestion({ description: list[0].description });
      suggest(list.slice(1));
    }, () => suggest([]));
  });
  omnibox.onInputEntered.addListener(async (text, disposition) => {
    let choice = text.trim();
    if (!/^(link|key|open|find|search|scene|do):/.test(choice)) choice = (await omniboxSuggestions(choice))[0]?.content || "";
    const at = choice.indexOf(":");
    const kind = choice.slice(0, at);
    const value = choice.slice(at + 1);
    if (kind === "find") {
      const url = chrome.runtime.getURL(`app/index.html#find=${encodeURIComponent(value)}`);
      if (disposition === "currentTab") await chrome.tabs.update({ url });
      else await chrome.tabs.create({ url, active: disposition !== "newBackgroundTab" });
    } else if (kind === "link") {
      await attempt(() => tvCall("POST", "/api/link", { url: value, video: "", title: "" }), (r) => playingText(r, "Playing on the TV."));
    } else if (kind === "key") {
      await attempt(() => tvCall("POST", "/api/key", { key: value }), null);
    } else if (kind === "open") {
      const app = appCache.apps.find((a) => a.id === value);
      await attempt(() => tvCall("POST", "/api/launch", { id: value }), `Opening ${app ? app.name : "it"} on the TV.`);
    } else if (kind === "do") {
      await attempt(() => tvCall("POST", "/api/do", { do: value }), (r) => r.done);
    } else if (kind === "scene") {
      const scene = sceneCache.scenes.find((sc) => sc.id === value);
      await attempt(() => tvCall("POST", "/api/scene", { id: value }), `Ran ${scene ? scene.name : "your scene"}.`);
    } else if (kind === "search") {
      await attempt(() => tvCall("POST", "/api/search", { text: value.slice(0, 100) }), `Searching the TV for “${value}”.`);
    }
  });
}
