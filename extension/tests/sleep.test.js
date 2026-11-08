// Sleep timer in the extension: a Chrome alarm that turns the pretend TV off
// (python3 mock_roku.py --port 9072).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const { onSleepAlarm } = await import("../engine/sleep.js");
const TV = "127.0.0.1:9072";
const call = (method, path, fields) => handleMessage(method === "GET"
  ? { type: "api", method, path, query: { tv: TV, ...fields }, body: null }
  : { type: "api", method, path, query: {}, body: { tv: TV, ...fields } }, { internal: true });
const power = async () => (/<power-mode>([^<]*)/.exec(await (await fetch(`http://${TV}/query/device-info`)).text()) || [])[1];

test("set, read, cancel, refuse silly times", async () => {
  assert.deepEqual((await call("GET", "/api/sleep")).data, { until: null });
  const set = await call("POST", "/api/sleep", { minutes: 30 });
  assert.equal(set.status, 200);
  assert.ok(Math.abs(set.data.until - (Date.now() / 1000 + 1800)) < 5);
  assert.deepEqual((await call("GET", "/api/sleep")).data, set.data);
  assert.equal((await call("POST", "/api/sleep", { minutes: 999 })).status, 400);
  assert.equal((await call("POST", "/api/sleep", { minutes: "30" })).status, 400);
  assert.deepEqual((await call("POST", "/api/sleep", { minutes: 0 })).data, { until: null });
});

test("when the alarm goes off, the TV turns off", async () => {
  await fetch(`http://${TV}/keypress/PowerOn`, { method: "POST" });
  assert.equal(await power(), "PowerOn");
  assert.equal(await onSleepAlarm({ name: "detox-rules" }), false, "other alarms are left alone");
  assert.equal(await onSleepAlarm({ name: `detox-sleep:${TV}` }), true);
  assert.equal(await power(), "DisplayOff");
  await fetch(`http://${TV}/keypress/PowerOn`, { method: "POST" });
});
