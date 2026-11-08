// Video finder (a video page served on this computer vs roku_detox.py), "My sites" result reading, and the
// media sniffer. Nothing here needs the internet.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
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

// A page with a video, served by a throwaway web server (a separate process, since the Python side blocks).
const SITE_PORT = await new Promise((resolve) => {   // a free port, so nothing else on this computer is in the way
  const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const site = mkdtempSync(path.join(tmpdir(), "roku-detox-video-"));
writeFileSync(path.join(site, "watch.html"), `<!doctype html><html><head><title>Big Buck Bunny &amp; friends</title>
<meta property="og:title" content="Big Buck Bunny"></head><body>
<video controls><source src="media/bunny.mp4" type="video/mp4"><source src="https://ads.doubleclick.net/x.mp4"></video>
</body></html>`);
// Players set up in other common ways: a schema.org embedUrl to a player page whose script names a path on
// its own site, and a <source> whose type (not its ending) says it's HLS.
writeFileSync(path.join(site, "show.html"), `<!doctype html><html><head><title>Open Movie</title>
<script type="application/ld+json">{"@type": "VideoObject", "name": "Open Movie", "embedUrl": "\\/player.html?id=7"}</script>
</head><body><p>Watch below.</p></body></html>`);
writeFileSync(path.join(site, "player.html"), `<!doctype html><html><body><div id="p"></div>
<script>player.setup({ file: "/streams/open/master.m3u8?sig=1", image: "/poster.jpg" });</script></body></html>`);
writeFileSync(path.join(site, "typed.html"), `<!doctype html><html><head><title>Typed</title></head><body>
<video controls><source src="/live/playlist?token=9" type="application/x-mpegURL"></video></body></html>`);
const server = spawn("python3", ["-m", "http.server", String(SITE_PORT), "--bind", "127.0.0.1", "--directory", site], { stdio: "ignore" });
after(() => server.kill());
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`http://127.0.0.1:${SITE_PORT}/watch.html`)).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 100));
}

test("find_video on a video page matches the Python finder", async () => {
  const url = `http://127.0.0.1:${SITE_PORT}/watch.html`;
  const js = await video.findVideo(url);
  assert.equal(js.url, `http://127.0.0.1:${SITE_PORT}/media/bunny.mp4`);
  assert.equal(js.title, "Big Buck Bunny");
  const py = pythonExpr(`rd.find_video(${JSON.stringify(url)})`);
  assert.ok(py.value, py.error);
  assert.deepEqual(js, py.value);
  console.log(`  found ${js.url} (${js.format}, via ${js.how}), title "${js.title}"`);
});

test("find_video follows a VideoObject's embedUrl and reads typed sources, like the Python finder", async () => {
  const base = `http://127.0.0.1:${SITE_PORT}`;
  const embedded = await video.findVideo(`${base}/show.html`);
  assert.deepEqual([embedded.url, embedded.format, embedded.how, embedded.referer],
    [`${base}/streams/open/master.m3u8?sig=1`, "hls", "the page's video player", `${base}/player.html?id=7`]);
  assert.deepEqual(embedded, pythonExpr(`rd.find_video(${JSON.stringify(`${base}/show.html`)})`).value);
  const typed = await video.findVideo(`${base}/typed.html`);
  assert.deepEqual([typed.url, typed.format], [`${base}/live/playlist?token=9`, "hls"]);
  assert.deepEqual(typed, pythonExpr(`rd.find_video(${JSON.stringify(`${base}/typed.html`)})`).value);
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

test("results are read from page data and look-alike links like read_results", () => {
  const data = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"url":"https://example.com/watch/ocean-life","name":"Ocean Life &amp; More","image":"https://img.example.com/ocean.jpg"},{"@type":"ListItem","position":2,"url":"https://example.com/watch/deep-sea","name":"Deep Sea"}]}</script>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"results":[{"title":"Whales of the Ocean","href":"/video/whales?utm_source=x","duration":3600,"thumbnail":{"sources":[{"url":"//img.example.com/w-small.jpg"},{"url":"//img.example.com/w-big.jpg"}]}},{"title":"About us","url":"/about"},{"name":"Ocean menu link","url":"/menu/ocean"}]}}}</script>
    <script>window.__INITIAL_STATE__ = {"feed":{"items":[{"headline":{"runs":[{"text":"Coral "},{"text":"Reefs"}]},"permalink":"https://example.com/watch/coral","viewCount":10}]}};</script>
    <script>var junk = {a: 1}; self.cfg = JSON.parse("{\\"items\\":[{\\"title\\":\\"Ocean Storms\\",\\"url\\":\\"/watch/storms\\",\\"releaseDate\\":\\"2020\\",\\"pad\\":\\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\"}]}");</script>
    <script>var ytInitialData = {"contents":[{"videoRenderer":{"videoId":"abcdefghijk","title":{"runs":[{"text":"Sea "},{"text":"Otters"}]},"thumbnail":{"thumbnails":[{"url":"https://i.ytimg.com/vi/abcdefghijk/1.jpg"},{"url":"https://i.ytimg.com/vi/abcdefghijk/2.jpg"}]}}}]};</script>
    </head><body><nav><a href="/watch/nav-ocean">Ocean (nav)</a></nav>
    <a href="/watch/ocean-life">Ocean Life</a><a href="/watch/forest">Forest</a><a href="/watch/ocean-sunset?ref=a">Ocean sunset</a></body></html>`;
  const grid = `<div>${["Panda hunt", "Daddy, stop", "City lights", "Rain", "Ocean drive", "Night shift"].map((t, i) => `<a href="/video/x${i}z">${t}</a><a href="/video/x${i}z?pp=1">${i}:00</a>`).join("")}<a href="/about-us">About</a><a href="/channel/ocean-fans">Ocean fans</a></div>`;
  const calls = [
    ["https://example.com/search?q=ocean", data, "ocean"], ["https://www.youtube.com/results?search_query=otter", data, "otter"],
    ["https://example.com/search?q=ocean", grid, "ocean"], ["https://example.com/s", grid, "zzz"], ["https://example.com/s", "<p>nothing</p>", "ocean"],
  ];
  const expected = oracle(calls.map((args) => ({ fn: "read_results", args })));
  calls.forEach((args, i) => {
    let got;
    try { got = { value: video.readResults(...args) }; } catch (err) { got = { error: err.message }; }
    assert.deepEqual(got.error ?? got.value, expected[i].error ?? expected[i].value, `${args[0]} ${args[2]}`);
  });
  const ocean = video.readResults(...calls[0]).map((r) => r.title);
  assert.ok(ocean.includes("Whales of the Ocean") && ocean.includes("Coral Reefs") && ocean.includes("Ocean Storms") && !ocean.includes("Ocean (nav)"));
  assert.ok(video.readResults(...calls[1]).some((r) => r.url === "https://www.youtube.com/watch?v=abcdefghijk" && r.title === "Sea Otters"));
  assert.equal(video.readResults(...calls[2]).length, 7); // six look-alike results plus the one that names the words
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
