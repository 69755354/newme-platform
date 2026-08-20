import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

const requestedBaseURL = process.env.E2E_BASE_URL?.trim() || "http://127.0.0.1:3210";
const parsedBaseURL = new URL(requestedBaseURL);

if (
  parsedBaseURL.protocol !== "http:"
  || parsedBaseURL.hostname !== "127.0.0.1"
  || parsedBaseURL.username
  || parsedBaseURL.password
  || parsedBaseURL.pathname !== "/"
  || parsedBaseURL.search
  || parsedBaseURL.hash
) {
  throw new Error("Anonymous production smoke is restricted to a loopback HTTP origin");
}

const port = Number(parsedBaseURL.port || "80");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error("Anonymous production smoke requires an explicit unprivileged loopback port");
}
const baseURL = parsedBaseURL.origin;

const releaseSha = process.env.E2E_EXPECTED_SHA?.trim()
  || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
  throw new Error("Anonymous production smoke requires an exact 40-character release SHA");
}

const webServerEnv: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const publicEnvironmentPrefix = ["NEXT", "PUBLIC", ""].join("_");
for (const key of Object.keys(webServerEnv)) {
  if (
    key.startsWith(publicEnvironmentPrefix)
    || /^(?:DATABASE_URL|DIRECT_URL|SUPABASE_|SENTRY_|POSTHOG_|META_|COS_|E2E_|NEWME_|CRON_SECRET|MONITORING_)/.test(key)
    || key === "NEXT_PUBLIC_SITE_URL"
  ) {
    delete webServerEnv[key];
  }
}
Object.assign(webServerEnv, {
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: "production",
  NEWME_ISOLATED_BUILD: "1",
  NEXT_PUBLIC_APP_VERSION: releaseSha,
  SENTRY_RELEASE: releaseSha,
  NEXT_PUBLIC_SITE_URL: baseURL,
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-anonymous-smoke-key",
  SUPABASE_SERVICE_ROLE_KEY: "local-anonymous-smoke-service-key",
  NEXT_PUBLIC_SENTRY_DSN: "",
  SENTRY_DSN: "",
  SENTRY_AUTH_TOKEN: "",
});

export default defineConfig({
  testDir: "./e2e",
  testMatch: /production-anonymous\.spec\.ts/,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npm run start -- -p ${port} -H 127.0.0.1`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: webServerEnv,
    stdout: "pipe",
    stderr: "pipe",
  },
});
