// What callers from outside the extension's own pages may do, and links that would reach the home network.
// Uses the pretend TV (python3 mock_roku.py --port 9072).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const { findVideo, isLocalHost } = await import("../engine/video.js");
const { parseTarget } = await import("../engine/util.js");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TV = "127.0.0.1:9072";

test("web pages and relay phones can't add or search sites, or open pages in hidden tabs", async () => {
  for (const opts of [{ internal: false, web: true }, { internal: false }]) {
    const call = (method, path, body) => handleMessage({ type: "api", method, path, query: {}, body }, opts);
    assert.equal((await call("POST", "/api/sites", { sites: [{ name: "x", url: "https://example.com/?q={q}", deep: true }] })).status, 403);
    assert.equal((await call("POST", "/api/sites/look", { siteId: "x", q: "a" })).status, 403);
    assert.equal((await call("GET", "/api/sites/search?q=a")).status, 403);
    assert.equal((await call("GET", "/api/sites")).status, 200, "listing them is fine");
  }
});

test("links from a phone or a web page can't reach this computer or the home network", async () => {
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.9", "172.20.1.1", "169.254.1.1", "printer", "nas.local", "[::1]", "fd00::1"]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "www.youtube.com"]) assert.equal(isLocalHost(host), false, host);
  // From outside, the browser opens no pages at all (it can't see where a name or a redirect leads).
  await assert.rejects(findVideo("http://192.168.1.9/admin", null, [], { publicOnly: true }), /home network/);
  await assert.rejects(findVideo("http://127.0.0.1.nip.io/x", null, [], { publicOnly: true }), /YouTube or Netflix links, or a direct link/);
  await assert.rejects(findVideo("https://example.com/v.mp4", "http://10.0.0.2/v.mp4", [], { publicOnly: true }), /home network/);
  const direct = await findVideo("https://cdn.example.com/v.mp4", null, [], { publicOnly: true });
  assert.equal(direct.how, "a direct video link", "a video file on the internet is handed to the TV, not opened here");
  // Icons too: the pretend TV's port is for this computer's own pages only.
  const icon = await handleMessage({ type: "icon", tv: "127.0.0.1:9072", id: "12" }, { internal: false });
  assert.equal(icon.dataUrl, null);
  assert.match(icon.error || "", /8060/);
  // And the pretend TV's port is for this computer's own pages only.
  const relay = await handleMessage({ type: "api", method: "POST", path: "/api/key", query: {}, body: { tv: TV, key: "Home" } }, { internal: false });
  assert.equal(relay.status, 400);
  assert.match(relay.data.error, /8060/);
});

test("rules can't be paused or resumed from a #do= link, however it's written", async () => {
  const { doPhrase } = await import("../engine/phrases.js");
  for (const p of ["pause rules", "Pause rules.", "pause-rules", "Páuse, RULES", "rules off?", "resume rules"]) {
    await assert.rejects(doPhrase(parseTarget(TV), p, { fromLink: true }), /from a link/, p);
  }
  const code = `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd
for p in ["pause rules", "Pause rules.", "pause-rules", "Páuse, RULES", "rules off?", "resume rules"]:
    try: rd.do_phrase(("127.0.0.1", 9072), p, from_link=True); print("ran")
    except ValueError as err: print(err)`;
  const lines = execFileSync("python3", ["-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(lines, Array(6).fill("Rules can't be paused or resumed from a link. Use the Rules menu."));
});

test("TV addresses on the home network use Roku's port", () => {
  assert.throws(() => parseTarget("192.168.1.20:9072"), /8060/);
  assert.deepEqual(parseTarget("192.168.1.20"), { host: "192.168.1.20", port: 8060 });
  assert.deepEqual(parseTarget("127.0.0.1:9072"), { host: "127.0.0.1", port: 9072 });
});

test("the program won't open home-network addresses for links from other devices", () => {
  const code = `import sys; sys.path.insert(0, ${JSON.stringify(ROOT)}); import roku_detox as rd
out = []
for url in ["http://127.0.0.1:9072/query/device-info", "http://localhost:9072/", "http://192.168.1.9/"]:
    try: rd.fetch_page(url, public_only=True); out.append("opened")
    except ValueError as err: out.append(str(err))
print(out[0]); print(out[1]); print(out[2])
print("opened" if rd.fetch_page("http://127.0.0.1:9072/query/device-info")[1] else "nothing")
# A name that looked public but connects to a local address (DNS tricks, redirects): stopped at the connection.
rd.is_public_host = lambda host: True
try: rd.fetch_page("http://127.0.0.1:9072/query/device-info", public_only=True); print("opened")
except rd.TVError: print("stopped")
try: rd.fetch_page("http://localhost:9072/query/device-info", public_only=True); print("opened")
except rd.TVError: print("stopped")
# Redirects only to http and https.
import urllib.request
try: rd.PublicRedirects().redirect_request(urllib.request.Request("https://example.com/"), None, 302, "Found", {}, "ftp://example.com/"); print("followed")
except ValueError: print("refused")`;
  const lines = execFileSync("python3", ["-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(lines.slice(0, 3), Array(3).fill("Links to addresses on your home network can only be sent from this computer."));
  assert.equal(lines[3], "opened", "from the Mac itself, local addresses still work");
  assert.equal(lines[4], "stopped");
  assert.equal(lines[5], "stopped");
  assert.equal(lines[6], "refused");
});
