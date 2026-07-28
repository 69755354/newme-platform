import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SAM-43 transfer policy accepts only active sales-capable roles", async () => {
  const {
    LEAD_TRANSFER_CANDIDATE_ROLES,
    getVisibleLeadOwnerIds,
    isLeadTransferCandidate,
  } = await import("../src/lib/lead-transfer-candidates.mjs");

  assert.deepEqual(LEAD_TRANSFER_CANDIDATE_ROLES, ["sales", "operator", "boss"]);
  for (const role of LEAD_TRANSFER_CANDIDATE_ROLES) {
    assert.equal(isLeadTransferCandidate({ role, is_active: true }), true);
    assert.equal(isLeadTransferCandidate({ role, is_active: false }), false);
  }
  for (const role of ["admin", "dev", "developer", "designer", null]) {
    assert.equal(isLeadTransferCandidate({ role, is_active: true }), false);
  }

  assert.deepEqual(
    getVisibleLeadOwnerIds([
      { assigned_to: "sales-visible" },
      { assigned_to: null },
      { assigned_to: "sales-visible" },
    ]),
    ["sales-visible"],
  );
});

test("SAM-43 applies the same active-role query policy everywhere", async () => {
  const { filterLeadTransferCandidateQuery } = await import(
    "../src/lib/lead-transfer-candidates.mjs"
  );
  const calls = [];
  const query = {
    in(column, values) {
      calls.push(["in", column, values]);
      return this;
    },
    eq(column, value) {
      calls.push(["eq", column, value]);
      return this;
    },
  };

  assert.equal(filterLeadTransferCandidateQuery(query), query);
  assert.deepEqual(calls, [
    ["in", "role", ["sales", "operator", "boss"]],
    ["eq", "is_active", true],
  ]);

  const route = read("src/app/api/leads/list/route.ts");
  const detail = read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  const listMutations = read("src/app/(dashboard)/leads/_hooks/useLeadMutations.ts");
  const detailMutations = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  const bulk = read("src/app/(dashboard)/leads/_components/LeadsBulkTransferBar.tsx");
  assert.match(route, /filterLeadTransferCandidateQuery\(/);
  assert.match(detail, /filterLeadTransferCandidateQuery\(/);
  assert.doesNotMatch(bulk, /salesUsers\.filter\(/);
  assert.match(listMutations, /if \(!newUser\)/);
  assert.match(detailMutations, /if \(!newUser\)/);
});

test("SAM-43 returns historical owner names only for visible Leads", () => {
  const route = read("src/app/api/leads/list/route.ts");
  const hook = read("src/app/(dashboard)/leads/_hooks/useLeadsData.ts");
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");

  assert.match(route, /const ownerIds = getVisibleLeadOwnerIds\(leads \|\| \[\]\)/);
  assert.match(route, /\.select\("id,full_name"\)\s*\.in\("id", ownerIds\)/);
  assert.doesNotMatch(route, /ownerProfilesPromise/);
  assert.match(route, /ownerProfiles:/);
  assert.match(hook, /setOwnerProfiles/);
  assert.match(hook, /ownerProfiles\.forEach/);
  assert.match(card, /userNameMap\[lead\.assigned_to\]/);
});

test("SAM-43 localizes one prompt and treats pending quality as incomplete", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");
  const translations = read("src/lib/i18n/translations.ts");

  assert.match(card, /lead\.quality === "pending"/);
  assert.equal((card.match(/data-testid="lead-card-action-prompt"/g) || []).length, 1);
  for (const key of [
    "actionOverdue",
    "actionFirstContact",
    "actionQuality",
    "actionPhone",
    "actionProjectType",
    "actionProjectStatus",
    "actionLocation",
    "actionQuotationValue",
    "actionNextAction",
    "actionFollowupDate",
    "actionNext",
    "actionMissingMore",
    "actionOpenDetail",
  ]) {
    assert.equal(
      (translations.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} must exist in both English and Chinese`,
    );
    assert.match(card, new RegExp(`leads\\.${key}`));
  }
  assert.doesNotMatch(card, /跟进已逾期|待记录首次联系|待评估线索质量|待完善|待填写下一步行动|待安排跟进日期|下一步：/);
});

test("SAM-43 makes project_status reproducible from repository migrations", () => {
  const migration = read("supabase/migrations/20260719020000_add_leads_project_status.sql");

  assert.match(
    migration,
    /ALTER TABLE public\.leads\s+ADD COLUMN IF NOT EXISTS project_status TEXT;/i,
  );
  assert.match(migration, /BEFORE UPDATE OF assigned_to ON public\.leads/i);
  assert.match(migration, /is_active = TRUE/i);
  assert.match(migration, /role IN \('sales', 'operator', 'boss'\)/i);
  assert.match(migration, /NEW\.assigned_to IS DISTINCT FROM OLD\.assigned_to/i);
  assert.match(migration, /^BEGIN;/m);
  assert.match(migration, /COMMIT;\s*$/m);
  assert.match(migration, /CREATE OR REPLACE FUNCTION/i);
  assert.match(migration, /DROP TRIGGER IF EXISTS/i);
  assert.match(migration, /SET search_path = pg_catalog, public, pg_temp/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.enforce_active_lead_transfer_candidate\(\) FROM PUBLIC/i);
});
