import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { followupStateTone, formatSuggestedValue } from "../../src/lib/followup-display.mjs";

const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("the card colours the three states and formats suggested values", () => {
  assert.match(followupStateTone("overdue"), /red/);
  assert.match(followupStateTone("at_risk"), /amber/);
  assert.match(followupStateTone("normal"), /emerald/);
  assert.equal(formatSuggestedValue("budget_aed", 150000), "AED 150,000");
  assert.equal(formatSuggestedValue("area_sqm", 111.5), "111.5 m²");
  assert.equal(formatSuggestedValue("rooms", 2), "2");
});

test("both languages carry every key the card uses, with the same shape", () => {
  const src = read("src/lib/i18n/translations.ts");
  const blocks = [...src.matchAll(/followup: \{([\s\S]*?)\n    \},/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2);
  const keys = (block) => [...block.matchAll(/^\s+(\w+):/gm)].map((k) => k[1]).sort();
  assert.deepEqual(keys(blocks[0]), keys(blocks[1]));
  const card = read("src/app/(dashboard)/leads/[id]/LeadFollowupCard.tsx");
  const top = keys(blocks[0]);
  for (const [, key] of card.matchAll(/t\("followup\.(\w+)"\)/g)) assert.ok(top.includes(key), key);
  for (const state of ["normal", "at_risk", "overdue"]) assert.match(blocks[0], new RegExp(`${state}:`));
  for (const field of ["rooms", "property_type", "area_sqm", "budget_aed", "renovation", "next_step"]) assert.match(blocks[1], new RegExp(`${field}:`));
  assert.match(blocks[1], /跟进状态/);
});

test("the card is on the lead page, next to the S18 panel, and hides itself for non-WhatsApp leads", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.match(page, /<LeadFollowupCard lead=\{lead\} t=\{t\} \/>/);
  const card = read("src/app/(dashboard)/leads/[id]/LeadFollowupCard.tsx");
  assert.match(card, /if \(!isWhatsApp \|\| failed \|\| !data \|\| !data\.has_conversation\) return null;/);
  assert.match(card, /data-testid="followup-state"/);
});

test("the interface labels Show room, FB and ins are not touched by the new strings", () => {
  const src = read("src/lib/i18n/translations.ts");
  const blocks = [...src.matchAll(/followup: \{([\s\S]*?)\n    \},/g)].map((m) => m[1]).join("\n");
  for (const label of ["Show room", "FB", "ins"]) assert.equal(blocks.includes(label), false, label);
});

test("the follow-up API checks the role before any service-role query, never caches and never returns message text", () => {
  const src = read("src/app/api/leads/[id]/followup/route.ts");
  assert.match(src, /^\/\/ RBAC: admin, boss, operator, or the lead's own sales owner/);
  assert.ok(src.indexOf("authorize(context, leadId)") < src.indexOf("supabaseAdmin.from(\"lead_followup_state\")"));
  assert.match(src, /private, no-store/);
  assert.doesNotMatch(src, /respond\(\{[^}]*body/);
});

test("migration contract: rollback declaration, definer entry guard, pinned search_path, service-only grants", () => {
  const sql = read("supabase/migrations/20261119100000_whatsapp_followup_monitor.sql");
  assert.match(sql, /^-- NO_ROLLBACK: \S/);
  assert.equal((sql.match(/security definer\nset search_path = pg_catalog, public, pg_temp/g) ?? []).length, 2);
  assert.match(sql, /begin\n  perform public\.assert_current_session_at_entry\(\);\n  declare/);
  assert.match(sql, /revoke all on function public\.upsert_lead_followup_state\([^)]*\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.upsert_lead_followup_state\([^)]*\) to service_role;/);
  assert.match(sql, /revoke all on table public\.lead_followup_state from public, anon, authenticated, service_role;/);
  assert.match(sql, /alter table public\.lead_followup_state enable row level security;/);
  assert.doesNotMatch(sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n"), /\bdrop table\b|\bdelete from\b|\btruncate\b/i);
});

test("the cron route, its timer and the schedule table agree", () => {
  const schedule = JSON.parse(read("infra/cron/schedule.json"));
  const entry = schedule.endpoints.find((e) => e.name === "check-whatsapp-followups");
  assert.equal(entry.install, "after-flag");
  assert.equal(entry.idempotent, true);
  assert.match(read("src/app/api/cron/check-whatsapp-followups/route.ts"), /WHATSAPP_FOLLOWUP_MONITOR_ENABLED/);
});
