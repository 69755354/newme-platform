import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { canonicalJson, validateDeployCiBinding } from "../../scripts/check-deploy-ci-binding.mjs";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("infra/release/required-jobs.json", root), "utf8"));
const deploy = await readFile(new URL("scripts/deploy-immutable.sh", root), "utf8");
const now = new Date("2026-08-15T00:30:00Z");
const baseEnv = {
  CI_EVENT: "workflow_dispatch",
  CI_HEAD_SHA: "b".repeat(40),
  CI_RUN_ID: "31654454535",
  CI_WORKFLOW_ID: "310914082",
  CI_WORKFLOW_PATH: ".github/workflows/ci.yml",
  CI_RUN_COMPLETED_AT: "2026-08-15T00:00:00Z",
  CI_GATE_AUDITED_AT: "2026-08-15T00:01:00Z",
  CI_MAX_RUN_AGE_SECONDS: "86400",
};
const requiredJobCompletedAt = Object.fromEntries(
  manifest.required_jobs.map(({ name }) => [name, "2026-08-14T23:59:30Z"]),
);
const audit = {
  version: "newme-ci-gate-audit/v1",
  release_sha: baseEnv.CI_HEAD_SHA,
  run_id: baseEnv.CI_RUN_ID,
  workflow_id: 310914082,
  workflow_path: ".github/workflows/ci.yml",
  workflow_name: "ci",
  workflow_state: "active",
  event: "workflow_dispatch",
  head_branch: "main",
  run_status: "completed",
  run_conclusion: "success",
  max_run_age_seconds: 86400,
  run_created_at: "2026-08-14T23:50:00Z",
  run_started_at: "2026-08-14T23:55:00Z",
  run_completed_at: baseEnv.CI_RUN_COMPLETED_AT,
  required_job_completed_at: requiredJobCompletedAt,
  manifest_sha256: createHash("sha256").update(canonicalJson(manifest)).digest("hex"),
  validated_at: baseEnv.CI_GATE_AUDITED_AT,
};
const validAuditBytes = Buffer.from(`${canonicalJson(audit)}\n`);
const validEnv = {
  ...baseEnv,
  CI_GATE_AUDIT_SHA256: createHash("sha256").update(validAuditBytes).digest("hex"),
};

const validate = (env = validEnv, candidateManifest = manifest, clock = now, auditBytes = validAuditBytes) =>
  validateDeployCiBinding({ manifest: candidateManifest, env, auditBytes, now: clock });

test("the exact workflow identity, fresh run, and audit digest pass", () => {
  assert.deepEqual(validate(), []);
});

test("workflow lookalikes and manifest weakening fail closed", () => {
  assert.ok(validate({ ...validEnv, CI_WORKFLOW_ID: "999" }).length > 0);
  assert.ok(validate({ ...validEnv, CI_WORKFLOW_PATH: ".github/workflows/lookalike.yml" }).length > 0);
  assert.ok(validate(validEnv, { ...manifest, workflow_id: 999 }).length > 0);
  assert.ok(validate(validEnv, { ...manifest, workflow_path: ".github/workflows/lookalike.yml" }).length > 0);
  assert.ok(validate(validEnv, { ...manifest, max_run_age_seconds: 86_401 }).length > 0);
});

test("malformed, future, reversed, and stale timestamps fail closed", () => {
  assert.ok(validate({ ...validEnv, CI_RUN_COMPLETED_AT: "not-a-time" }).length > 0);
  assert.ok(validate({ ...validEnv, CI_GATE_AUDITED_AT: "2026-08-14T23:59:59Z" }).length > 0);
  assert.ok(validate({ ...validEnv, CI_GATE_AUDITED_AT: "2026-08-15T00:36:00Z" }).length > 0);
  assert.ok(validate(validEnv, manifest, new Date("2026-08-16T00:00:01Z")).length > 0);
});

test("the oldest required-job completion controls boundary freshness", () => {
  const modified = {
    ...audit,
    required_job_completed_at: {
      ...audit.required_job_completed_at,
      "Repository validation": "2026-08-14T00:29:59Z",
    },
  };
  const bytes = Buffer.from(`${canonicalJson(modified)}\n`);
  const env = { ...validEnv, CI_GATE_AUDIT_SHA256: createHash("sha256").update(bytes).digest("hex") };
  assert.match(validate(env, manifest, now, bytes).join("\n"), /stale at the current release boundary/);
});

test("audit preimage tampering and alternate serialization fail closed", () => {
  const tampered = Buffer.from(validAuditBytes);
  tampered[10] ^= 1;
  assert.match(validate(validEnv, manifest, now, tampered).join("\n"), /digest does not match/);
  const pretty = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`);
  const prettyEnv = { ...validEnv, CI_GATE_AUDIT_SHA256: createHash("sha256").update(pretty).digest("hex") };
  assert.match(validate(prettyEnv, manifest, now, pretty).join("\n"), /not canonical JSON/);
});

test("a malformed gate digest fails closed", () => {
  assert.ok(validate({ ...validEnv, CI_GATE_AUDIT_SHA256: "a".repeat(63) }).length > 0);
  assert.ok(validate({ ...validEnv, CI_GATE_AUDIT_SHA256: "A".repeat(64) }).length > 0);
});

test("immutable deploy rechecks the binding at extraction, switch, and evidence boundaries", () => {
  assert.equal(
    deploy.split(/\r?\n/).filter((line) => line.includes('check-deploy-ci-binding.mjs')).length,
    3,
  );
  assert.match(deploy, /CI_GATE_AUDIT_SHA256/);
  assert.match(deploy, /CI_GATE_AUDITED_AT/);
  assert.match(deploy, /CI_RUN_COMPLETED_AT/);
  assert.match(deploy, /CI_WORKFLOW_ID/);
  assert.match(deploy, /CI_WORKFLOW_PATH/);
});
