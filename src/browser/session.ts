import { chromium, type BrowserContext, type Page } from "rebrowser-playwright";
import { BROWSER_PROFILE_DIR, SETTINGS, UPWORK, ensureDataDir } from "../config.js";
import type { LoginStatus } from "../types.js";

/**
 * Owns the single persistent stealth browser context. The user logs into Upwork
 * once (via open_login); the profile on disk keeps the session across restarts.
 *
 * Everything funnels through one context so we look like one human using one
 * browser, not a swarm of automated sessions.
 */
class BrowserSession {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;

  /** Get (or lazily launch) the persistent context. */
  async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.launch();
    try {
      this.context = await this.launching;
      return this.context;
    } finally {
      this.launching = null;
    }
  }

  private async launch(): Promise<BrowserContext> {
    ensureDataDir();
    const ctx = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: SETTINGS.headless,
      viewport: { width: 1366, height: 850 },
      locale: SETTINGS.locale,
      timezoneId: SETTINGS.timezone,
      // Use the real Chrome build if present — a genuine brand string is far
      // less detectable than bundled Chromium. Falls back automatically.
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--no-first-run",
      ],
    }).catch(async () => {
      // Retry without the "chrome" channel if a stable Chrome isn't installed.
      return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
        headless: SETTINGS.headless,
        viewport: { width: 1366, height: 850 },
        locale: SETTINGS.locale,
        timezoneId: SETTINGS.timezone,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-default-browser-check",
          "--no-first-run",
        ],
      });
    });

    ctx.on("close", () => {
      this.context = null;
    });
    return ctx;
  }

  /** Get a page to work with, reusing an existing tab when possible. */
  async getPage(): Promise<Page> {
    const ctx = await this.getContext();
    const pages = ctx.pages();
    if (pages.length > 0) return pages[0]!;
    return ctx.newPage();
  }

  /**
   * Determine whether the persistent session is authenticated with Upwork.
   * Probes an authed route and checks that we weren't bounced to login.
   */
  async checkLogin(): Promise<LoginStatus> {
    const checkedAt = new Date().toISOString();
    let page: Page | null = null;
    try {
      const ctx = await this.getContext();
      page = await ctx.newPage();
      await page.goto(UPWORK.bestMatches, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await humanPause(600, 1200);
      const url = page.url();
      const loggedIn =
        !/\/ab\/account-security\/login/i.test(url) &&
        !/\/login/i.test(url) &&
        /upwork\.com/i.test(url);

      let user: string | undefined;
      if (loggedIn) {
        user = await page
          .locator('[data-test="user-name"], [data-qa="user-name"]')
          .first()
          .textContent({ timeout: 2000 })
          .then((t) => t?.trim() || undefined)
          .catch(() => undefined);
      }
      return { loggedIn, user, checkedAt };
    } catch {
      return { loggedIn: false, checkedAt };
    } finally {
      // Close the throwaway probe tab, but never the last remaining page.
      if (page) {
        const ctx = this.context;
        if (ctx && ctx.pages().length > 1) await page.close().catch(() => {});
      }
    }
  }

  /**
   * Open the Upwork login page in a visible window so the human can sign in.
   * We never type credentials or solve challenges programmatically.
   */
  async openLogin(): Promise<{ opened: boolean; message: string }> {
    if (SETTINGS.headless) {
      return {
        opened: false,
        message:
          "Server is running headless (UPWORK_MCP_HEADLESS=true), so no window can be shown. " +
          "Restart with UPWORK_MCP_HEADLESS=false to log in interactively.",
      };
    }
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    await page.goto(UPWORK.login, { waitUntil: "domcontentloaded" }).catch(() => {});
    return {
      opened: true,
      message:
        "A browser window is open at the Upwork login page. Sign in manually (including any " +
        "2FA). Your session is saved to the persistent profile; call upwork_login_status to confirm.",
    };
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
  }
}

/** Random human-like pause. */
export async function humanPause(minMs = 400, maxMs = 1100): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * (maxMs - minMs));
  await new Promise((r) => setTimeout(r, ms));
}

/** Singleton — one browser per server process. */
export const session = new BrowserSession();
