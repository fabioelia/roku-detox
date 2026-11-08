// Loads the real service worker with a fake chrome object and talks to it the way pages do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
await import("../sw.js");
const ID = chrome.runtime.id;

function send(listeners, msg, sender) {
  return new Promise((resolve) => {
    const keepOpen = listeners[0](msg, sender, resolve);
    if (keepOpen !== true) setTimeout(() => resolve("(no answer)"), 50);
  });
}
const fromPage = (msg) => send(chrome.runtime.onMessage.listeners, msg, { id: ID, url: `chrome-extension://${ID}/app/index.html` });
const fromSite = (msg, origin) => send(chrome.runtime.onMessageExternal.listeners, msg, { origin, url: `${origin}/` });

test("the worker registers its listeners and sets up the alarm and the TV header rule", async () => {
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  assert.equal(chrome.runtime.onMessageExternal.listeners.length, 1);
  assert.equal(chrome.alarms.onAlarm.listeners.length, 1);
  assert.equal(chrome.webRequest.onResponseStarted.listeners.length, 2);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(chrome.alarms.created, [["detox-rules", { periodInMinutes: 0.5, delayInMinutes: 0.5 }]]);
  const rule = chrome.declarativeNetRequest.rules.get(1000);
  assert.equal(rule.action.requestHeaders[0].header, "origin");
  assert.ok(new RegExp(rule.condition.regexFilter).test("http://192.168.1.20:8060/keypress/Home"));
  assert.ok(!new RegExp(rule.condition.regexFilter).test("https://apis.justwatch.com/graphql"));
});

test("pages get answers; other senders don't", async () => {
  assert.deepEqual(await fromPage({ type: "ping" }), { ok: true, version: "1.0.0", engine: "extension" });
  assert.deepEqual(await fromSite({ type: "ping" }, "http://localhost:8642"), { ok: true, version: "1.0.0", engine: "extension" });
  assert.deepEqual(await fromSite({ type: "ping" }, "http://127.0.0.1:8642"), { ok: true, version: "1.0.0", engine: "extension" });
  assert.deepEqual(await fromSite({ type: "ping" }, "https://evil.example.com"), { status: 403, data: { error: "Forbidden." } });
  assert.equal(await send(chrome.runtime.onMessage.listeners, { type: "ping" }, { id: "someoneelse", url: "chrome-extension://someoneelse/x.html" }), "(no answer)");
  const reply = await fromPage({ type: "api", method: "GET", path: "/api/apps", query: { tv: "127.0.0.1:9072" }, body: null });
  assert.equal(reply.status, 200);
  assert.ok(reply.data.apps.some((a) => a.id === "12"));
  // Toolbar-only messages aren't open to web pages.
  assert.deepEqual(await fromSite({ type: "tv" }, "http://localhost:8642"), { status: 400, data: { error: "Bad request." } });
  assert.deepEqual(await fromPage({ type: "tv" }), { tv: "127.0.0.1:9072" });
});
