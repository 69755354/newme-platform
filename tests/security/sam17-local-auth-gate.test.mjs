import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateSam17Report } from "../../scripts/run-sam17-local-auth-gate.mjs";

const SHA = "a".repeat(40);
const ACTORS = ["boss", "admin", "operator", "sales", "sales-other"];
const CHECKS = [
  "auth-refresh",
  "dashboard",
  "lead-create-read-update",
  "first-contact",
  "timeline-edit-delete-readback",
  "won-lost",
  "cross-owner-denial",
];

function validReport() {
  return {
    ok: true,
    ui: "covered",
    runs: [1, 2].map((run) => ({
      run,
      actors: [...ACTORS],
      checks: [...CHECKS],
      cleanup: "verified",
    })),
  };
}

test("SAM-17 accepts only exact two-run authenticated browser evidence", () => {
  const evidence = validateSam17Report(validReport(), SHA);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.git_sha, SHA);
  assert.equal(evidence.ui, "covered");
  assert.equal(evidence.runs.length, 2);
});

test("SAM-17 fails closed on incomplete actors, checks, browser coverage, or cleanup", () => {
  const mutations = [
    (report) => { report.ok = false; },
    (report) => { report.ui = "not-covered-browser-unavailable"; },
    (report) => { report.runs.pop(); },
    (report) => { report.runs[0].actors.pop(); },
    (report) => { report.runs[0].checks.pop(); },
    (report) => { report.runs[1].cleanup = "failed"; },
  ];
  for (const mutate of mutations) {
    const report = validReport();
    mutate(report);
    assert.throws(() => validateSam17Report(report, SHA), /SAM17_FAIL_CLOSED/);
  }
  assert.throws(() => validateSam17Report(validReport(), "short"), /expected SHA/);
});

test("SAM-17 wrapper binds a clean HEAD and keeps bounded evidence outside the repository", async () => {
  const source = await readFile(
    new URL("../../scripts/run-sam17-local-auth-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /verify-local-sam66-auth-regression\.mjs/);
  assert.match(source, /git\("rev-parse", "HEAD"\)/);
  assert.match(source, /git\("status", "--porcelain", "--untracked-files=all"\)/);
  assert.match(source, /evidence path must remain outside the repository/);
  assert.match(source, /mode: 0o600/);
  assert.match(source, /REDACTED_JWT/);
  assert.doesNotMatch(source, /staging\.newme\.ae|app\.newme\.ae|bfsiibofuzoglziltgyd|vfopmpxlhwzpxqegayew/);
});
