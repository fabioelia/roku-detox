// Toolbar popup: send the current tab's video to the TV, or open the full page.

const $ = (selector) => document.querySelector(selector);
const FORMAT_NAMES = { hls: "HLS stream", mp4: "Video file", dash: "DASH stream" };

let tab = null;
let tv = null;
let videos = [];

function setStatus(text, state = "") {
  $("#status").textContent = text;
  $("#status").dataset.state = state;
}

async function message(msg) {
  const reply = await chrome.runtime.sendMessage(msg);
  if (reply === undefined) throw new Error("The extension didn't answer. Try again.");
  return reply;
}

async function api(method, path, { query = null, body = null } = {}) {
  const reply = await message({ type: "api", method, path, query, body });
  if (reply.status !== 200) throw new Error(reply.data?.error || `Something went wrong (${reply.status}).`);
  return reply.data;
}

function host(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function sizeText(bytes) {
  if (!bytes) return "";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function describe(video) {
  return [FORMAT_NAMES[video.format] || "Video", host(video.url), sizeText(video.size)].filter(Boolean).join(" · ");
}

function appFor(url) {
  const name = host(url).replace(/^m\./, "");
  if (["youtube.com", "youtu.be", "music.youtube.com"].includes(name)) return "YouTube";
  if (name === "netflix.com") return "Netflix";
  return null;
}

async function loadTv() {
  try { tv = (await message({ type: "tv" })).tv || null; } catch { tv = null; }
  if (!tv) {
    try { tv = JSON.parse(localStorage.getItem("detox.tv") || "null"); } catch { tv = null; }
  }
  $("#tv").textContent = tv ? `TV: ${tv}` : "No TV yet";
}

// More than one TV found: a small menu to switch (unless the options page fixes one TV).
async function loadTvPicker() {
  try {
    const { discovered = [], tvOverride = "" } = await chrome.storage.local.get(["discovered", "tvOverride"]);
    const tvs = (Array.isArray(discovered) ? discovered : []).filter((t) => t && typeof t.address === "string");
    if (tvOverride || tvs.length < 2) return false;
    if (tv && !tvs.some((t) => t.address === tv)) tvs.unshift({ address: tv, name: tv });
    const pick = document.createElement("select");
    pick.id = "tv-pick";
    pick.setAttribute("aria-label", "Which TV");
    pick.append(...tvs.map((t) => new Option(t.name || t.address, t.address, false, t.address === tv)));
    pick.addEventListener("change", async () => {
      await chrome.storage.local.set({ lastTv: pick.value });
      location.reload();   // everything below follows the TV
    });
    $("#tv").replaceChildren(pick);
    return true;
  } catch {
    return false;
  }
}

async function loadTvName() {
  if (!tv || $("#tv-pick")) return;
  try {
    const { device } = await api("GET", "/api/device", { query: { tv } });
    $("#tv").textContent = device.name;
    $("#tv").title = tv;
  } catch {
    $("#tv").title = "The TV didn't answer just now.";
  }
}

function render() {
  const send = $("#send");
  const pick = $("#video-pick");
  const web = tab && /^https?:\/\//.test(tab.url || "");
  if (!web) {
    $("#video-title").textContent = "Nothing to send from this tab.";
    $("#video-meta").textContent = "Open a page with a video, start it playing, then click the Roku Detox button.";
    send.disabled = true;
    return;
  }
  const app = appFor(tab.url);
  $("#video-title").textContent = tab.title || host(tab.url);
  if (app) {
    $("#video-meta").textContent = `Opens in the ${app} app on the TV.`;
  } else if (videos.length) {
    $("#video-meta").textContent = describe(videos[0]);
    if (videos.length > 1) {
      pick.replaceChildren(...videos.map((v, i) => new Option(`${i === 0 ? "Best: " : ""}${describe(v)}`, v.url)));
      pick.hidden = false;
    }
  } else {
    $("#video-meta").textContent = "No video seen playing on this tab yet. Start the video first, or send the page and Roku Detox will look for one.";
  }
  send.textContent = app || videos.length ? "Send to TV" : "Send this page to TV";
  send.disabled = !tv;
  if (!tv) setStatus("Pick your TV first: click Open Roku Detox.", "problem");
}

async function sendToTv() {
  const button = $("#send");
  button.disabled = true;
  setStatus("Sending…");
  const video = appFor(tab.url) ? "" : ($("#video-pick").hidden ? videos[0]?.url : $("#video-pick").value) || "";
  try {
    const result = await api("POST", "/api/link", { body: { tv, url: tab.url, video, title: tab.title || "" } });
    setStatus(`Playing on the TV${result.app ? ` in ${result.app}` : ""}.`, "ok");
  } catch (err) {
    setStatus(err.message, "problem");
  } finally {
    button.disabled = false;
  }
}

async function openApp() {
  try {
    await chrome.sidePanel.open({ windowId: tab ? tab.windowId : chrome.windows.WINDOW_ID_CURRENT });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("app/index.html") });
  }
  window.close();
}

// --- Quick remote -----------------------------------------------------------------------

let keyChain = Promise.resolve();
function pressKey(key) {
  if (!tv) return;
  const btn = $(`#keys [data-key="${key}"]`);
  if (btn) {
    btn.classList.add("sent");
    setTimeout(() => btn.classList.remove("sent"), 200);
  }
  // One at a time, so quick presses reach the TV in order.
  keyChain = keyChain.then(() => api("POST", "/api/key", { body: { tv, key } }))
    .then(() => { if ($("#status").dataset.state === "problem") setStatus(""); })
    .catch((err) => setStatus(err.message, "problem"));
}

const POPUP_KEYS = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "Select", Backspace: "Back" };

async function loadNow() {
  if (!tv) return;
  try {
    const { now } = await api("GET", "/api/now", { query: { tv } });
    const state = { play: "playing", pause: "paused", buffer: "loading" }[now?.state] || "";
    const screen = now?.screen || {};
    const home = !screen.id || ["roku", "roku dynamic menu", "home"].includes((screen.name || "").toLowerCase());
    const name = now?.app || (home ? "Home screen" : screen.name);
    $("#now").textContent = name ? `On the TV: ${name}${state && now?.app ? `, ${state}` : ""}` : "";
  } catch {
    $("#now").textContent = "";
  }
}

// Favorites and scenes from the page, one tap each.
async function loadLaunchers() {
  if (!tv) return;
  try {
    const [{ favorites = [], scenes = [] }, { apps = [] }] = await Promise.all([
      api("GET", "/api/settings", { query: { tv } }),
      api("GET", "/api/apps", { query: { tv } }),
    ]);
    const names = new Map(apps.map((a) => [a.id, a.name]));
    const buttons = [];
    for (const id of favorites.slice(0, 6)) {
      if (!names.has(id)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = names.get(id);
      b.title = `Open ${names.get(id)} on the TV`;
      b.addEventListener("click", () => run(b, () => api("POST", "/api/launch", { body: { tv, id } }), `Opening ${names.get(id)}.`));
      buttons.push(b);
    }
    // Sleep timer: one tap for 30 minutes, or off when one is set.
    const sleep = document.createElement("button");
    sleep.type = "button";
    const showSleep = (until) => {
      sleep.dataset.on = until ? "1" : "";
      sleep.textContent = until
        ? `Sleep: off at ${new Date(until * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} (tap to cancel)`
        : "Sleep in 30 min";
    };
    try { showSleep((await api("GET", "/api/sleep", { query: { tv } })).until); } catch { showSleep(null); }
    sleep.addEventListener("click", () => run(sleep, async () => {
      const { until } = await api("POST", "/api/sleep", { body: { tv, minutes: sleep.dataset.on ? 0 : 30 } });
      showSleep(until);
    }, sleep.dataset.on ? "Sleep timer off." : "The TV turns off in 30 minutes, even if you close this."));
    for (const scene of scenes.slice(0, 4)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "scene";
      b.textContent = scene.name;
      b.title = `Run the scene "${scene.name}"`;
      b.addEventListener("click", () => run(b, () => api("POST", "/api/scene", { body: { tv, id: scene.id } }), `Ran ${scene.name}.`));
      buttons.push(b);
    }
    buttons.push(sleep);
    $("#launch").replaceChildren(...buttons);
  } catch { /* the quick remote still works */ }
}

async function run(button, work, done) {
  button.disabled = true;
  try {
    await work();
    setStatus(done, "ok");
  } catch (err) {
    setStatus(err.message, "problem");
  } finally {
    button.disabled = false;
  }
}

function setUpQuickRemote() {
  for (const btn of document.querySelectorAll("#keys [data-key]")) btn.disabled = !tv;
  $("#keys").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-key]");
    if (btn && !btn.disabled) pressKey(btn.dataset.key);
  });
  document.addEventListener("keydown", (e) => {
    const el = e.target instanceof Element ? e.target : document.body;
    if (!tv || e.metaKey || e.ctrlKey || e.altKey || el.closest("select, input")) return;
    const key = POPUP_KEYS[e.key];
    if (!key || (key === "Select" && el.closest("button, a"))) return;
    e.preventDefault();
    pressKey(key);
  });
  $("#shortcuts").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
    window.close();
  });
}

async function main() {
  $("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  $("#send").addEventListener("click", sendToTv);
  $("#open").addEventListener("click", openApp);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tvReady = loadTv();
  if (tab && Number.isInteger(tab.id)) {
    try {
      const sniffed = await message({ type: "sniffed", tabId: tab.id });
      const best = sniffed.best;
      videos = best ? [best, ...(sniffed.items || []).filter((v) => v.url !== best.url)].slice(0, 8) : [];
    } catch {
      videos = [];
    }
  }
  await tvReady;
  render();
  setUpQuickRemote();
  await loadTvPicker();
  loadTvName();
  loadNow();
  loadLaunchers();
}

main();
