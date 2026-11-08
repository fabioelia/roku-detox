// Rules and the background watcher, ported from roku_detox.py's Watcher.
//
// Manifest V3 service workers can't loop forever, so chrome.alarms wakes the worker every
// 30 seconds (Chrome's minimum) and each wake-up checks the TV every few seconds for about
// 25 seconds. What the watcher remembers lives in chrome.storage.session (it survives the
// worker restarting, and is cleared when the browser quits); the activity list and the
// viewing log live in chrome.storage.local. Rules only run while the browser is open.

import {
  APP_ID_RE, HttpError, ParseError, TVError, ValueError, boundedInt, displayAddress, friendlyTime,
  isPlainObject, keepAlive, localClock, localDay, nowIso, parseTarget, pyStr, sleep, targetKey, truthy,
} from "./util.js";
import { activeApp, deviceInfo, ecp, friendlyNotice, launch, listApps, nowPlaying, parseMediaPlayer, press, runScene } from "./ecp.js";
import { getLocal, locked, readSettings, saveTvSettings, setLocal, tvEntry, updateSettings, TIME_RE } from "./store.js";
import { discover, rangeOf } from "./discover.js";

export const ALARM = "detox-rules";
export const RULES_DEFAULT = {
  autopilot: { enabled: false, target: "", skipNext: false },
  bedtime: { enabled: false, start: "21:00", end: "06:30", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], extendUntil: 0 },
  nightGuard: { enabled: false, start: "00:30", end: "06:00", idleMinutes: 3 },
  pausedUntil: 0, // epoch seconds: every rule rests until then (guests over, movie night)
  totalLimit: 0, // minutes of TV a day, all apps and inputs together (0: none)
  totalWeekendLimit: 0, // ... on Saturdays and Sundays instead (0: the same)
  bonus: { day: "", minutes: {} }, // extra minutes given for one day: app id (or "*" for all TV) -> minutes
  limits: {},    // app id -> minutes per day
  weekendLimits: {}, // app id -> minutes on Saturdays and Sundays instead (only apps with a daily limit)
  blocked: [],   // app ids sent back to the home screen
  redirects: {}, // app id -> app id to open instead
  log: false,    // keep a viewing log even with no other rules on
};
export const POLL_SECONDS = 5;
const ACTION_COOLDOWN = 6;
const USAGE_GAP_MAX = 40; // seconds counted between two checks at most (alarms can run late)
const BURST_SECONDS = 25;
const EVENTS_MAX = 300;

const now = () => Date.now() / 1000;
const copy = (value) => JSON.parse(JSON.stringify(value));

// --- Cleaning rules from the page (same checks and messages as clean_rules) -----------------

export function cleanRules(raw) {
  if (!isPlainObject(raw)) throw new ValueError("Bad rules.");
  const clock = (value, fallback) => {
    const text = truthy(value) ? pyStr(value) : fallback;
    if (!TIME_RE.test(text)) throw new ValueError("Write times like 21:30.");
    return text;
  };
  const appId = (value, allowEmpty = false) => {
    const text = truthy(value) ? pyStr(value) : "";
    if (allowEmpty && !text) return "";
    if (!APP_ID_RE.test(text)) throw new ValueError("Pick an app or input.");
    return text;
  };
  const section = (value) => {
    if (!truthy(value)) return {};
    if (!isPlainObject(value)) throw new ValueError("Bad rules.");
    return value;
  };
  const autopilot = section(raw.autopilot);
  const bedtime = section(raw.bedtime);
  const night = section(raw.nightGuard);
  const limits = truthy(raw.limits) ? raw.limits : {};
  const weekend = truthy(raw.weekendLimits) ? raw.weekendLimits : {};
  if (!isPlainObject(weekend) || Object.keys(weekend).length > 50) throw new ValueError("Bad rules.");
  const redirects = truthy(raw.redirects) ? raw.redirects : {};
  if (!isPlainObject(limits) || !isPlainObject(redirects) || Object.keys(limits).length > 50 || Object.keys(redirects).length > 50) {
    throw new ValueError("Bad rules.");
  }
  const blockedRaw = truthy(raw.blocked) ? raw.blocked : [];
  if (!Array.isArray(blockedRaw)) throw new ValueError("Bad rules.");
  const enabledAutopilot = truthy(autopilot.enabled);
  const target = appId(autopilot.target, true);
  if (enabledAutopilot && !target) throw new ValueError("Pick what the TV should open when it turns on.");
  const rules = {
    autopilot: { enabled: enabledAutopilot, target, skipNext: truthy(autopilot.skipNext) },
    bedtime: {
      enabled: truthy(bedtime.enabled),
      start: clock(bedtime.start, "21:00"),
      end: clock(bedtime.end, "06:30"),
      days: cleanDays(bedtime.days),
      extendUntil: boundedInt(bedtime.extendUntil, 0, 4_102_444_800),
    },
    nightGuard: {
      enabled: truthy(night.enabled),
      start: clock(night.start, "00:30"),
      end: clock(night.end, "06:00"),
      idleMinutes: boundedInt("idleMinutes" in night ? night.idleMinutes : 3, 1, 30),
    },
    limits: {},
    weekendLimits: {},
    blocked: [],
    redirects: {},
    log: truthy(raw.log),
    pausedUntil: boundedInt(raw.pausedUntil, 0, 4_102_444_800),
    totalLimit: boundedInt(raw.totalLimit, 0, 1440),
    totalWeekendLimit: boundedInt(raw.totalLimit, 0, 1440) ? boundedInt(raw.totalWeekendLimit, 0, 1440) : 0,
    bonus: cleanBonus(raw.bonus),
  };
  for (const [k, v] of Object.entries(limits)) rules.limits[appId(k)] = boundedInt(v, 1, 720);
  for (const [k, v] of Object.entries(weekend)) { // a weekend amount only for an app with a daily limit
    if (Object.hasOwn(rules.limits, appId(k))) rules.weekendLimits[appId(k)] = boundedInt(v, 1, 720);
  }
  rules.blocked = [...new Set(blockedRaw.slice(0, 50).map((a) => appId(a)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [k, v] of Object.entries(redirects)) if (k !== v) rules.redirects[appId(k)] = appId(v);
  // Refuse rules that would fight each other.
  for (const [source, dest] of Object.entries(rules.redirects)) {
    if (rules.redirects[dest] === source) throw new ValueError("Two swaps point at each other, so the TV would flip back and forth.");
    if (rules.blocked.includes(dest)) throw new ValueError("A swap opens a blocked app. Unblock it or change the swap.");
  }
  if (rules.autopilot.enabled && (rules.blocked.includes(rules.autopilot.target) || rules.autopilot.target in rules.redirects)) {
    throw new ValueError("The app set to open when the TV turns on is blocked or swapped. Pick another one.");
  }
  return rules;
}

export async function tvRules(address) {
  const raw = (await tvEntry(address)).rules;
  if (!truthy(raw)) return copy(RULES_DEFAULT);
  try {
    return cleanRules(raw);
  } catch (err) {
    if (err instanceof ValueError) return copy(RULES_DEFAULT);
    throw err;
  }
}

/** Minutes of TV allowed on moment's day for all apps and inputs together, or null (total_limit_today). */
export function totalLimitToday(rules, moment) {
  const weekend = (moment.getDay() === 0 || moment.getDay() === 6) && rules.totalWeekendLimit;
  const base = (weekend ? rules.totalWeekendLimit : rules.totalLimit) || null;
  return base === null ? null : base + bonusMinutes(rules, "*", moment);
}

/** {day: "YYYY-MM-DD", minutes: {app id or "*": minutes}}: extra time given for one day (clean_bonus). */
export function cleanBonus(raw) {
  if (!isPlainObject(raw)) return { day: "", minutes: {} };
  const day = typeof raw.day === "string" && /^\d{4}-\d\d-\d\d$/.test(raw.day) ? raw.day : "";
  const given = isPlainObject(raw.minutes) ? raw.minutes : {};
  const minutes = {};
  for (const [key, value] of Object.entries(given).slice(0, 51)) {
    if (key === "*" || APP_ID_RE.test(key)) {
      const amount = boundedInt(value, 0, 720);
      if (amount) minutes[key] = amount;
    }
  }
  return { day: Object.keys(minutes).length ? day : "", minutes };
}

/** Extra minutes given today for the app (or "*" for all TV together): bonus_minutes. */
export function bonusMinutes(rules, key, moment) {
  const bonus = rules.bonus || {};
  return bonus.day === localDay(moment) && bonus.minutes && Object.hasOwn(bonus.minutes, key) ? bonus.minutes[key] : 0;
}

/** Detox Home is playing a video (not showing its launcher, clock or a notice): detox_home_playing. */
async function detoxHomePlaying(target) {
  try {
    const { status, text } = await ecp(target, "query/media-player"); // one request (nowPlaying also asks what's open)
    return status === 200 && ["play", "buffer", "pause"].includes(parseMediaPlayer(text).state);
  } catch {
    return false;
  }
}

/** The app's own limit or all TV together is used up for moment's day (time_used_up). */
export function timeUsedUp(rules, usage, appId, moment) {
  if (appId === "dev") return false; // Detox Home's own screens don't count, so skip-home can always open it
  const limit = limitToday(rules, appId, moment);
  const total = totalLimitToday(rules, moment);
  return (limit !== undefined && (usage[appId] || 0) >= limit * 60) || Boolean(total && watchedToday(usage) >= total * 60);
}

/** Seconds on apps and inputs today (the home screen doesn't count). */
export function watchedToday(usage) {
  return Object.entries(usage).reduce((n, [k, v]) => n + (k === "home" ? 0 : v), 0);
}

/** Minutes allowed on the app on moment's day: its weekend amount on Saturday and Sunday, if any (limit_today). */
export function limitToday(rules, appId, moment) {
  const weekendDay = moment.getDay() === 0 || moment.getDay() === 6;
  let base;
  if (weekendDay && rules.weekendLimits && Object.hasOwn(rules.weekendLimits, appId)) base = rules.weekendLimits[appId];
  else base = Object.hasOwn(rules.limits, appId) ? rules.limits[appId] : undefined;
  return base === undefined ? undefined : base + bonusMinutes(rules, appId, moment);
}

/** Any rule that acts on the TV (the viewing log alone only watches). */
export function rulesEnforcing(rules) {
  return Boolean(
    (rules.autopilot.enabled && rules.autopilot.target)
    || rules.bedtime.enabled || rules.nightGuard.enabled
    || Object.keys(rules.limits).length || rules.blocked.length || Object.keys(rules.redirects).length || rules.totalLimit,
  );
}

/** pausedUntil, extendUntil and skipNext change only through their own routes (and the watcher), so a
 * page saving its older copy of the rules can't undo them or bring them back (keep_owned_fields). */
export function keepOwnedFields(rules, stored) {
  rules.pausedUntil = stored.pausedUntil || 0;
  rules.bedtime.extendUntil = stored.bedtime.extendUntil || 0;
  rules.autopilot.skipNext = Boolean(stored.autopilot.skipNext);
  rules.bonus = stored.bonus || { day: "", minutes: {} };
  return rules;
}

export function rulesActive(rules) {
  return Boolean(
    (rules.autopilot.enabled && rules.autopilot.target)
    || rules.bedtime.enabled || rules.nightGuard.enabled
    || Object.keys(rules.limits).length || rules.blocked.length || Object.keys(rules.redirects).length || rules.log || rules.totalLimit,
  );
}

/** Is the moment inside start-end, where end may be after midnight? */
export const BEDTIME_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The nights a bedtime applies to, in week order; none given (or none left) means every night. */
function cleanDays(raw) {
  if (raw === undefined || raw === null) return [...BEDTIME_DAYS];
  if (!Array.isArray(raw)) throw new ValueError("Bad rules.");
  const days = BEDTIME_DAYS.filter((day) => raw.includes(day));
  return days.length ? days : [...BEDTIME_DAYS];
}

/** Monday = 0, like Python's weekday() (getDay() counts from Sunday). */
const weekday = (moment) => (moment.getDay() + 6) % 7;

/** The night a bedtime starting on weekday belongs to: a start before noon counts as the night before (night_of). */
export function nightOf(day, start) {
  return BEDTIME_DAYS[(((day - (start < "12:00" ? 1 : 0)) % 7) + 7) % 7];
}

/**
 * Inside the bedtime hours of a night it applies to (bedtime_now). With 21:00-06:30 on school nights,
 * Thursday night runs into Friday morning, but Friday night is free. Weekday arithmetic, not date maths,
 * so a 23- or 25-hour day around a clock change doesn't move it.
 */
export function bedtimeNow(rule, moment) {
  if (!inWindow(rule.start, rule.end, moment)) return false;
  const startedYesterday = rule.start > rule.end && localClock(moment) < rule.start;
  return (rule.days || BEDTIME_DAYS).includes(nightOf(weekday(moment) - (startedYesterday ? 1 : 0), rule.start));
}

/** Whether the next bedtime (today's start if still ahead, else tomorrow's) is on one of its nights (next_bedtime_on). */
export function nextBedtimeOn(rule, moment) {
  const ahead = localClock(moment) >= rule.start ? 1 : 0;
  return (rule.days || BEDTIME_DAYS).includes(nightOf(weekday(moment) + ahead, rule.start));
}

export function inWindow(start, end, moment) {
  const clock = localClock(moment);
  return start <= end ? (start <= clock && clock < end) : (clock >= start || clock < end);
}

const HOME_NAMES = new Set(["roku", "roku dynamic menu", "home"]);

/** Roku's home screen reports as 'Roku' with no id, or on newer TVs as 'Roku Dynamic Menu'. */
export function isHome(app) {
  return !app.id || HOME_NAMES.has((app.name || "").trim().toLowerCase());
}

export function plainName(app) {
  return (app.name || app.id || "the app").replaceAll(" ", " ");
}

const APP_NAMES = new Map(); // target key -> {app id: name}

/** A channel's name for messages, looked up once per TV. */
export async function appLabel(target, appId) {
  const key = targetKey(target);
  let names = APP_NAMES.get(key);
  if (!names || !(appId in names)) {
    try {
      names = Object.fromEntries((await listApps(target)).map((a) => [a.id, a.name.replaceAll(" ", " ")]));
      APP_NAMES.set(key, names);
    } catch (err) {
      if (!(err instanceof TVError)) throw err;
      names = names || {};
    }
  }
  return names[appId] ?? appId;
}

// --- What the watcher remembers ----------------------------------------------------------------

function newWatch() {
  return {
    power: null, reachable: null, control: null, app: { id: "", name: "" }, onSince: null,
    autopilot: null, // null, "pending", or {verify: started, tries}
    homePolls: 0, idleSince: null, bedtimeWarned: null, lastAction: 0, lastSeen: 0,
    unreachableSince: null, said: {}, usageDay: null, usage: {}, lastTick: null, lastSaved: 0, devPlaying: false, timedOut: null,
  };
}

let STATE = null; // {tvs: {address: watch}, lastRound, sceneRuns: {"address|scene": "day hh:mm"}}

async function loadState() {
  if (!STATE) {
    let saved = null;
    try { saved = (await chrome.storage.session.get("watcher")).watcher; } catch { saved = null; }
    STATE = isPlainObject(saved) ? saved : {};
    STATE.tvs = isPlainObject(STATE.tvs) ? STATE.tvs : {};
    STATE.lastRound = STATE.lastRound || 0;
    STATE.sceneRuns = isPlainObject(STATE.sceneRuns) ? STATE.sceneRuns : {};
  }
  return STATE;
}

async function saveState() {
  try { await chrome.storage.session.set({ watcher: STATE }); } catch { /* ignore */ }
}

function notify(message) {
  try {
    chrome.notifications.create("", {
      type: "basic", iconUrl: chrome.runtime.getURL("icons/128.png"), title: "Roku Detox", message, priority: 1,
    }, () => void chrome.runtime.lastError);
  } catch { /* never let a notification break the watcher */ }
}

/** Record something the watcher did or noticed. key + every stop repeats. */
export async function event(address, message, kind = "action", key = null, every = 600) {
  const state = STATE && STATE.tvs[address];
  if (key && state) {
    const last = state.said[key] || 0;
    if (now() - last < every) return;
    state.said[key] = now();
  }
  const entry = { time: nowIso(), tv: address, kind, message };
  await locked(async () => {
    const events = await getLocal("events", []);
    const list = Array.isArray(events) ? events : [];
    list.push(entry);
    await setLocal("events", list.slice(-EVENTS_MAX));
  });
  if (kind === "alert") notify(message);
}

async function loadUsage(address, day) {
  const data = await getLocal("usage", {});
  const days = isPlainObject(data) && isPlainObject(data[address]) ? data[address] : {};
  return isPlainObject(days[day]) ? { ...days[day] } : {};
}

/** Seconds on each app over the days on record (up to two weeks), for Clean up. Same as usage_summary(). */
export async function usageSummary(address) {
  const data = await getLocal("usage", {});
  const days = isPlainObject(data) && isPlainObject(data[address]) ? data[address] : {};
  const totals = {};
  const perDay = []; // seconds on apps and inputs each day (the home screen doesn't count)
  const tracked = Object.keys(days).filter((day) => isPlainObject(days[day])).sort();
  for (const day of tracked) {
    let watched = 0;
    for (const [appId, seconds] of Object.entries(days[day])) {
      if (typeof seconds === "number" && Number.isFinite(seconds)) {
        totals[appId] = (totals[appId] || 0) + Math.trunc(seconds);
        if (appId !== "home") watched += Math.trunc(seconds);
      }
    }
    perDay.push({ day, seconds: watched });
  }
  const now = new Date();   // this computer's date, which the log uses
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { days: tracked.length, since: tracked[0] || null, totals, perDay, today };
}

async function saveUsage(address, day, usage) {
  await locked(async () => {
    const data = await getLocal("usage", {});
    const all = isPlainObject(data) ? data : {};
    const days = isPlainObject(all[address]) ? all[address] : {};
    days[day] = Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Math.trunc(v)]));
    for (const old of Object.keys(days).sort().slice(0, -14)) delete days[old]; // keep two weeks
    all[address] = days;
    await setLocal("usage", all);
  });
}

// --- One check of one TV ---------------------------------------------------------------------------

async function act(state, fn) {
  if (now() - state.lastAction < ACTION_COOLDOWN) return false;
  state.lastAction = now();
  await fn();
  return true;
}

async function check(address, rules) {
  const target = parseTarget(address);
  const state = STATE.tvs[address] || (STATE.tvs[address] = newWatch());
  const t = now();
  const local = new Date();

  let info;
  try {
    info = await deviceInfo(target);
  } catch (err) {
    if (!(err instanceof TVError) || err instanceof ParseError) throw err;
    if (state.power === "on") state.onSince = null;
    state.power = "off";
    state.reachable = false;
    state.unreachableSince = state.unreachableSince || t;
    if (t - state.unreachableSince > 180 && t >= (rules.pausedUntil || 0)
      && (rules.bedtime.enabled || Object.keys(rules.limits).length || rules.blocked.length || rules.totalLimit)) {
      await event(address, "Can't reach the TV. If it's on, rules aren't working. Check it's on the same Wi-Fi, and that Fast TV start is on.", "alert", "unreachable", 3600);
    }
    return;
  }
  state.reachable = true;
  state.unreachableSince = null;
  state.lastSeen = t;

  const mode = info["ecp-setting-mode"] || "";
  state.control = mode !== "limited" && mode !== "disabled";
  if (!state.control) {
    if (t < (rules.pausedUntil || 0)) return;
    await event(address, "The TV's remote access was switched to Limited, so rules can't run. Set it back: Settings > System > Advanced system settings > Control by mobile apps > Network access > Default.", "alert", "limited", 3600);
    return;
  }
  delete state.said.limited;

  const powered = info["power-mode"] === "PowerOn";
  const was = state.power;
  state.power = powered ? "on" : "standby";
  if (!powered) {
    state.onSince = null;
    state.autopilot = null;
    state.idleSince = null;
    state.bedtimeWarned = null;
    await tickUsage(address, state, null, t, local);
    return;
  }

  const app = await activeApp(target);
  state.app = app;
  state.devPlaying = app.id === "dev" && (await detoxHomePlaying(target));
  if (was === "standby" || was === "off") { // it just turned on
    state.onSince = t;
    state.homePolls = 0;
    state.autopilot = "pending";
    await event(address, `TV turned on (${isHome(app) ? "home screen" : plainName(app)}).`, "info");
  } else if (was === null) {
    state.onSince = t; // already on when we started watching
  }

  await tickUsage(address, state, app, t, local);
  if (t < (rules.pausedUntil || 0)) { // paused: keep counting viewing time, enforce nothing,
    // and start fresh afterwards: a full bedtime warning and a new idle count
    state.bedtimeWarned = state.idleSince = null;
    delete state.said["bedtime-off"];
    if (state.autopilot !== "pending") state.autopilot = null; // a skip-home under way doesn't pick up an hour later
    return;
  }

  if (await bedtime(address, rules, state, target, local, t)) return;
  if (await nightGuard(address, rules, state, target, local, t)) return;
  await autopilot(address, rules, state, target, app, t);
  await appRules(address, rules, state, target, app, local);
}

async function tickUsage(address, state, app, t, local = new Date()) {
  const day = localDay(local); // the check's one moment: the same day as its limits
  if (state.usageDay !== day) {
    if (state.usageDay && Object.keys(state.usage).length) await saveUsage(address, state.usageDay, state.usage);
    state.usageDay = day;
    state.usage = await loadUsage(address, day);
    state.lastTick = null;
  }
  if (app !== null && state.lastTick !== null) {
    // Newer TVs give the home screen an id; Detox Home counts as the home screen unless it plays a video.
    const key = isHome(app) || (app.id === "dev" && !state.devPlaying) ? "home" : app.id;
    state.usage[key] = (state.usage[key] || 0) + Math.min(t - state.lastTick, USAGE_GAP_MAX);
  }
  state.lastTick = app !== null ? t : null;
  if (t - state.lastSaved > 60) {
    state.lastSaved = t;
    await saveUsage(address, day, state.usage);
  }
}

async function bedtime(address, rules, state, target, local, t) {
  const rule = rules.bedtime;
  if (!rule.enabled || !bedtimeNow(rule, local) || t < rule.extendUntil) {
    state.bedtimeWarned = null;
    return false;
  }
  if (state.bedtimeWarned === null) {
    state.bedtimeWarned = t;
    await friendlyNotice(target, "Bedtime", "The TV turns off in 1 minute.");
    await event(address, "It's bedtime. The TV turns off in 1 minute.", "info", "bedtime-warn", 120);
    return true;
  }
  const grace = (state.said["bedtime-off"] || 0) > t - 6 * 3600 ? 15 : 60;
  if (t - state.bedtimeWarned >= grace) {
    if (await act(state, () => press(target, "PowerOff"))) {
      state.bedtimeWarned = null;
      state.said["bedtime-off"] = t;
      await event(address, "Bedtime. Turned the TV off.");
    }
  }
  return true;
}

async function nightGuard(address, rules, state, target, local, t) {
  const rule = rules.nightGuard;
  if (!rule.enabled || !inWindow(rule.start, rule.end, local) || !state.onSince) {
    state.idleSince = null;
    return false;
  }
  if (!inWindow(rule.start, rule.end, new Date(state.onSince * 1000))) return false; // it was already on before the quiet hours began
  let playing;
  try {
    playing = (await nowPlaying(target)).state === "play";
  } catch (err) {
    if (!(err instanceof TVError) || err instanceof ParseError) throw err;
    playing = false;
  }
  if (playing && !isHome(state.app)) {
    state.idleSince = null;
    return false;
  }
  state.idleSince = state.idleSince || t;
  if (t - state.idleSince >= rule.idleMinutes * 60) {
    if (await act(state, () => press(target, "PowerOff"))) {
      const when = friendlyTime(new Date(state.onSince * 1000));
      await event(address, `The TV turned on by itself at ${when} and nothing was playing. Turned it back off.`, "alert");
      state.idleSince = null;
    }
    return true;
  }
  return false;
}

async function autopilot(address, rules, state, target, app, t) {
  const rule = rules.autopilot;
  if (!rule.enabled || !rule.target || !state.autopilot) return;
  if (state.autopilot === "pending") {
    if (t - state.onSince > 45) {
      state.autopilot = null;
      return;
    }
    if (!isHome(app)) {
      state.autopilot = null;
      if ((app.id || "").startsWith("tvinput.")) await event(address, `TV turned on to ${plainName(app)}, so it was left alone.`, "info");
      return;
    }
    state.homePolls += 1;
    if (state.homePolls < 2) return; // wait for a second check, in case it's still switching inputs
    if (timeUsedUp(rules, state.usage, rule.target, new Date())) { // before "skip next time" is used up
      state.autopilot = null;
      await event(address, `TV turned on. ${await appLabel(target, rule.target)} has no time left today, so it stayed on the home screen.`, "info");
      return;
    }
    if (rule.skipNext) {
      state.autopilot = null;
      await updateSettings((data) => {
        const saved = data.tvs?.[address]?.rules?.autopilot;
        if (saved) saved.skipNext = false;
      });
      await event(address, "Skipped opening an app this time, as asked.", "info");
      return;
    }
    if (await act(state, () => launch(target, rule.target))) state.autopilot = { verify: t, tries: 1 };
    return;
  }
  const { verify: started, tries } = state.autopilot;
  if (t - started < 6) return;
  const name = await appLabel(target, rule.target);
  if (app.id === rule.target) {
    await event(address, `TV turned on. Opened ${name} instead of the home screen.`);
    state.autopilot = null;
  } else if (tries < 2 && isHome(app)) {
    if (await act(state, () => launch(target, rule.target))) state.autopilot = { verify: now(), tries: tries + 1 };
  } else {
    state.autopilot = null;
    if (isHome(app)) await event(address, `Couldn't open ${name} after the TV turned on. It's on the home screen.`, "alert");
  }
}

async function appRules(address, rules, state, target, app, local = new Date()) {
  const appId = app.id;
  if (!appId) return;
  const name = plainName(app);
  // A notice in Detox Home replaces the app; without Detox Home, go back to the home screen.
  const closeWith = (title, text) => async () => {
    if (!(await friendlyNotice(target, title, text))) await press(target, "Home");
  };
  if (rules.blocked.includes(appId)) {
    if (await act(state, closeWith("Not on this TV", `${name} is blocked.`))) {
      await event(address, `${name} is blocked. Closed it.`, "action", `blocked-${appId}`, 300);
    }
    return;
  }
  const limit = limitToday(rules, appId, local);
  if (limit !== undefined && (appId !== "dev" || state.devPlaying) && (state.usage[appId] || 0) >= limit * 60) {
    state.timedOut = appId; // "15 more minutes" from the home screen means this one
    if (await act(state, closeWith("Time's up", `${name} is done for today.`))) {
      await event(address, `Time's up for ${name} today (${limit} minute${limit !== 1 ? "s" : ""}). Closed it.`, "action", `limit-${appId}`, 900);
    }
    return;
  }
  const total = totalLimitToday(rules, local);
  // All apps together; Detox Home only while it plays a video (its notice and launcher are the home screen).
  if (total && (appId !== "dev" || state.devPlaying) && !isHome(app) && watchedToday(state.usage) >= total * 60) {
    state.timedOut = appId;
    if (await act(state, closeWith("Time's up", "That's all the TV for today."))) {
      await event(address, `Time's up for TV today (${total} minute${total !== 1 ? "s" : ""} in all). Closed ${name}.`, "action", "limit-total", 900);
    }
    return;
  }
  const instead = rules.redirects[appId];
  if (instead) {
    if (await act(state, () => launch(target, instead))) {
      await event(address, `${name} opened, so opened ${await appLabel(target, instead)} instead.`, "action", `redirect-${appId}`, 120);
    }
  }
}

// --- Rounds -----------------------------------------------------------------------------------------

/** Scenes with a daily time, run once in their minute (like roku_detox.py's scheduler). */
async function scheduledScenes(tvs) {
  const moment = new Date();
  const clock = localClock(moment);
  const minute = `${localDay(moment)} ${clock}`;
  let any = false;
  for (const [address, tv] of Object.entries(tvs)) {
    for (const scene of Array.isArray(tv?.scenes) ? tv.scenes : []) {
      if (!scene || !scene.at) continue;
      any = true;
      const key = `${address}|${scene.id}`;
      if (scene.at === clock && STATE.sceneRuns[key] !== minute) {
        STATE.sceneRuns[key] = minute;
        let target;
        try { target = parseTarget(address); } catch { continue; }
        runScene(target, scene).then(
          () => console.log(`Ran scheduled scene "${scene.name}" on ${address}.`),
          (err) => console.warn(`Scheduled scene "${scene.name}" didn't finish: ${err.message}`),
        );
      }
    }
  }
  for (const key of Object.keys(STATE.sceneRuns)) if (!STATE.sceneRuns[key].startsWith(localDay(moment))) delete STATE.sceneRuns[key];
  return any;
}

/** Check every TV that has rules on once. Returns how many TVs have rules on. */
export async function runRound() {
  await loadState();
  const settings = await readSettings();
  const tvs = isPlainObject(settings.tvs) ? settings.tvs : {};
  const active = {};
  for (const address of Object.keys(tvs)) {
    const rules = await tvRules(address);
    if (rulesActive(rules)) active[address] = rules;
  }
  for (const [address, rules] of Object.entries(active)) {
    try {
      await check(address, rules);
    } catch (err) {
      if (err instanceof HttpError) await event(address, `Rules hit a problem: ${err.message}`, "info", "problem", 900);
      else console.error("Roku Detox rules:", err);
    }
  }
  for (const address of Object.keys(STATE.tvs)) if (!(address in active)) delete STATE.tvs[address];
  await scheduledScenes(tvs);
  STATE.lastRound = now();
  await saveState();
  return Object.keys(active).length;
}

let burst = null;

/** Called by the alarm: check every few seconds for about 25 s while any rule is on. */
export function runBurst(seconds = BURST_SECONDS) {
  if (burst) return burst;
  burst = keepAlive((async () => {
    const started = Date.now();
    for (;;) {
      const roundStarted = Date.now();
      let active = 0;
      try {
        active = await runRound();
      } catch (err) {
        console.error("Roku Detox rules:", err);
      }
      if (!active) break; // nothing to watch: one round per alarm is enough
      const wait = Math.max(1000, POLL_SECONDS * 1000 - (Date.now() - roundStarted));
      if (Date.now() - started + wait > seconds * 1000) break;
      await sleep(wait);
    }
  })()).finally(() => { burst = null; });
  return burst;
}

export async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(ALARM);
    if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  } catch (err) {
    console.warn("Roku Detox: couldn't set the rules alarm", err);
  }
}

// --- For the page --------------------------------------------------------------------------------------

export async function rulesStatus(address) {
  await loadState();
  const state = STATE.tvs[address];
  const rules = await tvRules(address);
  const day = localDay();
  const usage = state && state.usageDay === day ? state.usage : await loadUsage(address, day);
  const events = await getLocal("events", []);
  const mine = (Array.isArray(events) ? events : []).filter((e) => e && e.tv === address).slice(-40);
  return {
    rules,
    active: rulesActive(rules),
    watching: Boolean(state) && now() - STATE.lastRound < (BURST_SECONDS + 30 + POLL_SECONDS * 4),
    awake: false,
    power: state ? state.power : null,
    app: state ? state.app : null,
    bedtimeNow: rules.bedtime.enabled && bedtimeNow(rules.bedtime, new Date()),
    usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, Math.trunc(v)])),
    limitsToday: Object.fromEntries(Object.keys(rules.limits).map((id) => [id, limitToday(rules, id, new Date())])),
    totalToday: totalLimitToday(rules, new Date()),
    timedOut: state ? state.timedOut || null : null,
    events: mine.reverse(),
  };
}

export const watcherOptions = { startOnSave: true }; // tests turn this off to run rounds by hand

export async function saveRules(address, rules) {
  await saveTvSettings(address, { rules });
  if (watcherOptions.startOnSave) runBurst(); // start watching right away instead of at the next alarm
}

export async function extendBedtime(address, minutes) {
  const rules = await tvRules(address);
  const start = Math.max(now(), rules.bedtime.extendUntil);
  rules.bedtime.extendUntil = Math.trunc(start + minutes * 60);
  await saveRules(address, rules);
  return rules;
}

/** Rest every rule for `minutes` (0 picks them back up). The viewing log keeps counting. */
/** Add minutes for today to an app's limit, or to all TV together ("*"): give_more_time. */
export async function giveMoreTime(address, key, minutes) {
  const rules = await tvRules(address);
  const today = localDay(new Date());
  const given = rules.bonus && rules.bonus.day === today ? { ...rules.bonus.minutes } : {};
  given[key] = Math.min(720, (given[key] || 0) + minutes);
  rules.bonus = { day: today, minutes: given };
  await saveRules(address, rules);
  return rules;
}

export async function pauseRules(address, minutes) {
  const rules = await tvRules(address);
  rules.pausedUntil = minutes ? Math.trunc(now() + minutes * 60) : 0;
  await saveRules(address, rules);
  return rules;
}

export async function skipAutopilot(address) {
  const rules = await tvRules(address);
  rules.autopilot.skipNext = true;
  await saveRules(address, rules);
  return rules;
}

// --- Connection check ------------------------------------------------------------------------------------

/** Plain-language checks for why control might not work. */
export async function doctor(target) {
  const checks = [];
  const address = displayAddress(target);
  let info;
  try {
    info = await deviceInfo(target);
  } catch (err) {
    if (!(err instanceof TVError) || err instanceof ParseError) throw err;
    let moved = null;
    const serial = (await tvEntry(address)).serial;
    if (serial) {
      const ranges = [rangeOf(target)];
      const tvs = await discover({ ranges, remember: false });
      moved = tvs.find((tv) => tv.serial === serial && tv.address !== address) || null;
    }
    checks.push({
      ok: false,
      title: "The TV isn't answering",
      fix: moved ? `Your TV moved to ${moved.address}. Pick it in the TV list at the top.`
        : "Check it's plugged in and on the same Wi-Fi as this computer. If the TV is off, turn on Fast TV start (Settings > System > Power) so this page can wake it.",
    });
    return { checks, moved };
  }
  if (info["serial-number"]) {
    await updateSettings((data) => {
      if (!isPlainObject(data.tvs)) data.tvs = {};
      if (!isPlainObject(data.tvs[address])) data.tvs[address] = {};
      data.tvs[address].serial = info["serial-number"];
    });
  }
  checks.push({ ok: true, title: "The TV answers on your Wi-Fi", fix: "" });
  const mode = info["ecp-setting-mode"] || "";
  const limited = mode === "limited" || mode === "disabled";
  checks.push({
    ok: !limited,
    title: limited ? "Remote access is set to Limited" : "Remote access is on",
    fix: limited ? "Settings > System > Advanced system settings > Control by mobile apps > Network access > Default." : "",
  });
  const wakes = info["supports-wake-on-wlan"] === "true";
  checks.push({
    ok: true,
    title: "Turning the TV on from here",
    fix: "Works while Fast TV start is on (Settings > System > Power). If it's off, the TV disappears from the network when it's turned off."
      + (wakes ? "" : " This TV may not support waking over Wi-Fi."),
  });
  if (mode === "permissive") {
    checks.push({ ok: false, title: "Remote access is set to Permissive", fix: "Default is enough for this page and lets in fewer devices." });
  }
  checks.push({
    ok: true,
    title: "Rules run while Chrome is open",
    fix: "Without the Roku Detox program at home, bedtime, limits and the other rules only work while this browser is running.",
  });
  return { checks, moved: null };
}

