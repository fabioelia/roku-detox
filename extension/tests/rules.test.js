// The watcher's rules, played out on the pretend TV (port 9072) with a fake clock.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const rules = await import("../engine/rules.js");

const TV = "127.0.0.1:9072";
const ok = async (method, path, data) => {
  const reply = await handleMessage(method === "GET"
    ? { type: "api", method, path, query: data } : { type: "api", method, path, body: data });
  assert.equal(reply.status, 200, `${method} ${path}: ${JSON.stringify(reply.data)}`);
  return reply.data;
};
const tv = (path) => fetch(`http://${TV}${path}`, { method: "POST" }).then((r) => r.text());
const active = async () => (await ok("GET", "/api/active", { tv: TV })).app;
const power = async () => (await ok("GET", "/api/device", { tv: TV })).device.powerMode;
const messages = async () => (await ok("GET", "/api/rules", { tv: TV })).events.map((e) => e.message);
const lastDev = () => fetch(`http://${TV}/test/last-dev`, { method: "POST" }).then((r) => r.json());

/** Set the clock, then run one round of checks. */
async function roundAt(when) {
  mock.timers.setTime(new Date(when).getTime());
  await rules.runRound();
}

async function setRules(value) {
  await ok("POST", "/api/rules", { tv: TV, rules: value });
}

before(async () => {
  rules.watcherOptions.startOnSave = false;
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-07T12:00:00").getTime() });
  await tv("/keypress/PowerOn");
  await tv("/keypress/Home");
});

after(async () => {
  mock.timers.reset();
  await tv("/keypress/PowerOn");
  await tv("/keypress/Home");
});

test("autopilot opens the chosen app when the TV turns on to the home screen", async () => {
  await setRules({ autopilot: { enabled: true, target: "12" } });
  await tv("/keypress/PowerOff");
  await roundAt("2026-11-07T12:00:00"); // standby
  await tv("/test/wake");                // turns itself on, to the home screen
  await roundAt("2026-11-07T12:00:05"); // just turned on: waits for a second look
  assert.deepEqual(await active(), { id: "", name: "Roku" });
  await roundAt("2026-11-07T12:00:10"); // still home: opens Netflix
  assert.equal((await active()).id, "12");
  await roundAt("2026-11-07T12:00:17"); // checks it worked
  const said = await messages();
  assert.equal(said[0], "TV turned on. Opened Netflix instead of the home screen.");
  assert.equal(said[1], "TV turned on (home screen).");
});

test("skip next time: the TV stays on the home screen once", async () => {
  await ok("POST", "/api/rules/skip", { tv: TV });
  await tv("/keypress/PowerOff");
  await roundAt("2026-11-07T12:01:00");
  await tv("/test/wake");
  await roundAt("2026-11-07T12:01:05");
  await roundAt("2026-11-07T12:01:10");
  assert.deepEqual(await active(), { id: "", name: "Roku" });
  assert.equal((await messages())[0], "Skipped opening an app this time, as asked.");
  assert.equal((await ok("GET", "/api/rules", { tv: TV })).rules.autopilot.skipNext, false);
});

test("a swap opens the other app instead", async () => {
  await setRules({ redirects: { "74519": "151908" } });
  await ok("POST", "/api/launch", { tv: TV, id: "74519" });
  await roundAt("2026-11-07T12:02:00");
  assert.equal((await active()).id, "151908");
  assert.equal((await messages())[0], "Pluto TV - It's Free TV opened, so opened The Roku Channel instead.");
});

test("a daily limit closes the app once its minutes are used up", async () => {
  await setRules({ limits: { "41468": 2 } });
  await ok("POST", "/api/launch", { tv: TV, id: "41468" });
  // At most 40 s count between two checks, so a late alarm (or a sleeping laptop) isn't counted as watching.
  for (const at of ["12:10:00", "12:10:30", "12:11:00", "12:11:15"]) await roundAt(`2026-11-07T${at}`); // 40 + 30 + 30 + 15 s
  assert.equal((await active()).id, "41468");
  await roundAt("2026-11-07T12:11:30"); // 130 s: over 2 minutes
  assert.equal((await messages())[0], "Time's up for Tubi - Free Movies & TV today (2 minutes). Closed it.");
  const status = await ok("GET", "/api/rules", { tv: TV });
  assert.equal(status.usage["41468"], 130);
  assert.notEqual((await active()).id, "41468"); // Detox Home's notice, or the home screen without it
  assert.ok(chrome.storage.local.dump().usage[TV]["2026-11-07"]["41468"] > 0, "viewing log saved per day");
});

test("bedtime warns, then turns the TV off; extending it holds off", async () => {
  await tv("/keypress/Home");
  await setRules({ bedtime: { enabled: true, start: "21:00", end: "06:30" } });
  await roundAt("2026-11-07T21:00:05");
  assert.equal((await messages())[0], "It's bedtime. The TV turns off in 1 minute.");
  assert.equal(await power(), "PowerOn");
  await roundAt("2026-11-07T21:00:40");
  assert.equal(await power(), "PowerOn"); // still in the minute of grace
  await roundAt("2026-11-07T21:01:10");
  assert.equal(await power(), "DisplayOff");
  assert.equal((await messages())[0], "Bedtime. Turned the TV off.");
  const status = await ok("GET", "/api/rules", { tv: TV });
  assert.equal(status.bedtimeNow, true);

  await tv("/keypress/PowerOn");
  await ok("POST", "/api/rules/extend", { tv: TV, minutes: 30 });
  await roundAt("2026-11-07T21:05:00");
  await roundAt("2026-11-07T21:07:00");
  assert.equal(await power(), "PowerOn");
});

test("night guard turns the TV back off when it woke itself and nothing plays", async () => {
  await setRules({ nightGuard: { enabled: true, start: "00:30", end: "06:00", idleMinutes: 1 } });
  await tv("/keypress/PowerOff");
  await roundAt("2026-11-08T02:00:00");
  await tv("/test/wake");
  await roundAt("2026-11-08T02:00:05");
  await roundAt("2026-11-08T02:00:40");
  assert.equal(await power(), "PowerOn");
  const before = chrome.notifications.list.length;
  await roundAt("2026-11-08T02:01:10");
  assert.equal(await power(), "DisplayOff");
  assert.equal((await messages())[0], "The TV turned on by itself at 2:00 AM and nothing was playing. Turned it back off.");
  assert.equal(chrome.notifications.list.length, before + 1);
  assert.equal(chrome.notifications.list.at(-1).message, (await messages())[0]);
});

test("an unreachable TV raises one alert after 3 minutes", async () => {
  const gone = "127.0.0.1:9";
  await ok("POST", "/api/rules", { tv: gone, rules: { blocked: ["12"] } });
  await roundAt("2026-11-08T09:00:00");
  await roundAt("2026-11-08T09:02:00");
  let events = (await ok("GET", "/api/rules", { tv: gone })).events;
  assert.equal(events.length, 0);
  await roundAt("2026-11-08T09:03:05");
  await roundAt("2026-11-08T09:04:00");
  events = (await ok("GET", "/api/rules", { tv: gone })).events;
  assert.deepEqual(events.map((e) => [e.kind, e.message]), [["alert", "Can't reach the TV. If it's on, rules aren't working. Check it's on the same Wi-Fi, and that Fast TV start is on."]]);
  await ok("POST", "/api/rules", { tv: gone, rules: {} });
  await setRules({});
  assert.ok(chrome.storage.local.dump().events.length <= 300);
});

test("pausing rules lets a blocked app stay on, then they're back", async () => {
  await setRules({ blocked: ["12"] });
  await tv("/keypress/PowerOn");
  await tv("/launch/12");
  mock.timers.setTime(new Date("2026-11-09T15:00:00").getTime());
  const paused = await ok("POST", "/api/rules/pause", { tv: TV, minutes: 60 });
  assert.equal(paused.rules.pausedUntil, Math.trunc(new Date("2026-11-09T16:00:00").getTime() / 1000));
  await roundAt("2026-11-09T15:00:05");
  await roundAt("2026-11-09T15:00:10");
  assert.equal((await active()).id, "12", "paused: Netflix stays");
  await roundAt("2026-11-09T16:00:05"); // the hour is up
  await roundAt("2026-11-09T16:00:10");
  assert.notEqual((await active()).id, "12", "back on: the blocked app is closed again");
  await tv("/launch/12");
  await ok("POST", "/api/rules/pause", { tv: TV, minutes: 60 });
  const resumed = await ok("POST", "/api/rules/pause", { tv: TV, minutes: 0 });
  assert.equal(resumed.rules.pausedUntil, 0);
  await setRules({});
  await tv("/keypress/Home");
});

test("after a pause, bedtime warns again before turning the TV off; saving rules keeps the pause", async () => {
  const power = async () => (await ok("GET", "/api/device", { tv: TV })).device.powerMode;
  const bedtime = { enabled: true, start: "21:00", end: "06:30" };
  await setRules({ bedtime });
  await tv("/keypress/PowerOn");
  await roundAt("2026-11-10T20:59:55");
  await roundAt("2026-11-10T21:00:02"); // the warning
  mock.timers.setTime(new Date("2026-11-10T21:00:30").getTime());
  const until = (await ok("POST", "/api/rules/pause", { tv: TV, minutes: 60 })).rules.pausedUntil;
  // The page saves its own copy of the rules, which says nothing is paused: the pause stays.
  const saved = await ok("POST", "/api/rules", { tv: TV, rules: { bedtime, pausedUntil: 0 } });
  assert.equal(saved.rules.pausedUntil, until);
  await roundAt("2026-11-10T21:30:00");
  await roundAt("2026-11-10T22:00:35"); // the pause is over: a fresh warning, not straight off
  assert.equal(await power(), "PowerOn");
  await roundAt("2026-11-10T22:03:00");
  assert.notEqual(await power(), "PowerOn", "after the warning's grace, bedtime turns it off");
  await setRules({});
  await tv("/keypress/PowerOn");
  await tv("/keypress/Home");
});
