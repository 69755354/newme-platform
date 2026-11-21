// Sheet -> OS sync carries the Meta ids of matched leads (fills EMPTY OS columns only) and queues the quote event once after linking.
// Fixtures only: synthetic ids and phones, no network, no database, no Drive access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync as rf } from "node:fs";
import { runSync } from "../../scripts/drive-to-os-sync.mjs";
import { SOURCES, buildChanges, toTab } from "../../scripts/lib/drive-sync-sources.mjs";
import { buildIndexes, cleanMetaId, decideChange, planBatch, planMetaIds, resolveConfig, validateChange, fingerprintOf } from "../../src/lib/drive-sync.mjs";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const cfg = resolveConfig({ DRIVE_SYNC_INGEST_ENABLED: "true" }); cfg.nowMs = NOW;
const LG = "123456789012345"; const LG2 = "223456789012345";
const lead = (o) => ({ id: "L1", import_fingerprint: null, meta_leadgen_id: null, campaign_id: null, adset_id: null, ad_id: null, phone: "+971501234567", email: null, archived: false, stage: "contacted", final_status: null, quality: "normal", next_action: null, poor_reason: null, quotation_value: null, updated_at: "2026-11-01T00:00:00.000Z", drive_sync: null, ...o });
const idsRow = (o = {}) => ({ key: "META-" + LG, sheet: "marketing_home_owners", row: 3, identity: { leadgen: LG, phone_digits: "971501234567" }, owned: {}, meta_ids: { meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333" }, ids_only: true, ...o });
const baselined = (extra = {}) => ({ row_hash: "x", quote_baseline: true, quote_state: "baseline_skipped", quote_value: 5000, ...extra });
const decide = (change, leads, c = cfg) => decideChange(change, buildIndexes(leads), c, new Map());

test("cleanMetaId accepts only plain numeric ids (prefixes stripped)", () => {
  assert.equal(cleanMetaId("meta_leadgen_id", `l:${LG}`), LG); assert.equal(cleanMetaId("ad_id", "ag:333333"), "333333"); assert.equal(cleanMetaId("campaign_id", "c:111111"), "111111");
  for (const bad of ["", "abc", "0123456789012", "12", "Cil D 2", "1e12345678"]) assert.equal(cleanMetaId("meta_leadgen_id", bad), null);
});

test("empty OS ids are filled from a sheet row matched by phone; nothing else is written", () => {
  const d = decide(idsRow(), [lead({})]);
  assert.equal(d.action, "update"); assert.deepEqual(d.set, { meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333" });
  assert.deepEqual(d.ids_gained.sort(), ["ad_id", "adset_id", "campaign_id", "meta_leadgen_id"]); assert.equal(d.matched_by, "phone");
  assert.ok(d.raw_patch.drive_sync.ids_filled.includes("meta_leadgen_id"));
});

test("a non-empty OS value is never overwritten; a different leadgen id is a reported conflict", () => {
  const d = decide(idsRow(), [lead({ meta_leadgen_id: LG2, campaign_id: "999999" })]);
  assert.equal(d.action, "update"); assert.deepEqual(d.set, { adset_id: "222222", ad_id: "333333" });
  assert.deepEqual(d.conflicts.map((c) => c.field).sort(), ["campaign_id", "meta_leadgen_id"]);
  // nothing to fill, only conflicts: a no-op that still reports them
  const n = decide(idsRow({ meta_ids: { meta_leadgen_id: LG } }), [lead({ meta_leadgen_id: LG2 })]);
  assert.equal(n.action, "noop"); assert.equal(n.conflicts[0].field, "meta_leadgen_id"); assert.equal(writeCostOf(n), 0);
});
const writeCostOf = (d) => (d.set && Object.keys(d.set).length ? 1 : 0);

test("a leadgen id held by another lead, or claimed by another row of the run, is not copied", () => {
  const holder = lead({ id: "L9", phone: "+971509999999", meta_leadgen_id: LG });
  const d = decide(idsRow({ identity: { phone_digits: "971501234567" }, meta_ids: { meta_leadgen_id: LG, ad_id: "333333" } }), [lead({}), holder]);
  assert.equal(d.action, "update"); assert.equal(d.set.meta_leadgen_id, undefined); assert.equal(d.set.ad_id, "333333");
  assert.equal(d.conflicts[0].reason, "held_by_other_lead");
  const leads = [lead({}), lead({ id: "L2", phone: "+971502222222" })];
  const plan = planBatch([idsRow({ key: "A", identity: { phone_digits: "971501234567" } }), idsRow({ key: "B", identity: { phone_digits: "971502222222" } })], leads, cfg);
  assert.equal(plan.counts.ids_leadgen, 1); assert.equal(plan.counts.id_conflicts, 1);
});

test("an ids-only market row never takes the lead's claim, and skips quietly when nothing is missing", () => {
  const leads = [lead({})]; const idx = buildIndexes(leads); const claimed = new Map();
  assert.equal(decideChange(idsRow(), idx, cfg, claimed).action, "update");
  assert.equal(claimed.has("L1"), false);
  const reg = { key: "LEGACY-x", sheet: "lead_register", row: 6, identity: { phone_digits: "971501234567" }, owned: { next_action: "Call" }, insertable: true };
  assert.equal(decideChange(reg, idx, cfg, claimed).action, "update"); // the register row still writes the same lead in the same run
  assert.deepEqual(decide(idsRow(), [lead({ meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333" })]), { action: "skip", reason: "marketing_no_drive_owned_content" });
  assert.equal(decide(idsRow(), []).action, "skip");
  assert.equal(decide(idsRow(), [lead({ archived: true })]).action, "skip");
});

test("a lead gaining its leadgen id with a dated quote inside 7 days queues the quote event once, at the quote time", () => {
  const quoteAt = "2026-11-19T08:00:00.000Z";
  const row = idsRow({ quote_value: "5,000", quote_at: quoteAt, ids_only: false, owned: { next_action: "x" } });
  const d = decide(row, [lead({ quotation_value: 5000, drive_sync: baselined() })]);
  assert.equal(d.quote_late.eventTime, Math.floor(Date.parse(quoteAt) / 1000)); assert.equal(d.quote_late.value, 5000); assert.equal(d.quote_meta_state, "sent_after_link");
  assert.equal(d.raw_patch.drive_sync.quote_meta, "sent_after_link");
  // second run: leadgen is there now (nothing to gain) and the state is stored -> no second event
  const again = decide(row, [lead({ quotation_value: 5000, meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333", drive_sync: { ...baselined(), ...d.raw_patch.drive_sync, row_hash: "x" } })]);
  assert.ok(!again.quote_late);
  // even if the leadgen were gained again (wiped), the stored state blocks a second send
  const blocked = decide(row, [lead({ quotation_value: 5000, drive_sync: baselined({ quote_meta: "sent_after_link" }) })]);
  assert.ok(!blocked.quote_late);
});

test("a quote older than 7 days, or undated, is recorded as not sendable and never queued", () => {
  const old = decide(idsRow({ quote_value: "5000", quote_at: "2026-11-10T08:00:00.000Z", ids_only: false }), [lead({ drive_sync: baselined() })]);
  assert.ok(!old.quote_late); assert.equal(old.quote_meta_state, "not_sendable_stale"); assert.equal(old.raw_patch.drive_sync.quote_meta, "not_sendable_stale");
  const undated = decide(idsRow({ ids_only: false }), [lead({ quotation_value: 8000, drive_sync: baselined() })]);
  assert.ok(!undated.quote_late); assert.equal(undated.quote_meta_state, "not_sendable_no_quote_date");
  const future = decide(idsRow({ quote_value: "5000", quote_at: "2026-11-30T08:00:00.000Z", ids_only: false }), [lead({ drive_sync: baselined() })]);
  assert.equal(future.quote_meta_state, "not_sendable_future_date");
  const noQuote = decide(idsRow({ ids_only: false }), [lead({})]);
  assert.ok(!noQuote.quote_late && !noQuote.quote_meta_state);
  const won = decide(idsRow({ quote_value: "5000", quote_at: "2026-11-20T08:00:00.000Z", ids_only: false }), [lead({ final_status: "won" })]);
  assert.ok(!won.quote_late);
});

test("a quote queued while the lead had no leadgen id is sent after linking when its stored time is still inside 7 days", () => {
  const d = decide(idsRow({ ids_only: false }), [lead({ quotation_value: 5000, drive_sync: baselined({ quote_state: "queued", quote_at: "2026-11-20T10:00:00.000Z" }) })]);
  assert.equal(d.quote_late.eventTime, Math.floor(Date.parse("2026-11-20T10:00:00.000Z") / 1000));
  const stale = decide(idsRow({ ids_only: false }), [lead({ quotation_value: 5000, drive_sync: baselined({ quote_state: "queued", quote_at: "2026-11-01T10:00:00.000Z" }) })]);
  assert.equal(stale.quote_meta_state, "not_sendable_stale");
});

test("a quote that the ordinary path sends in the same decision is not sent twice", () => {
  const row = idsRow({ ids_only: false, opp_stage: "Quotation reported", quote_value: "5000", quote_at: "2026-11-20T08:00:00.000Z" });
  const d = decide(row, [lead({ drive_sync: { row_hash: "old", quote_baseline: true } })]);
  assert.ok(d.quote); assert.ok(!d.quote_late); assert.equal(d.quote_meta_state, "sent_with_quote");
});

test("an unchanged row whose lead lacks the ids is not a no-op; once filled it is", () => {
  const row = { key: "META-" + LG, sheet: "lead_register", row: 6, identity: { fingerprint: fingerprintOf("META-" + LG), leadgen: LG }, owned: {}, meta_ids: { meta_leadgen_id: LG }, insertable: true };
  const l = lead({ import_fingerprint: fingerprintOf("META-" + LG) });
  const first = decide(row, [{ ...l, drive_sync: { ...baselined(), row_hash: decide(row, [l]).row_hash } }]);
  assert.equal(first.action, "update"); assert.equal(first.matched_by, "fingerprint"); assert.deepEqual(first.set, { meta_leadgen_id: LG });
  const filled = decide(row, [{ ...l, meta_leadgen_id: LG, drive_sync: { ...baselined(), row_hash: first.row_hash } }]);
  assert.equal(filled.action, "noop");
});

test("the Meta id fields never reach a lead the planner holds back (archived leads stay frozen)", () => {
  const d = decide({ ...idsRow(), ids_only: false, owned: { next_action: "x" } }, [lead({ archived: true })]);
  assert.equal(d.action, "hold"); assert.equal(d.reason, "archived_frozen");
});

test("validateChange checks meta_ids and quote_at", () => {
  assert.equal(validateChange({ key: "k", sheet: "s", row: 1, meta_ids: { ad_id: "1" }, quote_at: "2026-11-20T08:00:00.000Z" }), null);
  assert.equal(validateChange({ key: "k", sheet: "s", row: 1, meta_ids: [] }), "bad_meta_ids");
  assert.equal(validateChange({ key: "k", sheet: "s", row: 1, meta_ids: { ad_id: 5 } }), "bad_meta_ids");
  assert.equal(validateChange({ key: "k", sheet: "s", row: 1, quote_at: "soon" }), "bad_quote_at");
});

// ---- sheet side: which rows carry ids -------------------------------------------------------------------------------
const REG_HEAD = ["Client", "Primary phone", "Intake channel", "Dispatch status", "Lead quality", "Next action", "Opportunity stage", "Quote value AED", "Quote date", "Master Lead ID", "Source lead ID", "Campaign ID", "Adset ID", "Ad ID"];
const reg = (o) => REG_HEAD.map((h) => o[h] ?? "");
function tabsOf({ register = [], home = [], form = [] }) {
  const t = {};
  const put = (key, values) => { const src = SOURCES.find((s) => s.key === key); t[key] = toTab(src, values); };
  put("lead_register", [REG_HEAD, ...register.map(reg)]);
  put("marketing_home_owners", [["id", "phone", "ad_id", "adset_id", "campaign_id", "full_name"], ...home]);
  put("marketing_new_form_leads", [["id", "phone_number"], ...form]);
  return t;
}

test("sheet rows: META master id / l: source id and c:/as:/ag: ids become meta_ids; legacy doc references do not", () => {
  const tabs = tabsOf({ register: [
    { "Master Lead ID": `META-${LG}`, "Primary phone": "0501234567", "Dispatch status": "Delivered", "Campaign ID": "c:111111", "Adset ID": "as:222222", "Ad ID": "ag:333333", "Source lead ID": `l:${LG}` },
    { "Master Lead ID": "WA-abc", "Primary phone": "0502345678", "Dispatch status": "Delivered", "Source lead ID": `l:${LG2}`, "Opportunity stage": "Quotation reported", "Quote value AED": "1,000", "Quote date": "2026-11-19" },
    { "Master Lead ID": "LEGACY-9", "Primary phone": "0503456789", "Dispatch status": "Delivered", "Source lead ID": "Client DB 12-05-2026.xlsx | r 7", "Opportunity stage": "Quotation reported", "Quote value AED": "245,527.00" },
  ] });
  const ch = Object.fromEntries(buildChanges(tabs, {}).map((c) => [c.key, c]));
  assert.deepEqual(ch[`META-${LG}`].meta_ids, { meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333" });
  assert.deepEqual(ch["WA-abc"].meta_ids, { meta_leadgen_id: LG2 }); assert.equal(ch["WA-abc"].quote_at, "2026-11-18T20:00:00.000Z");
  assert.equal(ch["LEGACY-9"].meta_ids, undefined); assert.equal(ch["LEGACY-9"].quote_at, undefined);
});

test("market form rows with ids but no Drive text become ids-only changes (matched by phone), rows without ids stay skipped", () => {
  const tabs = tabsOf({ home: [[`l:${LG}`, "0501234567", "ag:333333", "as:222222", "c:111111", "X"], ["", "0507654321", "", "", "", "Y"]] });
  const m = buildChanges(tabs, {}).filter((c) => c.sheet === "marketing_home_owners");
  const withId = m.find((c) => c.key === `META-${LG}`);
  assert.equal(withId.ids_only, true); assert.equal(withId.skip_reason, undefined); assert.deepEqual(withId.meta_ids, { meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333" });
  assert.equal(m.find((c) => c.key !== `META-${LG}`).skip_reason, "marketing_no_drive_owned_content");
});

test("end to end dry run: the report says how many leads would gain ids; apply fills them once and a rerun is quiet", async () => {
  const tabs = tabsOf({ register: [{ "Master Lead ID": "LEGACY-9", "Primary phone": "0503456789", "Dispatch status": "Delivered" }], home: [[`l:${LG}`, "0503456789", "ag:333333", "as:222222", "c:111111", "X"]] });
  const values = { "Lead Register": [["junk"], ["junk"], ["junk"], ["junk"], REG_HEAD, ...[{ "Master Lead ID": "LEGACY-9", "Primary phone": "0503456789", "Dispatch status": "Delivered" }].map(reg)], "Home-owners": [["id", "phone", "ad_id", "adset_id", "campaign_id", "full_name"], [`l:${LG}`, "0503456789", "ag:333333", "as:222222", "c:111111", "X"]] };
  const reader = { async getValues(_id, range) { const tab = /^'(.+)'!/.exec(range)[1]; return values[tab] ?? [["id", "phone_number"], ["Client", "Lead key", "Lead quality", "Next action", "Day 1 feedback"]].slice(0, 1); }, async getModifiedTime() { return "2026-11-20T10:00:00.000Z"; } };
  assert.ok(tabs.lead_register.rows.length === 1);
  const leads = [lead({ id: "L5", phone: "+971503456789" })];
  const snap = path.join(mkdtempSync(path.join(tmpdir(), "link-ids-")), "os.json"); writeFileSync(snap, JSON.stringify(leads));
  const dir = mkdtempSync(path.join(tmpdir(), "link-ids-run-"));
  const r = await runSync({ argv: ["--run-now", "--data-dir", dir, "--os-snapshot", snap, "--only", "lead_register,marketing_home_owners"], env: { DRIVE_SYNC_INGEST_TOKEN: "t".repeat(40) }, deps: { reader } });
  assert.match(r.report, /would gain Meta lead id\s+1/); assert.match(r.report, /would gain campaign\/adset\/ad\s+1/);
  assert.ok(!/0503456789|971503456789/.test(r.report));
});

test("the ingest route reads the id columns, queues the late quote before any write, and widens the side-effect allowance by that one row", () => {
  const route = rf(new URL("../../src/app/api/sync/drive-ingest/route.ts", import.meta.url), "utf8");
  assert.match(route, /LEAD_COLUMNS = "[^"]*campaign_id, adset_id, ad_id/);
  assert.match(route, /enqueueMetaCrmStageEvent\(supabaseAdmin, \{ id: d\.lead_id, meta_leadgen_id: d\.set\.meta_leadgen_id \}, "quotation_submitted", d\.quote_late\.eventTime\)/);
  assert.ok(route.indexOf("d.quote_late") < route.indexOf('const patch: Json = { ...d.set }'), "the late quote is queued before the lead patch");
  assert.match(route, /late_quote_enqueue_failed/); assert.match(route, /lateQuotes/);
  assert.ok(!/migration/i.test(readFileSync(new URL("../../src/lib/drive-sync.mjs", import.meta.url), "utf8").split("\n").filter((l) => /rpc\(|create table|alter table/i.test(l)).join("")));
});

test("two rows with different Meta ids matching the same lead: only the first fills each empty column, the second reports conflicts", () => {
  const leads = [lead({})]; const idx = buildIndexes(leads); const claimed = new Map();
  const a = decideChange(idsRow({ key: "A" }), idx, cfg, claimed);
  const b = decideChange(idsRow({ key: "B", identity: { leadgen: LG2, phone_digits: "971501234567" }, meta_ids: { meta_leadgen_id: LG2, campaign_id: "444444", adset_id: "555555", ad_id: "666666" } }), idx, cfg, claimed);
  assert.deepEqual(a.set, { meta_leadgen_id: LG, campaign_id: "111111", adset_id: "222222", ad_id: "333333" });
  assert.equal(b.action, "noop"); assert.equal(b.set, undefined);
  assert.deepEqual(b.conflicts.map((c) => c.reason), ["filled_by_other_row", "filled_by_other_row", "filled_by_other_row", "filled_by_other_row"]);
  // the reservation survives into the next batch of the same run through the carried claims
  const plan = planBatch([idsRow({ key: "C", identity: { leadgen: LG2, phone_digits: "971501234567" }, meta_ids: { ad_id: "666666" } })], leads, cfg, Object.fromEntries(claimed));
  assert.equal(plan.decisions[0].d.set?.ad_id, undefined);
});

test("a row whose only change is the newly hashed sheet owner records the owner with one write (no field re-apply, no sync note)", async () => {
  const { rowHashOf, writeCost } = await import("../../src/lib/drive-sync.mjs");
  const reg = { key: "LEGACY-o", sheet: "lead_register", row: 9, identity: { phone_digits: "971501234567" }, owned: { next_action: "Call back" }, insertable: true, sheet_owner: "Faizan" };
  const oldHash = rowHashOf({ ...reg, sheet_owner: undefined });
  // OS was edited after the last sync (next_action differs): the old-hash row must not re-apply the sheet value.
  const d = decide(reg, [lead({ next_action: "Edited in OS", drive_sync: baselined({ row_hash: oldHash }) })]);
  assert.equal(d.action, "rehash"); assert.equal(d.reason, "sheet_owner_recorded"); assert.equal(d.set, undefined); assert.equal(d.notes, undefined);
  assert.equal(d.raw_patch.drive_sync.row_hash, rowHashOf(reg)); assert.equal(d.raw_patch.drive_sync.sheet_owner, "Faizan"); assert.equal(writeCost(d), 1);
  // the OS edit is recorded as OS-won, so a later unrelated sheet edit (new follow-up text) still does not overwrite it
  assert.ok(d.raw_patch.drive_sync.os_won.next_action);
  const after = baselined({ row_hash: rowHashOf(reg), sheet_owner: "Faizan", os_won: d.raw_patch.drive_sync.os_won, synced_at: "2026-11-21T12:00:00.000Z" });
  const later = decide({ ...reg, followup_text: "Day 2: no answer" }, [lead({ next_action: "Edited in OS", updated_at: "2026-11-21T12:00:00.000Z", drive_sync: after })]);
  assert.equal(later.action, "update"); assert.equal(later.set?.next_action, undefined);
  // once recorded, the same row is a plain no-op
  assert.equal(decide(reg, [lead({ drive_sync: baselined({ row_hash: rowHashOf(reg), sheet_owner: "Faizan" }) })]).action, "noop");
  // a real sheet change alongside the owner is still a normal update
  const changed = decide({ ...reg, owned: { next_action: "Visit" } }, [lead({ drive_sync: baselined({ row_hash: oldHash }) })]);
  assert.equal(changed.action, "update");
  const plan = planBatch([reg], [lead({ drive_sync: baselined({ row_hash: oldHash }) })], cfg);
  assert.equal(plan.counts.rehashed, 1); assert.equal(plan.counts.updated, 0); assert.equal(plan.counts.writes, 1);
});
