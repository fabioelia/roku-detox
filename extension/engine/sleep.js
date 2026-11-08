// Sleep timer: turn the TV off in a few minutes. Kept as a Chrome alarm, so it fires even if the
// extension's worker was asleep (it runs while Chrome is open). Same API as roku_detox.py's.

import { press } from "./ecp.js";
import { event } from "./rules.js";
import { ValueError, displayAddress, parseTarget } from "./util.js";

const PREFIX = "detox-sleep:";
export const MAX_SLEEP_MINUTES = 240;

export async function sleepStatus(address) {
  const alarm = await chrome.alarms.get(PREFIX + address);
  return { until: alarm ? Math.floor(alarm.scheduledTime / 1000) : null };
}

/** Turn the TV off in `minutes` (0 cancels). */
export async function setSleep(target, minutes) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_SLEEP_MINUTES) {
    throw new ValueError(`Pick between 1 and ${MAX_SLEEP_MINUTES} minutes.`);
  }
  const address = displayAddress(target);
  await chrome.alarms.clear(PREFIX + address);
  if (minutes) await chrome.alarms.create(PREFIX + address, { when: Date.now() + minutes * 60_000 });
  return sleepStatus(address);
}

/** chrome.alarms.onAlarm: true when the alarm was a sleep timer (and the TV was told to turn off). */
export async function onSleepAlarm(alarm) {
  if (!alarm || typeof alarm.name !== "string" || !alarm.name.startsWith(PREFIX)) return false;
  const address = alarm.name.slice(PREFIX.length);
  try {
    await press(parseTarget(address), "PowerOff");
    await event(address, "Sleep timer: turned the TV off.");
  } catch (err) {
    await event(address, `Sleep timer couldn't turn the TV off: ${err.message}`, "alert");
  }
  return true;
}
