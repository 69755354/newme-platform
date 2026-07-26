import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const command = fileURLToPath(
  new URL("../../scripts/check-staging-live-gate-evidence.mjs", import.meta.url),
);
const gitSha = "a".repeat(40);
const projectRef = "bfsiibofuzoglziltgyd";
const querySha256 = "b".repeat(64);
const root = new URL("../../", import.meta.url);

const validEvidence = () => ({
  schema_version: 1,
  git_sha: gitSha,
  project_ref: projectRef,
  query_sha256: querySha256,
  checked_at: new Date().toISOString(),
  result: "pass",
  violation_count: 0,
});

const execute = (path, overrides = {}) =>
  run(process.execPath, [
    command,
    path,
    overrides.gitSha ?? gitSha,
    overrides.projectRef ?? projectRef,
    overrides.querySha256 ?? querySha256,
  ]);

test("fresh zero-row live gate evidence allows the exact staging SHA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-live-gate-pass-"));
  const evidencePath = join(directory, "evidence.json");
  try {
    await writeFile(evidencePath, JSON.stringify(validEvidence()), "utf8");
    const result = await execute(evidencePath);
    assert.match(result.stdout, /staging live gate evidence verified/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live gate evidence fails closed on release, target, query, result, and age drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-live-gate-reject-"));
  const evidencePath = join(directory, "evidence.json");
  const cases = [
    [{ git_sha: "c".repeat(40) }, /git SHA does not match release/],
    [{ project_ref: "abcdefghijklmnopqrst" }, /project ref does not match/],
    [{ query_sha256: "d".repeat(64) }, /query SHA-256 does not match/],
    [{ result: "fail", violation_count: 1 }, /result is not pass/],
    [{
      checked_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    }, /older than 24 hours/],
  ];

  try {
    for (const [patch, expected] of cases) {
      await writeFile(
        evidencePath,
        JSON.stringify({ ...validEvidence(), ...patch }),
        "utf8",
      );
      await assert.rejects(execute(evidencePath), expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or malformed live gate evidence is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-live-gate-invalid-"));
  const evidencePath = join(directory, "evidence.json");
  try {
    await assert.rejects(execute(evidencePath), /missing or invalid JSON/);
    await writeFile(evidencePath, "{", "utf8");
    await assert.rejects(execute(evidencePath), /missing or invalid JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging promotion installs and requires exact-SHA live gate evidence", async () => {
  const [deploy, install] = await Promise.all([
    readFile(new URL("scripts/deploy-staging.sh", root), "utf8"),
    readFile(new URL("scripts/install-staging-assets.sh", root), "utf8"),
  ]);

  for (const pattern of [
    /check-staging-live-gate-evidence\.mjs/,
    /check-authenticated-security-definer-rpc-allowlist\.sql/,
    /validation\/\$SHA\/security-definer-live-gate\.json/,
    /cleanroom live security gate evidence is missing or invalid/,
  ]) assert.match(deploy, pattern);

  for (const pattern of [
    /check-staging-live-gate-evidence\.mjs/,
    /check-authenticated-security-definer-rpc-allowlist\.sql/,
    /\/opt\/newme-staging\/validation/,
  ]) assert.match(install, pattern);
});
