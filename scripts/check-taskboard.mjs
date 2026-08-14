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

const UNFINISHED_STATUSES = new Set(["TODO", "IN_PROGRESS", "REVIEW", "BLOCKED"]);

// ── Release scopes ──────────────────────────────────────────────────────────
// Round-4 C4-4. Until this revision the board had exactly two states as far as
// automation was concerned: "no unfinished rows" or "blocked", and the canonical
// deploy wrapper required the first. Most rows on this board cannot reach it
// before a deploy — they say 待部署, and what closes them is production having
// run the change. So the one gate that AGENTS.md calls a physical deploy blocker
// was unsatisfiable by construction, which is the same defect the required-jobs
// manifest documents about the reviewed wrapper: an unsatisfiable gate is not a
// strict gate, it is a gate that gets bypassed, and a bypassed gate protects
// nothing.
//
// The rows are therefore declared into two ordered milestones, in TASKBOARD.md
// itself (the Iron Rule: if it is not on the board, it does not exist):
//
//   predeploy_ready       must be closed before the canonical deploy or guarded
//                         control-plane bootstrap runs at all
//   postdeploy_acceptance can only be closed after production has run the change
//
// A scope requirement is cumulative: postdeploy_acceptance also requires
// predeploy_ready, so the later milestone can never go green over the earlier one.
// --require-complete is the last milestone, i.e. unchanged behaviour, and stays
// the release-final gate.
//
// The declarations are checked in both directions on every run of this checker,
// including the CI job that does not require any scope: an unfinished row nobody
// declared is a FAIL naming it (otherwise the way to leave the deploy gate is to
// add a row and say nothing), and a declaration with no unfinished row is a FAIL
// naming it (otherwise stale declarations accumulate until nobody can tell which
// ones are load-bearing).
export const SCOPE_ORDER = ["predeploy_ready", "postdeploy_acceptance"];
const SCOPE_BEGIN = "<!-- taskboard-scopes:begin -->";
const SCOPE_END = "<!-- taskboard-scopes:end -->";
const SCOPE_HEADER = /^\|\s*item\s*\|\s*scope\s*\|\s*closure condition\s*\|$/i;
const SCOPE_SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;
const SCOPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MIN_REASON_LENGTH = 8;

function findUnfinishedRows(taskboard, skipRange = null) {
  const rows = [];
  for (const [index, line] of taskboard.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    // The scope block's own rows start with "|" too. They are excluded here and
    // constrained by parseScopeBlock(), which refuses any line inside the block
    // that is not a declaration — so the exclusion cannot be used to park a real
    // row where this scan will not see it.
    if (skipRange && lineNumber >= skipRange.start && lineNumber <= skipRange.end) continue;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^⚠️\s*/u, ""));
    const status = cells.find((cell) => UNFINISHED_STATUSES.has(cell));
    if (status) rows.push({ line: lineNumber, status, key: cells[0] ?? "", source: line });
  }
  return rows;
}

function findTaskboardItemKeys(taskboard, skipRange = null) {
  const keys = new Set();
  for (const [index, line] of taskboard.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    if (skipRange && lineNumber >= skipRange.start && lineNumber <= skipRange.end) continue;
    if (!line.startsWith("|")) continue;
    const key = line.split("|")[1]?.trim() ?? "";
    if (SCOPE_KEY.test(key)) keys.add(key);
  }
  return keys;
}

export function parseScopeBlock(taskboard) {
  const lines = taskboard.split(/\r?\n/);
  const problems = [];
  const declarations = new Map();
  const begins = [];
  const ends = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === SCOPE_BEGIN) begins.push(index + 1);
    if (line.trim() === SCOPE_END) ends.push(index + 1);
  }
  if (begins.length === 0 && ends.length === 0) {
    return { present: false, declarations, problems, range: null };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
    problems.push(
      `TASKBOARD.md has ${begins.length} "${SCOPE_BEGIN}" and ${ends.length} "${SCOPE_END}" marker(s) ` +
        "in that order; the release-scope block must be exactly one region",
    );
    return { present: true, declarations, problems, range: null };
  }
  const range = { start: begins[0], end: ends[0] };
  for (let lineNumber = range.start + 1; lineNumber < range.end; lineNumber += 1) {
    const line = lines[lineNumber - 1].trim();
    if (line === "" || SCOPE_HEADER.test(line) || SCOPE_SEPARATOR.test(line)) continue;
    const cells =
      line.startsWith("|") && line.endsWith("|")
        ? line.slice(1, -1).split("|").map((cell) => cell.trim())
        : null;
    if (!cells || cells.length !== 3) {
      problems.push(
        `TASKBOARD.md line ${lineNumber} is inside the release-scope block but is neither its header ` +
          "nor a three-cell declaration; a line this parser skips is a row the scope gate cannot see",
      );
      continue;
    }
    const [key, scope, reason] = cells;
    if (!SCOPE_KEY.test(key)) {
      problems.push(
        `TASKBOARD.md line ${lineNumber} declares a scope for "${key}", which is not an item key`,
      );
      continue;
    }
    if (!SCOPE_ORDER.includes(scope)) {
      problems.push(
        `TASKBOARD.md line ${lineNumber} puts ${key} in scope "${scope}"; the scopes are ${SCOPE_ORDER.join(", ")}`,
      );
      continue;
    }
    if (reason.length < MIN_REASON_LENGTH) {
      problems.push(
        `TASKBOARD.md line ${lineNumber} puts ${key} in ${scope} without stating what closes it; ` +
          "a scope with no closure condition is a row moved out of the deploy gate without a reason anyone can read",
      );
      continue;
    }
    const existing = declarations.get(key);
    if (existing) {
      problems.push(
        `TASKBOARD.md declares a scope for ${key} twice (lines ${existing.line} and ${lineNumber})`,
      );
      continue;
    }
    declarations.set(key, { scope, reason, line: lineNumber });
  }
  return { present: true, declarations, problems, range };
}

// A candidate SHA cannot contain a truthful TASKBOARD row saying that the same
// SHA's future CI run succeeded: editing the row changes the SHA and starts the
// proof over. The deploy wrapper instead verifies the exact candidate run from
// required-jobs.json, while a later TASKBOARD-only closure SHA records that
// already-observed evidence. This manifest map makes that split machine-readable
// and prevents an evidence-dependent row from drifting back into predeploy.
export function auditClosureEvidenceModel(taskboard, manifest) {
  const problems = [];
  const parsed = parseScopeBlock(taskboard);
  const items = findTaskboardItemKeys(taskboard, parsed.range);
  const requiredJobs = new Set(
    Array.isArray(manifest?.required_jobs)
      ? manifest.required_jobs.map((entry) => entry?.name).filter((name) => typeof name === "string" && name)
      : [],
  );
  const entries = manifest?.taskboard_closure_evidence;
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push("infra/release/required-jobs.json has no taskboard_closure_evidence map");
    return problems;
  }

  const seen = new Set();
  const allowedEvidence = new Set([
    "all_required_jobs",
    "required_job",
    "post_main_workflow_delivery",
  ]);
  for (const [index, entry] of entries.entries()) {
    const label = `taskboard_closure_evidence[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${label} is not an object`);
      continue;
    }
    const { item, evidence, job } = entry;
    if (typeof item !== "string" || !SCOPE_KEY.test(item)) {
      problems.push(`${label} has no valid item key`);
      continue;
    }
    if (seen.has(item)) {
      problems.push(`infra/release/required-jobs.json maps TASKBOARD row ${item} twice`);
      continue;
    }
    seen.add(item);
    if (!items.has(item)) {
      problems.push(`infra/release/required-jobs.json maps missing TASKBOARD row ${item}`);
    }
    if (!allowedEvidence.has(evidence)) {
      problems.push(`${label} for ${item} has unknown evidence kind ${JSON.stringify(evidence)}`);
    }
    if (evidence === "required_job") {
      if (typeof job !== "string" || !requiredJobs.has(job)) {
        problems.push(`${label} for ${item} names a job that is not required by this manifest`);
      }
    } else if (job !== undefined) {
      problems.push(`${label} for ${item} must not name a job for evidence kind ${evidence}`);
    }

    const declaration = parsed.declarations.get(item);
    if (declaration && declaration.scope !== "postdeploy_acceptance") {
      problems.push(
        `TASKBOARD.md row ${item} depends on ${evidence} evidence and must be ` +
          `postdeploy_acceptance; putting it in predeploy_ready makes the candidate SHA prove its own future run`,
      );
    }
  }

  const evidenceDependent = /exact-head|workflow_run|Hermes(?: webhook| delivery)?|合并后的 main|必需 CI/i;
  for (const [item, declaration] of parsed.declarations) {
    if (evidenceDependent.test(declaration.reason) && !seen.has(item)) {
      problems.push(
        `TASKBOARD.md row ${item} has an exact-head or post-main closure condition but is absent from ` +
          "infra/release/required-jobs.json taskboard_closure_evidence",
      );
    }
  }
  return problems;
}

export function runTaskboardCheck({
  projectRoot = defaultProjectRoot,
  log = console.log,
  requireComplete = false,
  requireScope = null,
} = {}) {
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

  const scopeBlock = parseScopeBlock(taskboard);
  const unfinishedRows = findUnfinishedRows(taskboard, scopeBlock.range);
  const openByScope = new Map(SCOPE_ORDER.map((scope) => [scope, []]));

  if (scopeBlock.present || unfinishedRows.length > 0) {
    if (!scopeBlock.present) {
      fail(
        `TASKBOARD.md has ${unfinishedRows.length} unfinished row(s) and no "${SCOPE_BEGIN}" … ` +
          `"${SCOPE_END}" block: with no declarations, no unfinished row can be attributed to a ` +
          "release milestone and the predeploy gate would be measuring nothing",
      );
    } else {
      for (const problem of scopeBlock.problems) fail(problem);
      const openKeys = [...new Set(unfinishedRows.map((row) => row.key))];
      const undeclared = openKeys.filter((key) => !scopeBlock.declarations.has(key));
      const stale = [...scopeBlock.declarations.keys()].filter((key) => !openKeys.includes(key));
      for (const key of undeclared) {
        fail(
          `TASKBOARD.md row ${key} is unfinished but declares no release scope; ` +
            `add it to the release-scope block as one of ${SCOPE_ORDER.join(", ")}`,
        );
      }
      for (const key of stale) {
        fail(
          `TASKBOARD.md declares a release scope for ${key}, which has no unfinished row; ` +
            "remove the declaration so the block keeps naming only load-bearing rows",
        );
      }
      if (scopeBlock.problems.length === 0 && undeclared.length === 0 && stale.length === 0) {
        pass(
          `every unfinished TASKBOARD row declares exactly one release scope ` +
            `(${scopeBlock.declarations.size} row(s) declared)`,
        );
      }
    }
  }

  if (hasFile(projectRoot, "infra/release/required-jobs.json")) {
    try {
      const manifest = JSON.parse(source("infra/release/required-jobs.json"));
      const evidenceProblems = auditClosureEvidenceModel(taskboard, manifest);
      for (const problem of evidenceProblems) fail(problem);
      if (evidenceProblems.length === 0) {
        pass(
          `TASKBOARD closure-only evidence rows are machine-bound to the candidate gate manifest ` +
            `(${manifest.taskboard_closure_evidence.length} row(s))`,
        );
      }
    } catch (error) {
      fail(`infra/release/required-jobs.json is not valid JSON (${error.message})`);
    }
  }

  for (const row of unfinishedRows) {
    // An undeclared row falls into the earliest milestone, which is the direction
    // that blocks the most: it has already been reported as a FAIL above, and it
    // must not be able to sit outside every gate while that is being fixed.
    const scope = scopeBlock.declarations.get(row.key)?.scope ?? SCOPE_ORDER[0];
    openByScope.get(scope).push(row);
  }

  if (unfinishedRows.length > 0) {
    log("Tracked unfinished TASKBOARD rows:");
    for (const row of unfinishedRows) {
      const scope = scopeBlock.declarations.get(row.key)?.scope ?? "UNDECLARED";
      log(`  UNFINISHED line=${row.line} status=${row.status} scope=${scope} ${row.source}`);
    }
  }

  log(
    `PASS: ${result.pass} FAIL: ${result.fail} WARN: ${result.warn} ` +
      `UNFINISHED: ${unfinishedRows.length}`,
  );
  log(`SCOPES: ${SCOPE_ORDER.map((scope) => `${scope}=${openByScope.get(scope).length}`).join(" ")}`);

  const requestedScope = requireScope ?? (requireComplete ? SCOPE_ORDER[SCOPE_ORDER.length - 1] : null);
  let blocking = [];
  if (requestedScope) {
    // Cumulative on purpose: postdeploy acceptance cannot be green while a
    // predeploy row is open, because the release should never have reached
    // production while that row was unfinished.
    for (const scope of SCOPE_ORDER.slice(0, SCOPE_ORDER.indexOf(requestedScope) + 1)) {
      blocking = blocking.concat(openByScope.get(scope).map((row) => ({ ...row, scope })));
    }
  }

  let exitCode = 0;
  if (result.fail > 0) {
    log(`TASKBOARD EVIDENCE GATE: ${result.fail} code-evidence check(s) failed.`);
    exitCode = 1;
  } else if (requestedScope === SCOPE_ORDER[SCOPE_ORDER.length - 1] && blocking.length > 0) {
    log(
      `TASKBOARD COMPLETION GATE: ${blocking.length} unfinished row(s). ` +
        "RELEASE FINALIZATION BLOCKED.",
    );
    exitCode = 1;
  } else if (requestedScope && blocking.length > 0) {
    log(
      `TASKBOARD SCOPE GATE: ${requestedScope} requires ${blocking.length} more row(s): ` +
        `${blocking.map((row) => `${row.key} (${row.scope}, line ${row.line})`).join(", ")}. ` +
        "DEPLOYMENT BLOCKED.",
    );
    exitCode = 1;
  } else if (requestedScope) {
    log(
      `Taskboard scope gate ${requestedScope} is satisfied` +
        (unfinishedRows.length > 0
          ? `; ${unfinishedRows.length} row(s) remain in later milestones.`
          : "; no unfinished rows at all."),
    );
  } else if (unfinishedRows.length > 0) {
    log(
      `Taskboard evidence checks passed with ${unfinishedRows.length} tracked unfinished row(s). ` +
        "Release-final completion remains blocked.",
    );
  } else {
    log("Taskboard evidence checks passed; no unfinished rows.");
  }

  return { ...result, exitCode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const usage = () => {
    console.error(
      `Usage: node scripts/check-taskboard.mjs [--require-complete | --require-scope=<${SCOPE_ORDER.join("|")}>]`,
    );
    process.exitCode = 64;
  };
  const scopeArgument = args.find((arg) => arg.startsWith("--require-scope="));
  const requireScope = scopeArgument ? scopeArgument.slice("--require-scope=".length) : null;
  const unknown = args.filter((arg) => arg !== "--require-complete" && arg !== scopeArgument);
  if (args.length > 1 || unknown.length > 0) {
    // One mode per invocation. Two modes on one command line is a caller that
    // does not know which milestone it is gating, and guessing for it is how a
    // deploy ends up satisfied by the wrong scope.
    usage();
  } else if (requireScope !== null && !SCOPE_ORDER.includes(requireScope)) {
    console.error(`Unknown scope "${requireScope}"; the scopes are ${SCOPE_ORDER.join(", ")}`);
    process.exitCode = 64;
  } else {
    process.exitCode = runTaskboardCheck({
      requireComplete: args[0] === "--require-complete",
      requireScope,
    }).exitCode;
  }
}
