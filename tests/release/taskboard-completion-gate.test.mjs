import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runTaskboardCheck } from "../../scripts/check-taskboard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_FILES = [
  "src/lib/supabaseQuery.ts",
  "src/components/DashboardErrorBoundary.tsx",
  "src/shared/hooks/usePipelineDragDrop.ts",
  "src/shared/hooks/useStageGuard.ts",
  "src/app/(dashboard)/layout.tsx",
  "src/app/(dashboard)/leads/page.tsx",
  "src/app/(dashboard)/pipeline/page.tsx",
  "src/app/(dashboard)/leads/[id]/page.tsx",
  "src/app/(dashboard)/products/page.tsx",
  "src/app/globals.css",
];

function withFixture(extraTaskboard, callback) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-completion-"));
  try {
    for (const relativePath of REQUIRED_FILES) {
      const target = path.join(fixture, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relativePath), target);
    }
    const t1StatusRow = fs
      .readFileSync(path.join(ROOT, "TASKBOARD.md"), "utf8")
      .split(/\r?\n/)
      .find((line) => line.startsWith("| T1-12 "));
    assert.ok(t1StatusRow, "repository fixture must contain the T1-12 evidence row");
    fs.writeFileSync(path.join(fixture, "TASKBOARD.md"), `${t1StatusRow}\n${extraTaskboard}\n`);
    callback(fixture);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

const UNFINISHED_ROWS = [
  "| TRACKED-TODO | TODO |",
  "| TRACKED-ACTIVE | IN_PROGRESS |",
  "| TRACKED-REVIEW | REVIEW |",
  "| TRACKED-BLOCKED | BLOCKED |",
  "| TRACKED-WARN | ⚠️ REVIEW |",
].join("\n");

test("pre-deploy taskboard evidence mode reports unfinished rows without blocking CI", () => {
  withFixture(UNFINISHED_ROWS, (projectRoot) => {
    const messages = [];
    const result = runTaskboardCheck({ projectRoot, log: (line) => messages.push(line) });
    const output = messages.join("\n");
    assert.equal(result.exitCode, 0);
    assert.match(output, /UNFINISHED: 5/);
    for (const status of ["TODO", "IN_PROGRESS", "REVIEW", "BLOCKED"]) {
      assert.match(output, new RegExp(`status=${status}`));
    }
    assert.match(output, /Release-final completion remains blocked/);
    assert.doesNotMatch(output, /Safe to deploy/i);
  });
});

test("release-final taskboard completion mode blocks the same unfinished rows", () => {
  withFixture(UNFINISHED_ROWS, (projectRoot) => {
    const messages = [];
    const result = runTaskboardCheck({
      projectRoot,
      requireComplete: true,
      log: (line) => messages.push(line),
    });
    const output = messages.join("\n");
    assert.equal(result.exitCode, 1);
    assert.match(output, /TASKBOARD COMPLETION GATE: 5 unfinished row\(s\)/);
    assert.match(output, /RELEASE FINALIZATION BLOCKED/);
    assert.doesNotMatch(output, /Safe to deploy/i);
  });
});

test("completion mode ignores status vocabulary in prose and accepts DONE table rows", () => {
  withFixture(
    "The state machine documents TODO, IN_PROGRESS, REVIEW, and BLOCKED.\n| TRACKED-DONE | DONE |",
    (projectRoot) => {
      const messages = [];
      const result = runTaskboardCheck({
        projectRoot,
        requireComplete: true,
        log: (line) => messages.push(line),
      });
      assert.equal(result.exitCode, 0);
      assert.match(messages.join("\n"), /UNFINISHED: 0/);
    },
  );
});
