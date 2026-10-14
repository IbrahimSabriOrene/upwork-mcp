/** Shared domain types for the Upwork MCP. */

/** A normalized Upwork job posting. */
export interface Job {
  /** Upwork ciphertext id, e.g. "~021..." (stable across the site). */
  id: string;
  title: string;
  url: string;
  description: string;
  /** "hourly" | "fixed" | "unknown" */
  jobType: JobType;
  /** Hourly range in USD, when jobType === "hourly". */
  hourlyMin?: number;
  hourlyMax?: number;
  /** Fixed budget in USD, when jobType === "fixed". */
  fixedBudget?: number;
  /** Connects required to submit a proposal. */
  connects?: number;
  skills: string[];
  /** ISO 8601 timestamp of when the job was posted, if known. */
  postedAt?: string;
  /** Free-form experience level, e.g. "Intermediate". */
  experienceLevel?: string;
  /** Project length / duration text, when present. */
  duration?: string;
  /** Number of proposals already submitted (bucket text or count). */
  proposals?: string;
  client?: ClientInfo;
}

export type JobType = "hourly" | "fixed" | "unknown";

export interface ClientInfo {
  country?: string;
  /** Total USD the client has spent on Upwork. */
  totalSpent?: number;
  /** Payment method verified flag. */
  paymentVerified?: boolean;
  /** Average feedback score 0-5. */
  rating?: number;
  /** Number of hires. */
  totalHires?: number;
  memberSince?: string;
}

/** Filters accepted by search_jobs / save_search. Mirrors Upwork's search params. */
export interface JobSearchFilters {
  /** "hourly" | "fixed" */
  jobType?: JobType;
  /** Minimum hourly rate or fixed budget in USD. */
  budgetMin?: number;
  budgetMax?: number;
  /** e.g. ["entry", "intermediate", "expert"] */
  experienceLevel?: string[];
  /** Only jobs with payment-verified clients. */
  paymentVerifiedOnly?: boolean;
  /** Client's minimum total spend in USD. */
  clientSpentMin?: number;
  /** Sort order: "recency" | "relevance". */
  sort?: "recency" | "relevance";
  /** Max results to return per run. */
  limit?: number;
}

export type FeedType = "best-matches" | "most-recent";

export interface SavedSearch {
  name: string;
  query: string;
  filters: JobSearchFilters;
  intervalMinutes: number;
  createdAt: string;
  lastRunAt?: string;
  enabled: boolean;
}

/** A queued "new job matched a saved search" event. */
export interface MatchEvent {
  id: number;
  searchName: string;
  job: Job;
  seenAt: string;
  /** Whether Claude has already drained this via get_new_matches. */
  delivered: boolean;
}

export interface ProposalDraft {
  id: number;
  jobId: string;
  jobUrl: string;
  jobTitle: string;
  body: string;
  tone?: string;
  createdAt: string;
}

export interface LoginStatus {
  loggedIn: boolean;
  /** Display name / username if detectable. */
  user?: string;
  checkedAt: string;
}
