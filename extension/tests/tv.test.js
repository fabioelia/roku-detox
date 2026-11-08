// The engine against the pretend TV (python3 mock_roku.py --port 9072), through the same
// messages the page sends. A second pretend TV in Limited mode is started on 9073.
// Never points at a real TV.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const ecp = await import("../engine/ecp.js");
const rules = await import("../engine/rules.js");
const { discover } = await import("../engine/discover.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TV = "127.0.0.1:9072";
const LIMITED = "127.0.0.1:9073";
const target = { host: "127.0.0.1", port: 9072 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let limitedTv = null;

const api = (method, p, data = {}) => handleMessage(
  method === "GET" ? { type: "api", method, path: p, query: data, body: null } : { type: "api", method, path: p, body: data },
  { internal: true },
);
const ok = async (method, p, data) => {
  const reply = await api(method, p, data);
  assert.equal(reply.status, 200, `${method} ${p}: ${JSON.stringify(reply.data)}`);
  return reply.data;
};
const mock = async (p, method = "POST") => {
  const resp = await fetch(`http://${TV}${p}`, { method });
  return resp.headers.get("content-type")?.includes("json") ? resp.json() : resp.text();
};

function python(code) {
  return JSON.parse(execFileSync("python3", ["-c", `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd; t = ("127.0.0.1", 9072)\n${code}`], { encoding: "utf-8" }));
}

async function installDetoxHome(action = "Install") {
  const md5 = (s) => createHash("md5").update(s).digest("hex");
  const boundary = "b0undary";
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="mysubmit"\r\n\r\n${action}\r\n--${boundary}\r\n`
    + `Content-Disposition: form-data; name="archive"; filename="detox-home.zip"\r\nContent-Type: application/zip\r\n\r\nmanifest\r\n--${boundary}--\r\n`;
  const challenge = await fetch(`http://${TV}/plugin_install`, { method: "POST", body });
  const nonce = /nonce="([^"]+)"/.exec(challenge.headers.get("www-authenticate"))[1];
  const ha1 = md5("rokudev:rokudev:testpass");
  const ha2 = md5("POST:/plugin_install");
  const response = md5(`${ha1}:${nonce}:00000001:c1:auth:${ha2}`);
  const auth = `Digest username="rokudev", realm="rokudev", nonce="${nonce}", uri="/plugin_install", qop=auth, nc=00000001, cnonce="c1", response="${response}"`;
  const resp = await fetch(`http://${TV}/plugin_install`, {
    method: "POST", body, headers: { Authorization: auth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
  });
  assert.match(await resp.text(), action === "Install" ? /Install Success/ : /Delete Successful/);
}

before(async () => {
  try {
    await fetch(`http://${TV}/query/device-info`);
  } catch {
    throw new Error("Start the pretend TV first: python3 mock_roku.py --port 9072");
  }
  rules.watcherOptions.startOnSave = false;
  await installDetoxHome("Delete"); // start from a TV without Detox Home
  await mock("/keypress/PowerOn");
  await mock("/keypress/Home");
  limitedTv = spawn("python3", [path.join(ROOT, "mock_roku.py"), "--port", "9073", "--limited"], { stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://${LIMITED}/query/device-info`); break; } catch { await sleep(100); }
  }
});

after(() => { if (limitedTv) limitedTv.kill(); });

test("ping", async () => {
  assert.deepEqual(await handleMessage({ type: "ping" }), { ok: true, version: "1.0.0", engine: "extension" });
});

test("device, apps, active app and now playing match the Python server", async () => {
  const { device, control } = await ok("GET", "/api/device", { tv: TV });
  const py = python("print(json.dumps({'device': rd.summarize(t, rd.device_info(t)), 'control': rd.can_control(t), 'apps': rd.list_apps(t), 'active': rd.active_app(t), 'now': rd.now_playing(t)}))");
  assert.ok(Math.abs(device.uptime - py.device.uptime) <= 2);
  assert.deepEqual({ ...device, uptime: 0 }, { ...py.device, uptime: 0 });
  assert.equal(control, py.control);
  assert.equal(device.address, TV);
  assert.equal(device.name, "Test TV (pretend)");
  assert.deepEqual((await ok("GET", "/api/apps", { tv: TV })).apps, py.apps);
  assert.deepEqual((await ok("GET", "/api/active", { tv: TV })).app, py.active);
  assert.deepEqual((await ok("GET", "/api/now", { tv: TV })).now, py.now);
});

test("launch, deep links, keys and now playing", async () => {
  await ok("POST", "/api/launch", { tv: TV, id: "12" });
  assert.equal((await ok("GET", "/api/active", { tv: TV })).app.id, "12");
  await ok("POST", "/api/watch", { tv: TV, appId: "12", contentId: "80100172", mediaType: "series" });
  const { now } = await ok("GET", "/api/now", { tv: TV });
  assert.equal(now.state, "play");
  assert.equal(now.appId, "12");
  assert.equal(now.duration, 600000);
  assert.equal(typeof now.position, "number");
  assert.deepEqual(now.screen, { id: "12", name: "Netflix" });
  await ok("POST", "/api/key", { tv: TV, key: "Home" });
  assert.deepEqual((await ok("GET", "/api/active", { tv: TV })).app, { id: "", name: "Roku" });
  await ok("POST", "/api/key", { tv: TV, key: "Lit_é" });
  await ok("POST", "/api/type", { tv: TV, text: "hi there" });
  const bad = await api("POST", "/api/key", { tv: TV, key: "Dance" });
  assert.deepEqual(bad, { status: 400, data: { error: "Unknown remote button." } });
  const badWatch = await api("POST", "/api/watch", { tv: TV, appId: "12", contentId: "1", mediaType: "two words" });
  assert.deepEqual(badWatch, { status: 400, data: { error: "Bad media type." } });
  await ok("POST", "/api/store", { tv: TV, id: "41468" });
  assert.equal((await ok("GET", "/api/active", { tv: TV })).app.id, "11");
  await ok("POST", "/api/key", { tv: TV, key: "Home" });
  const missing = await api("POST", "/api/launch", { tv: TV, id: "999999" });
  assert.deepEqual(missing, { status: 502, data: { error: "The TV refused the request (error 404)." } });
});

test("icons come back as data URLs", async () => {
  const reply = await handleMessage({ type: "icon", tv: TV, id: "12" });
  assert.match(reply.dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(reply.dataUrl.split(",")[1], "base64").toString(), /<svg/);
  assert.deepEqual(await handleMessage({ type: "icon", tv: "8.8.8.8", id: "12" }), { dataUrl: null, error: "That address isn't on your home network." });
  assert.deepEqual(await handleMessage({ type: "icon", tv: TV, id: "../x" }), { dataUrl: null, error: "Bad channel id." });
});

test("input checks and unsupported routes", async () => {
  assert.deepEqual(await api("GET", "/api/apps", { tv: "8.8.8.8" }), { status: 400, data: { error: "That address isn't on your home network." } });
  assert.deepEqual(await api("GET", "/api/apps", {}), { status: 400, data: { error: "No TV address given." } });
  assert.deepEqual(await api("GET", "/api/nope", { tv: TV }), { status: 404, data: { error: "Not found." } });
  assert.deepEqual(await api("GET", "/api/key", { tv: TV }), { status: 404, data: { error: "Not found." } });
  assert.deepEqual(await api("POST", "/api/key", { tv: TV, key: "x".repeat(70000) }), { status: 413, data: { error: "Request too large." } });
  assert.deepEqual(await handleMessage({ type: "api", method: "POST", path: "/api/key", body: [1] }), { status: 400, data: { error: "Bad request." } });
  assert.deepEqual(await handleMessage({ type: "api", method: "DELETE", path: "/api/key" }), { status: 404, data: { error: "Not found." } });
  assert.deepEqual(await handleMessage({ type: "sniffed", tabId: 1 }, { internal: false }), { status: 400, data: { error: "Bad request." } });
  assert.deepEqual(await handleMessage("hello"), { status: 400, data: { error: "Bad request." } });
  const phone = await api("GET", "/api/phone");
  assert.deepEqual(phone, { status: 501, data: { error: "The phone remote needs the Roku Detox program at home.", needs: "home" } });
  const install = await api("POST", "/api/tvapp/install", { tv: TV, password: "x" });
  assert.equal(install.status, 501);
  assert.equal(install.data.error, "Install Detox Home from the TV's own installer page: open http://127.0.0.1:9072 in your browser.");
  // The page's own path?query form works too.
  assert.equal((await handleMessage({ type: "api", method: "GET", path: `/api/active?tv=${TV}` })).status, 200);
});

test("Limited mode answers 409 with blocked: true", async () => {
  const reply = await api("GET", "/api/apps", { tv: LIMITED });
  assert.equal(reply.status, 409);
  assert.equal(reply.data.blocked, true);
  assert.match(reply.data.error, /^The TV is blocking this\./);
  const { control } = await ok("GET", "/api/device", { tv: LIMITED });
  assert.equal(control, false);
  const doctor = await ok("GET", "/api/doctor", { tv: LIMITED });
  assert.equal(doctor.checks[1].title, "Remote access is set to Limited");
});

test("Detox Home: refused until installed, then messages and videos travel inline", async () => {
  const before = await api("POST", "/api/tv-message", { tv: TV, text: "Dinner's ready!" });
  assert.equal(before.status, 400);
  assert.match(before.data.error, /^Detox Home isn't on this TV yet/);
  assert.equal((await ok("GET", "/api/tvapp", { tv: TV })).installed, false);

  await installDetoxHome();
  // Sending checks again right away (no waiting for the "not installed" answer to expire).
  await ok("POST", "/api/tv-message", { tv: TV, text: "Dinner's ready!" });
  assert.deepEqual(await mock("/test/last-dev"), { contentId: "inline", mediaType: "message", text: "Dinner's ready!", from: "Sent from the browser" });
  const status = await ok("GET", "/api/tvapp", { tv: TV });
  assert.equal(status.installed, true);
  assert.equal(status.devMode, true);

  const sent = await ok("POST", "/api/link", { tv: TV, url: "https://example.com/videos/clip.mp4" });
  assert.deepEqual(sent, { app: "Detox Home", title: "clip.mp4", how: "a direct video link" });
  assert.deepEqual(await mock("/test/last-dev"), {
    contentId: "inline", mediaType: "video", url: "https://example.com/videos/clip.mp4", title: "clip.mp4", streamFormat: "mp4",
  });

  const direct = await ok("POST", "/api/link", { tv: TV, url: "https://example.com/watch/1", video: "https://cdn.example.com/hls/master.m3u8", title: "Episode 1" });
  assert.deepEqual(direct, { app: "Detox Home", title: "Episode 1", how: "the page's video player" });
  assert.equal((await mock("/test/last-dev")).referer, "https://example.com/watch/1");
  assert.equal((await mock("/test/last-dev")).streamFormat, "hls");

  const yt = await ok("POST", "/api/link", { tv: TV, url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.deepEqual(yt, { app: "YouTube", title: "" });
  assert.equal((await ok("GET", "/api/active", { tv: TV })).app.id, "837");
  await ok("POST", "/api/key", { tv: TV, key: "Home" });
});

test("settings, scenes, undo list, sites and watch history", async () => {
  const saved = await ok("POST", "/api/settings", {
    tv: TV, favorites: ["12", "837", "12"], services: { "12": true },
    scenes: [{ id: "quiet", name: "Quiet", steps: [{ do: "mute" }, { do: "wait", n: 1 }] }],
  });
  assert.deepEqual(saved, { favorites: ["12", "837"], scenes: [{ id: "quiet", name: "Quiet", steps: [{ do: "mute" }, { do: "wait", n: 1 }], at: null }], services: { "12": true } });
  assert.deepEqual(await ok("GET", "/api/settings", { tv: TV }), saved);
  await ok("POST", "/api/scene", { tv: TV, id: "quiet" });
  assert.deepEqual(await api("POST", "/api/scene", { tv: TV, id: "gone" }), { status: 400, data: { error: "That scene doesn't exist anymore." } });

  const { entry } = await ok("POST", "/api/log", { action: "removed", id: "74519", name: "Pluto TV", version: "1.0", tv: "Test TV", address: TV });
  assert.equal(entry.address, TV);
  assert.match(entry.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  assert.deepEqual((await ok("GET", "/api/log")).entries, [entry]);

  const sites = await ok("POST", "/api/sites", { sites: [{ id: "arch", name: "Archive", search: "https://archive.org/search?query={q}" }] });
  assert.deepEqual(sites, { sites: [{ id: "arch", name: "Archive", search: "https://archive.org/search?query={q}" }] });
  assert.deepEqual(await ok("GET", "/api/sites"), sites);

  const item = { id: "ts22138", title: "The Bear", type: "Show", year: 2022, poster: null, season: { id: "tss1", number: 1 },
    episode: { id: "tse1", number: 1, title: "System" }, appId: "2285", appName: "Hulu" };
  let history = await ok("POST", "/api/find/history", { tv: TV, item });
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].pinned, false);
  history = await ok("POST", "/api/find/history", { tv: TV, item: { ...item, id: "tm2", type: "Movie", season: null, episode: null, title: "Up" } });
  history = await ok("POST", "/api/find/history/pin", { tv: TV, id: "ts22138", pinned: true });
  assert.deepEqual(history.items.map((i) => [i.id, i.pinned]), [["ts22138", true], ["tm2", false]]);
  history = await ok("POST", "/api/find/history/remove", { tv: TV, id: "tm2" });
  assert.deepEqual(history.items.map((i) => i.id), ["ts22138"]);
  assert.deepEqual(await ok("GET", "/api/find/history", { tv: TV }), history);
  assert.deepEqual(await api("POST", "/api/find/history/pin", { tv: TV, id: "ts1", pinned: "yes" }), { status: 400, data: { error: "Say whether to pin it (true or false)." } });
  // Everything lives under the TV's address, like remote-settings.json.
  const stored = chrome.storage.local.dump().settings;
  assert.deepEqual(Object.keys(stored.tvs), [TV]);
  assert.deepEqual(Object.keys(stored.tvs[TV]).sort(), ["favorites", "findHistory", "scenes", "services"]);
});

test("rules: save, status, and a blocked app gets closed", async () => {
  const status = await ok("POST", "/api/rules", { tv: TV, rules: { blocked: ["74519"], limits: { "41468": 30 } } });
  assert.deepEqual(Object.keys(status).sort(), ["active", "app", "awake", "bedtimeNow", "events", "power", "rules", "usage", "watching"]);
  assert.equal(status.active, true);
  assert.deepEqual(status.rules.blocked, ["74519"]);
  const bad = await api("POST", "/api/rules", { tv: TV, rules: { redirects: { a: "b", b: "a" } } });
  assert.deepEqual(bad, { status: 400, data: { error: "Two swaps point at each other, so the TV would flip back and forth." } });

  await ok("POST", "/api/launch", { tv: TV, id: "74519" });
  await rules.runRound();
  const after = await ok("GET", "/api/rules", { tv: TV });
  assert.equal(after.watching, true);
  assert.equal(after.power, "on");
  assert.equal(after.events[0].message, "Pluto TV - It's Free TV is blocked. Closed it.");
  const shown = await mock("/test/last-dev"); // Detox Home is installed, so the TV shows a notice instead
  assert.deepEqual(shown, { contentId: "inline", mediaType: "notice", title: "Not on this TV", text: "Pluto TV - It's Free TV is blocked." });

  const extended = await ok("POST", "/api/rules/extend", { tv: TV, minutes: 30 });
  assert.ok(extended.rules.bedtime.extendUntil > Date.now() / 1000 + 29 * 60);
  const skipped = await ok("POST", "/api/rules/skip", { tv: TV });
  assert.equal(skipped.rules.autopilot.skipNext, true);
  await ok("POST", "/api/rules", { tv: TV, rules: {} });
  await ok("POST", "/api/key", { tv: TV, key: "Home" });
});

test("doctor and discovery", async () => {
  const doctor = await ok("GET", "/api/doctor", { tv: TV });
  assert.deepEqual(doctor.checks.slice(0, 2).map((c) => [c.ok, c.title]), [[true, "The TV answers on your Wi-Fi"], [true, "Remote access is on"]]);
  assert.equal(doctor.moved, null);
  const tvs = await discover({ hosts: [TV, LIMITED, "127.0.0.1:9"], includeKnown: false, remember: false });
  assert.deepEqual(tvs.map((t) => t.address).sort(), [TV, LIMITED]);
});

test("restart sequence takes the pretend TV offline, and it comes back", async () => {
  await ok("POST", "/api/restart", { tv: TV });
  const down = await api("GET", "/api/device", { tv: TV });
  assert.deepEqual(down, { status: 502, data: { error: "The TV didn't answer. Check it's turned on and on the same Wi-Fi." } });
  await sleep(8500);
  assert.equal((await ok("GET", "/api/device", { tv: TV })).device.name, "Test TV (pretend)");
});
