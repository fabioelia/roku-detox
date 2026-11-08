// A quick check of the Chrome extension in a real browser: loads extension/ into a headless Chrome
// with a fresh profile, points it at a pretend TV, and opens the page, the toolbar popup and the
// options page, checking what they show and failing on any page error. Run
// `python3 tools/build_extension.py` first if you changed index.html.
//
//   node tools/extension-smoke.mjs     (Chrome from /Applications, or set CHROME=/path/to/chrome)

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TV = "127.0.0.1:9094";
const DEBUG_PORT = 9394;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "roku-detox-ext-smoke-"));
const children = [];

function start(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "ignore" });
  children.push(child);
  return child;
}

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await check(); if (v) return v; } catch { /* not yet */ }
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** A DevTools connection to one target: evaluate expressions, and collect its errors. */
async function connect(wsUrl, problems, label) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") problems.push(`${label}: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`${label} console: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const my = ++id;
    ws.addEventListener("message", function on(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", on); resolve(m); } });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  await send("Runtime.enable");
  return {
    send,
    async eval(expression) {
      const out = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
      return out.result.value;
    },
    close: () => ws.close(),
  };
}

async function openPage(url, problems, label) {
  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  return connect(target.webSocketDebuggerUrl, problems, label);
}

async function main() {
  start("python3", ["mock_roku.py", "--port", TV.split(":")[1]]);
  start(CHROME, ["--headless=new", `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`,
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "about:blank"]);
  await until(async () => (await fetch(`http://${TV}/query/device-info`)).ok, 10000, "the pretend TV");
  const version = await until(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(), 15000, "Chrome");

  const problems = [];
  const browser = await connect(version.webSocketDebuggerUrl, problems, "browser");
  const loaded = await browser.send("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
  if (loaded.error) throw new Error(`Chrome wouldn't load the extension: ${loaded.error.message}`);
  const extId = loaded.result.id;
  const swTarget = await until(async () => (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json())
    .find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)), 10000, "the extension's worker");
  const sw = await connect(swTarget.webSocketDebuggerUrl, problems, "worker");

  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

  const setup = await sw.eval(`(async () => {
    await chrome.storage.local.set({ lastTv: "${TV}", discovered: [{ address: "${TV}", name: "Test TV (pretend)" }] });
    const m = chrome.runtime.getManifest();
    return { commands: (await chrome.commands.getAll()).filter((c) => c.shortcut).map((c) => c.name), omnibox: m.omnibox?.keyword, permissions: m.permissions };
  })()`);
  check("keyboard shortcuts are set", ["play-pause", "send-tab", "volume-up", "volume-down"].every((n) => setup.commands.includes(n)), setup.commands.join(","));
  check("the tv keyword is registered", setup.omnibox === "tv");
  check("needed permissions are asked for", ["scripting", "contextMenus", "tabs"].every((p) => setup.permissions.includes(p)));

  // The page, run by the extension.
  const pageSetup = await openPage(`chrome-extension://${extId}/options.html`, problems, "options");
  await wait(800);
  const options = await pageSetup.eval(`({ heading: document.querySelector("#tv-heading")?.textContent, shortcuts: document.querySelectorAll("#shortcut-list li").length })`);
  check("options page lists the shortcuts", options.shortcuts >= 4, JSON.stringify(options));
  await pageSetup.eval(`localStorage.setItem("detox.tv", JSON.stringify("${TV}")); localStorage.setItem("detox.view", JSON.stringify("remote")); 1`);
  pageSetup.close();

  const app = await openPage(`chrome-extension://${extId}/app/index.html`, problems, "page");
  await wait(3500);
  const state = await app.eval(`({ engine: state.engine?.kind, reachable: state.reachable, control: state.control, apps: state.apps.length, tips: !document.querySelector("#tips").hidden })`);
  check("the page uses the extension and reaches the TV", state.engine === "extension" && state.reachable && state.control && state.apps > 5, JSON.stringify(state));
  check("the tips card shows the first time", state.tips);
  const usage = await app.eval(`(async () => { document.querySelector('#views [data-view="cleanup"]').click(); await new Promise((r) => setTimeout(r, 800)); return document.querySelector("#channels").hidden === false; })()`);
  check("Clean up shows the channels", usage);
  const phrase = await app.eval(`api("/api/do", { tv: state.tv, do: "hdmi 2" }).then((r) => r.done)`);
  check("phrases work through the extension", phrase === "Opening Xbox.", phrase);
  app.close();

  // The toolbar popup, opened as a page.
  const popup = await openPage(`chrome-extension://${extId}/popup.html`, problems, "popup");
  await wait(2000);
  const pop = await popup.eval(`({ now: document.querySelector("#now").textContent, keys: [...document.querySelectorAll("#keys button")].filter((b) => !b.disabled).length,
    launchers: [...document.querySelectorAll("#launch button")].map((b) => b.textContent) })`);
  check("the popup shows what's on the TV", /^On the TV:/.test(pop.now), pop.now);
  check("the popup's remote is ready", pop.keys === 9, String(pop.keys));
  check("the popup offers the sleep timer", pop.launchers.some((t) => /Sleep/.test(t)), pop.launchers.join(" | "));
  popup.close();

  // The address bar's suggestions and a right-click, run inside the worker.
  const shortcuts = await sw.eval(`(async () => {
    const xml = await (await fetch("http://${TV}/query/active-app")).text();
    return { before: /id="([^"]*)"/.exec(xml)?.[1] };
  })()`);
  check("the worker can reach the TV", typeof shortcuts.before === "string");

  sw.close();
  browser.close();
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok || !c.detail ? "" : `  (${c.detail})`}`);
  }
  for (const p of problems) console.log(`FAIL ${p}`);
  failed += problems.length;
  console.log(failed ? `\n${failed} problem(s).` : `\nAll ${checks.length} checks passed, no page errors.`);
  return failed;
}

let code = 1;
try {
  code = (await main()) ? 1 : 0;
} catch (err) {
  console.error(`Extension smoke test couldn't run: ${err.message}`);
} finally {
  for (const child of children) child.kill();
  await wait(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* fine */ }
}
process.exit(code);
