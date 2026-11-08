// Shared helpers: errors that map to HTTP statuses, TV address checks, and small
// ports of the Python standard library bits roku_detox.py relies on.

export const ECP_PORT = 8060;
export const APP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_BODY = 64 * 1024;

// --- Errors (same statuses and texts as roku_detox.py's Handler.run) -----------

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** The TV (or a site) couldn't be reached or gave an unexpected answer -> 502. */
export class TVError extends HttpError {
  constructor(message) { super(502, message); }
}

/** The TV refused because 'Control by mobile apps' is set to Limited -> 409 + blocked. */
export class Blocked extends TVError {
  constructor() {
    super("The TV is blocking this. On the TV, set Settings > System > "
      + "Advanced system settings > Control by mobile apps > Network access to Default.");
    this.status = 409;
    this.extra = { blocked: true };
  }
}

/** The TV's answer wasn't XML we understand (Python's ET.ParseError) -> 502. */
export class ParseError extends TVError {
  constructor() { super("The TV sent an answer this program doesn't understand."); }
}

/** Bad input (Python's ValueError) -> 400. */
export class ValueError extends HttpError {
  constructor(message) { super(400, message); }
}

/** Something only the home program can do -> 501 with `needs`. */
export class NotSupported extends HttpError {
  constructor(message, needs = "home") { super(501, message, { needs }); }
}

// --- TV addresses ----------------------------------------------------------------

// Python's ipaddress IPv4 "is_private" networks (3.10), plus loopback.
const PRIVATE_NETS = [
  "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/29",
  "192.0.0.170/31", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
  "203.0.113.0/24", "240.0.0.0/4", "255.255.255.255/32",
].map((cidr) => {
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return { base: (ipv4ToInt(base) & mask) >>> 0, mask };
});

/** '192.168.1.20' -> 32-bit number, or null if it isn't a strict dotted IPv4 address. */
export function ipv4ToInt(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part[0] === "0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

export function isPrivateIPv4(host) {
  const n = ipv4ToInt(host);
  if (n === null || n === 0) return false; // 0.0.0.0 is "unspecified"
  return PRIVATE_NETS.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

/**
 * '192.168.1.50' or '192.168.1.50:8060' -> {host, port}. Only private and loopback IPv4
 * addresses are accepted, so this can't be used to reach anything outside the home network.
 */
export function parseTarget(value) {
  if (!value || typeof value !== "string") throw new ValueError("No TV address given.");
  if (value.length > 100) throw new ValueError("Enter the TV's IP address, like 192.168.1.20.");
  const trimmed = value.trim();
  const colon = trimmed.indexOf(":");
  const host = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const portText = colon === -1 ? "" : trimmed.slice(colon + 1);
  if (ipv4ToInt(host) === null) throw new ValueError("Enter the TV's IP address, like 192.168.1.20.");
  if (!isPrivateIPv4(host)) throw new ValueError("That address isn't on your home network.");
  const port = /^\d+$/.test(portText) ? Number(portText) : ECP_PORT;
  if (!(port > 0 && port < 65536)) throw new ValueError("That port number isn't valid.");
  // Other ports only for a pretend TV on this computer.
  if (port !== ECP_PORT && !host.startsWith("127.")) throw new ValueError("Roku TVs answer on port 8060. Leave the port off.");
  return { host, port };
}

export function displayAddress(target) {
  return target.port === ECP_PORT ? target.host : `${target.host}:${target.port}`;
}

export function targetKey(target) {
  return `${target.host}:${target.port}`;
}

// --- Python-ish string helpers ------------------------------------------------------

/** urllib.parse.quote(s, safe=''). */
export function quote(text) {
  return encodeURIComponent(String(text)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** urllib.parse.quote_plus(s). */
export function quotePlus(text) {
  return quote(text).replace(/%20/g, "+");
}

/** urllib.parse.urlencode(dict). */
export function urlencode(params) {
  return Object.entries(params).map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
}

/** Python's str() for the values the page may send. */
export function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Typed text from the page, like text_of() in roku_detox.py: a string, or "" for anything else. */
export function textOf(value) {
  return typeof value === "string" ? value : "";
}

/** Python's str.strip(): the same whitespace (JS trim() also strips U+FEFF but not U+001C-U+001F or U+0085). */
export function pyStrip(text) {
  return text.replace(/^[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");
}

/** Python truthiness. */
export function truthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

/** text[:n] counting code points, like Python slicing. */
export function cut(text, n) {
  const s = String(text);
  if (s.length <= n) return s;
  return Array.from(s).slice(0, n).join("");
}

/** len(text) counting code points. */
export function pyLen(text) {
  return Array.from(String(text)).length;
}

/** Python's int(value) clamped to low..high, or low when it isn't a number. */
export function boundedInt(value, low, high) {
  let n;
  if (typeof value === "boolean") n = value ? 1 : 0;
  else if (typeof value === "number") n = Number.isFinite(value) ? Math.trunc(value) : NaN;
  else if (typeof value === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(value)) n = parseInt(value.replace(/_/g, ""), 10);
  else n = NaN;
  if (Number.isNaN(n)) return low;
  return Math.max(low, Math.min(n, high));
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** datetime.now(timezone.utc).isoformat(timespec="seconds"). */
export function nowIso() {
  return new Date().toISOString().slice(0, 19) + "+00:00";
}

export function randomHex(bytes) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Local date and clock strings: '2026-11-07', '21:30'. */
export function localDay(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localClock(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** strftime("%-I:%M %p"), like '1:05 AM'. */
export function friendlyTime(date) {
  const hours = date.getHours() % 12 || 12;
  return `${hours}:${String(date.getMinutes()).padStart(2, "0")} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

/**
 * Keeps a Manifest V3 service worker awake while a long job runs (scenes, the restart
 * sequence, rule rounds): Chrome stops idle workers after 30 s without extension API calls.
 */
export async function keepAlive(promise) {
  const api = globalThis.chrome?.runtime?.getPlatformInfo;
  const timer = api ? setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch { /* ignore */ } }, 20000) : null;
  try {
    return await promise;
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** fetch() with a timeout. Network failures and timeouts reject. */
export async function fetchWithTimeout(url, options = {}, ms = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- HTML entities (enough of html.unescape for links, titles and meta tags) ----------

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  trade: "™", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", bull: "•", middot: "·",
  eacute: "é", egrave: "è", aacute: "á", agrave: "à", oacute: "ó", uacute: "ú",
  iacute: "í", ntilde: "ñ", ccedil: "ç", ouml: "ö", uuml: "ü", auml: "ä",
  szlig: "ß", deg: "°", times: "×", frac12: "½", euro: "€", pound: "£",
  sol: "/", colon: ":", period: ".", comma: ",", equals: "=", quest: "?", num: "#", excl: "!", lpar: "(", rpar: ")",
};

export function unescapeHtml(text) {
  if (!text || text.indexOf("&") === -1) return text || "";
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    const value = NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()];
    return value === undefined ? whole : value;
  });
}
