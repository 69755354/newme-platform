// One definition per metric: the same number must appear wherever it is shown.
import { test, expect } from "../lib/fixtures";
import { appApi, listLeads, rest } from "../lib/app";

test.describe("consistent totals", () => {
  test("dashboard, analytics and lead list agree on the lead total @bug-4c-15 @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/api/health" });
    // Exact ground truth straight from the database: live (non-archived) leads, excluding
    // the synthetic QA source -- the scope the dashboard and analytics both claim. The total
    // is read from the count header, so it is not limited by a page size.
    const truth = await rest(s, "GET", "leads?archived=eq.false&or=(source.is.null,source.neq.synthetic_qa)&select=id&limit=1", undefined, "count=exact");
    expect(truth.status, `ground-truth count ${truth.text.slice(0, 120)}`).toBeLessThan(300);
    const exact = Number(truth.contentRange?.split("/")[1]);
    expect(Number.isFinite(exact), `content-range header ${truth.contentRange}`).toBe(true);
    // A refused session would read as 0 everywhere and every comparison below would pass.
    expect(exact, "database ground truth must be above zero").toBeGreaterThan(0);
    const leads = await listLeads(s.page);
    const dash = await appApi<Record<string, unknown>>(s.page, "GET", "/api/dashboard/summary");
    const ana = await appApi<Record<string, unknown>>(s.page, "GET", "/api/analytics/summary");
    expect(dash.status).toBe(200);
    expect(ana.status).toBe(200);
    const dashJson = dash.json as { leads?: unknown[]; leadStats?: { total?: number } };
    const dashTotal = dashJson.leadStats?.total ?? dashJson.leads?.length ?? null;
    const anaJson = ana.json as { leadHealth?: { totalLeads?: number }; pipelineFunnel?: { totalLeads?: number } };
    const anaTotal = anaJson.leadHealth?.totalLeads ?? null;
    const funnelTotal = anaJson.pipelineFunnel?.totalLeads ?? null;
    expect(dashTotal, "dashboard lead rows present").not.toBeNull();
    expect(anaTotal, "analytics total present").not.toBeNull();
    expect(dashTotal, `dashboard ${dashTotal} vs database ${exact}`).toBe(exact);
    expect(anaTotal, `analytics ${anaTotal} vs database ${exact}`).toBe(exact);
    expect(funnelTotal, `analytics funnel ${funnelTotal} vs database ${exact}`).toBe(exact);
    // The list endpoint returns live leads only; without the synthetic QA source it must match exactly.
    const listed = leads.filter((l) => l.source !== "synthetic_qa").length;
    expect(listed, `lead list ${listed} (without synthetic_qa) vs database ${exact}`).toBe(exact);
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

  test("summary endpoints return clean numbers: no undefined or NaN in any figure @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/api/health" });
    for (const url of ["/api/dashboard/summary", "/api/analytics/summary"]) {
      const r = await appApi(s.page, "GET", url);
      expect(r.status, url).toBe(200);
      expect(JSON.stringify(r.json), `${url} contains a broken value`).not.toMatch(/undefined|NaN/);
    }
  });
});
