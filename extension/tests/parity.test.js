// The ported pure functions must answer exactly like roku_detox.py (asked through py_oracle.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const util = await import("../engine/util.js");
const ecp = await import("../engine/ecp.js");
const catalog = await import("../engine/catalog.js");
const video = await import("../engine/video.js");
const store = await import("../engine/store.js");
const rules = await import("../engine/rules.js");

const ORACLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "py_oracle.py");

function python(calls) {
  const out = execFileSync("python3", [ORACLE], { input: JSON.stringify(calls), encoding: "utf-8", maxBuffer: 1 << 24 });
  return JSON.parse(out);
}

const plain = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));

/** Run every args list through Python's fn and the JS function, and compare. */
function same(fn, js, argsList, { errorsOnly = false } = {}) {
  const expected = python(argsList.map((args) => ({ fn, args })));
  argsList.forEach((args, i) => {
    let got;
    try {
      got = { value: plain(js(...args)) };
    } catch (err) {
      got = { error: err.message, type: err.constructor.name };
    }
    const want = expected[i];
    const label = `${fn}(${JSON.stringify(args).slice(0, 160)})`;
    if ("error" in want) {
      assert.ok("error" in got, `${label}: Python failed with "${want.error}", JS returned ${JSON.stringify(got.value)}`);
      if (want.type === "ParseError") assert.equal(got.type, "ParseError", label);
      else assert.equal(got.error, want.error, label);
    } else {
      assert.ok(!("error" in got), `${label}: JS failed with "${got.error}", Python returned ${JSON.stringify(want.value)}`);
      if (!errorsOnly) assert.deepEqual(got.value, want.value, label);
    }
  });
}

const APPS = [
  ["12", "appl", "Netflix"], ["837", "appl", "YouTube"], ["13", "appl", "Prime Video"], ["2285", "appl", "Hulu"],
  ["291097", "appl", "Disney Plus"], ["151908", "appl", "The Roku Channel"], ["74519", "appl", "Pluto TV - It's Free TV"],
  ["41468", "appl", "Tubi - Free Movies & TV"], ["635764", "appl", "Xumo Play"], ["46041", "appl", "Sling TV"],
  ["2213", "appl", "Roku Media Player"], ["593099", "appl", "Peacock TV"], ["195316", "appl", "YouTube TV"],
  ["61322", "appl", "Max"], ["31440", "appl", "Paramount Plus"], ["551012", "appl", "Apple TV"],
  ["tvinput.hdmi1", "tvin", "HDMI 1"], ["x1", "menu", "Home"], ["2", "appl", "Roku TV Intro"], ["9", "appl", "Shout! TV"],
].map(([id, type, name]) => ({ id, type, version: "1.0", name }));

test("app_key", () => {
  same("app_key", catalog.appKey, [
    "Tubi - Free Movies & TV", "Tubi TV", "Netflix", "Prime Video", "Amazon Prime Video", "Disney Plus", "Disney+",
    "Paramount+", "Paramount Plus Essential", "YouTube TV", "YouTube", "Max", "HBO Max", "Peacock TV", "Peacock Premium",
    "The Roku Channel", "Pluto TV - It's Free TV", "Hulu", "Hulu (No Ads)", "Apple TV+", "Apple TV", "Starz Amazon Channel",
    "Showtime Roku Premium Channel", "Sling TV", "Fandango at Home", "Crunchyroll", "AMC+", "fuboTV", "Plex: Stream Movies & TV",
    "Xumo Play", "A&E", "PBS KIDS", "Netflix Standard with Ads", "Amazon Prime Video with Ads", "MGM+ Apple TV Channel",
    "Discovery+", "Café TV – Música", "", "TV", "+", "Hulu | Live TV", "BBC: iPlayer", "YouTubeTV Extra",
  ].map((n) => [n]));
});

test("match_app", () => {
  const services = ["Netflix", "Netflix Standard with Ads", "Amazon Prime Video", "Amazon Prime Video with Ads", "Disney Plus",
    "Hulu", "Peacock Premium", "Peacock Premium Plus", "The Roku Channel", "Pluto TV", "Tubi TV", "YouTube", "YouTube TV",
    "Max", "HBO Max", "Paramount Plus", "Paramount+ Amazon Channel", "Apple TV", "Apple TV+", "Sling TV", "Xumo Play",
    "Fandango at Home", "Starz", "TV", "Plex"];
  same("match_app", catalog.matchApp, services.map((s) => [s, APPS]));
});

test("parse_link", () => {
  same("parse_link", video.parseLink, [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?t=10", "https://m.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://youtube.com/live/dQw4w9WgXcQ", "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x",
    "https://www.youtube.com/channel/UC123", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/watch?v=&v=dQw4w9WgXcQ",
    "https://www.netflix.com/title/80100172", "https://www.netflix.com/watch/80100172?trackId=1", "https://www.netflix.com/browse",
    "https://www.netflix.com/gb/title/80100172", "ftp://x.com/a", "not a link", "", "  https://youtu.be/dQw4w9WgXcQ  ",
    "https://vimeo.com/123", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "http://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com", "https://www.netflix.com/title/abc", "https://www.w3schools.com/html/html5_video.asp",
  ].map((l) => [l]));
});

test("parse_roku_deeplink", () => {
  same("parse_roku_deeplink", catalog.parseRokuDeeplink, [
    "launch/12?contentID=82939566&MediaType=show", "launch/837?contentId=abc&mediaType=live", "launch/12", "launch/12?",
    "launch/dev?contentID=", "foo/12", null, "launch/12?contentID=a%20b+c&MediaType=movie", `launch/12?contentID=${"x".repeat(501)}`,
    "launch/bad id?x=1", "launch/12?MediaType=episode&contentID=1&contentID=2", "launch/tvinput.hdmi1", "launch/12?novalue&contentID=9",
  ].map((l) => [l]));
});

test("classify", () => {
  same("classify", ecp.classify, APPS.map((a) => [a]));
});

test("is_ad_url and stream_format", () => {
  const urls = ["https://pubads.g.doubleclick.net/x.mp4", "https://cdn.example.com/ads/preroll.mp4", "https://cdn.example.com/video/main.mp4",
    "https://example.com/vast.xml", "https://example.com/headset.mp4", "https://example.com/my_ad_video.mp4", "https://criteo.com/x",
    "https://static.criteo.net/x", "https://imasdk.googleapis.com/js/sdkloader/ima3.js", "https://example.com/sponsored/clip.m3u8",
    "https://example.com/Ad.mp4", "https://x.com/a.m3u8?x=1", "https://x.com/a.MPD", "https://x.com/a", "https://adserver.site.com/v.mp4",
    "https://media.net/a", "https://example.com/pre-roll/a.mp4"];
  same("is_ad_url", video.isAdUrl, urls.map((u) => [u]));
  same("stream_format", video.streamFormat, urls.map((u) => [u]));
});

test("parse_target", () => {
  same("parse_target", (v) => { const t = util.parseTarget(v); return [t.host, t.port]; }, [
    "192.168.1.50", "192.168.1.50:8060", "192.168.1.20:9072", "127.0.0.1:9072", " 192.168.1.20 ", "8.8.8.8", "0.0.0.0", "256.1.1.1",
    "010.0.0.1", "192.168.1", "fe80::1", "localhost", "", null, "192.168.1.50:0", "192.168.1.50:70000", "192.168.1.50:abc", "172.16.5.4",
    "172.32.0.1", "169.254.1.1", "100.64.0.1", "192.168.1.20:8060:1", 5, "192.168.1.20:", "203.0.113.9",
  ].map((v) => [v]));
  same("display_address", (h, p) => util.displayAddress({ host: h, port: p }), [["10.0.0.1", 8060], ["127.0.0.1", 9072]]);
});

const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="A &amp; B: the movie">
<meta content="https://cdn.example.com/og/clip.mp4" property="og:video">
<meta name="twitter:player:stream" content="https://ads.example.com/ads/pre.mp4">
<title>Fallback title</title></head><body>
<video src="/media/local.mp4?x=1&amp;y=2"></video>
<video><source src="https://cdn.example.com/v/clip.webm" type="video/webm"><source src='https://cdn.example.com/v/clip.mp4'></video>
<script>var cfg = {"contentUrl": "https:\\/\\/cdn.example.com\\/v\\/master.m3u8", "x": "https:\\/\\/cdn.example.com\\/v\\/other.mpd"};</script>
<a href="https://pubads.g.doubleclick.net/vast/ad.mp4">ad</a> https://cdn.example.com/raw/file.mov?token=abc
<iframe src="https://player.example.com/embed/1"></iframe>
</body></html>`;

test("video_candidates, pick_video, page_title, page_meta", () => {
  same("video_candidates", video.videoCandidates, [[PAGE, "https://example.com/page/1"], ["<p>nothing</p>", "https://example.com/"],
    ['<video src="javascript:alert(1)"></video><source src="//cdn.example.com/x.mp4">', "https://example.com/a/b"]]);
  same("pick_video", video.pickVideo, [
    [["https://cdn.example.com/a.mp4", "https://cdn.example.com/b.m3u8", "https://cdn.example.com/c.mpd"]],
    [["https://cdn.example.com/a.mp4", "https://www.youtube.com/embed/dQw4w9WgXcQ"]],
    [["https://cdn.example.com/a.webm"]], [[]], [["https://cdn.example.com/a.mpd", "https://cdn.example.com/b.mp4", "https://cdn.example.com/c.mp4"]],
  ]);
  same("page_title", video.pageTitle, [[PAGE], ["<title> Plain &quot;title&quot; </title>"], ["<p>none</p>"]]);
  same("page_meta", video.pageMeta, [[PAGE, "og:video:secure_url", "og:video"], [PAGE, "missing"]]);
  same("strip_tags", video.stripTags, [["<b>Hello</b>   <i>world</i> &amp; more\n"], ["<img alt='x'>"], ["Caf&eacute; &#233; &#x41;"]]);
});

test("clean_rules", () => {
  const good = {
    autopilot: { enabled: true, target: "12", skipNext: 0 },
    bedtime: { enabled: true, start: "22:00", end: "06:30", extendUntil: "123" },
    nightGuard: { enabled: 1 },
    limits: { "74519": 30, "41468": 9999, "12": "x" },
    blocked: ["9", "41468", "9"],
    redirects: { "74519": "151908", "13": "13" },
    log: true,
  };
  same("clean_rules", rules.cleanRules, [
    [good], [{}], [{ autopilot: { enabled: true } }], [{ bedtime: { start: "25:00" } }], [{ redirects: { a: "b", b: "a" } }],
    [{ redirects: { a: "b" }, blocked: ["b"] }], [{ autopilot: { enabled: true, target: "b" }, blocked: ["b"] }],
    [{ autopilot: { enabled: true, target: "b" }, redirects: { b: "c" } }], [{ limits: { "bad id!": 5 } }], [{ nightGuard: { idleMinutes: 0 } }],
    [{ nightGuard: { idleMinutes: 99, start: "", end: null } }], [{ blocked: [12, "13"] }], [{ redirects: { "12": 12 } }],
    [{ bedtime: { days: ["fri", "sat", "fri", 3] } }], [{ bedtime: { days: [] } }], [{ bedtime: { days: "mon" } }], [{ bedtime: { days: null } }],
  ]);
});

test("clean_scenes, clean_sites, clean_favorites, clean_services", () => {
  same("clean_scenes", store.cleanScenes, [
    [[{ id: "abc123", name: "  Movie night  ", steps: [{ do: "power_on" }, { do: "open", target: "tvinput.hdmi1" }, { do: "volume_up", n: "7" },
      { do: "volume_down", n: 99 }, { do: "mute" }, { do: "wait", n: 100 }, { do: "power_off" }], at: "21:30" }]],
    [[{ id: "a", name: "x", steps: [{ do: "dance" }] }]], [[{ id: "a", name: "", steps: [{ do: "mute" }] }]],
    [[{ id: "a", name: "Open", steps: [{ do: "open" }] }]], [[{ id: "a", name: "Late", steps: [{ do: "mute" }], at: "25:00" }]],
    [[{ id: "a", name: "Empty", steps: [] }]], [[{ id: "a1", name: "No time", steps: [{ do: "wait", n: "x" }], at: "" }]],
    ["nope"], [[1]],
  ]);
  same("clean_sites", store.cleanSites, [
    [[{ id: "s1", name: "Archive", search: "https://archive.org/search?query={q}" }]],
    [[{ id: "s1", name: "No q", search: "https://example.com/search" }]], [[{ id: "s1", name: "Bad", search: "ftp://x/{q}" }]],
    [[{ id: "s1", name: "Host", search: "https://{q}.example.com/" }]], [[{ id: "s1", name: "Port", search: "https://example.com:{q}/" }]],
    [[{ id: "s1", name: "", search: "https://x.com/{q}" }]], [Array(21).fill({ id: "s", name: "x", search: "https://x.com/{q}" })],
  ]);
  same("clean_favorites", store.cleanFavorites, [[["12", 837, "12", "tvinput.hdmi1"]], [["bad id!"]], ["x"]]);
  same("clean_services", store.cleanServices, [[{ "12": true, "13": 0, "2285": "yes" }], [{ "bad id!": true }], [[]]]);
});

test("clean_history_item", () => {
  const show = { id: "ts22138", title: " The Bear ", type: "Show", year: 2022, poster: "https://images.justwatch.com/poster/1/s166/x.webp",
    season: { id: "tss1", number: 1 }, episode: { id: "tse1", number: 2, title: "Hands" }, appId: "2285", appName: "Hulu" };
  same("clean_history_item", catalog.cleanHistoryItem, [
    [show], [{ ...show, type: "Movie" }], [{ ...show, poster: "https://evil.example.com/x.png" }], [{ ...show, title: "" }],
    [{ ...show, year: 1800 }], [{ ...show, appName: "" }], [{ ...show, season: null }], [{ ...show, appId: "bad id!" }],
    [{ id: "tm1", title: "Movie", type: "Movie" }], ["x"], [{ ...show, episode: { id: "tse1", number: 1.5 } }],
  ]);
});

test("annotate_offers and poster_url", () => {
  const raw = [
    { monetizationType: "FLATRATE", retailPrice: null, package: { clearName: "Hulu", technicalName: "hulu" }, deeplinkURL: "launch/2285?contentID=abc&MediaType=series" },
    { monetizationType: "FLATRATE", package: { clearName: "Hulu", technicalName: "hulu" }, deeplinkURL: null },
    { monetizationType: "ADS", package: { clearName: "Tubi TV", technicalName: "tubitv" } },
    { monetizationType: "RENT", retailPrice: "$3.99", package: { clearName: "Fandango at Home", technicalName: "vudu" }, deeplinkURL: "launch/13842?contentID=1" },
    { monetizationType: "BUY", retailPrice: "$9.99", package: { clearName: "Apple TV", technicalName: "itunes" } },
    { monetizationType: "FLATRATE", package: { clearName: "Starz Amazon Channel", technicalName: "amazonstarz" } },
    { monetizationType: "CINEMA", package: { clearName: "Cinema", technicalName: "c" } },
    { monetizationType: "FREE", package: { clearName: "", technicalName: "x" } },
    { monetizationType: "FLATRATE", package: { clearName: "Netflix", technicalName: "netflix" }, deeplinkURL: "launch/12?contentID=81&MediaType=series" },
  ];
  same("annotate_offers", catalog.annotateOffers, [[raw, APPS.filter((a) => a.type === "appl")], [[], []], [null, []]]);
  same("poster_url", catalog.posterUrl, [["/poster/123/{profile}/the-bear.{format}"], [null], [""]]);
});

test("rules helpers", () => {
  const base = rules.cleanRules({});
  same("rules_active", rules.rulesActive, [[base], [{ ...base, log: true }], [{ ...base, blocked: ["1"] }],
    [{ ...base, autopilot: { enabled: true, target: "" } }]]);
  same("in_window", (s, e, clock) => rules.inWindow(s, e, new Date(`2026-11-07T${clock}:00`)), [
    ["21:00", "06:30", "23:00"], ["21:00", "06:30", "06:30"], ["21:00", "06:30", "05:00"], ["21:00", "06:30", "12:00"],
    ["09:00", "17:00", "09:00"], ["09:00", "17:00", "17:00"], ["00:30", "06:00", "00:29"]]);
  // School nights (Sun-Thu): Thursday night runs into Friday morning; Friday and Saturday nights are free.
  const school = rules.cleanRules({ bedtime: { start: "21:00", end: "06:30", days: ["sun", "thu", "mon", "tue", "wed", "x"] } }).bedtime;
  assert.deepEqual(school.days, ["mon", "tue", "wed", "thu", "sun"]);
  const moments = ["2026-11-05 23:00", "2026-11-06 02:00", "2026-11-06 23:00", "2026-11-07 02:00", "2026-11-07 23:00",
    "2026-11-08 02:00", "2026-11-08 22:00", "2026-11-09 03:00", "2026-11-09 12:00", "2026-11-06 06:30"];
  const daytime = { start: "13:00", end: "15:00", days: ["sat"] };
  const cases = [...moments.map((m) => [school, m]), [daytime, "2026-11-07 14:00"], [daytime, "2026-11-08 14:00"], [{ start: "21:00", end: "06:30" }, "2026-11-06 23:00"]];
  // A start after midnight (or a morning window) belongs to the night before: 00:30 on school nights runs
  // early Monday to early Friday; a 07:00 "before school" window, Monday to Friday mornings.
  const late = { start: "00:30", end: "06:00", days: school.days };
  const morning = { start: "07:00", end: "08:00", days: school.days };
  cases.push([late, "2026-11-06 01:00"], [late, "2026-11-07 01:00"], [late, "2026-11-08 01:00"], [late, "2026-11-09 01:00"],
    [morning, "2026-11-09 07:30"], [morning, "2026-11-07 07:30"], [morning, "2026-11-06 07:30"]);
  same("bedtime_now", (rule, when) => rules.bedtimeNow(rule, new Date(when.replace(" ", "T") + ":00")), cases);
  assert.deepEqual(cases.slice(-7).map(([rule, when]) => rules.bedtimeNow(rule, new Date(when.replace(" ", "T") + ":00"))),
    [true, false, false, true, true, false, true]);
  same("next_bedtime_on", (rule, when) => rules.nextBedtimeOn(rule, new Date(when.replace(" ", "T") + ":00")), [
    [late, "2026-11-05 23:00"], [late, "2026-11-07 23:00"], [school, "2026-11-06 20:00"], [school, "2026-11-08 20:00"],
    [daytime, "2026-11-07 16:00"], [daytime, "2026-11-07 12:00"]]);
  assert.deepEqual(moments.map((m) => rules.bedtimeNow(school, new Date(m.replace(" ", "T") + ":00"))),
    [true, true, false, false, false, false, true, true, false, false]);
  same("is_home", rules.isHome, [[{ id: "", name: "Roku" }], [{ id: "562859", name: "Roku Dynamic Menu" }], [{ id: "12", name: "Netflix" }], [{ id: "x", name: " HOME " }]]);
  same("bounded_int", util.boundedInt, [["5", 1, 10], [5.9, 1, 10], [null, 1, 10], ["x", 1, 10], [99, 1, 10], [true, 0, 10], [" 7 ", 1, 10], ["-3", -5, 5], ["1_0", 1, 99]]);
});

const DEVICE = `<?xml version="1.0" encoding="UTF-8" ?>
<device-info>
\t<udn>abc</udn>
\t<serial-number>X00ABC</serial-number>
\t<vendor-name>TCL &amp; Co</vendor-name>
\t<model-number>55S405</model-number>
\t<friendly-model-name>TCL·Roku TV</friendly-model-name>
\t<is-tv>true</is-tv>
\t<user-device-name></user-device-name>
\t<friendly-device-name>Living Room</friendly-device-name>
\t<software-version>14.1.4</software-version>
\t<uptime>12345</uptime>
\t<power-mode>PowerOn</power-mode>
\t<ecp-setting-mode>default</ecp-setting-mode>
\t<country>US</country>
\t<supports-wake-on-wlan>true</supports-wake-on-wlan>
\t<empty/>
</device-info>`;
const APPS_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<apps>
\t<app id="tvinput.hdmi1" type="tvin" version="1.0.0">HDMI 1</app>
\t<app id="12" type="appl" version="5.1.2">Netflix</app>
\t<app id="41468" type="appl" version="2.0">Tubi - Free Movies &amp; TV</app>
\t<app id="dev" type="appl" version="1.0.1">Detox Home</app>
\t<app id="x" type="menu" version="1"/>
</apps>`;
const ACTIVE = `<?xml version="1.0" encoding="UTF-8" ?>
<active-app>
\t<app id="12" type="appl" version="5.1">Netflix</app>
\t<screensaver id="55545" type="ssvr">Default screensaver</screensaver>
</active-app>`;
const HOME = `<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n\t<app>Roku</app>\n</active-app>`;
const PLAYING = `<?xml version="1.0" encoding="UTF-8" ?>
<player error="false" state="play">
\t<plugin bandwidth="1000 bps" id="12" name="Netflix &amp; Chill"/>
\t<format audio="aac" captions="none" container="hls" drm="none" video="mpeg4_10b"/>
\t<buffering current="1000" max="1000" target="0"/>
\t<position>123456 ms</position>
\t<duration>3600000 ms</duration>
\t<is_live blocked="false">false</is_live>
</player>`;
const CLOSED = `<?xml version="1.0" encoding="UTF-8" ?>\n<player state="close" error="false" />\n`;

test("TV answers: device-info, apps, active-app, media-player, check", () => {
  const ok = (body) => [200, body, "text/xml"];
  const tv = (answers) => {
    const read = (p) => { const a = answers[p] || [404, "", ""]; ecp.check(a[0], a[1]); return a[1]; };
    return {
      device_info: () => ecp.parseDeviceInfo(read("query/device-info")),
      summarize: () => ecp.summarize({ host: "127.0.0.1", port: 9072 }, ecp.parseDeviceInfo(read("query/device-info"))),
      list_apps: () => ecp.parseApps(read("query/apps")),
      active_app: () => ecp.parseActiveApp(read("query/active-app")),
      now_playing: () => ({ ...ecp.parseMediaPlayer(read("query/media-player")), screen: ecp.parseActiveApp(read("query/active-app")) }),
    };
  };
  const cases = [
    { "query/device-info": ok(DEVICE), "query/apps": ok(APPS_XML), "query/active-app": ok(ACTIVE), "query/media-player": ok(PLAYING) },
    { "query/device-info": ok("<root><a>1</a></root>"), "query/apps": ok("<apps/>"), "query/active-app": ok(HOME), "query/media-player": ok(CLOSED) },
    { "query/device-info": ok("<html>oops"), "query/apps": [403, "ECP command not allowed in Limited mode.", "text/plain"],
      "query/active-app": ok("not xml"), "query/media-player": [500, "", ""] },
  ];
  for (const fn of ["device_info", "summarize", "list_apps", "active_app", "now_playing"]) {
    same(fn, (answers) => tv(answers)[fn](), cases.map((c) => [c]));
  }
  same("check", ecp.check, [[200, ""], [403, "ECP command not allowed in Limited mode."], [200, "Not Allowed"], [404, ""], [500, "x"], [401, ""]]);
});

test("bedtime nights hold across a clock change (run in New York and Berlin time)", () => {
  const script = `const r = await import(${JSON.stringify(new URL("../engine/rules.js", import.meta.url).href)});
const school = { start: "21:00", end: "06:30", days: ["mon", "tue", "wed", "thu", "sun"] };
const weekend = { start: "21:00", end: "06:30", days: ["fri", "sat"] };
const at = (s) => new Date(s);
console.log(JSON.stringify([r.bedtimeNow(school, at("2026-03-09T00:30:00")), r.bedtimeNow(weekend, at("2026-03-09T00:30:00")),
  r.bedtimeNow(school, at("2026-03-30T00:30:00")), r.bedtimeNow(school, at("2026-11-02T00:30:00"))]));`;
  for (const TZ of ["America/New_York", "Europe/Berlin"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, TZ } });
    // Sunday night into Monday morning is a school night; the weekend rule is off then.
    assert.deepEqual(JSON.parse(out), [true, false, true, true], TZ);
  }
});
