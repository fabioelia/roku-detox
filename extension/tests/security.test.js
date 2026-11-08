// What callers from outside the extension's own pages may do, and links that would reach the home network.
// Uses the pretend TV (python3 mock_roku.py --port 9072).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installFakeChrome } from "./fake-chrome.js";

installFakeChrome();
const { handleMessage } = await import("../engine/router.js");
const { isLocalHost } = await import("../engine/video.js");
const { parseTarget } = await import("../engine/util.js");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TV = "127.0.0.1:9072";

test("web pages can't add sites or open pages in hidden tabs, even when allowed", async () => {
  const web = (method, path, body) => handleMessage({ type: "api", method, path, query: {}, body }, { internal: false, web: true });
  assert.equal((await web("POST", "/api/sites", { sites: [{ name: "x", url: "https://example.com/?q={q}", deep: true }] })).status, 403);
  assert.equal((await web("POST", "/api/sites/look", { siteId: "x", q: "a" })).status, 403);
  assert.equal((await web("GET", "/api/sites/search?q=a")).status, 403);
  assert.equal((await web("GET", "/api/sites")).status, 200, "listing them is fine");
});

test("links from a phone or a web page can't reach this computer or the home network", async () => {
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.9", "172.20.1.1", "169.254.1.1", "printer", "nas.local", "[::1]", "fd00::1"]) {
    assert.equal(isLocalHost(host), true, host);
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "www.youtube.com"]) assert.equal(isLocalHost(host), false, host);
  const relay = await handleMessage({ type: "api", method: "POST", path: "/api/link", query: {}, body: { tv: TV, url: "http://192.168.1.9/admin" } }, { internal: false });
  assert.equal(relay.status, 400);
  assert.match(relay.data.error, /home network/);
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
print("opened" if rd.fetch_page("http://127.0.0.1:9072/query/device-info")[1] else "nothing")`;
  const lines = execFileSync("python3", ["-c", code], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(lines.slice(0, 3), Array(3).fill("Links to addresses on your home network can only be sent from this computer."));
  assert.equal(lines[3], "opened", "from the Mac itself, local addresses still work");
});
