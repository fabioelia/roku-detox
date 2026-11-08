// Installing and updating Detox Home from the extension, through the pretend TV's developer installer
// (python3 mock_roku.py --port 9072; its developer password is "testpass").
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { installFakeChrome } from "./fake-chrome.js";

const chrome = installFakeChrome();
const ZIP = readFileSync(fileURLToPath(new URL("../app/detox-home.zip", import.meta.url)));
chrome.runtime.getURL = (path) => (path === "app/detox-home.zip" ? `data:application/zip;base64,${ZIP.toString("base64")}` : `chrome-extension://x/${path}`);
const { md5, digestHeader } = await import("../engine/installer.js");
const { handleMessage } = await import("../engine/router.js");
const TV = "127.0.0.1:9072";
const call = (path, body, internal = true) => handleMessage({ type: "api", method: "POST", path, query: {}, body }, { internal });
const status = async () => (await handleMessage({ type: "api", method: "GET", path: "/api/tvapp", query: { tv: TV } }, { internal: true })).data;

test("MD5 and the digest answer match what the TV expects", () => {
  for (const text of ["", "rokudev:rokudev:testpass", "POST:/plugin_install", "ü€😀".repeat(30), "x".repeat(200)]) {
    assert.equal(md5(text), createHash("md5").update(text, "utf8").digest("hex"), text.slice(0, 20));
  }
  const header = digestHeader('Digest realm="rokudev", nonce="abc123", qop="auth"', "POST", "/plugin_install", "rokudev", "testpass", "c1");
  const ha1 = md5("rokudev:rokudev:testpass");
  const ha2 = md5("POST:/plugin_install");
  assert.ok(header.includes(`response="${md5(`${ha1}:abc123:00000001:c1:auth:${ha2}`)}"`), header);
});

test("the extension installs, updates and removes Detox Home itself (no installer page)", async () => {
  const wrong = await call("/api/tvapp/install", { tv: TV, password: "nope" });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /didn't accept that password/);
  assert.equal((await status()).canInstall, true);
  const installed = await call("/api/tvapp/install", { tv: TV, password: "testpass" });
  assert.equal(installed.status, 200, JSON.stringify(installed.data));
  assert.equal(installed.data.installed, true);
  assert.equal(installed.data.outdated, false, "the copy in the extension runs on its own");
  const again = await call("/api/tvapp/install", { tv: TV, password: "testpass" });
  assert.equal(again.status, 200, "installing again updates it");
  // Phones (the relay) and web pages can't install.
  assert.equal((await call("/api/tvapp/install", { tv: "127.0.0.1", password: "testpass" }, false)).status, 501);
  const removed = await call("/api/tvapp/remove", { tv: TV, password: "testpass" });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(removed.data.installed, false);
});
