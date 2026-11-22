import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { normalizePhone } from "../../src/lib/lead-contact.mjs";

// OS fix S31: the behaviour is proved by tests/database/s31-corrective.sql (CI, PostgreSQL). These checks pin the
// shape of the corrective migration and the one numeric assumption it relies on.
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const FILE = "supabase/migrations/20261120100000_dispatch_and_history_corrections.sql";
const sql = read(FILE);
const body = (name) => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const open = sql.indexOf("$fn$", start);
  return sql.slice(open, sql.indexOf("$fn$;", open + 4));
};

test("the migration is additive: only CREATE OR REPLACE of routines, grants and comments", () => {
  assert.match(sql.split("\n", 1)[0], /^-- NO_ROLLBACK: \S/);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete\s+from|alter\s+table|create\s+table|create\s+(unique\s+)?index)\b/i);
  // the only data writes outside the routines are the two derived-column repairs
  const outside = sql.replace(/\$fn\$[\s\S]*?\$fn\$;/g, "");
  assert.equal((outside.match(/^update public\./gm) ?? []).length, 2);
  assert.doesNotMatch(outside, /^insert into/im);
  const created = [...sql.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);
  assert.deepEqual(created, ["evaluate_lead_dispatch", "dispatch_reevaluate_dependents", "dispatch_decide", "sweep_lead_dispatch", "record_whatsapp_ad_event"]);
  for (const name of created) {
    const b = body(name);
    assert.match(b, /S31 corrective v1/, `${name} carries the posture marker`);
    assert.match(b, /assert_current_session_at_entry\(\)/, `${name} keeps the session check`);
  }
  assert.equal((sql.match(/security definer\nset search_path = pg_catalog, public, pg_temp/g) ?? []).length, 5);
  for (const sig of ["evaluate_lead_dispatch(uuid, uuid)", "dispatch_reevaluate_dependents(uuid, uuid)", "dispatch_decide(uuid, uuid, text, text)",
    "sweep_lead_dispatch(timestamptz, integer)", "record_whatsapp_ad_event(jsonb, boolean)"]) {
    assert.ok(sql.includes(`grant execute on function public.${sig} to service_role;`), `${sig} granted to the service role`);
    assert.match(sql, new RegExp(`revoke all on function public\\.${sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} from public, anon, authenticated`));
  }
});

test("(a) the phone confirmation predicate cannot become null", () => {
  const b = body("evaluate_lead_dispatch");
  assert.match(b, /not coalesce\(v_have and v_norm is not null and st\.phone_confirmed_norm is not null and st\.phone_confirmed_norm = v_norm, false\)/);
  assert.doesNotMatch(b, /not \(v_have and v_norm is not null and st\.phone_confirmed_norm = v_norm\)/);
});

test("(b) duplicate phone matching uses the canonical form only", () => {
  const b = body("evaluate_lead_dispatch");
  assert.doesNotMatch(b, /wa_phone_key/);
  assert.match(b, /public\.dispatch_phone_norm\(o\.phone\) = v_norm/);
  assert.doesNotMatch(body("dispatch_reevaluate_dependents"), /wa_phone_key/);
});

// The suffix prefilter is exact only if normalising never changes the last eight digits. The JavaScript rules
// mirror dispatch_phone_norm (tests/unit/s24-phone-parity.test.mjs), so they are used to check the invariant.
test("(b) the last eight digits of a readable number equal the last eight digits of its canonical form", () => {
  const raws = ["0501234567", "050 123 4567", "501234567", "042345678", "04 234 5678", "+971 0 4 345 6781", "00971501234567",
    "971501234567", "+971 050 123 4567", "+44 7911 123456", "0044 7911 123456", "+1 (415) 555-0100", "+971-50-123-4567",
    "+971.50.123.4567", "9710501234567", "+33 6 12 34 56 78", "0097143456781"];
  let checked = 0;
  for (const raw of raws) {
    const result = normalizePhone(raw);
    if (!result.ok) continue;
    checked++;
    assert.equal(raw.replace(/\D/g, "").slice(-8), result.e164.replace(/\D/g, "").slice(-8), `case ${JSON.stringify(raw)}`);
  }
  assert.ok(checked >= 12);
});

test("(c) a changed older candidate reaches the newer lead", () => {
  const dep = body("dispatch_reevaluate_dependents");
  assert.match(dep, /pg_try_advisory_xact_lock/, "dependents are never waited for");
  assert.doesNotMatch(dep, /perform pg_advisory_xact_lock/);
  assert.match(dep, /r\.decision = 'pending' and l\.id = any\(r\.candidate_ids\)/);
  assert.match(dep, /limit 50/);
  assert.match(body("dispatch_decide"), /v_dependents := public\.dispatch_reevaluate_dependents\(p_lead_id, p_actor\)/);
  const sweep = body("sweep_lead_dispatch");
  assert.match(sweep, /join public\.leads o on o\.id = any\(r\.candidate_ids\)/);
  assert.match(sweep, /greatest\(coalesce\(o\.updated_at, o\.created_at\), os\.updated_at\) > s\.evaluated_at/);
  assert.match(sweep, /if v_had_state then\s+v_dependents := v_dependents \+ public\.dispatch_reevaluate_dependents\(v_id, null\)/);
});

test("(d) a live delivery promotes a backfilled history row instead of returning early", () => {
  const b = body("record_whatsapp_ad_event");
  const conflict = b.indexOf("on conflict (waba_id, message_id) do nothing;");
  const promote = b.indexOf("where waba_id = v_waba and message_id = v_message and backfilled;");
  const early = b.indexOf("return jsonb_build_object('duplicate', true");
  assert.ok(conflict > 0 && promote > conflict && early > promote, "promotion is tried before the duplicate return");
  assert.match(b, /backfilled = false/);
  // the S21 corrections the S21 rule check looks for are kept
  assert.match(b, /S21 \(S18 review, item 1\)/);
  assert.match(b, /body_kind/);
  assert.match(b, /'promoted', v_promoted/);
  // timing and counts never include backfilled history rows (conversation: 2 + 5 sub-queries, lead: 2)
  assert.equal((b.match(/and not backfilled;/g) ?? []).length, 2);
  assert.equal((b.match(/and not e\.backfilled\)/g) ?? []).length, 5);
  assert.equal((b.match(/and not e\.backfilled;/g) ?? []).length, 2);
  assert.doesNotMatch(b, /where e\.conversation_id = c\.id and e\.direction = '(?:in|out)bound'\)/);
  // and the file repairs rows written before this correction, from live rows only
  const tail = sql.slice(sql.indexOf("one-time, idempotent repair"));
  assert.match(tail, /update public\.whatsapp_conversations c set/);
  assert.match(tail, /update public\.leads l set wa_first_inbound_at = n\.v_in, wa_first_reply_at = n\.v_reply/);
  assert.match(tail, /is distinct from/);
});

test("the release plumbing names the migration (last until S32 followed) and CI runs its database test", () => {
  const manifest = JSON.parse(read("infra/release/release-manifest.json"));
  // S32 (20261120200000) is the entry after S31 now; S31 keeps its place and predicate.
  const at = manifest.deferred_contract.findIndex((x) => x.file === "20261120100000_dispatch_and_history_corrections.sql");
  assert.ok(at >= 0 && at >= manifest.deferred_contract.length - 4, "S31 is among the last four deferred entries");
  const predAt = manifest.posture.deferred_contract.predicates.findIndex((x) => x.name === "s31-dispatch-and-history-corrections-present");
  assert.ok(predAt >= 0 && predAt >= manifest.posture.deferred_contract.predicates.length - 4);
  assert.equal(manifest.deferred_contract.at(-3).file, "20261120200000_tasks_future_only_not_valid.sql");
  assert.equal(manifest.posture.deferred_contract.predicates.at(-3).name, "s32-tasks-future-only-not-valid");
  assert.equal(manifest.deferred_contract.at(-2).file, "20261121100000_sync_advance_lead_stage_from_sheet.sql");
  assert.match(read(".github/workflows/ci.yml"), /tests\/database\/s31-corrective\.sql/);
  const dbTest = read("tests/database/s31-corrective.sql");
  for (const marker of ["a-second-evaluation-without-confirmation-still-reviews-phone", "b-canonical-twin-is-found",
    "c1-test-mark-withdraws-the-newer-review", "c2-archived-candidate-reaches-the-newer-lead-through-the-sweep",
    "c3-edited-older-lead-opens-the-newer-review", "d-live-delivery-promotes-instead-of-returning-early",
    "d2-conversation-timing-ignores-backfilled-rows", "d2-lead-timing-ignores-backfilled-rows", "d2-one-time-repair-recomputes-from-live-rows"]) {
    assert.ok(dbTest.includes(`'${marker}'`), `database test asserts ${marker}`);
  }
});
