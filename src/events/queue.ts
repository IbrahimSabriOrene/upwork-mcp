import { searchJobs } from "../scraper/jobs.js";
import {
  enqueueEvent,
  getSavedSearch,
  getUndeliveredEvents,
  markEventsDelivered,
  markSearchRun,
  markSeenReturningNew,
} from "../store/db.js";
import type { Job, MatchEvent } from "../types.js";
import { notifyDesktop } from "./notify.js";

export interface PollResult {
  searchName: string;
  totalFound: number;
  newJobs: Job[];
}

/**
 * Run one saved search, diff against previously-seen jobs, enqueue events for
 * anything new, and fire a desktop notification. This is the core of the
 * event-based behaviour and is shared by both the scheduler and poll_now.
 */
export async function runSavedSearch(name: string): Promise<PollResult> {
  const search = getSavedSearch(name);
  if (!search) throw new Error(`No saved search named "${name}".`);

  const jobs = await searchJobs(search.query, search.filters);
  const now = new Date().toISOString();
  markSearchRun(name, now);

  const newIds = markSeenReturningNew(name, jobs.map((j) => j.id), now);
  const newSet = new Set(newIds);
  const newJobs = jobs.filter((j) => newSet.has(j.id));

  for (const job of newJobs) {
    enqueueEvent(name, job, now);
  }

  if (newJobs.length > 0) {
    const first = newJobs[0]!;
    const extra = newJobs.length > 1 ? ` (+${newJobs.length - 1} more)` : "";
    notifyDesktop(
      `Upwork: ${newJobs.length} new job${newJobs.length > 1 ? "s" : ""} — ${name}`,
      `${first.title}${extra}`,
    );
  }

  return { searchName: name, totalFound: jobs.length, newJobs };
}

/**
 * Drain queued match events for Claude. Marks them delivered so a second call
 * returns nothing (unless new jobs have since arrived).
 */
export function drainEvents(since?: string): MatchEvent[] {
  const events = getUndeliveredEvents(since);
  markEventsDelivered(events.map((e) => e.id));
  return events;
}
