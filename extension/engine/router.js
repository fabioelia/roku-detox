// The app's HTTP API, answered inside the extension. Same routes, fields, status codes and
// error texts as roku_detox.py's Handler (see ENGINE.md). sw.js feeds it chrome.runtime messages.

import {
  APP_ID_RE, ECP_PORT, HttpError, MAX_BODY, NotSupported, ValueError, boundedInt, cut, displayAddress,
  fetchWithTimeout, isPlainObject, keepAlive, parseTarget, pyLen, pyStr, truthy,
} from "./util.js";
import {
  activeApp, canControl, deviceInfo, favoritesLink, fetchIcon, launch, listApps, nowPlaying, openStorePage, press,
  pushToTvApp, restart, runScene, search, settingsLink, summarize, tvAppPresent, typeText,
} from "./ecp.js";
import {
  appendLog, cleanFavorites, cleanScenes, cleanServices, getLocal, preferredTv, readLog, rememberTv, saveSites,
  saveTvSettings, setLocal, siteList, tvSettings,
} from "./store.js";
import {
  catalogId, findHistory, findNext, findSeason, findShow, findTitles, forgetHistory, pinHistory, recordHistory, watch,
} from "./catalog.js";
import { cast, lookCloser, searchSites, sniffedForTab, tvMessage } from "./video.js";
import { setSleep, sleepStatus } from "./sleep.js";
import { doPhrase } from "./phrases.js";
import { discoverReport } from "./discover.js";
import { cleanRules, doctor, extendBedtime, rulesStatus, saveRules, skipAutopilot, usageSummary } from "./rules.js";

export const VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch { return "1.0.0"; }
})();

const ok = () => ({ ok: true });

function appIdFrom(body) {
  const appId = pyStr(body.id ?? "");
  if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
  return appId;
}

function words(value, message, limit = 100) {
  const text = pyStr(value ?? "").trim();
  if (!(pyLen(text) > 0 && pyLen(text) <= limit)) throw new ValueError(message);
  return text;
}

function installerPage(value) {
  try {
    const { host, port } = parseTarget(value);
    return `http://${host}${port === ECP_PORT ? "" : `:${port}`}`;
  } catch {
    return "http://<your TV's address>";
  }
}

/** Is Roku's developer installer answering (developer mode on)? */
async function devModeOn(target) {
  const port = target.port === ECP_PORT ? 80 : target.port;
  try {
    await fetchWithTimeout(`http://${target.host}:${port}/`, { cache: "no-store", credentials: "omit", redirect: "manual" }, 1500);
    return true;
  } catch {
    return false;
  }
}

// Detox Home before 2.0 asked the Mac for everything over Wi-Fi.
const TV_APP_STANDALONE_VERSION = 2;

async function tvAppOptions(address) {
  const all = (await getLocal("tvAppOptions", {})) || {};
  const options = isPlainObject(all[address]) ? all[address] : {};
  return { simpleMode: Boolean(options.simpleMode), clock24: Boolean(options.clock24) };
}

async function tvAppStatus(target) {
  let dev = null;
  let installed;
  try {
    dev = (await listApps(target)).find((a) => a.id === "dev") || null;
    installed = Boolean(dev);
  } catch {
    installed = await tvAppPresent(target, 5);
  }
  const ours = Boolean(dev) && dev.name === "Detox Home";
  const major = /^\d+/.exec(dev?.version || "");
  return {
    installed,
    // Detox Home works on its own (ENGINE.md), so any copy of it just works.
    linked: ours,
    detoxHome: ours,
    version: dev?.version || "",
    outdated: ours && (major ? parseInt(major[0], 10) : 0) < TV_APP_STANDALONE_VERSION,
    devMode: await devModeOn(target),
    options: await tvAppOptions(displayAddress(target)),
    installedAt: null,
    ytdlp: false,
    appReady: true,
    engine: "extension",
    canInstall: false,
    installPage: installerPage(displayAddress(target)),
  };
}

const PHONE = "The phone remote needs the Roku Detox program at home.";
const HOUSEHOLD = "Sharing the page with everyone on your Wi-Fi needs the Roku Detox program at home.";

// Each route gets a context: {query, body, target(), address()}.
const GET_ROUTES = {
  "/api/discover": async () => discoverReport(),
  "/api/device": async (c) => {
    const target = c.target();
    const info = summarize(target, await deviceInfo(target));
    return { device: info, control: await canControl(target) };
  },
  "/api/apps": async (c) => ({ apps: await listApps(c.target()) }),
  "/api/active": async (c) => ({ app: await activeApp(c.target()) }),
  "/api/now": async (c) => ({ now: await nowPlaying(c.target()) }),
  "/api/find": async (c) => {
    const text = words(c.query.q, "Type a show or movie name.");
    return findTitles(c.target(), text);
  },
  "/api/find/show": async (c) => { const t = c.target(); return findShow(t, catalogId(c.query.id, "show")); },
  "/api/find/season": async (c) => { const t = c.target(); return findSeason(t, catalogId(c.query.id, "season")); },
  "/api/find/next": async (c) => {
    const number = pyStr(c.query.episode ?? "");
    if (!/^\d{1,6}$/.test(number)) throw new ValueError("Bad episode number.");
    const target = c.target();
    const showId = catalogId(c.query.show, "show");
    const seasonId = catalogId(c.query.season, "season");
    return findNext(target, showId, seasonId, parseInt(number, 10));
  },
  "/api/find/history": async (c) => findHistory(c.address()),
  "/api/rules": async (c) => rulesStatus(c.address()),
  "/api/doctor": async (c) => doctor(c.target()),
  "/api/tvapp": async (c) => tvAppStatus(c.target()),
  "/api/sites": async () => ({ sites: await siteList() }),
  "/api/sleep": async (c) => sleepStatus(c.address()),
  "/api/usage": async (c) => usageSummary(c.address()),
  "/api/sites/search": async (c) => ({ groups: await searchSites(words(c.query.q, "Type something to search for.")) }),
  "/api/log": async () => ({ entries: await readLog() }),
  "/api/settings": async (c) => tvSettings(c.address()),
  "/api/phone": async () => { throw new NotSupported(PHONE); },
  "/api/household": async () => { throw new NotSupported(HOUSEHOLD); },
  // Extension only: an icon as a data: URL (pages normally use the {type: "icon"} message).
  "/api/icon": async (c) => {
    const target = c.target();
    const appId = pyStr(c.query.id ?? "");
    if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
    const dataUrl = await fetchIcon(target, appId);
    if (!dataUrl) throw new HttpError(404, "No icon.");
    return { dataUrl };
  },
};

const POST_ROUTES = {
  "/api/key": async (c) => { const t = c.target(); await press(t, pyStr(c.body.key ?? "")); return ok(); },
  "/api/type": async (c) => {
    const text = pyStr(c.body.text ?? "");
    if (!(pyLen(text) > 0 && pyLen(text) <= 200)) throw new ValueError("Type between 1 and 200 characters.");
    await typeText(c.target(), text);
    return ok();
  },
  "/api/search": async (c) => {
    const keyword = words(c.body.text, "Type something to search for.");
    await search(c.target(), keyword);
    return ok();
  },
  "/api/link": async (c) => {
    const target = c.target();
    return cast(target, cut(pyStr(c.body.url ?? ""), 4000),
      cut(truthy(c.body.video) ? pyStr(c.body.video) : "", 4000) || null,
      cut(truthy(c.body.title) ? pyStr(c.body.title) : "", 200) || null);
  },
  "/api/watch": async (c) => {
    const target = c.target();
    await watch(target, pyStr(c.body.appId ?? ""),
      truthy(c.body.contentId) ? pyStr(c.body.contentId) : null,
      truthy(c.body.mediaType) ? pyStr(c.body.mediaType) : null);
    return ok();
  },
  "/api/store": async (c) => { const t = c.target(); await openStorePage(t, appIdFrom(c.body)); return ok(); },
  "/api/launch": async (c) => { const t = c.target(); await launch(t, appIdFrom(c.body)); return ok(); },
  "/api/restart": async (c) => { await restart(c.target()); return ok(); },
  "/api/log": async (c) => ({ entry: await appendLog(c.body) }),
  "/api/settings": async (c) => {
    const address = c.address();
    const b = c.body;
    await saveTvSettings(address, {
      favorites: "favorites" in b ? cleanFavorites(b.favorites) : null,
      scenes: "scenes" in b ? cleanScenes(b.scenes) : null,
      services: "services" in b ? cleanServices(b.services) : null,
    });
    const saved = await tvSettings(address);
    // Detox Home keeps its own copy: send it the new list.
    if ("favorites" in b) await pushToTvApp(parseTarget(address), "favorites", favoritesLink(saved.favorites));
    return saved;
  },
  "/api/scene": async (c) => {
    const target = c.target();
    const { scenes } = await tvSettings(displayAddress(target));
    const scene = (Array.isArray(scenes) ? scenes : []).find((s) => s && s.id === c.body.id);
    if (!scene) throw new ValueError("That scene doesn't exist anymore.");
    await runScene(target, scene);
    return ok();
  },
  "/api/rules": async (c) => {
    const address = c.address();
    await saveRules(address, cleanRules(c.body.rules));
    return rulesStatus(address);
  },
  "/api/rules/extend": async (c) => {
    const address = c.address();
    await extendBedtime(address, boundedInt(c.body.minutes, 5, 120));
    return rulesStatus(address);
  },
  "/api/rules/skip": async (c) => {
    const address = c.address();
    await skipAutopilot(address);
    return rulesStatus(address);
  },
  "/api/tvapp/install": async (c) => {
    throw new NotSupported(`Install Detox Home from the TV's own installer page: open ${installerPage(c.body.tv)} in your browser.`);
  },
  "/api/tvapp/remove": async (c) => {
    throw new NotSupported(`Remove Detox Home from the TV's own installer page: open ${installerPage(c.body.tv)} in your browser.`);
  },
  "/api/tvapp/options": async (c) => {
    const target = c.target();
    const address = displayAddress(target);
    const options = { simpleMode: truthy(c.body.simpleMode), clock24: truthy(c.body.clock24) };
    const all = (await getLocal("tvAppOptions", {})) || {};
    await setLocal("tvAppOptions", { ...(isPlainObject(all) ? all : {}), [address]: options });
    return { options, delivered: await pushToTvApp(target, "settings", settingsLink(options)) };
  },
  "/api/tv-message": async (c) => {
    const text = words(c.body.text, "Type a message of up to 200 characters.", 200);
    await tvMessage(c.target(), text);
    return ok();
  },
  "/api/sites": async (c) => ({ sites: await saveSites(c.body.sites) }),
  "/api/sleep": async (c) => setSleep(c.target(), c.body.minutes),
  "/api/do": async (c) => {
    const target = c.body.tv ? c.target() : parseTarget(await preferredTv() || "");
    return { done: await doPhrase(target, pyStr(c.body.do ?? ""), { strict: c.body.strict === true }) };
  },
  "/api/sites/look": async (c) => ({ group: await lookCloser(String(c.body.siteId ?? ""), words(c.body.q, "Type something to search for.")) }),
  "/api/phone": async () => { throw new NotSupported(PHONE); },
  "/api/pair": async () => { throw new NotSupported(PHONE); },
  "/api/household": async () => { throw new NotSupported(HOUSEHOLD); },
  "/api/find/history": async (c) => recordHistory(c.address(), c.body.item),
  "/api/find/history/remove": async (c) => forgetHistory(c.address(), c.body.id),
  "/api/find/history/pin": async (c) => pinHistory(c.address(), c.body.id, c.body.pinned),
};

function errorResponse(err) {
  if (err instanceof HttpError) return { status: err.status, data: { error: err.message, ...err.extra } };
  console.error("Roku Detox:", err);
  return { status: 500, data: { error: "Something went wrong inside the Roku Detox extension. Try again." } };
}

/** Query values from the path's own ?query and the message's query object (like parse_qs: blanks dropped). */
function readQuery(rawPath, query) {
  const out = {};
  const mark = rawPath.indexOf("?");
  if (mark !== -1) {
    for (const [k, v] of new URLSearchParams(rawPath.slice(mark + 1))) if (v && !(k in out)) out[k] = v;
  }
  if (query !== undefined && query !== null) {
    if (!isPlainObject(query)) throw new HttpError(400, "Bad request.");
    for (const [k, v] of Object.entries(query).slice(0, 30)) {
      if (typeof v === "string" || typeof v === "number") {
        const text = String(v);
        if (text && text.length <= 4000) out[k] = text;
      }
    }
  }
  return out;
}

/** One API request: {method, path, query, body} -> {status, data}. */
export async function apiRequest({ method = "GET", path, query, body } = {}) {
  try {
    if (method !== "GET" && method !== "POST") return { status: 404, data: { error: "Not found." } };
    if (typeof path !== "string" || path.length > 4500 || !path.startsWith("/")) return { status: 400, data: { error: "Bad request." } };
    const route = path.split("?")[0];
    const q = readQuery(path, query);
    let b = {};
    if (method === "POST") {
      if (body !== undefined && body !== null) {
        if (!isPlainObject(body)) return { status: 400, data: { error: "Bad request." } };
        let size;
        try { size = JSON.stringify(body).length; } catch { return { status: 400, data: { error: "Bad request." } }; }
        if (size > MAX_BODY) return { status: 413, data: { error: "Request too large." } };
        b = body;
      }
    }
    const handler = (method === "GET" ? GET_ROUTES : POST_ROUTES)[route];
    if (!handler || !Object.prototype.hasOwnProperty.call(method === "GET" ? GET_ROUTES : POST_ROUTES, route)) {
      return { status: 404, data: { error: "Not found." } };
    }
    let used = null;
    const target = () => {
      const t = parseTarget(method === "GET" ? q.tv : b.tv);
      used = displayAddress(t);
      return t;
    };
    const context = { query: q, body: b, target, address: () => displayAddress(target()) };
    const data = await keepAlive(handler(context));
    // Actions pick "the TV" for the toolbar, shortcuts and address bar; the page's polling (GETs) only
    // fills it in when there's none, so switching TVs in the popup sticks while the page is open.
    if (used && (method !== "GET" || !(await getLocal("lastTv", null)))) rememberTv(used);
    return { status: 200, data };
  } catch (err) {
    return errorResponse(err);
  }
}

/** An icon for <img data-icon-tv data-icon-id>: {dataUrl} (null when the TV has none). */
async function iconMessage(msg) {
  try {
    const target = parseTarget(msg.tv);
    const appId = typeof msg.id === "string" ? msg.id : "";
    if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
    return { dataUrl: await fetchIcon(target, appId) };
  } catch (err) {
    return { dataUrl: null, error: err instanceof HttpError ? err.message : "Couldn't load the icon." };
  }
}

/**
 * Every message the extension answers. internal = from this extension's own pages
 * (popup, options, side panel, app tab); external = from an allowed web page.
 */
export async function handleMessage(msg, { internal = false } = {}) {
  if (!isPlainObject(msg) || typeof msg.type !== "string") return { status: 400, data: { error: "Bad request." } };
  switch (msg.type) {
    case "ping":
      return { ok: true, version: VERSION, engine: "extension" };
    case "api":
      return apiRequest(msg);
    case "icon":
      return iconMessage(msg);
    case "sniffed":
      if (!internal || !Number.isInteger(msg.tabId)) break;
      return sniffedForTab(msg.tabId);
    case "tv":
      if (!internal) break;
      return { tv: await preferredTv() };
    default:
      break;
  }
  return { status: 400, data: { error: "Bad request." } };
}
