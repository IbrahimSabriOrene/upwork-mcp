import { SETTINGS, UPWORK } from "../config.js";
import { captureJson, findJobArray } from "../browser/interceptor.js";
import { humanPause, session } from "../browser/session.js";
import type { FeedType, Job, JobSearchFilters } from "../types.js";
import { jobIdFromUrl, jobUrl, normalizeJob } from "./normalize.js";

/** URLs that carry job data in their JSON body. */
const JOB_API_PATTERN = /\/api\/|\/graphql|search\/jobs|job-details|jobs\//i;

/** Build an Upwork job-search URL from a query + filters. */
export function buildSearchUrl(query: string, filters: JobSearchFilters = {}): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  params.set("sort", filters.sort === "relevance" ? "relevance" : "recency");
  if (filters.jobType === "hourly") params.set("t", "0");
  if (filters.jobType === "fixed") params.set("t", "1");
  if (filters.paymentVerifiedOnly) params.set("payment_verified", "1");
  if (filters.budgetMin != null || filters.budgetMax != null) {
    params.set(
      "amount",
      `${filters.budgetMin ?? 0}-${filters.budgetMax ?? ""}`,
    );
  }
  if (filters.clientSpentMin != null) {
    params.set("client_hires", ""); // placeholder; spend filter applied post-hoc
  }
  return `${UPWORK.searchPage}?${params.toString()}`;
}

/** Run a job search and return normalized, filtered, de-duplicated jobs. */
export async function searchJobs(
  query: string,
  filters: JobSearchFilters = {},
): Promise<Job[]> {
  const page = await session.getPage();
  const url = buildSearchUrl(query, filters);

  const captured = await captureJson(page, JOB_API_PATTERN, async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await humanPause();
    // Nudge lazy loading so the results XHR fires.
    await page.mouse.wheel(0, 1400).catch(() => {});
    await humanPause(800, 1600);
  });

  let jobs = extractJobs(captured);

  // DOM fallback if interception found nothing (e.g. SSR'd markup).
  if (jobs.length === 0) {
    jobs = await scrapeSearchDom(page);
  }

  jobs = applyClientSideFilters(jobs, filters);
  const limit = filters.limit ?? SETTINGS.defaultLimit;
  return dedupeById(jobs).slice(0, limit);
}

/** Fetch full detail for a single job by id or URL. */
export async function getJob(jobIdOrUrl: string): Promise<Job | null> {
  const id = jobIdFromUrl(jobIdOrUrl) ?? jobIdOrUrl;
  const page = await session.getPage();
  const url = jobUrl(id);

  const captured = await captureJson(page, JOB_API_PATTERN, async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await humanPause(900, 1800);
  });

  // Prefer a payload that carries this exact job.
  for (const c of captured) {
    const arr = findJobArray(c.json);
    if (arr) {
      for (const raw of arr) {
        const job = normalizeJob(raw);
        if (job && (job.id === id || job.id.includes(id))) return job;
      }
    }
    const single = normalizeJob(c.json);
    if (single && (single.id === id || single.id.includes(id))) return single;
  }

  // Fallback: whatever normalized job we can find, or a DOM scrape.
  const anyJob = extractJobs(captured)[0];
  if (anyJob) return anyJob;
  return scrapeJobDom(page, id);
}

/** Fetch the best-matches or most-recent feed. */
export async function listFeed(type: FeedType, limit?: number): Promise<Job[]> {
  const page = await session.getPage();
  const url = type === "best-matches" ? UPWORK.bestMatches : UPWORK.mostRecent;

  const captured = await captureJson(page, JOB_API_PATTERN, async () => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await humanPause();
    await page.mouse.wheel(0, 1200).catch(() => {});
    await humanPause(800, 1600);
  });

  let jobs = extractJobs(captured);
  if (jobs.length === 0) jobs = await scrapeSearchDom(page);
  return dedupeById(jobs).slice(0, limit ?? SETTINGS.defaultLimit);
}

/* ---------------------------- internals ---------------------------- */

function extractJobs(captured: { json: unknown }[]): Job[] {
  const out: Job[] = [];
  for (const c of captured) {
    const arr = findJobArray(c.json);
    if (!arr) continue;
    for (const raw of arr) {
      const job = normalizeJob(raw);
      if (job) out.push(job);
    }
  }
  return out;
}

function applyClientSideFilters(jobs: Job[], filters: JobSearchFilters): Job[] {
  return jobs.filter((j) => {
    if (filters.jobType && j.jobType !== filters.jobType) return false;
    if (filters.paymentVerifiedOnly && j.client?.paymentVerified === false) {
      return false;
    }
    if (
      filters.clientSpentMin != null &&
      (j.client?.totalSpent ?? 0) < filters.clientSpentMin
    ) {
      return false;
    }
    if (filters.budgetMin != null) {
      const value = j.fixedBudget ?? j.hourlyMax ?? j.hourlyMin ?? 0;
      if (value < filters.budgetMin) return false;
    }
    return true;
  });
}

function dedupeById(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const j of jobs) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
  return out;
}

/** Last-resort DOM scrape of a search/feed page. */
async function scrapeSearchDom(page: import("rebrowser-playwright").Page): Promise<Job[]> {
  const raw = await page
    .evaluate(() => {
      const cards = Array.from(
        document.querySelectorAll(
          '[data-test="JobTile"], article[data-ev-label], section[data-test="job-tile-list"] > *',
        ),
      );
      return cards.map((el) => {
        const q = (sel: string) =>
          (el.querySelector(sel)?.textContent ?? "").trim();
        const link = el.querySelector('a[href*="/jobs/"]') as HTMLAnchorElement | null;
        return {
          href: link?.href ?? "",
          title: q('[data-test="job-tile-title-link"], a[href*="/jobs/"]'),
          description: q('[data-test="UpCLineClamp JobDescription"], p'),
          type: q('[data-test="job-type-label"]'),
        };
      });
    })
    .catch(() => [] as { href: string; title: string; description: string; type: string }[]);

  const out: Job[] = [];
  for (const c of raw) {
    const id = jobIdFromUrl(c.href);
    if (!id || !c.title) continue;
    out.push({
      id,
      title: c.title,
      url: jobUrl(id),
      description: c.description,
      jobType: /hour/i.test(c.type) ? "hourly" : /fixed/i.test(c.type) ? "fixed" : "unknown",
      skills: [],
    });
  }
  return out;
}

/** Last-resort DOM scrape of a single job page. */
async function scrapeJobDom(
  page: import("rebrowser-playwright").Page,
  id: string,
): Promise<Job | null> {
  const data = await page
    .evaluate(() => {
      const q = (sel: string) =>
        (document.querySelector(sel)?.textContent ?? "").trim();
      return {
        title: q('h1, [data-test="job-title"]'),
        description: q('[data-test="Description"], [data-test="job-description-text"]'),
      };
    })
    .catch(() => null);
  if (!data || !data.title) return null;
  return {
    id,
    title: data.title,
    url: jobUrl(id),
    description: data.description,
    jobType: "unknown",
    skills: [],
  };
}
