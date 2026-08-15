import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditClosureEvidenceModel,
  REMEDIATION_BLOCKER_ITEM,
  runTaskboardCheck,
} from "../../scripts/check-taskboard.mjs";

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

// Round-4 C4-4. Every unfinished row must declare a milestone, so a fixture with
// unfinished rows and no block is now a FAIL — which is itself one of the cases
// measured below. The declarations are appended to the rows they describe.
const scopeBlock = (entries) =>
  [
    "<!-- taskboard-scopes:begin -->",
    "| item | scope | closure condition |",
    "| --- | --- | --- |",
    ...entries.map(([key, scope, reason]) => `| ${key} | ${scope} | ${reason ?? "closes when the fixture says so"} |`),
    "<!-- taskboard-scopes:end -->",
  ].join("\n");

const ALL_SCOPED = scopeBlock([
  ["TRACKED-TODO", "predeploy_ready"],
  ["TRACKED-ACTIVE", "predeploy_ready"],
  ["TRACKED-REVIEW", "postdeploy_acceptance"],
  ["TRACKED-BLOCKED", "postdeploy_acceptance"],
  ["TRACKED-WARN", "postdeploy_acceptance"],
]);

function runFixture(extraTaskboard, options = {}) {
  let captured;
  withFixture(extraTaskboard, (projectRoot) => {
    const messages = [];
    const result = runTaskboardCheck({ projectRoot, log: (line) => messages.push(line), ...options });
    captured = { result, output: messages.join("\n") };
  });
  return captured;
}

test("pre-deploy taskboard evidence mode reports unfinished rows without blocking CI", () => {
  const { result, output } = runFixture(`${UNFINISHED_ROWS}\n${ALL_SCOPED}`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.fail, 0);
  assert.match(output, /UNFINISHED: 5/);
  for (const status of ["TODO", "IN_PROGRESS", "REVIEW", "BLOCKED"]) {
    assert.match(output, new RegExp(`status=${status}`));
  }
  assert.match(output, /Release-final completion remains blocked/);
  assert.doesNotMatch(output, /Safe to deploy/i);
  // Round-4 C4-4. The unscoped CI run still attributes every row, so the counts
  // it prints are the same ones the deploy gate will act on.
  assert.match(output, /SCOPES: predeploy_ready=2 postdeploy_acceptance=3/);
});

test("release-final taskboard completion mode blocks the same unfinished rows", () => {
  const { result, output } = runFixture(`${UNFINISHED_ROWS}\n${ALL_SCOPED}`, { requireComplete: true });
  assert.equal(result.exitCode, 1);
  assert.match(output, /TASKBOARD COMPLETION GATE: 5 unfinished row\(s\)/);
  assert.match(output, /RELEASE FINALIZATION BLOCKED/);
  assert.doesNotMatch(output, /Safe to deploy/i);
});

// ── Round-4 C4-4: the milestone gates ───────────────────────────────────────
// The canonical deploy wrapper used to require the whole board, which this board
// cannot satisfy before a deploy: most rows say 待部署 and close on production
// having run the change. These cases measure the replacement — that an earlier
// milestone can go green while later ones stay open, that requiring a later one
// still requires every earlier one, and that the declarations cannot drift away
// from the rows they describe in either direction.

test("predeploy goes green while postdeploy acceptance rows stay open", () => {
  const board = [
    "| TRACKED-REVIEW | REVIEW |",
    "| TRACKED-BLOCKED | BLOCKED |",
    scopeBlock([
      ["TRACKED-REVIEW", "postdeploy_acceptance"],
      ["TRACKED-BLOCKED", "postdeploy_acceptance"],
    ]),
  ].join("\n");

  const predeploy = runFixture(board, { requireScope: "predeploy_ready" });
  assert.equal(predeploy.result.exitCode, 0);
  assert.match(
    predeploy.output,
    /Taskboard scope gate predeploy_ready is satisfied; 2 row\(s\) remain in later milestones\./,
  );

  const complete = runFixture(board, { requireComplete: true });
  assert.equal(complete.result.exitCode, 1);
  assert.match(complete.output, /TASKBOARD COMPLETION GATE: 2 unfinished row\(s\)/);
});

test("a later milestone can never go green over an open earlier one", () => {
  const board = [
    "| TRACKED-TODO | TODO |",
    scopeBlock([["TRACKED-TODO", "predeploy_ready"]]),
  ].join("\n");
  for (const requireScope of ["predeploy_ready", "postdeploy_acceptance"]) {
    const { result, output } = runFixture(board, { requireScope });
    assert.equal(result.exitCode, 1, `${requireScope} must be blocked by an open predeploy row`);
    assert.match(output, /TRACKED-TODO/);
  }
});

test("credential remediation accepts only the exact secret-scanning blocker", () => {
  const board = [
    `| ${REMEDIATION_BLOCKER_ITEM} | BLOCKED |`,
    "| LATER-UAT | REVIEW |",
    scopeBlock([
      [REMEDIATION_BLOCKER_ITEM, "predeploy_ready", "provider revocation and revoked alert readback"],
      ["LATER-UAT", "postdeploy_acceptance", "closes after production UAT"],
    ]),
  ].join("\n");
  const { result, output } = runFixture(board, { requireCredentialRemediation: true });
  assert.equal(result.exitCode, 0, output);
  assert.equal(result.fail, 0, output);
  assert.match(output, /exactly the permitted predeploy blocker: PROD-SECRET-SCANNING-ALERTS-OPEN \(BLOCKED\)/);
  assert.match(output, /Credential remediation taskboard gate is satisfied/);
  assert.match(output, /SCOPES: predeploy_ready=1 postdeploy_acceptance=1/);
});

test("credential remediation refuses a missing, mis-stated, or additional predeploy blocker", () => {
  const cases = [
    {
      name: "missing target blocker",
      board: [
        "| LATER-UAT | REVIEW |",
        scopeBlock([["LATER-UAT", "postdeploy_acceptance", "closes after production UAT"]]),
      ].join("\n"),
      observed: /observed: none/,
    },
    {
      name: "target is not BLOCKED",
      board: [
        `| ${REMEDIATION_BLOCKER_ITEM} | REVIEW |`,
        scopeBlock([
          [REMEDIATION_BLOCKER_ITEM, "predeploy_ready", "provider revocation and revoked alert readback"],
        ]),
      ].join("\n"),
      observed: /PROD-SECRET-SCANNING-ALERTS-OPEN \(REVIEW, line \d+\)/,
    },
    {
      name: "another predeploy blocker remains",
      board: [
        `| ${REMEDIATION_BLOCKER_ITEM} | BLOCKED |`,
        "| PROD-CODEQL-BLOCKING-RULESET-MISSING | BLOCKED |",
        scopeBlock([
          [REMEDIATION_BLOCKER_ITEM, "predeploy_ready", "provider revocation and revoked alert readback"],
          ["PROD-CODEQL-BLOCKING-RULESET-MISSING", "predeploy_ready", "live ruleset readback must close it"],
        ]),
      ].join("\n"),
      observed: /PROD-CODEQL-BLOCKING-RULESET-MISSING \(BLOCKED, line \d+\)/,
    },
  ];

  for (const fixture of cases) {
    const { result, output } = runFixture(fixture.board, { requireCredentialRemediation: true });
    assert.equal(result.exitCode, 1, `${fixture.name}:\n${output}`);
    assert.match(
      output,
      /credential remediation requires exactly one predeploy blocker, PROD-SECRET-SCANNING-ALERTS-OPEN \(BLOCKED\)/,
      fixture.name,
    );
    assert.match(output, fixture.observed, fixture.name);
    assert.doesNotMatch(output, /Credential remediation taskboard gate is satisfied/, fixture.name);
  }
});

test("credential remediation never masks taskboard structure failures", () => {
  const board = [
    `| ${REMEDIATION_BLOCKER_ITEM} | BLOCKED |`,
    "| UNDECLARED-PREDEPLOY | BLOCKED |",
    scopeBlock([
      [REMEDIATION_BLOCKER_ITEM, "predeploy_ready", "provider revocation and revoked alert readback"],
    ]),
  ].join("\n");
  const { result, output } = runFixture(board, { requireCredentialRemediation: true });
  assert.equal(result.exitCode, 1, output);
  assert.match(output, /UNDECLARED-PREDEPLOY is unfinished but declares no release scope/);
  assert.match(output, /TASKBOARD EVIDENCE GATE:/);
});

test("unfinished rows with no scope block at all are a failure, not a pass", () => {
  const { result, output } = runFixture(UNFINISHED_ROWS);
  assert.equal(result.exitCode, 1);
  assert.match(output, /TASKBOARD EVIDENCE GATE: 1 code-evidence check\(s\) failed\./);
  assert.match(output, /FAIL TASKBOARD\.md has 5 unfinished row\(s\) and no "<!-- taskboard-scopes:begin -->"/);
});

test("an unfinished row nobody declared is named as a failure and gated at the first milestone", () => {
  const board = [
    UNFINISHED_ROWS,
    scopeBlock([
      ["TRACKED-TODO", "predeploy_ready"],
      ["TRACKED-ACTIVE", "predeploy_ready"],
      ["TRACKED-REVIEW", "postdeploy_acceptance"],
      ["TRACKED-BLOCKED", "postdeploy_acceptance"],
      // TRACKED-WARN deliberately left undeclared.
    ]),
  ].join("\n");
  // Every mode refuses it, including the unscoped CI run: the way out of the
  // deploy gate must not be to add a row and say nothing about it.
  const { result, output } = runFixture(board);
  assert.equal(result.exitCode, 1);
  assert.match(output, /FAIL TASKBOARD\.md row TRACKED-WARN is unfinished but declares no release scope/);
  // And while that is being fixed it sits in the milestone that blocks the most,
  // not outside every gate.
  assert.match(output, /UNFINISHED line=\d+ status=REVIEW scope=UNDECLARED/);
  assert.match(output, /SCOPES: predeploy_ready=3 /);
  assert.equal(runFixture(board, { requireScope: "predeploy_ready" }).result.exitCode, 1);
});

test("a declaration with no unfinished row is named as a failure", () => {
  const board = [
    "| TRACKED-TODO | TODO |",
    "| TRACKED-DONE | DONE |",
    scopeBlock([
      ["TRACKED-TODO", "predeploy_ready"],
      ["TRACKED-DONE", "postdeploy_acceptance"],
    ]),
  ].join("\n");
  const { result, output } = runFixture(board);
  assert.equal(result.exitCode, 1);
  assert.match(
    output,
    /FAIL TASKBOARD\.md declares a release scope for TRACKED-DONE, which has no unfinished row/,
  );
  assert.doesNotMatch(output, /TRACKED-TODO, which has no unfinished row/);
});

test("the scope block refuses malformed declarations by line and by reason", () => {
  const cases = [
    {
      name: "a line the parser would otherwise skip",
      block: [
        "<!-- taskboard-scopes:begin -->",
        "| item | scope | closure condition |",
        "| --- | --- | --- |",
        "| TRACKED-TODO | predeploy_ready | closes on the CI run |",
        "TRACKED-ACTIVE is postdeploy, honestly",
        "<!-- taskboard-scopes:end -->",
      ].join("\n"),
      expected: /is inside the release-scope block but is neither its header nor a three-cell declaration/,
    },
    {
      name: "an unknown scope",
      block: scopeBlock([
        ["TRACKED-TODO", "predeploy_ready"],
        ["TRACKED-ACTIVE", "whenever_we_feel_like_it"],
      ]),
      expected: /puts TRACKED-ACTIVE in scope "whenever_we_feel_like_it"; the scopes are predeploy_ready, postdeploy_acceptance/,
    },
    {
      name: "a scope with no closure condition",
      block: scopeBlock([
        ["TRACKED-TODO", "predeploy_ready"],
        ["TRACKED-ACTIVE", "postdeploy_acceptance", "later"],
      ]),
      expected: /puts TRACKED-ACTIVE in postdeploy_acceptance without stating what closes it/,
    },
    {
      name: "a duplicate declaration",
      block: scopeBlock([
        ["TRACKED-TODO", "predeploy_ready"],
        ["TRACKED-ACTIVE", "postdeploy_acceptance"],
        ["TRACKED-ACTIVE", "predeploy_ready"],
      ]),
      expected: /declares a scope for TRACKED-ACTIVE twice \(lines \d+ and \d+\)/,
    },
    {
      name: "a first cell that is not an item key",
      block: scopeBlock([
        ["TRACKED-TODO", "predeploy_ready"],
        ["see the section above", "postdeploy_acceptance"],
      ]),
      expected: /declares a scope for "see the section above", which is not an item key/,
    },
    {
      name: "more than one block",
      block: [
        scopeBlock([["TRACKED-TODO", "predeploy_ready"]]),
        scopeBlock([["TRACKED-ACTIVE", "postdeploy_acceptance"]]),
      ].join("\n"),
      expected: /has 2 "<!-- taskboard-scopes:begin -->" and 2 "<!-- taskboard-scopes:end -->" marker\(s\)/,
    },
  ];

  for (const { name, block, expected } of cases) {
    const board = ["| TRACKED-TODO | TODO |", "| TRACKED-ACTIVE | IN_PROGRESS |", block].join("\n");
    const { result, output } = runFixture(board);
    assert.equal(result.exitCode, 1, `${name} must fail the checker`);
    assert.match(output, expected, name);
    // A malformed block is never treated as "no rule applies": the rows it failed
    // to declare are still gated.
    assert.equal(
      runFixture(board, { requireScope: "predeploy_ready" }).result.exitCode,
      1,
      `${name} must still block the predeploy gate`,
    );
  }
});

test("a well-formed block passes the two-way check and says how many rows it declares", () => {
  const { result, output } = runFixture(`${UNFINISHED_ROWS}\n${ALL_SCOPED}`);
  assert.equal(result.fail, 0);
  assert.match(
    output,
    /PASS every unfinished TASKBOARD row declares exactly one release scope \(5 row\(s\) declared\)/,
  );
});

test("candidate-CI evidence rows cannot be moved back into the candidate's own predeploy scope", () => {
  const manifest = {
    required_jobs: [{ name: "Measured exact-head job" }],
    taskboard_closure_evidence: [
      { item: "SELF-PROVING", evidence: "required_job", job: "Measured exact-head job" },
    ],
  };
  const board = (scope) =>
    [
      "| SELF-PROVING | REVIEW |",
      scopeBlock([["SELF-PROVING", scope, "candidate exact-head CI must be green"]]),
    ].join("\n");

  assert.deepEqual(auditClosureEvidenceModel(board("postdeploy_acceptance"), manifest), []);
  assert.match(
    auditClosureEvidenceModel(board("predeploy_ready"), manifest).join("\n"),
    /must be postdeploy_acceptance.*candidate SHA prove its own future run/,
  );
});

test("every exact-head closure condition is bound to a valid manifest evidence source", () => {
  const board = [
    "| SELF-PROVING | REVIEW |",
    scopeBlock([["SELF-PROVING", "postdeploy_acceptance", "candidate exact-head CI must be green"]]),
  ].join("\n");
  const requiredJobs = [{ name: "Measured exact-head job" }];

  assert.match(
    auditClosureEvidenceModel(board, {
      required_jobs: requiredJobs,
      taskboard_closure_evidence: [
        { item: "SELF-PROVING", evidence: "required_job", job: "Not a required job" },
      ],
    }).join("\n"),
    /names a job that is not required by this manifest/,
  );
  assert.match(
    auditClosureEvidenceModel(board, {
      required_jobs: requiredJobs,
      taskboard_closure_evidence: [{ item: "SOME-OTHER-ROW", evidence: "all_required_jobs" }],
    }).join("\n"),
    /SELF-PROVING.*absent from.*taskboard_closure_evidence/,
  );
});

test("the committed TASKBOARD satisfies the two-way scope check", () => {
  // The gate is only worth having if the real board keeps satisfying it, and this
  // is the case that would have caught the declaration block going stale as rows
  // are closed. Counts are deliberately not pinned — the board changes every day —
  // but the invariants are: no evidence failure, no undeclared row, and every
  // unfinished row attributed to exactly one milestone.
  const messages = [];
  const result = runTaskboardCheck({ projectRoot: ROOT, log: (line) => messages.push(line) });
  const output = messages.join("\n");
  assert.equal(result.fail, 0, output);
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(output, /scope=UNDECLARED/);
  assert.doesNotMatch(output, /declares no release scope/);
  assert.doesNotMatch(output, /which has no unfinished row/);

  const unfinished = Number(/UNFINISHED: (\d+)/.exec(output)?.[1]);
  const scopes = /SCOPES: predeploy_ready=(\d+) postdeploy_acceptance=(\d+)/.exec(output);
  assert.ok(scopes, `the checker must report per-scope counts:\n${output}`);
  assert.equal(
    Number(scopes[1]) + Number(scopes[2]),
    unfinished,
    "every unfinished row must be counted in exactly one milestone",
  );
  // A cleared predeploy milestone is valid while postdeploy acceptance stays open.
  // Prove the canonical scope gate agrees with the count instead of requiring an
  // artificial blocker to remain on the board.
  const predeployMessages = [];
  const predeployResult = runTaskboardCheck({
    projectRoot: ROOT,
    requireScope: "predeploy_ready",
    log: (line) => predeployMessages.push(line),
  });
  assert.equal(
    predeployResult.exitCode,
    Number(scopes[1]) === 0 ? 0 : 1,
    predeployMessages.join("\n"),
  );
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
