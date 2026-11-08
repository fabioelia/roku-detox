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
    ? { type: "api", method, path, query: data } : { type: "api", method, path, body: data }, { internal: true });
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

test("a weekend amount replaces the daily limit on Saturday and Sunday", async () => {
  await setRules({ limits: { "41468": 1 }, weekendLimits: { "41468": 3 } });
  await tv("/keypress/PowerOn");
  await ok("POST", "/api/launch", { tv: TV, id: "41468" });
  // Saturday, Nov 14: two and a half minutes in, still on (three allowed).
  for (const at of ["12:00:00", "12:00:30", "12:01:00", "12:01:30", "12:02:00", "12:02:30"]) await roundAt(`2026-11-14T${at}`);
  assert.equal((await active()).id, "41468");
  for (const at of ["12:03:00", "12:03:15"]) await roundAt(`2026-11-14T${at}`);
  assert.notEqual((await active()).id, "41468", "over three minutes: closed");
  assert.match((await messages())[0], /\(3 minutes\)/);
  // Monday, Nov 16: the daily minute again.
  await ok("POST", "/api/launch", { tv: TV, id: "41468" });
  for (const at of ["12:00:00", "12:00:30", "12:01:00", "12:01:10"]) await roundAt(`2026-11-16T${at}`);
  assert.notEqual((await active()).id, "41468", "over a minute on a weekday: closed");
  await setRules({});
  await tv("/keypress/Home");
});

test("all TV together: once the day's total is used, any app or input is closed", async () => {
  await setRules({ totalLimit: 2 });
  await tv("/keypress/PowerOn");
  await ok("POST", "/api/launch", { tv: TV, id: "41468" });
  // Tuesday, Nov 17: a minute on Tubi, then a switch to YouTube for the rest.
  for (const at of ["12:00:00", "12:00:30", "12:01:00"]) await roundAt(`2026-11-17T${at}`);
  await ok("POST", "/api/launch", { tv: TV, id: "837" });
  for (const at of ["12:01:20", "12:01:50"]) await roundAt(`2026-11-17T${at}`);
  assert.equal((await active()).id, "837", "under two minutes in all: still on");
  for (const at of ["12:02:10", "12:02:20"]) await roundAt(`2026-11-17T${at}`);
  assert.notEqual((await active()).id, "837", "over two minutes in all: closed");
  assert.equal((await messages())[0], "Time's up for TV today (2 minutes in all). Closed YouTube.");
  const status = await ok("GET", "/api/rules", { tv: TV });
  assert.equal(status.totalToday, 2);
  // An older page saves its whole rules object without the total: kept. An empty object clears it.
  await setRules({ limits: {}, blocked: [] });
  assert.equal((await ok("GET", "/api/rules", { tv: TV })).rules.totalLimit, 2);
  await setRules({});
  assert.equal((await ok("GET", "/api/rules", { tv: TV })).rules.totalLimit, 0);
  await tv("/keypress/Home");
});

test("all TV together: Detox Home's own screens don't count, its videos do", async () => {
  await setRules({ totalLimit: 1 });
  await tv("/keypress/PowerOn");
  // Wednesday, Nov 18: two minutes on Detox Home's launcher (it counts as the home screen).
  await tv("/input"); // Detox Home with nothing to show: its launcher
  for (const at of ["12:00:00", "12:00:30", "12:01:00", "12:01:30", "12:02:00"]) await roundAt(`2026-11-18T${at}`);
  assert.equal((await active()).id, "dev");
  assert.equal((await ok("GET", "/api/rules", { tv: TV })).usage.dev, undefined);
  // A video in Detox Home counts, and is stopped once the minute is used.
  await tv("/input?contentId=inline&mediaType=video&url=https%3A%2F%2Fcdn.example.com%2Fv.mp4");
  for (const at of ["12:02:30", "12:03:00", "12:03:30", "12:03:40"]) await roundAt(`2026-11-18T${at}`);
  assert.ok((await ok("GET", "/api/rules", { tv: TV })).usage.dev >= 60);
  assert.equal((await messages())[0], "Time's up for TV today (1 minute in all). Closed Detox Home.");
  await setRules({});
  await tv("/keypress/Home");
});

test("skip the home screen stays home when that app has no time left", async () => {
  await setRules({ limits: { "12": 1 }, autopilot: { enabled: true, target: "12" } });
  await tv("/keypress/Home");
  await tv("/launch/12");
  for (const at of ["13:00:00", "13:00:30", "13:01:00", "13:01:10"]) await roundAt(`2026-11-18T${at}`); // Netflix's minute is used
  await tv("/keypress/PowerOff");
  await roundAt("2026-11-18T13:02:00");
  await tv("/keypress/PowerOn");
  await tv("/keypress/Home");
  for (const at of ["13:03:00", "13:03:05", "13:03:10", "13:03:20"]) await roundAt(`2026-11-18T${at}`);
  assert.equal((await active()).id || "home", "home", "stayed on the home screen");
  assert.ok((await messages()).includes("TV turned on. Netflix has no time left today, so it stayed on the home screen."));
  await setRules({});
});

test("15 more minutes: for today only, for an app or all TV together, and kept when the page saves", async () => {
  mock.timers.setTime(new Date("2026-11-19T18:00:00").getTime());
  await setRules({ limits: { "12": 30 }, totalLimit: 90 });
  let status = await ok("POST", "/api/rules/more", { tv: TV, app: "12", minutes: 15 });
  assert.equal(status.limitsToday["12"], 45);
  status = await ok("POST", "/api/rules/more", { tv: TV, minutes: 15 });
  assert.equal(status.totalToday, 105);
  // The page saves its own copy of the rules (with no extra time in it): the extra time stays.
  status = await ok("POST", "/api/rules", { tv: TV, rules: { limits: { "12": 30 }, totalLimit: 90 } });
  assert.deepEqual(status.rules.bonus, { day: "2026-11-19", minutes: { "12": 15, "*": 15 } });
  // The next day it's gone.
  mock.timers.setTime(new Date("2026-11-20T09:00:00").getTime());
  status = await ok("GET", "/api/rules", { tv: TV });
  assert.equal(status.limitsToday["12"], 30);
  assert.equal(status.totalToday, 90);
  await setRules({});
});

test("15 more minutes goes where it's needed: the app's limit and the total, or bedtime", async () => {
  const { handleMessage } = await import("../engine/router.js");
  const say = async (text) => (await handleMessage({ type: "api", method: "POST", path: "/api/do", query: {}, body: { tv: TV, do: text } }, { internal: true })).data;
  await setRules({ limits: { "12": 1 }, totalLimit: 90 });
  await tv("/keypress/PowerOn");
  await tv("/launch/12");
  for (const at of ["14:00:00", "14:00:30", "14:01:00", "14:01:10"]) await roundAt(`2026-11-23T${at}`); // Netflix's minute: closed
  assert.notEqual((await active()).id, "12");
  mock.timers.setTime(new Date("2026-11-23T14:01:20").getTime());
  const reply = await say("15 more minutes");
  assert.equal(reply.done, "15 more minutes of Netflix today.", JSON.stringify(reply));
  const status = await ok("GET", "/api/rules", { tv: TV });
  assert.equal(status.limitsToday["12"], 16, "from the home screen, the app that was just closed");
  assert.equal(status.totalToday, 90, "not all TV together: it wasn't what stopped Netflix");
  // At bedtime it moves bedtime instead.
  await setRules({ bedtime: { enabled: true, start: "21:00", end: "06:30" } });
  mock.timers.setTime(new Date("2026-11-23T21:30:00").getTime());
  assert.equal((await say("more time")).done, "Bedtime is 15 minutes later tonight.");
  assert.ok((await ok("GET", "/api/rules", { tv: TV })).rules.bedtime.extendUntil > Date.now() / 1000 + 14 * 60);
  await setRules({});
  await tv("/keypress/Home");
});

test("15 more minutes: Detox Home's video, an extended bedtime, and the daily cap", async () => {
  const { handleMessage } = await import("../engine/router.js");
  const say = async (text) => (await handleMessage({ type: "api", method: "POST", path: "/api/do", query: {}, body: { tv: TV, do: text } }, { internal: true })).data;
  // A video in Detox Home with its own limit: the time goes to Detox Home.
  await setRules({ limits: { dev: 30 } });
  await tv("/keypress/PowerOn");
  await tv("/input?contentId=inline&mediaType=video&url=https%3A%2F%2Fcdn.example.com%2Fv.mp4");
  for (const at of ["10:00:00", "10:00:30"]) await roundAt(`2026-11-24T${at}`);
  assert.equal((await say("5 more mins")).done, "5 more minutes of Detox Home today.");
  // Bedtime put off already, and a limit is what stopped the app: the time goes to the limit, not bedtime.
  await tv("/keypress/Home");
  await setRules({ limits: { "12": 1 }, bedtime: { enabled: true, start: "21:00", end: "06:30" } });
  mock.timers.setTime(new Date("2026-11-24T21:00:30").getTime());
  await ok("POST", "/api/rules/extend", { tv: TV, minutes: 30 });
  await tv("/launch/12");
  for (const at of ["21:01:00", "21:01:30", "21:02:00", "21:02:10"]) await roundAt(`2026-11-24T${at}`);
  assert.equal((await say("15 more minutes")).done, "15 more minutes of Netflix today.");
  // Bedtime put off and nothing out of time: bedtime moves again.
  await setRules({ bedtime: { enabled: true, start: "21:00", end: "06:30" } });
  await tv("/keypress/Home");
  mock.timers.setTime(new Date("2026-11-24T21:10:00").getTime());
  await ok("POST", "/api/rules/extend", { tv: TV, minutes: 15 });
  const before = (await ok("GET", "/api/rules", { tv: TV })).rules.bedtime.extendUntil;
  assert.equal((await say("15 more minutes")).done, "Bedtime is 15 minutes later tonight.");
  assert.equal((await ok("GET", "/api/rules", { tv: TV })).rules.bedtime.extendUntil, before + 15 * 60);
  // The cap, the next day at noon: 720 extra minutes a day at most.
  await setRules({ limits: { "12": 30 } });
  mock.timers.setTime(new Date("2026-11-25T12:00:00").getTime());
  await tv("/launch/12");
  await roundAt("2026-11-25T12:00:05");
  for (let i = 0; i < 6; i++) await ok("POST", "/api/rules/more", { tv: TV, app: "12", minutes: 120 });
  assert.equal((await say("15 more minutes")).done, "Netflix already has as much extra time as can be given today.");
  await setRules({});
  await tv("/keypress/Home");
});

test("15 more minutes: Detox Home closed for time gets it even while bedtime is put off", async () => {
  const { handleMessage } = await import("../engine/router.js");
  const say = async (text) => (await handleMessage({ type: "api", method: "POST", path: "/api/do", query: {}, body: { tv: TV, do: text } }, { internal: true })).data;
  await setRules({ totalLimit: 1, bedtime: { enabled: true, start: "21:00", end: "06:30" } });
  mock.timers.setTime(new Date("2026-11-26T21:00:10").getTime());
  await ok("POST", "/api/rules/extend", { tv: TV, minutes: 30 });
  await tv("/keypress/PowerOn");
  await tv("/input?contentId=inline&mediaType=video&url=https%3A%2F%2Fcdn.example.com%2Fv.mp4");
  for (const at of ["21:01:00", "21:01:30", "21:02:00", "21:02:30", "21:02:40"]) await roundAt(`2026-11-26T${at}`);
  assert.match((await messages())[0], /Closed Detox Home/);
  assert.equal((await say("15 more minutes")).done, "15 more minutes of TV today.");
  // Nothing used up and nothing put off: whichever runs out first.
  await setRules({ limits: { "12": 60 }, totalLimit: 30 });
  mock.timers.setTime(new Date("2026-11-27T10:00:00").getTime());
  await tv("/launch/12");
  await roundAt("2026-11-27T10:00:05");
  assert.equal((await say("15 more minutes")).done, "15 more minutes of TV today.");
  const status = await ok("GET", "/api/rules", { tv: TV });
  assert.deepEqual([status.limitsToday["12"], status.totalToday], [60, 45]);
  await setRules({});
  await tv("/keypress/Home");
});
