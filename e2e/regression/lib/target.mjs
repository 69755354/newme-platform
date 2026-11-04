// Target resolution and production-safety rules for the NEWME OS regression suite.
//
// Pure functions only (no Playwright import) so tests/regression-suite can unit
// test the guard that keeps the full suite away from production.
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:3101";
export const DEFAULT_STAGING_ACCOUNTS = path.join(os.homedir(), ".config", "newme", "staging-qa-accounts.txt");
export const PRODUCTION_HOSTS = new Set(["app.newme.ae"]);

/** Chrome builds that exist on the NEWME server when Playwright's own Chromium is absent. */
export const FALLBACK_BROWSERS = [
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
  };
}

/** Extra search roots for a cached Chrome build (puppeteer cache); override with E2E_CHROME_PATH. */
export function cachedChromeCandidates(home = os.homedir()) {
  const root = path.join(home, ".claude-server-commander", "puppeteer-cache", "chrome");
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .map((v) => path.join(root, v, "chrome-linux64", "chrome"));
  } catch {
    return [];
  }
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
  for (const candidate of [...cachedChromeCandidates(), ...FALLBACK_BROWSERS]) {
    if (exists(candidate)) return candidate;
  }
  throw new Error("No Chromium found: set E2E_CHROME_PATH (playwright install is intentionally not used)");
}

// ─── Production write guard ───────────────────────────────────────────────

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Same-origin POST endpoints that do not change business data (sign in / session / sign out). */
const SAFE_APP_POSTS = [
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/session$/,
  /^\/api\/auth\/logout$/,
  /^\/monitoring(\/|$)/, // Sentry tunnel
];
/** Database auth endpoints: only token refresh and sign-out of the QA session itself. */
const SAFE_AUTH_POSTS = [/^\/auth\/v1\/token$/, /^\/auth\/v1\/logout$/];

/**
 * Decide whether a browser request may leave the browser when the target is production.
 * Production is read-only: every non-GET is refused except sign-in, session refresh,
 * sign-out and the Sentry tunnel. Server actions (POST + `next-action`) are POSTs even
 * when pages use them to read identity on mount, so they are allowed only while
 * `actionWindowOpen` (page load); the caller records and refuses any later one.
 * Returns { allow: boolean, reason: string }.
 * @param {{ method?: string, url: string, headers?: Record<string, string>, origin: string, actionWindowOpen?: boolean }} input
 */
export function productionRequestDecision({ method, url, headers = {}, origin, actionWindowOpen = false }) {
  const m = String(method || "GET").toUpperCase();
  if (READ_METHODS.has(m)) return { allow: true, reason: "read" };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, reason: "unparseable url" };
  }
  if (u.pathname.startsWith("/auth/v1/")) {
    return m === "POST" && SAFE_AUTH_POSTS.some((re) => re.test(u.pathname))
      ? { allow: true, reason: "auth session" }
      : { allow: false, reason: `database auth ${m} ${u.pathname}` };
  }
  if (u.pathname.startsWith("/rest/v1/")) return { allow: false, reason: `database write ${m} ${u.pathname}` };
  if (u.origin === origin) {
    if (m === "POST" && SAFE_APP_POSTS.some((re) => re.test(u.pathname))) return { allow: true, reason: "auth" };
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (m === "POST" && lower["next-action"]) {
      return actionWindowOpen ? { allow: true, reason: "server action during page load" } : { allow: false, reason: "server action after page load" };
    }
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
