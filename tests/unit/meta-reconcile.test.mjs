// S7 item 2: daily reconciliation of Meta form leads against the CRM.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateReconciliation, reconcile } from "../../scripts/meta-reconcile.mjs";

const PAGE = "123456789012345";
const NOW = Date.parse("2026-11-05T02:40:00Z");

const base = { mode: "dry_run", meta_leads: 4, already_in_crm: 4, missing: 0, failed: 0, isolated: 0,
  by_day: { "2026-11-04": { meta: 4, crm_before: 4 } } };

test("consistent counts pass", () => {
  const v = evaluateReconciliation(base);
  assert.equal(v.ok, true);
  assert.match(v.line, /all present in CRM/);
});

test("a missing lead or a failed check is a discrepancy with counts only", () => {
  const v = evaluateReconciliation({ ...base, already_in_crm: 3, missing: 1, by_day: { "2026-11-04": { meta: 4, crm_before: 3 } } });
  assert.equal(v.ok, false);
  assert.match(v.line, /1 Meta lead\(s\) are not in the CRM/);
  assert.match(v.line, /2026-11-04 meta 4 \/ crm 3/);
  assert.equal(evaluateReconciliation({ ...base, failed: 2 }).ok, false);
  assert.equal(evaluateReconciliation({ ...base, mode: "execute" }).ok, false, "never reconcile in write mode");
});

function graphLead(id, createdIso) {
  return { id, created_time: createdIso, platform: "ig", form_id: "998877665544", ad_id: "120249679465810743", adset_id: "120249626000270743", campaign_id: "120249626000250743", field_data: [{ name: "full_name", values: ["Fatima Test"] }, { name: "phone_number", values: ["+971500000000"] }] };
}

test("reconcile is read-only, bounds the window and keeps a grace period for in-flight leads", async () => {
  const graphCalls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    graphCalls.push(u);
    const path = u.pathname.split("/").slice(2).join("/");
    if (path === PAGE) return Response.json({ id: PAGE, access_token: "page-token" });
    if (path === `${PAGE}/leadgen_forms`) return Response.json({ data: [{ id: "998877665544", name: "Form" }] });
    if (path === "998877665544/leads") return Response.json({ data: [graphLead("500100000000001", "2026-11-04T10:00:00+0000"), graphLead("500200000000002", "2026-11-04T11:00:00+0000")] });
    return Response.json({ data: [] });
  };
  const writes = [];
  const db = { from() { const q = { select: () => q, in: async () => ({ data: [{ id: "l1", meta_leadgen_id: "500100000000001" }], error: null }),
    insert: (...a) => { writes.push(a); return q; }, update: (...a) => { writes.push(a); return q; }, upsert: (...a) => { writes.push(a); return q; },
    eq: () => q, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) }; return q; } };
  const { verdict } = await reconcile({ db, fetchImpl, nowMs: NOW, env: { META_LEADGEN_PAGE_IDS: PAGE, META_LEADS_ACCESS_TOKEN: "t" } });
  assert.equal(verdict.ok, false);
  assert.match(verdict.line, /1 Meta lead\(s\) are not in the CRM/);
  assert.deepEqual(writes, [], "reconciliation must not write");
  const leadsCall = graphCalls.find((u) => u.pathname.endsWith("/leads"));
  const filtering = JSON.parse(leadsCall.searchParams.get("filtering"));
  assert.deepEqual(filtering.map((f) => f.operator), ["GREATER_THAN", "LESS_THAN"]);
  assert.equal(filtering[1].value, Math.floor(NOW / 1000) - 30 * 60, "last 30 minutes are excluded");
  assert.equal(filtering[0].value, Math.floor(NOW / 1000) - 3 * 86_400);
  assert.ok(!verdict.line.includes("Fatima") && !verdict.line.includes("971"), "no lead data in the report");
});

test("shell wrapper alerts through the state machine and passes on the exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "newme-reconcile-"));
  const log = join(root, "alerts.log");
  const alert = join(root, "alert.sh");
  writeFileSync(alert, `#!/usr/bin/env bash\nprintf '%s|%s|%s\\n' "$1" "$2" "$3" >> "${log}"\n`);
  chmodSync(alert, 0o755);
  const fake = (body) => { const f = join(root, "fake.mjs"); writeFileSync(f, body); return f; };
  const wrapper = fileURLToPath(new URL("../../infra/observability/meta-reconcile.sh", import.meta.url));
  const run = (script) => spawnSync("bash", [wrapper], { encoding: "utf8", env: { ...process.env, HERMES_ALERT_STATE_SCRIPT: alert, NODE_BIN: process.execPath, META_RECONCILE_SCRIPT: script } });
  let r = run(fake('console.log("MISMATCH: 2 Meta lead(s) are not in the CRM"); process.exit(1);'));
  assert.equal(r.status, 1);
  r = run(fake('console.log("OK: Meta 3 leads, all present in CRM"); process.exit(0);'));
  assert.equal(r.status, 0);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines[0], "meta-lead-reconcile|failure|Meta lead reconciliation: MISMATCH: 2 Meta lead(s) are not in the CRM");
  assert.match(lines[1], /^meta-lead-reconcile\|recovery\|Meta lead reconciliation OK/);
});
