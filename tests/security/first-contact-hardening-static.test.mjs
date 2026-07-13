import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("stage endpoint enforces ownership, complete-contact gate, concurrency, and analytics event", async () => {
  const source = await read("src/app/api/leads/[id]/stage/route.ts");
  const transition = await read("supabase/migrations/20260714000003_atomic_stage_transition.sql");
  for (const token of [
    "getAuthProfile",
    "isAdminOrBoss",
    "lead.assigned_to !== profile.userId",
    '.from("follow_up_logs")',
    '.select("contact_time, contact_result")',
    "isCompleteContact",
    "evaluateFirstContactGate",
    'p_expected_stage: lead.stage',
    '.rpc("transition_lead_stage"',
  ]) assert.ok(source.includes(token), `missing stage protection: ${token}`);
  assert.ok(transition.includes("INSERT INTO public.business_events"));
  assert.ok(transition.includes("'stage_change'"));
});

test("quality endpoint accepts assessment only after the first complete contact", async () => {
  const source = await read("src/app/api/leads/[id]/quality/route.ts");
  for (const token of [
    "getAuthProfile",
    '.select(\'contact_time, contact_result\')',
    "isCompleteContact",
    ".some(isCompleteContact)",
  ]) assert.ok(source.includes(token), `missing quality protection: ${token}`);
});

test("contact creation and editing are server-authorized and return stored rows", async () => {
  const create = await read("src/app/api/leads/[id]/contacts/route.ts");
  const edit = await read("src/app/api/leads/[id]/contacts/[contactId]/route.ts");
  for (const [source, label] of [[create, "create"], [edit, "edit"]]) {
    for (const token of [
      "getAuthProfile",
      "isAdminOrBoss",
      "supabaseAdmin",
      "lead.assigned_to !== profile.userId",
      ".select(",
      ".single()",
    ]) assert.ok(source.includes(token), `missing contact ${label} protection: ${token}`);
  }
  assert.ok(create.includes('method: "POST"') === false, "route must not self-fetch");
  assert.ok(create.includes('.upsert({'));
  assert.ok(edit.includes('.eq("id", contactId)'));
  assert.ok(edit.includes('.eq("lead_id", leadId)'));
});

test("database triggers are the authoritative First Contact backstops", async () => {
  const gate = await read("supabase/migrations/20260711000000_fix_first_contact_gate_business_rule.sql");
  const milestone = await read("supabase/migrations/20260714000000_enforce_first_contact_milestone_gate.sql");
  for (const token of [
    "BEFORE UPDATE OF stage",
    "OLD.stage IS DISTINCT FROM 'new'",
    "complete_contact_count < 1",
    "contact_time IS NOT NULL",
    "contact_result IS NOT NULL",
    "btrim(contact_result) <> ''",
    "quality NOT IN ('good', 'normal', 'poor')",
  ]) assert.ok(gate.includes(token), `missing database gate: ${token}`);
  for (const token of [
    "complete_first_contact_if_ready",
    "btrim(NEW.contact_result) = ''",
    "ON CONFLICT (lead_id, milestone_key) DO UPDATE",
    "BEFORE DELETE ON public.lead_milestones",
    "'first_contact'",
  ]) assert.ok(milestone.includes(token), `missing milestone protection: ${token}`);
});

test("UI uses the server contact write and refreshes edit/readback state", async () => {
  const mutations = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  const timeline = await read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");
  const data = await read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  assert.ok(mutations.includes('"/api/leads/" + leadId + "/contacts"'));
  assert.ok(mutations.includes("await fetchData()"));
  assert.match(process, /log\.contact_time\s*!=\s*null\s*&&\s*!!log\.contact_result\?\.trim\(\)/);
  assert.ok(data.includes("contact_result"));
  assert.ok(timeline.includes("Edit Contact Record"));
  assert.ok(timeline.includes('method: "PATCH"'));
  assert.ok(timeline.includes("await onContactUpdated()"));
});
