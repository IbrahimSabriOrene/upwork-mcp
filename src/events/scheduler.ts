import { SETTINGS } from "../config.js";
import { listSavedSearches } from "../store/db.js";
import { runSavedSearch } from "./queue.js";

/**
 * Per-search timers. We use individual jittered setTimeout chains rather than
 * cron so each search keeps its own cadence and we can add randomness to every
 * run (looking less robotic and spreading load).
 */
class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = false;

  /** Load all enabled saved searches and begin polling them. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const s of listSavedSearches()) {
      if (s.enabled) this.schedule(s.name, s.intervalMinutes);
    }
  }

  /** (Re)schedule a single search. Call after save_search. */
  schedule(name: string, intervalMinutes: number): void {
    this.unschedule(name);
    const clamped = Math.max(intervalMinutes, SETTINGS.minIntervalMinutes);
    const tick = async () => {
      try {
        await runSavedSearch(name);
      } catch (err) {
        // A failing poll (logged out, network, block page) must not kill the
        // loop; back off and try again next interval.
        console.error(`[scheduler] poll "${name}" failed:`, (err as Error).message);
      } finally {
        if (this.running && this.timers.has(name)) {
          this.timers.set(name, setTimeout(tick, this.nextDelay(clamped)));
        }
      }
    };
    // First run is also jittered so all searches don't fire at once on startup.
    this.timers.set(name, setTimeout(tick, this.nextDelay(clamped)));
  }

  unschedule(name: string): void {
    const t = this.timers.get(name);
    if (t) {
      clearTimeout(t);
      this.timers.delete(name);
    }
  }

  stopAll(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** interval in ms +/- jitter. */
  private nextDelay(intervalMinutes: number): number {
    const base = intervalMinutes * 60_000;
    const jitter = (Math.random() * 2 - 1) * SETTINGS.pollJitterSeconds * 1000;
    return Math.max(60_000, base + jitter);
  }
}

export const scheduler = new Scheduler();
