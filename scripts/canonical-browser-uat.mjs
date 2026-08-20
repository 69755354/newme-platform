#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import { verifyPostdeployArtifactReceipt } from "./postdeploy-receipt.mjs";

export const BROWSER_INPUT_VERSION = "newme-postdeploy-browser-uat-input/v1";
export const BROWSER_OUTPUT_VERSION = "newme-postdeploy-browser-uat-output/v1";
export const BROWSER_RUNNER = "newme-postdeploy-browser-uat/v1";
export const BROWSER_RUNNER_PATH = "scripts/run-postdeploy-browser-uat.mjs";
export const PLAYWRIGHT_IMAGE = "mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948";
export const BROWSER_NAME = "chromium";
export const BROWSER_VERSION = "148.0.7778.96";
export const REQUIRED_ROLES = Object.freeze(["admin", "boss", "operator", "sales"]);
export const REQUIRED_LOCALES = Object.freeze(["en", "zh"]);

const DOCKER_BIN = "/usr/bin/docker";
const WORK_ROOT = "/var/lib/newme/postdeploy-browser-uat-v1";
const CONTAINER_EVIDENCE_PARENT = "/evidence";
const CONTAINER_ARTIFACT_ROOT = "/evidence/output";
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;
const CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIXTURE_MARKER = /^postdeploy-uat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTRACT_NO = /^UAT-C-[0-9a-f]{8}$/;
const DOCKER_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/root", LANG: "C.UTF-8" });

class BrowserProducerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function refuse(code) {
  throw new BrowserProducerError(code);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, code) {
  if (!isObject(value)) refuse(code);
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) refuse(code);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fsyncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureRootDirectory(directory) {
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== 0
    || metadata.gid !== 0
    || (metadata.mode & 0o777) !== 0o700
  ) refuse("browser_work_root_untrusted");
  return directory;
}

function expectedRepoDigest(reference) {
  const at = reference.lastIndexOf("@");
  if (at < 1) refuse("browser_image_reference_invalid");
  const tagged = reference.slice(0, at);
  const digest = reference.slice(at + 1);
  const slash = tagged.lastIndexOf("/");
  const colon = tagged.lastIndexOf(":");
  const repository = colon > slash ? tagged.slice(0, colon) : tagged;
  return `${repository}@${digest}`;
}

function dockerOutput(args, maximumBytes = 64 * 1024) {
  try {
    return execFileSync(DOCKER_BIN, args, {
      encoding: "utf8",
      env: DOCKER_ENV,
      maxBuffer: maximumBytes,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch {
    refuse("browser_runtime_unavailable");
  }
}

export function inspectCanonicalBrowserRuntime(releaseRoot) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) {
    refuse("browser_runtime_requires_posix_root");
  }
  if (realpathSync(releaseRoot) !== releaseRoot) refuse("browser_release_root_untrusted");
  const releaseMetadata = lstatSync(releaseRoot);
  if (
    !releaseMetadata.isDirectory()
    || releaseMetadata.isSymbolicLink()
    || releaseMetadata.uid !== 0
    || (releaseMetadata.mode & 0o027) !== 0
  ) refuse("browser_release_root_untrusted");
  let repoDigests;
  try {
    repoDigests = JSON.parse(dockerOutput(["image", "inspect", "--format", "{{json .RepoDigests}}", PLAYWRIGHT_IMAGE]));
  } catch {
    refuse("browser_image_not_prepared");
  }
  if (!Array.isArray(repoDigests) || !repoDigests.includes(expectedRepoDigest(PLAYWRIGHT_IMAGE))) {
    refuse("browser_image_digest_unverified");
  }
  const identityArgs = [
    "run", "--rm", "--pull=never", "--network=none", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--entrypoint", "/usr/bin/id", PLAYWRIGHT_IMAGE,
  ];
  const uid = Number(dockerOutput([...identityArgs, "-u", "pwuser"], 1024));
  const gid = Number(dockerOutput([...identityArgs, "-g", "pwuser"], 1024));
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid <= 0) refuse("browser_image_user_invalid");
  if (!Number.isSafeInteger(releaseMetadata.gid) || releaseMetadata.gid <= 0) {
    refuse("browser_release_group_invalid");
  }
  return { uid, gid, releaseGid: releaseMetadata.gid };
}

function canonicalRelativePath(value, code) {
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 1024
    || value.includes("\\")
    || value.startsWith("/")
    || path.posix.normalize(value) !== value
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) refuse(code);
  return value;
}

function readContainerFile(root, relativePath, identity, code) {
  const relative = canonicalRelativePath(relativePath, code);
  const absolute = path.join(root, ...relative.split("/"));
  const metadata = lstatSync(absolute);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== identity.uid
    || metadata.gid !== identity.gid
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size <= 0
    || metadata.size > 16 * 1024 * 1024
  ) refuse(code);
  return readFileSync(absolute);
}

function walkContainerEvidence(root, identity) {
  const files = [];
  let totalBytes = 0;
  const visit = (directory, prefix) => {
    const directoryMetadata = lstatSync(directory);
    if (
      !directoryMetadata.isDirectory()
      || directoryMetadata.isSymbolicLink()
      || directoryMetadata.uid !== identity.uid
      || directoryMetadata.gid !== identity.gid
      || (directoryMetadata.mode & 0o777) !== 0o700
    ) refuse("browser_evidence_tree_untrusted");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) refuse("browser_evidence_tree_untrusted");
      if (metadata.isDirectory()) {
        visit(absolute, relative);
      } else if (metadata.isFile()) {
        if (metadata.uid !== identity.uid || metadata.gid !== identity.gid || (metadata.mode & 0o777) !== 0o600 || metadata.size <= 0) {
          refuse("browser_evidence_tree_untrusted");
        }
        totalBytes += metadata.size;
        if (totalBytes > MAX_EVIDENCE_BYTES) refuse("browser_evidence_too_large");
        files.push(canonicalRelativePath(relative, "browser_evidence_path_invalid"));
      } else {
        refuse("browser_evidence_tree_untrusted");
      }
    }
  };
  visit(root, "");
  return files;
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch {
    refuse(code);
  }
}

export function collectCanonicalBrowserEvidence({
  output,
  artifactRoot,
  identity,
  release,
  actorIds,
  fixture,
  receiptPublicKeyBytes,
  runnerSourceSha256,
}) {
  exactKeys(output, [
    "output_version", "status", "release", "artifact_directory", "runner_source", "playwright_image",
    "browser_name", "browser_version", "viewport", "sessions", "artifacts", "completed_at",
  ], "browser_output_shape_invalid");
  if (
    output.output_version !== BROWSER_OUTPUT_VERSION
    || output.status !== "pass"
    || output.artifact_directory !== CONTAINER_ARTIFACT_ROOT
    || output.playwright_image !== PLAYWRIGHT_IMAGE
    || output.browser_name !== BROWSER_NAME
    || output.browser_version !== BROWSER_VERSION
  ) refuse("browser_output_identity_invalid");
  exactKeys(output.release, ["git_sha", "build_id", "deploy_run_id", "deployed_at"], "browser_output_release_invalid");
  if (
    output.release.git_sha !== release.git_sha
    || output.release.build_id !== release.build_id
    || output.release.deploy_run_id !== release.deploy_run_id
    || output.release.deployed_at !== release.deployed_at
  ) refuse("browser_output_release_invalid");
  exactKeys(output.runner_source, ["path", "sha256"], "browser_output_runner_invalid");
  if (output.runner_source.path !== BROWSER_RUNNER_PATH || output.runner_source.sha256 !== runnerSourceSha256) {
    refuse("browser_output_runner_invalid");
  }
  exactKeys(output.viewport, ["width", "height"], "browser_output_viewport_invalid");
  if (output.viewport.width !== 1440 || output.viewport.height !== 900) refuse("browser_output_viewport_invalid");
  if (!Array.isArray(output.sessions) || output.sessions.length !== 8 || !Array.isArray(output.artifacts) || output.artifacts.length !== 8) {
    refuse("browser_output_cardinality_invalid");
  }
  const documents = new Map();
  const expectedPaths = new Set();
  for (let index = 0; index < output.sessions.length; index += 1) {
    const role = REQUIRED_ROLES[Math.floor(index / REQUIRED_LOCALES.length)];
    const locale = REQUIRED_LOCALES[index % REQUIRED_LOCALES.length];
    const session = output.sessions[index];
    const artifact = output.artifacts[index];
    const artifactId = `browser_${role}_${locale}`;
    exactKeys(session, ["role", "actor_id", "locale", "subject", "status", "completed_at", "artifact_id"], "browser_session_invalid");
    exactKeys(artifact, ["id", "kind", "path", "sha256", "media_type"], "browser_artifact_invalid");
    if (
      session.role !== role
      || session.actor_id !== actorIds[role]
      || session.locale !== locale
      || session.status !== "pass"
      || session.artifact_id !== artifactId
      || artifact.id !== artifactId
      || artifact.kind !== "browser_uat"
      || artifact.path !== `${role}/${locale}/artifact.json`
      || !SHA256.test(artifact.sha256 ?? "")
      || artifact.media_type !== "application/json"
    ) refuse("browser_artifact_invalid");
    exactKeys(session.subject, ["lead_id", "contract_id", "marker_sha256"], "browser_subject_invalid");
    if (
      session.subject.lead_id !== fixture.lead_id
      || session.subject.contract_id !== fixture.contract_id
      || session.subject.marker_sha256 !== sha256(fixture.marker)
    ) refuse("browser_subject_invalid");
    const artifactBytes = readContainerFile(artifactRoot, artifact.path, identity, "browser_artifact_file_invalid");
    if (sha256(artifactBytes) !== artifact.sha256) refuse("browser_artifact_digest_invalid");
    const document = parseJson(artifactBytes, "browser_artifact_json_invalid");
    try {
      verifyPostdeployArtifactReceipt({ document, publicKeyBytes: receiptPublicKeyBytes, expectedProducer: BROWSER_RUNNER });
    } catch {
      refuse("browser_artifact_receipt_invalid");
    }
    if (
      document.kind !== "browser_uat"
      || document.release?.git_sha !== release.git_sha
      || document.release?.build_id !== release.build_id
      || document.release?.deploy_run_id !== release.deploy_run_id
      || document.payload?.role !== role
      || document.payload?.actor_id !== actorIds[role]
      || document.payload?.locale !== locale
      || document.payload?.subject?.lead_id !== fixture.lead_id
      || document.payload?.subject?.contract_id !== fixture.contract_id
      || document.payload?.subject?.marker_sha256 !== sha256(fixture.marker)
      || document.payload?.runner_source_sha256 !== runnerSourceSha256
      || document.payload?.playwright_image !== PLAYWRIGHT_IMAGE
    ) refuse("browser_artifact_semantic_invalid");
    expectedPaths.add(artifact.path);
    documents.set(artifact.path, artifactBytes);
    const tracePath = canonicalRelativePath(document.payload?.trace?.path, "browser_trace_path_invalid");
    if (!tracePath.startsWith(`${role}/${locale}/`)) refuse("browser_trace_path_invalid");
    expectedPaths.add(tracePath);
    for (const step of document.payload?.ordered_steps ?? []) {
      if (step?.screenshot === null) continue;
      const screenshotPath = canonicalRelativePath(step?.screenshot?.path, "browser_screenshot_path_invalid");
      if (!screenshotPath.startsWith(`${role}/${locale}/screenshots/`)) refuse("browser_screenshot_path_invalid");
      expectedPaths.add(screenshotPath);
    }
  }
  if (expectedPaths.size !== 72) refuse("browser_evidence_file_set_invalid");
  const actualPaths = walkContainerEvidence(artifactRoot, identity);
  if (actualPaths.length !== expectedPaths.size || actualPaths.some((file) => !expectedPaths.has(file))) {
    refuse("browser_evidence_file_set_invalid");
  }
  for (const relativePath of actualPaths) {
    if (!documents.has(relativePath)) {
      documents.set(relativePath, readContainerFile(artifactRoot, relativePath, identity, "browser_evidence_file_invalid"));
    }
  }
  return {
    sessions: structuredClone(output.sessions),
    artifacts: structuredClone(output.artifacts),
    documents,
  };
}

function removeContainer(containerName) {
  try {
    execFileSync(DOCKER_BIN, ["rm", "--force", containerName], {
      env: DOCKER_ENV,
      stdio: "ignore",
      windowsHide: true,
      timeout: 30_000,
    });
  } catch {
    // The normal --rm path already removed the container.
  }
}

/** A container failure code is a lowercase identifier authored by the runner. */
const CONTAINER_FAILURE_CODE = /^[a-z][a-z0-9_]{1,62}$/;

/**
 * A closed vocabulary for what the container's stderr looked like.
 *
 * The container's stdin carries the acceptance passwords and the receipt private
 * key, and a node crash can print the object it was handed, so stderr never
 * reaches the log verbatim. Matching it against a fixed list and printing only
 * our own names keeps the diagnosis while making a leak structurally impossible.
 */
const CONTAINER_STDERR_SIGNATURES = Object.freeze([
  ["docker_daemon_unreachable", /Cannot connect to the Docker daemon/],
  ["docker_daemon_error", /Error response from daemon/],
  ["image_missing", /Unable to find image|No such image/],
  ["permission_denied", /permission denied|EACCES/],
  ["path_missing", /no such file or directory|Cannot find module|ENOENT/],
  ["out_of_memory", /out of memory|Killed|SIGKILL/],
  ["node_fatal", /FATAL ERROR/],
  ["unhandled_rejection", /UnhandledPromiseRejection|unhandledRejection/],
  ["playwright_launch", /browserType\.launch|Executable doesn't exist/],
]);

function containerFailureCode(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    return stdout.length === 0 ? "<no-stdout>" : "<unparsable-stdout>";
  }
  const code = parsed?.failure_code;
  if (typeof code !== "string") return "<no-failure-code>";
  return CONTAINER_FAILURE_CODE.test(code) ? code : "<redacted-failure-code>";
}

/**
 * Describe a non-zero container exit without echoing anything it produced.
 *
 * The runner answers a machine-readable `{status,failure_code}` on stdout even
 * when it fails, so the cause is almost always already in hand -- discarding it
 * and refusing with a single opaque code is what made `stdin_empty` cost a full
 * deploy/accept cycle to place.
 */
export function containerFailureLabel(status, stdout, stderr) {
  const stderrText = stderr.toString("utf8");
  const signatures = CONTAINER_STDERR_SIGNATURES
    .filter(([, pattern]) => pattern.test(stderrText))
    .map(([name]) => name);
  return [
    `status=${Number.isInteger(status) ? status : "<no-status>"}`,
    `failure_code=${containerFailureCode(stdout)}`,
    `stderr_bytes=${stderr.length}`,
    `stderr_signatures=${signatures.length > 0 ? signatures.join(",") : "<none>"}`,
    `stderr_sha256=${createHash("sha256").update(stderr).digest("hex").slice(0, 16)}`,
  ].join(" ");
}

/**
 * The argument list that starts the browser UAT container.
 *
 * `--interactive` is load bearing, not cosmetic: docker attaches the container's
 * stdin only when it is present, and the runner reads its entire request from
 * stdin. Without it the container reads zero bytes and refuses with
 * `failure_code=stdin_empty` before it ever opens a browser -- which is exactly
 * how this release behaved in production. The list is built here so a test can
 * hold the flag in place.
 */
export function browserContainerArgs({ containerName, releaseGid, releaseRoot, evidenceParent }) {
  return [
    "run", "--rm", "--name", containerName, "--pull=never", "--read-only", "--user", "pwuser",
    "--interactive",
    "--group-add", String(releaseGid),
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=512", "--memory=2g", "--cpus=2",
    "--shm-size=1g", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m",
    "--tmpfs", "/home/pwuser:rw,nosuid,nodev,size=64m",
    "--mount", `type=bind,src=${releaseRoot},dst=/release,readonly`,
    "--mount", `type=bind,src=${evidenceParent},dst=${CONTAINER_EVIDENCE_PARENT}`,
    "--workdir", "/release", "--entrypoint", "/usr/bin/node", PLAYWRIGHT_IMAGE,
    `/release/${BROWSER_RUNNER_PATH}`,
  ];
}

function runBrowserContainer(args, inputBytes, { containerName, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let overflow = false;
    let interrupted = false;
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(DOCKER_BIN, args, {
      env: DOCKER_ENV,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      inputBytes.fill(0);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      interrupted = true;
      removeContainer(containerName);
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      overflow = true;
      removeContainer(containerName);
      child.kill("SIGTERM");
    }, CONTAINER_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflow = true;
        removeContainer(containerName);
        child.kill("SIGTERM");
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(chunk);
    });
    child.on("error", () => finish(new BrowserProducerError("browser_container_start_failed")));
    child.on("close", (status) => {
      if (interrupted) return finish(new BrowserProducerError("uat_interrupted"));
      if (overflow) return finish(new BrowserProducerError("browser_container_limit_exceeded"));
      if (status !== 0) {
        console.error(
          `postdeploy browser uat: container exited non-zero ${containerFailureLabel(status, Buffer.concat(stdout), Buffer.concat(stderr))}`,
        );
        return finish(new BrowserProducerError("browser_container_failed"));
      }
      finish(null, Buffer.concat(stdout));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(inputBytes);
  });
}

export async function runCanonicalBrowserUat({
  releaseRoot,
  release,
  accounts,
  actorIds,
  fixture,
  receiptPrivateKeyBytes,
  receiptPublicKeyBytes,
  signal = null,
}) {
  if (
    !SHA40.test(release?.git_sha ?? "")
    || REQUIRED_ROLES.some((role) => !UUID.test(actorIds?.[role] ?? ""))
    || !FIXTURE_MARKER.test(fixture?.marker ?? "")
    || !UUID.test(fixture?.lead_id ?? "")
    || !UUID.test(fixture?.contract_id ?? "")
    || fixture.lead_id === fixture.contract_id
    || !CONTRACT_NO.test(fixture?.contract_no ?? "")
  ) {
    refuse("browser_input_identity_invalid");
  }
  const identity = inspectCanonicalBrowserRuntime(releaseRoot);
  const runnerSourceSha256 = sha256(readFileSync(path.join(releaseRoot, BROWSER_RUNNER_PATH)));
  const workRoot = ensureRootDirectory(WORK_ROOT);
  const attempt = path.join(workRoot, `${release.git_sha}.${process.pid}.${randomUUID()}`);
  const evidenceParent = path.join(attempt, "evidence");
  const artifactRoot = path.join(evidenceParent, "output");
  const containerName = `newme-browser-uat-${release.git_sha.slice(0, 12)}-${randomUUID()}`;
  mkdirSync(attempt, { mode: 0o700 });
  mkdirSync(evidenceParent, { mode: 0o700 });
  chownSync(evidenceParent, identity.uid, identity.gid);
  chmodSync(evidenceParent, 0o700);
  fsyncDirectory(evidenceParent);
  fsyncDirectory(attempt);
  fsyncDirectory(workRoot);
  try {
    const input = {
      input_version: BROWSER_INPUT_VERSION,
      base_url: "https://app.newme.ae",
      release: {
        git_sha: release.git_sha,
        build_id: release.build_id,
        deploy_run_id: release.deploy_run_id,
        deployed_at: release.deployed_at,
      },
      fixture: { ...fixture },
      artifact_directory: CONTAINER_ARTIFACT_ROOT,
      receipt_private_key_pem: receiptPrivateKeyBytes.toString("utf8"),
      roles: REQUIRED_ROLES.map((role) => ({
        role,
        actor_id: actorIds[role],
        email: accounts[role].email,
        password: accounts[role].password,
      })),
    };
    const inputBytes = Buffer.from(JSON.stringify(input), "utf8");
    const args = browserContainerArgs({
      containerName,
      releaseGid: identity.releaseGid,
      releaseRoot,
      evidenceParent,
    });
    const stdout = await runBrowserContainer(args, inputBytes, { containerName, signal });
    const output = parseJson(stdout, "browser_output_json_invalid");
    return collectCanonicalBrowserEvidence({
      output,
      artifactRoot,
      identity,
      release: input.release,
      actorIds,
      fixture,
      receiptPublicKeyBytes,
      runnerSourceSha256,
    });
  } finally {
    removeContainer(containerName);
    if (existsSync(attempt)) rmSync(attempt, { recursive: true, force: false });
    fsyncDirectory(workRoot);
  }
}
