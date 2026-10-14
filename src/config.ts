import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root of the installed package (parent of dist/). */
const packageRoot = path.resolve(__dirname, "..");

/**
 * Directory for all persistent state (SQLite db + browser profile).
 * Override with UPWORK_MCP_DATA_DIR. Defaults to <package>/data.
 */
export const DATA_DIR =
  process.env.UPWORK_MCP_DATA_DIR ?? path.join(packageRoot, "data");

/** Persistent browser profile so the user logs in once and stays logged in. */
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, "browser-profile");

/** SQLite database file. */
export const DB_PATH = path.join(DATA_DIR, "upwork-mcp.db");

/** Upwork base URLs. */
export const UPWORK = {
  base: "https://www.upwork.com",
  login: "https://www.upwork.com/ab/account-security/login",
  searchPage: "https://www.upwork.com/nx/search/jobs/",
  bestMatches: "https://www.upwork.com/nx/find-work/best-matches",
  mostRecent: "https://www.upwork.com/nx/find-work/most-recent",
} as const;

/** Behaviour knobs, all overridable via env. */
export const SETTINGS = {
  /** Run the browser headless. Default false (less detectable + allows manual login). */
  headless: envBool("UPWORK_MCP_HEADLESS", false),
  /** Default poll interval for saved searches (minutes) when not specified. */
  defaultIntervalMinutes: envNum("UPWORK_MCP_DEFAULT_INTERVAL", 15),
  /** Minimum allowed poll interval to avoid hammering Upwork (minutes). */
  minIntervalMinutes: envNum("UPWORK_MCP_MIN_INTERVAL", 5),
  /** Jitter added to each scheduled poll, +/- this many seconds. */
  pollJitterSeconds: envNum("UPWORK_MCP_POLL_JITTER", 45),
  /** Default max results per search. */
  defaultLimit: envNum("UPWORK_MCP_DEFAULT_LIMIT", 30),
  /** Locale/timezone for the browser fingerprint. */
  locale: process.env.UPWORK_MCP_LOCALE ?? "en-US",
  timezone: process.env.UPWORK_MCP_TZ ?? "America/New_York",
} as const;

export function ensureDataDir(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
