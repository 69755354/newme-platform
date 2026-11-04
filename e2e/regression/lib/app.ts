// App-level helpers: JSON API calls with the browser's own cookies, direct
// Supabase REST probes with the user's own JWT (exactly what the browser could
// do), lead creation through the real UI, toasts, and nav discovery.
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";
import type { Registry, Session, Target } from "./fixtures";
import { restCoordsFromCookies, tokenExpiresAt } from "./restcoords";

export interface ApiResult<T = unknown> {
  status: number;
  json: T | null;
  text: string;
}

export async function appApi<T = Record<string, unknown>>(page: Page, method: string, url: string, body?: unknown): Promise<ApiResult<T>> {
  if (page.url() === "about:blank") await page.goto("/api/health");
  return page.evaluate(
    async ([m, u, b]) => {
      const res = await fetch(u as string, {
        method: m as string,
        headers: { "Content-Type": "application/json" },
        body: b === undefined ? undefined : JSON.stringify(b),
        credentials: "same-origin",
        cache: "no-store",
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text: text.slice(0, 4000) };
    },
    [method, url, body] as const,
  ) as Promise<ApiResult<T>>;
}

/**
 * Coordinates for direct database probes with the user's own token (what any browser
 * tab could do). See restcoords.ts for where the public key comes from.
 */
export async function ensureRest(s: Session, warmPath = "/leads") {
  if (s.rest) return s.rest;
  if (s.page.url() === "about:blank") await s.page.goto("/api/health");
  const isProd = process.env.E2E_TARGET === "production" || /newme\.ae$/.test(new URL(s.page.url()).hostname);
  let coords: ReturnType<typeof restCoordsFromCookies>;
  try {
    coords = restCoordsFromCookies(await s.context.cookies(), isProd);
  } catch (error) {
    // No public key on file: where the app itself talks to the database from the browser
    // (production today) borrow the coordinates from that live traffic instead.
    await s.page.goto(warmPath, { waitUntil: "domcontentloaded" });
    await expect.poll(() => Boolean(s.rest), { timeout: 15_000, message: (error as Error).message }).toBe(true);
    return s.rest!;
  }
  if (tokenExpiresAt(coords.authorization) < Date.now() + 60_000) {
    await s.page.goto(warmPath, { waitUntil: "networkidle" }).catch(() => undefined); // lets the app refresh the session
    coords = restCoordsFromCookies(await s.context.cookies(), isProd);
  }
  s.rest = coords;
  return coords;
}

/** GET a URL inside the page (the browser's own cookies) and return the raw text. */
export async function appText(page: Page, url: string): Promise<{ status: number; text: string }> {
  return page.evaluate(async (u) => {
    const res = await fetch(u, { credentials: "same-origin", cache: "no-store" });
    return { status: res.status, text: await res.text() };
  }, url);
}

export async function rest<T = unknown>(s: Session, method: string, pathAndQuery: string, body?: unknown, prefer = "return=representation"): Promise<ApiResult<T>> {
  const r = await ensureRest(s);
  return s.page.evaluate(
    async ([base, apikey, auth, m, p, b, pref]) => {
      const res = await fetch(`${base}/rest/v1/${p}`, {
        method: m as string,
        headers: { apikey: apikey as string, Authorization: auth as string, "Content-Type": "application/json", Prefer: pref as string },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, text: text.slice(0, 4000) };
    },
    [r.url, r.apikey, r.authorization, method, pathAndQuery, body, prefer] as const,
  ) as Promise<ApiResult<T>>;
}

export const uuid = () => randomUUID();

/** Visible sonner toasts (text). */
export async function toasts(page: Page): Promise<string[]> {
  return page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
}

/** Collect all toasts that appear during `fn` (sonner removes them after a few seconds). */
export async function captureToasts(page: Page, fn: () => Promise<unknown>, settleMs = 2500): Promise<string[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __e2eToasts?: string[]; __e2eToastObs?: MutationObserver };
    w.__e2eToasts = [];
    w.__e2eToastObs?.disconnect();
    const seen = new WeakSet<Element>();
    const scan = () => {
      document.querySelectorAll("[data-sonner-toast]").forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        w.__e2eToasts!.push((el as HTMLElement).innerText.replace(/\s+/g, " ").trim());
      });
    };
    w.__e2eToastObs = new MutationObserver(scan);
    w.__e2eToastObs.observe(document.body, { childList: true, subtree: true });
    scan();
  });
  await fn();
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => (window as unknown as { __e2eToasts?: string[] }).__e2eToasts ?? []);
}

// ─── Namespaced test data ─────────────────────────────────────────────────

/**
 * +97150000XXXX numbers, unique within a run even when Playwright restarts its worker
 * after a failed test (the sequence lives in a file in the run directory) and spread
 * across the 10000 range by a hash of the run id so separate runs rarely meet.
 */
export function testPhone(target: Target): string {
  const dir = process.env.E2E_RUN_DIR || ".";
  const file = `${dir}/phone-seq`;
  let n = 0;
  try {
    n = Number(readFileSync(file, "utf8")) || 0;
  } catch {
    n = 0;
  }
  n += 1;
  try {
    writeFileSync(file, String(n));
  } catch {
    /* run dir missing: fall back to in-memory uniqueness within this process */
  }
  const h = parseInt(createHash("sha1").update(target.runId).digest("hex").slice(0, 6), 16);
  return `+97150000${String((h + n * 37) % 10000).padStart(4, "0")}`;
}

export function testEmail(target: Target, label: string): string {
  return `e2e-${target.runId.toLowerCase()}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@qa.newme.ae`;
}

export interface NewLead {
  name: string;
  phone?: string;
  email?: string;
  location?: string;
  notes?: string;
}

/** Fill the /leads/new form and submit. Returns the created id (or null) plus toasts. */
export async function submitNewLeadForm(page: Page, lead: Partial<NewLead>): Promise<{ id: string | null; toasts: string[]; status: number | null }> {
  await page.goto("/leads/new", { waitUntil: "domcontentloaded" });
  const form = page.locator("form").first();
  await expect(form).toBeVisible();
  const name = form.locator("input").first();
  await name.fill(lead.name ?? "");
  if (lead.phone !== undefined) await form.locator('input[placeholder="+971..."], input[type="tel"]').first().fill(lead.phone);
  if (lead.email !== undefined) await form.locator('input[placeholder="email@example.com"], input[type="email"]').first().fill(lead.email);
  if (lead.location !== undefined) await form.locator('input[placeholder^="Dubai"]').first().fill(lead.location).catch(() => undefined);
  if (lead.notes !== undefined) await form.locator("textarea").first().fill(lead.notes);
  let id: string | null = null;
  let status: number | null = null;
  const waitInsert = page
    .waitForResponse((r) => r.request().method() === "POST" && /\/rest\/v1\/leads(\?|$)|\/api\/leads(\/create)?(\?|$)/.test(r.url()), { timeout: 20_000 })
    .then(async (r) => {
      status = r.status();
      const body = (await r.json().catch(() => null)) as { id?: string; lead?: { id?: string } } | Array<{ id?: string }> | null;
      const one = Array.isArray(body) ? body[0] : body;
      id = (one && ("id" in one ? one.id : (one as { lead?: { id?: string } }).lead?.id)) ?? null;
    })
    .catch(() => undefined);
  const seen = await captureToasts(page, async () => {
    await form.locator('button[type="submit"]').first().click();
    await waitInsert;
  });
  return { id, toasts: seen, status };
}

/** Create a lead through the real UI as `s` and register it for cleanup. */
export async function createLead(s: Session, registry: Registry, lead: NewLead): Promise<string> {
  const res = await submitNewLeadForm(s.page, lead);
  expect(res.id, `lead "${lead.name}" was not created (status ${res.status}, toasts ${res.toasts.join(" | ")})`).toBeTruthy();
  registry.add({ kind: "lead", id: res.id!, label: lead.name });
  return res.id!;
}

export interface LeadRow {
  id: string;
  customer_name: string | null;
  phone: string | null;
  assigned_to: string | null;
  updated_at: string;
  stage: string | null;
  final_status: string | null;
  archived?: boolean;
}

export async function listLeads(page: Page): Promise<LeadRow[]> {
  const r = await appApi<{ leads: LeadRow[] }>(page, "GET", "/api/leads/list");
  expect(r.status, `/api/leads/list ${r.text.slice(0, 200)}`).toBe(200);
  return r.json?.leads ?? [];
}

export async function getLead(page: Page, id: string): Promise<LeadRow | undefined> {
  return (await listLeads(page)).find((l) => l.id === id);
}

export async function assignViaApi(page: Page, leadId: string, assignedTo: string, reason = "E2E assign"): Promise<ApiResult> {
  const lead = await getLead(page, leadId);
  if (!lead) throw new Error(`lead ${leadId} not visible to assigning user`);
  return appApi(page, "POST", `/api/leads/${leadId}/assignment`, {
    assignedTo,
    idempotencyKey: uuid(),
    expectedUpdatedAt: lead.updated_at,
    reason,
  });
}

export async function addContactViaApi(page: Page, leadId: string): Promise<ApiResult> {
  return appApi(page, "POST", `/api/leads/${leadId}/contacts`, {
    contact_method: "phone",
    contact_result: "E2E reached customer",
    summary: "E2E first call",
    contact_time: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
}

/** Sidebar links visible to the current user. */
export async function sidebarLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator("aside a[href^='/'], nav a[href^='/']")
    .evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute("href") || ""));
  return [...new Set(hrefs.filter((h) => h && !h.startsWith("/api")).map((h) => h.split("?")[0]))];
}

export async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: false }), contentType: "image/png" });
}

/** Wait until the dashboard shell has rendered (sidebar or main content). */
export async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
}

export function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}
