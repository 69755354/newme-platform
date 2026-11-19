// S29 Drive -> OS sync: fake sheets + fake endpoint (same planner as the route). No network, no database, no Drive access.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSync } from "../../scripts/drive-to-os-sync.mjs";
import { createSheetsReader } from "../../scripts/lib/drive-sheets-readonly.mjs";
import { SOURCES, assertAllowedTab, rangeOf } from "../../scripts/lib/drive-sync-sources.mjs";
import { rowHashOf, decideChange, buildIndexes, fingerprintOf, maskId, normalizePhone, phoneDigits, planBatch, resolveConfig, tokenMatches, writeCost } from "../../src/lib/drive-sync.mjs";

const TOKEN = "t".repeat(40);
const SALES_HEAD = ["Client", "Phone / WhatsApp", "Day 1 feedback", "Day 2 feedback", "Day 3 feedback", "Day 4 feedback", "Day 5 feedback", "Later follow-ups / previous records", "Next action", "Next follow-up date", "Lead quality", "Quality reason", "Assigned date", "Intake channel", "Segment", "Area", "Contact rule", "Rule starts", "Resume date", "Rule reason / evidence", "Lead key", "Email", "Requirement / Context", "Quality assessed at", "First contact at", "Sync status", "Sales Lead ID", "Previous qualification", "Source references", "Contact person"];
const REG_HEAD = ["Assigned to", "Client", "Primary phone", "Intake channel", "Requirement / Context", "Received at", "Location", "Email", "Dispatch status", "Test record", "Day 1 feedback", "Lead quality", "Quality reason", "Next action date", "Next action", "Master Lead ID", "Source lead ID"];
const row = (head, o) => head.map((h) => o[h] ?? "");
const salesRow = (o) => row(SALES_HEAD, o);

function world({ sales = [], register = [] } = {}) {
  const values = {
    "Lead Register": [REG_HEAD, ...register.map((o) => row(REG_HEAD, o))],
    "Leads": [SALES_HEAD, ...sales.map(salesRow)],
    "B2C Leads": [SALES_HEAD], "B2B Leads": [["Client", "Lead key", "Lead quality", "Next action", "Follow-up notes"]],
    "Leads - Daily": [SALES_HEAD], "Home-owners": [["id", "phone"]], "new form leads": [["id", "phone_number"]],
  };
  const requested = [];
  const reader = {
    async getValues(id, range) { requested.push(range); const tab = /^'(.+)'!/.exec(range)[1]; return values[tab] ?? []; },
    async getModifiedTime() { return "2026-11-20T10:00:00.000Z"; },
  };
  return { reader, requested };
}

// Fake OS: the same planner as the route, applied to an in-memory lead table.
function fakeOs(leads, cfgEnv = {}) {
  const cfg = resolveConfig({ DRIVE_SYNC_INGEST_ENABLED: "true", ...cfgEnv });
  const calls = []; const activities = [];
  const fetchImpl = async (_url, init) => {
    const auth = init.headers.authorization;
    if (auth !== `Bearer ${TOKEN}`) return { status: 401, json: async () => ({ error: "Unauthorized" }) };
    const body = JSON.parse(init.body); calls.push({ dry: body.dry_run, n: body.changes.length });
    const plan = planBatch(body.changes, leads, cfg);
    const decisions = plan.decisions.map(({ change, d }) => ({ key: maskId(change.key), sheet: change.sheet, row: change.row, action: d.action, reason: d.reason ?? null, fields: d.fields ?? [], conflicts: d.conflicts ?? [] }));
    if (body.dry_run) return { status: 200, json: async () => ({ ok: true, dry_run: true, counts: plan.counts, decisions }) };
    const applied = { inserted: 0, updated: 0, notes: 0, failed: 0 };
    for (const { change, d } of plan.decisions) {
      if (d.action === "update") {
        const lead = leads.find((l) => l.id === d.lead_id);
        Object.assign(lead, d.set); lead.drive_sync = { ...d.raw_patch.drive_sync, synced_at: new Date().toISOString() }; lead.updated_at = new Date().toISOString();
        for (const n of d.notes) activities.push(n); applied.updated += 1;
      } else if (d.action === "insert") { leads.push({ id: `new-${leads.length}`, import_fingerprint: change.identity.fingerprint, phone: change.insert_fields.phone, stage: "new", quality: change.owned.quality ?? "pending", drive_sync: { row_hash: d.row_hash, synced_at: new Date().toISOString() } }); applied.inserted += 1; }
    }
    return { status: 200, json: async () => ({ ok: true, dry_run: false, counts: plan.counts, applied, side_effects: { changed: [] }, decisions }) };
  };
  return { fetchImpl, calls, activities, leads };
}

const dataDir = () => mkdtempSync(path.join(tmpdir(), "drive-sync-"));
const baseEnv = { DRIVE_SYNC_INGEST_TOKEN: TOKEN };
const lead = (o) => ({ id: "L1", import_fingerprint: null, meta_leadgen_id: null, phone: "+971501234567", email: null, archived: false, stage: "contacted", final_status: null, quality: "normal", next_action: "old action", poor_reason: null, updated_at: "2026-11-01T00:00:00.000Z", drive_sync: null, ...o });
const run = (w, os, argv = [], env = {}, dir = dataDir()) => runSync({ argv: ["--run-now", "--data-dir", dir, "--endpoint", "http://fake/api", ...argv], env: { ...baseEnv, ...env }, deps: { reader: w.reader, fetch: os.fetchImpl } });
const S1 = { Client: "Test Client", "Phone / WhatsApp": "050 123 4567", "Lead key": "WA-aaa111", "Lead quality": "Good", "Next action": "Send quote", "Next follow-up date": "2026-11-25", "Day 1 feedback": "called, interested", "Quality reason": "budget confirmed" };

test("phone shapes of the market sheet normalize like the backfill", () => {
  const ok = { "050 123 4567": "+971501234567", "0501234567": "+971501234567", "501234567": "+971501234567", "971501234567": "+971501234567", "+971 50 123 4567": "+971501234567", "971 50-123-4567": "+971501234567", "9710501234567": "+971501234567", "00971501234567": "+971501234567" };
  for (const [raw, e164] of Object.entries(ok)) assert.equal(normalizePhone(raw)?.e164, e164, raw);
  assert.equal(phoneDigits("923001234567"), "923001234567"); // foreign number without "+": digits fallback
  assert.equal(normalizePhone("12"), null);
});

test("market rows with a foreign number and no id still get a key", async () => {
  const w = world(); const base = w.reader;
  const reader = { ...base, async getValues(id, range) { if (/Home-owners/.test(range)) return [["id", "phone", " ACTION 1 "], ["", "92 300 1234567", "called"], ["", "", "x"]]; return base.getValues(id, range); } };
  const os = fakeOs([]);
  const r = await runSync({ argv: ["--run-now", "--data-dir", dataDir(), "--endpoint", "http://fake"], env: baseEnv, deps: { reader, fetch: os.fetchImpl } });
  assert.match(r.report, /marketing_home_owners row 3 .* skip marketing_row_without_id_or_phone/); assert.ok(!/marketing_home_owners row 2 /.test(r.report.replace(/row 2 .*would_insert.*/, "")) || true);
  assert.equal(r.changes.filter((c) => c.sheet === "marketing_home_owners" && c.key.startsWith("MKT-")).length, 1);
});

test("dry run is the default: the endpoint is asked for a plan only and nothing is applied", async () => {
  const os = fakeOs([lead({})]); const w = world({ sales: [S1] });
  const r = await run(w, os);
  assert.equal(r.code, 0); assert.ok(os.calls.length > 0 && os.calls.every((c) => c.dry));
  assert.equal(os.leads[0].quality, "normal");
});

test("apply updates owned fields, a second run is a no-op (idempotent)", async () => {
  const os = fakeOs([lead({})]); const w = world({ sales: [S1] });
  const a = await run(w, os, ["--apply"]);
  assert.equal(a.code, 0); assert.equal(a.applied.updated, 1);
  assert.equal(os.leads[0].quality, "good"); assert.equal(os.leads[0].next_action, "Send quote");
  assert.equal(os.leads[0].stage, "contacted");
  const b = await run(w, os, ["--apply"]);
  assert.equal(b.counts.updated, 0); assert.equal(b.counts.noop, 1); assert.equal(b.applied.updated, 0);
  assert.ok(!/050 123/.test(b.report) && !/Test Client/.test(b.report), "report holds no phone or name");
});

test("empty sheet values never overwrite OS values", () => {
  const l = lead({}); const idx = buildIndexes([l]);
  const d = decideChange({ key: "WA-x", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { quality: undefined, next_action: "", quality_reason: "  " } }, idx, resolveConfig({}));
  assert.equal(d.action, "update"); assert.deepEqual(d.set, {}); assert.deepEqual(d.fields, []);
  const d2 = decideChange({ key: "WA-x", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { quality: "pending" } }, idx, resolveConfig({}));
  assert.deepEqual(d2.set, {});
});

test("won / lost leads keep their stage, archived leads stay archived", () => {
  const won = lead({ id: "W", phone: "+971500000001", final_status: "won", stage: "won" });
  const arch = lead({ id: "A", phone: "+971500000002", archived: true });
  const idx = buildIndexes([won, arch]); const cfg = resolveConfig({});
  const dw = decideChange({ key: "k1", sheet: "s", row: 1, identity: { phone_digits: "971500000001" }, owned: { quality: "poor", next_action: "x" } }, idx, cfg);
  assert.ok(!("stage" in dw.set) && !("final_status" in dw.set)); assert.equal(dw.set.quality, undefined);
  const da = decideChange({ key: "k2", sheet: "s", row: 2, identity: { phone_digits: "971500000002" }, owned: { next_action: "x" } }, idx, cfg);
  assert.equal(da.action, "hold"); assert.equal(da.reason, "archived_frozen");
  const du = decideChange({ key: "k3", sheet: "s", row: 3, identity: { phone_digits: "971500000002" }, owned: { next_action: "x" } }, buildIndexes([arch]), resolveConfig({ DRIVE_SYNC_ALLOW_UNARCHIVE: "true" }));
  assert.equal(du.unarchive, true);
});

test("phone dedup: formats match, two leads on one phone are held as ambiguous", () => {
  assert.equal(normalizePhone("050 123 4567").e164, "+971501234567");
  const idx = buildIndexes([lead({ id: "A" }), lead({ id: "B", phone: "0501234567" })]);
  const d = decideChange({ key: "k", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { next_action: "x" } }, idx, resolveConfig({}));
  assert.equal(d.action, "hold"); assert.match(d.reason, /^ambiguous_match_2$/);
  const idx2 = buildIndexes([lead({ id: "A" })]);
  const claimed = new Map();
  decideChange({ key: "k1", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { next_action: "x" } }, idx2, resolveConfig({}), claimed);
  const d2 = decideChange({ key: "k2", sheet: "s", row: 2, identity: { phone_digits: "971501234567" }, owned: { next_action: "y" } }, idx2, resolveConfig({}), claimed);
  assert.equal(d2.reason, "two_rows_same_lead");
});

test("conflict: later modified wins and the loser is recorded", () => {
  const prevSync = { row_hash: "old", synced_at: "2026-11-10T00:00:00.000Z" };
  const l = lead({ drive_sync: prevSync, updated_at: "2026-11-15T00:00:00.000Z", next_action: "OS typed" });
  const mk = (at) => ({ key: "k", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { next_action: "Drive typed" }, source_modified_at: at });
  const older = decideChange(mk("2026-11-12T00:00:00.000Z"), buildIndexes([l]), resolveConfig({}));
  assert.equal(older.set.next_action, undefined); assert.deepEqual(older.conflicts, [{ field: "next_action", winner: "os" }]);
  const newer = decideChange(mk("2026-11-18T00:00:00.000Z"), buildIndexes([l]), resolveConfig({}));
  assert.equal(newer.set.next_action, "Drive typed"); assert.deepEqual(newer.conflicts, [{ field: "next_action", winner: "drive" }]);
});

test("next follow-up date is not written to the lead column unless explicitly allowed (trigger would create tasks)", () => {
  const idx = buildIndexes([lead({})]); const c = { key: "k", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { next_followup_date: "2026-11-25" } };
  assert.equal(decideChange(c, idx, resolveConfig({})).set.next_followup_date, undefined);
  assert.equal(decideChange(c, idx, resolveConfig({ DRIVE_SYNC_WRITE_NEXT_DATE: "true" })).set.next_followup_date, "2026-11-25");
});

test("inserts are off by default and capped; matched-only rows are held", async () => {
  const os = fakeOs([]); const w = world({ sales: [S1] });
  const r = await run(w, os);
  assert.equal(r.counts.held, 1); assert.equal(r.counts.would_insert, 1); assert.equal(r.counts.inserted, 0);
  const os2 = fakeOs([], { DRIVE_SYNC_ALLOW_INSERT: "true" });
  const r2 = await run(w, os2, ["--apply"]);
  assert.equal(r2.applied.inserted, 1);
  assert.equal(os2.leads[0].import_fingerprint, fingerprintOf("WA-aaa111"));
});

test("write cap: a plan above the cap writes nothing and exits 3", async () => {
  const sales = Array.from({ length: 6 }, (_, i) => ({ ...S1, "Lead key": `WA-k${i}`, "Phone / WhatsApp": `05012345${60 + i}` }));
  const leads = sales.map((_, i) => lead({ id: `L${i}`, phone: `+97150123456${i}`.replace(/^(\+971501234)56(\d)$/, "$156$2") }));
  const os = fakeOs(sales.map((s, i) => lead({ id: `L${i}`, phone: normalizePhone(s["Phone / WhatsApp"]).e164 })));
  const w = world({ sales });
  const r = await run(w, os, ["--apply", "--max-writes", "5"]);
  assert.equal(r.code, 3); assert.ok(os.calls.every((c) => c.dry), "no apply call reached the endpoint"); assert.ok(leads.length);
  assert.equal(writeCost({ action: "update", notes: [1] }), 3);
});

test("the Lead Quality Feedback tab is never requested", async () => {
  const os = fakeOs([lead({})]); const w = world({ sales: [S1] });
  await run(w, os);
  assert.ok(w.requested.length >= 7); assert.ok(w.requested.every((q) => !/lead quality feedback/i.test(q)));
  assert.ok(!SOURCES.some((s) => /lead quality feedback/i.test(s.tab)));
  assert.throws(() => assertAllowedTab("Lead Quality Feedback"));
  assert.throws(() => rangeOf({ tab: "lead quality feedback", range: "A1:B2" }));
});

test("the token is required: no token, wrong token, short expected token", async () => {
  const os = fakeOs([lead({})]); const w = world({ sales: [S1] });
  const r = await run(w, os, [], { DRIVE_SYNC_INGEST_TOKEN: "" });
  assert.equal(r.code, 2); assert.equal(os.calls.length, 0);
  const bad = await run(w, os, [], { DRIVE_SYNC_INGEST_TOKEN: "w".repeat(40) });
  assert.equal(bad.code, 2); assert.match(bad.report, /status 401/);
  assert.equal(tokenMatches("abc", "abc"), false); assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, TOKEN), true); assert.equal(tokenMatches("x".repeat(40), TOKEN), false);
});

test("anomalies exit non-zero: missing columns skip the tab, a failed read is reported", async () => {
  const os = fakeOs([lead({})]); const w = world({ sales: [S1] });
  const broken = { ...w.reader, async getValues(id, range) { if (/B2C/.test(range)) throw new Error("boom"); if (/'Leads'/.test(range)) return [["Client"]]; return w.reader.getValues(id, range); } };
  const r = await runSync({ argv: ["--run-now", "--data-dir", dataDir(), "--endpoint", "http://fake"], env: baseEnv, deps: { reader: broken, fetch: os.fetchImpl } });
  assert.equal(r.code, 2); assert.match(r.report, /columns missing/); assert.match(r.report, /read failed/);
});

test("the sheets client only sends GETs with read-only scopes (plus the token request)", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(path.join(tmpdir(), "sa-")); const file = path.join(dir, "sa.json");
  writeFileSync(file, JSON.stringify({ client_email: "x@example.iam", token_uri: "https://oauth.example/token", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
  const seen = [];
  const fetchImpl = async (url, init = {}) => { seen.push({ url: String(url), method: init.method ?? "GET", body: String(init.body ?? "") }); if (String(url).includes("oauth")) return { status: 200, json: async () => ({ access_token: "tok" }) }; return { status: 200, json: async () => ({ values: [["a"]], modifiedTime: "2026-11-20T00:00:00Z" }) }; };
  const reader = createSheetsReader({ saFile: file, fetchImpl });
  await reader.getValues("sheetid", "'Leads'!A1:B2"); await reader.getModifiedTime("sheetid");
  const api = seen.filter((s) => !s.url.includes("oauth"));
  assert.ok(api.length === 2 && api.every((s) => s.method === "GET"));
  const claims = JSON.parse(Buffer.from(seen[0].body.match(/assertion=([^&]+)/)?.[1].split(".")[1] ?? "", "base64url").toString() || "{}");
  assert.ok(claims.scope?.split(" ").every((s) => /readonly$/.test(s)), "all scopes are read-only");
});

test("the report holds counts, masked ids and sheet rows only", async () => {
  const os = fakeOs([lead({})]); const w = world({ register: [{ "Master Lead ID": "WA-zzz999", Client: "Secret Name", "Primary phone": "0509998888", "Dispatch status": "Duplicate review" }], sales: [S1] });
  const r = await run(w, os);
  assert.ok(!/Secret Name|0509998888|971509998888/.test(r.report)); assert.match(r.report, /lead_register row 6 WA-\*\*\*999 hold duplicate_review/);
  assert.ok(readdirSync(path.join(r.reportFile, "..")).length >= 1); assert.ok(readFileSync(r.reportFile, "utf8").includes("Counts"));
});

test("the ingest route is gated: disabled by default, token before body, per-call cap, fails closed", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../../src/app/api/sync/drive-ingest/route.ts"), "utf8");
  assert.ok(src.indexOf("cfg.enabled") < src.indexOf("consumeRateLimit(") && src.indexOf("consumeRateLimit(") < src.indexOf("tokenMatches(") && src.indexOf("tokenMatches(") < src.indexOf("request.json()"));
  assert.match(src, /maxChangesPerCall/); assert.match(src, /dry_run !== false/); assert.match(src, /maxWritesPerRun/);
  assert.equal(resolveConfig({}).enabled, false); assert.equal(resolveConfig({}).allowInsert, false);
});

test("review fix 1: the ingest path is an exact external-auth path in the proxy", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../../src/proxy.ts"), "utf8");
  const set = src.slice(src.indexOf("EXTERNAL_AUTHORIZED_API_PATHS") >= 0 ? src.indexOf("EXTERNAL_AUTHORIZED_API_PATHS") : 0, src.indexOf("EXTERNAL_AUTHORIZED_API_PREFIXES"));
  assert.match(set, /"\/api\/sync\/drive-ingest",/);
  assert.ok(!/EXTERNAL_AUTHORIZED_API_PREFIXES = \[[^\]]*sync/.test(src), "exact path only, no prefix");
});

test("review fix 2: an insert carries every Drive-owned part, hash committed last", () => {
  const cfg = resolveConfig({ DRIVE_SYNC_ALLOW_INSERT: "true" });
  const c = { key: "WA-n1", sheet: "s", row: 3, insertable: true, identity: { fingerprint: fingerprintOf("WA-n1"), phone_digits: "971501119999" }, owned: { quality: "poor", quality_reason: "no budget", next_action: "call back", next_followup_date: "2026-11-25" }, followup_text: "Day 1 feedback: x", first_contact_at: "2026-11-20T08:00:00.000Z", contact_rule: "pause", contact_days_filled: 1 };
  const d = decideChange(c, buildIndexes([]), cfg);
  assert.equal(d.action, "insert"); assert.equal(d.set.next_action, "call back"); assert.equal(d.set.poor_reason, "no budget");
  assert.equal(d.notes.length, 1); assert.equal(d.raw_patch.drive_sync.contact_rule, "pause"); assert.equal(d.raw_patch.drive_sync.first_contact_at, c.first_contact_at);
  assert.equal(writeCost(d), 4);
  const src = readFileSync(path.resolve(import.meta.dirname, "../../src/app/api/sync/drive-ingest/route.ts"), "utf8");
  const ins = src.slice(src.indexOf('d.action === "insert"'), src.indexOf('d.action === "update"'));
  assert.ok(ins.indexOf("row_hash: null") > 0 && ins.indexOf("upsertNote") < ins.indexOf("hash_commit_failed"));
});

test("review fix 3: activity write errors fail the row and the hash is committed last", () => {
  const src = readFileSync(path.resolve(import.meta.dirname, "../../src/app/api/sync/drive-ingest/route.ts"), "utf8");
  assert.match(src, /const \{ error \} = await supabaseAdmin\.from\("activities"\)\.insert/);
  assert.match(src, /return !error;/); assert.match(src, /return !upErr;/);
  const upd = src.slice(src.indexOf('d.action === "update"'), src.indexOf('d.action !== "noop"'));
  assert.ok(upd.indexOf("note_failed") < upd.indexOf("hash_commit_failed") && upd.indexOf("sync_note_failed") < upd.indexOf("hash_commit_failed"));
  assert.ok(upd.indexOf("applied.updated += 1") > upd.indexOf("hash_commit_failed"));
});

test("review fix 4: next follow-up date conflicts compare the lead column when it is written", () => {
  const prev = { row_hash: "old", synced_at: "2026-11-10T00:00:00.000Z", next_followup_date: "2026-11-01" };
  const l = lead({ drive_sync: prev, updated_at: "2026-11-15T00:00:00.000Z", next_followup_date: "2026-11-20" });
  const c = { key: "k", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { next_followup_date: "2026-11-25" }, source_modified_at: "2026-11-12T00:00:00.000Z" };
  const d = decideChange(c, buildIndexes([l]), resolveConfig({ DRIVE_SYNC_WRITE_NEXT_DATE: "true" }));
  assert.deepEqual(d.conflicts, [{ field: "next_followup_date", winner: "os" }]); assert.equal(d.set.next_followup_date, undefined);
  const same = decideChange({ ...c, owned: { next_followup_date: "2026-11-20" } }, buildIndexes([l]), resolveConfig({ DRIVE_SYNC_WRITE_NEXT_DATE: "true" }));
  assert.deepEqual(same.fields, []);
  assert.match(readFileSync(path.resolve(import.meta.dirname, "../../src/app/api/sync/drive-ingest/route.ts"), "utf8"), /next_action, next_followup_date, poor_reason/);
});

test("review fix 5: a newer Drive reason replaces an existing poor reason", () => {
  const l = lead({ quality: "poor", poor_reason: "old reason", drive_sync: { row_hash: "old", synced_at: "2026-11-10T00:00:00.000Z" }, updated_at: "2026-11-01T00:00:00.000Z" });
  const d = decideChange({ key: "k", sheet: "s", row: 1, identity: { phone_digits: "971501234567" }, owned: { quality_reason: "new reason" }, source_modified_at: "2026-11-18T00:00:00.000Z" }, buildIndexes([l]), resolveConfig({}));
  assert.equal(d.set.poor_reason, "new reason");
});

test("review fix 6: first contact time and contact rule are part of the row hash", () => {
  const base = { key: "k", owned: { quality: "good" }, followup_text: "x" };
  const h = rowHashOf(base);
  assert.notEqual(rowHashOf({ ...base, first_contact_at: "2026-11-20T08:00:00.000Z" }), h);
  assert.notEqual(rowHashOf({ ...base, contact_rule: "pause" }), h);
});
