/**
 * Prove that a release-final commit closes only the taskboard for an already
 * reviewed and deployed release.
 *
 * The release SHA remains the immutable application/database candidate. The
 * closure SHA is a later commit whose only purpose is to record the production
 * evidence needed to close TASKBOARD.md. A green release-final job at an
 * unrelated commit, at the release commit itself, or after any source change is
 * not evidence for that release.
 *
 * Usage:
 *   node scripts/check-release-closure.mjs \
 *     --release-sha <40-lowercase-hex> \
 *     --closure-sha <40-lowercase-hex> \
 *     --acceptance-digest <64-lowercase-hex> \
 *     [--repo <git-worktree>] \
 *     [--run-id <id> --run-json-file <path> --jobs-json-file <path> \
 *      --workflow-json-file <path> --required-jobs-file <path>]
 *
 * The CLI is read-only. It exits 0 only when both names are existing commits,
 * closure is the single direct child of release, and that commit names exactly
 * one changed path: TASKBOARD.md. That file must contain exactly one marker naming
 * the canonically attested postdeploy bundle digest. Invalid input, an
 * indeterminate Git result, or a failed Git command is a refusal.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RELEASE_CLOSURE_ALLOWED_FILES = Object.freeze(["TASKBOARD.md"]);
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const ACCEPTANCE_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const ACCEPTANCE_MARKER_PATTERN = /<!-- postdeploy-acceptance-sha256:([0-9a-f]{64}) -->/g;
export const TASKBOARD_STATUS = Object.freeze(["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"]);
const UNFINISHED_TASKBOARD_STATUS = new Set(TASKBOARD_STATUS.filter((status) => status !== "DONE"));
export const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function activeSectionBounds(lines) {
  const start = lines.findIndex((line) => line.trim() === "## 活动任务");
  if (start < 0) return { start: -1, end: -1 };
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{2,3}\s/.test(lines[index]) && lines[index].trim() !== "## 活动任务") {
      end = index;
      break;
    }
  }
  return { start, end };
}

function tableCells(line) {
  if (!line.trim().startsWith("|")) return null;
  const cells = line.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  if (cells.length === 0 || cells.every((cell) => /^:?-+:?$/.test(cell))) return null;
  return cells;
}

export function parseActiveTaskRows(taskboardText) {
  if (typeof taskboardText !== "string") return { rows: new Map(), problems: ["TASKBOARD content was not measured"] };
  const lines = taskboardText.split(/\r?\n/);
  const { start, end } = activeSectionBounds(lines);
  if (start < 0) return { rows: new Map(), problems: ["TASKBOARD has no active-task section"] };
  const rows = new Map();
  const problems = [];
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const cells = tableCells(line);
    if (!cells || cells[0] === "TASK_ID") continue;
    if (cells.length !== 4) {
      problems.push(`TASKBOARD active row ${index + 1} must contain exactly TASK_ID, STATUS, OWNER, UPDATED_AT`);
      continue;
    }
    const [id, status, owner, updatedAt] = cells;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(id)) problems.push(`TASKBOARD active row ${index + 1} has an invalid stable item ID`);
    if (!TASKBOARD_STATUS.includes(status)) problems.push(`TASKBOARD item ${id} has unknown status ${JSON.stringify(status)}`);
    if (!owner || !/^\d{4}-\d{2}-\d{2}$/.test(updatedAt)) problems.push(`TASKBOARD item ${id} has invalid owner or update date`);
    if (rows.has(id)) problems.push(`TASKBOARD item ${id} appears more than once in the active-task section`);
    else rows.set(id, { id, status, owner, updatedAt, line: index + 1 });
  }
  if (rows.size === 0) problems.push("TASKBOARD active-task section contains no stable item rows");
  return { rows, problems };
}

function historicalTableRows(taskboardText) {
  if (typeof taskboardText !== "string") return [];
  const lines = taskboardText.split(/\r?\n/);
  const { start, end } = activeSectionBounds(lines);
  return lines.flatMap((line, index) => {
    if (start >= 0 && index >= start && index < end) return [];
    const cells = tableCells(line);
    if (!cells || /^(?:TASK_ID|item|#|里程碑|File)$/i.test(cells[0])) return [];
    return [line];
  });
}

function isHistoricalStatusOnlyClosure(beforeLine, afterLine) {
  const before = tableCells(beforeLine);
  const after = tableCells(afterLine);
  if (!before || !after || before.length !== after.length || before[0] !== after[0]) return false;
  const changed = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) changed.push(index);
  }
  if (changed.length !== 1) return false;
  const index = changed[0];
  const previousStatus = before[index].replace(/^⚠️\s*/u, "");
  return UNFINISHED_TASKBOARD_STATUS.has(previousStatus) && after[index] === "DONE";
}

function auditAppendOnlyTaskboardShape(releaseText, closureText) {
  if (typeof releaseText !== "string" || typeof closureText !== "string") return [];
  const releaseLines = releaseText.replaceAll("\r\n", "\n").split("\n");
  const closureLines = closureText.replaceAll("\r\n", "\n").split("\n");
  const releaseBounds = activeSectionBounds(releaseLines);
  const closureBounds = activeSectionBounds(closureLines);
  const problems = [];
  if (releaseBounds.start < 0 || closureBounds.start < 0) return problems;

  if (JSON.stringify(releaseLines.slice(0, releaseBounds.start + 1)) !== JSON.stringify(closureLines.slice(0, closureBounds.start + 1))) {
    problems.push("closure TASKBOARD rewrote content before the active-task table");
  }

  const releaseActive = releaseLines.slice(releaseBounds.start + 1, releaseBounds.end);
  const closureActive = closureLines.slice(closureBounds.start + 1, closureBounds.end);
  if (releaseActive.length !== closureActive.length) {
    problems.push("closure TASKBOARD inserted, deleted, or reordered active-task table lines");
  } else {
    for (let index = 0; index < releaseActive.length; index += 1) {
      const beforeCells = tableCells(releaseActive[index]);
      const afterCells = tableCells(closureActive[index]);
      const activeDataRow = beforeCells?.length === 4
        && beforeCells[0] !== "TASK_ID"
        && TASKBOARD_STATUS.includes(beforeCells[1]);
      if (!activeDataRow) {
        if (releaseActive[index] !== closureActive[index]) {
          problems.push(`closure TASKBOARD rewrote non-item active-section line ${releaseBounds.start + index + 2}`);
        }
        continue;
      }
      if (!afterCells || afterCells.length !== 4 || afterCells[0] !== beforeCells[0] || afterCells[2] !== beforeCells[2]) {
        problems.push(`closure TASKBOARD rewrote stable identity columns for ${beforeCells[0]}`);
      }
    }
  }

  const releaseHistory = releaseLines.slice(releaseBounds.end);
  const closureHistory = closureLines.slice(closureBounds.end);
  const historyPrefixIsValid = closureHistory.length >= releaseHistory.length
    && releaseHistory.every((line, index) => (
      closureHistory[index] === line || isHistoricalStatusOnlyClosure(line, closureHistory[index])
    ));
  if (!historyPrefixIsValid) {
    problems.push("closure TASKBOARD must preserve all historical headings, prose, tables, order, and section ownership exactly");
  } else {
    const appended = closureHistory.slice(releaseHistory.length).join("\n");
    const appendedMarkers = [...appended.matchAll(ACCEPTANCE_MARKER_PATTERN)];
    if (appendedMarkers.length !== 1) {
      problems.push("closure TASKBOARD acceptance evidence must be appended after all release history");
    }
  }
  if ([...releaseText.matchAll(ACCEPTANCE_MARKER_PATTERN)].length !== 0) {
    problems.push("release TASKBOARD already contains a postdeploy acceptance digest marker");
  }
  return problems;
}

export function auditTaskboardClosureTransition(releaseText, closureText) {
  const release = parseActiveTaskRows(releaseText);
  const closure = parseActiveTaskRows(closureText);
  const problems = [...release.problems.map((problem) => `release ${problem}`), ...closure.problems.map((problem) => `closure ${problem}`)];
  const releaseOrder = [...release.rows.keys()];
  const closureOrder = [...closure.rows.keys()];
  if (JSON.stringify(releaseOrder) !== JSON.stringify(closureOrder)) {
    problems.push("closure TASKBOARD must preserve the exact stable-item order and set from the release");
  }
  for (const [id, before] of release.rows) {
    const after = closure.rows.get(id);
    if (!after) {
      problems.push(`closure TASKBOARD deleted or renamed stable item ${id}`);
      continue;
    }
    if (after.owner !== before.owner) problems.push(`closure TASKBOARD changed owner for stable item ${id}`);
    if (after.status !== "DONE") problems.push(`closure TASKBOARD item ${id} is not DONE`);
    if (before.status === "DONE" && after.updatedAt !== before.updatedAt) {
      problems.push(`closure TASKBOARD rewrote the completed historical row for ${id}`);
    }
    if (before.status !== "DONE" && after.updatedAt < before.updatedAt) {
      problems.push(`closure TASKBOARD moved the update date backwards for ${id}`);
    }
  }
  for (const id of closure.rows.keys()) {
    if (!release.rows.has(id)) problems.push(`closure TASKBOARD introduced unknown stable item ${id}`);
  }
  const closureHistoricalRows = historicalTableRows(closureText);
  const matchedClosureRows = new Set();
  for (const row of historicalTableRows(releaseText)) {
    const match = closureHistoricalRows.findIndex((candidate, index) => (
      !matchedClosureRows.has(index)
      && (candidate === row || isHistoricalStatusOnlyClosure(row, candidate))
    ));
    if (match < 0) problems.push(`closure TASKBOARD deleted or rewrote historical table row ${JSON.stringify(tableCells(row))}`);
    else matchedClosureRows.add(match);
  }
  problems.push(...auditAppendOnlyTaskboardShape(releaseText, closureText));
  return problems;
}

/**
 * Pure judgement for unit tests and independent negative controls.
 *
 * `isAncestor` and `changedFiles` must be measured by the caller. Returning a
 * list, rather than a boolean, makes every refusal reproducible while keeping an
 * empty list as the sole passing state.
 */
export function auditReleaseClosure({
  releaseSha,
  closureSha,
  acceptanceDigest,
  isAncestor,
  directParent,
  commitCount,
  perCommitChangedFiles,
  changedFiles,
  releaseTaskboardText,
  taskboardText,
}) {
  const problems = [];
  const release = String(releaseSha ?? "");
  const closure = String(closureSha ?? "");

  if (!FULL_SHA_PATTERN.test(release)) {
    problems.push("release SHA must be exactly 40 lowercase hexadecimal characters");
  }
  if (!FULL_SHA_PATTERN.test(closure)) {
    problems.push("closure SHA must be exactly 40 lowercase hexadecimal characters");
  }
  const digest = String(acceptanceDigest ?? "");
  if (!ACCEPTANCE_DIGEST_PATTERN.test(digest)) {
    problems.push("acceptance digest must be exactly 64 lowercase hexadecimal characters");
  }

  if (typeof isAncestor !== "boolean") {
    problems.push("release ancestry was not measured as a boolean");
  } else if (!isAncestor) {
    problems.push("release SHA is not an ancestor of closure SHA");
  }
  if (directParent !== release) problems.push("closure SHA must be the single direct child of the release SHA");
  if (commitCount !== 1) problems.push("release-to-closure range must contain exactly one commit");
  if (!Array.isArray(perCommitChangedFiles) || perCommitChangedFiles.length !== 1) {
    problems.push("closure commit changed-file inventory was not measured exactly once");
  } else if (
    perCommitChangedFiles[0].length !== 1
    || perCommitChangedFiles[0][0] !== "TASKBOARD.md"
  ) {
    problems.push("the closure commit itself must change exactly TASKBOARD.md");
  }

  if (!Array.isArray(changedFiles)) {
    problems.push("release-to-closure changed files were not measured as an array");
    return problems;
  }

  if (changedFiles.length === 0) {
    problems.push("release-to-closure diff is empty");
  }

  const unexpected = changedFiles.filter(
    (file) => typeof file !== "string" || !RELEASE_CLOSURE_ALLOWED_FILES.includes(file),
  );
  if (unexpected.length > 0) {
    const printable = unexpected.map((file) => JSON.stringify(file)).join(", ");
    problems.push(`release-to-closure diff contains files other than TASKBOARD.md: ${printable}`);
  }

  if (typeof taskboardText !== "string") {
    problems.push("closure TASKBOARD.md content was not measured");
  } else {
    const markers = [...taskboardText.matchAll(ACCEPTANCE_MARKER_PATTERN)].map((match) => match[1]);
    if (markers.length !== 1) {
      problems.push(`closure TASKBOARD.md must contain exactly one postdeploy acceptance digest marker (found ${markers.length})`);
    } else if (markers[0] !== digest) {
      problems.push("closure TASKBOARD.md acceptance digest does not match the attested bundle");
    }
  }
  problems.push(...auditTaskboardClosureTransition(releaseTaskboardText, taskboardText));

  return problems;
}

/**
 * Pure judgement over the GitHub run used to close a release.
 *
 * This is deliberately a second claim from the release-candidate run. The run
 * and every required job are bound to `closureSha`; `releaseSha` is bound by the
 * release-to-closure judgement above and by the workflow step that invokes it.
 */
function timestampMillis(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return null;
  const measured = Date.parse(value);
  return Number.isFinite(measured) ? measured : null;
}

export function auditFinalRequiredRun({ closureSha, runId, run, jobsResponse, manifest, workflow, now = new Date() }) {
  const problems = [];
  const refuse = (message) => problems.push(message);
  const closure = String(closureSha ?? "");
  const expectedRun = String(runId ?? "");

  if (!FULL_SHA_PATTERN.test(closure)) {
    refuse("final run closure SHA must be exactly 40 lowercase hexadecimal characters");
  }
  if (!/^[1-9][0-9]*$/.test(expectedRun)) {
    refuse("final run ID must be a positive numeric GitHub Actions run ID");
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    refuse("final-required-jobs manifest is not an object");
    return problems;
  }
  const required = manifest.required_jobs;
  const tolerated = manifest.tolerated_conclusions;
  if (!Array.isArray(required) || required.length === 0) {
    refuse("final-required-jobs manifest lists no jobs");
  }
  if (JSON.stringify(tolerated) !== JSON.stringify(["success"])) {
    refuse("final-required-jobs manifest must tolerate only success");
  }
  if (manifest.workflow_path !== ".github/workflows/ci.yml") {
    refuse("final-required-jobs manifest must pin .github/workflows/ci.yml");
  }
  if (manifest.workflow_id !== 310914082) {
    refuse("final-required-jobs manifest must pin workflow_id 310914082");
  }
  if (!Number.isInteger(manifest.max_run_age_seconds) || manifest.max_run_age_seconds < 1 || manifest.max_run_age_seconds > 86400) {
    refuse("final-required-jobs manifest freshness SLO must be between 1 and 86400 seconds");
  }

  const requiredNames = [];
  if (Array.isArray(required)) {
    for (const entry of required) {
      const name = entry && typeof entry === "object" ? entry.name : null;
      if (typeof name !== "string" || name.length === 0) {
        refuse("final-required-jobs manifest has an entry without a job name");
      } else {
        requiredNames.push(name);
      }
    }
    if (new Set(requiredNames).size !== requiredNames.length) {
      refuse("final-required-jobs manifest lists a job twice");
    }
  }

  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    refuse("canonical workflow endpoint payload is not an object");
  } else {
    if (workflow.id !== manifest.workflow_id) refuse("canonical workflow endpoint returned a different workflow_id");
    if (workflow.path !== manifest.workflow_path) refuse("canonical workflow endpoint returned a different workflow path");
    if (workflow.name !== manifest.workflow) refuse("canonical workflow endpoint returned a different workflow name");
    if (workflow.state !== "active") refuse("canonical workflow endpoint is not active");
  }

  const nowMs = now instanceof Date ? now.getTime() : timestampMillis(now);
  if (!Number.isFinite(nowMs)) refuse("final CI freshness reference time is invalid");
  let runUpdatedMs = null;
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    refuse("final GitHub run payload is not an object");
  } else {
    if (String(run.id ?? "") !== expectedRun) refuse("final run is not the run ID named by the operator");
    if (run.head_sha !== closure) refuse("final run head_sha is not the closure SHA");
    if (run.name !== manifest.workflow) refuse("final run used a different workflow");
    if (run.path !== manifest.workflow_path) refuse("final run used a different workflow path");
    if (run.workflow_id !== manifest.workflow_id) refuse("final run used a different workflow_id");
    if (run.status !== "completed") refuse("final run has not completed");
    if (run.conclusion !== "success") refuse("final run did not conclude success");
    if (run.event !== manifest.event) refuse("final run used a different event");
    if (run.head_branch !== manifest.head_branch) refuse("final run is not from the required branch");
    const createdMs = timestampMillis(run.created_at);
    const startedMs = timestampMillis(run.run_started_at);
    runUpdatedMs = timestampMillis(run.updated_at);
    if (createdMs === null || startedMs === null || runUpdatedMs === null) {
      refuse("final run timestamps are missing or invalid UTC timestamps");
    } else if (!(createdMs <= startedMs && startedMs <= runUpdatedMs)) {
      refuse("final run timestamps are not ordered created_at <= run_started_at <= updated_at");
    } else if (Number.isFinite(nowMs) && (runUpdatedMs > nowMs || nowMs - runUpdatedMs > manifest.max_run_age_seconds * 1000)) {
      refuse("final run completion is outside the manifest freshness SLO");
    }
  }

  const jobs = jobsResponse?.jobs;
  const total = jobsResponse?.total_count;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    refuse("final run reported no jobs");
    return problems;
  }
  if (!Number.isInteger(total) || total !== jobs.length) {
    refuse(`final job list is incomplete (${String(jobs.length)} of ${String(total)} returned)`);
  }

  const seen = new Set();
  for (const job of jobs) {
    const name = job && typeof job === "object" ? job.name : null;
    if (typeof name !== "string" || name.length === 0) {
      refuse("a job in the final run has no name");
      continue;
    }
    if (job.head_sha !== undefined && job.head_sha !== null && job.head_sha !== closure) {
      refuse(`final job ${JSON.stringify(name)} ran against a different commit`);
    }
    if (requiredNames.includes(name)) {
      if (seen.has(name)) {
        refuse(`required final job ${JSON.stringify(name)} appears twice`);
        continue;
      }
      seen.add(name);
      if (job.status !== "completed") refuse(`required final job ${JSON.stringify(name)} has not completed`);
      if (job.conclusion !== "success") {
        refuse(`required final job ${JSON.stringify(name)} concluded ${JSON.stringify(job.conclusion ?? null)}`);
      }
      const jobStartedMs = timestampMillis(job.started_at);
      const jobCompletedMs = timestampMillis(job.completed_at);
      if (jobStartedMs === null || jobCompletedMs === null || jobStartedMs > jobCompletedMs) {
        refuse(`required final job ${JSON.stringify(name)} has invalid or unordered timestamps`);
      } else {
        if (runUpdatedMs !== null && jobCompletedMs > runUpdatedMs) {
          refuse(`required final job ${JSON.stringify(name)} completed after the run update timestamp`);
        }
        if (Number.isFinite(nowMs) && (jobCompletedMs > nowMs || nowMs - jobCompletedMs > manifest.max_run_age_seconds * 1000)) {
          refuse(`required final job ${JSON.stringify(name)} completion is outside the manifest freshness SLO`);
        }
      }
    } else if (!["success", "skipped"].includes(job.conclusion)) {
      refuse(`non-required final job ${JSON.stringify(name)} concluded ${JSON.stringify(job.conclusion ?? null)}`);
    }
  }

  const missing = requiredNames.filter((name) => !seen.has(name));
  if (missing.length > 0) refuse(`required final job(s) absent from the run: ${missing.join(", ")}`);

  return problems;
}

function parseArgs(argv) {
  const values = new Map();
  const finalRunFlags = ["--run-id", "--run-json-file", "--jobs-json-file", "--workflow-json-file", "--required-jobs-file"];
  const allowed = new Set(["--release-sha", "--closure-sha", "--acceptance-digest", "--repo", ...finalRunFlags]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag)) {
      throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
    if (values.has(flag)) {
      throw new Error(`argument ${flag} was provided more than once`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`argument ${flag} requires a value`);
    }
    values.set(flag, value);
    index += 1;
  }

  for (const required of ["--release-sha", "--closure-sha", "--acceptance-digest"]) {
    if (!values.has(required)) throw new Error(`missing required argument ${required}`);
  }

  const presentFinalFlags = finalRunFlags.filter((flag) => values.has(flag));
  if (presentFinalFlags.length !== 0 && presentFinalFlags.length !== finalRunFlags.length) {
    const missing = finalRunFlags.filter((flag) => !values.has(flag));
    throw new Error(`final run verification requires all five flags; missing ${missing.join(", ")}`);
  }

  return {
    releaseSha: values.get("--release-sha"),
    closureSha: values.get("--closure-sha"),
    acceptanceDigest: values.get("--acceptance-digest"),
    repo: path.resolve(values.get("--repo") ?? process.cwd()),
    finalRun: presentFinalFlags.length === 0
      ? null
      : {
          runId: values.get("--run-id"),
          runJsonFile: path.resolve(values.get("--run-json-file")),
          jobsJsonFile: path.resolve(values.get("--jobs-json-file")),
          workflowJsonFile: path.resolve(values.get("--workflow-json-file")),
          requiredJobsFile: path.resolve(values.get("--required-jobs-file")),
        },
  };
}

function runGit(repo, args, { allowStatusOne = false, nulOutput = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`could not execute git ${args[0]}: ${result.error.message}`);
  }
  if (result.status === 0 || (allowStatusOne && result.status === 1)) {
    if (!nulOutput) return { status: result.status, stdout: result.stdout };
    return {
      status: result.status,
      stdout: result.stdout === "" ? [] : result.stdout.split("\0").filter((entry) => entry !== ""),
    };
  }
  throw new Error(`git ${args[0]} could not establish the release-closure claim (exit ${String(result.status)})`);
}

function requireCommit(repo, sha, label) {
  const result = spawnSync("git", ["-C", repo, "cat-file", "-e", `${sha}^{commit}`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not execute git cat-file: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} SHA is not an existing commit in the repository`);
}

/** Execute the read-only Git measurements used by the CLI. */
export function inspectReleaseClosure({ releaseSha, closureSha, repo = process.cwd() }) {
  const resolvedRepo = path.resolve(repo);
  requireCommit(resolvedRepo, releaseSha, "release");
  requireCommit(resolvedRepo, closureSha, "closure");

  const ancestry = runGit(
    resolvedRepo,
    ["merge-base", "--is-ancestor", releaseSha, closureSha],
    { allowStatusOne: true },
  );
  const diff = runGit(
    resolvedRepo,
    ["diff", "--name-only", "--no-renames", "-z", releaseSha, closureSha, "--"],
    { nulOutput: true },
  );
  const taskboard = runGit(resolvedRepo, ["show", `${closureSha}:TASKBOARD.md`]);
  const releaseTaskboard = runGit(resolvedRepo, ["show", `${releaseSha}:TASKBOARD.md`]);
  const parents = runGit(resolvedRepo, ["rev-list", "--parents", "-n", "1", closureSha]).stdout.trim().split(/\s+/);
  const countText = runGit(resolvedRepo, ["rev-list", "--count", `${releaseSha}..${closureSha}`]).stdout.trim();
  const commitDiff = runGit(
    resolvedRepo,
    ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", closureSha, "--"],
    { nulOutput: true },
  );

  return {
    isAncestor: ancestry.status === 0,
    directParent: parents.length === 2 ? parents[1] : null,
    commitCount: /^\d+$/.test(countText) ? Number(countText) : null,
    perCommitChangedFiles: [commitDiff.stdout],
    changedFiles: diff.stdout,
    releaseTaskboardText: releaseTaskboard.stdout,
    taskboardText: taskboard.stdout,
  };
}

export function main(argv = process.argv.slice(2)) {
  let claim;
  try {
    claim = parseArgs(argv);
  } catch (error) {
    console.error(`release closure: ${error.message}`);
    console.error(
      "Usage: node scripts/check-release-closure.mjs --release-sha <40hex> --closure-sha <40hex> --acceptance-digest <64hex> [--repo <path>] [--run-id <id> --run-json-file <path> --jobs-json-file <path> --workflow-json-file <path> --required-jobs-file <path>]",
    );
    return 64;
  }

  const shapeProblems = [];
  if (!FULL_SHA_PATTERN.test(claim.releaseSha)) shapeProblems.push("release SHA must be exactly 40 lowercase hexadecimal characters");
  if (!FULL_SHA_PATTERN.test(claim.closureSha)) shapeProblems.push("closure SHA must be exactly 40 lowercase hexadecimal characters");
  if (!ACCEPTANCE_DIGEST_PATTERN.test(claim.acceptanceDigest)) shapeProblems.push("acceptance digest must be exactly 64 lowercase hexadecimal characters");
  if (shapeProblems.length > 0) {
    for (const problem of shapeProblems) console.error(`release closure: ${problem}`);
    console.error(`release closure: refusing ${shapeProblems.length} invalid SHA value(s)`);
    return 1;
  }

  try {
    const measured = inspectReleaseClosure(claim);
    const problems = auditReleaseClosure({ ...claim, ...measured });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`release closure: ${problem}`);
      console.error(`release closure: refusing ${problems.length} problem(s)`);
      return 1;
    }

    if (claim.finalRun) {
      let run;
      let jobsResponse;
      let workflow;
      let manifest;
      try {
        run = JSON.parse(readFileSync(claim.finalRun.runJsonFile, "utf8"));
        jobsResponse = JSON.parse(readFileSync(claim.finalRun.jobsJsonFile, "utf8"));
        workflow = JSON.parse(readFileSync(claim.finalRun.workflowJsonFile, "utf8"));
        manifest = JSON.parse(readFileSync(claim.finalRun.requiredJobsFile, "utf8"));
      } catch (error) {
        console.error(`release closure: final run evidence could not be read as JSON (${error.message})`);
        console.error("release closure: refusing because final CI evidence is indeterminate");
        return 1;
      }
      const finalProblems = auditFinalRequiredRun({
        closureSha: claim.closureSha,
        runId: claim.finalRun.runId,
        run,
        jobsResponse,
        workflow,
        manifest,
      });
      if (finalProblems.length > 0) {
        for (const problem of finalProblems) console.error(`release closure: ${problem}`);
        console.error(`release closure: refusing ${finalProblems.length} final CI problem(s)`);
        return 1;
      }
      console.log(`release closure: final CI run ${claim.finalRun.runId} is green at closure SHA`);
    }
    console.log(`release closure: OK release=${claim.releaseSha} closure=${claim.closureSha}`);
    console.log(`release closure: acceptance=${claim.acceptanceDigest}`);
    console.log("release closure: changed files (1): TASKBOARD.md");
    return 0;
  } catch (error) {
    console.error(`release closure: ${error.message}`);
    console.error("release closure: refusing because the Git claim could not be established");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
