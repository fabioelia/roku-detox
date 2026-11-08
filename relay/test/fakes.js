// In-process stand-ins for Cloudflare (Durable Object ctx, hibernatable server sockets) and for the
// browser WebSocket the extension uses, wired to the real worker.js / Room code. No network at all.

import worker, { Room } from "../src/worker.js";
import { parseRoute } from "../src/relay-core.js";

export const RELAY = "https://relay.test";

export const tick = () => new Promise((resolve) => setImmediate(resolve));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(check, { timeoutMs = 2000, what = "condition" } = {}) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(2);
  }
}

/** The bits of DurableObjectState the Room uses. */
export class FakeCtx {
  constructor() {
    this.sockets = [];
  }

  acceptWebSocket(ws, tags = []) {
    ws.tags = tags;
    this.sockets.push(ws);
  }

  getWebSockets(tag) {
    return this.sockets.filter((ws) => !tag || ws.tags.includes(tag));
  }

  setWebSocketAutoResponse() {}

  forget(ws) {
    this.sockets = this.sockets.filter((s) => s !== ws);
  }
}

/** The Durable Object's end of a host socket. */
export class ServerSocket {
  constructor(client, net) {
    this.client = client;
    this.net = net;
    this.readyState = 1;
    this.attachment = null;
    this.sent = [];
  }

  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment() {
    return this.attachment;
  }

  send(text) {
    if (this.readyState !== 1) throw new Error("socket closed");
    this.sent.push(text);
    setImmediate(() => this.client.receive(text));
  }

  /** Relay-side close (e.g. too many hosts, or the relay restarting). */
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.net.ctx.forget(this);
    setImmediate(() => this.client.closedByServer(code));
  }
}

/**
 * A network with one relay (worker.js + one Room per room id) and a WebSocket class wired to it.
 * net.seen collects every text the relay received (requests and host messages) to prove it's all opaque.
 */
export function makeNetwork({ rateLimit = 1000 } = {}) {
  const net = {
    ctx: new FakeCtx(),
    seen: [],
    fetchCount: 0,
    roomFetches: 0, // requests that reached a Durable Object
    refuse: false, // when true, new host sockets fail to connect
    swallowHostMessages: false, // when true, the relay ignores everything a host sends (dead link)
  };
  const env = { RATE_LIMIT_PER_MINUTE: String(rateLimit) };
  net.room = new Room(net.ctx, env);
  net.roomIds = new Set();
  env.ROOM = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: (request) => {
        net.roomFetches++;
        net.roomIds.add(id);
        return net.room.fetch(request);
      },
    }),
  };
  net.env = env;

  /** What a phone's fetch() would reach. */
  net.fetch = async (url, init = {}) => {
    net.fetchCount++;
    if (typeof init.body === "string") net.seen.push(init.body);
    return worker.fetch(new Request(url, init), env);
  };

  class FakeWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.server = null;
      FakeWebSocket.instances.push(this);
      setImmediate(() => {
        const route = parseRoute(new URL(url).pathname);
        if (net.refuse || !url.startsWith("wss://") || route?.action !== "host") {
          this.readyState = 3;
          this.onclose?.({ code: 1006 });
          return;
        }
        net.roomIds.add(route.roomId);
        this.server = new ServerSocket(this, net);
        net.room.acceptHost(this.server); // what Room.fetch does with the WebSocketPair's server end
        this.readyState = 1;
        this.onopen?.({});
      });
    }

    send(text) {
      if (this.readyState !== 1) throw new Error("socket not open");
      net.seen.push(text);
      if (net.swallowHostMessages) return;
      const server = this.server;
      setImmediate(() => {
        if (server.readyState === 1) net.room.webSocketMessage(server, text);
      });
    }

    /** Client-side close (the extension stopping, or the test pulling the plug). */
    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const server = this.server;
      if (server && server.readyState === 1) {
        server.readyState = 3;
        net.ctx.forget(server);
        setImmediate(() => net.room.webSocketClose(server, code, "", true));
      }
      setImmediate(() => this.onclose?.({ code }));
    }

    receive(text) {
      if (this.readyState === 1) this.onmessage?.({ data: text });
    }

    closedByServer(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }

  net.WebSocket = FakeWebSocket;
  return net;
}
