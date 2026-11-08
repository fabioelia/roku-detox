// Sending a web page's video to the TV, and "My sites" search.
// A port of roku_detox.py's parse_link / find_video / search_site, plus a media sniffer:
// videos this browser actually played are the best answer, so they're tried first.

import { launch, showOnTv } from "./ecp.js";
import { saveSites, siteList } from "./store.js";
import { TVError, ValueError, cut, pyLen, quotePlus, unescapeHtml } from "./util.js";

// --- YouTube and Netflix links ------------------------------------------------------------

const YOUTUBE_HOSTS = new Set(["youtube.com", "youtu.be", "music.youtube.com", "youtube-nocookie.com"]);
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** A YouTube or Netflix link -> the app and deep-link parameters to open it, else null. */
export function parseLink(link) {
  let url = null;
  try { url = new URL(String(link).trim()); } catch { url = null; }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new ValueError("Paste the whole link, starting with https://");
  }
  let host = url.hostname.toLowerCase();
  for (const prefix of ["www.", "m."]) if (host.startsWith(prefix)) host = host.slice(prefix.length);
  const parts = url.pathname.split("/").filter(Boolean);

  if (YOUTUBE_HOSTS.has(host)) {
    let video = null;
    if (host === "youtu.be" && parts.length) video = parts[0];
    else if (parts[0] === "watch") video = url.searchParams.getAll("v").find((v) => v) || "";
    else if (parts.length >= 2 && ["shorts", "live", "embed", "v"].includes(parts[0])) video = parts[1];
    if (video && YOUTUBE_ID_RE.test(video)) return { app: "YouTube", appId: "837", params: { contentId: video, mediaType: "live" } };
    throw new ValueError("That YouTube link doesn't point to a single video.");
  }

  if (host === "netflix.com") {
    const kind = parts[parts.length - 2];
    const id = parts[parts.length - 1];
    if (parts.length >= 2 && (kind === "title" || kind === "watch") && /^\d+$/.test(id)) {
      return { app: "Netflix", appId: "12", params: { contentId: id, mediaType: kind === "watch" ? "movie" : "series" } };
    }
    throw new ValueError("That Netflix link doesn't point to a show or movie.");
  }
  return null;
}

// --- Ads and video addresses ------------------------------------------------------------------

// Ad and tracker hosts. Videos from these are never picked, and their pages are never opened,
// so a pre-roll ad doesn't get sent to the TV in place of the real video.
export const AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "imasdk.googleapis.com",
  "adservice.google", "amazon-adsystem.com", "adnxs.com", "moatads.com", "taboola.com",
  "outbrain.com", "popads.net", "popcash.net", "propellerads", "pubmatic.com", "rubiconproject.com",
  "criteo.", "advertising.com", "adform.net", "smartadserver.com", "spotxchange.com",
  "springserve.com", "teads.tv", "exoclick.com", "juicyads.com", "trafficjunky", "adsterra",
  "hilltopads", "onclickads", "admaven", "revcontent.com", "mgid.com", "openx.net",
  "casalemedia.com", "indexww.com", "sharethrough.com", "media.net", "adsystem", "adserver",
];
export const AD_PATH_RE = /(^|[/_.-])(ads?|adserver|preroll|pre-roll|vast|vpaid|sponsor(ed)?)([/_.-]|$)/i;
export const PLAYABLE_RE = /\.(m3u8|mp4|m4v|mov|mpd)$/i;
const VIDEO_URL_RE = /https?:(?:\\?\/){2}[^\s"'<>]+?\.(?:m3u8|mp4|m4v|mov|mpd)(?:\?[^\s"'<>]*)?/gi;
// A quoted path on the page's own site (or //host/..), as players are often set up: file: "/media/clip.m3u8".
const VIDEO_PATH_RE = /["']((?:\\?\/)[^\s"'<>]+?\.(?:m3u8|mp4|m4v|mov|mpd)(?:\?[^\s"'<>]*)?)["']/gi;
const FORMAT_SCORE = { hls: 3, mp4: 2, dash: 1 };

function urlParts(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), path: u.pathname, ok: true, url: u };
  } catch {
    return { host: "", path: String(url).split(/[?#]/)[0], ok: false, url: null };
  }
}

export function streamFormat(url) {
  const path = urlParts(url).path.toLowerCase();
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  return "mp4";
}

export function isAdUrl(url) {
  const { host, path } = urlParts(url);
  return AD_HOSTS.some((marker) => host.includes(marker)) || AD_PATH_RE.test(path);
}

/** Python's urllib.parse.urljoin, close enough for page links. null when it can't be joined. */
function urljoin(base, ref) {
  try { return new URL(ref, base).href; } catch { return null; }
}

// --- Reading pages -------------------------------------------------------------------------------

let refererRule = 0;

/**
 * fetch() can't set a Referer header, so set it with a short-lived session rule for this
 * one address (some embedded players only answer when they see the page they're on).
 */
async function withReferer(referer, url, fn) {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  let href = null;
  try { href = new URL(url).href.split("#")[0]; } catch { href = null; }
  if (!referer || !dnr?.updateSessionRules || !href || /[*^|]/.test(href)) return fn();
  const id = 2000 + (refererRule++ % 500);
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 2,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: referer }] },
        condition: { urlFilter: `|${href}|`, tabIds: [chrome.tabs?.TAB_ID_NONE ?? -1], resourceTypes: ["xmlhttprequest", "other"] },
      }],
    });
  } catch {
    return fn();
  }
  try {
    return await fn();
  } finally {
    dnr.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

const PAGE_ERROR = "Couldn't open that page from this browser. Check the link and your internet connection.";

/**
 * Read a page's HTML only: no scripts, images or ads are loaded.
 * Returns {finalUrl, page, ctype}; page is null for a video file.
 */
export async function fetchPage(url, { referer = null, limit = 3_000_000, timeout = 12000 } = {}) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeout);
  try {
    let resp;
    try {
      resp = await withReferer(referer, url, () => fetch(url, {
        headers: { Accept: "text/html,*/*" }, credentials: "omit", redirect: "follow", signal: controller.signal,
      }));
    } catch {
      throw new TVError(PAGE_ERROR);
    }
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout + 8000); // time to read the page itself
    if (!resp.ok) {
      resp.body?.cancel().catch(() => {});
      throw new TVError(PAGE_ERROR);
    }
    const ctype = resp.headers.get("Content-Type") || "";
    const finalUrl = resp.url || url;
    if (ctype.startsWith("video/") || ctype.includes("mpegurl")) {
      resp.body?.cancel().catch(() => {});
      return { finalUrl, page: null, ctype };
    }
    const chunks = [];
    let size = 0;
    try {
      const reader = resp.body.getReader();
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
      }
      reader.cancel().catch(() => {});
    } catch {
      if (!chunks.length) throw new TVError(PAGE_ERROR); // some sites cut the connection; use what arrived
    }
    const raw = new Uint8Array(Math.min(size, limit));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, Math.max(0, raw.length - offset));
      raw.set(part, offset);
      offset += part.length;
    }
    const charset = (/charset=["']?([\w.:-]+)/i.exec(ctype) || [])[1] || "utf-8";
    let decoder;
    try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder("utf-8"); }
    return { finalUrl, page: decoder.decode(raw), ctype };
  } finally {
    clearTimeout(timer);
  }
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pageMeta(page, ...names) {
  for (const name of names) {
    const n = escapeRe(name);
    const match = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']+)`, "i").exec(page)
      || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${n}["']`, "i").exec(page);
    if (match) return unescapeHtml(match[1]);
  }
  return null;
}

export function pageTitle(page) {
  let title = pageMeta(page, "og:title", "twitter:title");
  if (!title) {
    const match = /<title[^>]*>([^<]+)<\/title>/i.exec(page);
    title = match ? unescapeHtml(match[1]).trim() : "";
  }
  return title;
}

/** A video address as written in a page (HTML-escaped, or with JSON's \\/), made absolute; null if unusable. */
function cleanVideoLink(raw, baseUrl) {
  const clean = unescapeHtml(raw).replaceAll("\\/", "/").replaceAll("\\u002F", "/").replaceAll("\\u0026", "&");
  const absolute = urljoin(baseUrl, clean);
  return absolute && /^https?:\/\//.test(absolute) && !isAdUrl(absolute) ? absolute : null;
}

/** Every video address a page mentions, as absolute URLs, ads left out. */
export function videoCandidates(page, baseUrl) {
  const found = [pageMeta(page, "og:video:secure_url", "og:video:url", "og:video"), pageMeta(page, "twitter:player:stream")].filter(Boolean);
  for (const m of page.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)/gi)) found.push(m[1]);
  for (const m of page.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/g)) found.push(m[1]);
  for (const m of page.matchAll(VIDEO_URL_RE)) found.push(m[0]);
  for (const m of page.matchAll(VIDEO_PATH_RE)) found.push(m[1]); // players set up with a path on the same site
  const candidates = [];
  for (const raw of found) {
    const absolute = cleanVideoLink(raw, baseUrl);
    if (absolute && !candidates.includes(absolute)) candidates.push(absolute);
  }
  return candidates;
}

/** [[url, format]] for <video>/<source> tags whose type says what they are (addresses with no .m3u8/.mp4 ending). */
export function typedSources(page, baseUrl) {
  const out = [];
  for (const [tag] of page.matchAll(/<(?:video|source)\b[^>]*>/gi)) {
    const src = /\ssrc=["']([^"']+)/i.exec(tag);
    const type = /\stype=["']([^"']+)/i.exec(tag);
    if (!src || !type) continue;
    const kind = type[1].toLowerCase();
    const format = kind.includes("mpegurl") ? "hls" : kind.includes("dash+xml") ? "dash" : kind.startsWith("video/mp4") ? "mp4" : null;
    const absolute = format ? cleanVideoLink(src[1], baseUrl) : null;
    if (absolute && !out.some(([url]) => url === absolute)) out.push([absolute, format]);
  }
  return out;
}

/** Embedded players to look in: <iframe> addresses (lazy data-src ones too), then a VideoObject's embedUrl. */
export function videoFrames(page, baseUrl) {
  const found = [...page.matchAll(/<iframe[^>]+src=["']([^"']+)/gi)].map((m) => m[1]);
  for (const m of page.matchAll(/"embedUrl"\s*:\s*"([^"]+)"/g)) found.push(m[1]);
  const frames = [];
  for (const raw of found) {
    const absolute = cleanVideoLink(raw, baseUrl);
    if (absolute && !frames.includes(absolute)) frames.push(absolute);
  }
  return frames;
}

/** An embedded YouTube video, or the best playable file (typed: [[url, format]] from typedSources), or null. */
export function pickVideo(candidates, typed = []) {
  for (const candidate of candidates) {
    try {
      if (parseLink(candidate)) return { url: candidate, format: "app", how: "an embedded YouTube video" };
    } catch { /* not a single video */ }
  }
  const playable = candidates.filter((c) => PLAYABLE_RE.test(urlParts(c).path)).map((c) => [c, streamFormat(c)]);
  for (const [url, format] of typed) if (!playable.some(([c]) => c === url)) playable.push([url, format]);
  if (!playable.length) return null;
  let best = playable[0];
  for (const c of playable) if (FORMAT_SCORE[c[1]] > FORMAT_SCORE[best[1]]) best = c;
  return { url: best[0], format: best[1], how: "the page" };
}

function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Find a playable video file for a web page. Returns {url, title, format, how, referer}.
 * Order: the page's own player address (sent by the page), media this browser played on
 * that page, a direct link, the page's HTML, one level of embedded frames.
 */
const LOCAL_LINK_ERROR = "Links to addresses on your home network can only be sent from this computer.";
const OUTSIDE_LINK_ERROR = "From a phone, send YouTube or Netflix links, or a direct link to a video file. For other pages, use Send to TV in this browser on the computer.";

/**
 * A name or address on this computer or the home network (localhost, *.local, 10.x, 192.168.x, ...).
 * The browser can't look names up, so this checks what the link says; the program also checks where
 * names point (is_public_host).
 */
export function isLocalHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || /\.(localhost|local|lan|home|internal|arpa)$/.test(h) || !h.includes(".") && !h.includes(":")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (h.includes(":")) return h === "::1" || h === "::" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

export async function findVideo(pageUrl, direct = null, sniffed = [], { publicOnly = false } = {}) {
  if (/[\x00-\x20\x7f\\]/.test(pageUrl)) throw new ValueError("Paste the whole link, starting with https://");
  if (publicOnly) sniffed = []; // videos this browser played are its own business
  if (direct && publicOnly && isLocalHost(urlParts(direct).host)) throw new ValueError(LOCAL_LINK_ERROR);
  if (direct && /^https?:\/\//.test(direct) && direct.length < 4000 && !isAdUrl(direct)) {
    return { url: direct, title: "", format: streamFormat(direct), how: "the page's video player", referer: pageUrl };
  }
  const played = bestSniffed(sniffed);
  if (played) {
    return { url: played.url, title: played.title || "", format: played.format, how: "the video playing in this browser", referer: played.page || pageUrl };
  }
  const parsed = urlParts(pageUrl);
  if (!parsed.ok || !["http:", "https:"].includes(parsed.url.protocol) || !parsed.host) {
    throw new ValueError("Paste the whole link, starting with https://");
  }
  if (publicOnly && isLocalHost(parsed.host)) throw new ValueError(LOCAL_LINK_ERROR);
  if (PLAYABLE_RE.test(parsed.path)) {
    return { url: pageUrl, title: basename(parsed.path), format: streamFormat(pageUrl), how: "a direct video link", referer: "" };
  }
  // From a phone or a web page, this browser doesn't open the page: it can't tell where a name points or
  // where a redirect goes before it's too late. (The program on a computer can, and does.)
  if (publicOnly) throw new ValueError(OUTSIDE_LINK_ERROR);

  const fetched = await fetchPage(pageUrl);
  const { finalUrl, page } = fetched;
  if (page === null) {
    return { url: finalUrl, title: "", format: fetched.ctype.includes("mpegurl") ? "hls" : "mp4", how: "a direct video link", referer: "" };
  }
  const title = pageTitle(page);
  let found = pickVideo(videoCandidates(page, finalUrl), typedSources(page, finalUrl));
  if (found) return { ...found, title, referer: finalUrl };

  // Many sites put the player in an embedded frame. Look one level in (never into ad frames).
  for (const frame of videoFrames(page, finalUrl).slice(0, 3)) {
    let framed;
    try {
      framed = await fetchPage(frame, { referer: finalUrl });
    } catch (err) {
      if (err instanceof TVError) continue;
      throw err;
    }
    if (framed.page === null) {
      return { url: framed.finalUrl, title, format: streamFormat(framed.finalUrl), how: "the page's video player", referer: finalUrl };
    }
    found = pickVideo(videoCandidates(framed.page, framed.finalUrl), typedSources(framed.page, framed.finalUrl));
    if (found) return { ...found, title, how: "the page's video player", referer: framed.finalUrl };
  }

  if (/widevine|fairplay|playready|\bdrm\b/i.test(page)) {
    throw new ValueError("This site locks its videos (DRM), so they can't be sent to the TV. If it has a Roku app, use Find a show instead.");
  }
  throw new ValueError("Couldn't find a video on that page. Some sites load their videos in ways this can't see. "
    + "Start the video in a browser tab, then use the Roku Detox button in the toolbar to send it.");
}

/** Play a link on the TV: YouTube/Netflix in their apps, anything else in Detox Home. */
export async function cast(target, pageUrl, direct = null, title = null, { publicOnly = false } = {}) {
  const link = parseLink(pageUrl); // YouTube and Netflix have their own apps
  if (link) {
    await launch(target, link.appId, link.params);
    return { app: link.app, title: title || "" };
  }
  await loadSniffed();
  const found = await findVideo(pageUrl, direct, sniffedForUrl(pageUrl), { publicOnly });
  if (found.format === "app") {
    const embedded = parseLink(found.url);
    await launch(target, embedded.appId, embedded.params);
    return { app: embedded.app, title: found.title };
  }
  const name = cut(title || found.title || urlParts(pageUrl).host || "Video", 200);
  await showOnTv(target, "video", { url: found.url, title: name, streamFormat: found.format, referer: found.referer ?? pageUrl });
  return { app: "Detox Home", title: name, how: found.how };
}

export async function tvMessage(target, text) {
  await showOnTv(target, "message", { text, from: "Sent from the browser" });
}

// --- Media sniffer: videos this browser actually loaded, per tab ------------------------------

const SNIFFED = new Map(); // tab id -> [{url, format, mime, size, page, title, at}], oldest first
const TABS = new Map();    // tab id -> {url, title}
const SNIFF_MAX = 20;
let sniffLoaded = null;
let saveTimer = null;

function pageKey(url) {
  return String(url || "").split("#")[0].replace(/\/$/, "");
}

function loadSniffed() {
  if (!sniffLoaded) {
    sniffLoaded = (async () => {
      try {
        const { sniffed } = await chrome.storage.session.get("sniffed");
        for (const [tabId, list] of Object.entries(sniffed || {})) {
          if (Array.isArray(list) && !SNIFFED.has(Number(tabId))) SNIFFED.set(Number(tabId), list);
        }
      } catch { /* session storage unavailable */ }
    })();
  }
  return sniffLoaded;
}

function saveSniffed() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      chrome.storage.session.set({ sniffed: Object.fromEntries(SNIFFED) }).catch(() => {});
    } catch { /* ignore */ }
  }, 500);
}

const SKIP_MIME = /mp2t|iso\.segment|webm|ogg/i;
const SKIP_PATH = /\.(ts|m4s|aac|vtt|webm|ogv|m4a|mp3)$/i;

/** {format, mime} when a response looks like a playable video, else null. */
export function mediaKind(url, mime) {
  const { path } = urlParts(url);
  const type = String(mime || "").split(";")[0].trim().toLowerCase();
  if (SKIP_PATH.test(path) || SKIP_MIME.test(type)) return null;
  if (PLAYABLE_RE.test(path)) return { format: streamFormat(url), mime: type };
  if (type.includes("mpegurl")) return { format: "hls", mime: type };
  if (type === "application/dash+xml") return { format: "dash", mime: type };
  if (type.startsWith("video/")) return { format: "mp4", mime: type };
  return null;
}

function header(details, name) {
  const h = (details.responseHeaders || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value || "" : "";
}

async function tabInfo(tabId) {
  if (TABS.has(tabId)) return TABS.get(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const info = { url: tab.url || tab.pendingUrl || "", title: tab.title || "" };
    TABS.set(tabId, info);
    return info;
  } catch {
    return { url: "", title: "" };
  }
}

/** Record one response (exported for tests). */
export async function noteMedia(details) {
  if (details.tabId === undefined || details.tabId < 0) return;
  if (details.statusCode && details.statusCode >= 400) return;
  const url = details.url;
  if (!/^https?:\/\//.test(url) || url.length > 4000 || isAdUrl(url)) return;
  const kind = mediaKind(url, header(details, "content-type"));
  if (!kind) return;
  await loadSniffed();
  const tab = await tabInfo(details.tabId);
  if (/^https?:\/\//.test(tab.url) && isAdUrl(tab.url)) return;
  const range = /\/(\d+)\s*$/.exec(header(details, "content-range"));
  const size = range ? Number(range[1]) : Number(header(details, "content-length")) || 0;
  const list = SNIFFED.get(details.tabId) || [];
  const existing = list.find((item) => item.url === url);
  if (existing) {
    existing.last = Date.now();
    existing.size = Math.max(existing.size || 0, size);
  } else {
    list.push({ url, format: kind.format, mime: kind.mime, size, page: tab.url, title: tab.title, at: Date.now(), last: Date.now() });
    while (list.length > SNIFF_MAX) { // drop plain files before stream manifests
      const index = list.findIndex((item) => item.format === "mp4");
      list.splice(index === -1 ? 0 : index, 1);
    }
  }
  SNIFFED.set(details.tabId, list);
  saveSniffed();
}

/** The best video among sniffed ones: HLS (its first, master playlist), then the largest MP4, then DASH. */
export function bestSniffed(list) {
  let best = null;
  for (const item of list || []) {
    if (!item || !item.url || isAdUrl(item.url)) continue;
    if (!best) { best = item; continue; }
    const a = FORMAT_SCORE[item.format] || 0;
    const b = FORMAT_SCORE[best.format] || 0;
    if (a !== b) { if (a > b) best = item; continue; }
    if (item.format === "mp4") {
      if ((item.size || 0) > (best.size || 0) || ((item.size || 0) === (best.size || 0) && item.at > best.at)) best = item;
    } else if (item.at < best.at) {
      best = item;
    }
  }
  return best;
}

export async function sniffedForTab(tabId) {
  await loadSniffed();
  const list = SNIFFED.get(tabId) || [];
  return { items: [...list].reverse(), best: bestSniffed(list) };
}

/** Sniffed videos from any tab showing this page. */
export function sniffedForUrl(pageUrl) {
  const key = pageKey(pageUrl);
  const out = [];
  for (const list of SNIFFED.values()) for (const item of list) if (pageKey(item.page) === key) out.push(item);
  return out;
}

export function initSniffer() {
  const wr = chrome.webRequest;
  if (!wr?.onResponseStarted) return;
  loadSniffed();
  const byName = (details) => { noteMedia(details).catch(() => {}); };
  const byType = (details) => { noteMedia(details).catch(() => {}); };
  wr.onResponseStarted.addListener(byName, {
    urls: ["*://*/*.m3u8*", "*://*/*.mpd*", "*://*/*.mp4*", "*://*/*.m4v*", "*://*/*.mov*"],
    types: ["xmlhttprequest", "other"],
  }, ["responseHeaders"]);
  wr.onResponseStarted.addListener(byType, { urls: ["<all_urls>"], types: ["media"] }, ["responseHeaders"]);
  chrome.tabs.onRemoved.addListener((tabId) => {
    TABS.delete(tabId);
    if (SNIFFED.delete(tabId)) saveSniffed();
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    const list = SNIFFED.get(tabId);
    if (change.url && list) { // a new page: forget the old page's videos
      const keep = list.filter((item) => pageKey(item.page) === pageKey(change.url));
      if (keep.length !== list.length) {
        if (keep.length) SNIFFED.set(tabId, keep);
        else SNIFFED.delete(tabId);
        saveSniffed();
      }
    }
    if (change.url || change.title) TABS.set(tabId, { url: tab.url || change.url || "", title: tab.title || "" });
    if (change.title) for (const item of SNIFFED.get(tabId) || []) if (pageKey(item.page) === pageKey(tab.url)) item.title = tab.title;
  });
}

// --- My sites: search sites you choose, then send a result's video to the TV ---------------------

const NAV_PATH_RE = new RegExp(
  "(^|/)(login|log-in|signin|sign-in|signup|sign-up|register|account|profile|privacy|terms|contact|about|"
  + "faq|help|dmca|cookie|cookies|legal|advertise|careers|genre|genres|category|categories|tag|tags|search|"
  + "feed|rss|sitemap|cart|subscribe|donate|share)(/|$)", "i");
const NAV_QUERY_RE = /(^|&)(page|sort|filter|lang|order|ref)=/i;

export function stripTags(fragment) {
  return unescapeHtml(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function unquote(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

// Many sites build their results with scripts, but still ship them inside the page as data
// (YouTube's ytInitialData, Next.js __NEXT_DATA__, schema.org JSON-LD...). Reading that data finds
// results with no scripts run, so ads and pop-ups still never load. Same rules as read_results().
const JSON_SCRIPT_RE = /<script\b[^>]*\btype=["']application\/(?:ld\+json|json)["'][^>]*>([\s\S]*?)<\/script>/gi;
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const ASSIGN_RE = /[A-Za-z_$][\w$]*\s*=\s*(?=[[{])/g;
const JSON_PARSE_RE = /JSON\.parse\(\s*"((?:\\[\s\S]|[^"\\])*)"\s*\)/g;
const URL_KEYS = ["url", "href", "link", "permalink", "canonicalUrl", "canonical_url", "webpageUrl", "webpage_url",
  "watchUrl", "watch_url", "shareUrl", "share_url", "pageUrl", "page_url", "path"];
const TITLE_KEYS = ["title", "headline", "name"];
const IMAGE_KEYS = ["thumbnail", "thumbnails", "thumbnailUrl", "thumbnail_url", "image", "images", "poster", "posterUrl",
  "poster_url", "cover", "coverImage", "cover_image", "contentImage", "artwork", "picture", "img", "still"];
// Data that is clearly a video, show or movie, not a menu entry.
const MEDIA_TYPES = new Set(["videoobject", "movie", "tvseries", "tvepisode", "episode", "tvseason", "clip",
  "musicvideoobject", "creativework", "listitem"]);
const MEDIA_KEYS = ["duration", "lengthSeconds", "length_seconds", "runtime", "uploadDate", "upload_date", "releaseDate",
  "release_date", "episodeNumber", "seasonNumber", "viewCount", "view_count"];
const DROP_PARAMS = new Set(["ref", "ref_src", "fbclid", "gclid", "si", "pp", "feature", "source", "from"]);
const MAX_DATA_BYTES = 6_000_000;
const MAX_DATA_NODES = 300_000;
const MAX_RESULTS = 20;
const MIN_GRID = 5; // this many links of the same shape (like /video/<id>) are the page's list of results
const NO_RESULTS = "No results could be read from this page. The site may build its results with scripts.";

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isContainer = (v) => v !== null && typeof v === "object";
const isDict = (v) => isContainer(v) && !Array.isArray(v);

/** End of the JSON object or array starting at text[start] (balanced brackets, strings skipped), or -1. */
export function scanJson(text, start) {
  const closers = { "{": "}", "[": "]" };
  const stack = [];
  const n = Math.min(text.length, start + MAX_DATA_BYTES);
  for (let i = start; i < n; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (ch in closers) {
      stack.push(closers[ch]);
    } else if (ch === "}" || ch === "]") {
      if (!stack.length || stack.pop() !== ch) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** JSON found in a page's scripts, in page order. */
export function pageData(page) {
  const blobs = [];
  let used = 0;
  const add = (raw) => {
    const text = raw.trim();
    if (text.length < 2 || used + text.length > MAX_DATA_BYTES || blobs.length >= 40) return;
    try {
      blobs.push(JSON.parse(text));
      used += text.length;
    } catch { /* not JSON */ }
  };
  for (const match of page.matchAll(JSON_SCRIPT_RE)) add(match[1].replace(/^\s*(?:<!--|<!\[CDATA\[)|(?:-->|\]\]>)\s*$/g, ""));
  for (const script of page.matchAll(SCRIPT_RE)) {
    const [, attrs, body] = script;
    if (/\bsrc=|application\/(?:ld\+json|json)/i.test(attrs)) continue; // read above, or loaded from elsewhere
    for (const assign of body.matchAll(ASSIGN_RE)) {
      const from = assign.index + assign[0].length;
      const stop = scanJson(body, from);
      if (stop - from >= 64) add(body.slice(from, stop));
    }
    for (const parsed of body.matchAll(JSON_PARSE_RE)) {
      if (parsed[1].length < 64) continue;
      try { add(JSON.parse(`"${parsed[1].replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")}"`)); } catch { /* not a JSON string */ }
    }
  }
  return blobs;
}

/** Text from the shapes sites use for a title: "x", {simpleText: "x"}, {content: "x"}, {runs: [{text: "x"}]}. */
function dataText(value) {
  if (typeof value === "string") return value;
  if (isDict(value)) {
    for (const key of ["simpleText", "content", "text"]) if (typeof value[key] === "string") return value[key];
    if (Array.isArray(value.runs)) return value.runs.filter((run) => isDict(run) && typeof run.text === "string").map((run) => run.text).join("");
  }
  return "";
}

function dataTitle(node, depth = 0) {
  for (const key of TITLE_KEYS) {
    const text = stripTags(dataText(node[key]));
    if (text) return text;
  }
  const metadata = node.metadata;
  if (depth < 3 && isDict(metadata)) {
    const title = dataTitle(metadata, depth + 1);
    if (title) return title;
    for (const value of Object.values(metadata)) {
      if (isDict(value)) {
        const inner = dataTitle(value, depth + 1);
        if (inner) return inner;
      }
    }
  }
  return "";
}

/** The first picture address in a value: a string, {url: ..}, or a list (the last, usually largest). */
function dataImage(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === "string") return /^(https:\/\/|http:\/\/|\/\/|\/)/.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const found = dataImage(value[i], depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (isDict(value)) {
    for (const key of ["url", "src", "contentUrl"]) {
      if (typeof value[key] === "string") {
        const found = dataImage(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      if (isContainer(item)) {
        const found = dataImage(item, depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/** A result's address without tracking bits, so the same video found twice counts once. */
export function resultKey(url) {
  const parsed = urlParts(url);
  if (!parsed.ok) return String(url);
  const query = new URLSearchParams();
  for (const [k, v] of parsed.url.searchParams) if (!k.toLowerCase().startsWith("utm_") && !DROP_PARAMS.has(k.toLowerCase())) query.append(k, v);
  const rest = query.toString();
  return parsed.host.replace(/^www\./, "") + parsed.path.replace(/\/+$/, "") + (rest ? `?${rest}` : "");
}

/** Links in a results list look alike: same first folder, same depth, same query names. */
function linkShape(url) {
  const parsed = urlParts(url);
  const parts = parsed.path.split("/").filter(Boolean);
  const names = parsed.ok ? [...new Set([...parsed.url.searchParams.keys()])].sort() : [];
  return [parsed.host, parts.length ? parts[0].toLowerCase() : "", String(parts.length), names.join(",")].join("|");
}

function usableLink(absolute, finalUrl, baseRoot) {
  if (!absolute) return false;
  const parsed = urlParts(absolute);
  if (!parsed.ok || !["http:", "https:"].includes(parsed.url.protocol) || !parsed.host.endsWith(baseRoot) || isAdUrl(absolute)) return false;
  if (parsed.path.replace(/^\/+|\/+$/g, "") === "" || NAV_PATH_RE.test(parsed.path) || NAV_QUERY_RE.test(parsed.url.search.slice(1))) return false;
  return absolute.replace(/\/+$/, "") !== finalUrl.replace(/\/+$/, "");
}

function usableImage(url, finalUrl) {
  if (!url) return null;
  const absolute = urljoin(finalUrl, unescapeHtml(url));
  return absolute && absolute.startsWith("https://") && !isAdUrl(absolute) ? absolute : null;
}

function firstImage(node, finalUrl) {
  for (const key of IMAGE_KEYS) {
    if (has(node, key)) {
      const image = usableImage(dataImage(node[key]), finalUrl);
      if (image) return image;
    }
  }
  return null;
}

/**
 * [[result, sure]] from the page's data. sure: clearly a video or show, so it's kept even when its
 * title doesn't repeat the search words (a search engine's own ranking is better than ours).
 */
function dataResults(page, finalUrl, baseRoot) {
  const youtubePage = baseRoot === "youtube.com";
  const out = [];
  let budget = MAX_DATA_NODES;
  for (const blob of pageData(page)) {
    const stack = [blob];
    while (stack.length && budget > 0) {
      const node = stack.pop();
      budget--;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      if (!isDict(node)) continue;
      const children = Object.values(node).filter(isContainer);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
      let entry = null;
      let videoId = node.videoId;
      if (typeof videoId !== "string" && has(node, "contentType") && String(node.contentType).toUpperCase().includes("VIDEO")) videoId = node.contentId;
      if (typeof videoId === "string" && YOUTUBE_ID_RE.test(videoId)) {
        const title = dataTitle(node);
        if (title) entry = [{ title, url: `https://www.youtube.com/watch?v=${videoId}`, image: firstImage(node, finalUrl) }, youtubePage];
      }
      if (entry === null) {
        const key = URL_KEYS.find((k) => typeof node[k] === "string" && node[k]);
        const title = key ? dataTitle(node) : "";
        if (key && title) {
          const absolute = urljoin(finalUrl, unescapeHtml(node[key]));
          if (usableLink(absolute, finalUrl, baseRoot)) {
            const kinds = (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).filter((k) => typeof k === "string").map((k) => k.toLowerCase());
            const sure = kinds.some((k) => MEDIA_TYPES.has(k)) || MEDIA_KEYS.some((k) => has(node, k));
            entry = [{ title, url: absolute, image: firstImage(node, finalUrl) }, sure];
          }
        }
      }
      if (entry && pyLen(entry[0].title) >= 2 && pyLen(entry[0].title) <= 140) out.push(entry);
    }
  }
  return out;
}

/** Pick out the results on a search results page: from the page's data first, then from its links. */
export function readResults(finalUrl, html, query) {
  const baseHost = urlParts(finalUrl).host;
  const baseRoot = baseHost.split(".").slice(-2).join(".");
  const fromData = dataResults(html, finalUrl, baseRoot);
  // Menus, headers and footers are never results.
  const page = html.replace(/<(script|style|noscript|svg|header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const allWords = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const longWords = allWords.filter((w) => pyLen(w) >= 3);
  const words = longWords.length ? longWords : allWords;
  const links = [];
  const seen = new Map();
  for (const match of page.matchAll(/<a\b([^>]*?)href=["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] + match[3];
    const inner = match[4];
    const absolute = urljoin(finalUrl, unescapeHtml(match[2]));
    if (!usableLink(absolute, finalUrl, baseRoot)) continue;
    const image = /<img[^>]+(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)/i.exec(inner);
    const alt = /<img[^>]+alt=["']([^"']+)/i.exec(inner);
    const titleAttr = /\btitle=["']([^"']+)/i.exec(attrs);
    const title = stripTags((titleAttr ? titleAttr[1] : "") || stripTags(inner) || (alt ? alt[1] : ""));
    if (!(pyLen(title) >= 2 && pyLen(title) <= 140)) continue;
    const imageUrl = image ? usableImage(image[1], finalUrl) : null;
    const key = resultKey(absolute);
    if (seen.has(key)) {
      const entry = seen.get(key);
      entry.image = entry.image || imageUrl;
      if (pyLen(title) > pyLen(entry.title)) entry.title = title;
      continue;
    }
    const entry = { title, url: absolute, image: imageUrl };
    seen.set(key, entry);
    links.push(entry);
  }
  // Links (and data that may be a menu) must mention the search words; rank by how many, then by having a picture.
  const score = (entry) => {
    const haystack = (entry.title + " " + unquote(urlParts(entry.url).path)).toLowerCase();
    return words.filter((w) => haystack.includes(w)).length;
  };
  // The biggest set of look-alike links that mentions the search words at least once is the
  // results list: kept whole, in the site's order (a menu of look-alike links never mentions them).
  const shapes = new Map();
  for (const entry of links) {
    const shape = linkShape(entry.url);
    if (!shapes.has(shape)) shapes.set(shape, []);
    shapes.get(shape).push(entry);
  }
  let grid = [];
  for (const group of shapes.values()) {
    if (group.length >= MIN_GRID && group.length > grid.length && group.some((entry) => score(entry) > 0)) grid = group;
  }
  const inGrid = new Set(grid);
  const sure = [...fromData.filter(([, certain]) => certain).map(([entry]) => entry), ...grid];
  const maybe = [...fromData.filter(([, certain]) => !certain).map(([entry]) => entry), ...links]
    .filter((r) => !inGrid.has(r) && score(r) > 0);
  maybe.sort((a, b) => (score(b) - score(a)) || (Number(a.image === null) - Number(b.image === null)));
  const results = [];
  const keys = new Map();
  for (const entry of [...sure, ...maybe]) {
    const key = resultKey(entry.url);
    if (keys.has(key)) {
      const kept = keys.get(key);
      kept.image = kept.image || entry.image;
      continue;
    }
    keys.set(key, entry);
    results.push(entry);
  }
  if (!results.length) throw new ValueError(NO_RESULTS);
  return results.slice(0, MAX_RESULTS);
}

// --- Look closer: let the site's scripts build the page in a hidden tab, then read it ---------

const RENDER_TIMEOUT = 20000;

/** Runs inside the site's page: waits for its results to appear, then returns what's on it. */
async function snapshotPage() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const roots = () => {
    const out = [document];
    for (let i = 0; i < out.length && out.length < 500; i++) {
      for (const el of out[i].querySelectorAll("*")) if (el.shadowRoot) out.push(el.shadowRoot);
    }
    return out;
  };
  const count = () => roots().reduce((n, root) => n + root.querySelectorAll("a[href]").length, 0);
  // In a header, menu or footer, also across hidden parts (custom elements like <site-topnav>).
  const MENU_TAG = /^(header|nav|footer|aside)$|(^|-)(nav|navbar|topnav|menu|menubar|header|footer|masthead|sidebar|breadcrumbs?)(-|$)/i;
  const MENU_ROLE = /^(navigation|banner|contentinfo|menu|menubar)$/i;
  const inMenu = (el) => {
    for (let node = el, hops = 0; node && hops < 60; hops++) {
      if (node.nodeType === 1 && (MENU_TAG.test(node.localName) || MENU_ROLE.test(node.getAttribute("role") || ""))) return true;
      node = node.parentElement || node.getRootNode?.().host || null;
    }
    return false;
  };
  // Wait until the number of links stops changing (results usually arrive a second or two after load).
  let last = -1;
  let steady = 0;
  for (let i = 0; i < 24 && steady < 2; i++) {
    if (i === 4) window.scrollBy(0, Math.round(window.innerHeight * 1.5)); // some sites load results as you scroll
    await sleep(500);
    const now = count();
    steady = now === last && now > 0 ? steady + 1 : 0;
    last = now;
  }
  const links = [];
  for (const root of roots()) {
    for (const a of root.querySelectorAll("a[href]")) {
      if (links.length >= 1500) break;
      const href = a.href;
      if (!/^https?:/.test(href)) continue;
      if (inMenu(a)) continue; // menus are never results
      let text = (a.getAttribute("title") || a.getAttribute("aria-label") || a.innerText || "").trim();
      let img = a.querySelector("img");
      // Cards often put the picture in the link and the name next to it.
      let card = a;
      for (let up = 0; up < 3 && (!text || !img) && card.parentElement; up++) {
        card = card.parentElement;
        if (!text) text = (card.innerText || "").trim().split("\n")[0];
        if (!img) img = card.querySelector("img");
      }
      if (!text && img) text = img.alt || "";
      links.push({ href, text: text.slice(0, 200), img: img ? (img.currentSrc || img.src || "") : "" });
    }
  }
  return { url: location.href, html: document.documentElement.outerHTML.slice(0, 3_000_000), links };
}

function waitForLoad(tabId, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }, done);
  });
}

const escAttr = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");
// Link reading stops at quotes and "#", so addresses carry those percent-encoded instead.
const escHref = (href) => String(href).split("#")[0].replace(/&/g, "&amp;").replace(/"/g, "%22").replace(/'/g, "%27").replace(/</g, "%3C");

/** Open the page in a hidden, muted tab, let it build its results, read them, close it. */
export async function renderedPage(url) {
  if (!globalThis.chrome?.scripting?.executeScript) {
    throw new ValueError("Looking closer needs the Roku Detox extension. Reload it in chrome://extensions so it can use this.");
  }
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    try { await chrome.tabs.update(tab.id, { muted: true }); } catch { /* not important */ }
    await waitForLoad(tab.id, RENDER_TIMEOUT);
    const [first] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotPage });
    const snap = first?.result;
    if (!snap || typeof snap.html !== "string") throw new ValueError("Couldn't read that page. Try again.");
    // Links inside the page's hidden parts (shadow DOM) and names next to pictures, as plain links.
    const extra = (snap.links || []).map((l) => `<a href="${escHref(l.href)}" title="${escAttr(l.text)}">${l.img ? `<img src="${escHref(l.img)}">` : ""}</a>`).join("\n");
    return { finalUrl: snap.url || url, page: `${snap.html}\n<div>${extra}</div>` };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
  }
}

export async function searchSite(site, query, { closer = false } = {}) {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(site.search);
  if (!authority || authority[1].includes("{q}") || /[\x00-\x20\x7f\\]/.test(site.search)) { // saved before that was checked
    throw new ValueError("This site's search address needs fixing under My sites.");
  }
  const url = site.search.replaceAll("{q}", quotePlus(query));
  const { finalUrl, page } = closer ? await renderedPage(url) : await fetchPage(url, { limit: 3_000_000 });
  if (page === null) return [];
  return readResults(finalUrl, page, query);
}

function groupFor(site, results, error = null) {
  const group = { site: site.name, siteId: site.id, results };
  if (error) {
    group.error = error;
    if (!site.deep) group.canLookCloser = true;
  }
  if (site.deep) group.lookedCloser = true;
  return group;
}

export async function searchSites(query) {
  const sites = await siteList();
  if (!sites.length) return [];
  const one = async (site) => {
    try {
      return groupFor(site, await searchSite(site, query, { closer: Boolean(site.deep) }));
    } catch (err) {
      if (err instanceof TVError || err instanceof ValueError) return groupFor(site, [], err.message);
      throw err;
    }
  };
  // Plain reads at most 8 at a time; sites that need a hidden tab 3 at a time. Answers in the sites' order.
  const out = new Array(sites.length);
  const run = async (indexes, limit) => {
    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        const index = indexes[next++];
        out[index] = await one(sites[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, indexes.length) }, worker));
  };
  const plain = sites.map((s, i) => i).filter((i) => !sites[i].deep);
  const deep = sites.map((s, i) => i).filter((i) => sites[i].deep);
  await Promise.all([run(plain, 8), run(deep, 3)]);
  return out;
}

/** Search one site the slow way (hidden tab). When that finds results, remember to do it every time. */
export async function lookCloser(siteId, query) {
  const sites = await siteList();
  const site = sites.find((s) => s.id === siteId);
  if (!site) throw new ValueError("That site isn't in your list any more.");
  let results;
  try {
    results = await searchSite(site, query, { closer: true });
  } catch (err) {
    if (err instanceof TVError || err instanceof ValueError) {
      return { ...groupFor({ ...site, deep: true }, [], `Looked closer and still found nothing. ${err.message}`), canLookCloser: false };
    }
    throw err;
  }
  if (results.length && !site.deep) await saveSites(sites.map((s) => (s.id === siteId ? { ...s, deep: true } : s)));
  return groupFor({ ...site, deep: true }, results);
}
