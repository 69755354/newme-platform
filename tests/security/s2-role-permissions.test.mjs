/**
 * OS fix stream S2 — permissions, status codes and permission-driven visibility.
 *
 * Review 2026-11-03 (0-总报告 挡住干活#3, 安全风险#1/#2; 2-security F-04/F-06;
 * 4a problem 1/2/20; 4c problems 1-8/20). The database half lives in
 * supabase/migrations/20261104110000_role_least_privilege.sql and is exercised
 * against a real PostgreSQL by tests/database/role-permissions.py (CI job
 * migration-replay). This file covers what needs no database:
 *
 *   1. the money/contract routes answer a refusal with its mapped status instead
 *      of 500 — the detached pino method (`const log = logger.warn; log(...)`)
 *      threw on `this` and every 42501 became "Internal server error";
 *   2. impersonation refuses an inactive target;
 *   3. the contract action buttons follow the routines' own role/step rules;
 *   4. finance / designer / operator sidebars, the New Lead button and the New
 *      Contract link only offer what the role can actually use;
 *   5. the migration's static shape.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { contractActionPermissions, APPROVAL_STEP_ROLES } from "../../src/lib/contract-action-permissions.mjs";
import { LEAD_CREATE_ROLES, LEAD_IMPORT_ROLES } from "../../src/lib/lead-create-roles.mjs";
import * as moneyRpc from "../../src/lib/money-rpc.mjs";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

function loadModule(relativePath, mocks) {
  const ts = require("typescript");
  const filename = path.join(root, relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const previousLoad = Module._load;
  Module._load = (request, parent, isMain) => Object.hasOwn(mocks, request)
    ? mocks[request]
    : previousLoad.call(Module, request, parent, isMain);
  try {
    loaded._compile(outputText, filename);
    return loaded.exports;
  } finally {
    Module._load = previousLoad;
  }
}

const nextServer = {
  NextRequest: class {},
  NextResponse: {
    json: (body, init) => ({ body, status: init?.status ?? 200, headers: new Headers(), cookies: { set: () => {} } }),
  },
};

/**
 * A logger with pino's one relevant property: its level methods read `this`.
 * pino's `logger.warn` is `LOG(...)` bound to the instance through `this[writeSym]`;
 * called detached it throws a TypeError, which is exactly the production defect.
 */
function pinoLikeLogger() {
  const calls = [];
  const logger = { calls };
  for (const level of ["info", "warn", "error"]) {
    logger[level] = function (...args) {
      if (this !== logger) throw new TypeError(`pino ${level}() called without its logger as this`);
      calls.push({ level, args });
    };
  }
  return logger;
}

const MONEY_ROUTES = [
  "src/app/api/contracts/[id]/approve/route.ts",
  "src/app/api/contracts/[id]/revoke/route.ts",
  "src/app/api/contracts/[id]/route.ts",
  "src/app/api/contracts/route.ts",
  "src/app/api/quotations/[id]/convert/route.ts",
  "src/app/api/payments/[id]/confirm/route.ts",
  "src/app/api/payments/[id]/void/route.ts",
  "src/app/api/payments/[id]/allocate/route.ts",
];

// ───────────────────────────────────────────────────────────────────────────
// 1. Refusals are 403/400/404, not 500
// ───────────────────────────────────────────────────────────────────────────
test("no money route detaches a pino level method from its logger", () => {
  for (const route of MONEY_ROUTES) {
    const source = read(route);
    assert.doesNotMatch(source, /=\s*logger\.(error|warn|info)\s*;/, `${route} still detaches a logger method`);
    assert.doesNotMatch(source, /\?\s*logger\.error\s*:\s*logger\.warn/, `${route} still selects a detached method`);
  }
});

function contractRoute(relativePath, rpcError, extraMocks = {}) {
  const logger = pinoLikeLogger();
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: "user-finance" } }, error: null }) },
    rpc: async () => ({ data: null, error: rpcError }),
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role: "finance" }, error: null }) }) }) }),
  };
  const route = loadModule(relativePath, {
    "next/server": nextServer,
    "@/lib/supabase-server": { createServerSupabase: async () => supabase },
    "@/lib/logger": { logger, genReqId: () => "req-s2" },
    "@/lib/money-rpc.mjs": moneyRpc,
    "@/lib/notification-dispatch": { dispatchPersistedNotification: async () => {} },
    "@/lib/notifications": { createNotification: async () => {}, getAdminUserIds: async () => [] },
    "@/lib/request-auth-context": { applyPrivateNoStore: (response) => response },
    ...extraMocks,
  });
  return { route, logger };
}

const refusal = { code: "42501", message: "only a manager may activate or complete a contract" };

test("POST /api/contracts/[id]/approve reports a 42501 refusal as 403 and logs it at warn", async () => {
  const { route, logger } = contractRoute("src/app/api/contracts/[id]/approve/route.ts", refusal);
  const response = await route.POST(
    new Request("https://app.newme.ae/api/contracts/c1/approve", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "approve" }),
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.error, refusal.message);
  assert.deepEqual(logger.calls.map((call) => call.level), ["warn"]);
});

test("POST /api/contracts/[id]/revoke reports a 42501 refusal as 403, not 500", async () => {
  const { route } = contractRoute("src/app/api/contracts/[id]/revoke/route.ts", refusal);
  const response = await route.POST(
    new Request("https://app.newme.ae/api/contracts/c1/revoke", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "duplicate" }),
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );
  assert.equal(response.status, 403);
  assert.equal(response.body.error, refusal.message);
});

test("an unmapped database failure is still a 500 logged at error, with no database text relayed", async () => {
  const { route, logger } = contractRoute("src/app/api/contracts/[id]/approve/route.ts", { code: "XX000", message: "row 42 says 0501234567" });
  const response = await route.POST(
    new Request("https://app.newme.ae/api/contracts/c1/approve", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reject" }),
    }),
    { params: Promise.resolve({ id: "c1" }) },
  );
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(response.body), /0501234567/);
  assert.deepEqual(logger.calls.map((call) => call.level), ["error"]);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. Impersonation refuses an inactive target
// ───────────────────────────────────────────────────────────────────────────
function impersonate(target) {
  const adminCalls = [];
  const context = {
    role: "admin",
    user: { id: "admin-1", email: "admin@example.invalid" },
    profile: { full_name: "Admin" },
  };
  class RequestAuthError extends Error {}
  const route = loadModule("src/app/api/admin/impersonate/route.ts", {
    "next/server": nextServer,
    "@/lib/request-auth-context": {
      getRequestAuthContext: async () => context,
      applyRequestAuthCookies: (_context, response) => response,
      RequestAuthError,
      requestAuthErrorResponse: () => ({ status: 401 }),
    },
    "@/lib/supabase-admin": {
      supabaseAdmin: {
        auth: { admin: { generateLink: async () => { adminCalls.push("generateLink"); return { data: { properties: { action_link: "https://example.invalid/l" } }, error: null }; } } },
        from: (table) => table === "audit_logs"
          ? { insert: () => Promise.resolve({ error: null }) }
          : { select: () => ({ eq: () => ({ single: async () => ({ data: target, error: null }) }) }) },
      },
    },
  });
  return { route, adminCalls };
}

test("POST /api/admin/impersonate refuses a deactivated target with 403 and mints no link", async () => {
  const { route, adminCalls } = impersonate({ id: "t", email: "t@example.invalid", full_name: "T", role: "sales", is_active: false });
  const response = await route.POST(new Request("https://app.newme.ae/api/admin/impersonate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUserId: "t" }),
  }));
  assert.equal(response.status, 403);
  assert.match(response.body.error, /inactive/);
  assert.deepEqual(adminCalls, []);
});

test("POST /api/admin/impersonate still mints a link for an active target", async () => {
  const { route, adminCalls } = impersonate({ id: "t", email: "t@example.invalid", full_name: "T", role: "sales", is_active: true });
  const response = await route.POST(new Request("https://app.newme.ae/api/admin/impersonate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetUserId: "t" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(adminCalls, ["generateLink"]);
  assert.match(read("src/app/api/admin/impersonate/route.ts"), /select\("id, email, full_name, role, is_active"\)/);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. Contract action buttons follow the routines' rules
// ───────────────────────────────────────────────────────────────────────────
test("contract action permissions mirror approve_contract / revoke_contract and the upload/remind routes", () => {
  const sql = read("supabase/migrations/20260812000000_money_actor_identity_and_atomicity.sql")
    + read("supabase/migrations/20260814000000_l0_round3_authorization_and_integrity.sql");
  // The step roles are read out of the routine, not restated by hand.
  const adminStep = /pending_admin[\s\S]{0,200}?money_actor\(p_approver_id, array\['admin', 'operator'\]\)/;
  const ceoStep = /pending_ceo[\s\S]{0,200}?money_actor\(p_approver_id, array\['boss'\]\)/;
  assert.match(sql, adminStep);
  assert.match(sql, ceoStep);
  assert.deepEqual([...APPROVAL_STEP_ROLES.pending_admin], ["admin", "operator"]);
  assert.deepEqual([...APPROVAL_STEP_ROLES.pending_ceo], ["boss"]);

  const expect = (role, isOwner, status, expected) =>
    assert.deepEqual(contractActionPermissions(role, isOwner, status), expected, `${role}/${status}/${isOwner}`);
  expect("finance", false, "pending_admin", { approve: false, revoke: false, upload: false, remind: false });
  expect("boss", false, "pending_admin", { approve: false, revoke: false, upload: true, remind: true });
  expect("admin", false, "pending_admin", { approve: true, revoke: false, upload: true, remind: true });
  expect("operator", false, "pending_admin", { approve: true, revoke: false, upload: false, remind: true });
  expect("admin", false, "pending_ceo", { approve: false, revoke: false, upload: true, remind: true });
  expect("boss", false, "pending_ceo", { approve: true, revoke: false, upload: true, remind: true });
  expect("boss", false, "active", { approve: false, revoke: true, upload: false, remind: true });
  expect("finance", false, "active", { approve: false, revoke: false, upload: false, remind: false });
  expect("sales", true, "draft", { approve: false, revoke: false, upload: true, remind: true });
  expect("sales", false, "draft", { approve: false, revoke: false, upload: false, remind: false });
  expect("designer", false, "active", { approve: false, revoke: false, upload: false, remind: false });
});

test("the contract detail API and page use the shared permissions, not canManage, for the action buttons", () => {
  const api = read("src/app/api/contracts/[id]/route.ts");
  assert.match(api, /import \{ contractActionPermissions \} from "@\/lib\/contract-action-permissions\.mjs"/);
  assert.match(api, /permissions: contractActionPermissions\(role, contract\.sales_id === user\.id, contract\.status\)/);
  const page = read("src/app/(dashboard)/contracts/[id]/page.tsx");
  assert.match(page, /const showApprove = permissions\.approve;/);
  assert.match(page, /const showUploadButton = permissions\.upload;/);
  assert.match(page, /\{permissions\.remind && \(/);
  assert.match(page, /\{permissions\.revoke && \(/);
  assert.doesNotMatch(page, /canManage &&\s*\(\(contract\.status === "pending_admin"/);
  assert.doesNotMatch(page, /canManage && \["active", "approved"\]\.includes\(contract\.status\)/);
});

// ───────────────────────────────────────────────────────────────────────────
// 4. Permission-driven visibility
// ───────────────────────────────────────────────────────────────────────────
test("the New Lead and import buttons are shown only to roles whose requests are accepted", () => {
  const page = read("src/app/(dashboard)/leads/page.tsx");
  assert.match(page, /const canCreateLead = LEAD_CREATE_ROLES\.includes\(salesRole \?\? ""\)/);
  assert.match(page, /\{canCreateLead && \(\s*<button onClick=\{\(\) => setShowQuickCreate\(true\)\}/);
  assert.deepEqual([...LEAD_CREATE_ROLES], ["admin", "boss", "operator", "sales"]);
  // Derived from the policies, not restated: these are the roles the INSERT
  // policies on public.leads name.
  const policies = read("supabase/migrations/20260630200000_rls_policy_remediation.sql");
  assert.match(policies, /policy_leads_insert_admin\s+ON leads FOR INSERT TO authenticated\s+WITH CHECK \(EXISTS \(SELECT 1 FROM profiles WHERE id = auth\.uid\(\) AND role IN \('admin','boss','operator'\)\)\)/);
  const s2 = read("supabase/migrations/20261104110000_role_least_privilege.sql");
  assert.match(s2, /policy_leads_insert_sales ON public\.leads FOR INSERT TO authenticated WITH CHECK \('\s*\|\| '\(EXISTS \(SELECT 1 FROM public\.profiles WHERE id = auth\.uid\(\) AND role = ''sales''\)\)/);
});

test("the Import button follows the import routes (admin and boss only), not the create roles (review F-1)", () => {
  const page = read("src/app/(dashboard)/leads/page.tsx");
  assert.match(page, /const canImportLeads = LEAD_IMPORT_ROLES\.includes\(salesRole \?\? ""\)/);
  assert.match(page, /\{canImportLeads && \(\s*<button onClick=\{\(\) => setShowImport\(true\)\}/);
  assert.deepEqual([...LEAD_IMPORT_ROLES], ["admin", "boss"]);
  // bound to the routes: both refuse everything outside this list
  for (const route of ["src/app/api/leads/import/preview/route.ts", "src/app/api/leads/import/confirm/route.ts"]) {
    const source = read(route);
    const gate = source.includes('!["admin", "boss"].includes(profile.role)');
    assert.ok(gate, `${route} no longer restricts the import to admin and boss`);
  }
});

test("lead detail offers 'New contract' only to roles /contracts/new admits (review F-2)", () => {
  const panel = read("src/app/(dashboard)/leads/[id]/LeadContractsPanel.tsx");
  assert.match(panel, /setCanCreateContract\(json\.role === "admin" \|\| json\.role === "boss"\)/);
  assert.equal((panel.match(/href=\{`\/contracts\/new\?lead_id=\$\{leadId\}`\}/g) || []).length, 2);
  assert.equal((panel.match(/\{canCreateContract && \(/g) || []).length, 2, "both New contract links must be gated");
  assert.match(read("src/app/(dashboard)/contracts/new/page.tsx"), /useRequireRole\(\["admin", "boss"\]\)/);
  // the panel's data source reports the role it uses
  assert.match(read("src/app/api/contracts/route.ts"), /NextResponse\.json\(\{ data, role: userRole \}\)/);
});

test("contract list buttons (upload, remind, revoke) use the shared per-role rules (review F-3)", () => {
  const list = read("src/app/(dashboard)/contracts/page.tsx");
  assert.match(list, /contractActionPermissions\(role \?\? "", !!userId && c\.sales_id === userId, c\.status\)/);
  assert.match(list, /const canUpload = \(c: Contract\) => actionPermissions\(c\)\.upload;/);
  assert.match(list, /const canRevoke = \(c: Contract\) => actionPermissions\(c\)\.revoke;/);
  assert.match(list, /c\.first_payment_status !== "paid" && canRemind\(c\)/);
  assert.doesNotMatch(list, /\["draft", "pending_admin", "pending_ceo"\]\.includes\(c\.status\)/);
  assert.match(read("src/app/api/contracts/list/route.ts"), /userId,\s*\n\s*totalCount/);
  // the list shows finance nothing it cannot use, whichever status the contract is in
  for (const status of ["draft", "pending_admin", "pending_ceo", "approved", "active", "suspended"]) {
    const finance = contractActionPermissions("finance", false, status);
    assert.deepEqual(finance, { approve: false, revoke: false, upload: false, remind: false }, status);
  }
  assert.equal(contractActionPermissions("boss", false, "suspended").revoke, true, "list and detail agree on suspended");
});

test("the products page links back to quotes only for roles /quotes admits (review F-4)", () => {
  const page = read("src/app/(dashboard)/products/page.tsx");
  assert.match(page, /const canOpenQuotes = role === "admin" \|\| role === "boss" \|\| role === "sales";/);
  assert.match(page, /\{canOpenQuotes && \(\s*<Link prefetch=\{false\} href="\/quotes"/);
  assert.match(read("src/app/(dashboard)/quotes/page.tsx"), /\["admin", "boss", "sales"\]/);
});

test("the projects page admits the roles that can read projects, and finance is not one of them (review F-5)", () => {
  const page = read("src/app/(dashboard)/projects/page.tsx");
  const roles = page.match(/!\[(".*?")\]\.includes\(profile\.role\)/);
  assert.ok(roles, "projects page role list not found");
  assert.deepEqual(roles[1].replaceAll('"', "").split(/,\s*/), ["admin", "boss", "sales", "operator", "designer"]);
  const sql = read("supabase/migrations/20261104110000_role_least_privilege.sql");
  assert.ok(sql.includes("'policy_projects_select_designer'"));
});

test("the contract detail page does not link finance to a lead it cannot open", () => {
  const page = read("src/app/(dashboard)/contracts/[id]/page.tsx");
  assert.match(page, /\{viewerRole !== "finance" && \(\s*<Link prefetch=\{false\} href=\{`\/leads\/\$\{contract\.leads\.id\}`\}/);
});

test("the New Contract link is shown only to the roles /contracts/new admits", () => {
  const list = read("src/app/(dashboard)/contracts/page.tsx");
  const newPage = read("src/app/(dashboard)/contracts/new/page.tsx");
  assert.match(newPage, /useRequireRole\(\["admin", "boss"\]\)/);
  assert.match(list, /\{\(role === "admin" \|\| role === "boss"\) && \(\s*<Link prefetch=\{false\} href="\/contracts\/new"/);
});

test("finance and designer have their own sidebars and role labels", () => {
  const nav = read("src/lib/nav.ts");
  assert.match(nav, /export const FINANCE_NAV: NavItem\[\] = \[/);
  assert.match(nav, /export const DESIGNER_NAV: NavItem\[\] = \[/);
  assert.match(nav, /finance: "FINANCE_NAV"/);
  assert.match(nav, /designer: "DESIGNER_NAV"/);
  // operator was offered /quotes, whose server guard admits admin/boss/sales only
  assert.match(nav, /href: "\/quotes",\s*labelKey: "mgmtQuotes", icon: Calculator, roles: \["admin", "boss"\]/);
  const layout = read("src/app/(dashboard)/layout.tsx");
  assert.match(layout, /role === "finance"\s*\?\s*t\("nav\.roleFinance"\)/);
  assert.match(layout, /role === "designer"\s*\?\s*t\("nav\.roleDesigner"\)/);
  const i18n = read("src/lib/i18n/translations.ts");
  for (const key of ["roleFinance", "roleDesigner", "financePayments"]) {
    assert.equal((i18n.match(new RegExp(`^      ${key}: "`, "gm")) || []).length >= 2, true, `${key} missing in en or zh nav section`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 5. Migration shape (behaviour is in tests/database/role-permissions.py)
// ───────────────────────────────────────────────────────────────────────────
test("the S2 migration admits operator to stage transitions and drops the company-wide designer/finance policies", () => {
  const sql = read("supabase/migrations/20261104110000_role_least_privilege.sql");
  assert.match(sql, /^-- NO_ROLLBACK: /m);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.transition_lead_stage\(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid\)/);
  assert.match(sql, /NOT IN \('admin', 'boss', 'operator', 'sales', 'user', 'salesperson'\)/);
  assert.match(sql, /v_actor_role NOT IN \('admin', 'boss', 'operator'\) AND v_current_lead\.assigned_to IS DISTINCT FROM v_actor_id/);
  assert.match(sql, /SET search_path TO 'pg_catalog', 'public', 'pg_temp'/);
  assert.doesNotMatch(sql, /'Lead stage changed concurrently'/, "the phase tool rejects that literal as non-transactional");
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.transition_lead_stage\(uuid, text, text, text, uuid\) FROM PUBLIC, anon, authenticated;/);
  for (const policy of [
    "policy_activities_select_designer", "policy_activities_select_finance", "policy_activities_insert_designer",
    "policy_business_events_select_designer", "policy_business_events_select_finance",
    "policy_lead_milestones_select_designer",
    "policy_products_insert_designer", "policy_products_update_designer", "policy_products_delete_designer",
    "policy_transfer_history_select_finance", "policy_customers_select_designer",
  ]) {
    assert.ok(sql.includes(`'${policy}'`), `${policy} is not dropped`);
  }
  assert.match(sql, /policy_activities_insert_sales ON public\.activities FOR INSERT TO authenticated WITH CHECK/);
  assert.match(sql, /policy_leads_select_designer_involved/);
  assert.match(sql, /DROP POLICY IF EXISTS policy_leads_select_finance_contracted ON public\.leads/);
  assert.doesNotMatch(sql, /CREATE POLICY policy_leads_select_finance/, "finance reads no lead rows");
  // Exactly two SECURITY DEFINER functions: the stage RPC and contract_lead_display,
  // which carries the A1 entry guard and a pinned search_path. No policy is `true`.
  assert.equal((sql.match(/^\s*SECURITY DEFINER$/gm) || []).length, 2);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.contract_lead_display[\s\S]*?SECURITY DEFINER\s+SET search_path = pg_catalog, public, pg_temp[\s\S]*?assert_current_session_at_entry\(\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.contract_lead_display\(uuid\) FROM PUBLIC, anon;/);
  assert.doesNotMatch(sql, /USING \(true\)/i);
  for (const fn of ["money_write_is_direct()", "guard_contracts_write()", "guard_payments_write()", "guard_installment_plans_write()",
    "guard_definer_only_write()", "require_current_session()", "contract_transition_is_allowed(text, text)",
    "guard_contract_transition()", "guard_quotations_write()"]) {
    assert.ok(sql.includes(`'public.${fn}'`), `${fn} search_path not pinned`);
  }
  assert.match(sql, /ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp/);
});

test("the S2 migration closes the project/workflow/file/customer routes around the designer rules (review B-1, F-6)", () => {
  const sql = read("supabase/migrations/20261104110000_role_least_privilege.sql");
  // projects: sales only on insert/update, never a policy without a role check
  assert.match(sql, /policy_projects_insert_sales ON public\.projects FOR INSERT TO authenticated WITH CHECK \('\s*\|\| '\(EXISTS \(SELECT 1 FROM public\.profiles WHERE id = auth\.uid\(\) AND role = ''sales''\)\) AND sales_id = auth\.uid\(\)\)'/);
  assert.match(sql, /policy_projects_update_sales ON public\.projects FOR UPDATE[\s\S]*?role = ''sales''[\s\S]*?WITH CHECK[\s\S]*?role = ''sales''/);
  // designer cannot re-point a project: trigger refuses lead_id and the people columns
  assert.match(sql, /'lead_id', 'customer_id', 'contract_id', 'sales_id', 'project_manager', 'assigned_to'/);
  assert.match(sql, /CREATE TRIGGER trg_guard_projects_lead_binding BEFORE INSERT OR UPDATE ON public\.projects/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.guard_projects_lead_binding\(\) FROM PUBLIC, anon, authenticated;/);
  // company-wide workflow stages replaced by the involved-lead scope
  assert.match(sql, /DROP POLICY IF EXISTS policy_lead_workflow_stages_select_designer ON public\.lead_workflow_stages/);
  assert.match(sql, /CREATE POLICY policy_lead_workflow_stages_select_designer_involved/);
  // file records and customers
  assert.match(sql, /lead_files_insert_staff ON public\.lead_files FOR INSERT[\s\S]*?uploaded_by = auth\.uid\(\) AND/);
  assert.match(sql, /policy_customers_insert_sales ON public\.customers FOR INSERT[\s\S]*?role = ''sales''/);
  // the release gate's predicate names every one of them
  const manifest = JSON.parse(read("infra/release/release-manifest.json"));
  const predicate = manifest.posture.deferred_contract.predicates.find((p) => p.name === "s2-role-least-privilege-present").sql;
  for (const needle of ["trg_guard_projects_lead_binding", "policy_projects_insert_sales", "policy_projects_update_sales",
    "policy_lead_workflow_stages_select_designer", "policy_lead_workflow_stages_select_designer_involved",
    "lead_files_insert_staff", "policy_customers_insert_sales", "contract_lead_display(uuid)", "policy_projects_update_designer_involved"]) {
    assert.ok(predicate.includes(needle), `posture predicate does not check ${needle}`);
  }
  // behaviour is proven against PostgreSQL by tests/database/role-permissions.py
  const script = read("tests/database/role-permissions.py");
  assert.match(script, /designer, finance and sales cannot attach or re-point a project/);
  assert.match(script, /designer reads workflow stages only for its involved leads/);
});

test("the role permission database test follows the isolated-database conventions of tests/database", () => {
  // The CI wiring (a `Role permission boundaries` step after the Meta ads one in
  // the migration-replay job, `createdb --template history
  // newme_role_permissions_test` + `PGDATABASE=newme_role_permissions_test
  // python3 tests/database/role-permissions.py`) is added by the coordinator:
  // the push token of the fix streams has no `workflow` scope.
  const script = read("tests/database/role-permissions.py");
  assert.match(script, /PGDATABASE"\) == "newme_role_permissions_test"/);
  assert.match(script, /rollback;/);
});
