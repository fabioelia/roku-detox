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
  "search for cafe", "Run Lola Run", "sleep timer 20", "netflix", "pause rules", "resume rules"];

function python(phrases, strict = false) {
  const code = `import json, sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd, tempfile, os
d = tempfile.mkdtemp(); rd.SETTINGS_PATH = os.path.join(d, "s.json"); rd.ACTIVITY_PATH = os.path.join(d, "a.json")
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
