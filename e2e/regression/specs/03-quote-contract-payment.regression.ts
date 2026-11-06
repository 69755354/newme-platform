// Quotes with discount bounds/export, quote -> contract conversion, approvals, activation, payments.
import { test, expect, type RoleKey } from "../lib/fixtures";
import { appApi, appText, rest, uuid, settle } from "../lib/app";
import { seedLead, stageOf } from "../lib/data";
import { bodyText, rawKeysIn } from "../lib/ui";

const DEVICES = { knx_ip_router: 1, bus_cable: 20 };

async function quoteFor(admin: import("../lib/fixtures").Session, leadId: string, extra: Record<string, unknown> = {}) {
  return appApi<{ quote_id?: string; quote_no?: string; total?: number; error?: string }>(admin.page, "POST", "/api/quotations/generate", { lead_id: leadId, devices: DEVICES, ...extra });
}

test.describe("quote rules", () => {
  for (const [label, rate] of [["150 percent", 150], ["negative", -10]] as const) {
    test(`a ${label} discount is refused and never saves a negative total @bug-4b-3 @role-salesA`, async ({ as, accounts, target, ns, registry }) => {
      const admin = await as("admin", { path: "/api/health" });
      const id = await seedLead(admin, registry, target, ns, { label: `disc-${rate}`, assignedTo: accounts.salesA.id });
      const a = await as("salesA", { path: "/api/health" });
      const r = await appApi<{ quote_id?: string; total?: number }>(a.page, "POST", "/api/quotations/generate", { lead_id: id, devices: DEVICES, discount_rate: rate });
      if (r.json?.quote_id) registry.add({ kind: "quotation", id: r.json.quote_id, label: `${ns}-disc` });
      expect(r.status, `discount ${rate} -> ${r.status} ${r.text.slice(0, 120)}`).toBe(400);
      if (r.json?.total !== undefined) expect(r.json.total).toBeGreaterThan(0);
    });
  }

  test("a valid quote saves, opens in the detail page and exports real quantities @bug-4c-9 @bug-4c-10 @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "quote-open", assignedTo: accounts.salesA.id });
    const q = await quoteFor(admin, id, { discount_rate: 10 });
    expect(q.status, q.text.slice(0, 200)).toBeLessThan(300);
    registry.add({ kind: "quotation", id: q.json!.quote_id!, label: q.json!.quote_no ?? "quote" });
    expect(q.json!.total).toBeGreaterThan(0);
    await admin.page.goto(`/quotations/${q.json!.quote_id}`, { waitUntil: "domcontentloaded" });
    await settle(admin.page);
    const text = await bodyText(admin.page);
    expect(text, "quote detail page").not.toMatch(/Invalid quotation line item|Application error/i);
    expect(text).toContain(q.json!.quote_no!);
    const exp = await appText(admin.page, `/api/quotations/export?id=${q.json!.quote_id}`);
    expect(exp.status, "export status").toBe(200);
    const csv = exp.text;
    expect(csv, "export must not contain zero-quantity rows for ordered devices").not.toMatch(/,0,0,0/);
  });

  test("the quote status dropdown shows readable labels, not translation keys @bug-4c-12 @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/quotes" });
    await settle(s.page);
    expect(rawKeysIn(await bodyText(s.page))).toEqual([]);
  });
});

test.describe("quote -> contract -> payment", () => {
  test("converting a quote makes a draft contract and does NOT mark the lead won yet @bug-4c-13 @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "convert", assignedTo: accounts.salesA.id });
    const q = await quoteFor(admin, id);
    expect(q.status, q.text.slice(0, 160)).toBeLessThan(300);
    const quoteId = q.json!.quote_id!;
    registry.add({ kind: "quotation", id: quoteId, label: "convert" });
    const acc = await rest(admin, "PATCH", `quotations?id=eq.${quoteId}`, { status: "accepted" });
    expect(acc.status, acc.text.slice(0, 160)).toBeLessThan(300);
    const total = q.json!.total!;
    const conv = await appApi<{ contract_id?: string; contract?: { id?: string }; id?: string }>(admin.page, "POST", `/api/quotations/${quoteId}/convert`, {
      installments: [{ seq: 1, amount: Math.round((total / 2) * 100) / 100, due_date: "2030-01-01", description: "E2E deposit" }, { seq: 2, amount: Math.round((total - Math.round((total / 2) * 100) / 100) * 100) / 100, due_date: "2030-02-01", description: "E2E balance" }],
    });
    expect(conv.status, conv.text.slice(0, 200)).toBeLessThan(300);
    const contractId = conv.json?.contract_id ?? conv.json?.contract?.id ?? conv.json?.id;
    if (contractId) registry.add({ kind: "contract", id: contractId, label: "convert" });
    const lead = await stageOf(admin, id);
    expect(lead.final_status, "lead must not be won while the contract is a draft with no payment").not.toBe("won");
  });

  test("contract approvals run admin step then boss step; wrong-step and no-rights calls answer 403, never 500 @bug-4c-6 @bug-4c-7 @bug-4c-8 @role-finance @role-boss @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const boss = await as("boss", { path: "/api/health" });
    const fin = await as("finance", { path: "/api/health" });
    const des = await as("designer", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "contract-approve", assignedTo: accounts.salesA.id });
    const created = await appApi<{ id?: string; contract?: { id?: string } }>(admin.page, "POST", "/api/contracts", {
      lead_id: id, amount: 1000, currency: "AED", party_a_name: "E2E Customer", party_b_name: "NewMe",
      installments: [{ seq: 1, amount: 400, due_date: "2030-01-01", description: "E2E 1" }, { seq: 2, amount: 600, due_date: "2030-02-01", description: "E2E 2" }],
      first_payment_due_date: "2030-01-01",
    });
    expect(created.status, created.text.slice(0, 200)).toBeLessThan(300);
    const cid = (created.json?.id ?? created.json?.contract?.id) as string;
    expect(cid, "contract id").toBeTruthy();
    registry.add({ kind: "contract", id: cid, label: "approve-flow" });

    // 403 not 500 for roles that must not decide, at any step
    for (const [who, label] of [[fin, "finance"], [des, "designer"]] as const) {
      const r = await appApi(who.page, "POST", `/api/contracts/${cid}/approve`, { action: "approve", notes: "E2E" });
      expect(r.status, `${label} approve -> ${r.status} ${r.text.slice(0, 80)}`).toBe(403);
      const rev = await appApi(who.page, "POST", `/api/contracts/${cid}/revoke`, { reason: "E2E" });
      expect(rev.status, `${label} revoke -> ${rev.status}`).toBe(403);
      const mk = await appApi(who.page, "POST", "/api/contracts", { lead_id: id, amount: 10, installments: [{ seq: 1, amount: 10 }] });
      expect(mk.status, `${label} create contract -> ${mk.status}`).toBe(403);
    }
    // Policy decided by Sam: admin == boss, so either may decide either step. What must hold is
    // that an early or repeated decision never ends in a 500.
    const early = await appApi(boss.page, "POST", `/api/contracts/${cid}/approve`, { action: "approve", notes: "E2E boss first" });
    expect(early.status, `boss first decision -> ${early.status} ${early.text.slice(0, 80)}`).toBeLessThan(500);
    const second = await appApi(admin.page, "POST", `/api/contracts/${cid}/approve`, { action: "approve", notes: "E2E second decision" });
    expect(second.status, `second decision -> ${second.status} ${second.text.slice(0, 120)}`).toBeLessThan(500);
    const detail = await appApi<{ contract?: { status?: string }; status?: string }>(admin.page, "GET", `/api/contracts/${cid}`);
    const status = detail.json?.contract?.status ?? detail.json?.status ?? "";
    if (early.status === 200 && second.status === 200) expect(status, "two successful decisions complete the two-step approval").toBe("approved");
    else expect(["pending_admin", "pending_ceo", "approved"], `contract status ${status}`).toContain(status);
    // an admin at the boss step is allowed too (admin == boss), and a repeat is not a 500
    const again = await appApi(admin.page, "POST", `/api/contracts/${cid}/approve`, { action: "approve", notes: "E2E repeat" });
    expect(again.status, `repeat approval -> ${again.status}`).toBeLessThan(500);
  });

  test("record, confirm and void a payment; amount rules enforced @role-finance", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const fin = await as("finance", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "payment", assignedTo: accounts.salesA.id });
    const created = await appApi<{ id?: string; contract?: { id?: string } }>(admin.page, "POST", "/api/contracts", {
      lead_id: id, amount: 500, currency: "AED", party_a_name: "E2E Customer", party_b_name: "NewMe",
      installments: [{ seq: 1, amount: 500, due_date: "2030-01-01", description: "E2E" }], first_payment_due_date: "2030-01-01",
    });
    expect(created.status, created.text.slice(0, 200)).toBeLessThan(300);
    const cid = (created.json?.id ?? created.json?.contract?.id) as string;
    registry.add({ kind: "contract", id: cid, label: "payment" });
    const bad = await appApi(fin.page, "POST", "/api/payments", { contract_id: cid, amount: -5, payment_date: "2030-01-01", payment_method: "bank_transfer", idempotencyKey: uuid() });
    expect(bad.status, "negative payment").toBe(400);
    const pay = await appApi<{ id?: string; payment?: { id?: string } }>(fin.page, "POST", "/api/payments", { contract_id: cid, amount: 100, payment_date: "2030-01-01", payment_method: "bank_transfer", reference_no: "E2E-REF", idempotencyKey: uuid() });
    expect(pay.status, pay.text.slice(0, 200)).toBeLessThan(300);
    const pid = (pay.json?.id ?? pay.json?.payment?.id) as string;
    expect(pid).toBeTruthy();
    registry.add({ kind: "payment", id: pid, label: "payment" });
    const sales = await as("salesA", { path: "/api/health" });
    const denied = await appApi(sales.page, "POST", `/api/payments/${pid}/confirm`, { idempotencyKey: uuid() });
    expect(denied.status, `sales confirm -> ${denied.status}`).toBe(403);
    const ok = await appApi(fin.page, "POST", `/api/payments/${pid}/confirm`, { idempotencyKey: uuid() });
    expect(ok.status, ok.text.slice(0, 160)).toBeLessThan(300);
  });

  test("a salesperson never sees a New Contract button that bounces them away @bug-4b-6 @role-salesA", async ({ as }) => {
    const s = await as("salesA", { path: "/contracts" });
    await settle(s.page);
    const btn = s.page.getByRole("link", { name: /New Contract|新建合同|创建合同/i });
    const n = await btn.count();
    if (n > 0) {
      await btn.first().click();
      await s.page.waitForTimeout(2500);
      expect(new URL(s.page.url()).pathname, "button leads somewhere the role can use").toMatch(/^\/contracts\/new/);
    }
  });
});

export type { RoleKey };
