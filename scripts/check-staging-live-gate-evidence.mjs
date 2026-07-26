#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const fail = (message) => {
  console.error(`staging live gate evidence rejected: ${message}`);
  process.exit(1);
};

const [
  evidencePath,
  expectedGitSha,
  expectedProjectRef,
  expectedQuerySha256,
] = process.argv.slice(2);

if (!evidencePath) fail("evidence path is required");
if (!/^[0-9a-f]{40}$/.test(expectedGitSha ?? "")) {
  fail("expected git SHA must be 40 lowercase hexadecimal characters");
}
if (!/^[a-z]{20}$/.test(expectedProjectRef ?? "")) {
  fail("expected project ref must be 20 lowercase letters");
}
if (!/^[0-9a-f]{64}$/.test(expectedQuerySha256 ?? "")) {
  fail("expected query SHA-256 must be 64 lowercase hexadecimal characters");
}

let evidence;
try {
  evidence = JSON.parse(await readFile(evidencePath, "utf8"));
} catch {
  fail("evidence file is missing or invalid JSON");
}

if (evidence.schema_version !== 1) fail("unsupported schema version");
if (evidence.git_sha !== expectedGitSha) fail("git SHA does not match release");
if (evidence.project_ref !== expectedProjectRef) {
  fail("project ref does not match isolated staging");
}
if (evidence.query_sha256 !== expectedQuerySha256) {
  fail("query SHA-256 does not match the installed gate");
}
if (evidence.result !== "pass") fail("result is not pass");
if (evidence.violation_count !== 0) fail("violation count is not zero");

const checkedAt = Date.parse(evidence.checked_at);
if (!Number.isFinite(checkedAt)) fail("checked_at is not a valid timestamp");

const age = Date.now() - checkedAt;
if (age < -MAX_FUTURE_SKEW_MS) fail("checked_at is too far in the future");
if (age > MAX_AGE_MS) fail("evidence is older than 24 hours");

console.log(
  `staging live gate evidence verified SHA=${expectedGitSha} project=${expectedProjectRef}`,
);
