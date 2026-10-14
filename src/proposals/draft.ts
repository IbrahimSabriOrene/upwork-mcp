import { insertDraft } from "../store/db.js";
import type { Job, ProposalDraft } from "../types.js";

export interface DraftOptions {
  /** e.g. "professional", "friendly", "concise". */
  tone?: string;
  /** Freelancer's résumé / portfolio / positioning to weave in. */
  resumeContext?: string;
}

/**
 * Assemble a proposal draft for a job. This intentionally does NOT call an LLM
 * itself — Claude (the MCP client) is the writer. We return a structured
 * scaffold plus all the job context Claude needs so it can produce the final
 * cover letter, then persist whatever gets saved. Nothing is ever submitted to
 * Upwork.
 */
export function buildDraftScaffold(job: Job, opts: DraftOptions = {}): string {
  const lines: string[] = [];
  const budget = describeBudget(job);

  lines.push(`# Proposal draft — ${job.title}`);
  lines.push(`Job: ${job.url}`);
  lines.push(`Type: ${job.jobType}${budget ? ` · ${budget}` : ""}`);
  if (job.connects != null) lines.push(`Connects to apply: ${job.connects}`);
  if (job.skills.length) lines.push(`Skills: ${job.skills.join(", ")}`);
  if (job.client) {
    const c = job.client;
    const bits = [
      c.country && `country: ${c.country}`,
      c.totalSpent != null && `spent: $${c.totalSpent}`,
      c.paymentVerified != null && `payment ${c.paymentVerified ? "verified" : "unverified"}`,
      c.rating != null && `rating: ${c.rating.toFixed(1)}`,
    ].filter(Boolean);
    if (bits.length) lines.push(`Client: ${bits.join(" · ")}`);
  }
  lines.push("");
  lines.push("## Job description");
  lines.push(job.description || "(no description captured)");
  lines.push("");
  lines.push("## Writing brief for Claude");
  lines.push(
    `Write a ${opts.tone ?? "professional, warm"} Upwork cover letter for the job above. ` +
      "Open with a specific hook that references the client's actual need (not a generic " +
      "greeting). Show relevant proof, propose a concrete first step, and close with a " +
      "light call to action. Keep it under ~150 words. Do not invent experience.",
  );
  if (opts.resumeContext) {
    lines.push("");
    lines.push("## Freelancer context to draw from");
    lines.push(opts.resumeContext);
  }
  lines.push("");
  lines.push("## Draft");
  lines.push("(Claude: write the final cover letter here.)");

  return lines.join("\n");
}

/** Persist a finished draft the user/Claude chose to keep. */
export function saveDraft(
  job: Pick<Job, "id" | "url" | "title">,
  body: string,
  tone?: string,
): ProposalDraft {
  return insertDraft({
    jobId: job.id,
    jobUrl: job.url,
    jobTitle: job.title,
    body,
    tone,
    createdAt: new Date().toISOString(),
  });
}

function describeBudget(job: Job): string {
  if (job.jobType === "fixed" && job.fixedBudget != null) {
    return `$${job.fixedBudget} fixed`;
  }
  if (job.jobType === "hourly") {
    if (job.hourlyMin != null && job.hourlyMax != null) {
      return `$${job.hourlyMin}–$${job.hourlyMax}/hr`;
    }
    if (job.hourlyMax != null) return `up to $${job.hourlyMax}/hr`;
  }
  return "";
}
