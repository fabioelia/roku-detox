import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash, hkdfSync } from "node:crypto";
import {
  RelayCryptoError,
  decrypt,
  encrypt,
  fromBase64Url,
  keyFromLink,
  linkFor,
  newHouseholdKey,
  normalizeKey,
  roomIdFor,
  toBase64Url,
} from "../client/relay-crypto.js";

const flipByte = (b64, index = 0) => {
  const bytes = fromBase64Url(b64);
  bytes[index] ^= 0x01;
  return toBase64Url(bytes);
};

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof RelayCryptoError && err.code === code);

test("household keys are 32 random bytes as base64url", () => {
  const a = newHouseholdKey();
  const b = newHouseholdKey();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(fromBase64Url(a).length, 32);
  assert.notEqual(a, b);
  assert.equal(normalizeKey(fromBase64Url(a)), a);
  assert.throws(() => normalizeKey("too-short"), RelayCryptoError);
});

test("base64url handles binary and long inputs", () => {
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) & 0xff);
  const text = toBase64Url(bytes);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(fromBase64Url(text), bytes);
  assert.throws(() => fromBase64Url("a+b/"), RelayCryptoError);
  assert.throws(() => fromBase64Url("abcde"), RelayCryptoError); // impossible length
});

test("roomId is the first 22 chars of base64url(SHA-256(key))", async () => {
  const key = newHouseholdKey();
  const expected = createHash("sha256").update(fromBase64Url(key)).digest("base64url").slice(0, 22);
  const roomId = await roomIdFor(key);
  assert.equal(roomId, expected);
  assert.match(roomId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(await roomIdFor(key), roomId);
  assert.notEqual(await roomIdFor(newHouseholdKey()), roomId);
});

test("encrypt/decrypt round trip; the frame is only {id, iv, ct}", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const msg = { type: "api", method: "POST", path: "/api/key", query: { tv: "192.0.2.10" }, body: { key: "Home", note: "café ✓" } };
  const frame = await encrypt(key, roomId, msg);
  assert.deepEqual(Object.keys(frame).sort(), ["ct", "id", "iv"]);
  assert.match(frame.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(fromBase64Url(frame.iv).length, 12);
  assert.ok(!JSON.stringify(frame).includes("api"), "no plaintext leaks into the frame");
  assert.deepEqual(await decrypt(key, roomId, frame, { kind: "req", maxAgeMs: 60_000 }), msg);

  const reply = await encrypt(key, roomId, { status: 200, data: { ok: true } }, { id: frame.id, kind: "res" });
  assert.equal(reply.id, frame.id);
  assert.deepEqual(await decrypt(key, roomId, reply, { kind: "res" }), { status: 200, data: { ok: true } });
});

test("every message gets a fresh IV", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const a = await encrypt(key, roomId, { same: true }, { id: "x".repeat(22) });
  const b = await encrypt(key, roomId, { same: true }, { id: "x".repeat(22) });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test("tampering is detected: flipped ciphertext, tag or IV byte", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const frame = await encrypt(key, roomId, { type: "ping" });
  const ctLength = fromBase64Url(frame.ct).length;
  await rejectsWith(decrypt(key, roomId, { ...frame, ct: flipByte(frame.ct, 0) }), "auth");
  await rejectsWith(decrypt(key, roomId, { ...frame, ct: flipByte(frame.ct, ctLength - 1) }), "auth"); // tag
  await rejectsWith(decrypt(key, roomId, { ...frame, iv: flipByte(frame.iv, 5) }), "auth");
  const truncated = toBase64Url(fromBase64Url(frame.ct).subarray(0, ctLength - 1));
  await rejectsWith(decrypt(key, roomId, { ...frame, ct: truncated }), "auth");
});

test("the wrong room id (AAD) fails", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const frame = await encrypt(key, roomId, { type: "ping" });
  await rejectsWith(decrypt(key, await roomIdFor(newHouseholdKey()), frame), "auth");
  await rejectsWith(decrypt(key, roomId.slice(0, 21) + (roomId[21] === "A" ? "B" : "A"), frame), "auth");
});

test("the wrong household key fails", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const frame = await encrypt(key, roomId, { type: "ping" });
  await rejectsWith(decrypt(newHouseholdKey(), roomId, frame), "auth");
});

test("a reply moved to another request id, or sent the wrong way, fails", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const reply = await encrypt(key, roomId, { status: 200, data: {} }, { id: "a".repeat(22), kind: "res" });
  await rejectsWith(decrypt(key, roomId, { ...reply, id: "b".repeat(22) }), "id");
  await rejectsWith(decrypt(key, roomId, reply, { kind: "req" }), "kind");
});

test("old or far-future messages fail when a replay window is given", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const now = Date.now();
  const old = await encrypt(key, roomId, { type: "ping" }, { now: now - 10 * 60_000 });
  const future = await encrypt(key, roomId, { type: "ping" }, { now: now + 10 * 60_000 });
  await rejectsWith(decrypt(key, roomId, old, { maxAgeMs: 5 * 60_000, now }), "stale");
  await rejectsWith(decrypt(key, roomId, future, { maxAgeMs: 5 * 60_000, now }), "stale");
  assert.deepEqual(await decrypt(key, roomId, old), { type: "ping" }); // no window: only authenticity is checked
});

test("malformed frames are rejected as format errors", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  await rejectsWith(decrypt(key, roomId, null), "format");
  await rejectsWith(decrypt(key, roomId, { id: "a".repeat(22), iv: "short", ct: "a".repeat(30) }), "format");
  await rejectsWith(decrypt(key, roomId, { id: "a".repeat(22), iv: "a".repeat(16), ct: "!!" }), "format");
});

test("matches an independent HKDF-SHA-256 + AES-256-GCM implementation (node:crypto)", async () => {
  const key = newHouseholdKey();
  const roomId = await roomIdFor(key);
  const frame = await encrypt(key, roomId, { hello: "tv" }, { id: "c".repeat(22), kind: "req", now: 1234 });
  const aesKey = Buffer.from(hkdfSync("sha256", fromBase64Url(key), new Uint8Array(0), "roku-detox-relay-v1", 32));
  const ct = Buffer.from(fromBase64Url(frame.ct));
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(fromBase64Url(frame.iv)));
  decipher.setAAD(Buffer.from(roomId, "utf8"));
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  assert.deepEqual(JSON.parse(plain.toString("utf8")), { v: 1, id: "c".repeat(22), kind: "req", ts: 1234, body: { hello: "tv" } });
});

test("phone links: linkFor and keyFromLink round trip; bad links give null", () => {
  const key = newHouseholdKey();
  const link = linkFor("relay.example.com", key);
  assert.equal(link, `https://relay.example.com/#k=${key}`);
  assert.equal(linkFor("http://localhost:8787/some/path", key), `http://localhost:8787/#k=${key}`);
  assert.equal(keyFromLink(link), key);
  assert.equal(keyFromLink(`#k=${key}`), key);
  assert.equal(keyFromLink(`k=${key}`), key);
  assert.equal(keyFromLink(`#tv=192.0.2.10&k=${key}`), key);
  assert.equal(keyFromLink(""), null);
  assert.equal(keyFromLink("#k=nope"), null);
  assert.equal(keyFromLink("#x=1"), null);
  assert.equal(keyFromLink(undefined), null);
  assert.throws(() => linkFor("", key));
});
