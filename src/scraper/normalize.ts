import { UPWORK } from "../config.js";
import type { ClientInfo, Job, JobType } from "../types.js";

/**
 * Map a raw Upwork job record (from an intercepted JSON payload) into our
 * stable Job shape. Upwork uses several field spellings across endpoints, so
 * every getter tries multiple candidate paths and degrades gracefully.
 */
export function normalizeJob(raw: unknown): Job | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;

  const id = str(r.ciphertext ?? r.uid ?? r.id ?? r.jobTile?.job?.ciphertext);
  const title = str(r.title ?? r.jobTile?.job?.title);
  if (!id || !title) return null;

  const description = str(
    r.description ?? r.snippet ?? r.jobTile?.job?.description ?? "",
  );

  const jobType = normalizeJobType(
    r.type ?? r.jobType ?? r.job?.type ?? r.hourlyBudget != null,
  );

  const budget = r.budget ?? r.amount ?? r.job?.budget;
  const fixedBudget = num(budget?.amount ?? budget?.rawValue ?? budget);
  const hourlyMin = num(r.hourlyBudgetMin ?? r.hourlyBudget?.min ?? r.rateMin);
  const hourlyMax = num(r.hourlyBudgetMax ?? r.hourlyBudget?.max ?? r.rateMax);

  const skills = extractSkills(r.skills ?? r.attrs ?? r.ontologySkills);

  const client = normalizeClient(r.client ?? r.buyer ?? r.clientInfo);

  return {
    id,
    title,
    url: jobUrl(id),
    description,
    jobType,
    fixedBudget: jobType === "fixed" ? fixedBudget : undefined,
    hourlyMin: jobType === "hourly" ? hourlyMin : undefined,
    hourlyMax: jobType === "hourly" ? hourlyMax : undefined,
    connects: num(r.connectPrice ?? r.connects ?? r.proposalsTier?.connects),
    skills,
    postedAt: normalizeDate(r.createdOn ?? r.publishedOn ?? r.postedOn ?? r.createTime),
    experienceLevel: str(
      r.contractorTier ?? r.tierText ?? r.experienceLevel ?? "",
    ) || undefined,
    duration: str(r.durationLabel ?? r.engagementDuration ?? r.duration ?? "") || undefined,
    proposals: str(r.totalApplicants ?? r.proposalsTier ?? r.applied ?? "") || undefined,
    client,
  };
}

export function jobUrl(id: string): string {
  return `${UPWORK.base}/jobs/${id}`;
}

/** Extract the ciphertext id from a full job URL. */
export function jobIdFromUrl(input: string): string | null {
  const m = input.match(/(~[0-9a-z]+)/i) ?? input.match(/jobs\/([^/?#]+)/i);
  return m ? m[1]! : null;
}

function normalizeClient(raw: unknown): ClientInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, any>;
  const info: ClientInfo = {
    country: str(c.location?.country ?? c.country ?? "") || undefined,
    totalSpent: num(c.totalSpent ?? c.stats?.totalCharges ?? c.totalCharges),
    paymentVerified:
      typeof c.paymentVerificationStatus === "string"
        ? /verified/i.test(c.paymentVerificationStatus)
        : bool(c.paymentVerified ?? c.isPaymentMethodVerified),
    rating: num(c.totalFeedback ?? c.rating ?? c.stats?.score),
    totalHires: num(c.totalHires ?? c.stats?.totalHires ?? c.hires),
    memberSince: normalizeDate(c.memberSince ?? c.creationDate),
  };
  // Drop entirely-empty client objects.
  return Object.values(info).some((v) => v !== undefined) ? info : undefined;
}

function normalizeJobType(v: unknown): JobType {
  if (v === true) return "hourly";
  const s = String(v ?? "").toLowerCase();
  if (s.includes("hour") || s === "2") return "hourly";
  if (s.includes("fixed") || s.includes("budget") || s === "1") return "fixed";
  return "unknown";
}

function extractSkills(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object") {
        const o = s as Record<string, any>;
        return String(o.name ?? o.prettyName ?? o.prefLabel ?? o.skill ?? "");
      }
      return "";
    })
    .filter((s): s is string => s.length > 0);
}

function normalizeDate(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return new Date(v).toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (v == null) return undefined;
  return /^(true|1|yes)$/i.test(String(v));
}
