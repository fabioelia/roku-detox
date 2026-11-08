// Roku Detox relay: a Cloudflare Worker plus one Durable Object class (Room), one object per household.
//
//   GET  /room/<roomId>/host      WebSocket for the computer's Roku Detox extension ("host")
//   POST /room/<roomId>/request   one encrypted request from a phone; answers with the computer's encrypted reply
//
// Everything that crosses the relay is an opaque {id, iv, ct} frame. See README.md for the privacy model.
// The logic lives in relay-core.js (plain JavaScript, unit-tested in Node); this file is the Cloudflare glue.
//
// Room deliberately doesn't import "cloudflare:workers" (a plain class works as a Durable Object, including
// the WebSocket hibernation handlers), so this module can also be loaded by the Node tests.

import {
  MAX_BODY_BYTES,
  MAX_HOSTS_PER_ROOM,
  MESSAGES,
  RATE_LIMIT_PER_MINUTE,
  REQUEST_TIMEOUT_MS,
  RoomCore,
  parseRoute,
} from "./relay-core.js";

const CORS_HEADERS = {
  // Any origin may call /request: the body is encrypted and the room id is unguessable.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Retry-After",
  "Access-Control-Max-Age": "86400",
};

export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...CORS_HEADERS,
      ...headers,
    },
  });
}

/** Reads a request body as text, giving up (null) as soon as it's over `limit` bytes. */
export async function readLimited(request, limit) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = parseRoute(url.pathname);

    if (!route) {
      if (url.pathname.startsWith("/room/")) return jsonResponse(404, { error: MESSAGES.notFound });
      // The phone page, when Workers static assets are configured in wrangler.toml (binding "ASSETS").
      if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) return env.ASSETS.fetch(request);
      if (url.pathname === "/") return jsonResponse(200, { ok: true, service: "roku-detox-relay" });
      return jsonResponse(404, { error: MESSAGES.notFound });
    }

    // One Durable Object per household, addressed by the room id.
    const room = () => env.ROOM.get(env.ROOM.idFromName(route.roomId));

    if (route.action === "host") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return jsonResponse(426, { error: MESSAGES.upgrade }, { Upgrade: "websocket" });
      }
      return room().fetch(request);
    }

    // route.action === "request"
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "POST") return jsonResponse(405, { error: MESSAGES.method }, { Allow: "POST, OPTIONS" });
    const text = await readLimited(request, MAX_BODY_BYTES);
    if (text === null) return jsonResponse(413, { error: MESSAGES.tooBig });
    return room().fetch(new Request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: text,
    }));
  },
};

function connectedAt(ws) {
  try {
    return Number(ws.deserializeAttachment()?.connectedAt) || 0;
  } catch {
    return 0;
  }
}

/**
 * One household. State: the host sockets (kept by Cloudflare across hibernation, tagged "host") and,
 * in memory only, the requests waiting for an answer plus the rate limiter. Nothing is ever written to
 * storage, so a room nobody has used in 30 days is simply empty.
 */
export class Room {
  constructor(ctx, env = {}) {
    this.ctx = ctx;
    this.env = env;
    this.core = new RoomCore({
      getHosts: () => this.hosts(),
      timeoutMs: REQUEST_TIMEOUT_MS,
      rateLimit: Number(env.RATE_LIMIT_PER_MINUTE) || RATE_LIMIT_PER_MINUTE,
    });
    // Keep-alive pings are answered by Cloudflare without waking the object (no duration charges).
    if (typeof WebSocketRequestResponsePair === "function" && typeof ctx.setWebSocketAutoResponse === "function") {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  /** Open host sockets, newest first (the newest connection gets the requests). */
  hosts() {
    return this.ctx.getWebSockets("host")
      .filter((ws) => ws.readyState === undefined || ws.readyState === 1)
      .map((ws) => ({ ws, at: connectedAt(ws) }))
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.ws);
  }

  /** Accepts the server end of a new host socket (hibernation API) and drops the oldest beyond the limit. */
  acceptHost(ws) {
    this.ctx.acceptWebSocket(ws, ["host"]);
    ws.serializeAttachment({ connectedAt: Date.now() });
    for (const old of this.hosts().slice(MAX_HOSTS_PER_ROOM)) {
      try {
        old.close(4000, "Too many computers are connected to this household.");
      } catch {
        // already closed
      }
      this.core.hostGone(old);
    }
  }

  async fetch(request) {
    const route = parseRoute(new URL(request.url).pathname);
    if (route?.action === "host") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.acceptHost(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route?.action === "request" && request.method === "POST") {
      const result = await this.core.handleRequest(await request.text());
      return jsonResponse(result.status, result.body, result.headers);
    }
    return jsonResponse(404, { error: MESSAGES.notFound });
  }

  webSocketMessage(ws, message) {
    const answer = this.core.handleHostMessage(message, ws);
    if (answer) {
      try {
        ws.send(answer);
      } catch {
        // socket closed meanwhile
      }
    }
  }

  webSocketClose(ws) {
    this.core.hostGone(ws);
    try {
      ws.close(1000, "Bye");
    } catch {
      // already closed
    }
  }

  webSocketError(ws) {
    this.core.hostGone(ws);
  }
}
