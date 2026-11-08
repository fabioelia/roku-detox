// Sending a web page's video to the TV, and "My sites" search.
// A port of roku_detox.py's parse_link / find_video / search_site, plus a media sniffer:
// videos this browser actually played are the best answer, so they're tried first.

import { launch, showOnTv } from "./ecp.js";
import { siteList } from "./store.js";
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

/** Every video address a page mentions, as absolute URLs, ads left out. */
export function videoCandidates(page, baseUrl) {
  const found = [pageMeta(page, "og:video:secure_url", "og:video:url", "og:video"), pageMeta(page, "twitter:player:stream")].filter(Boolean);
  for (const m of page.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)/gi)) found.push(m[1]);
  for (const m of page.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/g)) found.push(m[1]);
  for (const m of page.matchAll(VIDEO_URL_RE)) found.push(m[0]);
  const candidates = [];
  for (const raw of found) {
    const clean = unescapeHtml(raw).replaceAll("\\/", "/").replaceAll("\\u002F", "/").replaceAll("\\u0026", "&");
    const absolute = urljoin(baseUrl, clean);
    if (absolute && /^https?:\/\//.test(absolute) && !candidates.includes(absolute) && !isAdUrl(absolute)) candidates.push(absolute);
  }
  return candidates;
}

/** An embedded YouTube video, or the best playable file, or null. */
export function pickVideo(candidates) {
  for (const candidate of candidates) {
    try {
      if (parseLink(candidate)) return { url: candidate, format: "app", how: "an embedded YouTube video" };
    } catch { /* not a single video */ }
  }
  const playable = candidates.filter((c) => PLAYABLE_RE.test(urlParts(c).path));
  if (!playable.length) return null;
  let best = playable[0];
  for (const c of playable) if (FORMAT_SCORE[streamFormat(c)] > FORMAT_SCORE[streamFormat(best)]) best = c;
  return { url: best, format: streamFormat(best), how: "the page" };
}

function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Find a playable video file for a web page. Returns {url, title, format, how, referer}.
 * Order: the page's own player address (sent by the page), media this browser played on
 * that page, a direct link, the page's HTML, one level of embedded frames.
 */
export async function findVideo(pageUrl, direct = null, sniffed = []) {
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
  if (PLAYABLE_RE.test(parsed.path)) {
    return { url: pageUrl, title: basename(parsed.path), format: streamFormat(pageUrl), how: "a direct video link", referer: "" };
  }

  const fetched = await fetchPage(pageUrl);
  const { finalUrl, page } = fetched;
  if (page === null) {
    return { url: finalUrl, title: "", format: fetched.ctype.includes("mpegurl") ? "hls" : "mp4", how: "a direct video link", referer: "" };
  }
  const title = pageTitle(page);
  let found = pickVideo(videoCandidates(page, finalUrl));
  if (found) return { ...found, title, referer: finalUrl };

  // Many sites put the player in an embedded frame. Look one level in (never into ad frames).
  const frames = [];
  for (const m of page.matchAll(/<iframe[^>]+src=["']([^"']+)/gi)) {
    const absolute = urljoin(finalUrl, unescapeHtml(m[1]));
    if (absolute && /^https?:\/\//.test(absolute) && !isAdUrl(absolute) && !frames.includes(absolute)) frames.push(absolute);
  }
  for (const frame of frames.slice(0, 3)) {
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
    found = pickVideo(videoCandidates(framed.page, framed.finalUrl));
    if (found) return { ...found, title, how: "the page's video player", referer: framed.finalUrl };
  }

  if (/widevine|fairplay|playready|\bdrm\b/i.test(page)) {
    throw new ValueError("This site locks its videos (DRM), so they can't be sent to the TV. If it has a Roku app, use Find a show instead.");
  }
  throw new ValueError("Couldn't find a video on that page. Some sites load their videos in ways this can't see. "
    + "Start the video in a browser tab, then use the Roku Detox button in the toolbar to send it.");
}

/** Play a link on the TV: YouTube/Netflix in their apps, anything else in Detox Home. */
export async function cast(target, pageUrl, direct = null, title = null) {
  const link = parseLink(pageUrl); // YouTube and Netflix have their own apps
  if (link) {
    await launch(target, link.appId, link.params);
    return { app: link.app, title: title || "" };
  }
  await loadSniffed();
  const found = await findVideo(pageUrl, direct, sniffedForUrl(pageUrl));
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

/** Pick out the links on a search results page that look like results. */
export function readResults(finalUrl, html, query) {
  const baseHost = urlParts(finalUrl).host;
  const baseRoot = baseHost.split(".").slice(-2).join(".");
  // Menus, headers and footers are never results.
  const page = html.replace(/<(script|style|noscript|svg|header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const allWords = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const longWords = allWords.filter((w) => pyLen(w) >= 3);
  const words = longWords.length ? longWords : allWords;
  const results = [];
  const seen = new Map();
  for (const match of page.matchAll(/<a\b([^>]*?)href=["']([^"'#]+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = match[1] + match[3];
    const inner = match[4];
    const absolute = urljoin(finalUrl, unescapeHtml(match[2]));
    if (!absolute) continue;
    const parsed = urlParts(absolute);
    if (!parsed.ok || !["http:", "https:"].includes(parsed.url.protocol) || !parsed.host.endsWith(baseRoot) || isAdUrl(absolute)) continue;
    if (parsed.path.replace(/^\/+|\/+$/g, "") === "" || NAV_PATH_RE.test(parsed.path) || NAV_QUERY_RE.test(parsed.url.search.slice(1))) continue;
    if (absolute.replace(/\/+$/, "") === finalUrl.replace(/\/+$/, "")) continue;
    const image = /<img[^>]+(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)/i.exec(inner);
    const alt = /<img[^>]+alt=["']([^"']+)/i.exec(inner);
    const titleAttr = /\btitle=["']([^"']+)/i.exec(attrs);
    const title = stripTags((titleAttr ? titleAttr[1] : "") || stripTags(inner) || (alt ? alt[1] : ""));
    if (!(pyLen(title) >= 2 && pyLen(title) <= 140)) continue;
    let imageUrl = image ? urljoin(finalUrl, unescapeHtml(image[1])) : null;
    if (imageUrl && (!imageUrl.startsWith("https://") || isAdUrl(imageUrl))) imageUrl = null;
    const key = absolute.split("?")[0].replace(/\/+$/, "");
    if (seen.has(key)) {
      const entry = seen.get(key);
      entry.image = entry.image || imageUrl;
      if (pyLen(title) > pyLen(entry.title) && pyLen(title) <= 140) entry.title = title;
      continue;
    }
    const entry = { title, url: absolute, image: imageUrl };
    seen.set(key, entry);
    results.push(entry);
  }
  // Keep links that mention the search words; rank by how many, then by having a picture.
  const score = (entry) => {
    const haystack = (entry.title + " " + unquote(urlParts(entry.url).path)).toLowerCase();
    return words.filter((w) => haystack.includes(w)).length;
  };
  const matched = results.filter((r) => score(r) > 0);
  if (!matched.length) throw new ValueError("No results could be read. This site may build its results with scripts, which this can't see.");
  matched.sort((a, b) => (score(b) - score(a)) || (Number(a.image === null) - Number(b.image === null)));
  return matched.slice(0, 12);
}

export async function searchSite(site, query) {
  const url = site.search.replaceAll("{q}", quotePlus(query));
  const { finalUrl, page } = await fetchPage(url, { limit: 2_000_000 });
  if (page === null) return [];
  return readResults(finalUrl, page, query);
}

export async function searchSites(query) {
  const sites = await siteList();
  if (!sites.length) return [];
  const one = async (site) => {
    try {
      return { site: site.name, siteId: site.id, results: await searchSite(site, query) };
    } catch (err) {
      if (err instanceof TVError || err instanceof ValueError) return { site: site.name, siteId: site.id, results: [], error: err.message };
      throw err;
    }
  };
  // At most 8 at a time, answers in the sites' order.
  const out = new Array(sites.length);
  let next = 0;
  const worker = async () => {
    while (next < sites.length) {
      const index = next++;
      out[index] = await one(sites[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, sites.length) }, worker));
  return out;
}
