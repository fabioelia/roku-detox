// Pure relay logic: routing, frame validation, rate limiting and request/reply matching.
// No Cloudflare APIs here, so it runs (and is unit-tested) in plain Node. src/worker.js wraps it.
//
// The relay only ever handles opaque frames {id, iv, ct}. It can't read them: they're sealed with a key
// derived from the household key, which never leaves the phone and the computer.

export const MAX_BODY_BYTES = 64 * 1024; // phone -> relay request bodies
export const MAX_REPLY_BYTES = 1024 * 1024; // computer -> relay replies (app lists, icons, search results)
export const REQUEST_TIMEOUT_MS = 15_000;
export const RATE_LIMIT_PER_MINUTE = 120;
export const RATE_WINDOW_MS = 60_000;
export const MAX_HOSTS_PER_ROOM = 4;

export const MESSAGES = {
  offline: "The computer with Roku Detox isn't online.",
  timeout: "The computer with Roku Detox didn't answer in time.",
  hostGone: "The computer with Roku Detox went offline before it answered.",
  unreadable: "The computer couldn't read that request. Open the phone link from the computer again.",
  tooBig: "That request is too big for the relay.",
  rateLimited: "Too many requests in one minute. Wait a few seconds and try again.",
  badJson: "That isn't a Roku Detox relay message.",
  badFrame: "That relay message is missing its id, iv or ct.",
  duplicate: "A request with that id is already waiting for an answer.",
  notFound: "Not found.",
  method: "Send requests with POST.",
  upgrade: "This address is only for the Roku Detox extension's connection.",
};

const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const FRAME_ID = /^[A-Za-z0-9_-]{16,64}$/;
const FRAME_IV = /^[A-Za-z0-9_-]{16}$/; // 12 bytes
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MIN_CT_CHARS = 22; // the 16-byte AES-GCM tag alone

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isRoomId(value) {
  return typeof value === "string" && ROOM_ID.test(value);
}

/** "/room/<roomId>/host" or "/room/<roomId>/request" -> {roomId, action}; anything else -> null. */
export function parseRoute(pathname) {
  const match = /^\/room\/([A-Za-z0-9_-]{22})\/(host|request)\/?$/.exec(String(pathname || ""));
  return match ? { roomId: match[1], action: match[2] } : null;
}

/** True when `text` is at most `maxBytes` long in UTF-8 (cheap for the common case). */
export function fitsInBytes(text, maxBytes) {
  if (typeof text !== "string" || text.length > maxBytes) return false;
  if (text.length * 3 <= maxBytes) return true;
  return encoder.encode(text).byteLength <= maxBytes;
}

/** Checks a parsed value is a frame and returns ONLY {id, iv, ct}, so nothing else is ever forwarded. */
export function validateFrame(value, maxBytes = MAX_BODY_BYTES) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: MESSAGES.badFrame };
  const { id, iv, ct } = value;
  if (typeof id !== "string" || !FRAME_ID.test(id)) return { ok: false, error: MESSAGES.badFrame };
  if (typeof iv !== "string" || !FRAME_IV.test(iv)) return { ok: false, error: MESSAGES.badFrame };
  if (typeof ct !== "string" || ct.length < MIN_CT_CHARS || ct.length > maxBytes || !BASE64URL.test(ct)) {
    return { ok: false, error: MESSAGES.badFrame };
  }
  return { ok: true, frame: { id, iv, ct } };
}

/** Sliding-window limiter: at most `limit` hits in any `windowMs`. One per room. */
export class RateLimiter {
  constructor({ limit = RATE_LIMIT_PER_MINUTE, windowMs = RATE_WINDOW_MS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }

  take(now = Date.now()) {
    while (this.hits.length && now - this.hits[0] >= this.windowMs) this.hits.shift();
    if (this.hits.length >= this.limit) {
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((this.hits[0] + this.windowMs - now) / 1000)) };
    }
    this.hits.push(now);
    return { ok: true };
  }
}

function failure(status, error, headers) {
  return headers ? { status, body: { error }, headers } : { status, body: { error } };
}

/**
 * One household's room. Hosts are the computer's WebSocket(s): anything with send(text).
 * getHosts() returns the connected ones, preferred (newest) first. The Durable Object supplies them
 * from ctx.getWebSockets("host"), so this survives hibernation: only pending requests live in memory,
 * and a pending request keeps the object awake until it's answered or times out.
 */
export class RoomCore {
  constructor({
    getHosts = () => [],
    timeoutMs = REQUEST_TIMEOUT_MS,
    rateLimit = RATE_LIMIT_PER_MINUTE,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (timer) => clearTimeout(timer),
  } = {}) {
    this.getHosts = getHosts;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.limiter = new RateLimiter({ limit: rateLimit });
    this.pending = new Map(); // id -> {resolve, timer, host}
  }

  get pendingCount() {
    return this.pending.size;
  }

  /** A phone's POST body -> Promise<{status, body, headers?}>. 200 body is the computer's {id, iv, ct}. */
  handleRequest(text) {
    if (!fitsInBytes(text, MAX_BODY_BYTES)) return Promise.resolve(failure(413, MESSAGES.tooBig));
    const rate = this.limiter.take(this.now());
    if (!rate.ok) {
      return Promise.resolve({
        status: 429,
        body: { error: MESSAGES.rateLimited, retryAfter: rate.retryAfterSec },
        headers: { "Retry-After": String(rate.retryAfterSec) },
      });
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return Promise.resolve(failure(400, MESSAGES.badJson));
    }
    const checked = validateFrame(value, MAX_BODY_BYTES);
    if (!checked.ok) return Promise.resolve(failure(400, checked.error));
    const { frame } = checked;
    if (this.pending.has(frame.id)) return Promise.resolve(failure(409, MESSAGES.duplicate));
    const hosts = this.getHosts();
    if (!hosts.length) return Promise.resolve(failure(503, MESSAGES.offline));

    const wire = JSON.stringify(frame);
    return new Promise((resolve) => {
      // Registered before sending, so even an instant reply finds its request.
      const entry = { resolve, host: null, timer: null };
      this.pending.set(frame.id, entry);
      entry.timer = this.setTimer(() => this.settle(frame.id, failure(504, MESSAGES.timeout)), this.timeoutMs);
      for (const host of hosts) {
        entry.host = host;
        try {
          host.send(wire);
          return;
        } catch {
          // that socket just died: try the next computer, if any
        }
      }
      this.settle(frame.id, failure(503, MESSAGES.offline));
    });
  }

  /** A text message from a host socket. Returns text to send back to that host (the keep-alive "pong"), or null. */
  handleHostMessage(message, host) {
    const text = typeof message === "string" ? message : decoder.decode(message);
    if (text === "ping") return "pong";
    if (text.length > MAX_REPLY_BYTES * 2) return null; // can't be a valid reply; don't bother parsing
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (value && typeof value.id === "string" && typeof value.error === "string" && !("ct" in value)) {
      // The computer couldn't open the request (tampered, or a stale link): tell the phone now, not in 15 s.
      this.settle(value.id, failure(502, MESSAGES.unreadable));
      return null;
    }
    const checked = validateFrame(value, MAX_REPLY_BYTES);
    if (!checked.ok || !fitsInBytes(text, MAX_REPLY_BYTES)) return null;
    this.settle(checked.frame.id, { status: 200, body: checked.frame });
    return null; // a reply for a request that already timed out is simply dropped
  }

  /** A host socket closed or errored: fail its requests now (and all of them if no computer is left). */
  hostGone(host) {
    const remaining = this.getHosts().filter((h) => h !== host);
    for (const [id, entry] of [...this.pending]) {
      if (entry.host === host || remaining.length === 0) this.settle(id, failure(503, MESSAGES.hostGone));
    }
  }

  settle(id, result) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this.clearTimer(entry.timer);
    entry.resolve(result);
    return true;
  }
}
