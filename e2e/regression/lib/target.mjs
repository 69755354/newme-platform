// Target resolution and production-safety rules for the NEWME OS regression suite.
//
// Pure functions only (no Playwright import) so tests/regression-suite can unit
// test the guard that keeps the full suite away from production.
import { existsSync } from "node:fs";
import path from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:3101";
export const DEFAULT_STAGING_ACCOUNTS = "/home/claude-ops/.config/newme/staging-qa-accounts.txt";
export const PRODUCTION_HOSTS = new Set(["app.newme.ae"]);

/** Chrome builds that exist on the NEWME server when Playwright's own Chromium is absent. */
export const FALLBACK_BROWSERS = [
  "/home/claude-ops/.claude-server-commander/puppeteer-cache/chrome/linux-156.0.8078.47/chrome-linux64/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function makeRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

/**
 * Resolve the run configuration from the environment.
 * Throws when the combination is unsafe (full suite against production, or
 * production without the explicit opt-in that the repo's other configs require).
 */
export function resolveTarget(env = process.env) {
  const baseURL = (env.E2E_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error(`E2E_BASE_URL is not a valid URL: ${baseURL}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("E2E_BASE_URL must not contain credentials");
  }
  const isProduction = PRODUCTION_HOSTS.has(parsed.hostname) || env.E2E_TARGET === "production";
  const suite = (env.E2E_SUITE || (isProduction ? "smoke" : "full")).trim();
  if (!["full", "smoke"].includes(suite)) {
    throw new Error(`E2E_SUITE must be "full" or "smoke" (got "${suite}")`);
  }
  if (isProduction && env.E2E_ALLOW_PRODUCTION !== "1") {
    throw new Error("Refusing to run against production without E2E_ALLOW_PRODUCTION=1");
  }
  if (isProduction && suite !== "smoke") {
    throw new Error("Only the production-safe smoke suite (E2E_SUITE=smoke) may run against production");
  }
  const accountsFile = (env.E2E_ACCOUNTS_FILE || (isProduction ? "" : DEFAULT_STAGING_ACCOUNTS)).trim();
  if (!accountsFile) {
    throw new Error("E2E_ACCOUNTS_FILE is required (path to role|name|email|password|user_id lines)");
  }
  const runId = (env.E2E_RUN_ID || makeRunId()).replace(/[^A-Za-z0-9-]/g, "");
  return {
    baseURL,
    origin: parsed.origin,
    isProduction,
    suite,
    accountsFile,
    runId,
    allowWrites: !isProduction,
    idleMs: Number(env.E2E_IDLE_MS || (suite === "smoke" ? 0 : 120000)),
    smokeLeadId: (env.E2E_SMOKE_LEAD_ID || "").trim() || null,
    smokeLeadName: (env.E2E_SMOKE_LEAD_NAME || "E2E-SMOKE-LEAD").trim(),
    smokeLeadRole: (env.E2E_SMOKE_LEAD_ACCOUNT || "sales:QA Sales A").trim(),
  };
}

/** Pick a Chromium binary without ever running `playwright install`. */
/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string | null} [bundledPath]
 * @param {(p: string) => boolean} [exists]
 */
export function resolveBrowserExecutable(env = process.env, bundledPath = null, exists = existsSync) {
  if (env.E2E_CHROME_PATH) {
    if (!exists(env.E2E_CHROME_PATH)) throw new Error(`E2E_CHROME_PATH does not exist: ${env.E2E_CHROME_PATH}`);
    return env.E2E_CHROME_PATH;
  }
  if (bundledPath && exists(bundledPath)) return undefined; // let Playwright use its own build
  for (const candidate of FALLBACK_BROWSERS) {
    if (exists(candidate)) return candidate;
  }
  throw new Error("No Chromium found: set E2E_CHROME_PATH (playwright install is intentionally not used)");
}

// ─── Production write guard ───────────────────────────────────────────────

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Same-origin POST endpoints that do not change business data. */
const SAFE_APP_POSTS = [
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/session$/,
  /^\/api\/auth\/logout$/,
  /^\/monitoring(\/|$)/, // Sentry tunnel
];

/**
 * Decide whether a browser request may leave the browser when the target is production.
 * `allowLeadId` opens exactly one marked QA lead for the smoke journey.
 * Returns { allow: boolean, reason: string }.
 */
/**
 * @param {{ method?: string, url: string, headers?: Record<string, string>, postData?: string, origin: string, allowLeadId?: string | null }} input
 */
export function productionRequestDecision({ method, url, headers = {}, postData = "", origin, allowLeadId = null }) {
  const m = String(method || "GET").toUpperCase();
  if (READ_METHODS.has(m)) return { allow: true, reason: "read" };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: "unparseable url" };
  }
  const body = String(postData || "");
  const touchesMarkedLead = Boolean(allowLeadId) && (u.href.includes(allowLeadId) || body.includes(allowLeadId));

  // Supabase REST (any host): RPC reads are POSTs; table writes are not allowed.
  if (u.pathname.startsWith("/rest/v1/")) {
    if (touchesMarkedLead) return { allow: true, reason: "marked QA lead" };
    if (m === "POST" && u.pathname.startsWith("/rest/v1/rpc/")) return { allow: true, reason: "rpc read" };
    return { allow: false, reason: `database write ${m} ${u.pathname}` };
  }
  if (u.pathname.startsWith("/auth/v1/")) {
    // token refresh / logout of the QA session itself
    return { allow: true, reason: "auth session" };
  }
  if (u.origin === origin) {
    if (SAFE_APP_POSTS.some((re) => re.test(u.pathname))) return { allow: true, reason: "auth" };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (lower["next-action"]) {
      // Server actions are POSTs even for reads (getCurrentUser on page mount).
      // Smoke tests never click write buttons; anything else is caught by the
      // REST/API rules above and below.
      return { allow: true, reason: "server action (read on mount)" };
    }
    if (touchesMarkedLead && u.pathname.startsWith("/api/leads/")) return { allow: true, reason: "marked QA lead" };
    return { allow: false, reason: `app write ${m} ${u.pathname}` };
  }
  return { allow: false, reason: `third-party ${m} ${u.host}` };
}

/** Meta pixel / Conversions API traffic that must never leave a test browser. */
export const META_TRAFFIC = /(^https?:\/\/([a-z0-9-]+\.)*(facebook\.(com|net)|fbcdn\.net|fbsbx\.com|instagram\.com)\/)|\/api\/leads\/meta-capi(\b|\/|\?)/i;

export function isMetaTraffic(url) {
  return META_TRAFFIC.test(String(url));
}

export function runDir(repoRoot, runId) {
  return path.join(repoRoot, "e2e", "regression", ".runs", runId);
}

// ─── Public-origin replay (staging behind Cloudflare Access) ───────────────

/**
 * The app only accepts requests whose Origin equals its configured public URL.
 * Staging is configured for https://staging.newme.ae, which is not reachable from
 * the server itself, so for loopback targets the browser's API calls are replayed
 * with that Origin (Chromium does not let an intercepted request rewrite it).
 * Returns the origin to present, or null when no replay is needed.
 */
export function publicOriginFor(baseURL, env = process.env) {
  if (env.E2E_PUBLIC_ORIGIN === "none") return null;
  let host;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return null;
  }
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback) return null;
  return (env.E2E_PUBLIC_ORIGIN || "https://staging.newme.ae").replace(/\/+$/, "");
}
