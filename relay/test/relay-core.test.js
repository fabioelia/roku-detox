import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BODY_BYTES,
  MAX_REPLY_BYTES,
  MESSAGES,
  RateLimiter,
  RoomCore,
  fitsInBytes,
  isRoomId,
  parseRoute,
  validateFrame,
} from "../src/relay-core.js";

const ROOM = "abcdefghijklmnopqrstuv"; // 22 chars
const frame = (id = "request-id-0000001", extra = {}) => ({ id, iv: "A".repeat(16), ct: "B".repeat(40), ...extra });
const body = (value) => JSON.stringify(value);

/** A host socket that records what the relay sends it. */
function fakeHost() {
  return {
    sent: [],
    send(text) {
      this.sent.push(text);
    },
  };
}

test("routes: only /room/<22-char id>/(host|request)", () => {
  assert.deepEqual(parseRoute(`/room/${ROOM}/host`), { roomId: ROOM, action: "host" });
  assert.deepEqual(parseRoute(`/room/${ROOM}/request`), { roomId: ROOM, action: "request" });
  assert.deepEqual(parseRoute(`/room/${ROOM}/request/`), { roomId: ROOM, action: "request" });
  for (const bad of ["/", "/room", `/room/${ROOM}`, `/room/${ROOM}x/host`, "/room/short/host", `/room/${ROOM}/other`, `/room/${ROOM.slice(0, 21)}!/host`]) {
    assert.equal(parseRoute(bad), null, bad);
  }
  assert.equal(isRoomId(ROOM), true);
  assert.equal(isRoomId("nope"), false);
});

test("frame validation keeps only {id, iv, ct}", () => {
  const ok = validateFrame(frame(undefined, { secret: "dropped", status: 1 }));
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.frame).sort(), ["ct", "id", "iv"]);
  for (const bad of [null, [], "x", frame("short"), frame(undefined, { iv: "A".repeat(15) }), frame(undefined, { ct: "B".repeat(10) }), frame(undefined, { ct: "B+/=" + "B".repeat(30) }), frame(undefined, { ct: 5 })]) {
    assert.equal(validateFrame(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateFrame(frame(undefined, { ct: "B".repeat(MAX_BODY_BYTES + 1) })).ok, false);
  assert.equal(validateFrame(frame(undefined, { ct: "B".repeat(MAX_BODY_BYTES + 1) }), MAX_REPLY_BYTES).ok, true);
});

test("byte size check counts UTF-8 bytes", () => {
  assert.equal(fitsInBytes("a".repeat(10), 10), true);
  assert.equal(fitsInBytes("a".repeat(11), 10), false);
  assert.equal(fitsInBytes("é".repeat(5), 10), true); // 2 bytes each
  assert.equal(fitsInBytes("é".repeat(6), 10), false);
  assert.equal(fitsInBytes(null, 10), false);
});

test("rate limiter: 30 per rolling minute, then Retry-After", () => {
  const limiter = new RateLimiter({ limit: 30, windowMs: 60_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) assert.equal(limiter.take(t0 + i * 100).ok, true);
  const denied = limiter.take(t0 + 3000);
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterSec, 57);
  assert.equal(limiter.take(t0 + 60_000).ok, true); // the first hit has rolled out of the window
  assert.equal(limiter.take(t0 + 60_001).ok, false);
});

test("no host connected -> 503 with the plain-English message", async () => {
  const core = new RoomCore({ getHosts: () => [] });
  const result = await core.handleRequest(body(frame()));
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: "The computer with Roku Detox isn't online." });
  assert.equal(core.pendingCount, 0);
});

test("a request is forwarded to the newest host and matched with its reply", async () => {
  const newest = fakeHost();
  const older = fakeHost();
  const core = new RoomCore({ getHosts: () => [newest, older] });
  const pending = core.handleRequest(body(frame("req-aaaaaaaaaaaaaa", { extra: "not forwarded" })));
  assert.equal(newest.sent.length, 1);
  assert.equal(older.sent.length, 0);
  assert.deepEqual(JSON.parse(newest.sent[0]), frame("req-aaaaaaaaaaaaaa"));
  assert.equal(core.pendingCount, 1);

  // An unrelated reply is ignored; the matching one resolves the request.
  assert.equal(core.handleHostMessage(body(frame("someone-else-0000")), newest), null);
  core.handleHostMessage(body({ id: "req-aaaaaaaaaaaaaa", iv: "C".repeat(16), ct: "D".repeat(50) }), newest);
  const result = await pending;
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: "req-aaaaaaaaaaaaaa", iv: "C".repeat(16), ct: "D".repeat(50) });
  assert.equal(core.pendingCount, 0);
});

test("concurrent requests are matched by id, in any order", async () => {
  const host = fakeHost();
  const core = new RoomCore({ getHosts: () => [host] });
  const ids = ["first-request-0001", "second-request-002", "third-request-0003"];
  const pendings = ids.map((id) => core.handleRequest(body(frame(id))));
  for (const id of [...ids].reverse()) core.handleHostMessage(body({ id, iv: "E".repeat(16), ct: id.padEnd(30, "x") }), host);
  const results = await Promise.all(pendings);
  results.forEach((r, i) => assert.equal(r.body.ct, ids[i].padEnd(30, "x")));
});

test("if the newest host's socket throws, the next host gets the request", async () => {
  const broken = { send() { throw new Error("closed"); } };
  const working = fakeHost();
  const core = new RoomCore({ getHosts: () => [broken, working] });
  const pending = core.handleRequest(body(frame()));
  assert.equal(working.sent.length, 1);
  core.handleHostMessage(working.sent[0], working); // echo is a valid frame with the same id
  assert.equal((await pending).status, 200);

  const allBroken = new RoomCore({ getHosts: () => [broken] });
  assert.equal((await allBroken.handleRequest(body(frame()))).status, 503);
  assert.equal(allBroken.pendingCount, 0);
});

test("no reply in time -> 504, and a late reply is dropped", async () => {
  const host = fakeHost();
  const core = new RoomCore({ getHosts: () => [host], timeoutMs: 20 });
  const result = await core.handleRequest(body(frame()));
  assert.equal(result.status, 504);
  assert.equal(result.body.error, MESSAGES.timeout);
  assert.equal(core.pendingCount, 0);
  assert.equal(core.handleHostMessage(host.sent[0], host), null); // nothing to settle, no crash
});

test("bad input: 413 too big, 400 not JSON, 400 not a frame, 409 duplicate id", async () => {
  const host = fakeHost();
  const core = new RoomCore({ getHosts: () => [host], timeoutMs: 50 });
  assert.equal((await core.handleRequest("x".repeat(MAX_BODY_BYTES + 1))).status, 413);
  assert.equal((await core.handleRequest("é".repeat(MAX_BODY_BYTES / 2 + 1))).status, 413);
  assert.equal((await core.handleRequest("{not json")).status, 400);
  assert.equal((await core.handleRequest(body({ id: "x" }))).status, 400);
  const first = core.handleRequest(body(frame("duplicate-id-00001")));
  assert.equal((await core.handleRequest(body(frame("duplicate-id-00001")))).status, 409);
  assert.equal(host.sent.length, 1);
  assert.equal((await first).status, 504);
});

test("more than the per-minute limit -> 429 with Retry-After", async () => {
  let now = 5_000_000;
  const core = new RoomCore({ getHosts: () => [], rateLimit: 3, now: () => now });
  for (let i = 0; i < 3; i++) assert.equal((await core.handleRequest(body(frame()))).status, 503);
  const limited = await core.handleRequest(body(frame()));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["Retry-After"], "60");
  assert.equal(limited.body.retryAfter, 60);
  now += 60_000;
  assert.equal((await core.handleRequest(body(frame()))).status, 503);
});

test("a host that can't open the request answers {id, error} -> 502 right away", async () => {
  const host = fakeHost();
  const core = new RoomCore({ getHosts: () => [host] });
  const pending = core.handleRequest(body(frame("unreadable-req-001")));
  core.handleHostMessage(body({ id: "unreadable-req-001", error: "unreadable" }), host);
  const result = await pending;
  assert.equal(result.status, 502);
  assert.equal(result.body.error, MESSAGES.unreadable);
});

test("when the host disconnects, its waiting requests fail with 503", async () => {
  const hosts = [fakeHost()];
  const core = new RoomCore({ getHosts: () => hosts });
  const pending = core.handleRequest(body(frame()));
  const [gone] = hosts.splice(0, 1);
  core.hostGone(gone);
  const result = await pending;
  assert.equal(result.status, 503);
  assert.equal(result.body.error, MESSAGES.hostGone);
});

test("keep-alive: 'ping' -> 'pong'; junk from a host is ignored", () => {
  const core = new RoomCore();
  assert.equal(core.handleHostMessage("ping"), "pong");
  assert.equal(core.handleHostMessage(new TextEncoder().encode("ping")), "pong");
  assert.equal(core.handleHostMessage("not json"), null);
  assert.equal(core.handleHostMessage(body({ hello: 1 })), null);
  assert.equal(core.handleHostMessage(body(frame(undefined, { ct: "B".repeat(MAX_REPLY_BYTES + 10) }))), null);
});
