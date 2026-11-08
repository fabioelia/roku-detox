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

test("a timer that fires long after it was due (the computer slept) is skipped", async () => {
  await fetch(`http://${TV}/keypress/PowerOn`, { method: "POST" });
  assert.equal(await onSleepAlarm({ name: `detox-sleep:${TV}`, scheduledTime: Date.now() - 8 * 3600 * 1000 }), true);
  assert.equal(await power(), "PowerOn", "the TV someone is watching stays on");
  assert.equal(await onSleepAlarm({ name: `detox-sleep:${TV}`, scheduledTime: Date.now() - 30 * 1000 }), true);
  assert.equal(await power(), "DisplayOff", "a little late is fine");
  await fetch(`http://${TV}/keypress/PowerOn`, { method: "POST" });
});

test("a scene can start the sleep timer", async () => {
  const saved = await call("POST", "/api/settings", { scenes: [{ name: "Wind down", steps: [{ do: "volume_down", n: 2 }, { do: "sleep_timer", n: 45 }] }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.scenes[0].steps[1], { do: "sleep_timer", n: 45 });
  assert.equal((await call("POST", "/api/scene", { id: saved.data.scenes[0].id })).status, 200);
  const { until } = (await call("GET", "/api/sleep")).data;
  assert.ok(Math.abs(until - (Date.now() / 1000 + 45 * 60)) < 10);
  await call("POST", "/api/sleep", { minutes: 0 });
  await call("POST", "/api/settings", { scenes: [] });
});
