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

async function loadTvName() {
  if (!tv) return;
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
  loadTvName();
}

main();
