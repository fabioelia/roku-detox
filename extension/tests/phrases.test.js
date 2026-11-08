// Phrases ("open Netflix", "HDMI 2", "sleep 30"): the extension answers exactly like do_phrase() in
// roku_detox.py, against the pretend TV (python3 mock_roku.py --port 9072).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const { foldWords } = await import("../engine/phrases.js");
const TV = "127.0.0.1:9072";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PHRASES = ["pause", "Open Netflix", "hdmi 2", "volume up 3", "sleep 30", "cancel sleep", "home",
  "open zzzz", "YouTube", "watch the roku channel", "louder", "  ", "Pokémon", "It", "tv", "a", "Us",
  "search for cafe", "Run Lola Run", "sleep timer 20", "netflix", "What's on?", "What’s playing on the TV right now", "Where's Waldo?", "https://youtu.be/dQw4w9WgXcQ", "pause rules", "resume rules",
  "screen time", "time left", "how much time is left today", "15 more minutes", "give me more time please"];

function python(phrases, strict = false) {
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd, tempfile, os
d = tempfile.mkdtemp(); rd.SETTINGS_PATH = os.path.join(d, "s.json"); rd.ACTIVITY_PATH = os.path.join(d, "a.json"); rd.USAGE_PATH = os.path.join(d, "u.json")
rd.search = lambda target, words: None
out = []
for p in json.loads(sys.argv[1]):
    try: out.append({"done": rd.do_phrase(("127.0.0.1", 9072), p, strict=json.loads(sys.argv[2]))})
    except Exception as err: out.append({"error": str(err)})
rd.set_sleep(("127.0.0.1", 9072), 0)
print(json.dumps(out))`;
  return JSON.parse(execFileSync("python3", ["-c", code, JSON.stringify(phrases), JSON.stringify(strict)], { encoding: "utf8" }));
}

test("folding words", () => {
  assert.equal(foldWords("Pokémon TV!"), "pokemon tv");
  assert.equal(foldWords("  Open   Café+ "), "open cafe+");
});

for (const strict of [false, true]) {
  test(`phrases answer like the program's (${strict ? "search box" : "Siri"})`, async () => {
    const expected = python(PHRASES, strict);
    for (const [i, phrase] of PHRASES.entries()) {
      const reply = await handleMessage({ type: "api", method: "POST", path: "/api/do", query: {}, body: { tv: TV, do: phrase, strict } }, { internal: true });
      const got = reply.status === 200 ? { done: reply.data.done } : { error: reply.data.error };
      assert.deepEqual(got, expected[i], `${phrase} (strict: ${strict})`);
    }
    await handleMessage({ type: "api", method: "POST", path: "/api/sleep", query: {}, body: { tv: TV, minutes: 0 } }, { internal: true });
  });
}

test("the search box only acts on clear commands", async () => {
  const say = async (text) => (await handleMessage({ type: "api", method: "POST", path: "/api/do", query: {}, body: { tv: TV, do: text, strict: true } }, { internal: true })).data.done;
  assert.equal(await say("It"), "Searching the TV for It.");
  assert.equal(await say("Home"), "Searching the TV for Home.");
  assert.equal(await say("Run Lola Run"), "Searching the TV for lola run.");
  assert.equal(await say("netflix"), "Opening Netflix.");
  assert.equal(await say("search for Bluey"), "Searching the TV for bluey.");
});

test("durations and clock times are said the same way", async () => {
  const { sayDuration, sayClock } = await import("../engine/phrases.js");
  const seconds = [0, 59, 60, 61, 119, 120, 3599, 3600, 3660, 7260, 7320.9];
  const clocks = ["00:00", "00:30", "06:30", "12:00", "12:05", "21:00", "23:59"];
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd
print(json.dumps([[rd.say_duration(s) for s in json.loads(sys.argv[1])], [rd.say_clock(c) for c in json.loads(sys.argv[2])]]))`;
  const [durations, times] = JSON.parse(execFileSync("python3", ["-c", code, JSON.stringify(seconds), JSON.stringify(clocks)], { encoding: "utf8" }));
  assert.deepEqual(seconds.map(sayDuration), durations);
  assert.deepEqual(clocks.map(sayClock), times);
  assert.equal(sayDuration(3660), "1 hour 1 minute");
  assert.equal(sayClock("21:00"), "9 PM");
  assert.equal(sayClock("06:30"), "6:30 AM");
});

test("screen time and time left read today's viewing log and limits, like the program", async () => {
  const rules = await import("../engine/rules.js");
  rules.watcherOptions.startOnSave = false;   // no rounds against the pretend TV here
  const { localDay } = await import("../engine/util.js");
  const day = localDay();
  const usage = { "12": 1500, "837": 400, home: 900 };
  const soon = new Date(Date.now() + 2 * 3600 * 1000);   // bedtime in two hours, so it isn't now
  const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const setup = { totalLimit: 45, limits: { "12": 30, "837": 5 }, bedtime: { enabled: true, start: hhmm(soon), end: hhmm(new Date(soon.getTime() + 60000)) } };
  await globalThis.chrome.storage.local.set({ usage: { [TV]: { [day]: usage } } });
  await handleMessage({ type: "api", method: "POST", path: "/api/rules", query: {}, body: { tv: TV, rules: setup } }, { internal: true });
  const asked = ["screen time", "time left"];
  const got = [];
  for (const phrase of asked) got.push((await handleMessage({ type: "api", method: "POST", path: "/api/do", query: {}, body: { tv: TV, do: phrase } }, { internal: true })).data.done);

  const code = `import json, sys, tempfile, os; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd
d = tempfile.mkdtemp(); rd.SETTINGS_PATH = os.path.join(d, "s.json"); rd.ACTIVITY_PATH = os.path.join(d, "a.json"); rd.USAGE_PATH = os.path.join(d, "u.json")
json.dump({"${TV}": {"${day}": json.loads(sys.argv[1])}}, open(rd.USAGE_PATH, "w"))
rd.save_rules("${TV}", rd.clean_rules(json.loads(sys.argv[2])))
print(json.dumps([rd.do_phrase(("127.0.0.1", 9072), p) for p in json.loads(sys.argv[3])]))`;
  const expected = JSON.parse(execFileSync("python3", ["-c", code, JSON.stringify(usage), JSON.stringify(setup), JSON.stringify(asked)], { encoding: "utf8" }));
  assert.deepEqual(got, expected);
  assert.equal(got[0], "31 minutes of TV today. The most: Netflix, 25 minutes.");
  assert.equal(got[1], `All TV together: 13 minutes left. Netflix: 5 minutes left. YouTube: time's up for today. Bedtime is at ${(await import("../engine/phrases.js")).sayClock(setup.bedtime.start)}.`);
  await handleMessage({ type: "api", method: "POST", path: "/api/rules", query: {}, body: { tv: TV, rules: {} } }, { internal: true });
});

test("links play only for a Shortcuts key, and only YouTube and Netflix (nothing is fetched)", async () => {
  const { doPhrase } = await import("../engine/phrases.js");
  const { parseTarget } = await import("../engine/util.js");
  const links = ["https://youtu.be/dQw4w9WgXcQ", "https://www.netflix.com/title/80057281", "http://127.0.0.1:9072/query/device-info", "https://example.com/video"];
  const code = `import json, sys, tempfile, os; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd
d = tempfile.mkdtemp(); rd.SETTINGS_PATH = os.path.join(d, "s.json"); rd.USAGE_PATH = os.path.join(d, "u.json")
rd.fetch_page = rd.find_video = None   # a key must never make it load a page
out = []
for p in json.loads(sys.argv[1]):
    for links in (True, False):
        try: out.append({"done": rd.do_phrase(("127.0.0.1", 9072), p, links=links)})
        except Exception as err: out.append({"error": str(err)})
print(json.dumps(out))`;
  const expected = JSON.parse(execFileSync("python3", ["-c", code, JSON.stringify(links)], { encoding: "utf8" }));
  const got = [];
  for (const p of links) {
    for (const withLinks of [true, false]) {
      try { got.push({ done: await doPhrase(parseTarget(TV), p, { links: withLinks }) }); } catch (err) { got.push({ error: err.message }); }
    }
  }
  assert.deepEqual(got, expected);
  assert.equal(got[0].done, "Playing it on the TV in YouTube.");
  assert.match(got[1].error, /That's a link/);
  assert.match(got[4].error, /YouTube and Netflix/);
});
