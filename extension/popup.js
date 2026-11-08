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
  if (!tv) return;
  try {
    const { device } = await api("GET", "/api/device", { query: { tv } });
    tvOff = Boolean(device.powerMode) && device.powerMode !== "PowerOn";
    if (tvOff) $("#now").textContent = "The TV is off. Power turns it on.";
    if ($("#tv-pick")) return;   // the TV menu already names it
    $("#tv").textContent = device.name;
    $("#tv").title = tv;
  } catch {
    tvOff = false;   // unknown: let "what's on" try
    if (!$("#tv-pick")) $("#tv").title = "The TV didn't answer just now.";
  }
}

// After anything that may have turned the TV on or off.
function refreshPower() {
  setTimeout(() => { loadTvName().then(() => { if (!tvOff) loadNow(); }); }, 2500);
}

function render() {
  const send = $("#send");
  const pick = $("#video-pick");
  const web = tab && /^https?:\/\//.test(tab.url || "");
  $("#video-card").classList.toggle("idle", !web);
  if (!web) {
    $("#video-title").textContent = "Nothing to send from this tab. Start a video on a page, then click Roku Detox.";
    $("#video-meta").textContent = "";
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
  if (key.startsWith("Power")) refreshPower();
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

let tvOff = false;
const minutesText = (seconds) => {
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
};
// "TV today: 1 h 5 min of 2 h" while the viewing log (or any rule) is counting.
function showToday(status) {
  const watched = status ? Object.entries(status.usage || {}).reduce((n, [k, v]) => n + (k === "home" ? 0 : v), 0) : 0;
  const box = $("#today");
  box.hidden = !status || !status.active || watched < 60;
  if (box.hidden) return;
  box.textContent = `TV today: ${minutesText(watched)}${status.totalToday ? ` of ${minutesText(status.totalToday * 60)}` : ""}`;
}

async function loadNow() {
  if (!tv || tvOff) return;
  try {
    const { now } = await api("GET", "/api/now", { query: { tv } });
    if (tvOff) return;   // found out meanwhile that the TV is off
    const state = { play: "playing", pause: "paused", buffer: "loading" }[now?.state] || "";
    const screen = now?.screen || {};
    const home = !screen.id || ["roku", "roku dynamic menu", "home"].includes((screen.name || "").toLowerCase());
    const name = now?.app || (home ? "Home screen" : screen.name);
    // A daily time limit on what's showing: say how much is left today.
    let left = "";
    const appId = now?.appId || (home ? "" : screen.id);
    let status = null;
    try { status = await api("GET", "/api/rules", { query: { tv } }); } catch { /* no rules: no notes */ }
    showToday(status);
    if (appId && status) {
      try {
        const weekendDay = [0, 6].includes(new Date().getDay());
        const appLimit = status.limitsToday ? status.limitsToday[appId]
          : (weekendDay && status.rules?.weekendLimits?.[appId]) || status.rules?.limits?.[appId];
        // All TV together counts too: whichever runs out first.
        const watched = Object.entries(status.usage || {}).reduce((n, [k, v]) => n + (k === "home" ? 0 : v), 0);
        const lefts = [];
        if (appLimit) lefts.push(appLimit - (status.usage?.[appId] || 0) / 60);
        if (status.totalToday && (appId !== "dev" || status.devPlaying)) lefts.push(status.totalToday - watched / 60);
        const paused = (status.rules?.pausedUntil || 0) > Date.now() / 1000;   // nothing closes while paused
        if (lefts.length && !paused) {
          const minutes = Math.round(Math.min(...lefts));
          left = minutes > 0 ? ` (${minutes} min left today)` : " (time's up for today)";
        }
      } catch { /* no rules: no note */ }
    }
    if (tvOff) return;
    $("#now").textContent = name ? `On the TV: ${name}${state && now?.app ? `, ${state}` : ""}${left}` : "";
  } catch {
    if (!tvOff) $("#now").textContent = "";
  }
}

// --- Continue watching: the next episode of the show watched last, in the same app ---------

const code = (season, episode) => `S${season} E${episode}`;

async function loadResume() {
  if (!tv) return;
  let items;
  try { ({ items = [] } = await api("GET", "/api/find/history", { query: { tv } })); } catch { return; }
  // The show watched last (pinned ones come first in the list, so go by when each was watched).
  const item = items.filter((i) => i && i.type === "Show" && i.season?.id != null && i.episode?.number != null && i.appId != null)
    .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
  if (!item) return;
  const btn = $("#resume-btn");
  btn.textContent = `Next episode of ${item.title}`;
  btn.title = `After ${code(item.season.number, item.episode.number)}, in ${item.appName || "the same app"}`;
  $("#resume").hidden = false;
  btn.addEventListener("click", () => run(btn, async () => {
    const next = await api("GET", "/api/find/next", { query: { tv, show: item.id, season: item.season.id, episode: item.episode.number } });
    if (next.done) throw new Error(`That was the last episode of ${item.title}.`);
    const { season = {}, episode } = next;
    if (!episode) throw new Error("Couldn't find the next episode.");
    const offer = (episode.offers || []).find((o) => String(o.appId) === String(item.appId));
    if (!offer) throw new Error(`${code(season.number, episode.number)} isn't in ${item.appName || "that app"}. Open Roku Detox to pick another way.`);
    await api("POST", "/api/watch", { body: { tv, appId: offer.appId, contentId: offer.contentId, mediaType: offer.mediaType } });
    // It's playing; if remembering it fails, still move on so the next click plays the next one.
    await api("POST", "/api/find/history", { body: { tv, item: {
      id: item.id, title: item.title, type: "Show", year: item.year ?? null, poster: item.poster || null,
      season: { id: season.id ?? null, number: season.number ?? null },
      episode: { id: episode.id ?? null, number: episode.number, title: episode.title || "" },
      appId: offer.appId, appName: item.appName || null,
    } } }).catch(() => {});
    // The next click goes on from here.
    item.season = { id: season.id ?? null, number: season.number ?? null };
    item.episode = { id: episode.id ?? null, number: episode.number, title: episode.title || "" };
    btn.title = `After ${code(season.number, episode.number)}, in ${item.appName || "the same app"}`;
    resumeSaid = `Playing ${item.title} ${code(season.number, episode.number)}${offer.showLevel ? " (pick it in the app)" : ""}.`;
    setTimeout(loadNow, 3000);
  }, () => resumeSaid));
}
let resumeSaid = "";

// Favorites and scenes from the page, one tap each.
let refreshSleep = async () => {};   // set once the sleep button exists
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
    refreshSleep = async () => {
      try { showSleep((await api("GET", "/api/sleep", { query: { tv } })).until); } catch { showSleep(null); }
    };
    await refreshSleep();
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
      b.addEventListener("click", () => run(b, async () => {
        await api("POST", "/api/scene", { body: { tv, id: scene.id } });
        setTimeout(refreshSleep, 1500);   // a scene can set the sleep timer
        refreshPower();                   // or turn the TV on or off
      }, `Ran ${scene.name}.`));
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
    setStatus(typeof done === "function" ? done() : done, "ok");
  } catch (err) {
    setStatus(err.message, "problem");
  } finally {
    button.disabled = false;
  }
}

function setUpQuickRemote() {
  for (const btn of document.querySelectorAll("#keys [data-key]")) btn.disabled = !tv;
  // The same phrases as the page's search box: "open Netflix", "HDMI 2", "sleep 30", a scene's name.
  $("#say-input").disabled = !tv;
  $("#say-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#say-input");
    const text = input.value.trim();
    if (!tv || !text) return;
    input.disabled = true;
    try {
      if (/^https?:\/\/\S+$/i.test(text)) {   // a pasted link plays, like the page's Send box
        const result = await api("POST", "/api/link", { body: { tv, url: text, video: "", title: "" } });
        setStatus(`Playing on the TV${result.app ? ` in ${result.app}` : ""}.`, "ok");
        input.value = "";
        return;
      }
      const { done } = await api("POST", "/api/do", { body: { tv, do: text } });
      setStatus(done, "ok");
      input.value = "";
      refreshPower();
      if (/sleep|off in/i.test(text) || done.startsWith("Running")) setTimeout(refreshSleep, 1500);
    } catch (err) {
      setStatus(err.message, "problem");
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
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
  loadResume();
}

main();
