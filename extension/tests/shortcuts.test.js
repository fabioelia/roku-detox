// The right-click menu, "tv" in the address bar and keyboard shortcuts, against the pretend TV
// (python3 mock_roku.py --port 9072).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const shortcuts = await import("../engine/shortcuts.js");
const TV = "127.0.0.1:9072";

async function activeApp() {
  const xml = await (await fetch(`http://${TV}/query/active-app`)).text();
  return (/<app[^>]*\bid="([^"]+)"/.exec(xml) || [])[1] || "home";
}

test("with no TV picked, actions explain what to do", async () => {
  await shortcuts.onCommand("tv-home");
  assert.match(chrome.notifications.list.at(-1).message, /Pick your TV first/);
});

test("tv in the address bar: buttons, apps, links, then finding and searching", async () => {
  await chrome.storage.local.set({ lastTv: TV });
  assert.equal((await shortcuts.omniboxSuggestions("pause"))[0].content, "key:Play");
  assert.equal((await shortcuts.omniboxSuggestions("Louder"))[0].content, "key:VolumeUp");
  const netflix = await shortcuts.omniboxSuggestions("netf");
  assert.equal(netflix[0].content, "open:12");
  assert.match(netflix[0].description, /<match>Netflix<\/match>/);
  const link = await shortcuts.omniboxSuggestions("https://youtu.be/dQw4w9WgXcQ");
  assert.deepEqual(link.map((s) => s.content), ["link:https://youtu.be/dQw4w9WgXcQ"]);
  const show = await shortcuts.omniboxSuggestions("the bear & co <3");
  assert.deepEqual(show.map((s) => s.content), ["find:the bear & co <3", "search:the bear & co <3"]);
  assert.ok(show[0].description.includes("the bear &amp; co &lt;3"), "descriptions are escaped for the address bar");
  assert.deepEqual(await shortcuts.omniboxSuggestions("   "), []);
});

test("right-click a link and keyboard shortcuts act on the last TV", async () => {
  await shortcuts.onCommand("tv-home");
  assert.equal(await activeApp(), "home");
  await shortcuts.onMenuClick({ menuItemId: "send-link", linkUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, { id: 4, title: "A page" });
  assert.equal(await activeApp(), "837");
  assert.match(chrome.notifications.list.at(-1).message, /YouTube/);
  await shortcuts.onCommand("tv-home");
  assert.equal(await activeApp(), "home");
  const before = chrome.notifications.list.length;
  await shortcuts.onCommand("volume-up");
  assert.equal(chrome.notifications.list.length, before, "buttons that work stay quiet");
});

test("scenes you made show up in the address bar", async () => {
  const { handleMessage } = await import("../engine/router.js");
  const saved = await handleMessage({ type: "api", method: "POST", path: "/api/settings", query: {}, body: {
    tv: TV, scenes: [{ name: "Game time", steps: [{ do: "open", target: "tvinput.hdmi2" }] }],
  } }, { internal: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const id = saved.data.scenes[0].id;
  await new Promise((r) => setTimeout(r, 0));
  const list = await shortcuts.omniboxSuggestions("game");
  assert.ok(list.some((s) => s.content === `scene:${id}` && s.description.includes("<match>Game time</match>")), JSON.stringify(list));
});

test("only punctuation doesn't match every scene and app", async () => {
  const list = await shortcuts.omniboxSuggestions("+");
  assert.deepEqual(list.map((s) => s.content), ["search:+"]);
});

test("numbered phrases in the address bar do what they say", async () => {
  assert.deepEqual((await shortcuts.omniboxSuggestions("sleep 30"))[0], { content: "do:sleep 30", description: "Turn the TV off in 30 minutes <dim>on the TV</dim>" });
  assert.equal((await shortcuts.omniboxSuggestions("Volume up 5"))[0].content, "do:Volume up 5");
  assert.equal((await shortcuts.omniboxSuggestions("hdmi 2"))[0].content, "do:hdmi 2");
});

test("questions in the address bar answer in a notification", async () => {
  await chrome.storage.local.set({ lastTv: TV });
  const [first] = await shortcuts.omniboxSuggestions("what's on?");
  assert.deepEqual(first, { content: "do:what's on?", description: "Tell me what's on the TV <dim>(the answer shows as a notification)</dim>" });
  assert.equal((await shortcuts.omniboxSuggestions("screen-time"))[0].content, "do:screen-time");
  assert.equal((await shortcuts.omniboxSuggestions("Screen time"))[0].content, "do:Screen time");
  assert.equal((await shortcuts.omniboxSuggestions("time left today"))[0].content, "do:time left today");
  assert.equal((await shortcuts.omniboxSuggestions("pause rules"))[0].content, "do:pause rules");
});
