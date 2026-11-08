// Both ends of the Roku Detox relay. No dependencies besides relay-crypto.js; no Cloudflare code.
//
// RelayEngine (the phone page): api(path, body) with the same contract as index.html's api(),
//   but every call is encrypted and POSTed to https://<relay>/room/<roomId>/request.
// RelayHost (the extension's service worker): keeps wss://<relay>/room/<roomId>/host open, opens each
//   request, runs it through handle(msg) (the extension's normal message router) and seals the answer.
//
// Messages are the ENGINE.md extension messages: {type: "api", method, path, query, body} -> {status, data},
// {type: "ping"} -> {ok, version, engine}, {type: "icon", tv, id} -> {dataUrl}.
// The engine also coalesces messages sent within a few milliseconds into one {type: "batch", messages}
// request (answered by RelayHost as {type: "batch", results}), so page start-up and simultaneous polls
// count as one request against the relay's per-minute limit. handle() never sees batches.

import { decrypt, encrypt, keyFromLink, linkFor, normalizeKey, roomIdFor } from "./relay-crypto.js";

export const PING_INTERVAL_MS = 20_000; // Chrome keeps an MV3 service worker alive while its WebSocket is active
export const REPLAY_WINDOW_MS = 5 * 60_000;
export const ALLOWED_TYPES = ["api", "ping", "icon"];
export const MAX_BATCH = 8;
const MAX_REQUEST_CHARS = 64 * 1024; // the relay's request limit
const MAX_REPLY_CHARS = 1024 * 1024 - 256; // just under the relay's reply limit

/** "relay.example.com" or "https://relay.example.com/anything" -> "https://relay.example.com". */
export function relayOrigin(relay) {
  const text = String(relay || "").trim();
  if (!text) throw new Error("Missing relay address.");
  return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).origin;
}

export function requestUrl(relay, roomId) {
  return `${relayOrigin(relay)}/room/${roomId}/request`;
}

export function hostSocketUrl(relay, roomId) {
  return `${relayOrigin(relay).replace(/^http/, "ws")}/room/${roomId}/host`;
}

function relayError(message, props) {
  return Object.assign(new Error(message), { status: 0, blocked: false, ...props });
}

// ---------------------------------------------------------------------------------------------------------
// Phone page
// ---------------------------------------------------------------------------------------------------------

export class RelayEngine {
  /**
   * relay: relay origin (defaults to the page's own origin, when the relay serves the page)
   * key:   the household key (base64url), e.g. keyFromLink(location.hash)
   */
  constructor({ relay = globalThis.location?.origin, key, fetch: fetchFn, timeoutMs = 20_000, batchDelayMs = 15, maxBatch = MAX_BATCH } = {}) {
    this.name = "relay";
    this.relay = relayOrigin(relay);
    this.key = normalizeKey(key);
    this.fetch = fetchFn || ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = timeoutMs;
    this.batchDelayMs = batchDelayMs;
    this.maxBatch = Math.max(1, Math.min(maxBatch, MAX_BATCH));
    this.roomId = null; // filled in once derived; the relay only ever sees this, never the key
    this._roomPromise = roomIdFor(this.key).then((id) => (this.roomId = id));
    this._queue = [];
    this._timer = null;
    this._icons = new Map();
  }

  /** A RelayEngine for a page opened from the phone link (https://<relay>/#k=<key>), or null. */
  static fromLocation(loc = globalThis.location) {
    const key = loc ? keyFromLink(loc.hash || "") : null;
    return key ? new RelayEngine({ relay: loc.origin, key }) : null;
  }

  link() {
    return linkFor(this.relay, this.key);
  }

  /** Same contract as index.html's api(): GET when body is undefined; resolves to data; throws Error with .status/.blocked/.needs. */
  async api(path, body) {
    const url = new URL(path, "https://relay.invalid");
    const answer = await this.send({
      type: "api",
      method: body === undefined ? "GET" : "POST",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: body === undefined ? null : body,
    });
    const status = Number(answer && answer.status) || 0;
    const data = answer && answer.data != null ? answer.data : {};
    if (status < 200 || status >= 300) {
      const info = data && typeof data === "object" ? data : {};
      throw relayError(info.error || `Something went wrong (${status}).`, {
        status,
        blocked: Boolean(info.blocked),
        needs: info.needs,
        pair: Boolean(info.pair),
        data: info,
      });
    }
    return data;
  }

  /** {ok, version, engine} from the extension, through the relay. Rejects with .offline when the computer is away. */
  ping() {
    return this.send({ type: "ping" });
  }

  /** An app icon as a data: URL (cached for the page's lifetime), or null. */
  icon(tv, id) {
    const cacheKey = `${tv}\n${id}`;
    if (!this._icons.has(cacheKey)) {
      const pending = this.send({ type: "icon", tv, id }).then(
        (answer) => (answer && typeof answer.dataUrl === "string" ? answer.dataUrl : null),
        () => {
          this._icons.delete(cacheKey);
          return null;
        },
      );
      this._icons.set(cacheKey, pending);
    }
    return this._icons.get(cacheKey);
  }

  /** Sends one message and resolves with the computer's raw answer. Messages sent together share one request. */
  send(msg) {
    return new Promise((resolve, reject) => {
      this._queue.push({ msg, resolve, reject });
      if (this._queue.length >= this.maxBatch) this._flush();
      else if (!this._timer) this._timer = setTimeout(() => this._flush(), this.batchDelayMs);
    });
  }

  _flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const items = this._queue.splice(0, this.maxBatch);
    if (this._queue.length) this._timer = setTimeout(() => this._flush(), this.batchDelayMs);
    if (!items.length) return;
    if (items.length === 1) {
      this._roundTrip(items[0].msg).then(items[0].resolve, items[0].reject);
      return;
    }
    this._roundTrip({ type: "batch", messages: items.map((item) => item.msg) }).then(
      (answer) => {
        const results = answer && Array.isArray(answer.results) ? answer.results : null;
        items.forEach((item, i) => {
          if (results && i < results.length) item.resolve(results[i]);
          else item.reject(relayError(answer?.data?.error || "The computer's answer didn't make sense to this page.", { status: Number(answer?.status) || 502 }));
        });
      },
      (err) => items.forEach((item) => item.reject(err)),
    );
  }

  async _roundTrip(msg) {
    const roomId = await this._roomPromise;
    const frame = await encrypt(this.key, roomId, msg, { kind: "req" });
    const body = JSON.stringify(frame);
    if (body.length > MAX_REQUEST_CHARS) throw relayError("That's too much to send through the relay at once.", { status: 413 });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res;
    try {
      res = await this.fetch(requestUrl(this.relay, roomId), {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" }, // a "simple" request: no CORS preflight round trip
        body,
        credentials: "omit",
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      if (err && err.name === "AbortError") throw relayError("The relay didn't answer in time.", { status: 504 });
      throw relayError("This phone can't reach the Roku Detox relay. Check its internet connection.", { status: 0, offline: true });
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("Retry-After")) || Number(data.retryAfter) || undefined;
      throw relayError(data.error || `The relay had a problem (${res.status}).`, {
        status: res.status,
        offline: res.status === 503,
        retryAfter,
      });
    }
    try {
      if (!data || data.id !== frame.id) throw new Error("reply for a different request");
      return await decrypt(this.key, roomId, data, { kind: "res" });
    } catch (cause) {
      throw relayError("The computer's answer couldn't be verified, so it was ignored.", { status: 502, cause });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Extension (service worker)
// ---------------------------------------------------------------------------------------------------------

export class RelayHost {
  /**
   * relay:  relay origin; key: the household key (base64url) the extension made with newHouseholdKey()
   * handle: async (msg) => answer; for {type: "api"} the answer is {status, data}
   * onStatus: (status) => void, status is "stopped" | "connecting" | "online" | "offline"
   */
  constructor({
    relay,
    key,
    handle,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    pingMs = PING_INTERVAL_MS,
    minBackoffMs = 1000,
    maxBackoffMs = 60_000,
    replayWindowMs = REPLAY_WINDOW_MS,
    allowTypes = ALLOWED_TYPES,
    onStatus,
  } = {}) {
    if (typeof handle !== "function") throw new TypeError("RelayHost needs a handle(msg) function.");
    this.relay = relayOrigin(relay);
    this.key = normalizeKey(key);
    this.handle = handle;
    this.WebSocket = WebSocketImpl;
    this.pingMs = pingMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.replayWindowMs = replayWindowMs;
    this.allowTypes = allowTypes;
    this.onStatus = onStatus;
    this.roomId = null; // filled in once derived; the relay only ever sees this, never the key
    this._roomPromise = roomIdFor(this.key).then((id) => (this.roomId = id));
    this.status = "stopped";
    this._stopped = true;
    this._ws = null;
    this._attempts = 0;
    this._retry = null;
    this._pinger = null;
    this._lastHeard = 0;
    this._seen = new Map(); // request id -> first seen (replay protection)
  }

  /** The link/QR to give phones: https://<relay>/#k=<key>. */
  link() {
    return linkFor(this.relay, this.key);
  }

  /** Connects (and keeps reconnecting). Safe to call again, e.g. every time the service worker starts. */
  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retry);
    this._retry = null;
    this._drop();
    this._setStatus("stopped");
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    try {
      this.onStatus?.(status);
    } catch {
      // a broken status callback mustn't break the connection
    }
  }

  async _connect() {
    if (this._stopped || this._ws) return;
    this._setStatus("connecting");
    let ws;
    try {
      const roomId = await this._roomPromise;
      if (this._stopped || this._ws) return;
      ws = new this.WebSocket(hostSocketUrl(this.relay, roomId));
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      if (this._ws !== ws) return;
      this._lastHeard = Date.now();
      this._setStatus("online");
      this._send(ws, "ping"); // a quick pong proves the room works and resets the backoff
      clearInterval(this._pinger);
      this._pinger = setInterval(() => this._tick(ws), this.pingMs);
    };
    ws.onmessage = (event) => {
      if (this._ws !== ws) return;
      this._lastHeard = Date.now();
      this._attempts = 0;
      this._onMessage(ws, event.data).catch(() => {});
    };
    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._drop();
      this._scheduleReconnect();
    };
    ws.onerror = () => {}; // a close event follows
  }

  _tick(ws) {
    if (this._ws !== ws) return;
    if (Date.now() - this._lastHeard > this.pingMs * 2.5) {
      // No pong for a while (laptop slept, Wi-Fi changed): the socket is dead even if it doesn't know yet.
      this._drop();
      this._scheduleReconnect();
      return;
    }
    this._send(ws, "ping");
  }

  _drop() {
    clearInterval(this._pinger);
    this._pinger = null;
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000);
    } catch {
      // already closed
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this._setStatus("offline");
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** this._attempts);
    this._attempts = Math.min(this._attempts + 1, 20);
    clearTimeout(this._retry);
    this._retry = setTimeout(() => {
      this._retry = null;
      this._connect();
    }, base / 2 + Math.random() * (base / 2));
  }

  _send(ws, text) {
    if (ws.readyState !== (this.WebSocket?.OPEN ?? 1)) return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  async _onMessage(ws, data) {
    if (typeof data !== "string" || data === "pong" || data.length > MAX_REQUEST_CHARS * 2) return;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame.id !== "string") return;
    const roomId = await this._roomPromise;
    let msg;
    try {
      msg = await decrypt(this.key, roomId, frame, { kind: "req", maxAgeMs: this.replayWindowMs });
    } catch (err) {
      if (err && err.code === "stale") {
        await this._reply(ws, roomId, frame.id, {
          status: 400,
          data: { error: "The phone's clock and this computer's clock are more than 5 minutes apart. Fix the time and try again." },
        });
      } else {
        this._send(ws, JSON.stringify({ id: frame.id, error: "unreadable" })); // reveals nothing; spares the phone a 15 s wait
      }
      return;
    }
    if (this._seenBefore(frame.id)) return; // the same sealed request again: a replay, never run twice
    await this._reply(ws, roomId, frame.id, await this._answer(msg));
  }

  _seenBefore(id) {
    const now = Date.now();
    for (const [seenId, at] of this._seen) {
      if (now - at <= this.replayWindowMs * 2) break; // Map keeps insertion (= time) order
      this._seen.delete(seenId);
    }
    if (this._seen.has(id)) return true;
    this._seen.set(id, now);
    if (this._seen.size > 5000) this._seen.delete(this._seen.keys().next().value);
    return false;
  }

  async _answer(msg) {
    if (msg && msg.type === "batch" && Array.isArray(msg.messages)) {
      const messages = msg.messages.slice(0, MAX_BATCH);
      return { type: "batch", results: await Promise.all(messages.map((m) => this._answerOne(m))) };
    }
    return this._answerOne(msg);
  }

  async _answerOne(msg) {
    if (!msg || typeof msg !== "object" || !this.allowTypes.includes(msg.type)) {
      return { status: 400, data: { error: "The computer doesn't take that kind of request from a phone." } };
    }
    try {
      const answer = await this.handle(msg);
      return answer === undefined ? null : answer;
    } catch (err) {
      return { status: 500, data: { error: (err && err.message) || "Something went wrong on the computer." } };
    }
  }

  async _reply(ws, roomId, id, answer) {
    let text = JSON.stringify(await encrypt(this.key, roomId, answer, { id, kind: "res" }));
    if (text.length > MAX_REPLY_CHARS) {
      const tooBig = { status: 413, data: { error: "That answer is too big to send to the phone." } };
      text = JSON.stringify(await encrypt(this.key, roomId, tooBig, { id, kind: "res" }));
    }
    this._send(ws, text);
  }
}
