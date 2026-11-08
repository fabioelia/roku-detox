// Saved data in chrome.storage.local. The same shapes as roku_detox.py's files:
//   "settings"  -> remote-settings.json ({tvs: {address: {favorites, scenes, services, findHistory, rules, serial}}, sites})
//   "undoList"  -> undo-list.json
//   "events"    -> activity-log.json (newest last, at most 300)
//   "usage"     -> viewing-log.json ({address: {day: {app id: seconds}}})
//   "discovered", "lastTv", "tvOverride" -> extension-only conveniences

import {
  APP_ID_RE, ValueError, boundedInt, cut, displayAddress, isPlainObject, nowIso, parseTarget,
  pyStr, randomHex, truthy,
} from "./util.js";

const local = () => chrome.storage.local;

export async function getLocal(key, fallback) {
  const data = await local().get(key);
  return data[key] === undefined ? fallback : data[key];
}

export async function setLocal(key, value) {
  await local().set({ [key]: value });
}

// One write at a time, so read-change-save steps never interleave (like SETTINGS_LOCK).
let queue = Promise.resolve();
export function locked(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function readSettings() {
  const data = await getLocal("settings", {});
  return isPlainObject(data) ? data : {};
}

/** Read, change and save the settings in one locked step. change(data) may throw to cancel. */
export function updateSettings(change) {
  return locked(async () => {
    const data = await readSettings();
    const result = await change(data);
    await setLocal("settings", data);
    return result;
  });
}

export async function tvEntry(address) {
  const tvs = (await readSettings()).tvs;
  return (isPlainObject(tvs) && isPlainObject(tvs[address])) ? tvs[address] : {};
}

export async function tvSettings(address) {
  const tv = await tvEntry(address);
  return {
    favorites: tv.favorites ?? [],
    scenes: tv.scenes ?? [],
    services: tv.services ?? {},
  };
}

export function saveTvSettings(address, changes) {
  return updateSettings((data) => {
    if (!isPlainObject(data.tvs)) data.tvs = {};
    if (!isPlainObject(data.tvs[address])) data.tvs[address] = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value !== null && value !== undefined) data.tvs[address][key] = value;
    }
  });
}

// --- Cleaning what the page sends (same rules and messages as roku_detox.py) -------------

export const SCENE_STEPS = new Set(["power_on", "power_off", "open", "volume_up", "volume_down", "mute", "wait", "sleep_timer"]);
export const SCENE_ID_RE = /^[a-z0-9]{1,16}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SITE_ID_RE = /^[a-z0-9]{1,16}$/;

/** {app id: true/false} for 'I pay for this service'. */
export function cleanServices(raw) {
  if (!isPlainObject(raw) || Object.keys(raw).length > 100) throw new ValueError("Bad services list.");
  const services = {};
  for (const [appId, hasIt] of Object.entries(raw)) {
    if (!APP_ID_RE.test(String(appId))) throw new ValueError("Bad channel id.");
    services[String(appId)] = truthy(hasIt);
  }
  return services;
}

export function cleanFavorites(raw) {
  if (!Array.isArray(raw)) throw new ValueError("Bad shortcut list.");
  const favorites = [];
  for (const item of raw.slice(0, 24)) {
    const appId = pyStr(item);
    if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
    if (!favorites.includes(appId)) favorites.push(appId);
  }
  return favorites;
}

export function cleanScenes(raw) {
  if (!Array.isArray(raw) || raw.length > 20) throw new ValueError("Bad scene list.");
  const scenes = [];
  for (const item of raw) {
    if (!isPlainObject(item)) throw new ValueError("Bad scene.");
    const name = cut(pyStr(item.name ?? "").trim(), 40);
    if (!name) throw new ValueError("Give each scene a name.");
    const steps = [];
    const rawSteps = truthy(item.steps) ? item.steps : [];
    if (!Array.isArray(rawSteps)) throw new ValueError("Unknown scene step.");
    for (const step of rawSteps.slice(0, 20)) {
      const action = isPlainObject(step) ? step.do : null;
      if (!SCENE_STEPS.has(action)) throw new ValueError("Unknown scene step.");
      const clean = { do: action };
      if (action === "open") {
        const appId = pyStr(step.target ?? "");
        if (!APP_ID_RE.test(appId)) throw new ValueError(`Pick what to open in "${name}".`);
        clean.target = appId;
      } else if (action === "volume_up" || action === "volume_down") {
        clean.n = boundedInt(step.n, 1, 50);
      } else if (action === "wait") {
        clean.n = boundedInt(step.n, 1, 30);
      } else if (action === "sleep_timer") {
        clean.n = boundedInt(step.n, 1, 240);
      }
      steps.push(clean);
    }
    if (!steps.length) throw new ValueError(`"${name}" needs at least one step.`);
    const at = truthy(item.at) ? item.at : null;
    if (at !== null && !TIME_RE.test(pyStr(at))) throw new ValueError("Write times like 22:30.");
    let sceneId = truthy(item.id) ? pyStr(item.id) : "";
    if (!SCENE_ID_RE.test(sceneId)) sceneId = randomHex(4);
    scenes.push({ id: sceneId, name, steps, at });
  }
  return scenes;
}

export function cleanSites(raw) {
  if (!Array.isArray(raw) || raw.length > 20) throw new ValueError("You can add up to 20 sites.");
  const sites = [];
  for (const item of raw) {
    if (!isPlainObject(item)) throw new ValueError("Bad site.");
    const name = cut(pyStr(item.name ?? "").trim(), 40);
    const search = cut(pyStr(item.search ?? "").replace(/^[ \t\r\n\u00a0\ufeff]+|[ \t\r\n\u00a0\ufeff]+$/g, ""), 500);
    let parsed = null;
    try { parsed = new URL(search.replaceAll("{q}", "x")); } catch { parsed = null; }
    if (!name) throw new ValueError("Give each site a name.");
    if (/[\x00-\x20\x7f\\]/.test(search)) throw new ValueError(`The search address for "${name}" has a space or an odd character in it.`);
    const authority = /^https?:\/\/([^/?#]+)/i.exec(search);
    if (!authority) throw new ValueError(`The search address for "${name}" needs to start with https://`);
    // The words never pick the site's address.
    if (authority[1].includes("{q}")) throw new ValueError(`The {q} for "${name}" goes after the site's name, in the search part of the address.`);
    if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
      throw new ValueError(`The search address for "${name}" needs to start with https://`);
    }
    if (!search.includes("{q}")) throw new ValueError(`Put {q} in the search address for "${name}" where your search words go.`);
    let siteId = truthy(item.id) ? pyStr(item.id) : "";
    if (!SITE_ID_RE.test(siteId)) siteId = randomHex(4);
    const site = { id: siteId, name, search };
    if (item.deep === true) site.deep = true; // read in a hidden tab ("Look closer" worked for it)
    sites.push(site);
  }
  return sites;
}

export async function siteList() {
  const sites = (await readSettings()).sites || [];
  return Array.isArray(sites) ? sites : [];
}

export async function saveSites(raw) {
  const sites = cleanSites(raw);
  await updateSettings((data) => { data.sites = sites; });
  return sites;
}

// --- Undo list ---------------------------------------------------------------------------

export async function readLog() {
  const entries = await getLocal("undoList", []);
  return Array.isArray(entries) ? entries : [];
}

export async function appendLog(raw) {
  const action = raw.action;
  if (action !== "removed" && action !== "reinstalled") throw new ValueError("Unknown undo-list action.");
  const appId = pyStr(raw.id ?? "");
  if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
  const entry = {
    time: nowIso(),
    action,
    id: appId,
    name: cut(pyStr(raw.name ?? ""), 200),
    version: cut(pyStr(raw.version ?? ""), 64),
    tv: cut(pyStr(raw.tv ?? ""), 200),
    address: displayAddress(parseTarget(raw.address)),
  };
  await locked(async () => {
    const entries = await readLog();
    entries.push(entry);
    await setLocal("undoList", entries.slice(-2000));
  });
  return entry;
}

// --- Which TV the toolbar button sends to -----------------------------------------------------

export async function rememberTv(address) {
  try {
    if ((await getLocal("lastTv", null)) !== address) await setLocal("lastTv", address);
  } catch { /* storage unavailable: not important */ }
}

/** The options page's override, else the TV the page used last. */
export async function preferredTv() {
  const override = await getLocal("tvOverride", "");
  if (override) return override;
  return getLocal("lastTv", null);
}
