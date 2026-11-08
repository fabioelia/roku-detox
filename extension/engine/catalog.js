// Show and movie search (JustWatch catalog), seasons, next episode, watch history.
// A port of the matching part of roku_detox.py with the same JSON shapes.

import { SUBSCRIPTION_APPS, deviceInfo, launch, listApps } from "./ecp.js";
import { isPlainObject, nowIso, cut, pyLen, pyStr, APP_ID_RE, TVError, ValueError, fetchWithTimeout } from "./util.js";
import { readSettings, updateSettings } from "./store.js";

export const JUSTWATCH_URL = "https://apis.justwatch.com/graphql";
export const JUSTWATCH_QUERY = `
query Find($country: Country!, $filter: TitleFilter, $first: Int!, $language: Language!) {
  popularTitles(country: $country, filter: $filter, first: $first) {
    edges { node {
      id objectType
      content(country: $country, language: $language) { title originalReleaseYear posterUrl shortDescription }
      offers(country: $country, platform: ROKU_OS) {
        monetizationType retailPrice(language: $language)
        package { clearName technicalName }
        deeplinkURL(platform: ROKU_OS)
      }
    } }
  }
}`;
const JUSTWATCH_OFFERS = `offers(country: $country, platform: ROKU_OS) {
        monetizationType retailPrice(language: $language)
        package { clearName technicalName }
        deeplinkURL(platform: ROKU_OS)
      }`;
export const JUSTWATCH_SHOW_QUERY = `
query Show($id: ID!, $country: Country!, $language: Language!) {
  node(id: $id) {
    id __typename
    ... on Show {
      content(country: $country, language: $language) { title originalReleaseYear posterUrl }
      seasons(sortDirection: ASC) { id totalEpisodeCount content(country: $country, language: $language) { seasonNumber title } }
    }
  }
}`;
export const JUSTWATCH_SEASON_QUERY = `
query Season($id: ID!, $country: Country!, $language: Language!) {
  node(id: $id) {
    id __typename
    ... on Season {
      content(country: $country, language: $language) { seasonNumber title }
      ${JUSTWATCH_OFFERS}
      show { id ${JUSTWATCH_OFFERS} }
      episodes {
        id
        content(country: $country, language: $language) { episodeNumber title shortDescription runtime }
        ${JUSTWATCH_OFFERS}
      }
    }
  }
}`;

export const CATALOG_ID_RE = /^[a-z]{1,4}\d{1,12}$/; // ts22138 (show), tss27124 (season), tse520068, tm...
const SHOW_MEDIA_TYPES = new Set(["show", "series", "season"]); // deep links that open a show's page
const MAX_EPISODES = 500;
const FIND_CACHE = new Map();
const NODE_CACHE = new Map(); // "Show|id|country" -> JustWatch answer
const FIND_CACHE_SECONDS = 600;
export const ADDON_MARKERS = ["amazon channel", "roku premium channel", "apple tv channel"];
export const KINDS = { FLATRATE: "included", FREE: "free", ADS: "free", FAST: "free", RENT: "rent", BUY: "buy" };
const KIND_ORDER = { free: 0, included: 1, rent: 2, buy: 3 };

// --- Matching JustWatch services to the TV's apps -----------------------------------------

const APP_KEY_SKIP = new Set(["the", "plus", "premium", "with", "ads", "app", "standard", "basic", "essential", "free", "tv", "streaming"]);

/** 'Tubi - Free Movies & TV' and 'Tubi TV' both become 'tubi'. */
export function appKey(name) {
  const base = String(name).split(/\s+[-–|]\s+|:\s/)[0].toLowerCase().replaceAll("+", " plus");
  const words = base.match(/[a-z0-9]+/g) || [];
  if (words.join("").startsWith("youtubetv")) return "youtubetv";
  return words.filter((w) => !APP_KEY_SKIP.has(w)).join("");
}

export function matchApp(service, apps) {
  const key = appKey(service);
  if (key.length < 3) return null;
  let best = null;
  for (const app of apps) {
    const other = appKey(app.name);
    if (other.length < 3) continue;
    if (key === other) return app;
    if (key === "youtubetv" || other === "youtubetv") continue; // YouTube TV is a separate paid service
    if (key.startsWith(other) || key.endsWith(other) || other.startsWith(key)) {
      if (best === null || appKey(best.name).length < other.length) best = app;
    }
  }
  return best;
}

/** Python's urllib.parse.parse_qsl: blank values dropped, '+' is a space. */
function parseQsl(query) {
  const pairs = [];
  for (const part of String(query || "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const decode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    const value = decode(part.slice(eq + 1));
    if (!value) continue;
    pairs.push([decode(part.slice(0, eq)), value]);
  }
  return pairs;
}

/** JustWatch gives Roku links like 'launch/12?contentID=82939566&MediaType=show'. */
export function parseRokuDeeplink(link) {
  const match = /^launch\/([A-Za-z0-9._-]{1,64})(?:\?(.*))?$/.exec(typeof link === "string" ? link : "");
  if (!match) return null;
  const params = Object.fromEntries(parseQsl(match[2] || ""));
  const contentId = params.contentID || params.contentId || null;
  if (contentId && pyLen(contentId) > 500) return null;
  return { appId: match[1], contentId, mediaType: params.MediaType || params.mediaType || null };
}

// --- JustWatch requests -------------------------------------------------------------------------

function cacheGet(cache, key) {
  const hit = cache.get(key);
  if (hit && Date.now() / 1000 - hit.at < FIND_CACHE_SECONDS) return hit.value;
  return null;
}

function cachePut(cache, key, value) {
  const now = Date.now() / 1000;
  for (const [k, v] of cache) if (now - v.at >= FIND_CACHE_SECONDS) cache.delete(k);
  cache.set(key, { at: now, value });
}

export async function justwatchPost(operation, query, variables) {
  let data;
  try {
    const resp = await fetchWithTimeout(JUSTWATCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationName: operation, query, variables }),
      credentials: "omit",
    }, 10000);
    data = await resp.json();
  } catch {
    throw new TVError("Couldn't reach the show catalog (JustWatch). Check your internet connection.");
  }
  if (!isPlainObject(data)) throw new TVError("The show catalog (JustWatch) sent an answer this program doesn't understand.");
  return data;
}

export async function justwatchSearch(query, country) {
  const key = `${query.toLowerCase()}|${country}`;
  const cached = cacheGet(FIND_CACHE, key);
  if (cached !== null) return cached;
  const data = await justwatchPost("Find", JUSTWATCH_QUERY, {
    country, language: "en", first: 10, filter: { searchQuery: query },
  });
  if (data.errors && data.errors.length) throw new TVError("The show catalog (JustWatch) didn't accept the search. It may have changed.");
  const edges = ((data.data || {}).popularTitles || {}).edges || [];
  const titles = edges.filter((edge) => edge && edge.node).map((edge) => edge.node);
  cachePut(FIND_CACHE, key, titles);
  return titles;
}

/** The TV's country, since what's streaming where differs by country. */
export async function catalogCountry(target) {
  const country = (await deviceInfo(target)).country || "US";
  return /^[A-Z]{2}$/.test(country) ? country : "US";
}

/** The TV's country and the channels installed on it. */
export async function catalogContext(target) {
  const country = await catalogCountry(target);
  let apps;
  try {
    apps = (await listApps(target)).filter((a) => a.type === "appl");
  } catch (err) {
    if (!(err instanceof TVError)) throw err;
    apps = [];
  }
  return [country, apps];
}

export function posterUrl(path) {
  if (!path) return null;
  return "https://images.justwatch.com" + path.replace("{profile}", "s166").replace("{format}", "webp");
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JustWatch offers -> one per service and kind, marking which ones this TV can play. */
export function annotateOffers(rawOffers, apps) {
  const installed = new Map(apps.map((a) => [a.id, a]));
  const offers = new Map();
  for (const offer of rawOffers || []) {
    if (!isPlainObject(offer)) continue;
    const kind = KINDS[offer.monetizationType];
    const pkg = offer.package || {};
    const service = pkg.clearName || "";
    if (!kind || !service) continue;
    const link = parseRokuDeeplink(offer.deeplinkURL);
    const app = link ? (installed.get(link.appId) || null) : matchApp(service, apps);
    const appId = (link || {}).appId || (app || {}).id || null;
    const entry = {
      service,
      kind,
      price: offer.retailPrice ?? null,
      appId,
      appName: app ? app.name : null,
      installed: Boolean(app),
      addon: ADDON_MARKERS.some((marker) => service.toLowerCase().includes(marker)),
      subscription: SUBSCRIPTION_APPS.has(appId),
      contentId: (link || {}).contentId ?? null,
      mediaType: (link || {}).mediaType ?? null,
    };
    const dedupe = `${pkg.technicalName || service}\u0000${kind}`;
    if (!offers.has(dedupe) || (entry.contentId && !offers.get(dedupe).contentId)) offers.set(dedupe, entry);
  }
  return [...offers.values()].sort((a, b) => (KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    || (Number(!a.installed) - Number(!b.installed))
    || compareStrings(a.service, b.service));
}

/** Search the catalog and mark which offers this TV can play. */
export async function findTitles(target, query) {
  const [country, apps] = await catalogContext(target);
  const results = [];
  for (const node of await justwatchSearch(query, country)) {
    const content = node.content || {};
    results.push({
      id: node.id ?? null,
      type: node.objectType === "MOVIE" ? "Movie" : "Show",
      title: content.title || "",
      year: content.originalReleaseYear ?? null,
      description: cut(content.shortDescription || "", 300),
      poster: posterUrl(content.posterUrl),
      offers: annotateOffers(node.offers, apps),
    });
  }
  return { country, results };
}

// --- Seasons and episodes ----------------------------------------------------------------------

export function catalogId(value, what) {
  const text = value === null || value === undefined || value === "" || value === false || value === 0 ? "" : pyStr(value);
  if (!CATALOG_ID_RE.test(text)) throw new ValueError(`Bad ${what} id.`);
  return text;
}

export async function justwatchNode(nodeId, kind, query, country) {
  const key = `${kind}|${nodeId}|${country}`;
  const cached = cacheGet(NODE_CACHE, key);
  if (cached !== null) return cached;
  const data = await justwatchPost(kind, query, { id: nodeId, country, language: "en" });
  const node = (data.data || {}).node;
  if (!node) {
    const errors = Array.isArray(data.errors) ? data.errors : [];
    const problems = errors.filter(isPlainObject).map((e) => pyStr(e.message ?? "")).join(" ");
    if (errors.length && !["no merge target", "unknown prefix"].some((word) => problems.includes(word))) {
      throw new TVError("The show catalog (JustWatch) didn't answer properly. Try again in a minute.");
    }
    throw new ValueError(`The show catalog doesn't have that ${kind.toLowerCase()}.`);
  }
  if (node.__typename !== kind) throw new ValueError(`That isn't a ${kind.toLowerCase()}.`);
  cachePut(NODE_CACHE, key, node);
  return node;
}

function seasonSummary(season) {
  const content = season.content || {};
  return {
    id: season.id ?? null,
    number: content.seasonNumber ?? null,
    title: content.title || "",
    episodeCount: season.totalEpisodeCount || 0,
  };
}

function byNumber(a, b) {
  const an = a.number === null || a.number === undefined;
  const bn = b.number === null || b.number === undefined;
  if (an !== bn) return an ? 1 : -1;
  return (a.number || 0) - (b.number || 0);
}

export async function showDetails(showId, country) {
  const node = await justwatchNode(showId, "Show", JUSTWATCH_SHOW_QUERY, country);
  const content = node.content || {};
  const seasons = (node.seasons || []).filter((s) => s && s.id).map(seasonSummary);
  return {
    id: node.id ?? null,
    title: content.title || "",
    year: content.originalReleaseYear ?? null,
    poster: posterUrl(content.posterUrl),
    seasons: seasons.filter((s) => s.number || s.episodeCount).sort(byNumber),
  };
}

/**
 * Season or show offers for an episode that has none: they open the right app, but a link
 * that plays one particular episode would play the wrong one, so drop it.
 */
function inheritedOffers(rawOffers, apps) {
  const offers = annotateOffers(rawOffers, apps);
  for (const offer of offers) {
    offer.showLevel = true;
    if (!SHOW_MEDIA_TYPES.has((offer.mediaType || "").toLowerCase())) offer.contentId = offer.mediaType = null;
  }
  return offers;
}

function episodeOffers(episode, season, apps) {
  const offers = annotateOffers(episode.offers, apps);
  for (const offer of offers) { // Netflix's "episode" links open the show's page
    if (SHOW_MEDIA_TYPES.has((offer.mediaType || "").toLowerCase())) offer.showLevel = true;
  }
  if (offers.length) return offers;
  const fromSeason = inheritedOffers(season.offers, apps);
  return fromSeason.length ? fromSeason : inheritedOffers((season.show || {}).offers, apps);
}

export async function seasonDetails(seasonId, country, apps) {
  const node = await justwatchNode(seasonId, "Season", JUSTWATCH_SEASON_QUERY, country);
  const content = node.content || {};
  const episodes = [];
  for (const episode of (node.episodes || []).slice(0, MAX_EPISODES)) {
    if (!episode || !episode.id) continue;
    const about = episode.content || {};
    episodes.push({
      id: episode.id,
      number: about.episodeNumber ?? null,
      title: about.title || "",
      description: cut(about.shortDescription || "", 300),
      runtime: about.runtime || null,
      offers: episodeOffers(episode, node, apps),
    });
  }
  return {
    id: node.id ?? null,
    number: content.seasonNumber ?? null,
    title: content.title || "",
    showId: (node.show || {}).id ?? null,
    episodes: episodes.sort(byNumber),
  };
}

function seasonSummaryOf(season) {
  return { id: season.id, number: season.number, title: season.title, episodeCount: season.episodes.length };
}

export async function findShow(target, showId) {
  return showDetails(showId, await catalogCountry(target));
}

export async function findSeason(target, seasonId) {
  const [country, apps] = await catalogContext(target);
  return seasonDetails(seasonId, country, apps);
}

/** The episode after this one: next in the season, else the first of the next season. */
export async function findNext(target, showId, seasonId, number) {
  const [country, apps] = await catalogContext(target);
  const season = await seasonDetails(seasonId, country, apps);
  if (season.showId && season.showId !== showId) throw new ValueError("That season belongs to a different show.");
  const later = season.episodes.filter((e) => e.number !== null && e.number !== undefined && e.number > number);
  if (later.length) return { season: seasonSummaryOf(season), episode: later[0] };
  const { seasons } = await showDetails(showId, country);
  const position = seasons.findIndex((s) => s.id === seasonId);
  if (position === -1) throw new ValueError("That season belongs to a different show.");
  for (const upcoming of seasons.slice(position + 1)) {
    if (!upcoming.episodeCount) continue;
    const following = await seasonDetails(upcoming.id, country, apps);
    if (following.episodes.length) return { season: seasonSummaryOf(following), episode: following.episodes[0] };
  }
  return { done: true };
}

// --- "Continue watching": kept per TV under settings.tvs[address].findHistory, newest first ----

export const HISTORY_MAX = 30;
export const HISTORY_PINS_MAX = 20; // so there's always room for what's being watched now
const POSTER_RE = /^https:\/\/images\.justwatch\.com\/[^\s"'<>\\()]{1,300}$/;

function wholeNumber(value, low, high, message) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) throw new ValueError(message);
  return value;
}

function shortText(value, limit, message, required = true) {
  if (typeof value !== "string" || pyLen(value.trim()) > limit || (required && !value.trim())) throw new ValueError(message);
  return value.trim();
}

function cleanHistorySeason(raw) {
  if (!isPlainObject(raw)) throw new ValueError("Bad season.");
  return { id: catalogId(raw.id, "season"), number: wholeNumber(raw.number, 0, 100000, "Bad season number.") };
}

function cleanHistoryEpisode(raw) {
  if (!isPlainObject(raw)) throw new ValueError("Bad episode.");
  return {
    id: catalogId(raw.id, "episode"),
    number: wholeNumber(raw.number, 0, 100000, "Bad episode number."),
    title: shortText(raw.title ?? "", 200, "Episode titles can be up to 200 characters.", false),
  };
}

/** One watch history entry from the page. 'at' and 'pinned' are filled in by the caller. */
export function cleanHistoryItem(raw) {
  if (!isPlainObject(raw)) throw new ValueError("Bad watch history entry.");
  const kind = raw.type;
  const year = raw.year ?? null;
  const poster = raw.poster ?? null;
  const season = raw.season ?? null;
  const episode = raw.episode ?? null;
  const appId = raw.appId ?? null;
  const appName = raw.appName ?? null;
  if (kind !== "Show" && kind !== "Movie") throw new ValueError("Say whether it's a show or a movie.");
  if (poster !== null && !(typeof poster === "string" && POSTER_RE.test(poster))) throw new ValueError("Bad poster address.");
  if (kind === "Movie" && (season !== null || episode !== null)) throw new ValueError("A movie doesn't have seasons or episodes.");
  if (episode !== null && season === null) throw new ValueError("Say which season the episode is in.");
  if (appId !== null && !(typeof appId === "string" && APP_ID_RE.test(appId))) throw new ValueError("Bad channel id.");
  return {
    id: catalogId(raw.id, "show"),
    title: shortText(raw.title, 200, "Give a title of up to 200 characters."),
    type: kind,
    year: year === null ? null : wholeNumber(year, 1870, 2100, "Bad year."),
    poster,
    season: season === null ? null : cleanHistorySeason(season),
    episode: episode === null ? null : cleanHistoryEpisode(episode),
    appId,
    appName: appName === null ? null : (shortText(appName, 100, "Bad channel name.", false) || null),
  };
}

function storedHistory(tv) {
  const items = [];
  const seen = new Set();
  const rawItems = Array.isArray(tv.findHistory) ? tv.findHistory : [];
  for (const raw of rawItems.slice(0, HISTORY_MAX + HISTORY_PINS_MAX)) {
    let item;
    try {
      item = cleanHistoryItem(raw);
    } catch (err) {
      if (err instanceof ValueError) continue;
      throw err;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    item.at = typeof raw.at === "string" && pyLen(raw.at) <= 40 ? raw.at : "";
    item.pinned = raw.pinned === true;
    items.push(item);
  }
  return items;
}

/** Keep every pinned item, and the newest others up to HISTORY_MAX in all. */
function trimHistory(items) {
  let room = HISTORY_MAX - items.filter((i) => i.pinned).length;
  const kept = [];
  for (const item of items) {
    if (item.pinned || room > 0) {
      kept.push(item);
      if (!item.pinned) room -= 1;
    }
  }
  return kept;
}

function historyView(items) {
  return { items: [...items].sort((a, b) => Number(!a.pinned) - Number(!b.pinned)) }; // pinned first, then newest
}

export async function findHistory(address) {
  const tvs = (await readSettings()).tvs;
  const tv = isPlainObject(tvs) && isPlainObject(tvs[address]) ? tvs[address] : {};
  return historyView(storedHistory(tv));
}

/** Read, edit and save one TV's watch history in one locked step. edit(items) -> items. */
async function changeHistory(address, edit) {
  const items = await updateSettings((data) => {
    if (!isPlainObject(data.tvs)) data.tvs = {};
    const tvs = data.tvs;
    const result = edit(storedHistory(isPlainObject(tvs[address]) ? tvs[address] : {}));
    if (result.length || address in tvs) {
      if (!isPlainObject(tvs[address])) tvs[address] = {};
      tvs[address].findHistory = result;
    }
    return result;
  });
  return historyView(items);
}

function pinsFull(items) {
  return items.filter((i) => i.pinned).length >= HISTORY_PINS_MAX;
}

/** Add or refresh an entry and move it to the front. Keeps its pin unless 'pinned' is given. */
export async function recordHistory(address, raw) {
  const item = cleanHistoryItem(raw);
  const pinned = raw.pinned;
  return changeHistory(address, (items) => {
    const old = items.find((i) => i.id === item.id);
    const rest = items.filter((i) => i.id !== item.id);
    item.at = nowIso();
    item.pinned = typeof pinned === "boolean" ? pinned : Boolean(old && old.pinned);
    if (item.pinned && pinsFull(rest)) throw new ValueError(`You can pin up to ${HISTORY_PINS_MAX}. Unpin one first.`);
    return trimHistory([item, ...rest]);
  });
}

export async function forgetHistory(address, itemId) {
  const id = catalogId(itemId, "show");
  return changeHistory(address, (items) => items.filter((i) => i.id !== id));
}

export async function pinHistory(address, itemId, pinned) {
  const id = catalogId(itemId, "show");
  if (typeof pinned !== "boolean") throw new ValueError("Say whether to pin it (true or false).");
  return changeHistory(address, (items) => {
    const item = items.find((i) => i.id === id);
    if (!item) throw new ValueError("That isn't in the watch history anymore.");
    if (pinned && !item.pinned && pinsFull(items)) throw new ValueError(`You can pin up to ${HISTORY_PINS_MAX}. Unpin one first.`);
    item.pinned = pinned;
    return trimHistory(items);
  });
}

// --- Opening a show or movie ---------------------------------------------------------------------

export async function watch(target, appId, contentId = null, mediaType = null) {
  if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
  const params = {};
  if (contentId) {
    if (pyLen(contentId) > 500) throw new ValueError("Bad content id.");
    params.contentId = contentId;
    if (mediaType) {
      if (!/^[A-Za-z]{1,20}$/.test(mediaType)) throw new ValueError("Bad media type.");
      params.mediaType = mediaType;
    }
  }
  await launch(target, appId, Object.keys(params).length ? params : null);
}
