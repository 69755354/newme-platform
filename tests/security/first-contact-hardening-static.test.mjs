import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(\`../../\${path}\`, import.meta.url), "utf8");

test("stage endpoint enforces ownership, complete-contact gate, concurrency, and analytics event", async () => {
  const source = await read("src/app/api/leads/[id]/stage/route.ts");
  for (const token of [
    "getAuthProfile",
    "isAdminOrBoss",
    "lead.assigned_to !== profile.userId",
    '.from("follow_up_logs")',
    '.not("contact_time", "is", null)',
    '.not("contact_result", "is", null)',
    "evaluateFirstContactGate",
    '.eq("stage", lead.stage)',
    '.from("business_events")',
    'event_type: "stage_change"',
  ]) assert.ok(source.includes(token), \`missing stage protection: \${token}\`);
});

test("quality endpoint rejects assessment before a complete contact", async () => {
  const source = await read("src/app/api/leads/[id]/quality/route.ts");
  assert.match(source, /\(contactCount \?\? 0\) < 1/);
  assert.ok(source.includes("getAuthProfile"));
});

test("contact edit endpoint scopes the write to both contact and lead and returns readback", async () => {
  const source = await read("src/app/api/leads/[id]/contacts/[contactId]/route.ts");
  for (const token of [
    "getAuthProfile",
    "isAdminOrBoss",
    "supabaseAdmin",
    '.eq("id", contactId)',
    '.eq("lead_id", leadId)',
    ".select(",
    ".single()",
  ]) assert.ok(source.includes(token), \`missing contact edit protection: \${token}\`);
});

test("database trigger is the authoritative First Contact backstop", async () => {
  const source = await read("supabase/migrations/20260711000000_fix_first_contact_gate_business_rule.sql");
  for (const token of [
    "BEFORE UPDATE OF stage",
    "OLD.stage IS DISTINCT FROM 'new'",
    "complete_contact_count < 1",
    "contact_time IS NOT NULL",
    "contact_result IS NOT NULL",
    "btrim(contact_result) <> ''",
    "quality NOT IN ('good', 'normal', 'poor')",
  ]) assert.ok(source.includes(token), \`missing database gate: \${token}\`);
});

test("UI counts only complete contacts and exposes edit/readback wiring", async () => {
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  const timeline = await read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");
  const data = await read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  assert.match(process, /log\.contact_time\s*!=\s*null\s*&&\s*!!log\.contact_result\?\.trim\(\)/);
  assert.ok(data.includes("contact_result"));
  assert.ok(timeline.includes("Edit Contact Record"));
  assert.ok(timeline.includes('method: "PATCH"'));
  assert.ok(timeline.includes("await onContactUpdated()"));
});
