// Production-safe smoke subset (@smoke): reads only, plus one reversible
// assignment journey on a single marked test lead. Runs on staging too.
import { test, expect, requireWrites, type RoleKey } from "../lib/fixtures";
import { appApi, listLeads, sidebarLinks, settle, pathOf, rest, assignViaApi, getLead } from "../lib/app";
import { bodyText, rawKeysIn, openBellPanel, horizontalOverflow } from "../lib/ui";
import { seedLead } from "../lib/data";

const ALL_ROLES: RoleKey[] = ["boss", "admin", "operator", "salesA", "salesB", "finance", "designer"];
const MANAGEMENT: RoleKey[] = ["boss", "admin", "operator"];

test.describe("health and anonymous access", () => {
  test("health endpoint answers ok @smoke", async ({ as }) => {
    const s = await as(null);
    const res = await s.page.request.get("/api/health");
    expect(res.status()).toBe(200);
  });

  test("anonymous visitors cannot read data APIs @smoke", async ({ as }) => {
    const s = await as(null, { anonymous: true });
    await s.page.goto("/api/health");
    for (const url of ["/api/leads/list", "/api/contracts/list", "/api/users", "/api/payments/list", "/api/notifications"]) {
      const r = await appApi(s.page, "GET", url);
      expect(r.status, `${url} must be 401/403 without a session`).toBeGreaterThanOrEqual(401);
      expect(r.status, url).toBeLessThan(500);
    }
  });

  test("anonymous visitors are sent to the login page @smoke", async ({ as }) => {
    const s = await as(null, { anonymous: true });
    await s.page.goto("/leads", { waitUntil: "domcontentloaded" });
    await s.page.waitForURL(/\/login/, { timeout: 15_000 });
    expect(await bodyText(s.page)).not.toMatch(/E2E-|QA测试/);
  });
});

for (const role of ALL_ROLES) {
  test.describe(`role ${role}`, () => {
    test(`lands on a working page without server errors @smoke @role-${role}`, async ({ as }) => {
      const s = await as(role, { path: "/" });
      await settle(s.page);
      expect(pathOf(s.page), "must not bounce to login with a valid session").not.toMatch(/^\/login/);
      const text = await bodyText(s.page);
      expect(text).not.toMatch(/Application error|Internal Server Error|This page couldn.t load/i);
      expect(s.pageErrors, "uncaught browser errors").toEqual([]);
      expect(s.serverErrors, "5xx responses while loading").toEqual([]);
    });

    test(`every sidebar entry opens its own page, no silent bounce @smoke @role-${role} @bug-4a-2 @bug-4b-7 @bug-4c-20 @bug-4d-18`, async ({ as }) => {
      const s = await as(role, { path: "/" });
      await settle(s.page);
      const links = await sidebarLinks(s.page);
      expect(links.length, "sidebar has entries").toBeGreaterThan(2);
      const bounced: string[] = [];
      for (const href of links) {
        await s.page.goto(href, { waitUntil: "domcontentloaded" });
        await settle(s.page);
        const landed = pathOf(s.page);
        if (landed !== href && !landed.startsWith(href + "/")) bounced.push(`${href} -> ${landed}`);
      }
      expect(bounced, "sidebar entries that silently redirect elsewhere").toEqual([]);
    });
  });
}

test.describe("data visibility", () => {
  test("management roles see leads; finance and designer see none @smoke @role-finance @role-designer", async ({ as }) => {
    for (const role of MANAGEMENT) {
      const s = await as(role, { path: "/api/health" });
      const leads = await listLeads(s.page);
      expect(leads.length, `${role} should see company leads`).toBeGreaterThan(0);
    }
    for (const role of ["finance", "designer"] as RoleKey[]) {
      const s = await as(role, { path: "/api/health" });
      const r = await appApi<{ leads: unknown[] }>(s.page, "GET", "/api/leads/list");
      const n = r.status === 200 ? (r.json?.leads ?? []).length : 0;
      expect(n, `${role} must not read leads`).toBe(0);
    }
  });

  test("a salesperson only sees leads assigned to them @smoke @role-salesA", async ({ as, accounts }) => {
    const s = await as("salesA", { path: "/api/health" });
    const leads = await listLeads(s.page);
    const foreign = leads.filter((l) => l.assigned_to !== accounts.salesA.id);
    expect(foreign.map((l) => l.id), "leads of other people visible to sales A").toEqual([]);
  });

  test("sales A cannot read, write or delete another person's lead (pages, JSON APIs, direct database) @smoke @role-salesA", async ({ as, accounts }) => {
    const admin = await as("admin", { path: "/api/health" });
    const target = (await listLeads(admin.page)).find((l) => l.assigned_to && l.assigned_to !== accounts.salesA.id && !l.archived);
    test.skip(!target, "no lead owned by someone else to attack");
    const id = target!.id;
    const a = await as("salesA", { path: "/api/health" });
    const reads = ["timeline", "transfer-history"];
    for (const part of reads) {
      const r = await appApi(a.page, "GET", `/api/leads/${id}/${part}`);
      expect([401, 403, 404], `GET ${part} -> ${r.status} ${r.text.slice(0, 80)}`).toContain(r.status);
    }
    const attacks: Array<[string, string, unknown]> = [
      ["POST", `/api/leads/${id}/notes`, { content: "E2E intrusion" }],
      ["POST", `/api/leads/${id}/quality`, { quality: "good" }],
      ["POST", `/api/leads/${id}/assignment`, { assignedTo: accounts.salesA.id, idempotencyKey: crypto.randomUUID(), expectedUpdatedAt: target!.updated_at, reason: "E2E intrusion" }],
      ["POST", `/api/leads/${id}/delete`, { idempotencyKey: crypto.randomUUID() }],
    ];
    // Production: these writes are blocked by the browser guard before leaving the machine
    // (the request would be refused by the app anyway); on staging they hit the real API.
    for (const [method, url, body] of attacks) {
      const r = await appApi(a.page, method, url, body).catch(() => ({ status: 0, text: "blocked", json: null }));
      if (r.status === 0) continue;
      expect([400, 403, 404], `${method} ${url} -> ${r.status} ${r.text.slice(0, 80)}`).toContain(r.status);
    }
    const dbRead = await rest<unknown[]>(a, "GET", `leads?id=eq.${id}&select=id`);
    expect(dbRead.json ?? [], "direct database read of a foreign lead").toEqual([]);
    for (const table of ["activities", "follow_up_logs", "lead_milestones", "tasks"]) {
      const r = await rest<Array<{ lead_id?: string }>>(a, "GET", `${table}?lead_id=eq.${id}&select=lead_id`);
      expect(r.json ?? [], `direct read of ${table} for a foreign lead`).toEqual([]);
    }
    await a.page.goto(`/leads/${id}`, { waitUntil: "domcontentloaded" });
    await settle(a.page);
    // compare without echoing the name: on production it is a real customer
    const shown = (await bodyText(a.page)).includes(target!.customer_name ?? "\u0000never");
    expect(shown, "a foreign lead's name is rendered on the page").toBe(false);
  });

  test("finance and designer cannot read company-wide activities, business events or milestones @smoke @role-finance @role-designer @bug-4c-1", async ({ as }) => {
    for (const role of ["finance", "designer"] as RoleKey[]) {
      const s = await as(role, { path: "/api/health" });
      for (const table of ["activities", "business_events", "lead_milestones"]) {
        const r = await rest<unknown[]>(s, "GET", `${table}?select=id&limit=5`);
        const rows = r.status === 200 ? (r.json ?? []) : [];
        expect(rows.length, `${role} read ${rows.length} rows of ${table}`).toBe(0);
      }
    }
  });

  test("non-managers cannot list users @smoke @role-salesA @role-finance @role-designer", async ({ as }) => {
    for (const role of ["salesA", "finance", "designer"] as RoleKey[]) {
      const s = await as(role, { path: "/api/health" });
      const r = await appApi(s.page, "GET", "/api/users");
      expect([401, 403], `${role} GET /api/users -> ${r.status}`).toContain(r.status);
    }
  });
});

test.describe("language and layout", () => {
  for (const path of ["/dashboard", "/leads", "/analytics", "/quotes", "/team"]) {
    test(`Chinese UI has no raw keys or known typos on ${path} @smoke @role-boss @bug-4a-12 @bug-4a-13 @bug-4b-12 @bug-4c-12`, async ({ as }) => {
      const s = await as("boss", { lang: "zh", path });
      await settle(s.page);
      await s.page.waitForTimeout(1500);
      const text = await bodyText(s.page);
      expect(rawKeysIn(text), "raw translation keys visible").toEqual([]);
      expect(text).not.toContain("首长国");
    });
  }

  test("notification panel fits a 390 px phone screen @smoke @role-salesA @bug-4d-1", async ({ as }) => {
    const s = await as("salesA", { device: "mobile390", path: "/workbench" });
    await settle(s.page);
    const { viewport, panel } = await openBellPanel(s.page);
    expect(panel, "notification panel did not open").not.toBeNull();
    expect(panel!.left, "panel starts left of the screen edge").toBeGreaterThanOrEqual(-1);
    expect(panel!.right, "panel runs past the right edge").toBeLessThanOrEqual(viewport + 1);
  });

  test("notification panel fits a 360 px phone screen @smoke @role-boss @bug-4d-1", async ({ as }) => {
    const s = await as("boss", { device: "mobile360", path: "/dashboard" });
    await settle(s.page);
    const { viewport, panel } = await openBellPanel(s.page);
    expect(panel, "notification panel did not open").not.toBeNull();
    expect(panel!.left).toBeGreaterThanOrEqual(-1);
    expect(panel!.right).toBeLessThanOrEqual(viewport + 1);
  });

  test("phone layout has no sideways scrolling on the lead list @smoke @role-salesA", async ({ as }) => {
    const s = await as("salesA", { device: "mobile390", path: "/leads" });
    await settle(s.page);
    expect(await horizontalOverflow(s.page)).toBeLessThanOrEqual(1);
  });
});

test.describe("assignment journey (staging only; production is read-only)", () => {
  test("assign twice in a row without a refresh, then restore the owner @role-admin @bug-4a-6", async ({ as, accounts, target, registry, ns }) => {
    requireWrites(target);
    const admin = await as("admin", { path: "/api/health" });
    const leadId = await seedLead(admin, registry, target, ns, { label: "smoke-assign", assignedTo: accounts.salesA.id });
    const before = await getLead(admin.page, leadId);
    expect(before, "seeded lead must be visible to admin").toBeTruthy();
    const original = before!.assigned_to!;
    const other = original === accounts.salesA.id ? accounts.salesB.id : accounts.salesA.id;
    const first = await assignViaApi(admin.page, leadId, other, "E2E smoke reassignment 1");
    expect(first.status, first.text).toBe(200);
    const back = await assignViaApi(admin.page, leadId, original, "E2E smoke reassignment 2");
    expect(back.status, back.text).toBe(200);
    expect((await getLead(admin.page, leadId))!.assigned_to, "owner restored").toBe(original);
  });
});
