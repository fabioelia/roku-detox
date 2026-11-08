// Viewing time for Clean up: the same totals as usage_summary() in roku_detox.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const TV = "127.0.0.1:9072";

const localToday = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; };

test("totals over the days on record", async () => {
  const get = () => handleMessage({ type: "api", method: "GET", path: "/api/usage", query: { tv: TV }, body: null }, { internal: true });
  assert.deepEqual((await get()).data, { days: 0, since: null, totals: {}, perDay: [], today: localToday() });
  await chrome.storage.local.set({ usage: { [TV]: {
    "2026-11-01": { 12: 1350, home: 60 },
    "2026-11-02": { 12: 600, 837: 1200.7 },
    "2026-11-03": "broken",
  }, "127.0.0.1:9073": { "2026-11-01": { 12: 99 } } } });
  assert.deepEqual((await get()).data, { days: 2, since: "2026-11-01", totals: { 12: 1950, home: 60, 837: 1200 },
    perDay: [{ day: "2026-11-01", seconds: 1350 }, { day: "2026-11-02", seconds: 1800 }], today: localToday() });
});

test("the page's polling doesn't undo a TV picked in the popup", async () => {
  const get = (tv) => handleMessage({ type: "api", method: "GET", path: "/api/usage", query: { tv }, body: null }, { internal: true });
  await chrome.storage.local.remove("lastTv");
  await get("127.0.0.1:9072");
  assert.equal((await chrome.storage.local.get("lastTv")).lastTv, "127.0.0.1:9072", "the first TV used becomes the one");
  await chrome.storage.local.set({ lastTv: "127.0.0.1:9074" });   // picked in the popup
  await get("127.0.0.1:9072");
  assert.equal((await chrome.storage.local.get("lastTv")).lastTv, "127.0.0.1:9074");
  await handleMessage({ type: "api", method: "POST", path: "/api/sleep", query: {}, body: { tv: "127.0.0.1:9072", minutes: 0 } }, { internal: true });
  assert.equal((await chrome.storage.local.get("lastTv")).lastTv, "127.0.0.1:9072", "doing something on a TV picks it");
});
