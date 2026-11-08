// The catalog against JustWatch (live), compared field by field with roku_detox.py's answers
// for the same pretend TV (python3 mock_roku.py --port 9072). Needs the internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const { handleMessage } = await import("../engine/router.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TV = "127.0.0.1:9072";

function python(expr) {
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd; t = ("127.0.0.1", 9072)
try:
    print(json.dumps({"status": 200, "data": ${expr}}))
except rd.TVError as err:
    print(json.dumps({"status": 502, "data": {"error": str(err)}}))
except ValueError as err:
    print(json.dumps({"status": 400, "data": {"error": str(err)}}))`;
  return JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf-8", maxBuffer: 1 << 26 }));
}

const get = (p, query) => handleMessage({ type: "api", method: "GET", path: p, query }, { internal: true });

/** Every key path in a JSON value, like "results[].offers[].appId", so shapes can be compared too. */
function shape(value, prefix = "", out = new Set()) {
  if (Array.isArray(value)) for (const item of value) shape(item, `${prefix}[]`, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(`${prefix}.${k}`); shape(v, `${prefix}.${k}`, out); }
  return out;
}

let showId = null;
let seasonId = null;

test("/api/find answers exactly like find_titles(('127.0.0.1', 9072), 'The Bear')", async () => {
  const js = await get("/api/find", { tv: TV, q: "The Bear" });
  const py = python('rd.find_titles(t, "The Bear")');
  assert.equal(js.status, 200, JSON.stringify(js.data));
  assert.equal(py.status, 200);
  assert.ok(js.data.results.length > 0, "JustWatch found nothing");
  assert.deepEqual([...shape(js.data)].sort(), [...shape(py.data)].sort(), "field names differ");
  assert.deepEqual(js.data, py.data);
  const bear = js.data.results.find((r) => r.type === "Show" && /bear/i.test(r.title));
  assert.ok(bear, "no show called The Bear");
  showId = bear.id;
  console.log(`  ${js.data.results.length} results, ${js.data.results.reduce((n, r) => n + r.offers.length, 0)} offers, country ${js.data.country}; fields: ${[...shape(js.data)].sort().join(" ")}`);
});

test("/api/find/show, /season and /next match the Python answers", async () => {
  assert.ok(showId);
  const show = await get("/api/find/show", { tv: TV, id: showId });
  assert.deepEqual(show, python(`rd.find_show(t, ${JSON.stringify(showId)})`));
  assert.ok(show.data.seasons.length > 0);
  seasonId = show.data.seasons[0].id;
  const season = await get("/api/find/season", { tv: TV, id: seasonId });
  assert.deepEqual(season, python(`rd.find_season(t, ${JSON.stringify(seasonId)})`));
  assert.ok(season.data.episodes.length > 0);
  const last = season.data.episodes[season.data.episodes.length - 1].number;
  for (const episode of [1, last]) {
    const next = await get("/api/find/next", { tv: TV, show: showId, season: seasonId, episode: String(episode) });
    assert.deepEqual(next, python(`rd.find_next(t, ${JSON.stringify(showId)}, ${JSON.stringify(seasonId)}, ${episode})`));
  }
});

test("catalog errors match", async () => {
  assert.deepEqual(await get("/api/find", { tv: TV, q: "" }), { status: 400, data: { error: "Type a show or movie name." } });
  assert.deepEqual(await get("/api/find/show", { tv: TV, id: "nope" }), { status: 400, data: { error: "Bad show id." } });
  assert.deepEqual(await get("/api/find/next", { tv: TV, show: "ts1", season: "tss1", episode: "x" }), { status: 400, data: { error: "Bad episode number." } });
  assert.deepEqual(await get("/api/find/show", { tv: TV, id: "ts999999999999" }), python('rd.find_show(t, "ts999999999999")'));
  if (seasonId) { // a season's id where a show's is expected
    assert.deepEqual(await get("/api/find/show", { tv: TV, id: seasonId }), python(`rd.find_show(t, ${JSON.stringify(seasonId)})`));
  }
});
