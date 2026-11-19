#!/usr/bin/env node
// S22: how many requests does each key page send, and how long is the longest
// chain of requests that had to wait for the one before it?
//
// Not part of the release; nothing imports it. It exists so a change to how a
// page fetches data can be compared before and after with the same yardstick.
//
// Usage
//   MEASURE_EMAIL=<qa boss account> MEASURE_PASSWORD=<its password> \
//     node scripts/measure-page-requests.mjs --base http://127.0.0.1:3101 \
//       [--pages /dashboard,/analytics] [--runs 3] [--out result.json]
//
//   Run it against the STAGING site only (the instance the release rehearsal
//   uses), once on the build from main and once on the build from this branch,
//   then compare the two outputs. Under flock like every Node job on this host:
//     flock /home/claude-ops/newme-ops/fixes/.build.lock \
//       env NODE_OPTIONS=--max-old-space-size=2048 node scripts/measure-page-requests.mjs ...
//   The account's credentials come from the environment only; they are never
//   printed, written to the output, or accepted as arguments.
//   Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome
//
//   The script refuses the production host (app.newme.ae) on purpose.
//
// What is counted
//   requests   every request to the site's /api/ routes and to the data service
//              (/rest/v1, /auth/v1); static files and the error-report tunnel
//              are left out.
//   chain      the longest sequence of those requests in which each one started
//              after the previous one had finished (greedy, 5 ms tolerance). This
//              is the number of round trips the page cannot avoid; fewer is
//              faster at any distance from the server.
//   authMe     how many times /api/auth/me was asked.
//   lastMs     when the last of those requests finished, after navigation start.
import { chromium } from "playwright";
import fs from "node:fs";

const DEFAULT_PAGES = ["/dashboard", "/analytics", "/leads", "/contracts", "/quotes", "/products", "/team", "/settings"];
const PRODUCTION_HOSTS = new Set(["app.newme.ae", "newme.ae", "www.newme.ae"]);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Longest back-to-back chain among [{s, e}] spans (milliseconds). */
export function longestChain(spans, toleranceMs = 5) {
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  const best = [];
  let longest = 0;
  for (const span of sorted) {
    let depth = 1;
    for (const earlier of best) if (earlier.e <= span.s + toleranceMs) depth = Math.max(depth, earlier.depth + 1);
    best.push({ e: span.e, depth });
    longest = Math.max(longest, depth);
  }
  return longest;
}

function isCounted(url) {
  const { pathname } = new URL(url);
  if (pathname.startsWith("/monitoring-tunnel") || pathname.startsWith("/cdn-cgi/")) return false;
  return pathname.startsWith("/api/") || pathname.startsWith("/rest/v1/") || pathname.startsWith("/auth/v1/");
}

async function main() {
  const base = arg("base", process.env.BASE_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("--base is required, for example --base http://127.0.0.1:3101");
  if (PRODUCTION_HOSTS.has(new URL(base).hostname)) {
    console.error("refusing to measure production (app.newme.ae); use the staging site");
    process.exit(2);
  }
  const email = process.env.MEASURE_EMAIL;
  const password = process.env.MEASURE_PASSWORD;
  if (!email || !password) throw new Error("set MEASURE_EMAIL and MEASURE_PASSWORD in the environment");
  const pages = arg("pages", DEFAULT_PAGES.join(",")).split(",").map((p) => p.trim()).filter(Boolean);
  const runs = Number(arg("runs", "3"));

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const results = {};
  try {
    for (const path of pages) {
      const samples = [];
      for (let i = 0; i < runs; i += 1) {
        // A fresh browser context per run: nothing cached, a new session.
        const context = await browser.newContext({ viewport: { width: 1366, height: 800 } });
        const login = await context.request.post(`${base}/api/auth/login`, { data: { email, password } });
        if (!login.ok()) throw new Error(`login failed with status ${login.status()}`);
        const page = await context.newPage();
        const started = new Map();
        const spans = [];
        const byPath = {};
        let t0 = 0;
        page.on("request", (r) => { if (isCounted(r.url())) started.set(r, Date.now()); });
        page.on("requestfinished", (r) => {
          const s = started.get(r);
          if (s === undefined) return;
          spans.push({ s: s - t0, e: Date.now() - t0 });
          const key = new URL(r.url()).pathname;
          byPath[key] = (byPath[key] ?? 0) + 1;
        });
        page.on("requestfailed", (r) => {
          const s = started.get(r);
          if (s === undefined) return;
          spans.push({ s: s - t0, e: Date.now() - t0 });
        });
        t0 = Date.now();
        await page.goto(base + path, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => undefined);
        samples.push({
          requests: spans.length,
          chain: longestChain(spans),
          authMe: byPath["/api/auth/me"] ?? 0,
          lastMs: spans.reduce((m, x) => Math.max(m, x.e), 0),
          byPath,
        });
        await context.close();
      }
      const median = (key) => samples.map((x) => x[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      results[path] = { requests: median("requests"), chain: median("chain"), authMe: median("authMe"), lastMs: median("lastMs"), samples: samples.length, example: samples[0].byPath };
      console.log(`${path.padEnd(14)} requests ${String(results[path].requests).padStart(3)}  chain ${results[path].chain}  authMe ${results[path].authMe}  lastMs ${results[path].lastMs}`);
    }
  } finally {
    await browser.close();
  }
  const out = arg("out", "");
  if (out) fs.writeFileSync(out, JSON.stringify({ base, runs, results }, null, 2));
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
