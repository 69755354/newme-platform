/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixtures receive a callback named `use`; it is not a React hook. */
// Shared Playwright fixtures for the regression suite.
//
// `as(roleKey, options)` opens a fresh browser context signed in as that QA role
// (from the session cached by global-setup), with:
//   - the UI language forced through localStorage (`newme-lang`),
//   - Meta pixel / CAPI traffic aborted,
//   - on production, every write request aborted except the single marked QA lead,
//   - page errors, 5xx responses and blocked writes recorded on the handle.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { loadAccounts } from "./accounts.mjs";
import { isMetaTraffic, productionRequestDecision, publicOriginFor, resolveTarget } from "./target.mjs";
import { authStatePath, runDirFromEnv } from "./paths";

export type RoleKey = "boss" | "admin" | "operator" | "salesA" | "salesB" | "finance" | "designer";
export type Lang = "en" | "zh";

export interface Account {
  key: RoleKey;
  role: string;
  name: string;
  email: string;
  password: string;
  id: string;
}

export interface OpenOptions {
  lang?: Lang;
  /** "desktop" = 1366x900 (default), "mobile390", "mobile360", or explicit size. */
  device?: "desktop" | "mobile390" | "mobile360" | { width: number; height: number };
  /** Start without the cached session (e.g. login/logout tests). */
  anonymous?: boolean;
  path?: string;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  account: Account | null;
  pageErrors: string[];
  serverErrors: string[];
  blockedWrites: string[];
  metaBlocked: string[];
  /** Write the session back to the cache on close (false for tests that log out or change the password). */
  keepState: boolean;
  /** Production: server actions are tolerated until this time (page load), refused afterwards. */
  actionWindowUntil: number;
  /** Captured Supabase REST coordinates for direct RLS probes. */
  rest: { url: string; apikey: string; authorization: string } | null;
}

export type Target = ReturnType<typeof resolveTarget>;

const DEVICES = {
  desktop: { viewport: { width: 1366, height: 900 } },
  mobile390: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  mobile360: { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;

export function namespace(target: Target) {
  return `E2E-${target.runId}`;
}

async function openSession(
  browser: Browser,
  target: Target,
  accounts: Record<string, Account>,
  key: RoleKey | null,
  options: OpenOptions,
): Promise<Session> {
  const account = key ? accounts[key] : null;
  if (key && !account) throw new Error(`No QA account for ${key}`);
  const deviceOpts = typeof options.device === "object" ? { viewport: options.device } : DEVICES[options.device ?? "desktop"];
  const lang = options.lang ?? "en";
  const context = await browser.newContext({
    baseURL: target.baseURL,
    ignoreHTTPSErrors: true,
    timezoneId: "Asia/Dubai",
    locale: lang === "zh" ? "zh-CN" : "en-US",
    serviceWorkers: "block",
    storageState: key && !options.anonymous ? authStatePath(target.baseURL, key) : undefined,
    ...deviceOpts,
  });
  await context.addInitScript((l) => {
    try {
      window.localStorage.setItem("newme-lang", l);
    } catch {
      /* storage disabled */
    }
  }, lang);

  const session: Session = {
    context,
    page: null as unknown as Page,
    account,
    pageErrors: [],
    serverErrors: [],
    blockedWrites: [],
    metaBlocked: [],
    keepState: !options.anonymous && !target.isProduction,
    actionWindowUntil: 0,
    rest: null,
  };

  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = req.url();
    if (isMetaTraffic(url)) {
      session.metaBlocked.push(url.slice(0, 120));
      return route.abort("blockedbyclient");
    }
    if (target.isProduction) {
      if (req.isNavigationRequest()) session.actionWindowUntil = Date.now() + 8000;
      const decision = productionRequestDecision({
        method: req.method(),
        url,
        headers: req.headers(),
        origin: target.origin,
        actionWindowOpen: Date.now() < session.actionWindowUntil,
      });
      if (!decision.allow) {
        session.blockedWrites.push(`${req.method()} ${url.slice(0, 140)} (${decision.reason})`);
        return route.abort("blockedbyclient");
      }
    }
    const publicOrigin = publicOriginFor(target.baseURL);
    if (publicOrigin && url.startsWith(target.origin) && new URL(url).pathname.startsWith("/api/") && req.headers().origin) {
      const response = await route.fetch({ headers: { ...req.headers(), origin: publicOrigin } });
      return route.fulfill({ response });
    }
    return route.fallback();
  });

  context.on("request", (req) => {
    const url = req.url();
    if (url.includes("/rest/v1/")) {
      const h = req.headers();
      if (h.apikey && h.authorization) {
        session.rest = { url: url.split("/rest/v1/")[0], apikey: h.apikey, authorization: h.authorization };
      }
    }
  });
  context.on("response", (res) => {
    if (res.status() >= 500) session.serverErrors.push(`${res.status()} ${res.request().method()} ${res.url().replace(target.origin, "").slice(0, 140)}`);
  });

  const page = await context.newPage();
  page.on("pageerror", (err) => session.pageErrors.push(err.message.slice(0, 300)));
  session.page = page;
  if (options.path) await page.goto(options.path, { waitUntil: "domcontentloaded" });
  return session;
}

type Fixtures = {
  as: (key: RoleKey | null, options?: OpenOptions) => Promise<Session>;
  ns: string;
  registry: Registry;
};

type WorkerFixtures = {
  target: Target;
  accounts: Record<string, Account>;
};

export interface CreatedRecord {
  kind: "lead" | "quotation" | "contract" | "payment" | "user" | "product";
  id: string;
  label?: string;
}

export class Registry {
  constructor(private readonly file: string, private readonly target: Target) {}
  add(record: CreatedRecord) {
    if (this.target.isProduction) throw new Error("Refusing to create test data on production");
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n");
  }
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  target: [
    async ({}, use) => {
      await use(resolveTarget(process.env));
    },
    { scope: "worker" },
  ],
  accounts: [
    async ({ target }, use) => {
      await use(loadAccounts(target.accountsFile) as Record<string, Account>);
    },
    { scope: "worker" },
  ],
  ns: async ({ target }, use) => {
    await use(namespace(target));
  },
  registry: async ({ target }, use) => {
    await use(new Registry(path.join(runDirFromEnv(), "created.jsonl"), target));
  },
  as: async ({ browser, target, accounts }, use, testInfo) => {
    const sessions: Session[] = [];
    await use(async (key, options = {}) => {
      const s = await openSession(browser, target, accounts, key, options);
      sessions.push(s);
      return s;
    });
    for (const s of sessions) {
      if (s.blockedWrites.length) {
        testInfo.annotations.push({ type: "blocked-writes", description: s.blockedWrites.slice(0, 5).join(" ; ") });
      }
      // Refresh tokens rotate when a page refreshes the session, so write the live
      // state back (only while it is still valid) to keep the next run's cache usable.
      if (s.account && s.keepState) {
        try {
          const probe = s.page.isClosed() ? await s.context.newPage() : s.page;
          if (probe.url() === "about:blank") await probe.goto("/api/health");
          const me = await probe.evaluate(async () => (await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })).status);
          if (me === 200) await s.context.storageState({ path: authStatePath(target.baseURL, s.account.key) });
        } catch {
          /* cache refresh is best effort */
        }
      }
      await s.context.close().catch(() => undefined);
    }
  },
});

/** Skip a write test on production (belt and braces on top of the suite grep). */
export function requireWrites(target: Target) {
  test.skip(!target.allowWrites, "writes are not allowed against production");
}

export { expect };
