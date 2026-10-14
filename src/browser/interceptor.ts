import type { Page, Response } from "rebrowser-playwright";

/**
 * Capture JSON responses that flow through a page while an action runs.
 *
 * Upwork's SPA fetches search results / job detail as JSON from its own
 * internal endpoints (GraphQL at /api/graphql/v1 and various /api/... routes).
 * Intercepting those payloads is far more robust than scraping rendered DOM,
 * which changes with every redesign.
 */
export interface CapturedResponse {
  url: string;
  status: number;
  json: unknown;
}

/**
 * Run `action` while collecting JSON responses whose URL matches `urlPattern`.
 * Returns everything captured during the action window.
 */
export async function captureJson(
  page: Page,
  urlPattern: RegExp,
  action: () => Promise<void>,
): Promise<CapturedResponse[]> {
  const captured: CapturedResponse[] = [];

  const handler = async (response: Response) => {
    try {
      const url = response.url();
      if (!urlPattern.test(url)) return;
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;
      const json = await response.json().catch(() => null);
      if (json !== null) {
        captured.push({ url, status: response.status(), json });
      }
    } catch {
      // Ignore bodies that can't be read (redirects, aborted requests, etc.).
    }
  };

  page.on("response", handler);
  try {
    await action();
    // Small settle window so late XHRs are captured after navigation resolves.
    await page.waitForTimeout(1200);
  } finally {
    page.off("response", handler);
  }
  return captured;
}

/**
 * Deep-search an arbitrary JSON structure for the first array whose elements
 * look like Upwork job records. Upwork nests results differently across
 * endpoints, so we probe structurally rather than hard-coding a path.
 */
export function findJobArray(root: unknown): unknown[] | null {
  const looksLikeJob = (o: unknown): boolean => {
    if (!o || typeof o !== "object") return false;
    const r = o as Record<string, unknown>;
    const hasTitle = typeof r.title === "string";
    const hasId =
      typeof r.ciphertext === "string" ||
      typeof r.uid === "string" ||
      typeof r.id === "string" ||
      typeof r.jobTile === "object";
    return hasTitle && hasId;
  };

  let best: unknown[] | null = null;
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      if (node.length > 0 && node.filter(looksLikeJob).length >= node.length / 2) {
        if (!best || node.length > best.length) best = node;
      }
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      visit(value, depth + 1);
    }
  };
  visit(root, 0);
  return best;
}
