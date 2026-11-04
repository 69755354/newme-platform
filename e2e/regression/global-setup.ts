// Logs every QA role in ONCE per run (or reuses a still-valid cached session) so
// the suite stays far below the login rate limits (8 logins / account / 15 min,
// 20 logins / IP / 5 min). Session files are written 0600 under a gitignored dir.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type FullConfig } from "@playwright/test";
import { loadAccounts, missingRoles, ROLE_KEYS } from "./lib/accounts.mjs";
import { isMetaTraffic, publicOriginFor, resolveTarget } from "./lib/target.mjs";
import { authStatePath, authCacheDir } from "./lib/paths";

// A context-level request object does not send Secure cookies to http://127.0.0.1, so the
// check runs fetch() inside a real page (same cookie rules as the tests).
async function sessionStillValid(browser: Awaited<ReturnType<typeof chromium.launch>>, baseURL: string, file: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  const ctx = await browser.newContext({ baseURL, storageState: file, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage();
    await page.goto("/api/health");
    const res = await page.evaluate(async () => {
      const r = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as { forcePasswordChange?: boolean } };
    });
    if (res.status !== 200 || res.body.forcePasswordChange) return false;
    await ctx.storageState({ path: file });
    return true;
  } finally {
    await ctx.close();
  }
}

export default async function globalSetup(config: FullConfig) {
  const target = resolveTarget(process.env);
  const runDir = process.env.E2E_RUN_DIR as string;
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  chmodSync(runDir, 0o700);
  chmodSync(path.dirname(runDir), 0o700); // traces hold session cookies and sign-in request bodies
  const accounts = loadAccounts(target.accountsFile);
  const missing = missingRoles(accounts, ROLE_KEYS);
  if (missing.length) throw new Error(`Accounts file lacks roles: ${missing.join(", ")}`);

  const health = await fetch(`${target.baseURL}/api/health`).catch((e: Error) => e);
  if (health instanceof Error || !health.ok) {
    throw new Error(`Target ${target.baseURL} is not healthy (/api/health): ${health instanceof Error ? health.message : health.status}`);
  }

  const dir = authCacheDir(target.baseURL);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const use = config.projects[0]?.use ?? {};
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  const loggedIn: string[] = [];
  const reused: string[] = [];
  try {
    for (const key of ROLE_KEYS) {
      const file = authStatePath(target.baseURL, key);
      if (process.env.E2E_FRESH_LOGIN !== "1" && !target.isProduction && (await (browser ??= await chromium.launch({ headless: true, ...(use.launchOptions ?? {}) }), sessionStillValid(browser, target.baseURL, file)))) {
        chmodSync(file, 0o600);
        reused.push(key);
        continue;
      }
      const ctx = await browser!.newContext({ baseURL: target.baseURL, ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
      await ctx.route((url) => isMetaTraffic(url.href), (route) => route.abort());
      const publicOrigin = publicOriginFor(target.baseURL);
      if (publicOrigin) {
        await ctx.route(/\/api\//, async (route) => {
          const headers = route.request().headers();
          if (!headers.origin) return route.continue();
          const response = await route.fetch({ headers: { ...headers, origin: publicOrigin } });
          return route.fulfill({ response });
        });
      }
      const page = await ctx.newPage();
      const account = accounts[key];
      await page.goto("/login", { waitUntil: "domcontentloaded" });
      await page.locator('input[type="email"]').first().fill(account.email);
      await page.locator('input[type="password"]').first().fill(account.password);
      await page.locator('button[type="submit"]').first().click();
      try {
        await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
      } catch {
        const msg = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
        throw new Error(`Login failed for role ${key}: ${msg}`);
      }
      if (new URL(page.url()).pathname.startsWith("/change-password")) {
        throw new Error(`QA account ${key} is forced to change its password; fix the account before running the suite`);
      }
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await ctx.storageState({ path: file });
      chmodSync(file, 0o600);
      await ctx.close();
      loggedIn.push(key);
    }
  } finally {
    await browser?.close();
  }

  writeFileSync(
    path.join(runDir, "meta.json"),
    JSON.stringify(
      {
        baseURL: target.baseURL,
        isProduction: target.isProduction,
        suite: target.suite,
        runId: target.runId,
        startedAt: new Date().toISOString(),
        version: process.env.E2E_EXPECTED_VERSION || null,
        logins: { fresh: loggedIn, reused },
      },
      null,
      2,
    ),
  );
  console.log(`[regression] target=${target.baseURL} suite=${target.suite} run=${target.runId} fresh-logins=${loggedIn.join(",") || "none"} reused=${reused.length}`);
}
