// Options: a fixed TV address for the toolbar button, and the extension id for web pages.

const $ = (selector) => document.querySelector(selector);

function setStatus(el, text, state = "") {
  el.textContent = text;
  el.dataset.state = state;
}

async function api(method, path, { query = null, body = null } = {}) {
  const reply = await chrome.runtime.sendMessage({ type: "api", method, path, query, body });
  if (!reply) throw new Error("The extension didn't answer. Try again.");
  if (reply.status !== 200) throw new Error(reply.data?.error || `Something went wrong (${reply.status}).`);
  return reply.data;
}

async function loadTv() {
  const { tvOverride = "", lastTv = null } = await chrome.storage.local.get(["tvOverride", "lastTv"]);
  $("#tv-input").value = tvOverride;
  setStatus($("#tv-status"), tvOverride ? `Always sending to ${tvOverride}.`
    : lastTv ? `Sending to the TV used last: ${lastTv}.` : "No TV used yet. Pick one in Roku Detox, or type its address.");
}

$("#tv-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = $("#tv-input").value.trim();
  const status = $("#tv-status");
  if (!address) {
    await chrome.storage.local.remove("tvOverride");
    return loadTv();
  }
  setStatus(status, "Checking the TV…");
  try {
    const { device } = await api("GET", "/api/device", { query: { tv: address } });
    await chrome.storage.local.set({ tvOverride: device.address });
    $("#tv-input").value = device.address;
    setStatus(status, `Saved. The toolbar button sends to ${device.name} (${device.address}).`, "ok");
  } catch (err) {
    setStatus(status, err.message, "problem");
  }
});

$("#tv-clear").addEventListener("click", async () => {
  await chrome.storage.local.remove("tvOverride");
  loadTv();
});

const id = chrome.runtime.id;
$("#ext-id").textContent = id;
$("#snippet").textContent = `localStorage.setItem("detox.extensionId", "${id}")`;
$("#version").textContent = `Version ${chrome.runtime.getManifest().version}`;
$("#copy-id").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(id);
    setStatus($("#id-status"), "Copied.", "ok");
  } catch {
    setStatus($("#id-status"), "Couldn't copy. Select the id and copy it yourself.", "problem");
  }
});

const RELAY_WORDS = {
  off: "Off. Save a relay address to use Roku Detox from your phone.",
  stopped: "Starting…",
  connecting: "Connecting to the relay…",
  online: "Connected. Phones with the link can use Roku Detox while this browser is open.",
  offline: "Can't reach the relay right now. It keeps trying.",
};

async function loadRelay() {
  const info = await chrome.runtime.sendMessage({ type: "relay-info" });
  if (document.activeElement !== $("#relay-input")) $("#relay-input").value = info.relayUrl || "";
  setStatus($("#relay-status"), RELAY_WORDS[info.status] || info.status,
    info.status === "online" ? "ok" : info.status === "offline" ? "problem" : "");
  $("#relay-link-box").hidden = !info.link;
  $("#relay-link").textContent = info.link || "";
}

$("#relay-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  let address = $("#relay-input").value.trim();
  if (!address) return;
  if (!/^https:\/\//i.test(address)) address = `https://${address.replace(/^http:\/\//i, "")}`;
  try {
    address = new URL(address).origin;
  } catch {
    setStatus($("#relay-status"), "That doesn't look like a web address.", "problem");
    return;
  }
  await chrome.storage.local.set({ relayUrl: address });
  setTimeout(loadRelay, 300);
});
$("#relay-off").addEventListener("click", async () => {
  await chrome.storage.local.remove("relayUrl");
  setTimeout(loadRelay, 300);
});
$("#relay-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#relay-link").textContent);
    setStatus($("#relay-status"), "Link copied.", "ok");
  } catch {
    setStatus($("#relay-status"), "Couldn't copy. Select the link and copy it yourself.", "problem");
  }
});
$("#relay-new-key").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "relay-new-key" });
  loadRelay();
});
setInterval(loadRelay, 4000);

loadTv();
loadRelay();

// --- Ways to use it: the keyboard shortcuts as they're set now ------------------------------

async function loadShortcuts() {
  const list = $("#shortcut-list");
  try {
    const commands = (await chrome.commands.getAll()).filter((c) => c.name !== "_execute_action" && c.description)
      .sort((a, b) => (Number(!a.shortcut) - Number(!b.shortcut)) || a.description.localeCompare(b.description));
    list.replaceChildren(...commands.map((c) => {
      const li = document.createElement("li");
      const key = document.createElement("kbd");
      key.textContent = c.shortcut || "not set";
      li.append(key, ` ${c.description}`);
      if (!c.shortcut) li.classList.add("muted");
      return li;
    }));
  } catch {
    list.textContent = "";
  }
}
$("#shortcuts-edit").addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
loadShortcuts();
