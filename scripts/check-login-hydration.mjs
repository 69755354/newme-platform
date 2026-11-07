#!/usr/bin/env node
// S13: browser check that /login hydrates cleanly in every language-state combination.
//
// The production release gate failed because a browser whose localStorage held
// "zh" but had no `newme-lang` cookie got an English server page and a Chinese
// first client render (React error #418). This script reproduces every
// combination of session language and cookie state against a running server
// and fails on any console error or page error.
//
// Usage: BASE_URL=http://127.0.0.1:3137 node scripts/check-login-hydration.mjs
// Optional: PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome (browser binary)
import { chromium } from "playwright";
import { CASES } from "./login-hydration-cases.mjs";

const base = (process.env.BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

const BUTTON = { zh: "登录", en: "Sign In" };

async function runCase(browser, c) {
  const context = await browser.newContext({
    locale: c.storage === "zh" ? "zh-CN" : "en-US",
    viewport: { width: 1366, height: 800 },
  });
  if (c.storage) await context.addInitScript((l) => localStorage.setItem("newme-lang", l), c.storage);
  if (c.cookie) await context.addCookies([{ name: "newme-lang", value: c.cookie, url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String((e && e.message) || e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text().slice(0, 300)); });
  const res = await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
  // Hydration happens right after load; give React time to finish and report.
  await page.waitForTimeout(4000);
  const button = await page.getByRole("button", { name: BUTTON[c.expect], exact: true }).count();
  const htmlLang = await page.evaluate(() => document.documentElement.lang);
  const cookies = await context.cookies(base);
  const cookie = cookies.find((k) => k.name === "newme-lang")?.value ?? null;
  await context.close();
  const problems = [];
  if (res.status() !== 200) problems.push(`status ${res.status()}`);
  if (errors.length) problems.push(...errors);
  if (button !== 1) problems.push(`expected a "${BUTTON[c.expect]}" button after settling, found ${button}`);
  if (htmlLang !== c.expect) problems.push(`html lang is "${htmlLang}", expected "${c.expect}"`);
  if (c.storage && cookie !== c.expect) problems.push(`newme-lang cookie is "${cookie}", expected it to be written as "${c.expect}"`);
  return problems;
}

// The language switch itself: toggle on the page, then reload; no errors, and the choice sticks.
async function runToggleCase(browser) {
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1366, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String((e && e.message) || e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text().slice(0, 300)); });
  await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  const zhNow = await page.getByRole("button", { name: "登录", exact: true }).count();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const zhAfterReload = await page.getByRole("button", { name: "登录", exact: true }).count();
  const stored = await page.evaluate(() => localStorage.getItem("newme-lang"));
  const cookie = (await context.cookies(base)).find((k) => k.name === "newme-lang")?.value ?? null;
  await context.close();
  const problems = [...errors];
  if (zhNow !== 1) problems.push("page did not switch to Chinese when the switch was clicked");
  if (zhAfterReload !== 1) problems.push("Chinese was not kept after reload");
  if (stored !== "zh" || cookie !== "zh") problems.push(`stored "${stored}" / cookie "${cookie}", expected zh / zh`);
  return problems;
}

const browser = await chromium.launch({ headless: true, executablePath });
let failed = 0;
for (const c of CASES) {
  const problems = await runCase(browser, c);
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.name}`);
  for (const p of problems) console.log("     " + p);
  if (problems.length) failed += 1;
}
{
  const problems = await runToggleCase(browser);
  console.log(`${problems.length ? "FAIL" : "ok  "} language switch on the page, then reload`);
  for (const p of problems) console.log("     " + p);
  if (problems.length) failed += 1;
}
await browser.close();
if (failed) {
  console.error(`${failed} login hydration checks failed`);
  process.exit(1);
}
console.log(`all ${CASES.length + 1} login hydration checks passed`);
