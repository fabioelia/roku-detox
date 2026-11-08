// Plain phrases ("pause", "open Netflix", "HDMI 2", "game time", "sleep 30"): the same rules as
// do_phrase() in roku_detox.py, for the page's search box (typed or spoken).

import { deviceInfo, launch, listApps, nowPlaying, press, pressSequence, runScene, search } from "./ecp.js";
import { setSleep } from "./sleep.js";
import { cast } from "./video.js";
import { appLabel, isHome, pauseRules, plainName, rulesEnforcing, rulesStatus, tvRules } from "./rules.js";
import { tvSettings } from "./store.js";
import { ValueError, cut, displayAddress, pyLen } from "./util.js";

const PHRASE_KEYS = [
  [["pause", "play", "resume", "play pause", "playpause"], "Play", "Play or pause sent."],
  [["home", "go home", "home screen"], "Home", "Went to the home screen."],
  [["back", "go back"], "Back", "Went back."],
  [["ok", "select", "enter"], "Select", "Pressed OK."],
  [["mute", "unmute"], "VolumeMute", "Mute pressed."],
  [["louder", "volume up", "turn it up"], "VolumeUp", "Turned it up."],
  [["quieter", "softer", "volume down", "turn it down"], "VolumeDown", "Turned it down."],
  [["off", "turn off", "tv off", "power off", "turn off the tv", "turn the tv off"], "PowerOff", "Turned the TV off."],
  [["on", "turn on", "tv on", "power on", "turn on the tv", "turn the tv on"], "PowerOn", "Turned the TV on."],
  [["replay", "rewind a bit", "instant replay"], "InstantReplay", "Replayed the last few seconds."],
  [["rewind"], "Rev", "Rewinding."],
  [["fast forward", "forward"], "Fwd", "Fast forwarding."],
];

export const STATUS_ON_RE = /^(?:(?:what s|whats|what is) (?:on|playing)(?: on)?(?: (?:the )?tv)?(?: right now| now)?|now playing|what am i watching)$/;
export const STATUS_TIME_RE = /^(?:screen time|tv time|watch time|how much tv)(?: today)?$/;
export const STATUS_LEFT_RE = /^(?:time left|how much time is left|how much time left)(?: today)?$/;

/** 1 hour 5 minutes, 45 minutes, less than a minute (say_duration in roku_detox.py). */
export function sayDuration(seconds) {
  let minutes = Math.floor(Math.trunc(seconds) / 60);
  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  const parts = hours ? [`${hours} hour${hours !== 1 ? "s" : ""}`] : [];
  if (minutes) parts.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  return parts.join(" ");
}

/** 21:00 -> 9 PM, 06:30 -> 6:30 AM. */
export function sayClock(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const h = hour % 12 || 12;
  return `${minute ? `${h}:${String(minute).padStart(2, "0")}` : h} ${hour < 12 ? "AM" : "PM"}`;
}

async function sayWhatsOn(target) {
  if (((await deviceInfo(target))["power-mode"] ?? "PowerOn") !== "PowerOn") return "The TV is off.";
  const now = await nowPlaying(target);
  if (isHome(now.screen)) return "The home screen is on.";
  const name = plainName(now.screen);
  if (now.live) return `${name} is on, live.`;
  if (["play", "pause", "buffer"].includes(now.state) && now.position) {
    let said = `${name} is on, ${now.state === "pause" ? "paused" : "playing"}, ${sayDuration(now.position / 1000)} in`;
    if (now.duration && now.duration > now.position) said += `, ${sayDuration((now.duration - now.position) / 1000)} to go`;
    return `${said}.`;
  }
  return `${name} is on.`;
}

async function sayScreenTime(target) {
  const status = await rulesStatus(displayAddress(target));
  const usage = Object.entries(status.usage).filter(([k, v]) => k !== "home" && v > 0);
  const total = usage.reduce((sum, [, v]) => sum + v, 0);
  if (total < 60) {
    if (!status.active) return "The viewing log is off. Turn it on in the Rules menu to keep track of screen time.";
    return total ? "Less than a minute of TV today." : "No TV yet today.";
  }
  const [top, topSeconds] = usage.reduce((best, e) => (e[1] > best[1] || (e[1] === best[1] && e[0] < best[0]) ? e : best));
  const name = await appLabel(target, top);
  if (usage.length === 1) return `${sayDuration(total)} of TV today, all on ${name}.`;
  return `${sayDuration(total)} of TV today. The most: ${name}, ${sayDuration(topSeconds)}.`;
}

async function sayTimeLeft(target) {
  const status = await rulesStatus(displayAddress(target));
  const { rules } = status;
  const nowSeconds = Date.now() / 1000;
  const parts = [];
  if (nowSeconds < (rules.pausedUntil || 0)) parts.push("Rules are paused, so nothing closes for now.");
  const limits = [];
  for (const [appId, minutes] of Object.entries(rules.limits)) limits.push([await appLabel(target, appId), minutes * 60 - (status.usage[appId] || 0)]);
  limits.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  for (const [name, left] of limits) parts.push(left <= 0 ? `${name}: time's up for today.` : `${name}: ${sayDuration(left)} left.`);
  if (rules.bedtime.enabled) {
    const later = (rules.bedtime.extendUntil || 0) - nowSeconds;
    if (!status.bedtimeNow) parts.push(`Bedtime is at ${sayClock(rules.bedtime.start)}.`);
    else parts.push(later > 0 ? `Bedtime is put off for ${sayDuration(later)} more.` : "It's bedtime.");
  }
  return parts.join(" ") || "There's no daily limit or bedtime set.";
}

/** Lowercase words without accents or punctuation: "Pokémon TV!" -> "pokemon tv". */
export function foldWords(text) {
  return String(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}_\s+]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Do what a short phrase says on the TV. Returns a sentence saying what happened.
 * strict (the page's search box): only clear commands act, meaning a verb ("open ...", "watch ..."),
 * a number phrase ("sleep 30", "volume up 5", "hdmi 2"), or an app or scene's exact name.
 * Anything else, single button words like "home" included, is a search.
 */
export async function doPhrase(target, phrase, { strict = false } = {}) {
  if (/^\s*https?:\/\/\S+\s*$/i.test(phrase)) { // a link, say from the iPhone share sheet
    const result = await cast(target, cut(String(phrase).trim(), 4000));
    return `Playing it on the TV in ${result.app}.`;
  }
  const words = cut(foldWords(phrase), 120);
  if (!words) throw new ValueError("Say what to do, like pause, open Netflix or sleep 30.");
  if (!strict) {
    for (const [names, key, said] of PHRASE_KEYS) {
      if (names.includes(words)) {
        await press(target, key);
        return said;
      }
    }
    // Questions (Siri reads the answer out): what's on, screen time, time left.
    if (STATUS_ON_RE.test(words)) return sayWhatsOn(target);
    if (STATUS_TIME_RE.test(words)) return sayScreenTime(target);
    if (STATUS_LEFT_RE.test(words)) return sayTimeLeft(target);
  }
  let match = /^(?:volume |turn it )?(up|down) (\d{1,2})$/.exec(words);
  if (match) {
    const keys = Array(Math.min(Number(match[2]), 30)).fill(match[1] === "up" ? "VolumeUp" : "VolumeDown");
    await pressSequence(target, keys, 150);
    return `Volume ${match[1]} ${match[2]}.`;
  }
  match = /^(?:sleep timer|sleep in|sleep|turn off in|off in)(?: for)? (\d{1,3})(?: ?(?:m|min|mins|minute|minutes))?$/.exec(words);
  if (match) {
    const minutes = Number(match[1]);
    await setSleep(target, minutes);
    return minutes ? `The TV turns off in ${minutes} minutes.` : "Sleep timer off.";
  }
  if (["cancel sleep", "sleep off", "stop sleep timer", "cancel sleep timer"].includes(words)) {
    await setSleep(target, 0);
    return "Sleep timer off.";
  }
  if (["pause rules", "pause the rules", "rules off"].includes(words)) {
    const rules = await tvRules(displayAddress(target));
    if (!rulesEnforcing(rules)) return "No rules are on, so there's nothing to pause.";
    if (rules.pausedUntil > Date.now() / 1000 + 3600) return "Rules are already paused for longer than an hour.";
    await pauseRules(displayAddress(target), 60);
    return "Rules are paused for an hour.";
  }
  if (["resume rules", "rules on", "unpause rules"].includes(words)) {
    await pauseRules(displayAddress(target), 0);
    return "Rules are back on.";
  }
  match = /^(?:search for|search|find|look for|look up) (.+)$/.exec(words);
  if (match) {
    await search(target, match[1]);
    return `Searching the TV for ${match[1]}.`;
  }
  const opening = /^(?:open|launch|start|go to|switch to|put on|watch|run) (.+)$/.exec(words);
  const asked = (opening ? opening[1] : words).replace(/^the /, "");
  const loose = Boolean(opening) || !strict; // strict and no verb: exact names only

  const { scenes } = await tvSettings(displayAddress(target));
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if ((loose ? [asked, words] : [words]).includes(foldWords(scene.name ?? ""))) {
      runScene(target, scene).catch(() => { /* the page shows the TV's state soon enough */ });
      return `Running ${scene.name}.`;
    }
  }
  const apps = await listApps(target);
  const nameOf = (app) => foldWords(app.name);
  let choices = apps.filter((a) => nameOf(a) === asked);
  if (!choices.length && loose && pyLen(asked) >= 3) { // short words ("it", "tv") only match a whole name
    choices = apps.filter((a) => nameOf(a).startsWith(asked));
    if (!choices.length) choices = apps.filter((a) => nameOf(a).split(" ").includes(asked));
    if (!choices.length) choices = apps.filter((a) => nameOf(a).includes(asked));
  }
  if (!choices.length) {
    const port = /^hdmi ?(\d)$/.exec(asked);
    if (port) choices = apps.filter((a) => a.id === `tvinput.hdmi${port[1]}`);
  }
  if (choices.length) {
    const app = choices.reduce((best, a) => (pyLen(a.name) < pyLen(best.name) ? a : best));
    await launch(target, app.id);
    return `Opening ${app.name}.`;
  }
  if (opening && !strict) throw new ValueError(`There's no app or scene called ${asked} on this TV.`);
  const text = cut(opening ? opening[1] : String(phrase).trim(), 100);
  await search(target, text);
  return `Searching the TV for ${text}${/[.?!]$/.test(text) ? "" : "."}`;
}
