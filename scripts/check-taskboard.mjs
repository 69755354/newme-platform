import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDirectory, "..");

function readFile(projectRoot, relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function hasFile(projectRoot, relativePath) {
  return fs.existsSync(path.join(projectRoot, relativePath));
}

function matchingLineCount(source, text) {
  return source.split(/\r?\n/).filter((line) => line.includes(text)).length;
}

export function runTaskboardCheck({ projectRoot = defaultProjectRoot, log = console.log } = {}) {
  const result = { pass: 0, fail: 0, warn: 0 };
  const pass = (message) => {
    result.pass += 1;
    log(`  PASS ${message}`);
  };
  const fail = (message) => {
    result.fail += 1;
    log(`  FAIL ${message}`);
  };
  const warn = (message) => {
    result.warn += 1;
    log(`  WARN ${message}`);
  };
  const source = (relativePath) => readFile(projectRoot, relativePath);
  const checkFile = (relativePath, missingMessage, evaluate) => {
    if (!hasFile(projectRoot, relativePath)) {
      fail(missingMessage);
      return;
    }
    evaluate(source(relativePath));
  };

  log("=== Taskboard Verification ===");

  checkFile("src/lib/supabaseQuery.ts", "File src/lib/supabaseQuery.ts does not exist", (text) => {
    if (/useSupabaseQuery/.test(text) && /AbortController/.test(text) && /8000|8s|timeout/.test(text) && /retry|retryCount|maxRetries/.test(text)) {
      pass("supabaseQuery.ts exists with all required features");
    } else {
      warn("supabaseQuery.ts exists but missing some features (AbortController/timeout/retry)");
    }
  });

  checkFile("src/components/DashboardErrorBoundary.tsx", "File src/components/DashboardErrorBoundary.tsx does not exist", (text) => {
    if (/errorId/.test(text) && /sentry/i.test(text)) {
      pass("DashboardErrorBoundary.tsx exists with errorId + Sentry");
    } else {
      warn("DashboardErrorBoundary.tsx exists but missing errorId or Sentry");
    }
  });

  checkFile("src/shared/hooks/usePipelineDragDrop.ts", "File src/shared/hooks/usePipelineDragDrop.ts does not exist", (text) => {
    if (/onDragStart|onDrop/.test(text) && /draggingLeadId|dragging/.test(text)) {
      pass("usePipelineDragDrop.ts exists with drag handlers");
    } else {
      warn("usePipelineDragDrop.ts exists but missing required exports");
    }
  });

  checkFile("src/shared/hooks/useStageGuard.ts", "File src/shared/hooks/useStageGuard.ts does not exist", (text) => {
    if (/validTransition|stageGuard|isValidTransition/.test(text)) {
      pass("useStageGuard.ts exists with transition validation");
    } else {
      warn("useStageGuard.ts exists but missing validation logic");
    }
  });

  checkFile("src/app/(dashboard)/layout.tsx", "File layout.tsx does not exist", (text) => {
    if (/ErrorBoundary/.test(text)) pass("layout.tsx contains ErrorBoundary");
    else fail("layout.tsx missing ErrorBoundary");
  });

  checkFile("src/app/(dashboard)/leads/page.tsx", "File leads/page.tsx does not exist", (text) => {
    if (/usePipelineDragDrop/.test(text)) pass("leads imports usePipelineDragDrop");
    else fail("leads does NOT import usePipelineDragDrop");
    if (/useStageGuard/.test(text)) pass("leads imports useStageGuard");
    else fail("leads does NOT import useStageGuard");
    if (/useSupabaseQuery/.test(text)) pass("leads imports useSupabaseQuery");
    else fail("leads does NOT import useSupabaseQuery");
  });

  checkFile("src/app/(dashboard)/pipeline/page.tsx", "File pipeline/page.tsx does not exist", (text) => {
    if (/usePipelineDragDrop/.test(text)) pass("pipeline imports usePipelineDragDrop");
    else fail("pipeline does NOT import usePipelineDragDrop (still inline)");
    if (/useSupabaseQuery/.test(text)) pass("pipeline imports useSupabaseQuery");
    else fail("pipeline does NOT import useSupabaseQuery (still direct calls)");
    if (/useStageGuard/.test(text)) pass("pipeline imports useStageGuard");
    else fail("pipeline does NOT import useStageGuard");
  });

  checkFile("src/app/(dashboard)/leads/[id]/page.tsx", "File leads/[id]/page.tsx does not exist", (text) => {
    const maybeCount = matchingLineCount(text, "maybeSingle");
    if (maybeCount >= 3) pass(`maybeSingle count = ${maybeCount} (>= 3)`);
    else fail(`maybeSingle count = ${maybeCount} (need >= 3)`);
    if (/skeleton|Skeleton|loading.*fallback/i.test(text)) pass("contains skeleton/loading fallback");
    else fail("missing skeleton/loading fallback");
    if (/useSupabaseQuery/.test(text)) pass("imports useSupabaseQuery");
    else fail("does NOT import useSupabaseQuery");
  });

  checkFile("src/app/(dashboard)/products/page.tsx", "File products/page.tsx does not exist", (text) => {
    if (/fetch.*api\/products/.test(text)) pass("products uses fetch('/api/products') via API route");
    else fail("products does NOT fetch /api/products");
  });

  checkFile("src/app/globals.css", "File src/app/globals.css does not exist", (text) => {
    if (/error-boundary-fallback/.test(text)) pass("globals.css contains error-boundary-fallback");
    else fail("globals.css missing error-boundary-fallback");
  });

  checkFile("src/components/DashboardErrorBoundary.tsx", "DashboardErrorBoundary.tsx does not exist (needed for T1-11)", (text) => {
    if (/captureException|Sentry\.capture/.test(text)) pass("ErrorBoundary contains captureException");
    else fail("ErrorBoundary missing Sentry.captureException");
  });

  const taskboard = source("TASKBOARD.md");
  const t1_12 = taskboard.split(/\r?\n/).find((line) => line.startsWith("| T1-12 "))?.match(/[✅⚠️❌]/)?.[0];
  if (t1_12 === "✅") pass("TASKBOARD.md marks T1-12 done");
  else if (t1_12 === "❌") fail("TASKBOARD.md marks T1-12 not started");
  else warn("TASKBOARD.md marks T1-12 partial or malformed — manual verification pending");

  log(`PASS: ${result.pass} FAIL: ${result.fail} WARN: ${result.warn}`);
  if (result.fail > 0) log(`TASKBOARD GATE: ${result.fail} task(s) incomplete. DEPLOY BLOCKED.`);
  else log("All tasks complete. Safe to deploy.");

  return { ...result, exitCode: result.fail > 0 ? 1 : 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTaskboardCheck().exitCode;
}
