import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskboardCheck } from "../../scripts/check-taskboard.mjs";

const fixtureFiles = {
  "src/lib/supabaseQuery.ts": "useSupabaseQuery AbortController 8000 retry",
  "src/components/DashboardErrorBoundary.tsx": "errorId Sentry captureException",
  "src/shared/hooks/usePipelineDragDrop.ts": "onDragStart draggingLeadId",
  "src/shared/hooks/useStageGuard.ts": "validTransition",
  "src/app/(dashboard)/layout.tsx": "ErrorBoundary",
  "src/app/(dashboard)/leads/page.tsx": "usePipelineDragDrop useStageGuard useSupabaseQuery",
  "src/app/(dashboard)/pipeline/page.tsx": "usePipelineDragDrop useSupabaseQuery useStageGuard",
  "src/app/(dashboard)/leads/[id]/page.tsx": "maybeSingle\nmaybeSingle\nmaybeSingle\nSkeleton\nuseSupabaseQuery",
  "src/app/(dashboard)/products/page.tsx": "fetch('/api/products')",
  "src/app/globals.css": ".error-boundary-fallback {}",
  "TASKBOARD.md": "| T1-12 | Sentry error events actually received | manual | ✅ | 2026-07-01 |\n",
};

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskboard-check-"));
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return root;
}

function withFixture(callback) {
  const root = createFixture();
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("taskboard checker accepts a complete taskboard", () => {
  withFixture((projectRoot) => {
    const result = runTaskboardCheck({ projectRoot, log: () => {} });
    assert.deepEqual(result, { pass: 18, fail: 0, warn: 0, exitCode: 0 });
  });
});

test("taskboard checker blocks missing required evidence", () => {
  withFixture((projectRoot) => {
    fs.rmSync(path.join(projectRoot, "src/app/(dashboard)/layout.tsx"));
    const result = runTaskboardCheck({ projectRoot, log: () => {} });
    assert.equal(result.fail, 1);
    assert.equal(result.exitCode, 1);
  });
});

test("taskboard checker warns but does not crash on malformed T1-12 status", () => {
  withFixture((projectRoot) => {
    fs.writeFileSync(path.join(projectRoot, "TASKBOARD.md"), "| T1-12 | Sentry | manual | done |\n");
    const result = runTaskboardCheck({ projectRoot, log: () => {} });
    assert.deepEqual(result, { pass: 17, fail: 0, warn: 1, exitCode: 0 });
  });
});
