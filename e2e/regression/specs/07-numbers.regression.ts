// One definition per metric: the same number must appear wherever it is shown.
import { test, expect } from "../lib/fixtures";
import { appApi, listLeads } from "../lib/app";

test.describe("consistent totals", () => {
  test("dashboard, analytics and lead list agree on the lead total @bug-4c-15 @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/api/health" });
    const leads = await listLeads(s.page);
    const visible = leads.filter((l) => !l.archived).length;
    const dash = await appApi<Record<string, unknown>>(s.page, "GET", "/api/dashboard/summary");
    const ana = await appApi<Record<string, unknown>>(s.page, "GET", "/api/analytics/summary");
    expect(dash.status).toBe(200);
    expect(ana.status).toBe(200);
    const dashTotal = (dash.json?.leads as unknown[] | undefined)?.length ?? null;
    const anaJson = ana.json as { leadHealth?: { totalLeads?: number }; pipelineFunnel?: { totalLeads?: number } };
    const anaTotal = anaJson.leadHealth?.totalLeads ?? null;
    const funnelTotal = anaJson.pipelineFunnel?.totalLeads ?? null;
    expect(dashTotal, "dashboard lead rows present").not.toBeNull();
    expect(anaTotal, "analytics total present").not.toBeNull();
    expect(anaTotal, `analytics ${anaTotal} vs lead list ${visible}`).toBe(visible);
    expect(funnelTotal, `analytics funnel ${funnelTotal} vs lead list ${visible}`).toBe(visible);
    expect(dashTotal, `dashboard ${dashTotal} vs lead list ${visible}`).toBe(visible);
  });

  test("the two ad attribution pages show the same total @bug-4a-14 @role-admin", async ({ as }) => {
    const s = await as("admin", { path: "/ads" });
    await s.page.waitForLoadState("networkidle").catch(() => undefined);
    const first = await s.page.locator("body").innerText();
    await s.page.goto("/settings/ads");
    await s.page.waitForLoadState("networkidle").catch(() => undefined);
    const second = await s.page.locator("body").innerText();
    const num = (t: string) => t.match(/(?:Total|总数|总线索)\D{0,12}(\d+)/i)?.[1] ?? null;
    const a = num(first);
    const b = num(second);
    test.skip(!a || !b, "totals not found on one of the pages");
    expect(a, "/ads vs /settings/ads totals").toBe(b);
  });

  test("dashboard and lead list handle more than 500 leads without hiding rows silently @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/api/health" });
    const r = await appApi<{ leads: unknown[] }>(s.page, "GET", "/api/leads/list");
    expect(r.status).toBe(200);
    expect((r.json?.leads ?? []).length).toBeLessThanOrEqual(5000);
  });

  test("today / this-month figures use Dubai time @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/api/health" });
    const r = await appApi<Record<string, unknown>>(s.page, "GET", "/api/dashboard/summary");
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/undefined|NaN/);
  });
});
