// OS fix S16 (database batch): the contract owner follows the lead, approval notifications
// reach the next approver, and the notification constraints accept contract_created.
// Needs the S16 migration; against a database without it these are the failing cases.
import { test, expect } from "../lib/fixtures";
import type { Session } from "../lib/fixtures";
import { appApi, rest } from "../lib/app";
import { seedLead } from "../lib/data";

const DEVICES = { knx_ip_router: 1, bus_cable: 20 };

interface NotificationRow { id: string; user_id: string; type: string; related_id: string | null; related_type: string | null; title: string }

/** Notifications of one type about one contract that were written for `userId`. */
async function notificationsFor(s: Session, contractId: string, type: string, userId: string) {
  const r = await rest<NotificationRow[]>(s, "GET", `notifications?related_id=eq.${contractId}&type=eq.${type}&user_id=eq.${userId}&select=id,user_id,type,related_id,related_type,title`);
  expect(r.status, r.text.slice(0, 160)).toBe(200);
  return r.json ?? [];
}

test.describe("S16 database batch", () => {
  test("contract_created notification is written and shown to the managers @role-admin @role-boss", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const boss = await as("boss", { path: "/api/health" });
    const leadId = await seedLead(admin, registry, target, ns, { label: "s16-created", assignedTo: accounts.salesA.id });
    const created = await appApi<{ id?: string }>(admin.page, "POST", "/api/contracts", {
      lead_id: leadId, amount: 1000, currency: "AED", party_a_name: "E2E Customer", party_b_name: "NewMe",
      installments: [{ seq: 1, amount: 400, due_date: "2030-01-01", description: "E2E 1" }, { seq: 2, amount: 600, due_date: "2030-02-01", description: "E2E 2" }],
      first_payment_due_date: "2030-01-01",
    });
    expect(created.status, created.text.slice(0, 200)).toBeLessThan(300);
    const cid = created.json!.id!;
    registry.add({ kind: "contract", id: cid, label: "s16-created" });
    const rows = await notificationsFor(boss, cid, "contract_created", accounts.boss.id);
    expect(rows.length, "boss received contract_created").toBe(1);
    expect(rows[0].related_type).toBe("contract");
  });

  async function convertedContract(admin: Session, registry: Parameters<typeof seedLead>[1], target: Parameters<typeof seedLead>[2], ns: string, ownerId: string, label: string) {
    const leadId = await seedLead(admin, registry, target, ns, { label, assignedTo: ownerId });
    const q = await appApi<{ quote_id?: string; total?: number }>(admin.page, "POST", "/api/quotations/generate", { lead_id: leadId, devices: DEVICES });
    expect(q.status, q.text.slice(0, 200)).toBeLessThan(300);
    const quoteId = q.json!.quote_id!;
    registry.add({ kind: "quotation", id: quoteId, label });
    const accepted = await rest(admin, "PATCH", `quotations?id=eq.${quoteId}`, { status: "accepted" });
    expect(accepted.status, accepted.text.slice(0, 160)).toBeLessThan(300);
    const total = q.json!.total!;
    const half = Math.round((total / 2) * 100) / 100;
    const conv = await appApi<{ contract_id?: string; id?: string }>(admin.page, "POST", `/api/quotations/${quoteId}/convert`, {
      installments: [
        { seq: 1, amount: half, due_date: "2030-01-01", description: "E2E deposit" },
        { seq: 2, amount: Math.round((total - half) * 100) / 100, due_date: "2030-02-01", description: "E2E balance" },
      ],
    });
    expect(conv.status, conv.text.slice(0, 200)).toBeLessThan(300);
    const cid = (conv.json?.contract_id ?? conv.json?.id)!;
    expect(cid, "contract id").toBeTruthy();
    registry.add({ kind: "contract", id: cid, label });
    return cid;
  }

  test("an admin converts a quotation on a salesperson's lead and that salesperson can submit it @role-admin @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const sales = await as("salesA", { path: "/api/health" });
    const cid = await convertedContract(admin, registry, target, ns, accounts.salesA.id, "s16-owner");
    const row = await rest<Array<{ sales_id: string; status: string }>>(sales, "GET", `contracts?id=eq.${cid}&select=sales_id,status`);
    expect(row.status, row.text.slice(0, 160)).toBe(200);
    expect(row.json?.[0]?.sales_id, "the contract belongs to the lead's owner, not to the admin who built the quotation").toBe(accounts.salesA.id);
    const submitted = await appApi(sales.page, "PATCH", `/api/contracts/${cid}`, { status: "pending_admin" });
    expect(submitted.status, `submit for approval -> ${submitted.status} ${submitted.text.slice(0, 160)}`).toBe(200);
  });

  test("a rejected contract resubmitted for approval opens a new approval row and notifies the approvers @role-admin @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const operator = await as("operator", { path: "/api/health" });
    const sales = await as("salesA", { path: "/api/health" });
    const cid = await convertedContract(admin, registry, target, ns, accounts.salesA.id, "s16-resubmit");
    expect((await appApi(sales.page, "PATCH", `/api/contracts/${cid}`, { status: "pending_admin" })).status).toBe(200);
    const rejected = await appApi(admin.page, "POST", `/api/contracts/${cid}/approve`, { action: "reject", notes: "E2E reject" });
    expect(rejected.status, rejected.text.slice(0, 160)).toBe(200);
    const first = await notificationsFor(operator, cid, "contract_pending_approval", accounts.operator.id);
    const again = await appApi(sales.page, "PATCH", `/api/contracts/${cid}`, { status: "pending_admin" });
    expect(again.status, `resubmit -> ${again.status} ${again.text.slice(0, 160)}`).toBe(200);
    const after = await notificationsFor(operator, cid, "contract_pending_approval", accounts.operator.id);
    expect(after.length, "the resubmission produced its own pending-approval notification").toBe(first.length + 1);
    const approvals = await rest<Array<{ step: string; status: string }>>(admin, "GET", `contract_approvals?contract_id=eq.${cid}&select=step,status&order=created_at.asc`);
    expect(approvals.json?.filter((a) => a.step === "admin_review" && a.status === "pending").length, "one pending admin_review row").toBe(1);
  });

  test("passing the first approval step notifies the boss that the second step is open @role-admin @role-boss", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const boss = await as("boss", { path: "/api/health" });
    const cid = await convertedContract(admin, registry, target, ns, accounts.salesA.id, "s16-second-step");
    expect((await appApi(admin.page, "PATCH", `/api/contracts/${cid}`, { status: "pending_admin" })).status).toBe(200);
    expect((await notificationsFor(boss, cid, "contract_pending_approval", accounts.boss.id)).length, "the boss is not told before their step is open").toBe(0);
    const step1 = await appApi<{ new_status?: string }>(admin.page, "POST", `/api/contracts/${cid}/approve`, { action: "approve", notes: "E2E step one" });
    expect(step1.status, step1.text.slice(0, 160)).toBe(200);
    expect(step1.json?.new_status).toBe("pending_ceo");
    expect((await notificationsFor(boss, cid, "contract_pending_approval", accounts.boss.id)).length, "the boss was told their step is open").toBe(1);
  });
});
