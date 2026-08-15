import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyHistoryBaseline } from "../../scripts/check-history-baseline.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BODY_MARKER = "SET check_function_bodies = false;";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function copyFile(root, relative) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, relative), target);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "newme-schema-baseline-"));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const relative of [
    "supabase/replay/production-schema-baseline.sql",
    "supabase/replay/production-schema-baseline.json",
    "supabase/replay/capture-production-schema-baseline.sql",
    "supabase/migration-history-reconciliation.json",
    "infra/release/release-manifest.json",
  ]) {
    copyFile(root, relative);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "infra/release/release-manifest.json"), "utf8"));
  for (const entry of [...manifest.required_for_app, ...manifest.deferred_contract]) {
    copyFile(root, path.join("supabase", "migrations", entry.file));
  }
  return root;
}

function readMeta(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "supabase/replay/production-schema-baseline.json"), "utf8"));
}

function writeMeta(root, meta) {
  fs.writeFileSync(
    path.join(root, "supabase/replay/production-schema-baseline.json"),
    JSON.stringify(meta, null, 2) + "\n",
  );
}

function restampBaseline(root) {
  const sqlPath = path.join(root, "supabase/replay/production-schema-baseline.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const marker = sql.indexOf(BODY_MARKER);
  assert.notEqual(marker, -1);
  const body = sql.slice(marker);
  const meta = readMeta(root);
  meta.artifact.bytes = Buffer.byteLength(sql, "utf8");
  meta.artifact.sha256 = sha256(Buffer.from(sql, "utf8"));
  meta.source.body_bytes = Buffer.byteLength(body, "utf8");
  meta.source.body_sha256 = sha256(Buffer.from(body, "utf8"));
  writeMeta(root, meta);
}

test("the checked-in schema baseline binds the production capture and exact pending set", () => {
  const result = verifyHistoryBaseline({ root: ROOT });
  assert.equal(result.projectId, "vfopmpxlhwzpxqegayew");
  assert.equal(result.watermark, "20260805202917");
  assert.equal(result.productionHistoryRows, 100);
  assert.equal(result.baselineStatementCount, 2408);
  assert.equal(result.forward.length, 26);
  assert.equal(result.forward[0], "20260806000000_baseline_undeclared_production_objects.sql");
  assert.equal(result.forward.at(-1), "20260818000000_money_direct_write_contract_phase.sql");
  assert.ok(result.forward.includes("20260817220000_notification_event_idempotency.sql"));
  assert.ok(result.forward.includes("20260817230000_lead_rebalance_plan_idempotency.sql"));
});

test("one changed baseline byte is refused before apply", (t) => {
  const root = fixture(t);
  const file = path.join(root, "supabase/replay/production-schema-baseline.sql");
  fs.appendFileSync(file, "-- tamper\n");
  assert.throws(() => verifyHistoryBaseline({ root }), /baseline (?:byte count|SHA-256) differs/);
});

test("top-level row DML is refused even when an attacker restamps both hashes", (t) => {
  const root = fixture(t);
  const file = path.join(root, "supabase/replay/production-schema-baseline.sql");
  fs.appendFileSync(file, "INSERT INTO public.profiles DEFAULT VALUES;\n");
  restampBaseline(root);
  assert.throws(() => verifyHistoryBaseline({ root }), /forbidden top-level kind INSERT/);
});

test("credential-shaped material is refused even when artifact integrity is restamped", (t) => {
  const root = fixture(t);
  const file = path.join(root, "supabase/replay/production-schema-baseline.sql");
  const sql = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, sql.replace(
    "-- GENERATED FILE:",
    `-- ${["sb", "secret", "schema-baseline-fixture-value"].join("_")}\n-- GENERATED FILE:`,
  ));
  restampBaseline(root);
  assert.throws(() => verifyHistoryBaseline({ root }), /forbidden secret-shaped material: supabase-secret/);
});

test("capture query tampering is refused by provenance hash", (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "supabase/replay/capture-production-schema-baseline.sql"), "\n-- changed\n");
  assert.throws(
    () => verifyHistoryBaseline({ root }),
    /capture query (?:must contain exactly one top-level statement|SHA-256 differs)/,
  );
});

test("history reconciliation tampering is refused by provenance hash", (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "supabase/migration-history-reconciliation.json"), " ");
  assert.throws(() => verifyHistoryBaseline({ root }), /history reconciliation SHA-256 differs/);
});

test("omitting a pending migration from the manifest is refused in both directions", (t) => {
  const root = fixture(t);
  const manifestPath = path.join(root, "infra/release/release-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.required_for_app = manifest.required_for_app.filter(
    (entry) => entry.version !== "20260817220000",
  );
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  assert.throws(() => verifyHistoryBaseline({ root }), /not the exact set/);
});

test("an undeclared timestamped migration after the watermark is refused", (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, "supabase/migrations/20260817225000_undeclared.sql"),
    "select 1;\n",
  );
  assert.throws(() => verifyHistoryBaseline({ root }), /not the exact set/);
});

test("a manifest entry whose migration bytes changed is refused", (t) => {
  const root = fixture(t);
  fs.appendFileSync(
    path.join(root, "supabase/migrations/20260817220000_notification_event_idempotency.sql"),
    "-- changed\n",
  );
  assert.throws(() => verifyHistoryBaseline({ root }), /migration hash differs/);
});
