// The Cloudflare glue (worker.js fetch handler + Room) driven over real Request/Response objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { MAX_BODY_BYTES } from "../src/relay-core.js";
import { RELAY, makeNetwork } from "./fakes.js";

const ROOM = "abcdefghijklmnopqrstuv";
const FRAME = JSON.stringify({ id: "request-id-0000001", iv: "A".repeat(16), ct: "B".repeat(40) });
const post = (net, body, path = `/room/${ROOM}/request`) =>
  worker.fetch(new Request(`${RELAY}${path}`, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body }), net.env);

test("CORS preflight on /request allows any origin", async () => {
  const net = makeNetwork();
  const res = await worker.fetch(new Request(`${RELAY}/room/${ROOM}/request`, { method: "OPTIONS", headers: { Origin: "https://anywhere.example" } }), net.env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Content-Type/i);
});

test("POST /request with no computer connected -> 503 JSON with CORS headers", async () => {
  const net = makeNetwork();
  const res = await post(net, FRAME);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await res.json(), { error: "The computer with Roku Detox isn't online." });
  assert.deepEqual([...net.roomIds], [ROOM]); // one Durable Object per room id
});

test("bodies over 64 KB are refused before reaching the room", async () => {
  const net = makeNetwork();
  const res = await post(net, "x".repeat(MAX_BODY_BYTES + 1));
  assert.equal(res.status, 413);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(net.roomFetches, 0);
  const declared = await worker.fetch(new Request(`${RELAY}/room/${ROOM}/request`, { method: "POST", headers: { "Content-Length": String(MAX_BODY_BYTES + 1) }, body: "{}" }), net.env).catch(() => null);
  if (declared) assert.equal(declared.status, 413); // some runtimes refuse a lying Content-Length themselves
});

test("bad JSON -> 400; wrong method -> 405; unknown routes -> 404", async () => {
  const net = makeNetwork();
  assert.equal((await post(net, "{nope")).status, 400);
  const get = await worker.fetch(new Request(`${RELAY}/room/${ROOM}/request`), net.env);
  assert.equal(get.status, 405);
  assert.match(get.headers.get("Allow"), /POST/);
  assert.equal((await post(net, FRAME, "/room/too-short/request")).status, 404);
  assert.equal((await worker.fetch(new Request(`${RELAY}/elsewhere`), net.env)).status, 404);
  const home = await worker.fetch(new Request(`${RELAY}/`), net.env);
  assert.deepEqual(await home.json(), { ok: true, service: "roku-detox-relay" });
});

test("the host route needs a WebSocket upgrade", async () => {
  const net = makeNetwork();
  const res = await worker.fetch(new Request(`${RELAY}/room/${ROOM}/host`), net.env);
  assert.equal(res.status, 426);
  assert.equal(res.headers.get("Upgrade"), "websocket");
});

test("429 with Retry-After once a room passes its per-minute limit", async () => {
  const net = makeNetwork({ rateLimit: 2 });
  assert.equal((await post(net, FRAME)).status, 503);
  assert.equal((await post(net, FRAME)).status, 503);
  const res = await post(net, FRAME);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("Retry-After")) >= 1);
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /Retry-After/);
});

test("the phone page is served from static assets when configured", async () => {
  const net = makeNetwork();
  const env = { ...net.env, ASSETS: { fetch: (req) => new Response(`page for ${new URL(req.url).pathname}`) } };
  const res = await worker.fetch(new Request(`${RELAY}/`), env);
  assert.equal(await res.text(), "page for /");
  assert.equal((await worker.fetch(new Request(`${RELAY}/room/${ROOM}/request`, { method: "POST", body: FRAME }), env)).status, 503);
});
