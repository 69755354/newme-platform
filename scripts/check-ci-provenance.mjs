import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIRECTORY = path.join(ROOT, ".github", "workflows");
const POLICY_PATH = path.join(ROOT, "infra", "ci", "provenance-exceptions.json");
const LOCK_PATH = path.join(ROOT, "infra", "ci", "provenance-lock.json");
const TRUSTED_ACTION_OWNERS = new Set(["actions", "github", "supabase"]);
const ACTION_SHA = /^[0-9a-f]{40}$/;
const IMAGE_REFERENCE = /^([a-z0-9][a-z0-9._/-]*):([a-z0-9][a-z0-9._-]*)@sha256:([0-9a-f]{64})$/i;
const PLAYWRIGHT_CONTAINER = /^mcr\.microsoft\.com\/playwright:v1\.60\.0-noble@sha256:[0-9a-f]{64}$/;
const NETWORK_RETRY_DELAYS_MS = [0, 250, 750];
const EXCEPTION_FIELDS = [
  "id",
  "kind",
  "subject",
  "risk_reason",
  "mitigation",
  "owner",
  "expires",
  "audit_ref",
];

function stripQuotes(value) {
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function startsMappingKey(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:-\\s*)?(?:${escaped}|"${escaped}"|'${escaped}')\\s*:`).test(line);
}

function flowMappingKey(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-?\\s*\\{[^}]*?(?:^|[,\\s])(?:${escaped}|"${escaped}"|'${escaped}')\\s*:`).test(line);
}

function parsedWorkflowReferences(source, file, failures) {
  let document;
  try {
    document = yaml.load(source);
  } catch (error) {
    failures.push(`${file} is not valid YAML: ${error.message}`);
    return { uses: [], runners: [], images: [] };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    failures.push(`${file} workflow root must be an object`);
    return { uses: [], runners: [], images: [] };
  }
  const jobs = document.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    failures.push(`${file} jobs must be an object`);
    return { uses: [], runners: [], images: [] };
  }

  const references = { uses: [], runners: [], images: [] };
  const scalar = (value, label, target) => {
    if (typeof value !== "string" || !value.trim()) failures.push(`${label} must be a non-empty static scalar`);
    else target.push(value.trim());
  };
  for (const [jobName, job] of Object.entries(jobs)) {
    const label = `${file} job ${jobName}`;
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (Object.hasOwn(job, "continue-on-error")) {
      failures.push(`${label} may not declare continue-on-error`);
    }
    if (Object.hasOwn(job, "runs-on")) scalar(job["runs-on"], `${label}.runs-on`, references.runners);
    if (Object.hasOwn(job, "uses")) scalar(job.uses, `${label}.uses`, references.uses);
    if (typeof job.container === "string") scalar(job.container, `${label}.container`, references.images);
    else if (job.container && typeof job.container === "object" && Object.hasOwn(job.container, "image")) {
      scalar(job.container.image, `${label}.container.image`, references.images);
    }
    if (job.services && typeof job.services === "object" && !Array.isArray(job.services)) {
      for (const [serviceName, service] of Object.entries(job.services)) {
        if (!service || typeof service !== "object" || Array.isArray(service) || !Object.hasOwn(service, "image")) {
          failures.push(`${label}.services.${serviceName} must declare a static image`);
        } else {
          scalar(service.image, `${label}.services.${serviceName}.image`, references.images);
        }
      }
    }
    if (Object.hasOwn(job, "steps")) {
      if (!Array.isArray(job.steps)) {
        failures.push(`${label}.steps must be an array`);
      } else {
        for (const [stepIndex, step] of job.steps.entries()) {
          if (!step || typeof step !== "object" || Array.isArray(step)) {
            failures.push(`${label}.steps[${stepIndex}] must be an object`);
          } else if (Object.hasOwn(step, "uses")) {
            scalar(step.uses, `${label}.steps[${stepIndex}].uses`, references.uses);
          }
        }
      }
    }

    const steps = Array.isArray(job.steps) ? job.steps : [];
    const actionSteps = steps.filter((step) => step && typeof step === "object" && !Array.isArray(step));
    for (const [stepIndex, step] of actionSteps.entries()) {
      if (Object.hasOwn(step, "continue-on-error")) {
        failures.push(`${label}.steps[${stepIndex}] may not declare continue-on-error`);
      }
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        if (!step.with || step.with["persist-credentials"] !== false) {
          failures.push(`${label}.steps[${stepIndex}] checkout must set persist-credentials: false`);
        }
      }
      if (typeof step.uses === "string" && step.uses.startsWith("actions/dependency-review-action@")) {
        if (file !== ".github/workflows/ci.yml" || jobName !== "validate") {
          failures.push(`${label}.steps[${stepIndex}] dependency review must stay in the canonical validation job`);
        }
        if (step.if !== "${{ github.event_name == 'pull_request' }}") {
          failures.push(`${label}.steps[${stepIndex}] dependency review must use the exact pull_request condition`);
        }
      }
    }

    const securityEvents = job.permissions && typeof job.permissions === "object"
      ? job.permissions["security-events"]
      : undefined;
    if (securityEvents === "write") {
      if (Object.hasOwn(job, "if")) {
        failures.push(`${label} security-events write jobs may not be conditionally skipped`);
      }
      if (Object.hasOwn(job, "needs")) {
        failures.push(`${label} security-events write jobs must not declare needs; an upstream failure would turn the required scan into a skipped/neutral check`);
      }
      const allowed = /^(?:actions\/checkout|github\/codeql-action\/(?:init|analyze))@/;
      for (const [stepIndex, step] of actionSteps.entries()) {
        if (Object.hasOwn(step, "if")) {
          failures.push(`${label}.steps[${stepIndex}] security-events write steps may not be conditionally skipped`);
        }
        if (Object.hasOwn(step, "run")) {
          failures.push(`${label}.steps[${stepIndex}] security-events write jobs may not execute repository commands`);
        }
        if (typeof step.uses !== "string" || !allowed.test(step.uses)) {
          failures.push(`${label}.steps[${stepIndex}] security-events write jobs may only use checkout and CodeQL actions`);
        }
      }
      const initSteps = actionSteps.filter((step) => typeof step.uses === "string" && step.uses.startsWith("github/codeql-action/init@"));
      const analyzeSteps = actionSteps.filter((step) => typeof step.uses === "string" && step.uses.startsWith("github/codeql-action/analyze@"));
      const init = initSteps[0];
      if (initSteps.length !== 1 || init.with?.["build-mode"] !== "none" || init.with?.languages !== "javascript-typescript") {
        failures.push(`${label} must run isolated javascript-typescript CodeQL with build-mode: none`);
      }
      if (analyzeSteps.length !== 1) failures.push(`${label} must run exactly one CodeQL analyze step`);
    }

    const runsPlaywright = actionSteps.some((step) => typeof step.run === "string" && /\bplaywright\s+test\b/.test(step.run));
    if (runsPlaywright) {
      const containerImage = typeof job.container === "string" ? job.container : job.container?.image;
      if (!PLAYWRIGHT_CONTAINER.test(String(containerImage || ""))) {
        failures.push(`${label} Playwright tests must run in the reviewed version-matched browser container`);
      }
    }
  }
  return references;
}

function sameMultiset(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function isoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : parsed;
}

function loadRunnerExceptions(policy, today, failures) {
  const exceptions = new Map();
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    failures.push("provenance policy must be an object");
    return exceptions;
  }
  if (policy.schema_version !== 1) failures.push("provenance policy schema_version must be 1");
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(String(policy.policy_version))) {
    failures.push("provenance policy_version must be date.revision");
  }
  if (!Array.isArray(policy.exceptions)) {
    failures.push("provenance policy exceptions must be an array");
    return exceptions;
  }

  const todayDate = isoDate(today);
  if (!todayDate) {
    failures.push("provenance validation date must be ISO-8601");
    return exceptions;
  }
  const maximumExpiry = new Date(todayDate);
  maximumExpiry.setUTCDate(maximumExpiry.getUTCDate() + 45);

  for (const [index, exception] of policy.exceptions.entries()) {
    const prefix = `provenance exception[${index}]`;
    if (!exception || typeof exception !== "object" || Array.isArray(exception)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    for (const field of EXCEPTION_FIELDS) {
      if (typeof exception[field] !== "string" || !exception[field].trim()) {
        failures.push(`${prefix} missing ${field}`);
      }
    }
    if (!Number.isInteger(exception.version) || exception.version < 1) {
      failures.push(`${prefix} version must be a positive integer`);
    }
    if (exception.kind !== "github-hosted-runner") {
      failures.push(`${prefix} has unsupported kind`);
    }
    if (/-latest$/i.test(String(exception.subject))) {
      failures.push(`${prefix} may not accept a *-latest runner`);
    }
    const expiry = isoDate(exception.expires);
    if (!expiry || expiry < todayDate) {
      failures.push(`${prefix} is expired or invalid`);
    } else if (expiry > maximumExpiry) {
      failures.push(`${prefix} exceeds the 45-day maximum lifetime`);
    }
    if (!/^https:\/\/github\.com\/actions\/runner-images\/blob\/[0-9a-f]{40}\//.test(String(exception.audit_ref))) {
      failures.push(`${prefix} audit_ref must bind an official runner-images commit`);
    }
    if (exceptions.has(exception.subject)) {
      failures.push(`${prefix} duplicates runner ${exception.subject}`);
    } else if (typeof exception.subject === "string" && exception.subject) {
      exceptions.set(exception.subject, exception);
    }
  }
  return exceptions;
}

function loadProvenanceLock(lock, failures) {
  const actions = new Map();
  const images = new Map();
  const artifacts = new Map();
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    failures.push("provenance lock must be an object");
    return { actions, images, artifacts };
  }
  if (lock.schema_version !== 1) failures.push("provenance lock schema_version must be 1");
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(String(lock.lock_version))) {
    failures.push("provenance lock_version must be date.revision");
  }
  if (!Array.isArray(lock.actions) || !Array.isArray(lock.images) || !Array.isArray(lock.artifacts)) {
    failures.push("provenance lock actions, images, and artifacts must be arrays");
    return { actions, images, artifacts };
  }
  for (const [index, action] of lock.actions.entries()) {
    const prefix = `provenance lock action[${index}]`;
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    const owner = String(action.uses || "").split("/", 1)[0].toLowerCase();
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+(?:\/[^@\s]+)?$/i.test(String(action.uses))) failures.push(`${prefix} uses is invalid`);
    if (!TRUSTED_ACTION_OWNERS.has(owner)) failures.push(`${prefix} owner '${owner}' is not trusted`);
    if (!ACTION_SHA.test(String(action.commit_sha))) failures.push(`${prefix} commit_sha is invalid`);
    if (!/^v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(String(action.version))) failures.push(`${prefix} version is invalid`);
    const repository = String(action.uses || "").split("/").slice(0, 2).join("/");
    const expectedSource = `https://api.github.com/repos/${repository}/git/ref/tags/${action.version}`;
    if (action.source !== expectedSource) {
      failures.push(`${prefix} source must be the official GitHub tag-ref API`);
    }
    if (actions.has(action.uses)) failures.push(`${prefix} duplicates ${action.uses}`);
    else if (typeof action.uses === "string" && action.uses) actions.set(action.uses, action);
  }
  for (const [index, image] of lock.images.entries()) {
    const prefix = `provenance lock image[${index}]`;
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    const official = String(image.reference || "").match(/^docker\.io\/library\/([a-z0-9._-]+):([a-z0-9][a-z0-9._-]*)$/i);
    const playwright = String(image.reference || "").match(/^mcr\.microsoft\.com\/playwright:(v\d+\.\d+\.\d+-noble)$/i);
    const tag = official?.[2] || playwright?.[1] || "";
    if ((!official && !playwright) || /(?:^|[-_.])latest(?:$|[-_.])/i.test(tag)) failures.push(`${prefix} reference is invalid`);
    if (!/^sha256:[0-9a-f]{64}$/.test(String(image.digest))) failures.push(`${prefix} digest is invalid`);
    const expectedSource = official
      ? `https://hub.docker.com/_/${official[1]}`
      : "https://mcr.microsoft.com/product/playwright/about";
    if (String(image.source) !== expectedSource) failures.push(`${prefix} source must name the official image publisher`);
    if (images.has(image.reference)) failures.push(`${prefix} duplicates ${image.reference}`);
    else if (typeof image.reference === "string" && image.reference) images.set(image.reference, image);
  }
  for (const [index, artifact] of lock.artifacts.entries()) {
    const prefix = `provenance lock artifact[${index}]`;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
      failures.push(`${prefix} must be an object`);
      continue;
    }
    const version = String(artifact.version || "");
    const expectedAsset = `supabase_${version}_linux_amd64.tar.gz`;
    const expectedSource = `https://github.com/supabase/cli/releases/download/v${version}/checksums.txt`;
    const expectedUrl = `https://github.com/supabase/cli/releases/download/v${version}/${expectedAsset}`;
    if (artifact.id !== "supabase-cli-linux-amd64") failures.push(`${prefix} id is not approved`);
    if (!/^\d+\.\d+\.\d+$/.test(version)) failures.push(`${prefix} version is invalid`);
    if (artifact.asset_name !== expectedAsset) failures.push(`${prefix} asset_name does not match the version`);
    if (artifact.source !== expectedSource) failures.push(`${prefix} source must be the official GitHub release checksums`);
    if (artifact.url !== expectedUrl) failures.push(`${prefix} url must be the official GitHub release asset`);
    if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256))) failures.push(`${prefix} sha256 is invalid`);
    if (!/^[0-9a-f]{64}$/.test(String(artifact.source_sha256))) failures.push(`${prefix} source_sha256 is invalid`);
    if (artifacts.has(artifact.url)) failures.push(`${prefix} duplicates ${artifact.url}`);
    else if (typeof artifact.url === "string" && artifact.url) artifacts.set(artifact.url, artifact);
  }
  return { actions, images, artifacts };
}

async function fetchJson(fetchImpl, url, label, options = {}) {
  let response;
  try {
    response = await fetchWithNetworkRetries(fetchImpl, url, {
      redirect: "error",
      ...options,
      headers: {
        "User-Agent": "newme-ci-provenance-gate",
        Accept: "application/vnd.github+json",
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error(`${label} could not be fetched`);
  }
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

async function fetchWithNetworkRetries(fetchImpl, url, options) {
  let lastError;
  for (const [attempt, delay] of NETWORK_RETRY_DELAYS_MS.entries()) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetchImpl(url, options);
      const transientStatus = [408, 425, 429].includes(response?.status) || response?.status >= 500;
      if (!transientStatus || attempt === NETWORK_RETRY_DELAYS_MS.length - 1) return response;
      try {
        await response.body?.cancel();
      } catch {
        // The retry remains fail-closed even if the rejected response body cannot be cancelled.
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function parseGitTagAdvertisement(bytes, repository, version) {
  const tagRef = `refs/tags/${version}`;
  const peeledRef = `${tagRef}^{}`;
  const refs = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const lengthText = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/i.test(lengthText)) throw new Error(`${repository}@${version} Git advertisement is malformed`);
    const packetLength = Number.parseInt(lengthText, 16);
    offset += 4;
    if (packetLength === 0) continue;
    if (packetLength < 4 || offset + packetLength - 4 > bytes.length) {
      throw new Error(`${repository}@${version} Git advertisement packet is invalid`);
    }
    const packet = bytes.subarray(offset, offset + packetLength - 4).toString("utf8").replace(/\n$/, "");
    offset += packetLength - 4;
    const match = packet.split("\0", 1)[0].match(/^([0-9a-f]{40})\s+(refs\/tags\/.+)$/);
    if (match) {
      if (refs.has(match[2])) throw new Error(`${repository}@${version} Git advertisement repeats ${match[2]}`);
      refs.set(match[2], match[1]);
    }
  }
  if (offset !== bytes.length) throw new Error(`${repository}@${version} Git advertisement has trailing bytes`);
  const commit = refs.get(peeledRef) || refs.get(tagRef) || "";
  if (!ACTION_SHA.test(commit)) throw new Error(`${repository}@${version} Git tag did not resolve to a commit`);
  return commit;
}

export async function resolveActionGitTag(fetchImpl, action) {
  const repository = action.uses.split("/").slice(0, 2).join("/");
  const bytes = await fetchBytes(
    fetchImpl,
    `https://github.com/${repository}.git/info/refs?service=git-upload-pack`,
    `${repository}@${action.version} Git tag advertisement`,
    5_000_000,
    { headers: { Accept: "application/x-git-upload-pack-advertisement" }, redirect: "error" },
  );
  return parseGitTagAdvertisement(bytes, repository, action.version);
}

async function fetchBytes(fetchImpl, url, label, maximumBytes, options = {}) {
  let response;
  try {
    response = await fetchWithNetworkRetries(fetchImpl, url, {
      redirect: options.redirect || "error",
      headers: { "User-Agent": "newme-ci-provenance-gate", ...(options.headers || {}) },
    });
  } catch {
    throw new Error(`${label} could not be fetched`);
  }
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximumBytes) throw new Error(`${label} is empty or too large`);
  return bytes;
}

async function resolveArtifactChecksums(fetchImpl, artifact) {
  const bytes = await fetchBytes(
    fetchImpl,
    artifact.source,
    `${artifact.id}@${artifact.version} checksums`,
    1_000_000,
    { redirect: "follow" },
  );
  return {
    sourceDigest: createHash("sha256").update(bytes).digest("hex"),
    lines: bytes.toString("utf8").split(/\r?\n/),
  };
}

async function resolveRunnerAuditReference(fetchImpl, exception) {
  const match = exception.audit_ref.match(/^https:\/\/github\.com\/actions\/runner-images\/blob\/([0-9a-f]{40})\/(.+)$/);
  if (!match) return;
  const [, commit, file] = match;
  await fetchBytes(
    fetchImpl,
    `https://raw.githubusercontent.com/actions/runner-images/${commit}/${file}`,
    `${exception.subject} runner audit reference`,
    5_000_000,
  );
}

async function resolveDockerHubDigest(fetchImpl, image) {
  const parsed = image.reference.match(/^docker\.io\/library\/([a-z0-9._-]+):([a-z0-9][a-z0-9._-]*)$/i);
  if (!parsed) throw new Error(`${image.reference} is not a supported Docker Official Image`);
  const [, name, tag] = parsed;
  const tokenDocument = await fetchJson(
    fetchImpl,
    `https://auth.docker.io/token?service=registry.docker.io&scope=${encodeURIComponent(`repository:library/${name}:pull`)}`,
    `${image.reference} registry token`,
    { headers: { Accept: "application/json" } },
  );
  if (typeof tokenDocument?.token !== "string" || tokenDocument.token.length < 20) {
    throw new Error(`${image.reference} registry token response is invalid`);
  }
  let response;
  try {
    response = await fetchWithNetworkRetries(fetchImpl, `https://registry-1.docker.io/v2/library/${name}/manifests/${tag}`, {
      method: "HEAD",
      redirect: "error",
      headers: {
        "User-Agent": "newme-ci-provenance-gate",
        Authorization: `Bearer ${tokenDocument.token}`,
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    });
  } catch {
    throw new Error(`${image.reference} manifest could not be fetched`);
  }
  if (!response?.ok) throw new Error(`${image.reference} manifest returned HTTP ${response?.status ?? "unknown"}`);
  const digest = response.headers?.get?.("docker-content-digest") || "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${image.reference} registry digest is invalid`);
  return digest;
}

async function resolveMicrosoftRegistryDigest(fetchImpl, image) {
  const parsed = image.reference.match(/^mcr\.microsoft\.com\/([a-z0-9._/-]+):([a-z0-9][a-z0-9._-]*)$/i);
  if (!parsed) throw new Error(`${image.reference} is not a supported Microsoft Artifact Registry image`);
  const [, name, tag] = parsed;
  let response;
  try {
    response = await fetchWithNetworkRetries(fetchImpl, `https://mcr.microsoft.com/v2/${name}/manifests/${tag}`, {
      method: "HEAD",
      redirect: "error",
      headers: {
        "User-Agent": "newme-ci-provenance-gate",
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.oci.image.manifest.v1+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(", "),
      },
    });
  } catch {
    throw new Error(`${image.reference} manifest could not be fetched`);
  }
  if (!response?.ok) throw new Error(`${image.reference} manifest returned HTTP ${response?.status ?? "unknown"}`);
  const digest = response.headers?.get?.("docker-content-digest") || "";
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${image.reference} registry digest is invalid`);
  return digest;
}

async function resolveRegistryDigest(fetchImpl, image) {
  if (image.reference.startsWith("docker.io/library/")) return resolveDockerHubDigest(fetchImpl, image);
  if (image.reference.startsWith("mcr.microsoft.com/")) return resolveMicrosoftRegistryDigest(fetchImpl, image);
  throw new Error(`${image.reference} registry is not approved`);
}

async function resolveDockerCliDigest(image) {
  const run = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", image.reference, "--format", "{{json .Manifest}}"],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  if (run.error || run.status !== 0) throw new Error(`${image.reference} Docker CLI readback failed`);
  let manifest;
  try {
    manifest = JSON.parse(run.stdout || "");
  } catch {
    throw new Error(`${image.reference} Docker CLI readback was not JSON`);
  }
  const digest = manifest?.digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(String(digest))) throw new Error(`${image.reference} Docker CLI digest is invalid`);
  return digest;
}

export async function verifyProvenanceSources({
  policy,
  lock,
  fetchImpl = globalThis.fetch,
  dockerDigestResolver = resolveDockerCliDigest,
  actionTagResolver = (action) => resolveActionGitTag(fetchImpl, action),
  artifactChecksumsResolver = (artifact) => resolveArtifactChecksums(fetchImpl, artifact),
  runnerAuditResolver = (exception) => resolveRunnerAuditReference(fetchImpl, exception),
}) {
  const failures = [];
  if (typeof fetchImpl !== "function") return ["provenance source verification has no fetch implementation"];
  const parsed = loadProvenanceLock(lock, failures);
  const runnerExceptions = loadRunnerExceptions(policy, new Date().toISOString().slice(0, 10), failures);
  if (failures.length) return failures;

  const actionResolutions = new Map();
  for (const action of parsed.actions.values()) {
    const repository = action.uses.split("/").slice(0, 2).join("/");
    const key = `${repository}@${action.version}`;
    try {
      const resolved = actionResolutions.has(key)
        ? actionResolutions.get(key)
        : await actionTagResolver(action);
      actionResolutions.set(key, resolved);
      if (resolved !== action.commit_sha) failures.push(`${key} official tag resolves to ${resolved}, not the locked commit`);
    } catch (error) {
      failures.push(error.message);
    }
  }

  for (const image of parsed.images.values()) {
    try {
      let resolved;
      try {
        resolved = await resolveRegistryDigest(fetchImpl, image);
      } catch (registryError) {
        try {
          resolved = await dockerDigestResolver(image);
        } catch {
          throw registryError;
        }
      }
      if (resolved !== image.digest) failures.push(`${image.reference} official tag resolves to ${resolved}, not the locked digest`);
    } catch (error) {
      failures.push(error.message);
    }
  }

  for (const artifact of parsed.artifacts.values()) {
    try {
      const { sourceDigest, lines } = await artifactChecksumsResolver(artifact);
      const expectedLine = `${artifact.sha256}  ${artifact.asset_name}`;
      if (sourceDigest !== artifact.source_sha256 || lines.filter((line) => line === expectedLine).length !== 1) {
        failures.push(`${artifact.id}@${artifact.version} official checksums do not match the provenance lock`);
      }
    } catch (error) {
      failures.push(error.message);
    }
  }

  for (const exception of runnerExceptions.values()) {
    try {
      await runnerAuditResolver(exception);
    } catch (error) {
      failures.push(error.message);
    }
  }
  return failures;
}

function validateImage(reference, location, failures, imageLock, usedImages) {
  const value = stripQuotes(reference.trim());
  const match = value.match(IMAGE_REFERENCE);
  if (!match) {
    failures.push(`${location} image must use an explicit tag plus sha256 digest`);
    return;
  }
  if (/(?:^|[-_.])latest(?:$|[-_.])/i.test(match[2])) {
    failures.push(`${location} image tag may not contain latest`);
  }
  const key = `${match[1]}:${match[2]}`;
  const approved = imageLock.get(key);
  if (!approved) {
    failures.push(`${location} image '${key}' is absent from the provenance lock`);
  } else if (approved.digest !== `sha256:${match[3]}`) {
    failures.push(`${location} image digest does not match the provenance lock`);
  } else {
    usedImages.add(key);
  }
}

function shellTokens(value) {
  return [...value.matchAll(/"(?:\\.|[^"])*"|'[^']*'|\S+/g)].map((match) => stripQuotes(match[0]));
}

function dockerRunImage(command) {
  const tokens = shellTokens(command);
  const valueOptions = new Set([
    "--add-host", "--cpus", "--entrypoint", "--env", "-e", "--memory",
    "--name", "--network", "--pids-limit", "--platform", "--user", "-u",
    "--volume", "-v", "--workdir", "-w",
  ]);
  const flagOptions = new Set(["--init", "--interactive", "-i", "--read-only", "--rm", "--tty", "-t", "-it"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (flagOptions.has(token) || /^--[^=]+=/.test(token)) continue;
    if (valueOptions.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return null;
    return token;
  }
  return null;
}

function validateAptInstall(line, location, failures) {
  const match = line.match(/\b(?:sudo\s+)?apt(?:-get)?\s+install\b([^;&|]*)/);
  if (!match) return;
  const packages = shellTokens(match[1]).filter((token) => token && !token.startsWith("-"));
  if (!packages.length) {
    failures.push(`${location} apt install has no auditable package list`);
    return;
  }
  for (const packageSpec of packages) {
    if (!/^[a-z0-9][a-z0-9+.-]*:[a-z0-9]+=[a-z0-9][a-z0-9+.:~_-]*$/i.test(packageSpec)
      && !/^[a-z0-9][a-z0-9+.-]*=[a-z0-9][a-z0-9+.:~_-]*$/i.test(packageSpec)) {
      failures.push(`${location} apt package '${packageSpec}' must pin an exact version`);
    }
  }
}

export function validateWorkflowProvenance({ workflows, policy, lock, today = new Date().toISOString().slice(0, 10) }) {
  const failures = [];
  if (!workflows || typeof workflows !== "object" || Array.isArray(workflows) || !Object.keys(workflows).length) {
    return ["no workflow sources supplied"];
  }
  const runnerExceptions = loadRunnerExceptions(policy, today, failures);
  const provenanceLock = loadProvenanceLock(lock, failures);
  const usedRunnerExceptions = new Set();
  const usedActions = new Set();
  const usedImages = new Set();
  const usedArtifacts = new Set();

  for (const [file, source] of Object.entries(workflows).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof source !== "string") {
      failures.push(`${file} workflow source must be text`);
      continue;
    }
    const parsedReferences = parsedWorkflowReferences(source, file, failures);
    const rawReferences = { uses: [], runners: [], images: [] };
    const lines = source.split(/\r?\n/);
    for (const [index, rawLine] of lines.entries()) {
      const location = `${file}:${index + 1}`;
      const line = rawLine.trimStart().startsWith("#") ? "" : rawLine.replace(/\s+#.*$/, "");

      if (startsMappingKey(rawLine, "uses") || flowMappingKey(rawLine, "uses")) {
        const uses = rawLine.match(/^\s*(?:-\s*)?(?:uses|"uses"|'uses')\s*:\s*(['"]?)([^'"\s#]+)\1(?:\s+#\s*(\S+))?\s*$/);
        if (!uses) {
          failures.push(`${location} action reference is not statically auditable`);
        } else {
          const reference = uses[2];
          const versionComment = uses[3] || "";
          rawReferences.uses.push(reference);
          if (reference.startsWith("./")) {
            failures.push(`${location} local actions are forbidden until their nested action manifest has an audited provenance contract`);
          } else if (reference.startsWith("docker://")) {
            validateImage(reference.slice("docker://".length), location, failures, provenanceLock.images, usedImages);
          } else {
            const action = reference.match(/^([a-z0-9_.-]+)\/([a-z0-9_.-]+)(?:\/[^@]+)?@(.+)$/i);
            if (!action) {
              failures.push(`${location} action reference is malformed`);
            } else {
              const owner = action[1].toLowerCase();
              if (!TRUSTED_ACTION_OWNERS.has(owner)) failures.push(`${location} action owner '${owner}' is not trusted`);
              if (!ACTION_SHA.test(action[3])) failures.push(`${location} action must pin a full lowercase 40-character commit SHA`);
              if (!/^v\d+\.\d+\.\d+(?:[-+][0-9a-z.-]+)?$/i.test(versionComment)) {
                failures.push(`${location} pinned action must retain an exact version comment`);
              }
              const actionKey = reference.slice(0, reference.lastIndexOf("@"));
              const approved = provenanceLock.actions.get(actionKey);
              if (!approved) {
                failures.push(`${location} action '${actionKey}' is absent from the provenance lock`);
              } else if (approved.commit_sha !== action[3] || approved.version !== versionComment) {
                failures.push(`${location} action SHA/version does not match the provenance lock`);
              } else {
                usedActions.add(actionKey);
              }
            }
          }
        }
      }

      if (startsMappingKey(rawLine, "runs-on") || flowMappingKey(rawLine, "runs-on")) {
        const runnerMatch = rawLine.match(/^\s*(?:-\s*)?(?:runs-on|"runs-on"|'runs-on')\s*:\s*(['"]?)([^'"\s#]+)\1(?:\s+#.*)?$/);
        if (!runnerMatch) {
          failures.push(`${location} runner label must be a static scalar`);
        } else {
          const runner = runnerMatch[2];
          rawReferences.runners.push(runner);
          if (/-latest$/i.test(runner)) failures.push(`${location} runner may not use a *-latest alias`);
          const exception = runnerExceptions.get(runner);
          if (!exception) failures.push(`${location} mutable hosted runner '${runner}' lacks an active exception`);
          else usedRunnerExceptions.add(runner);
        }
      }

      if (startsMappingKey(rawLine, "image") || flowMappingKey(rawLine, "image")) {
        const image = rawLine.match(/^\s*(?:-\s*)?(?:image|"image"|'image')\s*:\s*(['"]?)([^'"\s#]+)\1(?:\s+#.*)?$/);
        if (!image) failures.push(`${location} image reference is not statically auditable`);
        else {
          rawReferences.images.push(image[2]);
          validateImage(image[2], location, failures, provenanceLock.images, usedImages);
        }
      }

      if (/\bnpx(?:\.cmd)?\b/i.test(line)) failures.push(`${location} npx is forbidden because it can download missing packages`);
      if (/\bnpm\s+(?:exec|x)\b/i.test(line) && !/\bnpm\s+(?:exec|x)\s+--offline(?:\s|$)/i.test(line)) {
        failures.push(`${location} npm exec must use --offline`);
      }
      if (/\bplaywright\s+install\b/i.test(line)) {
        failures.push(`${location} Playwright browser downloads are forbidden; use the digest-pinned browser container`);
      }
      validateAptInstall(line, location, failures);
    }

    for (const kind of ["uses", "runners", "images"]) {
      if (!sameMultiset(parsedReferences[kind], rawReferences[kind])) {
        failures.push(`${file} parsed ${kind} references do not exactly match statically auditable scalar lines`);
      }
    }

    for (const [index, rawLine] of lines.entries()) {
      const executableLine = rawLine.trimStart().startsWith("#") ? "" : rawLine.replace(/\s+#.*$/, "");
      if (!/\bnpm\s+ci(?:\s|$)/.test(executableLine)) continue;
      if (!/\bnpm\s+ci\s+[^\r\n]*--strict-allow-scripts=true(?:\s|$)/.test(executableLine)) {
        failures.push(`${file}:${index + 1} npm ci must force --strict-allow-scripts=true`);
      }
      if (!/\bnpm\s+ci\s+[^\r\n]*--include=optional(?:\s|$)/.test(executableLine)) {
        failures.push(`${file}:${index + 1} npm ci must force --include=optional`);
      }
      if (!/\bnpm\s+ci\s+[^\r\n]*--registry=https:\/\/registry\.npmjs\.org(?:\s|$)/.test(executableLine)) {
        failures.push(`${file}:${index + 1} npm ci must force the official npm registry`);
      }
      if (/--(?:dangerously-allow-all-scripts|ignore-scripts)(?:=|\s|$)/.test(executableLine)) {
        failures.push(`${file}:${index + 1} npm ci may not bypass reviewed install scripts`);
      }
      let jobStart = -1;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (/^ {2}[a-z0-9_-]+:\s*$/i.test(lines[cursor])) {
          jobStart = cursor;
          break;
        }
      }
      const jobPrefix = lines.slice(Math.max(0, jobStart), index).join("\n");
      const setup = jobPrefix.lastIndexOf("uses: actions/setup-node@");
      const toolchain = jobPrefix.lastIndexOf("run: node scripts/check-toolchain.mjs");
      if (jobStart < 0 || setup < 0 || toolchain < setup) {
        failures.push(`${file}:${index + 1} npm ci must follow setup-node and the pre-install toolchain gate in the same job`);
      }
    }

    const executableSource = lines
      .map((rawLine) => rawLine.trimStart().startsWith("#") ? "" : rawLine.replace(/\s+#.*$/, ""))
      .join("\n");
    const normalized = executableSource.replace(/\\\r?\n[ \t]*/g, " ");
    for (const match of normalized.matchAll(/https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/releases\/download\/[^\s'"\\]+/gi)) {
      if (!provenanceLock.artifacts.has(match[0])) {
        failures.push(`${file} release asset '${match[0]}' is absent from the provenance lock`);
      }
    }
    for (const command of normalized.matchAll(/\b(?:curl|wget)\s+[^\r\n]*/gi)) {
      const downloadsToFile = /(?:^|\s)(?:--output|-o)\s+(?!\/dev\/null(?:\s|$))/.test(command[0])
        && !/\s-X\s+POST(?:\s|$)/i.test(command[0]);
      if (!downloadsToFile) continue;
      const lockedUrl = [...provenanceLock.artifacts.keys()].find((url) => command[0].includes(url));
      if (!lockedUrl) failures.push(`${file} network download is not bound to a reviewed artifact`);
    }
    for (const artifact of provenanceLock.artifacts.values()) {
      const installer = `node scripts/install-reviewed-artifact.mjs ${artifact.id}`;
      const installerMatches = normalized.split(installer).length - 1;
      if (!installerMatches) continue;
      usedArtifacts.add(artifact.url);
      if (installerMatches !== 1) failures.push(`${file} ${artifact.id} reviewed installer must run exactly once`);
    }
    for (const match of normalized.matchAll(/\bnode\s+scripts\/install-reviewed-artifact\.mjs(?:\s+[^\r\n]*)?/g)) {
      if (![...provenanceLock.artifacts.values()].some((artifact) => match[0] === `node scripts/install-reviewed-artifact.mjs ${artifact.id}`)) {
        failures.push(`${file} reviewed artifact installer invocation is not exact`);
      }
    }
    for (const match of normalized.matchAll(/\bdocker\s+run\s+([^\r\n]+)/g)) {
      const prefix = normalized.slice(0, match.index);
      const lineNumber = prefix.split(/\r?\n/).length;
      const image = dockerRunImage(match[1]);
      if (!image) failures.push(`${file}:${lineNumber} docker run image is not statically auditable`);
      else validateImage(image, `${file}:${lineNumber}`, failures, provenanceLock.images, usedImages);
    }
  }

  for (const runner of runnerExceptions.keys()) {
    if (!usedRunnerExceptions.has(runner)) failures.push(`stale provenance exception for unused runner '${runner}'`);
  }
  for (const action of provenanceLock.actions.keys()) {
    if (!usedActions.has(action)) failures.push(`stale provenance lock action '${action}'`);
  }
  for (const image of provenanceLock.images.keys()) {
    if (!usedImages.has(image)) failures.push(`stale provenance lock image '${image}'`);
  }
  for (const artifact of provenanceLock.artifacts.keys()) {
    if (!usedArtifacts.has(artifact)) failures.push(`stale provenance lock artifact '${artifact}'`);
  }
  return failures;
}

async function main() {
  const workflowFiles = fs.readdirSync(WORKFLOW_DIRECTORY)
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort();
  const workflows = Object.fromEntries(workflowFiles.map((file) => [
    path.posix.join(".github", "workflows", file),
    fs.readFileSync(path.join(WORKFLOW_DIRECTORY, file), "utf8"),
  ]));
  let policy;
  let lock;
  try {
    policy = JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
    lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8"));
  } catch {
    console.error("[FAIL] provenance lock or exception policy is missing or invalid JSON");
    process.exitCode = 1;
    return;
  }
  const failures = [
    ...validateWorkflowProvenance({ workflows, policy, lock }),
    ...await verifyProvenanceSources({ policy, lock }),
  ];
  if (failures.length) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`[PASS] CI provenance gate (${workflowFiles.length} workflows; official tag/digest readback verified)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[FAIL] CI provenance gate crashed: ${error.message}`);
    process.exitCode = 1;
  });
}
