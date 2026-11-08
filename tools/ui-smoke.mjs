// A quick check of the page in a real browser: starts a pretend TV and a throwaway copy of the
// program, opens every menu in headless Chrome, clicks the things that broke before, and fails on
// any page error. Nothing touches your settings, your real TV or your network (finding TVs is faked).
//
//   node tools/ui-smoke.mjs            (Chrome from /Applications, or set CHROME=/path/to/chrome)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TV_PORT = 9093;
const PAGE_PORT = 8693;
const DEBUG_PORT = 9393;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const data = mkdtempSync(join(tmpdir(), "roku-detox-smoke-"));
const children = [];

function start(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: "ignore" });
  child.on("error", (err) => console.error(`Couldn't start ${cmd}: ${err.message}`));
  children.push(child);
  return child;
}

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await check()) return; } catch { /* not yet */ }
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`Chrome isn't at ${CHROME}. Set CHROME=/path/to/chrome.`);
  start("python3", ["mock_roku.py", "--port", String(TV_PORT)]);
  start("python3", ["roku_detox.py", "--no-browser", "--port", String(PAGE_PORT), "--data", data]);
  start(CHROME, ["--headless=new", `--user-data-dir=${join(data, "chrome")}`, `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"]);
  await until(async () => (await fetch(`http://127.0.0.1:${TV_PORT}/query/device-info`)).ok, 10000, "the pretend TV");
  await until(async () => (await fetch(`http://127.0.0.1:${PAGE_PORT}/`)).ok, 10000, "the program");
  await until(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok, 15000, "Chrome");

  const target = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const problems = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") problems.push(`Page error: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`Console error: ${m.params.args.map((a) => a.value ?? a.description).join(" ")}`);
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const my = ++id;
    ws.addEventListener("message", function on(ev) { const m = JSON.parse(ev.data); if (m.id === my) { ws.removeEventListener("message", on); resolve(m.result); } });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  const page = async (expression) => {
    const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  // Finding TVs would ask the real network; the page gets an empty answer instead.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `{
    const real = window.fetch.bind(window);
    window.fetch = (url, init) => String(url).includes("/api/discover")
      ? Promise.resolve(new Response(JSON.stringify({ tvs: [] }), { headers: { "Content-Type": "application/json" } }))
      : real(url, init);
  }` });
  const url = `http://localhost:${PAGE_PORT}/`;
  await send("Page.navigate", { url });
  await wait(800);
  await page(`localStorage.setItem("detox.tv", JSON.stringify("127.0.0.1:${TV_PORT}")); localStorage.setItem("detox.view", JSON.stringify("remote")); location.reload(); 1`);
  await wait(2500);

  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });

  const connected = await page(`({ reachable: state.reachable, control: state.control, apps: state.apps.length, compact: document.querySelector("#picker").dataset.compact })`);
  check("connects to the pretend TV", connected.reachable && connected.control && connected.apps > 5, JSON.stringify(connected));
  check("the TV picker folds away once connected", connected.compact === "true");

  for (const view of ["find", "rules", "cleanup", "tvapp", "phone", "remote"]) {
    const shown = await page(`(async () => { document.querySelector('#views [data-view="${view}"]').click(); await new Promise((r) => setTimeout(r, 500));
      const v = document.querySelector('.view[data-view="${view}"]'); return v && !v.hidden && v.innerText.trim().length > 20; })()`);
    check(`the ${view} menu shows`, shown);
  }

  // Episode pickers keep their own open/closed map (a name clash once broke them).
  check("episode pickers' state is a map", await page(`typeof state.pickerOpen === "object" && state.pickerOpen !== null`));
  check("Switch TV toggles", await page(`(() => { const t = document.querySelector("#picker-toggle"); t.click(); const open = document.querySelector("#picker").dataset.compact === "false"; t.click(); return open && document.querySelector("#picker").dataset.compact === "true"; })()`));

  // Remote: a click sends one press; holding repeats; keyboard keys work.
  const presses = await page(`(async () => {
    const sent = []; const real = api;
    api = (path, body) => { if (path === "/api/key") sent.push(body.key); return real(path, body); };
    document.querySelector('#remote [data-key="Home"]').click();
    const up = document.querySelector('#remote [data-key="VolumeUp"]');
    const o = { bubbles: true, button: 0, pointerId: 1 };
    up.dispatchEvent(new PointerEvent("pointerdown", o)); await new Promise((r) => setTimeout(r, 900));
    up.dispatchEvent(new PointerEvent("pointerup", o)); up.click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    await new Promise((r) => setTimeout(r, 600)); api = real; return sent; })()`);
  check("a click sends one press", presses[0] === "Home", presses.join(","));
  check("holding a button repeats it", presses.filter((k) => k === "VolumeUp").length >= 2, presses.join(","));
  check("M mutes", presses.at(-1) === "VolumeMute", presses.join(","));
  const typed = await page(`(async () => {
    const sent = []; const real = api;
    api = (path, body) => { if (path === "/api/key") sent.push(body.key); return real(path, body); };
    document.querySelector("#smart-live").click();
    const input = document.querySelector("#smart-input");
    for (const v of ["h", "hi", "h", "ha"]) { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 800)); api = real; document.querySelector("#smart-live").click(); return sent.join(","); })()`);
  check("live typing sends letters and Backspace", typed === "Lit_h,Lit_i,Backspace,Lit_a", typed);
  const quoted = await page(`(async () => {
    const sent = []; const real = api;
    api = (path, body) => { if (path === "/api/key") sent.push(body.key); return Promise.resolve({ ok: true }); };
    document.querySelector("#smart-live").click();
    const input = document.querySelector("#smart-input");
    for (const v of ['a', 'a"', 'a"b']) { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); }
    await new Promise((r) => setTimeout(r, 400)); api = real; document.querySelector("#smart-live").click(); return sent.join(" "); })()`);
  check("live typing sends quotes too", quoted === 'Lit_a Lit_" Lit_b', quoted);

  // Phrases in the search box, the sleep timer, favorites suggestions.
  const phrase = await page(`(async () => { const r = await api("/api/do", { tv: state.tv, do: "open netflix" }); return r.done; })()`);
  check("phrases: open netflix", phrase === "Opening Netflix.", phrase);
  const sleep = await page(`(async () => { document.querySelector('#sleep-chips [data-sleep="30"]').click(); await new Promise((r) => setTimeout(r, 700));
    const shown = document.querySelector("#sleep-status").textContent; document.querySelector("#sleep-cancel").click(); await new Promise((r) => setTimeout(r, 500));
    return { shown, after: document.querySelector("#sleep-status").textContent }; })()`);
  check("sleep timer sets and cancels", /off at/.test(sleep.shown) && sleep.after === "", JSON.stringify(sleep));
  check("favorites are suggested", await page(`document.querySelectorAll("[data-fav-add]").length > 0`));

  // Narrow screen: the remote leads on Remote, follows on other menus.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const order = await page(`(async () => { const top = (el) => el.getBoundingClientRect().top + scrollY;
    const onRemote = top(document.querySelector(".side")) < top(document.querySelector("main"));
    document.querySelector('#views [data-view="find"]').click(); await new Promise((r) => setTimeout(r, 300));
    const onFind = top(document.querySelector(".side")) > top(document.querySelector("main"));
    document.querySelector('#views [data-view="remote"]').click(); return onRemote && onFind; })()`);
  check("on phones the remote leads only on Remote", order);
  const remoteOnly = await page(`(() => { document.querySelector("#remote-only").click();
    const on = getComputedStyle(document.querySelector("main")).display === "none" && getComputedStyle(document.querySelector("#remote")).display !== "none";
    document.querySelector("#remote-only-exit").click();
    return on && getComputedStyle(document.querySelector("main")).display !== "none"; })()`);
  check("Just the remote hides the rest and comes back", remoteOnly);

  // A home-screen link: shows "Doing … in 2 seconds", then does it; Cancel stops it.
  const doLink = await page(`(async () => {
    location.hash = "do=open%20netflix"; await new Promise((r) => setTimeout(r, 300));
    const banner = !document.querySelector("#do-banner").hidden;
    await new Promise((r) => setTimeout(r, 2800));
    const opened = document.querySelector("#toast").textContent;
    location.hash = "do=off"; await new Promise((r) => setTimeout(r, 300)); document.querySelector("#do-cancel").click();
    await new Promise((r) => setTimeout(r, 2300));
    const dev = await api("/api/device?tv=" + encodeURIComponent(state.tv));
    return { banner, opened, power: dev.device.powerMode }; })()`);
  check("a #do= link waits, then does it", doLink.banner && doLink.opened === "Opening Netflix.", JSON.stringify(doLink));
  check("Cancel stops a #do= link", doLink.power === "PowerOn", JSON.stringify(doLink));

  // The send-only page (phones without the program): every menu opens without errors, and the
  // things it can't do stay out of the way.
  await send("Emulation.clearDeviceMetricsOverride");
  await send("Page.navigate", { url: `${url}?engine=lite` });
  await wait(2500);
  const lite = await page(`(async () => {
    const out = { engine: state.engine?.kind, menus: [] };
    for (const view of ["find", "rules", "cleanup", "remote"]) {
      const btn = document.querySelector('#views [data-view="' + view + '"]');
      if (btn && !btn.hidden) { btn.click(); await new Promise((r) => setTimeout(r, 300)); out.menus.push(view); }
    }
    out.sleepHidden = getComputedStyle(document.querySelector("#sleep")).display === "none";
    out.tvAppHidden = document.querySelector('#views [data-view="tvapp"]').hidden;
    out.winddown = Boolean(document.querySelector('[data-template="winddown"]'));
    return out; })()`);
  check("the lite page loads as lite", lite.engine === "lite", JSON.stringify(lite));
  check("lite hides what it can't do", lite.sleepHidden && lite.tvAppHidden && !lite.winddown, JSON.stringify(lite));

  ws.close();
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
  console.error(`Smoke test couldn't run: ${err.message}`);
} finally {
  for (const child of children) child.kill();
  await wait(300);
  try { rmSync(data, { recursive: true, force: true }); } catch { /* fine */ }
}
process.exit(code);
