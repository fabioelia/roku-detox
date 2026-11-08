// End-to-end encryption for the Roku Detox relay. Used by BOTH the phone page and the extension.
// WebCrypto only (globalThis.crypto.subtle): works in browsers on https:// pages, in MV3 service workers
// and in Node 20+. The relay never sees the household key, only {id, iv, ct} frames.
//
// - Household key: 32 random bytes, passed around as a base64url string (43 characters).
// - Room id:       base64url(SHA-256(key)) cut to 22 characters. The only thing the relay learns.
// - Message key:   HKDF-SHA-256(key, salt = empty, info = "roku-detox-relay-v1") -> AES-GCM 256.
// - Frame:         {id, iv, ct}: AES-GCM with a random 12-byte IV and AAD = roomId.
//   The plaintext is an envelope {v: 1, id, kind: "req" | "res", ts, body}. decrypt() checks that the
//   envelope id matches the frame id and (optionally) the kind and age, so the relay can't swap replies
//   between requests, bounce a request back as a reply, or replay an old command later.

export const INFO = "roku-detox-relay-v1";
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const ROOM_ID_LENGTH = 22;
export const ENVELOPE_VERSION = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class RelayCryptoError extends Error {
  // code: "key" (bad household key), "format" (not a frame), "auth" (tampered or wrong key/room),
  //       "id" (frame id doesn't match the sealed id), "kind" (request/reply mix-up), "stale" (too old or clock off)
  constructor(code, message) {
    super(message);
    this.name = "RelayCryptoError";
    this.code = code;
  }
}

function webCrypto() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new RelayCryptoError("key", "Encryption isn't available here. The page has to be opened over https://.");
  }
  return c;
}

export function toBase64Url(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new RelayCryptoError("format", "Not base64url text.");
  }
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function keyBytes(key) {
  let bytes;
  if (typeof key === "string") {
    try { bytes = fromBase64Url(key.trim()); } catch { bytes = null; }
  } else if (key instanceof Uint8Array) {
    bytes = key;
  } else if (key instanceof ArrayBuffer) {
    bytes = new Uint8Array(key);
  }
  if (!bytes || bytes.length !== KEY_BYTES) {
    throw new RelayCryptoError("key", "That household key isn't valid. Make a new phone link on the computer.");
  }
  return bytes;
}

/** The household key as its canonical base64url string (accepts a string, Uint8Array or ArrayBuffer). */
export function normalizeKey(key) {
  return toBase64Url(keyBytes(key));
}

/** A new household key: 32 random bytes as a base64url string. Made once by the extension. */
export function newHouseholdKey() {
  return toBase64Url(webCrypto().getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** A random request id (16 bytes, base64url, 22 characters). */
export function newMessageId() {
  return toBase64Url(webCrypto().getRandomValues(new Uint8Array(16)));
}

/** roomId = base64url(SHA-256(key))[0..22]. Safe to show the relay; it can't be turned back into the key. */
export async function roomIdFor(key) {
  const digest = await webCrypto().subtle.digest("SHA-256", keyBytes(key));
  return toBase64Url(digest).slice(0, ROOM_ID_LENGTH);
}

const aesKeys = new Map(); // canonical key string -> Promise<CryptoKey> (derivation is cached per key)

function aesKeyFor(key) {
  const name = normalizeKey(key);
  let pending = aesKeys.get(name);
  if (!pending) {
    pending = (async () => {
      const { subtle } = webCrypto();
      const base = await subtle.importKey("raw", keyBytes(key), "HKDF", false, ["deriveKey"]);
      return subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(INFO) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    pending.catch(() => aesKeys.delete(name));
    aesKeys.set(name, pending);
  }
  return pending;
}

/**
 * Seal any JSON value into a relay frame {id, iv, ct}.
 * options.id: the request id (a reply reuses the request's id; new id if missing)
 * options.kind: "req" (phone -> computer, the default) or "res" (computer -> phone)
 */
export async function encrypt(key, roomId, obj, { id = newMessageId(), kind = "req", now = Date.now() } = {}) {
  if (typeof roomId !== "string" || !roomId) throw new RelayCryptoError("format", "Missing room id.");
  const iv = webCrypto().getRandomValues(new Uint8Array(IV_BYTES));
  const envelope = { v: ENVELOPE_VERSION, id, kind, ts: now, body: obj === undefined ? null : obj };
  const ct = await webCrypto().subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(roomId), tagLength: 128 },
    await aesKeyFor(key),
    encoder.encode(JSON.stringify(envelope)),
  );
  return { id, iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

/**
 * Open a relay frame and return the original value. Throws RelayCryptoError if anything is off.
 * options.kind: required envelope kind ("req" on the computer, "res" on the phone)
 * options.maxAgeMs: reject envelopes whose timestamp is further than this from `now` (replay window)
 */
export async function decrypt(key, roomId, frame, { kind, maxAgeMs, now = Date.now() } = {}) {
  if (!frame || typeof frame !== "object" || typeof frame.id !== "string") {
    throw new RelayCryptoError("format", "Not a relay frame.");
  }
  const iv = fromBase64Url(frame.iv);
  const ct = fromBase64Url(frame.ct);
  if (iv.length !== IV_BYTES || ct.length < 16) throw new RelayCryptoError("format", "Not a relay frame.");
  const aesKey = await aesKeyFor(key);
  let plain;
  try {
    plain = await webCrypto().subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(String(roomId)), tagLength: 128 },
      aesKey,
      ct,
    );
  } catch {
    throw new RelayCryptoError("auth", "This message was changed on the way, or it wasn't made with this household's key.");
  }
  let envelope;
  try {
    envelope = JSON.parse(decoder.decode(plain));
  } catch {
    throw new RelayCryptoError("format", "The message inside isn't readable.");
  }
  if (!envelope || envelope.v !== ENVELOPE_VERSION) {
    throw new RelayCryptoError("format", "This message comes from a different version of Roku Detox.");
  }
  if (envelope.id !== frame.id) throw new RelayCryptoError("id", "This message was moved from another request.");
  if (kind && envelope.kind !== kind) throw new RelayCryptoError("kind", "This message went the wrong way.");
  if (maxAgeMs != null && !(Math.abs(now - Number(envelope.ts)) <= maxAgeMs)) {
    throw new RelayCryptoError("stale", "This message is too old, or the phone's clock is wrong.");
  }
  return envelope.body;
}

/**
 * The household key from a phone link's hash ("#k=<key>", "k=<key>" or a whole link). null if missing/invalid.
 * The key lives in the #fragment, which browsers never send to any server.
 */
export function keyFromLink(hash) {
  if (typeof hash !== "string") return null;
  const at = hash.indexOf("#");
  const value = new URLSearchParams(at >= 0 ? hash.slice(at + 1) : hash).get("k");
  if (!value) return null;
  try {
    return normalizeKey(value);
  } catch {
    return null;
  }
}

/** The phone link: https://<relay host>/#k=<key>. `host` may be "relay.example.com" or a full origin. */
export function linkFor(host, key) {
  const text = String(host || "").trim();
  if (!text) throw new RelayCryptoError("format", "Missing relay address.");
  const base = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  return `${base.origin}/#k=${normalizeKey(key)}`;
}
