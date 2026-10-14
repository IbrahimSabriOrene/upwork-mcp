import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { session } from "./browser/session.js";
import { getJob, listFeed, searchJobs } from "./scraper/jobs.js";
import {
  deleteSavedSearch,
  getDraft,
  getSavedSearch,
  listDrafts,
  listSavedSearches,
  upsertSavedSearch,
} from "./store/db.js";
import { drainEvents, runSavedSearch } from "./events/queue.js";
import { scheduler } from "./events/scheduler.js";
import {
  getQuietHours,
  notificationsEnabled,
  setNotificationsEnabled,
  setQuietHours,
} from "./events/notify.js";
import { buildDraftScaffold, saveDraft } from "./proposals/draft.js";
import { SETTINGS } from "./config.js";
import type { JobSearchFilters } from "./types.js";

/** zod shape for search filters, reused by search_jobs and save_search. */
const filtersShape = {
  jobType: z.enum(["hourly", "fixed"]).optional(),
  budgetMin: z.number().optional(),
  budgetMax: z.number().optional(),
  experienceLevel: z.array(z.string()).optional(),
  paymentVerifiedOnly: z.boolean().optional(),
  clientSpentMin: z.number().optional(),
  sort: z.enum(["recency", "relevance"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
};

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function text(msg: string) {
  return { content: [{ type: "text" as const, text: msg }] };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "upwork-mcp",
    version: "0.1.0",
  });

  /* --------------------------- session / auth --------------------------- */

  server.registerTool(
    "upwork_login_status",
    {
      title: "Check Upwork login status",
      description:
        "Report whether the persistent browser session is signed in to Upwork.",
      inputSchema: {},
    },
    async () => json(await session.checkLogin()),
  );

  server.registerTool(
    "upwork_open_login",
    {
      title: "Open Upwork login window",
      description:
        "Open a visible browser window at Upwork's login page so you can sign in manually " +
        "(credentials and 2FA are never handled programmatically).",
      inputSchema: {},
    },
    async () => json(await session.openLogin()),
  );

  /* ------------------------------- read --------------------------------- */

  server.registerTool(
    "search_jobs",
    {
      title: "Search Upwork jobs",
      description:
        "Run an Upwork job search and return normalized job results. Requires an active " +
        "logged-in session.",
      inputSchema: {
        query: z.string().describe("Search keywords, e.g. 'react native developer'."),
        filters: z.object(filtersShape).optional(),
      },
    },
    async ({ query, filters }) => {
      const jobs = await searchJobs(query, (filters ?? {}) as JobSearchFilters);
      return json({ count: jobs.length, jobs });
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get Upwork job detail",
      description:
        "Fetch full detail for a single job by its id (~0...) or full job URL, including " +
        "client history and connects cost when available.",
      inputSchema: {
        jobIdOrUrl: z.string().describe("Job ciphertext id or full https://www.upwork.com/jobs/ URL."),
      },
    },
    async ({ jobIdOrUrl }) => {
      const job = await getJob(jobIdOrUrl);
      return job ? json(job) : text(`No job found for "${jobIdOrUrl}".`);
    },
  );

  server.registerTool(
    "list_feed",
    {
      title: "List an Upwork job feed",
      description: "Fetch the 'best-matches' or 'most-recent' job feed for your account.",
      inputSchema: {
        type: z.enum(["best-matches", "most-recent"]),
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ type, limit }) => {
      const jobs = await listFeed(type, limit);
      return json({ count: jobs.length, jobs });
    },
  );

  /* -------------------------- monitoring / events ----------------------- */

  server.registerTool(
    "save_search",
    {
      title: "Save a monitored search",
      description:
        "Register (or update) a saved search that is polled on an interval; new matching " +
        "jobs raise desktop notifications and are queued for get_new_matches.",
      inputSchema: {
        name: z.string().describe("Unique name for this saved search."),
        query: z.string(),
        filters: z.object(filtersShape).optional(),
        intervalMinutes: z
          .number()
          .int()
          .min(SETTINGS.minIntervalMinutes)
          .optional()
          .describe(`Poll interval; minimum ${SETTINGS.minIntervalMinutes} min.`),
      },
    },
    async ({ name, query, filters, intervalMinutes }) => {
      const interval = Math.max(
        intervalMinutes ?? SETTINGS.defaultIntervalMinutes,
        SETTINGS.minIntervalMinutes,
      );
      upsertSavedSearch({
        name,
        query,
        filters: (filters ?? {}) as JobSearchFilters,
        intervalMinutes: interval,
        createdAt: getSavedSearch(name)?.createdAt ?? new Date().toISOString(),
        enabled: true,
      });
      scheduler.schedule(name, interval);
      return text(
        `Saved search "${name}" is now monitored every ~${interval} min. ` +
          `First poll will run shortly.`,
      );
    },
  );

  server.registerTool(
    "list_saved_searches",
    {
      title: "List saved searches",
      description: "List all monitored saved searches and their status.",
      inputSchema: {},
    },
    async () => json(listSavedSearches()),
  );

  server.registerTool(
    "delete_saved_search",
    {
      title: "Delete a saved search",
      description: "Stop monitoring a saved search and forget its seen-job history.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      scheduler.unschedule(name);
      const ok = deleteSavedSearch(name);
      return text(ok ? `Deleted saved search "${name}".` : `No saved search "${name}".`);
    },
  );

  server.registerTool(
    "poll_now",
    {
      title: "Poll saved searches now",
      description:
        "Force an immediate poll of one saved search (by name) or all of them, returning " +
        "any newly-found jobs.",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => {
      const targets = name ? [name] : listSavedSearches().map((s) => s.name);
      if (targets.length === 0) return text("No saved searches to poll.");
      const results = [];
      for (const t of targets) results.push(await runSavedSearch(t));
      return json(results);
    },
  );

  server.registerTool(
    "get_new_matches",
    {
      title: "Get new matched jobs",
      description:
        "Drain the queue of new jobs found by monitored searches since you last checked. " +
        "Marks them delivered so a later call won't repeat them.",
      inputSchema: {
        since: z.string().optional().describe("Optional ISO timestamp lower bound."),
      },
    },
    async ({ since }) => {
      const events = drainEvents(since);
      return json({ count: events.length, matches: events });
    },
  );

  server.registerTool(
    "set_notification_config",
    {
      title: "Configure desktop notifications",
      description:
        "Enable/disable desktop notifications and optionally set quiet hours (HH:MM-HH:MM).",
      inputSchema: {
        enabled: z.boolean().optional(),
        quietHours: z
          .string()
          .regex(/^$|^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/)
          .optional()
          .describe('e.g. "22:00-07:00", or "" to clear.'),
      },
    },
    async ({ enabled, quietHours }) => {
      if (enabled !== undefined) setNotificationsEnabled(enabled);
      if (quietHours !== undefined) setQuietHours(quietHours);
      return json({
        enabled: notificationsEnabled(),
        quietHours: getQuietHours() || null,
      });
    },
  );

  /* ------------------------------- drafts ------------------------------- */

  server.registerTool(
    "draft_proposal",
    {
      title: "Draft a proposal (no submit)",
      description:
        "Build a proposal scaffold + writing brief for a job so you can compose a tailored " +
        "cover letter. NEVER submits to Upwork — a human always clicks Submit. Optionally " +
        "pass the finished body back via 'save' to store it.",
      inputSchema: {
        jobIdOrUrl: z.string(),
        tone: z.string().optional(),
        resumeContext: z.string().optional(),
        save: z
          .string()
          .optional()
          .describe("If provided, persist this finished proposal body as a draft."),
      },
    },
    async ({ jobIdOrUrl, tone, resumeContext, save }) => {
      const job = await getJob(jobIdOrUrl);
      if (!job) return text(`No job found for "${jobIdOrUrl}".`);
      if (save) {
        const draft = saveDraft(job, save, tone);
        return json({ saved: true, draft });
      }
      return text(buildDraftScaffold(job, { tone, resumeContext }));
    },
  );

  server.registerTool(
    "list_drafts",
    {
      title: "List saved proposal drafts",
      description: "List proposal drafts saved via draft_proposal.",
      inputSchema: {},
    },
    async () => json(listDrafts()),
  );

  server.registerTool(
    "get_draft",
    {
      title: "Get a saved proposal draft",
      description: "Fetch a saved proposal draft by id.",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      const draft = getDraft(id);
      return draft ? json(draft) : text(`No draft #${id}.`);
    },
  );

  return server;
}
