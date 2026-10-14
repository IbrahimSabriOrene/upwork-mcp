import Database from "better-sqlite3";
import { DB_PATH, ensureDataDir } from "../config.js";
import type {
  Job,
  JobSearchFilters,
  MatchEvent,
  ProposalDraft,
  SavedSearch,
} from "../types.js";

let db: Database.Database | null = null;

/** Lazily open the database and create the schema. */
export function getDb(): Database.Database {
  if (db) return db;
  ensureDataDir();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      name            TEXT PRIMARY KEY,
      query           TEXT NOT NULL,
      filters_json    TEXT NOT NULL DEFAULT '{}',
      interval_min    INTEGER NOT NULL,
      created_at      TEXT NOT NULL,
      last_run_at     TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS seen_jobs (
      search_name     TEXT NOT NULL,
      job_id          TEXT NOT NULL,
      first_seen_at   TEXT NOT NULL,
      PRIMARY KEY (search_name, job_id)
    );

    CREATE TABLE IF NOT EXISTS match_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      search_name     TEXT NOT NULL,
      job_json        TEXT NOT NULL,
      seen_at         TEXT NOT NULL,
      delivered       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id          TEXT NOT NULL,
      job_url         TEXT NOT NULL,
      job_title       TEXT NOT NULL,
      body            TEXT NOT NULL,
      tone            TEXT,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      key             TEXT PRIMARY KEY,
      value           TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_delivered ON match_events (delivered, id);
  `);
}

/* ------------------------------- config ------------------------------- */

export function getConfig(key: string, fallback: string): string {
  const row = getDb()
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/* --------------------------- saved searches --------------------------- */

export function upsertSavedSearch(s: SavedSearch): void {
  getDb()
    .prepare(
      `INSERT INTO saved_searches (name, query, filters_json, interval_min, created_at, last_run_at, enabled)
       VALUES (@name, @query, @filters_json, @interval_min, @created_at, @last_run_at, @enabled)
       ON CONFLICT(name) DO UPDATE SET
         query = excluded.query,
         filters_json = excluded.filters_json,
         interval_min = excluded.interval_min,
         enabled = excluded.enabled`,
    )
    .run({
      name: s.name,
      query: s.query,
      filters_json: JSON.stringify(s.filters ?? {}),
      interval_min: s.intervalMinutes,
      created_at: s.createdAt,
      last_run_at: s.lastRunAt ?? null,
      enabled: s.enabled ? 1 : 0,
    });
}

export function listSavedSearches(): SavedSearch[] {
  const rows = getDb()
    .prepare("SELECT * FROM saved_searches ORDER BY created_at ASC")
    .all() as SavedSearchRow[];
  return rows.map(rowToSavedSearch);
}

export function getSavedSearch(name: string): SavedSearch | undefined {
  const row = getDb()
    .prepare("SELECT * FROM saved_searches WHERE name = ?")
    .get(name) as SavedSearchRow | undefined;
  return row ? rowToSavedSearch(row) : undefined;
}

export function deleteSavedSearch(name: string): boolean {
  const info = getDb()
    .prepare("DELETE FROM saved_searches WHERE name = ?")
    .run(name);
  getDb().prepare("DELETE FROM seen_jobs WHERE search_name = ?").run(name);
  return info.changes > 0;
}

export function markSearchRun(name: string, at: string): void {
  getDb()
    .prepare("UPDATE saved_searches SET last_run_at = ? WHERE name = ?")
    .run(at, name);
}

interface SavedSearchRow {
  name: string;
  query: string;
  filters_json: string;
  interval_min: number;
  created_at: string;
  last_run_at: string | null;
  enabled: number;
}

function rowToSavedSearch(r: SavedSearchRow): SavedSearch {
  return {
    name: r.name,
    query: r.query,
    filters: safeParse<JobSearchFilters>(r.filters_json, {}),
    intervalMinutes: r.interval_min,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at ?? undefined,
    enabled: r.enabled === 1,
  };
}

/* ------------------------------ seen jobs ----------------------------- */

/**
 * Insert job ids as seen for a search. Returns the ids that were NOT seen
 * before (i.e. genuinely new for this search).
 */
export function markSeenReturningNew(
  searchName: string,
  jobIds: string[],
  at: string,
): string[] {
  const d = getDb();
  const insert = d.prepare(
    "INSERT OR IGNORE INTO seen_jobs (search_name, job_id, first_seen_at) VALUES (?, ?, ?)",
  );
  const newIds: string[] = [];
  const tx = d.transaction((ids: string[]) => {
    for (const id of ids) {
      const info = insert.run(searchName, id, at);
      if (info.changes > 0) newIds.push(id);
    }
  });
  tx(jobIds);
  return newIds;
}

/* ---------------------------- match events ---------------------------- */

export function enqueueEvent(searchName: string, job: Job, at: string): number {
  const info = getDb()
    .prepare(
      "INSERT INTO match_events (search_name, job_json, seen_at, delivered) VALUES (?, ?, ?, 0)",
    )
    .run(searchName, JSON.stringify(job), at);
  return Number(info.lastInsertRowid);
}

/** Return undelivered events (optionally since an ISO timestamp). */
export function getUndeliveredEvents(since?: string): MatchEvent[] {
  const rows = since
    ? (getDb()
        .prepare(
          "SELECT * FROM match_events WHERE delivered = 0 AND seen_at >= ? ORDER BY id ASC",
        )
        .all(since) as MatchEventRow[])
    : (getDb()
        .prepare("SELECT * FROM match_events WHERE delivered = 0 ORDER BY id ASC")
        .all() as MatchEventRow[]);
  return rows.map(rowToEvent);
}

export function markEventsDelivered(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  getDb()
    .prepare(`UPDATE match_events SET delivered = 1 WHERE id IN (${placeholders})`)
    .run(...ids);
}

interface MatchEventRow {
  id: number;
  search_name: string;
  job_json: string;
  seen_at: string;
  delivered: number;
}

function rowToEvent(r: MatchEventRow): MatchEvent {
  return {
    id: r.id,
    searchName: r.search_name,
    job: JSON.parse(r.job_json) as Job,
    seenAt: r.seen_at,
    delivered: r.delivered === 1,
  };
}

/* ------------------------------- drafts ------------------------------- */

export function insertDraft(
  d: Omit<ProposalDraft, "id">,
): ProposalDraft {
  const info = getDb()
    .prepare(
      "INSERT INTO drafts (job_id, job_url, job_title, body, tone, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(d.jobId, d.jobUrl, d.jobTitle, d.body, d.tone ?? null, d.createdAt);
  return { ...d, id: Number(info.lastInsertRowid) };
}

export function listDrafts(): ProposalDraft[] {
  const rows = getDb()
    .prepare("SELECT * FROM drafts ORDER BY created_at DESC")
    .all() as DraftRow[];
  return rows.map(rowToDraft);
}

export function getDraft(id: number): ProposalDraft | undefined {
  const row = getDb().prepare("SELECT * FROM drafts WHERE id = ?").get(id) as
    | DraftRow
    | undefined;
  return row ? rowToDraft(row) : undefined;
}

interface DraftRow {
  id: number;
  job_id: string;
  job_url: string;
  job_title: string;
  body: string;
  tone: string | null;
  created_at: string;
}

function rowToDraft(r: DraftRow): ProposalDraft {
  return {
    id: r.id,
    jobId: r.job_id,
    jobUrl: r.job_url,
    jobTitle: r.job_title,
    body: r.body,
    tone: r.tone ?? undefined,
    createdAt: r.created_at,
  };
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
