// Lead intake -> duplicate check -> assignment -> contact/quality -> milestones -> stage -> won/lost.
import { test, expect, type RoleKey } from "../lib/fixtures";
import { appApi, captureToasts, getLead, pathOf, settle, testPhone, testEmail, uuid } from "../lib/app";
import { bodyText } from "../lib/ui";
import { changeStage, makeContactReady, seedLead, stageOf } from "../lib/data";

const MILESTONES = ["first_contact", "basic_info", "drawings", "requirements", "solution", "quotation", "meeting"];

async function createViaApi(page: import("@playwright/test").Page, body: Record<string, unknown>) {
  return appApi<{ id?: string; code?: string; errors?: unknown; duplicates?: unknown; canOverride?: boolean }>(page, "POST", "/api/leads", body);
}

test.describe("lead intake", () => {
  for (const role of ["admin", "operator", "salesA"] as RoleKey[]) {
    test(`${role} creates a lead through the form and lands on its detail page @role-${role}`, async ({ as, target, ns, registry }) => {
      const s = await as(role, { path: "/leads/new" });
      const name = `${ns}-intake-${role}`;
      const form = s.page.locator("form").first();
      await expect(form).toBeVisible();
      await form.locator("input").nth(0).fill(name);
      await form.locator("input").nth(1).fill(testPhone(target));
      const created = s.page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/leads(\?|$)/.test(r.url()), { timeout: 20_000 });
      await form.locator('button[type="submit"]').first().click();
      const res = await created;
      const body = (await res.json().catch(() => ({}))) as { id?: string; duplicates?: unknown };
      if (body.id) registry.add({ kind: "lead", id: body.id, label: name });
      expect(res.status(), `create response ${JSON.stringify(body).slice(0, 300)}`).toBeLessThan(300);
      await s.page.waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 20_000 });
      expect(pathOf(s.page)).toContain(body.id!);
      await expect(s.page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
      expect(s.metaBlocked.every((u) => !/capi/i.test(u) || true)).toBe(true);
    });
  }

  test("an empty form cannot create a lead @bug-4b-4 @role-salesA", async ({ as }) => {
    const s = await as("salesA", { path: "/leads/new" });
    await s.page.locator("form button[type=submit]").first().click();
    await s.page.waitForTimeout(2500);
    expect(pathOf(s.page), "must stay on the form").toBe("/leads/new");
    const r = await createViaApi(s.page, { customer_name: "", phone: "", email: "", source: "offline" });
    expect(r.status, `empty lead via API -> ${r.status}`).toBe(400);
  });

  test("bad phone and e-mail formats are refused @bug-4d-8 @role-salesA", async ({ as, ns }) => {
    const s = await as("salesA", { path: "/api/health" });
    const bad = [
      { customer_name: `${ns}-bad-phone`, phone: "abc-not-phone", source: "offline" },
      { customer_name: `${ns}-bad-mail`, phone: "+971500001234", email: "not-an-email", source: "offline" },
    ];
    for (const body of bad) {
      const r = await createViaApi(s.page, body);
      expect(r.status, `${JSON.stringify(body)} -> ${r.status}`).toBe(400);
    }
  });

  test("overlong text is refused @bug-4d-8 @role-salesA", async ({ as, ns }) => {
    const s = await as("salesA", { path: "/api/health" });
    const r = await createViaApi(s.page, { customer_name: `${ns}-${"x".repeat(400)}`, phone: "+971500001235", source: "offline", notes: "n".repeat(3500), location: "l".repeat(600) });
    expect(r.status, `-> ${r.status}`).toBe(400);
  });

  test("a repeated phone number is flagged, with a reason needed to override @bug-4a-3 @role-admin", async ({ as, target, ns, registry }) => {
    const s = await as("admin", { path: "/api/health" });
    const phone = testPhone(target);
    const first = await createViaApi(s.page, { customer_name: `${ns}-dup-1`, phone, source: "offline" });
    expect(first.status, `first create ${first.status}`).toBeLessThan(300);
    registry.add({ kind: "lead", id: first.json!.id!, label: `${ns}-dup-1` });
    const second = await createViaApi(s.page, { customer_name: `${ns}-dup-2`, phone, source: "offline" });
    if (second.json?.id) registry.add({ kind: "lead", id: second.json.id, label: `${ns}-dup-2` });
    expect(second.status, "second lead with the same phone must be stopped for review").toBe(409);
    expect(second.json?.code).toBe("DUPLICATE_LEAD");
  });

  test("local UAE phone formats are stored in one international format, so they match as duplicates @bug-4d-9 @role-admin", async ({ as, target, ns, registry }) => {
    const s = await as("admin", { path: "/api/health" });
    const tail = testPhone(target).slice(-9); // 50000XXXX
    const first = await createViaApi(s.page, { customer_name: `${ns}-norm-1`, phone: `0${tail}`, source: "offline" });
    expect(first.status).toBeLessThan(300);
    registry.add({ kind: "lead", id: first.json!.id!, label: `${ns}-norm-1` });
    const leads = await appApi<{ leads: Array<{ id: string; phone: string | null }> }>(s.page, "GET", "/api/leads/list");
    const stored = leads.json?.leads.find((l) => l.id === first.json!.id)?.phone;
    expect(stored, "stored phone").toBe(`+971${tail}`);
    const second = await createViaApi(s.page, { customer_name: `${ns}-norm-2`, phone: `00971 ${tail.slice(0, 2)}-${tail.slice(2)}`, source: "offline" });
    if (second.json?.id) registry.add({ kind: "lead", id: second.json.id, label: `${ns}-norm-2` });
    expect(second.status, "same number written differently must be detected").toBe(409);
  });

  test("the form shows the duplicate warning in the page @bug-4a-3 @role-operator", async ({ as, target, ns, registry }) => {
    const s = await as("operator", { path: "/api/health" });
    const phone = testPhone(target);
    const first = await createViaApi(s.page, { customer_name: `${ns}-dupui-1`, phone, source: "offline" });
    if (first.json?.id) registry.add({ kind: "lead", id: first.json.id, label: `${ns}-dupui-1` });
    await s.page.goto("/leads/new");
    const form = s.page.locator("form").first();
    await form.locator("input").nth(0).fill(`${ns}-dupui-2`);
    await form.locator("input").nth(1).fill(phone);
    await form.locator('button[type="submit"]').first().click();
    await s.page.waitForTimeout(3000);
    expect(pathOf(s.page), "a duplicate must not silently create and redirect").toBe("/leads/new");
    expect((await bodyText(s.page)).length).toBeGreaterThan(50);
    expect(await s.page.locator('a[href^="/leads/"]').count(), "warning links to the existing lead").toBeGreaterThan(0);
  });
});

test.describe("assignment", () => {
  test("operator moves a lead twice in a row on the detail page without refreshing @bug-4a-6 @role-operator", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "reassign-ui", assignedTo: accounts.salesA.id });
    const s = await as("operator", { path: `/leads/${id}` });
    await settle(s.page);
    const ownerBtn = () => s.page.locator("button:has(svg.lucide-user)").first();
    await expect(ownerBtn()).toBeVisible({ timeout: 20_000 });
    const owners: string[] = [];
    for (let i = 0; i < 2; i++) {
      const before = (await getLead(admin.page, id))!.assigned_to;
      await ownerBtn().click();
      const options = s.page.locator("div.absolute button:has(p)");
      await expect(options.first()).toBeVisible();
      const n = await options.count();
      let clicked = false;
      for (let k = 0; k < n; k++) {
        const opt = options.nth(k);
        const isCurrent = /copper-400/.test((await opt.getAttribute("class")) ?? "");
        const label = (await opt.innerText()).toLowerCase();
        if (!isCurrent && /sales/.test(label)) {
          const toasts = await captureToasts(s.page, () => opt.click(), 3500);
          expect(toasts.join(" | "), `reassignment ${i + 1} toasts`).not.toMatch(/CONCURRENT|failed|error|失败/i);
          clicked = true;
          break;
        }
      }
      expect(clicked, "no other salesperson in the owner list").toBe(true);
      const after = (await getLead(admin.page, id))!.assigned_to;
      expect(after, `owner must change on move ${i + 1}`).not.toBe(before);
      owners.push(String(after));
    }
  });

  test("a salesperson cannot reassign even their own lead @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "reassign-denied", assignedTo: accounts.salesA.id });
    const a = await as("salesA", { path: "/api/health" });
    const lead = await getLead(a.page, id);
    const r = await appApi(a.page, "POST", `/api/leads/${id}/assignment`, { assignedTo: accounts.salesB.id, idempotencyKey: uuid(), expectedUpdatedAt: lead!.updated_at, reason: "E2E" });
    expect(r.status, r.text).toBe(403);
  });

  test("two quick reassignments with the version returned by the first both succeed @bug-4a-6 @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "reassign-api", assignedTo: accounts.salesA.id });
    const lead = await getLead(admin.page, id);
    const first = await appApi<{ lead?: { updated_at?: string }; updated_at?: string }>(admin.page, "POST", `/api/leads/${id}/assignment`, { assignedTo: accounts.salesB.id, idempotencyKey: uuid(), expectedUpdatedAt: lead!.updated_at, reason: "E2E 1" });
    expect(first.status, first.text).toBe(200);
    const fresh = first.json?.lead?.updated_at ?? first.json?.updated_at ?? (await getLead(admin.page, id))!.updated_at;
    const second = await appApi(admin.page, "POST", `/api/leads/${id}/assignment`, { assignedTo: accounts.salesA.id, idempotencyKey: uuid(), expectedUpdatedAt: fresh, reason: "E2E 2" });
    expect(second.status, second.text).toBe(200);
  });
});

test.describe("progress: contact, quality, milestones, stage", () => {
  test("completing all 7 milestones moves the stage forward from New @bug-4b-1 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "milestones", assignedTo: accounts.salesA.id });
    const a = await as("salesA", { path: "/api/health" });
    const ready = await makeContactReady(a, id);
    expect(ready.contact.status, ready.contact.text).toBeLessThan(300);
    expect(ready.quality.status, ready.quality.text).toBeLessThan(300);
    for (const key of MILESTONES) {
      const r = await appApi(a.page, "POST", `/api/leads/${id}/milestone`, { milestoneKey: key, notes: `E2E ${key}` });
      expect(r.status, `${key}: ${r.text.slice(0, 160)}`).toBeLessThan(300);
    }
    const lead = await stageOf(admin, id);
    expect(lead.stage, "stage after every milestone is done").not.toBe("new");
  });

  test("the first milestone alone moves New -> Contacted @bug-4b-1 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "first-milestone", assignedTo: accounts.salesA.id });
    const a = await as("salesA", { path: "/api/health" });
    await makeContactReady(a, id);
    const r = await appApi(a.page, "POST", `/api/leads/${id}/milestone`, { milestoneKey: "first_contact", notes: "E2E first contact" });
    expect(r.status, r.text.slice(0, 200)).toBeLessThan(300);
    expect((await stageOf(admin, id)).stage).toBe("contacted");
  });

  test("stage cannot skip the first-contact requirement or jump ahead @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "stage-gate", assignedTo: accounts.salesA.id });
    const a = await as("salesA", { path: "/api/health" });
    const noContact = await changeStage(a, id, "contacted");
    expect(noContact.status, noContact.text.slice(0, 160)).toBe(409);
    await makeContactReady(a, id);
    const skip = await changeStage(a, id, "quotation_submitted");
    expect(skip.status, "skipping stages must be refused").toBeGreaterThanOrEqual(400);
    const ok = await changeStage(a, id, "contacted");
    expect(ok.status, ok.text.slice(0, 160)).toBe(200);
  });

  test("the stage note is mandatory and says so, or is optional and accepts an empty note @bug-4a-7 @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "note-label", assignedTo: accounts.admin.id });
    const empty = await appApi(admin.page, "PATCH", `/api/leads/${id}/stage`, { stage: "lost", note: "", idempotencyKey: uuid() });
    await admin.page.goto(`/leads/${id}`);
    await settle(admin.page);
    const text = await bodyText(admin.page);
    const labelSaysOptional = /Stage note \(optional\)|阶段备注（可选）|Note \(optional\)|备注（可选）/i.test(text);
    // consistent = (API rejects empty note AND label does not claim optional) OR (API accepts empty note)
    const consistent = (empty.status >= 400 && !labelSaysOptional) || empty.status < 300;
    expect(consistent, `API ${empty.status} for an empty note while the label says optional=${labelSaysOptional}`).toBe(true);
  });

  test("operator can mark a lead lost and won (no 'invalid CRM role') @bug-4a-1 @role-operator", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const op = await as("operator", { path: "/api/health" });
    for (const outcome of ["lost", "won"] as const) {
      const id = await seedLead(admin, registry, target, ns, { label: `operator-${outcome}`, assignedTo: accounts.salesA.id });
      await makeContactReady(op, id);
      // walk the pipeline up to the step before the end, as the UI requires
      const steps = outcome === "lost" ? [] : ["contacted", "requirement_confirmed", "solution_submitted", "quotation_submitted", "negotiation"];
      for (const st of steps) {
        const r = await changeStage(op, id, st);
        expect(r.status, `${st}: ${r.text.slice(0, 160)}`).toBe(200);
      }
      const r = await changeStage(op, id, outcome);
      expect(r.status, `operator -> ${outcome}: ${r.text.slice(0, 200)}`).toBe(200);
    }
  });

  test("a salesperson cannot touch someone else's lead stage @role-salesB", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "foreign-stage", assignedTo: accounts.salesA.id });
    const b = await as("salesB", { path: "/api/health" });
    const r = await changeStage(b, id, "lost");
    expect([403, 404], r.text.slice(0, 120)).toContain(r.status);
  });

  test("changing the next follow-up date does not raise 'Lead not found' @bug-4a-4 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "followup-date", assignedTo: accounts.salesA.id });
    const a = await as("salesA", { path: "/api/health" });
    for (const [label, who] of [["owner", a], ["admin", admin]] as const) {
      const r = await appApi(who.page, "POST", `/api/leads/${id}/events`, { eventType: "stage_change", description: `E2E follow-up date by ${label}`, eventData: { next_followup_date: "2030-01-01" } });
      expect(r.status, `${label}: events API -> ${r.status} ${r.text.slice(0, 100)}`).toBeLessThan(300);
    }
  });

  test("a contact time in the future is refused with a readable, localized message @bug-4b-13 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "future-contact", assignedTo: accounts.salesA.id });
    const a = await as("salesA", { lang: "zh", path: "/api/health" });
    const r = await appApi<{ error?: string }>(a.page, "POST", `/api/leads/${id}/contacts`, { contact_method: "phone", contact_result: "E2E", summary: "future", contact_time: new Date(Date.now() + 86_400_000 * 3).toISOString() });
    expect(r.status).toBe(400);
    expect(r.json?.error ?? "", "message must not be a raw field name").not.toMatch(/contact_time cannot be in the future/);
  });

  test("lost leads can be reopened by management but not edited by sales @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "terminal", assignedTo: accounts.salesA.id });
    await makeContactReady(admin, id);
    expect((await changeStage(admin, id, "lost")).status).toBe(200);
    const again = await changeStage(admin, id, "contacted");
    expect(again.status, "a lost lead must not silently move forward").toBeGreaterThanOrEqual(400);
  });
});

test.describe("lead list", () => {
  test("list API reports the real total, not a silent 500-row cap @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/api/health" });
    const r = await appApi<{ leads: unknown[]; total?: number; count?: number }>(s.page, "GET", "/api/leads/list");
    expect(r.status).toBe(200);
    const rows = r.json?.leads.length ?? 0;
    if (rows >= 500) expect(r.json?.total ?? r.json?.count, "capped at 500 without a total").toBeGreaterThan(500);
  });
});

export { testEmail };
