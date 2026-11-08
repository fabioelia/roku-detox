// Video finder (live public page vs roku_detox.py), "My sites" result reading, and the media sniffer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const video = await import("../engine/video.js");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");

function pythonExpr(expr) {
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd
try:
    print(json.dumps({"value": ${expr}}))
except Exception as err:
    print(json.dumps({"error": str(err)}))`;
  return JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf-8" }));
}

function oracle(calls) {
  return JSON.parse(execFileSync("python3", [path.join(HERE, "py_oracle.py")], { input: JSON.stringify(calls), encoding: "utf-8" }));
}

test("find_video on a public page matches the Python finder", async () => {
  const url = "https://www.w3schools.com/html/html5_video.asp";
  const js = await video.findVideo(url);
  const py = pythonExpr(`rd.find_video(${JSON.stringify(url)})`);
  assert.ok(py.value, py.error);
  assert.deepEqual(js, py.value);
  console.log(`  found ${js.url} (${js.format}, via ${js.how}), title "${js.title}"`);
});

test("find_video errors match", async () => {
  for (const url of ["ftp://example.com/x", "https://example.invalid/page"]) {
    let message = null;
    try { await video.findVideo(url); } catch (err) { message = err.message; }
    const py = pythonExpr(`rd.find_video(${JSON.stringify(url)})`);
    assert.equal(message, py.error.replace("from this Mac", "from this browser"));
  }
  const direct = await video.findVideo("https://example.com/watch", "https://cdn.example.com/a/master.m3u8?t=1");
  assert.deepEqual(direct, pythonExpr('rd.find_video("https://example.com/watch", "https://cdn.example.com/a/master.m3u8?t=1")').value);
});

test("search results are read like search_site", () => {
  const page = `<html><body><nav><a href="/movies/the-bear-menu">The Bear (menu)</a></nav>
    <div class="results">
      <a href="/watch/the-bear-s1" title="The Bear Season 1"><img data-src="https://img.example.com/bear1.jpg" src="/blank.gif"></a>
      <a href="/watch/the-bear-s1?ref=x">The Bear Season 1 (2022)</a>
      <a href="https://other.com/the-bear">Elsewhere: The Bear</a>
      <a href="/watch/polar-bear-doc"><img src="http://img.example.com/p.jpg" alt="Polar Bear documentary"></a>
      <a href="/login">Bear login</a>
      <a href="/watch/kitchen">Kitchen Nightmares</a>
      <a href="https://ads.example.com/ads/bear">Bear ad</a>
      <a href="/tag/bear">bear</a>
      <a href="/">Home</a>
    </div></body></html>`;
  const calls = [["https://example.com/search?q=the+bear", page, "the bear"], ["https://example.com/s", page, "zzz"], ["https://example.com/s", page, "a"]];
  const expected = oracle(calls.map((args) => ({ fn: "read_results", args })));
  calls.forEach((args, i) => {
    let got;
    try { got = { value: video.readResults(...args) }; } catch (err) { got = { error: err.message }; }
    assert.deepEqual(got.error ?? got.value, expected[i].error ?? expected[i].value, JSON.stringify(args[2]));
  });
});

test("sniffer: records playable media per tab, skips ads and segments, picks the best", async () => {
  chrome.tabs.list.set(7, { id: 7, url: "https://videos.example.com/watch/42", title: "Episode 42" });
  const note = (url, type, extra = {}) => video.noteMedia({
    tabId: 7, url, statusCode: 200, type: "media", ...extra,
    responseHeaders: [{ name: "Content-Type", value: type }, ...(extra.headers || [])],
  });
  await note("https://cdn.example.com/v/preview.mp4", "video/mp4", { headers: [{ name: "Content-Range", value: "bytes 0-1/500000" }] });
  await note("https://cdn.example.com/v/full", "video/mp4", { headers: [{ name: "Content-Length", value: "900000000" }] });
  await note("https://cdn.example.com/hls/seg1.ts", "video/mp2t");
  await note("https://ads.example.com/ads/preroll.mp4", "video/mp4");
  await note("https://pubads.g.doubleclick.net/x.m3u8", "application/vnd.apple.mpegurl");
  await note("https://cdn.example.com/page.html", "text/html");
  await video.noteMedia({ tabId: -1, url: "https://cdn.example.com/bg.mp4", responseHeaders: [] });

  let { items, best } = await video.sniffedForTab(7);
  assert.deepEqual(items.map((i) => i.url), ["https://cdn.example.com/v/full", "https://cdn.example.com/v/preview.mp4"]);
  assert.equal(best.url, "https://cdn.example.com/v/full"); // the bigger file, not the preview
  assert.equal(best.page, "https://videos.example.com/watch/42");
  assert.equal(best.title, "Episode 42");

  await note("https://cdn.example.com/hls/master.m3u8", "application/x-mpegURL");
  await note("https://cdn.example.com/hls/720p.m3u8", "application/x-mpegURL");
  ({ best } = await video.sniffedForTab(7));
  assert.equal(best.url, "https://cdn.example.com/hls/master.m3u8"); // HLS first, and its master playlist

  for (let i = 0; i < 30; i++) await note(`https://cdn.example.com/frag/${i}.mp4`, "video/mp4");
  ({ items, best } = await video.sniffedForTab(7));
  assert.equal(items.length, 20);
  assert.equal(best.url, "https://cdn.example.com/hls/master.m3u8"); // stream manifests outlive plain files

  const found = await video.findVideo("https://videos.example.com/watch/42#t=5", null, video.sniffedForUrl("https://videos.example.com/watch/42#t=5"));
  assert.deepEqual(found, { url: "https://cdn.example.com/hls/master.m3u8", title: "Episode 42", format: "hls",
    how: "the video playing in this browser", referer: "https://videos.example.com/watch/42" });
  assert.deepEqual((await video.sniffedForTab(99)).items, []);
});

test("mediaKind and the referer rule", async () => {
  assert.deepEqual(video.mediaKind("https://x.com/a.mpd", ""), { format: "dash", mime: "" });
  assert.deepEqual(video.mediaKind("https://x.com/stream", "application/dash+xml"), { format: "dash", mime: "application/dash+xml" });
  assert.equal(video.mediaKind("https://x.com/a.webm", "video/webm"), null);
  assert.equal(video.mediaKind("https://x.com/a.json", "application/json"), null);
  // Frames are read with the page as Referer, through a short-lived session rule.
  try { await video.fetchPage("https://example.invalid/frame", { referer: "https://example.com/page" }); } catch { /* no such host */ }
  assert.equal(chrome.declarativeNetRequest.rules.size, 0, "the referer rule is removed afterwards");
});
