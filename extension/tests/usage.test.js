// Viewing time for Clean up: the same totals as usage_summary() in roku_detox.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const TV = "127.0.0.1:9072";

test("totals over the days on record", async () => {
  const get = () => handleMessage({ type: "api", method: "GET", path: "/api/usage", query: { tv: TV }, body: null }, { internal: true });
  assert.deepEqual((await get()).data, { days: 0, since: null, totals: {} });
  await chrome.storage.local.set({ usage: { [TV]: {
    "2026-11-01": { 12: 1350, home: 60 },
    "2026-11-02": { 12: 600, 837: 1200.7 },
    "2026-11-03": "broken",
  }, "127.0.0.1:9073": { "2026-11-01": { 12: 99 } } } });
  assert.deepEqual((await get()).data, { days: 2, since: "2026-11-01", totals: { 12: 1950, home: 60, 837: 1200 } });
});
