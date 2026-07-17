import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("First Contact milestone API enforces contact plus quality before insert", async () => {
  const source = await read("src/app/api/leads/[id]/milestone/route.ts");
  const gate = source.indexOf('milestoneKey === "first_contact"');
  const insert = source.indexOf('.from("lead_milestones")');

  assert.notEqual(gate, -1, "first_contact milestone must have a dedicated server gate");
  assert.match(source, /from\("follow_up_logs"\)/);
  assert.match(source, /contact_result/);
  assert.match(source, /quality/);
  assert.ok(gate < insert, "First Contact gate must run before milestone insert");
});

test("First Contact completion explains an unmet business gate", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /setFirstContactBlockReason/);
  assert.match(source, /completeContactCount < 1/);
  assert.match(source, /!isAssessedQuality\(lead\.quality\)/);
  assert.match(source, /请先添加 1 条完整联系记录/);
  assert.match(source, /请先选择线索质量，再完成初次接触/);
});

test("First Contact workspace remains available after milestone completion", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /key === "first_contact" && \(isNext \|\| completed\)/);
});

test("database rejects direct First Contact milestone bypass", async () => {
  const migration = await read("supabase/migrations/20260714000000_enforce_first_contact_milestone_gate.sql");
  assert.match(migration, /BEFORE INSERT ON public\.lead_milestones/);
  assert.match(migration, /NEW\.milestone_key = 'first_contact'/);
  assert.match(migration, /public\.follow_up_logs/);
  assert.match(migration, /quality NOT IN \('good', 'normal', 'poor'\)/);
});


test("Lead Detail renders only one First Contact workflow", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.doesNotMatch(source, /<LeadContactQualityPanel/);
});

test("milestone mutation uses the owned server route", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  assert.match(source, /fetch\("\/api\/leads\/" \+ leadId \+ "\/milestone"/);
  assert.doesNotMatch(source, /supabase\s*\.from\("lead_milestones"\)\s*\.insert/);
});

test("Timeline falls back to the required contact result when notes are empty", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");
  assert.match(source, /content: f\.summary \|\| f\.contact_result/);
});


test("database prevents deleting First Contact and synchronizes current milestone", async () => {
  const migration = await read("supabase/migrations/20260714000000_enforce_first_contact_milestone_gate.sql");
  assert.match(migration, /BEFORE DELETE ON public\.lead_milestones/);
  assert.match(migration, /OLD\.milestone_key = 'first_contact'/);
  assert.match(migration, /current_milestone = 'first_contact'/);
  assert.match(migration, /legacy_pre_enforcement/);
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(process, /historicalFirstContact/);
});


test("contact creation is idempotent across retries", async () => {
  const route = await read("src/app/api/leads/[id]/contacts/route.ts");
  const migration = await read("supabase/migrations/20260714000002_add_contact_idempotency.sql");
  assert.match(route, /createHash\("sha256"\)/);
  assert.match(route, /contact_fingerprint/);
  assert.match(route, /onConflict: "contact_fingerprint"/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS contact_fingerprint TEXT/);
  assert.match(migration, /UNIQUE.*contact_fingerprint/is);
  assert.doesNotMatch(migration, /WHERE contact_fingerprint IS NOT NULL/);
});

test("First Contact migration uses valid dollar quoting", async () => {
  const migration = await read("supabase/migrations/20260714000000_enforce_first_contact_milestone_gate.sql");
  assert.doesNotMatch(migration, /AS \$\r?\n/);
  assert.doesNotMatch(migration, /DO \$\r?\n/);
});

test("milestone POST treats an existing milestone as idempotent success", async () => {
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");
  assert.match(route, /duplicate: true/);
  assert.match(route, /existingMilestone/);
});
test("milestone POST rejects blank notes before inserting a new milestone", async () => {
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");
  const validation = route.indexOf("if (!normalizedNotes)");
  const insert = route.indexOf(".insert({");

  assert.match(route, /const normalizedNotes = String\(notes \?\? ""\)\.trim\(\);/);
  assert.notEqual(validation, -1, "blank milestone notes must be rejected");
  assert.ok(validation < insert, "note validation must run before milestone insert");
  assert.match(route, /Milestone note is required/);
  assert.match(route, /notes: normalizedNotes/);
});

test("database orders milestones by pipeline sequence when timestamps tie", async () => {
  const migration = await read("supabase/migrations/20260718000000_fix_milestone_order_same_timestamp.sql");

  assert.match(migration, /ORDER BY\s+milestone_order\(milestone_key\) DESC/);
  assert.doesNotMatch(migration, /ORDER BY completed_at DESC LIMIT 1/);
});


test("First Contact requires explicit manual confirmation after contact and quality", async () => {
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  const data = await read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  const migration = await read("supabase/migrations/20260716000001_disable_auto_first_contact_milestone.sql");

  assert.match(route, /manualConfirmation: true/);
  assert.match(route, /existingMilestone\.notes/);
  assert.match(process, /milestone\.notes\?\.trim\(\)/);
  assert.match(data, /id, milestone_key, completed_at, notes/);
  assert.match(migration, /DROP TRIGGER IF EXISTS trg_after_followup_insert/);
});
