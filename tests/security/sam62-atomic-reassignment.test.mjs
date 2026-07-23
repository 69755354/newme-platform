import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../supabase/migrations/20260723140000_atomic_lead_reassignment.sql", import.meta.url);
const dashboardMutation = new URL("../../src/app/(dashboard)/leads/_hooks/useLeadMutations.ts", import.meta.url);
const detailMutation = new URL("../../src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts", import.meta.url);
const route = new URL("../../src/app/api/leads/[id]/assignment/route.ts", import.meta.url);
const noteRoute = new URL("../../src/app/api/leads/[id]/notes/route.ts", import.meta.url);
const deleteRoute = new URL("../../src/app/api/leads/[id]/delete/route.ts", import.meta.url);

test("SAM-62 reassignment has one atomic, idempotent server boundary", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /UNIQUE \(actor_id, operation, idempotency_key\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /CONCURRENT_LEAD_UPDATE/);
  assert.match(sql, /FORBIDDEN_REASSIGNMENT/);
  assert.match(sql, /coalesce\(v_actor_role, ''\) NOT IN/);
  assert.match(sql, /coalesce\(v_target_role, ''\) NOT IN/);
  for (const table of ["transfer_history", "activities", "business_events", "notifications"]) {
    assert.match(sql, new RegExp(`INSERT INTO public\\.${table}`));
  }
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.reassign_lead_atomic[\s\S]*FROM PUBLIC, anon/);
});

test("SAM-62 removes dashboard and detail reassignment direct writes", async () => {
  const [dashboard, detail, api] = await Promise.all([
    readFile(dashboardMutation, "utf8"),
    readFile(detailMutation, "utf8"),
    readFile(route, "utf8"),
  ]);
  for (const source of [dashboard, detail]) {
    assert.match(source, /\/api\/leads\/\$\{leadId\}\/assignment/);
    assert.match(source, /idempotencyKey: crypto\.randomUUID\(\)/);
  }
  assert.match(api, /reassign_lead_atomic/);
  assert.match(api, /CONCURRENT/);
});

test("SAM-62 has no dashboard shortcut around the controlled stage transition", async () => {
  const dashboard = await readFile(dashboardMutation, "utf8");
  assert.doesNotMatch(dashboard, /const changeStage\s*=/);
  assert.doesNotMatch(dashboard, /\.from\("leads"\)\.update/);
  assert.doesNotMatch(dashboard, /\.from\("activities"\)\.insert/);
  assert.doesNotMatch(dashboard, /from\("quotations"\)/);
});

test("SAM-62 records a note and its contact timestamp in one idempotent mutation", async () => {
  const [sql, detail, api] = await Promise.all([
    readFile(migration, "utf8"),
    readFile(detailMutation, "utf8"),
    readFile(noteRoute, "utf8"),
  ]);
  assert.match(sql, /FUNCTION public\.record_lead_note_atomic/);
  assert.match(sql, /INSERT INTO public\.follow_up_logs/);
  assert.match(sql, /RETURNING id INTO v_note_id/);
  assert.match(sql, /UPDATE public\.leads SET last_contact_date/);
  assert.match(sql, /operation = 'lead_note'/);
  assert.match(detail, /\/api\/leads\/\$\{leadId\}\/notes/);
  assert.match(api, /record_lead_note_atomic/);
});

test("SAM-62 records structured contact and the lead contact fact atomically", async () => {
  const [sql, api] = await Promise.all([readFile(migration, "utf8"), readFile(new URL("../../src/app/api/leads/[id]/contacts/route.ts", import.meta.url), "utf8")]);
  assert.match(sql, /FUNCTION public\.record_lead_contact_atomic/);
  assert.match(sql, /ON CONFLICT \(contact_fingerprint\)/);
  assert.match(sql, /last_contact_date = greatest/);
  assert.match(sql, /operation = 'lead_contact'/);
  assert.match(api, /record_lead_contact_atomic/);
  assert.doesNotMatch(api, /supabaseAdmin/);
});

test("SAM-62 deletes a Lead through an audited, idempotent server boundary", async () => {
  const [sql, dashboard, api] = await Promise.all([
    readFile(migration, "utf8"), readFile(dashboardMutation, "utf8"), readFile(deleteRoute, "utf8"),
  ]);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.lead_deletion_requests/);
  assert.match(sql, /FUNCTION public\.delete_lead_atomic/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /LEAD_DELETE_BLOCKED/);
  assert.match(sql, /INSERT INTO public\.audit_logs/);
  assert.match(dashboard, /\/api\/leads\/\$\{leadId\}\/delete/);
  assert.doesNotMatch(dashboard, /\.from\("leads"\)\.delete/);
  assert.match(api, /delete_lead_atomic/);
});

test("SAM-62 puts stage gates and replay protection in the database transaction", async () => {
  const [sql, detail, api] = await Promise.all([
    readFile(migration, "utf8"), readFile(detailMutation, "utf8"),
    readFile(new URL("../../src/app/api/leads/[id]/stage/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.transition_lead_stage\(uuid, text, text, text\)/);
  assert.match(sql, /FUNCTION public\.transition_lead_stage\([\s\S]*p_idempotency_key uuid/);
  assert.match(sql, /operation = 'stage_transition'/);
  assert.match(sql, /FROM public\.follow_up_logs/);
  assert.match(sql, /First Contact requirements are incomplete/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(detail, /idempotencyKey: crypto\.randomUUID\(\)/);
  assert.match(api, /p_idempotency_key: idempotencyKey/);
});
