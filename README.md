# Upwork MCP

An event-based [Model Context Protocol](https://modelcontextprotocol.io) server that lets
Claude search and monitor Upwork jobs directly, using a **stealth Playwright** browser driven
against your own logged-in Upwork session.

- **Read + draft only.** It searches, monitors, fetches job detail, and drafts proposals.
  It never submits a proposal or sends a message — a human always clicks Submit.
- **Event-based.** Saved searches poll on an interval; new matching jobs raise **desktop
  notifications** and queue up for Claude to pull via `get_new_matches`.
- **Stealth.** Uses [`rebrowser-playwright`](https://github.com/rebrowser/rebrowser-playwright)
  with a persistent profile so you log in once and stay logged in.

> ⚠️ **Terms-of-service / account risk.** Automating a logged-in Upwork session is against
> Upwork's Terms of Service and can get your account flagged or banned. This project keeps the
> risk as low as possible (one persistent human-logged-in session, conservative jittered poll
> intervals, no write/submit actions, an easy kill switch) but the risk is real and is yours to
> accept. Use a sensible poll interval and don't hammer the site.

## Requirements

- Node.js 20+ (tested on 22)
- Google Chrome installed is preferred (the browser uses the real Chrome channel when present
  and falls back to bundled Chromium otherwise)

## Install & build

```bash
npm install        # installs deps and downloads Chromium
npm run build      # compiles TypeScript to dist/
```

## Register with Claude

Copy `.mcp.json.example` into your client config and adjust the absolute path to `dist/index.js`.

- **Claude Code:** add the `mcpServers.upwork` block to your project's `.mcp.json` (or run
  `claude mcp add`).
- **Claude Desktop:** merge the block into `claude_desktop_config.json`
  (Settings → Developer → Edit Config).

Keep `UPWORK_MCP_HEADLESS=false` so a window can appear for manual login.

## First run — log in

1. Ask Claude to call **`upwork_open_login`**. A browser window opens at Upwork's login page.
2. Sign in manually, including any 2FA. The session is saved to the persistent profile under
   `data/browser-profile/`.
3. Ask Claude to call **`upwork_login_status`** — it should report `loggedIn: true`.

## Tools

| Tool | What it does |
| --- | --- |
| `upwork_login_status` | Report whether the session is signed in. |
| `upwork_open_login` | Open a window to sign in manually. |
| `search_jobs` | Search jobs by query + filters. |
| `get_job` | Full detail for one job (client history, connects). |
| `list_feed` | `best-matches` or `most-recent` feed. |
| `save_search` | Register a monitored search (polls on an interval). |
| `list_saved_searches` / `delete_saved_search` | Manage saved searches. |
| `poll_now` | Force an immediate poll; return new jobs. |
| `get_new_matches` | Drain queued new-job events for Claude. |
| `set_notification_config` | Toggle desktop toasts / set quiet hours. |
| `draft_proposal` | Build a proposal scaffold + brief (optionally save the body). |
| `list_drafts` / `get_draft` | Manage saved proposal drafts. |

## Example flow

```
upwork_login_status            → { loggedIn: true }
search_jobs "react native dev" → normalized job list
save_search name:"rn" query:"react native developer" intervalMinutes:15
  → polled every ~15 min; desktop toast + queue on new jobs
get_new_matches                → drains the queue (dedup: won't repeat)
draft_proposal <jobUrl>        → scaffold; Claude writes the cover letter
draft_proposal <jobUrl> save:"<final letter>"  → stores the draft (never submits)
```

## Configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `UPWORK_MCP_HEADLESS` | `false` | Run the browser headless. Keep `false` to allow login. |
| `UPWORK_MCP_DATA_DIR` | `<pkg>/data` | Where the SQLite db + browser profile live. |
| `UPWORK_MCP_DEFAULT_INTERVAL` | `15` | Default saved-search poll interval (minutes). |
| `UPWORK_MCP_MIN_INTERVAL` | `5` | Hard floor on poll interval (minutes). |
| `UPWORK_MCP_POLL_JITTER` | `45` | +/- jitter added to each poll (seconds). |
| `UPWORK_MCP_LOCALE` / `UPWORK_MCP_TZ` | `en-US` / `America/New_York` | Browser fingerprint. |

## How it works

- **`src/browser/session.ts`** — one persistent stealth browser context; `isLoggedIn()` probe.
- **`src/browser/interceptor.ts`** — captures Upwork's own JSON/GraphQL XHR responses (more
  robust than DOM scraping); DOM scrape is the fallback.
- **`src/scraper/`** — `jobs.ts` (search / detail / feeds) + `normalize.ts` (raw → `Job`).
- **`src/events/`** — `scheduler.ts` (jittered per-search timers) → `queue.ts` (dedup against
  SQLite `seen_jobs`, enqueue) → `notify.ts` (desktop toast).
- **`src/store/db.ts`** — SQLite: saved searches, seen jobs, events, drafts, config.
- **`src/proposals/draft.ts`** — assembles a scaffold + brief for Claude to write; never submits.

## Kill switch

- `set_notification_config { enabled: false }` silences toasts.
- `delete_saved_search` stops a monitor.
- Stopping the MCP server halts all polling and closes the browser.

## Notes on stealth robustness

If Upwork's bot defenses tighten, options in order of effort: raise the poll interval, swap
`rebrowser-playwright` for [`patchright`](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright),
or route through a residential proxy. The scraper prefers intercepted JSON over CSS selectors
specifically so it survives Upwork UI redesigns.
