// Test-data helpers: seed leads through the signed-in user's own REST access
// (same path the app's "new lead" form uses), always namespaced E2E-<run> and
// registered for cleanup through the application API in global-teardown.
import { expect } from "@playwright/test";
import type { Registry, RoleKey, Session, Target } from "./fixtures";
import { rest, testPhone, appApi, uuid } from "./app";

export interface SeedOptions {
  label: string;
  /** user id the lead is assigned to (null = unassigned) */
  assignedTo?: string | null;
  phone?: string | null;
  email?: string | null;
  quality?: string;
}

/** Create a lead as `s` (needs lead-write rights: admin/boss/operator/sales). Returns its id. */
export async function seedLead(s: Session, registry: Registry, target: Target, ns: string, opts: SeedOptions): Promise<string> {
  const name = `${ns}-${opts.label}`;
  const row = {
    source: "offline",
    customer_name: name,
    phone: opts.phone === undefined ? testPhone(target) : opts.phone,
    email: opts.email ?? null,
    quality: opts.quality ?? "pending",
    assigned_to: opts.assignedTo === undefined ? s.account?.id ?? null : opts.assignedTo,
    created_by: s.account?.id ?? null,
    next_action: "call",
    next_followup_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
  };
  const res = await rest<Array<{ id: string }>>(s, "POST", "leads?select=id", row);
  expect(res.status, `seed lead "${name}" failed: ${res.text.slice(0, 200)}`).toBeLessThan(300);
  const id = res.json?.[0]?.id;
  expect(id, "seeded lead has no id").toBeTruthy();
  registry.add({ kind: "lead", id: id!, label: name });
  return id!;
}

export async function stageOf(s: Session, leadId: string): Promise<{ stage: string | null; final_status: string | null; current_milestone: string | null; assigned_to: string | null; updated_at: string }> {
  const res = await rest<Array<Record<string, string | null>>>(s, "GET", `leads?id=eq.${leadId}&select=stage,final_status,current_milestone,assigned_to,updated_at`);
  expect(res.status, res.text.slice(0, 200)).toBe(200);
  const row = res.json?.[0];
  expect(row, `lead ${leadId} not visible`).toBeTruthy();
  return row as never;
}

/** Record contact + quality so the first-contact gate allows moving the lead forward. */
export async function makeContactReady(s: Session, leadId: string) {
  const c = await appApi(s.page, "POST", `/api/leads/${leadId}/contacts`, {
    contact_method: "phone",
    contact_result: "E2E reached customer",
    summary: "E2E first call",
    contact_time: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  const q = await appApi(s.page, "POST", `/api/leads/${leadId}/quality`, { quality: "good" });
  return { contact: c, quality: q };
}

export function stageNote() {
  return { note: "E2E stage change", idempotencyKey: uuid() };
}

export async function changeStage(s: Session, leadId: string, stage: string, note = "E2E stage change") {
  return appApi(s.page, "PATCH", `/api/leads/${leadId}/stage`, { stage, note, idempotencyKey: uuid() });
}

export const PIPELINE_ORDER = ["new", "contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation", "pending_decision"] as const;

export function keyFor(role: RoleKey) {
  return role;
}

export interface TempUser {
  id: string;
  email: string;
  secret: string;
  name: string;
}

/** A throw-away sales login (forced to change its password on first sign-in). Removed by teardown. */
export async function createTempUser(admin: Session, registry: Registry, target: Target, ns: string, label: string): Promise<TempUser> {
  const secret = `Aa1!${uuid().replace(/-/g, "").slice(0, 14)}`;
  const email = `e2e-${target.runId.toLowerCase()}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@qa.newme.ae`;
  const name = `${ns}-${label}`;
  const res = await appApi<{ id?: string; user?: { id?: string } }>(admin.page, "POST", "/api/users", { email, password: secret, full_name: name, role: "sales", phone: testPhone(target) });
  expect(res.status, `create temp user: ${res.text.slice(0, 160)}`).toBeLessThan(300);
  const id = (res.json?.id ?? res.json?.user?.id) as string;
  expect(id, "temp user id").toBeTruthy();
  registry.add({ kind: "user", id, label: name });
  return { id, email, secret, name };
}

/** Sign in through the real login form in the given (anonymous) page. */
export async function loginViaForm(page: import("@playwright/test").Page, email: string, secret: string) {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(secret);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
}
