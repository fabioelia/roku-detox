// Phone (RelayEngine) -> worker.js -> Room -> fake WebSocket -> extension (RelayHost) -> handle() and back,
// all in one process. Proves the relay only ever sees opaque frames.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayEngine, RelayHost } from "../client/relay-client.js";
import { decrypt, encrypt, newHouseholdKey, roomIdFor } from "../client/relay-crypto.js";
import { RELAY, makeNetwork, sleep, tick, waitFor } from "./fakes.js";

const TV = "192.0.2.10"; // a documentation-only address; nothing is ever contacted

async function setup(t, { handle = () => ({ status: 200, data: {} }), startHost = true, hostOptions = {}, net = makeNetwork() } = {}) {
  const key = newHouseholdKey();
  const calls = [];
  const host = new RelayHost({
    relay: RELAY,
    key,
    WebSocket: net.WebSocket,
    minBackoffMs: 4,
    maxBackoffMs: 16,
    handle: async (msg) => {
      calls.push(msg);
      return handle(msg);
    },
    ...hostOptions,
  });
  t.after(() => host.stop());
  const engine = new RelayEngine({ relay: RELAY, key, fetch: net.fetch, batchDelayMs: 3 });
  if (startHost) {
    host.start();
    await waitFor(() => host.status === "online", { what: "host online" });
  }
  return { key, host, engine, net, calls, roomId: await roomIdFor(key) };
}

test("GET: the extension gets the ENGINE.md message, the phone gets the data, the relay sees neither", async (t) => {
  const apps = [{ id: "12", type: "appl", name: "Netflix", version: "", group: "streaming", subscription: true }];
  const { key, host, engine, net, calls, roomId } = await setup(t, { handle: () => ({ status: 200, data: { apps } }) });
  assert.equal(host.link(), `${RELAY}/#k=${key}`);
  assert.equal(host.roomId, roomId);

  assert.deepEqual(await engine.api(`/api/apps?tv=${TV}`), { apps });
  assert.deepEqual(calls, [{ type: "api", method: "GET", path: "/api/apps", query: { tv: TV }, body: null }]);

  const everything = net.seen.join("\n");
  for (const secret of ["Netflix", "/api/apps", "appl", TV, key]) assert.ok(!everything.includes(secret), `relay saw ${secret}`);
  assert.deepEqual([...net.roomIds], [roomId]);
  assert.equal(engine.roomId, roomId);
});

test("POST: body and method arrive intact", async (t) => {
  const { engine, calls } = await setup(t, { handle: (msg) => ({ status: 200, data: { ok: true, echo: msg.body } }) });
  const data = await engine.api("/api/key", { tv: TV, key: "Home" });
  assert.deepEqual(data, { ok: true, echo: { tv: TV, key: "Home" } });
  assert.deepEqual(calls[0], { type: "api", method: "POST", path: "/api/key", query: {}, body: { tv: TV, key: "Home" } });
});

test("errors keep index.html's api() contract: .status, .blocked, .needs, .pair", async (t) => {
  const answers = {
    "/api/key": { status: 403, data: { error: "The TV is blocking remote buttons.", blocked: true } },
    "/api/doctor": { status: 501, data: { error: "Connection check needs the home program.", needs: "engine" } },
    "/api/rules": { status: 401, data: { error: "Type the PIN.", pair: true } },
    "/api/now": { status: 500, data: {} },
  };
  const { engine } = await setup(t, { handle: (msg) => answers[msg.path] });
  await assert.rejects(engine.api("/api/key", { key: "Up" }), (err) => err.status === 403 && err.blocked === true && err.message === "The TV is blocking remote buttons.");
  await assert.rejects(engine.api("/api/doctor"), (err) => err.status === 501 && err.needs === "engine" && err.blocked === false);
  await assert.rejects(engine.api("/api/rules"), (err) => err.status === 401 && err.pair === true);
  await assert.rejects(engine.api("/api/now"), (err) => err.status === 500 && err.message === "Something went wrong (500).");
});

test("calls made together share one relay request (batch), each gets its own answer", async (t) => {
  const { engine, net, calls } = await setup(t, { handle: (msg) => ({ status: 200, data: { path: msg.path } }) });
  const before = net.fetchCount;
  const results = await Promise.all([engine.api(`/api/device?tv=${TV}`), engine.api(`/api/apps?tv=${TV}`), engine.api(`/api/now?tv=${TV}`)]);
  assert.deepEqual(results.map((r) => r.path), ["/api/device", "/api/apps", "/api/now"]);
  assert.equal(net.fetchCount - before, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.type === "api"), "handle() never sees the batch wrapper");
});

test("ping and icons go through too; icons are cached", async (t) => {
  const { engine, calls } = await setup(t, {
    handle: (msg) => (msg.type === "ping" ? { ok: true, version: "1.0.0", engine: "extension" } : { dataUrl: `data:image/png;base64,${msg.id}` }),
  });
  assert.deepEqual(await engine.ping(), { ok: true, version: "1.0.0", engine: "extension" });
  assert.equal(await engine.icon(TV, "12"), "data:image/png;base64,12");
  assert.equal(await engine.icon(TV, "12"), "data:image/png;base64,12");
  assert.equal(calls.filter((c) => c.type === "icon").length, 1);
});

test("computer offline -> the phone gets 503 with the plain-English message", async (t) => {
  const { engine, calls } = await setup(t, { startHost: false });
  await assert.rejects(engine.api(`/api/apps?tv=${TV}`), (err) => err.status === 503 && err.offline === true && err.message === "The computer with Roku Detox isn't online.");
  assert.equal(calls.length, 0);
});

test("computer too slow -> 504", async (t) => {
  const { engine, net } = await setup(t, { handle: () => new Promise(() => {}) });
  net.room.core.timeoutMs = 40;
  await assert.rejects(engine.api("/api/key", { key: "Home" }), (err) => err.status === 504 && err.message === "The computer with Roku Detox didn't answer in time.");
});

test("computer disconnects mid-request -> 503 now; it reconnects by itself and works again", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  t.after(() => release());
  const { host, engine, net, calls } = await setup(t, {
    handle: async (msg) => (msg.path === "/api/slow" ? gate.then(() => ({ status: 200, data: {} })) : { status: 200, data: { fine: true } }),
  });
  const slow = engine.api("/api/slow");
  await waitFor(() => calls.length === 1, { what: "request at the extension" });
  const first = net.WebSocket.instances.at(-1);
  first.close(1006);
  await assert.rejects(slow, (err) => err.status === 503 && err.message === "The computer with Roku Detox went offline before it answered.");
  await waitFor(() => net.WebSocket.instances.length === 2 && host.status === "online", { what: "reconnect" });
  assert.deepEqual(await engine.api("/api/fast"), { fine: true });
});

test("a request replayed by the relay is never run twice", async (t) => {
  const { engine, net, calls } = await setup(t, { handle: () => ({ status: 200, data: { ok: true } }) });
  await engine.api("/api/key", { key: "Power" });
  const server = net.WebSocket.instances.at(-1).server;
  const original = server.sent.find((text) => text !== "pong");
  const repliesBefore = net.seen.length;
  server.send(original); // the relay (or anyone in the middle) sends the same sealed request again
  await sleep(20);
  assert.equal(calls.length, 1);
  assert.equal(net.seen.length, repliesBefore, "no answer was sent for the replay");
});

test("someone without the household key can't get a request run (502, not executed)", async (t) => {
  const { net, calls, roomId } = await setup(t);
  const intruder = new RelayEngine({ relay: RELAY, key: newHouseholdKey(), fetch: net.fetch, batchDelayMs: 1 });
  intruder._roomPromise = Promise.resolve(roomId); // knows the room id, not the key
  await assert.rejects(intruder.api("/api/key", { key: "Power" }), (err) => err.status === 502);
  assert.equal(calls.length, 0);
});

test("a reply changed by the relay is rejected by the phone", async (t) => {
  const { key, net } = await setup(t, { handle: () => ({ status: 200, data: { ok: true } }) });
  const tamper = (edit) => async (url, init) => {
    const res = await net.fetch(url, init);
    const frame = await res.json();
    return new Response(JSON.stringify(edit(frame)), { status: res.status });
  };
  const flipLast = (ct) => ct.slice(0, -2) + (ct.at(-2) === "A" ? "B" : "A") + ct.at(-1);
  const flipped = new RelayEngine({ relay: RELAY, key, fetch: tamper((f) => ({ ...f, ct: flipLast(f.ct) })), batchDelayMs: 1 });
  await assert.rejects(flipped.api("/api/now"), (err) => err.status === 502 && /couldn't be verified/.test(err.message));
  const relabeled = new RelayEngine({ relay: RELAY, key, fetch: tamper((f) => ({ ...f, id: "another-request-0001" })), batchDelayMs: 1 });
  await assert.rejects(relabeled.api("/api/now"), (err) => err.status === 502);
});

test("only api/ping/icon messages are accepted from phones", async (t) => {
  const { engine, calls } = await setup(t);
  const answer = await engine.send({ type: "store:set", key: "detox.settings", value: {} });
  assert.equal(answer.status, 400);
  assert.equal(calls.length, 0);
});

test("handler errors come back as a 500 answer", async (t) => {
  const { engine } = await setup(t, { handle: () => { throw new Error("The TV didn't answer."); } });
  await assert.rejects(engine.api("/api/apps"), (err) => err.status === 500 && err.message === "The TV didn't answer.");
});

test("a request sealed with a badly wrong clock gets a clear 'fix the time' answer", async (t) => {
  const { key, net, calls, roomId } = await setup(t);
  const frame = await encrypt(key, roomId, { type: "ping" }, { now: Date.now() - 10 * 60_000 });
  const res = await net.fetch(`${RELAY}/room/${roomId}/request`, { method: "POST", body: JSON.stringify(frame) });
  assert.equal(res.status, 200);
  const answer = await decrypt(key, roomId, await res.json(), { kind: "res" });
  assert.equal(answer.status, 400);
  assert.match(answer.data.error, /clock/);
  assert.equal(calls.length, 0);
});

test("keep-alive pings get pongs; a silent link is dropped and reconnected", async (t) => {
  const statuses = [];
  const { host, net } = await setup(t, { hostOptions: { pingMs: 10, onStatus: (s) => statuses.push(s) } });
  await sleep(45);
  assert.ok(net.seen.filter((text) => text === "ping").length >= 3);
  assert.equal(host.status, "online");
  assert.equal(net.WebSocket.instances.length, 1);

  net.swallowHostMessages = true; // the link silently dies: pings go nowhere
  await waitFor(() => net.WebSocket.instances.length >= 2, { what: "watchdog reconnect" });
  net.swallowHostMessages = false;
  await waitFor(() => host.status === "online");
  assert.ok(statuses.includes("offline"));
  host.stop();
  assert.equal(host.status, "stopped");
  await tick();
});

test("a host that can't connect keeps retrying with backoff, then connects", async (t) => {
  const net = makeNetwork();
  net.refuse = true;
  const { host } = await setup(t, { net, startHost: false });
  host.start();
  await waitFor(() => net.WebSocket.instances.length >= 3, { what: "retries" });
  assert.notEqual(host.status, "online");
  net.refuse = false;
  await waitFor(() => host.status === "online", { what: "connected after retries" });
});
