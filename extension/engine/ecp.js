// Talking to the TV over Roku's External Control Protocol (port 8060).
// A port of the "Talking to the TV" part of roku_detox.py. Service workers have no
// DOMParser, so the TV's small XML answers are read with the regex helpers below.

import {
  APP_ID_RE, Blocked, ParseError, TVError, ValueError, displayAddress, fetchWithTimeout,
  keepAlive, quote, sleep, targetKey, unescapeHtml, urlencode,
} from "./util.js";
import { explainFailure, lastNetError } from "./neterrors.js";

export const STORE_APP_ID = "11"; // Roku's Streaming Store; launch/11?contentID=<id>
export const KEYS = new Set([
  "Home", "Back", "Select", "Up", "Down", "Left", "Right", "Info",
  "InstantReplay", "Rev", "Play", "Fwd", "Search", "Backspace", "Enter",
  "VolumeUp", "VolumeDown", "VolumeMute", "Power", "PowerOn", "PowerOff",
  "ChannelUp", "ChannelDown", "InputTuner", "InputAV1",
  "InputHDMI1", "InputHDMI2", "InputHDMI3", "InputHDMI4",
]);
// Roku's built-in remote shortcut for a system restart.
export const RESTART_SEQUENCE = [...Array(5).fill("Home"), "Up", "Rev", "Rev", "Fwd", "Fwd"];

// Name fragments of free, ad-supported channels. Only used to label tiles.
export const FREE_WITH_ADS = [
  "pluto", "tubi", "xumo", "crackle", "plex", "freevee", "local now",
  "haystack", "redbox", "filmrise", "popcornflix", "fawesome", "vix",
  "shout! tv", "freestream", "samsung tv plus", "lg channels",
];
export const ROKU_OWNED_IDS = new Set(["151908", "2213"]); // The Roku Channel, Roku Media Player
// Subscription apps, so the page can ask "do you pay for this?". Everything else counts as free.
export const SUBSCRIPTION_APPS = new Set([
  "12", "13", "2285", "291097", "61322", "593099", "31440", "551012", "298229", "123132",
  "46041", "195316", "43465", "196460", "65067", "808732", "34376", "2595",
]);

// --- Tiny XML helpers ---------------------------------------------------------------

const NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";

function stripProlog(xml) {
  return String(xml)
    .replace(/^﻿/, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
}

/** Attributes of a start tag's inside, like ` id="12" type="appl"`. */
export function xmlAttrs(text) {
  const attrs = {};
  const re = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "g");
  for (const m of String(text || "").matchAll(re)) attrs[m[1]] = unescapeHtml(m[2] ?? m[3] ?? "");
  return attrs;
}

/** The text inside an element, entities decoded, CDATA kept, child tags dropped. */
export function xmlText(inner) {
  if (!inner) return "";
  let out = "";
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<[^>]*>|([^<]+)/g;
  for (const m of inner.matchAll(re)) {
    if (m[1] !== undefined) out += m[1];
    else if (m[2] !== undefined) out += unescapeHtml(m[2]);
  }
  return out;
}

/**
 * The document's root element: {tag, attrs, inner}. Throws ParseError when the answer
 * isn't XML (like Python's ET.ParseError).
 */
export function xmlRoot(xml) {
  const text = stripProlog(xml).trim();
  const start = text.match(new RegExp(`^<(${NAME})(\\s[^>]*?)?(/?)>`));
  if (!start) throw new ParseError();
  const tag = start[1];
  const attrs = xmlAttrs(start[2] || "");
  if (start[3] === "/") return { tag, attrs, inner: "" };
  const close = text.lastIndexOf(`</${tag}`);
  if (close === -1 || close < start[0].length) throw new ParseError();
  return { tag, attrs, inner: text.slice(start[0].length, close) };
}

/**
 * Direct children of an element's inner XML: [{tag, attrs, inner, text}].
 * Handles nesting of same-named tags well enough for Roku's flat answers.
 */
export function xmlChildren(inner) {
  const children = [];
  const re = new RegExp(`<(${NAME})(\\s[^>]*?)?(/?)>`, "g");
  let m;
  while ((m = re.exec(inner))) {
    const tag = m[1];
    const attrs = xmlAttrs(m[2] || "");
    if (m[3] === "/") {
      children.push({ tag, attrs, inner: "", text: "" });
      continue;
    }
    // Find the matching close tag, counting nested opens of the same name.
    const scan = new RegExp(`<(/?)${tag.replace(/[.]/g, "\\.")}(?:\\s[^>]*?)?(/?)>`, "g");
    scan.lastIndex = re.lastIndex;
    let depth = 1;
    let end = -1;
    let after = -1;
    let s;
    while ((s = scan.exec(inner))) {
      if (s[1] === "/") depth -= 1;
      else if (s[2] !== "/") depth += 1;
      if (depth === 0) { end = s.index; after = scan.lastIndex; break; }
    }
    if (end === -1) throw new ParseError();
    const body = inner.slice(re.lastIndex, end);
    children.push({ tag, attrs, inner: body, text: xmlText(body) });
    re.lastIndex = after;
  }
  return children;
}

/** Every element named `tag` anywhere in the XML (like ElementTree's iter()). */
export function xmlFindAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${tag}\\s*>)`, "g");
  for (const m of stripProlog(xml).matchAll(re)) {
    out.push({ tag, attrs: xmlAttrs(m[1] || ""), inner: m[2] || "", text: xmlText(m[2] || "") });
  }
  return out;
}

// --- Requests --------------------------------------------------------------------------

/**
 * One ECP request. Returns {status, text, bytes, ctype}. Network failures -> TVError.
 * HTTP errors are returned, not thrown, like the Python version.
 */
export async function ecp(target, path, method = "GET", { timeout = 4000, binary = false } = {}) {
  const url = `http://${target.host}:${target.port}/${path}`;
  let resp;
  const started = Date.now();
  try {
    resp = await fetchWithTimeout(url, {
      method,
      body: method === "POST" ? "" : undefined,
      cache: "no-store",
      credentials: "omit",
      redirect: "manual",
      referrerPolicy: "no-referrer",
    }, timeout);
  } catch {
    const why = await lastNetError(target.host, String(target.port), started);
    throw new TVError(explainFailure(why, displayAddress(target))
      || "The TV didn't answer. Check it's turned on and on the same Wi-Fi.");
  }
  const ctype = resp.headers.get("Content-Type") || "";
  let bytes = null;
  let text = "";
  try {
    if (binary && resp.ok) bytes = new Uint8Array(await resp.arrayBuffer());
    else text = await resp.text();
  } catch {
    throw new TVError("The TV didn't answer. Check it's turned on and on the same Wi-Fi.");
  }
  return { status: resp.status, text, bytes, ctype };
}

export function isBlocked(status, body) {
  return status === 401 || status === 403 || String(body || "").toLowerCase().includes("not allowed");
}

export function check(status, body) {
  if (isBlocked(status, body)) throw new Blocked();
  if (status >= 300 || status === 0) throw new TVError(`The TV refused the request (error ${status}).`);
}

export async function deviceInfo(target) {
  const { status, text } = await ecp(target, "query/device-info");
  check(status, text);
  return parseDeviceInfo(text);
}

export function parseDeviceInfo(xml) {
  const root = xmlRoot(xml);
  if (root.tag !== "device-info") throw new TVError("That device didn't answer like a Roku.");
  const info = {};
  for (const child of xmlChildren(root.inner)) info[child.tag] = child.text.trim();
  return info;
}

export function summarize(target, info) {
  return {
    address: displayAddress(target),
    name: info["user-device-name"] || info["friendly-device-name"] || info["default-device-name"] || "Roku",
    model: info["friendly-model-name"] || "",
    modelNumber: info["model-number"] || "",
    vendor: info["vendor-name"] || "",
    software: info["software-version"] || "",
    isTv: info["is-tv"] === "true",
    screenSize: info["screen-size"] || "",
    uptime: parseInt(info.uptime || "0", 10) || 0,
    powerMode: info["power-mode"] || "",
    accessMode: info["ecp-setting-mode"] || "",
    country: info.country || "",
    serial: info["serial-number"] || "",
  };
}

export function classify(app) {
  const name = app.name.toLowerCase();
  if (app.type === "tvin") return "input";
  if (app.type !== "appl") return "system";
  if (ROKU_OWNED_IDS.has(app.id) || name.startsWith("roku ") || name.startsWith("the roku ") || name.includes("roku channel")) return "roku";
  if (FREE_WITH_ADS.some((fragment) => name.includes(fragment))) return "free";
  return "app";
}

export function parseApps(xml) {
  xmlRoot(xml); // must be XML at all
  return xmlFindAll(xml, "app").map((node) => {
    const app = {
      id: node.attrs.id || "",
      type: node.attrs.type || "",
      version: node.attrs.version || "",
      name: node.text.trim(),
    };
    app.group = classify(app);
    app.subscription = SUBSCRIPTION_APPS.has(app.id);
    return app;
  });
}

export async function listApps(target) {
  const { status, text } = await ecp(target, "query/apps");
  check(status, text);
  return parseApps(text);
}

export async function canControl(target) {
  try {
    const { status, text } = await ecp(target, "query/apps");
    return status === 200 && !isBlocked(status, text);
  } catch (err) {
    if (err instanceof TVError) return false;
    throw err;
  }
}

export function parseActiveApp(xml) {
  const root = xmlRoot(xml);
  const node = xmlChildren(root.inner).find((c) => c.tag === "app");
  if (!node) return { id: "", name: "" };
  return { id: node.attrs.id || "", name: node.text.trim() };
}

export async function activeApp(target) {
  const { status, text } = await ecp(target, "query/active-app");
  check(status, text);
  return parseActiveApp(text);
}

export async function press(target, key) {
  key = String(key);
  let path;
  if (key.startsWith("Lit_") && Array.from(key).length === 5) path = "keypress/Lit_" + quote(key.slice(4));
  else if (KEYS.has(key)) path = "keypress/" + key;
  else throw new ValueError("Unknown remote button.");
  const { status, text } = await ecp(target, path, "POST");
  check(status, text);
}

export async function pressSequence(target, keys, delay = 350) {
  for (const key of keys) {
    await press(target, key);
    await sleep(delay);
  }
}

export async function typeText(target, text) {
  return keepAlive(pressSequence(target, Array.from(text, (ch) => "Lit_" + ch), 80));
}

export async function restart(target) {
  return keepAlive(pressSequence(target, RESTART_SEQUENCE));
}

export async function openStorePage(target, appId) {
  const quoted = quote(appId);
  let { status, text } = await ecp(target, `launch/${STORE_APP_ID}?contentID=${quoted}`, "POST");
  if (status < 300 && status !== 0) return;
  if (isBlocked(status, text)) throw new Blocked();
  // Older Roku OS versions only support the install command.
  ({ status, text } = await ecp(target, `install/${quoted}`, "POST"));
  check(status, text);
}

export async function launch(target, appId, params = null) {
  let path = `launch/${quote(appId)}`;
  if (params && Object.keys(params).length) path += "?" + urlencode(params);
  const { status, text } = await ecp(target, path, "POST");
  check(status, text);
}

// Icons: fetched once per TV and app, kept in memory as data: URLs.
const ICONS = new Map();
const ICONS_MAX = 400;

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** data: URL of an app's icon, or null when the TV has none. */
export async function fetchIcon(target, appId) {
  if (!APP_ID_RE.test(appId)) throw new ValueError("Bad channel id.");
  const key = `${targetKey(target)}|${appId}`;
  if (ICONS.has(key)) return ICONS.get(key);
  const { status, bytes, ctype } = await ecp(target, `query/icon/${quote(appId)}`, "GET", { binary: true });
  if (status !== 200 || !ctype.startsWith("image/") || !bytes) return null;
  const type = ctype.split(";")[0].trim();
  const dataUrl = `data:${type};base64,${toBase64(bytes)}`;
  if (ICONS.size >= ICONS_MAX) ICONS.delete(ICONS.keys().next().value);
  ICONS.set(key, dataUrl);
  return dataUrl;
}

export function parseMediaPlayer(xml) {
  const root = xmlRoot(xml);
  const children = xmlChildren(root.inner);
  const plugin = children.find((c) => c.tag === "plugin");
  const textOf = (tag) => (children.find((c) => c.tag === tag) || {}).text || "";
  const millis = (tag) => {
    const m = textOf(tag).match(/^\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  };
  return {
    state: root.attrs.state || "",
    appId: plugin ? plugin.attrs.id || "" : "",
    app: plugin ? plugin.attrs.name || "" : "",
    position: millis("position"),
    duration: millis("duration"),
    live: textOf("is_live").trim() === "true",
  };
}

/** What's on screen, and if something is playing, how far in it is. */
export async function nowPlaying(target) {
  const { status, text } = await ecp(target, "query/media-player");
  check(status, text);
  const now = parseMediaPlayer(text);
  now.screen = await activeApp(target);
  return now;
}

/**
 * Open Roku's search screen and type the words in. Roku removed the ECP search command
 * in Roku OS 12, so this does what the Roku phone app does: press Search, then type.
 */
export async function search(target, keyword) {
  return keepAlive((async () => {
    await press(target, "Search");
    await sleep(1500);
    await pressSequence(target, Array.from(keyword, (ch) => "Lit_" + ch), 80);
  })());
}

/** Run a saved scene's steps in order (see clean_scenes in store.js). */
export async function runScene(target, scene) {
  return keepAlive((async () => {
    for (const step of scene.steps) {
      const action = step.do;
      if (action === "power_on") {
        await press(target, "PowerOn");
        await sleep(4000); // give the TV time to wake up
      } else if (action === "power_off") {
        await press(target, "PowerOff");
      } else if (action === "open") {
        await launch(target, step.target);
        await sleep(2000);
      } else if (action === "volume_up") {
        await pressSequence(target, Array(step.n).fill("VolumeUp"), 150);
      } else if (action === "volume_down") {
        await pressSequence(target, Array(step.n).fill("VolumeDown"), 150);
      } else if (action === "mute") {
        await press(target, "VolumeMute");
      } else if (action === "wait") {
        await sleep(step.n * 1000);
      }
    }
  })());
}

// --- Detox Home (Roku's "dev" app slot) ---------------------------------------------------

const TV_APP_SEEN = new Map(); // target key -> {at, present}

/** Is Detox Home installed on this TV? */
export async function tvAppPresent(target, maxAge = 60) {
  const key = targetKey(target);
  const checked = TV_APP_SEEN.get(key);
  if (checked && Date.now() / 1000 - checked.at < maxAge) return checked.present;
  let present;
  try {
    present = (await listApps(target)).some((a) => a.id === "dev");
  } catch (err) {
    if (err instanceof TVError) return Boolean(checked && checked.present);
    throw err;
  }
  TV_APP_SEEN.set(key, { at: Date.now() / 1000, present });
  return present;
}

/**
 * Open Detox Home showing a video, message or notice. Without the Mac, the item travels
 * inside the deep link (ENGINE.md, "Detox Home (TV app) without the Mac").
 */
export async function showOnTv(target, kind, item) {
  // A "not installed" answer is checked again: it may have just been installed from the TV's installer page.
  if (!(await tvAppPresent(target)) && !(await tvAppPresent(target, 0))) {
    throw new ValueError("Detox Home isn't on this TV yet. Install it from the TV's installer page first (see the TV app menu).");
  }
  const params = { contentId: "inline", mediaType: kind };
  for (const [key, value] of Object.entries(item)) {
    if (value !== undefined && value !== null && value !== "") params[key] = String(value);
  }
  let inFront = false;
  try {
    inFront = (await activeApp(target)).id === "dev";
  } catch (err) {
    if (!(err instanceof TVError)) throw err;
  }
  if (inFront) { // already open: hand it the new item instead of restarting it
    const { status, text } = await ecp(target, "input?" + urlencode(params), "POST");
    check(status, text);
  } else {
    await launch(target, "dev", params);
  }
}

/** Show a rule's notice on the TV if Detox Home is installed. Returns true if shown. */
export async function friendlyNotice(target, title, text) {
  try {
    if (!(await tvAppPresent(target))) return false;
    await showOnTv(target, "notice", { title, text });
    return true;
  } catch (err) {
    if (err instanceof TVError || err instanceof ValueError) return false;
    throw err;
  }
}

/**
 * Newer Roku OS versions refuse ECP requests that carry a browser Origin header unless
 * the TV is set to Permissive. Strip it from this extension's own requests to the TV (requests
 * that belong to no tab: the service worker's), like the Python program, which sends none.
 */
export async function installEcpHeaderRule() {
  const dnr = globalThis.chrome?.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [1000],
      addRules: [{
        id: 1000,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
        condition: {
          regexFilter: "^http://[0-9.]+:[0-9]+/(query|keypress|launch|install|input|search)",
          tabIds: [chrome.tabs?.TAB_ID_NONE ?? -1], // this worker's own requests, never a web page's
          resourceTypes: ["xmlhttprequest", "other"],
        },
      }],
    });
  } catch (err) {
    console.warn("Roku Detox: couldn't add the TV header rule", err);
  }
}
