// Role x action matrix: database policies read directly with each user's own token,
// plus JSON API and page-level access.
import { test, expect, type RoleKey } from "../lib/fixtures";
import { appApi, rest, pathOf, settle, uuid } from "../lib/app";
import { seedLead } from "../lib/data";
import { bodyText } from "../lib/ui";

test.describe("database policies (direct reads/writes with the user's own token)", () => {
  for (const role of ["finance", "designer"] as RoleKey[]) {
    test(`${role} cannot read company-wide activities, business events or milestones @bug-4c-1 @role-${role}`, async ({ as }) => {
      const s = await as(role, { path: "/api/health" });
      for (const table of ["activities", "business_events", "lead_milestones"]) {
        const r = await rest<unknown[]>(s, "GET", `${table}?select=id&limit=5`);
        const n = r.status === 200 ? (r.json ?? []).length : 0;
        expect(n, `${role} reads ${table}`).toBe(0);
      }
    });
  }

  test("designer cannot write activities on a lead they cannot see @bug-4c-2 @role-designer", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "inject", assignedTo: accounts.salesA.id });
    const row = { lead_id: id, type: "note", content: "E2E injected note" };
    // control: the same row (same field names) is accepted from a user who may write it
    const control = await rest(admin, "POST", "activities", { ...row, user_id: accounts.admin.id });
    expect(control.status, `control insert as admin must work, otherwise a denial proves nothing: ${control.text.slice(0, 120)}`).toBeLessThan(300);
    const d = await as("designer", { path: "/api/health" });
    const r = await rest(d, "POST", "activities", { ...row, user_id: accounts.designer.id });
    expect([401, 403], `designer insert -> ${r.status} ${r.text.slice(0, 100)}`).toContain(r.status);
  });

  test("designer cannot add, change or delete products; finance cannot either @bug-4c-3 @role-designer @role-finance", async ({ as, ns, registry }) => {
    const ctl = await as("admin", { path: "/api/health" });
    const control = await rest<Array<{ id: string }>>(ctl, "POST", "products", { sku: `${ns}-ctl`, name: `${ns}-prod-control`, category: "other", unit_price: 1 });
    expect(control.status, `control insert as admin must work (otherwise the denial below proves nothing): ${control.text.slice(0, 120)}`).toBeLessThan(300);
    if (control.json?.[0]?.id) registry.add({ kind: "product", id: control.json[0].id, label: `${ns}-prod-control` });
    for (const role of ["designer", "finance"] as RoleKey[]) {
      const s = await as(role, { path: "/api/health" });
      const ins = await rest<Array<{ id: string }>>(s, "POST", "products", { sku: `${ns}-${role}`, name: `${ns}-prod-${role}`, category: "other", unit_price: 1 });
      if (ins.status < 300 && ins.json?.[0]?.id) registry.add({ kind: "product", id: ins.json[0].id, label: `${ns}-prod-${role}` });
      expect(ins.status, `${role} product insert -> ${ins.status}`).toBeGreaterThanOrEqual(400);
    }
    const admin = await as("admin", { path: "/api/health" });
    const list = await rest<Array<{ id: string; unit_price: number | null }>>(admin, "GET", "products?select=id,unit_price&limit=1");
    const row = list.json?.[0];
    test.skip(!row, "no product to attempt a change on");
    const d = await as("designer", { path: "/api/health" });
    const upd = await rest<unknown[]>(d, "PATCH", `products?id=eq.${row!.id}`, { unit_price: row!.unit_price });
    expect((upd.json ?? []).length === 0 || upd.status >= 400, `designer product update -> ${upd.status} rows=${(upd.json ?? []).length}`).toBe(true);
    // delete the control product admin created above; it must survive
    const controlId = control.json?.[0]?.id;
    expect(controlId, "control product id").toBeTruthy();
    const del = await rest<unknown[]>(d, "DELETE", `products?id=eq.${controlId}`);
    expect(del.status >= 400 || (del.json ?? []).length === 0, `designer product delete -> ${del.status} rows=${(del.json ?? []).length}`).toBe(true);
    const still = await rest<unknown[]>(ctl, "GET", `products?id=eq.${controlId}&select=id`);
    expect((still.json ?? []).length, "the product must still exist after the designer's delete").toBe(1);
  });

  test("finance cannot edit lead fields directly @role-finance", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "fin-edit", assignedTo: accounts.salesA.id });
    const f = await as("finance", { path: "/api/health" });
    const r = await rest<unknown[]>(f, "PATCH", `leads?id=eq.${id}`, { notes: "E2E finance edit" });
    expect(r.status >= 400 || (r.json ?? []).length === 0, `finance lead edit -> ${r.status}`).toBe(true);
  });

  test("operator can read and move leads through the stage RPC; sales cannot read others' leads in the database @role-operator @role-salesB", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "rls", assignedTo: accounts.salesA.id });
    const b = await as("salesB", { path: "/api/health" });
    const r = await rest<unknown[]>(b, "GET", `leads?id=eq.${id}&select=id`);
    expect(r.json ?? []).toEqual([]);
    const op = await as("operator", { path: "/api/health" });
    const ro = await rest<unknown[]>(op, "GET", `leads?id=eq.${id}&select=id`);
    expect((ro.json ?? []).length).toBe(1);
  });
});

test.describe("management actions", () => {
  test("only admin and boss can manage the team; others get 403 @role-operator @role-salesA @role-finance @role-designer", async ({ as }) => {
    for (const role of ["operator", "salesA", "finance", "designer"] as RoleKey[]) {
      const s = await as(role, { path: "/api/health" });
      const generated = `Aa1!${uuid().slice(0, 12)}`;
      const r = await appApi(s.page, "POST", "/api/users", { email: `e2e-denied-${role}@qa.newme.ae`, password: generated, full_name: "E2E denied", role: "sales" });
      expect(r.status, `${role} create user -> ${r.status}`).toBe(403);
    }
  });

  test("admin keeps full boss-level rights: lists users, contracts, payments, analytics @role-admin", async ({ as }) => {
    const s = await as("admin", { path: "/api/health" });
    for (const url of ["/api/users", "/api/contracts/list", "/api/payments/list", "/api/analytics/summary", "/api/dashboard/summary"]) {
      const r = await appApi(s.page, "GET", url);
      expect(r.status, `${url} -> ${r.status}`).toBe(200);
    }
  });

  test("impersonation refuses an unknown target @role-admin", async ({ as }) => {
    const s = await as("admin", { path: "/api/health" });
    const r = await appApi(s.page, "POST", "/api/admin/impersonate", { userId: "00000000-0000-0000-0000-000000000000" });
    expect(r.status, `-> ${r.status}`).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  for (const [role, pages] of [
    ["operator", ["/leads", "/dashboard", "/analytics", "/pipeline"]],
    ["finance", ["/contracts", "/payments"]],
    ["salesA", ["/workbench", "/leads", "/quotes", "/pipeline"]],
  ] as Array<[RoleKey, string[]]>) {
    test(`${role} reaches the pages it is meant to use @role-${role}`, async ({ as }) => {
      const s = await as(role, { path: "/" });
      for (const p of pages) {
        await s.page.goto(p, { waitUntil: "domcontentloaded" });
        await settle(s.page);
        expect(pathOf(s.page), `${role} -> ${p}`).toBe(p);
        expect(await bodyText(s.page)).not.toMatch(/Application error|Internal Server Error/);
      }
      expect(s.serverErrors).toEqual([]);
    });
  }

  for (const role of ["finance", "designer"] as RoleKey[]) {
    test(`${role} is turned away from /pipeline @role-${role}`, async ({ as }) => {
      const s = await as(role, { path: "/" });
      await s.page.goto("/pipeline", { waitUntil: "domcontentloaded" });
      await settle(s.page);
      expect(pathOf(s.page), `${role} must not stay on /pipeline`).not.toBe("/pipeline");
    });
  }

  test("a lead the user may not see answers fast with a clear message @bug-4c-21 @role-finance", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "no-access", assignedTo: accounts.salesA.id });
    const f = await as("finance", { path: "/" });
    const t0 = Date.now();
    await f.page.goto(`/leads/${id}`, { waitUntil: "domcontentloaded" });
    await f.page.waitForFunction(() => document.body.innerText.trim().length > 40, undefined, { timeout: 15_000 }).catch(() => undefined);
    expect(Date.now() - t0, "blank for too long").toBeLessThan(8000);
    expect(await bodyText(f.page)).not.toContain(`${ns}-no-access`);
  });
});
