// A small stand-in for the parts of the chrome.* API the engine uses, for node --test.

function area() {
  let data = {};
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(data);
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const key of list) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    async clear() { data = {}; },
    dump() { return data; },
  };
}

export function installFakeChrome() {
  const notifications = [];
  const sessionRules = new Map();
  const tabs = new Map();
  const event = () => {
    const listeners = [];
    return { listeners, addListener(fn) { listeners.push(fn); }, removeListener() {}, hasListener: (fn) => listeners.includes(fn) };
  };
  globalThis.chrome = {
    storage: { local: area(), session: area(), onChanged: event() },
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getManifest: () => ({ version: "1.0.0" }),
      getURL: (path) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${path}`,
      getPlatformInfo: (cb) => cb && cb({}),
      lastError: undefined,
      onMessage: event(),
      onMessageExternal: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    notifications: { create(id, options, cb) { notifications.push(options); if (cb) cb(id); }, list: notifications },
    alarms: { created: [], async get() { return undefined; }, async create(name, info) { this.created.push([name, info]); }, onAlarm: event() },
    declarativeNetRequest: {
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        for (const id of removeRuleIds) sessionRules.delete(id);
        for (const rule of addRules) sessionRules.set(rule.id, rule);
      },
      rules: sessionRules,
    },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return tabs.get(id); },
      onRemoved: event(),
      onUpdated: event(),
      list: tabs,
    },
    webRequest: { onResponseStarted: event() },
  };
  return globalThis.chrome;
}
