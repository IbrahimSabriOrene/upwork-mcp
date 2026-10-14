import notifier from "node-notifier";
import { getConfig, setConfig } from "../store/db.js";

/** Desktop-notification config, persisted in the config table. */
export function notificationsEnabled(): boolean {
  return getConfig("notify.enabled", "1") === "1";
}

export function setNotificationsEnabled(enabled: boolean): void {
  setConfig("notify.enabled", enabled ? "1" : "0");
}

/** Quiet hours as "HH:MM-HH:MM" local time, or "" for none. */
export function getQuietHours(): string {
  return getConfig("notify.quietHours", "");
}

export function setQuietHours(range: string): void {
  setConfig("notify.quietHours", range);
}

function inQuietHours(now = new Date()): boolean {
  const range = getQuietHours();
  const m = range.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const [, sh, sm, eh, em] = m;
  const start = Number(sh) * 60 + Number(sm);
  const end = Number(eh) * 60 + Number(em);
  const cur = now.getHours() * 60 + now.getMinutes();
  // Handle overnight ranges (e.g. 22:00-07:00).
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** Fire a desktop toast unless disabled or within quiet hours. */
export function notifyDesktop(title: string, message: string): void {
  if (!notificationsEnabled() || inQuietHours()) return;
  try {
    notifier.notify({
      title,
      message,
      sound: true,
      wait: false,
      appID: "Upwork MCP",
    });
  } catch {
    // Notifications are best-effort; never let them break a poll.
  }
}
