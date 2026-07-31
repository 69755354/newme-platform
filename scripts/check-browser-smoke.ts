#!/usr/bin/env npx tsx
/**
 * check-browser-smoke.ts — Minimal login-state browser smoke test for CRM
 * 
 * Verifies 14 routes render without crash/ChunkLoadError/RSC errors.
 * Does NOT test business logic, forms, permissions, or UI details.
 * 
 * Usage: npx tsx scripts/check-browser-smoke.ts
 */

import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BASE = (
  process.env.BROWSER_SMOKE_BASE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://app.newme.ae"
).replace(/\/+$/, "");
const REPORT_PATH =
  process.env.BROWSER_SMOKE_REPORT_PATH || "/tmp/browser-smoke-report.json";
const CREDS = {
  email: process.env.DEV_EMAIL || "",
  password: process.env.DEV_PASSWORD || "",
};

const ROUTES = [
  "/login",
  "/dashboard",
  "/command-center",
  "/workbench",
  "/leads",
  "/quotes",
  "/projects",
  "/contracts",
  "/pipeline",
  "/analytics",
  "/ads",
  "/products",
  "/team",
  "/settings",
];

interface PageResult {
  route: string;
  status: "PASS" | "P0" | "P1" | "SKIP";
  reason?: string;
  consoleErrors: string[];
  finalUrl?: string;
  durationMs?: number;
}

async function loadEnv() {
  // Read from project root .env.local (we run from newme-platform/)
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) {
    console.error(`❌ ${envPath} not found`);
    return;
  }
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key === "DEV_EMAIL") CREDS.email = val;
    if (key === "DEV_PASSWORD") CREDS.password = val;
  }
}

async function main() {
  await loadEnv();

  if (!CREDS.email || !CREDS.password) {
    console.error("❌ DEV_EMAIL/DEV_PASSWORD not found in .env.local");
    process.exit(1);
  }

  const results: PageResult[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Collect console errors
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  try {
    // ─── Step 1: Login ───
    console.log("🔐 Logging in...");
    await page.goto(`${BASE}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.fill('input[type="email"]', CREDS.email);
    await page.fill('input[type="password"]', CREDS.password);
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    await page.waitForURL("**/dashboard", { timeout: 15000 });
    console.log("✅ Login OK\n");

    // ─── Step 2: Smoke each route ───
    for (const route of ROUTES) {
      const result: PageResult = { route, status: "PASS", consoleErrors: [] };
      const startedAt = Date.now();
      pageErrors.length = 0; // reset

      try {
        const resp = await page.goto(`${BASE}${route}`, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

        const status = resp?.status() || 0;
        const bodyText = await page.textContent("body");
        result.finalUrl = page.url();

        // Check for crash indicators
        if (status >= 500) {
          result.status = "P0";
          result.reason = `HTTP ${status}`;
        } else if (
          bodyText?.includes("Application error") ||
          bodyText?.includes("Something went wrong") ||
          bodyText?.includes("Internal Server Error")
        ) {
          result.status = "P0";
          result.reason = "Application Error in body";
        }

        // Check console for ChunkLoadError / RSC manifest errors
        for (const err of pageErrors) {
          if (
            err.includes("ChunkLoadError") ||
            err.includes("manifest") ||
            err.includes("React Client Manifest") ||
            err.includes("does not exist") ||
            err.includes("Cannot find module")
          ) {
            result.status = "P0";
            result.reason = (result.reason ? result.reason + "; " : "") + "Chunk/RSC error in console";
          }
        }
        result.consoleErrors = [...pageErrors];

        // Check for blank page (P1)
        if (
          result.status === "PASS" &&
          bodyText &&
          bodyText.trim().length < 50 &&
          !bodyText.includes("Coming Soon")
        ) {
          result.status = "P1";
          result.reason = "Page appears blank (< 50 chars)";
        }

        const icon = result.status === "P0" ? "🔴" : result.status === "P1" ? "🟡" : "✅";
        const reasonStr = result.reason ? ` — ${result.reason}` : "";
        console.log(`${icon} ${route}${reasonStr}`);

      } catch (e: any) {
        result.status = "P0";
        result.reason = `Navigation error: ${e.message?.slice(0, 80)}`;
        result.finalUrl = page.url();
        console.log(`🔴 ${route} — ${result.reason}`);
      } finally {
        result.durationMs = Date.now() - startedAt;
      }

      results.push(result);
    }
  } finally {
    await browser.close();
  }

  // ─── Summary ───
  const p0 = results.filter((r) => r.status === "P0");
  const p1 = results.filter((r) => r.status === "P1");
  const pass = results.filter((r) => r.status === "PASS");

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Browser-smoke: ${pass.length}/${ROUTES.length} PASS`);
  if (p0.length) console.log(`🔴 P0 (${p0.length}): ${p0.map((r) => r.route).join(", ")}`);
  if (p1.length) console.log(`🟡 P1 (${p1.length}): ${p1.map((r) => r.route).join(", ")}`);

  // List console errors
  const allErrors = results
    .filter((r) => r.consoleErrors.length > 0)
    .map((r) => r.consoleErrors.map((e) => `  ${r.route}: ${e.slice(0, 120)}`))
    .flat();
  if (allErrors.length > 0) {
    console.log(`\n⚠️  Console errors (${allErrors.length}):`);
    allErrors.forEach((e) => console.log(e));
  }

  if (p0.length === 0 && p1.length === 0) {
    console.log("\n🎉 ALL 14/14 PASS — today frozen.");
  }

  // Write JSON report
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        baseUrl: BASE,
        total: ROUTES.length,
        pass: pass.length,
        results,
        p0: p0.map((r) => ({
          route: r.route,
          reason: r.reason,
          finalUrl: r.finalUrl,
          durationMs: r.durationMs,
        })),
        p1: p1.map((r) => ({
          route: r.route,
          reason: r.reason,
          finalUrl: r.finalUrl,
          durationMs: r.durationMs,
        })),
      },
      null,
      2
    )
  );
  console.log(`\n📄 Report saved: ${REPORT_PATH}`);

  process.exit(p0.length > 0 ? 1 : 0);
}

main();
