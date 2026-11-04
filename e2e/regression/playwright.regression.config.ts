// NEWME OS end-to-end regression suite.
//
// Full suite (staging):   bash e2e/regression/run.sh
// Production smoke:       E2E_BASE_URL=https://app.newme.ae E2E_ALLOW_PRODUCTION=1 \
//                         E2E_ACCOUNTS_FILE=... bash e2e/regression/run.sh
// See /home/claude-ops/newme-ops/fixes/REGRESSION-RUNBOOK.md.
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { chromium } from "@playwright/test";
import { resolveBrowserExecutable, resolveTarget, runDir } from "./lib/target.mjs";

const target = resolveTarget(process.env);
// Workers are forked after this file is evaluated, so pinning the run id here
// gives every process the same namespace and run directory.
process.env.E2E_RUN_ID = target.runId;
const repoRoot = path.resolve(__dirname, "..", "..");
const RUN_DIR = runDir(repoRoot, target.runId);
process.env.E2E_RUN_DIR = RUN_DIR;

let bundled: string | null = null;
try {
  bundled = chromium.executablePath();
} catch {
  bundled = null;
}
const executablePath = resolveBrowserExecutable(process.env, bundled);

export default defineConfig({
  testDir: "./specs",
  testMatch: /\.regression\.ts$/,
  grep: target.suite === "smoke" ? /@smoke/ : undefined,
  outputDir: path.join(RUN_DIR, "artifacts"),
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS || 1),
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(RUN_DIR, "results.json") }],
  ],
  use: {
    baseURL: target.baseURL,
    headless: true,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
    timezoneId: "Asia/Dubai",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    ignoreHTTPSErrors: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    serviceWorkers: "block",
    launchOptions: {
      executablePath,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  projects: [{ name: target.suite }],
});
