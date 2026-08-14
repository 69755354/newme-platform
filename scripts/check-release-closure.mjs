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
 *     [--repo <git-worktree>] \
 *     [--run-id <id> --run-json-file <path> --jobs-json-file <path> \
 *      --required-jobs-file <path>]
 *
 * The CLI is read-only. It exits 0 only when both names are existing commits,
 * release is an ancestor of closure, and their non-empty diff names exactly one
 * allowed path: TASKBOARD.md. Invalid input, an indeterminate Git result, or a
 * failed Git command is a refusal.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RELEASE_CLOSURE_ALLOWED_FILES = Object.freeze(["TASKBOARD.md"]);
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Pure judgement for unit tests and independent negative controls.
 *
 * `isAncestor` and `changedFiles` must be measured by the caller. Returning a
 * list, rather than a boolean, makes every refusal reproducible while keeping an
 * empty list as the sole passing state.
 */
export function auditReleaseClosure({ releaseSha, closureSha, isAncestor, changedFiles }) {
  const problems = [];
  const release = String(releaseSha ?? "");
  const closure = String(closureSha ?? "");

  if (!FULL_SHA_PATTERN.test(release)) {
    problems.push("release SHA must be exactly 40 lowercase hexadecimal characters");
  }
  if (!FULL_SHA_PATTERN.test(closure)) {
    problems.push("closure SHA must be exactly 40 lowercase hexadecimal characters");
  }

  if (typeof isAncestor !== "boolean") {
    problems.push("release ancestry was not measured as a boolean");
  } else if (!isAncestor) {
    problems.push("release SHA is not an ancestor of closure SHA");
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

  return problems;
}

/**
 * Pure judgement over the GitHub run used to close a release.
 *
 * This is deliberately a second claim from the release-candidate run. The run
 * and every required job are bound to `closureSha`; `releaseSha` is bound by the
 * release-to-closure judgement above and by the workflow step that invokes it.
 */
export function auditFinalRequiredRun({ closureSha, runId, run, jobsResponse, manifest }) {
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

  if (!run || typeof run !== "object" || Array.isArray(run)) {
    refuse("final GitHub run payload is not an object");
  } else {
    if (String(run.id ?? "") !== expectedRun) refuse("final run is not the run ID named by the operator");
    if (run.head_sha !== closure) refuse("final run head_sha is not the closure SHA");
    if (run.name !== manifest.workflow) refuse("final run used a different workflow");
    if (run.status !== "completed") refuse("final run has not completed");
    if (run.conclusion !== "success") refuse("final run did not conclude success");
    if (run.event !== manifest.event) refuse("final run used a different event");
    if (run.head_branch !== manifest.head_branch) refuse("final run is not from the required branch");
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
  const finalRunFlags = ["--run-id", "--run-json-file", "--jobs-json-file", "--required-jobs-file"];
  const allowed = new Set(["--release-sha", "--closure-sha", "--repo", ...finalRunFlags]);

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

  for (const required of ["--release-sha", "--closure-sha"]) {
    if (!values.has(required)) throw new Error(`missing required argument ${required}`);
  }

  const presentFinalFlags = finalRunFlags.filter((flag) => values.has(flag));
  if (presentFinalFlags.length !== 0 && presentFinalFlags.length !== finalRunFlags.length) {
    const missing = finalRunFlags.filter((flag) => !values.has(flag));
    throw new Error(`final run verification requires all four flags; missing ${missing.join(", ")}`);
  }

  return {
    releaseSha: values.get("--release-sha"),
    closureSha: values.get("--closure-sha"),
    repo: path.resolve(values.get("--repo") ?? process.cwd()),
    finalRun: presentFinalFlags.length === 0
      ? null
      : {
          runId: values.get("--run-id"),
          runJsonFile: path.resolve(values.get("--run-json-file")),
          jobsJsonFile: path.resolve(values.get("--jobs-json-file")),
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

  return {
    isAncestor: ancestry.status === 0,
    changedFiles: diff.stdout,
  };
}

export function main(argv = process.argv.slice(2)) {
  let claim;
  try {
    claim = parseArgs(argv);
  } catch (error) {
    console.error(`release closure: ${error.message}`);
    console.error(
      "Usage: node scripts/check-release-closure.mjs --release-sha <40hex> --closure-sha <40hex> [--repo <path>] [--run-id <id> --run-json-file <path> --jobs-json-file <path> --required-jobs-file <path>]",
    );
    return 64;
  }

  const shapeProblems = auditReleaseClosure({
    releaseSha: claim.releaseSha,
    closureSha: claim.closureSha,
    isAncestor: true,
    changedFiles: ["TASKBOARD.md"],
  }).filter((problem) => problem.includes("SHA must be"));
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
      let manifest;
      try {
        run = JSON.parse(readFileSync(claim.finalRun.runJsonFile, "utf8"));
        jobsResponse = JSON.parse(readFileSync(claim.finalRun.jobsJsonFile, "utf8"));
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
