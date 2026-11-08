// Plain phrases ("pause", "open Netflix", "HDMI 2", "game time", "sleep 30"): the same rules as
// do_phrase() in roku_detox.py, for the page's search box (typed or spoken).

import { launch, listApps, press, pressSequence, runScene, search } from "./ecp.js";
import { setSleep } from "./sleep.js";
import { tvSettings } from "./store.js";
import { ValueError, displayAddress } from "./util.js";

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

/** Lowercase words without accents or punctuation: "Pokémon TV!" -> "pokemon tv". */
export function foldWords(text) {
  return String(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}_\s+]/gu, " ").split(/\s+/).filter(Boolean).join(" ");
}

/** Do what a short phrase says on the TV. Returns a sentence saying what happened. */
export async function doPhrase(target, phrase) {
  const words = foldWords(phrase).slice(0, 120);
  if (!words) throw new ValueError("Say what to do, like pause, open Netflix or sleep 30.");
  for (const [names, key, said] of PHRASE_KEYS) {
    if (names.includes(words)) {
      await press(target, key);
      return said;
    }
  }
  let match = /^(?:volume |turn it )?(up|down) (\d{1,2})$/.exec(words);
  if (match) {
    const keys = Array(Math.min(Number(match[2]), 30)).fill(match[1] === "up" ? "VolumeUp" : "VolumeDown");
    await pressSequence(target, keys, 150);
    return `Volume ${match[1]} ${match[2]}.`;
  }
  match = /^(?:sleep|sleep timer|turn off in|off in|sleep in)(?: for)? (\d{1,3})(?: ?(?:m|min|mins|minute|minutes))?$/.exec(words);
  if (match) {
    const minutes = Number(match[1]);
    await setSleep(target, minutes);
    return minutes ? `The TV turns off in ${minutes} minutes.` : "Sleep timer off.";
  }
  if (["cancel sleep", "sleep off", "stop sleep timer", "cancel sleep timer"].includes(words)) {
    await setSleep(target, 0);
    return "Sleep timer off.";
  }
  match = /^(?:search|search for|find|look for|look up) (.+)$/.exec(words);
  if (match) {
    await search(target, match[1]);
    return `Searching the TV for ${match[1]}.`;
  }
  const opening = /^(?:open|launch|start|go to|switch to|put on|watch|run) (.+)$/.exec(words);
  const asked = (opening ? opening[1] : words).replace(/^the /, "");

  const { scenes } = await tvSettings(displayAddress(target));
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if ([asked, words].includes(foldWords(scene.name ?? ""))) {
      runScene(target, scene).catch(() => { /* the page shows the TV's state soon enough */ });
      return `Running ${scene.name}.`;
    }
  }
  const apps = await listApps(target);
  const nameOf = (app) => foldWords(app.name);
  let choices = apps.filter((a) => nameOf(a) === asked);
  if (!choices.length) choices = apps.filter((a) => nameOf(a).startsWith(asked));
  if (!choices.length) choices = apps.filter((a) => nameOf(a).split(" ").includes(asked));
  if (!choices.length) choices = apps.filter((a) => nameOf(a).includes(asked));
  if (!choices.length) {
    const port = /^hdmi ?(\d)$/.exec(asked);
    if (port) choices = apps.filter((a) => a.id === `tvinput.hdmi${port[1]}`);
  }
  if (choices.length) {
    const app = choices.reduce((best, a) => (a.name.length < best.name.length ? a : best));
    await launch(target, app.id);
    return `Opening ${app.name}.`;
  }
  if (opening) throw new ValueError(`There's no app or scene called ${asked} on this TV.`);
  const text = String(phrase).trim().slice(0, 100);
  await search(target, text);
  return `Searching the TV for ${text}.`;
}
