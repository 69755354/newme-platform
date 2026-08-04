import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyDatabaseTypes } from "../../scripts/run-sam20-database-gate.mjs";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

function sam20TypeFixture() {
  const tables = [
    "organizations",
    "memberships",
    "platform_staff",
    "support_sessions",
    "platform_action_approvals",
    "platform_action_approval_events",
    "audit_events",
    "leads",
  ];
  const tableSource = tables.map((table) => {
    const baseColumn = table === "leads" ? "organization_id" : "id";
    const forward = table === "organizations"
      ? {
          Row: ["billable_seat_limit: number", "plan_key: string"],
          Insert: ["billable_seat_limit?: number", "plan_key?: string"],
          Update: ["billable_seat_limit?: number", "plan_key?: string"],
        }
      : table === "platform_staff"
        ? {
          Row: ["role_key: string"],
            Insert: ["role_key: string"],
            Update: ["role_key?: string"],
          }
        : { Row: [], Insert: [], Update: [] };
    const section = (name) => {
      const optional = name === "Update" ? "?" : "";
      const properties = [
        `${baseColumn}${optional}: string`,
        ...forward[name],
      ].map((property) => `          ${property}`).join("\n");
      return `        ${name}: {\n${properties}\n        }`;
    };
    return `      ${table}: {\n${["Row", "Insert", "Update"].map(section).join("\n")}\n      }`;
  }).join("\n");
  const columns = tables.map((table, ordinal) => ({
    table_name: table,
    column_name: table === "leads" ? "organization_id" : "id",
    ordinal_position: ordinal + 1,
    is_nullable: "NO",
    udt_name: "uuid",
    column_default: null,
  }));
  return {
    source: `export type Database = {\n  public: {\n    Tables: {\n${tableSource}\n    }\n    Functions: {\n      requested_organization_id: { Args: never; Returns: string }\n    }\n  }\n}`,
    contract: {
      columns,
      foreign_keys: [],
      requested_organization_id_return: "uuid",
    },
  };
}

test("SAM-20 migration establishes one explicit Lead organization boundary", async () => {
  const sql = await read(
    "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
  );

  for (const table of [
    "organizations",
    "memberships",
    "platform_staff",
    "support_sessions",
    "audit_events",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`));
    assert.match(
      sql,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`),
    );
  }

  assert.match(
    sql,
    /ALTER TABLE public\.leads[\s\S]*ADD COLUMN IF NOT EXISTS organization_id uuid/i,
  );
  assert.match(
    sql,
    /ALTER TABLE public\.leads[\s\S]*ALTER COLUMN organization_id SET NOT NULL/i,
  );
  assert.match(
    sql,
    /CREATE POLICY sam20_leads_organization_boundary[\s\S]*AS RESTRICTIVE[\s\S]*requested_organization_id\(\)[\s\S]*memberships/i,
  );
  assert.match(
    sql,
    /CREATE TRIGGER sam20_enforce_lead_organization_context[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON public\.leads/i,
  );
  assert.match(sql, /MESSAGE = 'organization_context_required'/);
  assert.match(sql, /MESSAGE = 'lead_organization_context_mismatch'/);
  assert.match(sql, /MESSAGE = 'active_organization_membership_required'/);

  for (const table of [
    "activities",
    "business_events",
    "chat_messages",
    "follow_up_logs",
    "lead_documents",
    "lead_milestones",
    "tasks",
  ]) {
    assert.ok(sql.includes(`'${table}'`), `missing Lead child boundary: ${table}`);
  }
  assert.match(sql, /ALTER VIEW public\.v_lead_trace SET \(security_invoker = true\)/i);
});

test("SAM-20 keeps Data API exposure explicit and support tables private", async () => {
  const sql = await read(
    "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
  );

  assert.match(sql, /GRANT SELECT ON TABLE public\.organizations TO authenticated/i);
  assert.match(sql, /GRANT SELECT ON TABLE public\.memberships TO authenticated/i);
  for (const table of ["platform_staff", "support_sessions", "audit_events"]) {
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon, authenticated`, "i"),
    );
    assert.doesNotMatch(
      sql,
      new RegExp(`GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL) ON TABLE public\\.${table} TO authenticated`, "i"),
    );
  }
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.requested_organization_id\(\) FROM PUBLIC/i,
  );
  assert.doesNotMatch(sql, /SECURITY DEFINER/i);
});

test("browser, server, API, UI, and support audit use the same organization context", async () => {
  const [
    browser,
    server,
    provider,
    listRoute,
    timelineRoute,
    access,
    newLead,
  ] = await Promise.all([
    read("src/lib/supabase.ts"),
    read("src/lib/supabase-server.ts"),
    read("src/app/(dashboard)/leads/LeadOrganizationProvider.tsx"),
    read("src/app/api/leads/list/route.ts"),
    read("src/app/api/leads/[id]/timeline/route.ts"),
    read("src/lib/lead-organization-access.ts"),
    read("src/app/(dashboard)/leads/new/page.tsx"),
  ]);

  assert.match(browser, /ORGANIZATION_CONTEXT_HEADER/);
  assert.match(server, /ORGANIZATION_CONTEXT_HEADER/);
  assert.match(provider, /\/api\/organizations\/context/);
  assert.match(provider, /window\.location\.reload\(\)/);
  assert.match(listRoute, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(timelineRoute, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(newLead, /organization_id: organizationId/);

  const auditInsert = access.indexOf('.from("audit_events").insert');
  const supportReturn = access.lastIndexOf("supportSessionId,");
  assert.ok(auditInsert >= 0, "support access must write audit evidence");
  assert.ok(
    supportReturn > auditInsert,
    "support client must be returned only after the audit insert",
  );
  assert.match(access, /support_audit_required/);
  assert.match(access, /support_session_not_authorized/);
});

test("Lead directory candidates are constrained to active members of the requested organization", async () => {
  const [listRoute, uat] = await Promise.all([
    read("src/app/api/leads/list/route.ts"),
    read("scripts/uat/sam20-lead-organization-isolation.mjs"),
  ]);

  const membershipLookup = listRoute.indexOf('.from("memberships")');
  const profileLookup = listRoute.indexOf('.from("profiles")');
  assert.ok(membershipLookup >= 0, "organization memberships must be loaded");
  assert.ok(
    profileLookup > membershipLookup,
    "membership IDs must be loaded before the profile directory",
  );
  assert.match(listRoute, /\.eq\("organization_id", access\.organizationId\)/);
  assert.match(listRoute, /\.eq\("status", "active"\)/);
  assert.match(listRoute, /\.in\("id", organizationMemberUserIds\)/);
  assert.match(listRoute, /access\.supportSessionId[\s\S]*data: \[\] as SalesUserRow\[\]/);

  assert.match(uat, /listAProfileIds\.includes\(userA\.id\)/);
  assert.match(uat, /!listAProfileIds\.includes\(userB\.id\)/);
  assert.match(uat, /listBProfileIds\.includes\(userB\.id\)/);
  assert.match(uat, /!listBProfileIds\.includes\(userA\.id\)/);
});

test("SAM-20 UAT uses the canonical release manifest and verifies every fixture class is removed", async () => {
  const uat = await read("scripts/uat/sam20-lead-organization-isolation.mjs");

  assert.match(uat, /RELEASE_MANIFEST_PATH = "\/runner\/release\/manifest\.json"/);
  assert.match(uat, /readFile\(RELEASE_MANIFEST_PATH, "utf8"\)/);
  assert.match(uat, /manifest\?\.git_sha === releaseSha/);
  assert.doesNotMatch(uat, /fetch\([\s\S]*\/runner\/release\/manifest\.json/);
  assert.doesNotMatch(uat, /manifest\?\.commit/);
  for (const fixture of [
    "organizations",
    "memberships",
    "membership_roles",
    "leads",
    "platform_staff",
    "support_sessions",
    "audit_events",
    "user_session_daily",
    "audit_logs",
    "profiles",
    "auth_fixtures",
  ]) {
    assert.ok(uat.includes(`"${fixture}"`) || uat.includes(`${fixture}:count=`));
  }
  assert.match(uat, /cleanup: "verified"/);
  assert.match(uat, /cleanupCounts,/);
  assert.match(uat, /from\("user_session_daily"\)\.delete\(\)\.in\("user_id", users\)/);
  assert.match(uat, /from\("audit_logs"\)\.delete\(\)\.in\("actor_id", users\)/);
  assert.match(
    uat,
    /createMembership\(organizationA, userA\.id, "sales_agent"\)/,
  );
  assert.match(
    uat,
    /createMembership\(organizationB, userB\.id, "sales_agent"\)/,
  );
  assert.match(
    uat,
    /createMembership\(organizationA, companyAdminUser\.id, "org_admin"\)/,
  );
  assert.match(
    uat,
    /from\("membership_roles"\)[\s\S]*\.insert\(\{[\s\S]*organization_id: organizationId,[\s\S]*membership_id: membership\.id,[\s\S]*role_id: role\.id/,
  );
  assert.match(
    uat,
    /from\("membership_roles"\)\.delete\(\)\.in\("organization_id", organizationIds\)/,
  );
  assert.match(uat, /typeof error\.message === "string"/);
  assert.match(uat, /role_key: "platform_ops"/);
  assert.match(uat, /role_key: "platform_owner"/);
  assert.match(uat, /support_user_id: supportUser\.id/);
  assert.doesNotMatch(uat, /approver_user_id: approverUser\.id/);
  assert.match(uat, /approval_request_id: supportApprovalId/);
  assert.match(uat, /independentApproval: 1/);
  assert.match(uat, /approvalEvents: 3/);
  assert.doesNotMatch(uat, /cleanup: 0/);
});

test("SAM-20 synthetic support cleanup stays service-role and marker bound", async () => {
  const [migration, rollback, gate] = await Promise.all([
    read("supabase/migrations/20260804193000_sam20_synthetic_support_cleanup_boundary.sql"),
    read("supabase/rollback/20260804193000_sam20_synthetic_support_cleanup_boundary_rollback.sql"),
    read("scripts/run-sam23-database-gate.mjs"),
  ]);
  assert.match(migration, /current_user = 'service_role'/);
  assert.match(migration, /\^sam20-\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4/);
  assert.match(migration, /platform_action_approval_events/);
  assert.match(migration, /audit_events/);
  assert.match(migration, /sam20_is_synthetic_support_approval\(OLD\.id\)/);
  assert.match(migration, /RAISE EXCEPTION 'immutable_record'/);
  assert.match(rollback, /sam20_synthetic_support_cleanup_rollback_requires_staging_or_test/);
  assert.match(rollback, /DROP FUNCTION public\.sam20_is_synthetic_support_approval\(uuid\)/);
  assert.match(gate, /sam20_synthetic_support_cleanup_boundary_fixture/);
  assert.match(gate, /sam20_synthetic_support_cleanup_rollback_not_fail_closed/);
});

test("SAM-20 database gate fails closed and CI runs the disposable apply/rollback roundtrip", async () => {
  assert.throws(
    () => verifyDatabaseTypes("", {
      columns: [],
      foreign_keys: [],
      requested_organization_id_return: "uuid",
    }),
    /database_contract_table_missing:organizations/,
  );

  const [runner, rollback, workflow, packageJson] = await Promise.all([
    read("scripts/run-sam20-database-gate.mjs"),
    read("supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql"),
    read(".github/workflows/ci.yml"),
    read("package.json"),
  ]);
  assert.match(runner, /postgres:17-alpine@sha256:[a-f0-9]{64}/);
  assert.match(
    runner,
    /FORWARD_TYPE_COLUMNS[\s\S]*organizations[\s\S]*billable_seat_limit[\s\S]*plan_key/,
  );
  assert.match(
    runner,
    /FORWARD_TYPE_COLUMNS[\s\S]*platform_staff[\s\S]*role_key[\s\S]*Row: ": string"/,
  );
  assert.match(runner, /database_type_forward_mismatch/);
  assert.match(runner, /database_type_unexpected_columns/);
  assert.match(runner, /sam20_rollback_without_environment/);
  assert.match(runner, /sam20_rollback_requires_staging_or_test/);
  assert.match(runner, /finally \{/);
  assert.match(runner, /\["rm", "--force", container\]/);
  assert.match(rollback, /current_setting\('newme\.environment', true\)/);
  assert.match(rollback, /sam20_rollback_fixture_organizations_not_clean/);
  assert.match(rollback, /DROP COLUMN IF EXISTS organization_id/);
  assert.match(workflow, /npm run check:sam20-database/);
  assert.equal(
    JSON.parse(packageJson).scripts["check:sam20-database"],
    "node scripts/run-sam20-database-gate.mjs",
  );
});

test("SAM-20 type gate permits the exact later required role_key addition but rejects original-column drift", () => {
  const fixture = sam20TypeFixture();

  assert.doesNotThrow(() => verifyDatabaseTypes(fixture.source, fixture.contract));

  const driftedSource = fixture.source.replace(
    "      platform_staff: {\n        Row: {\n          id: string",
    "      platform_staff: {\n        Row: {\n          id: number",
  );
  assert.notEqual(driftedSource, fixture.source);
  assert.throws(
    () => verifyDatabaseTypes(driftedSource, fixture.contract),
    /database_type_mismatch:platform_staff\.Row\.id:expected=: string:actual=: number/,
  );
});

