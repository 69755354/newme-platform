#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export const JOURNAL_WINDOW_MINUTES = 15;
export const DISK_ALERT_THRESHOLD_PERCENT = 90;

const STAGING_SERVICE = "newme-staging.service";
const STAGING_ROOT = "/opt/newme-staging";
const STAGING_RELEASES = `${STAGING_ROOT}/releases`;
const STAGING_CURRENT = `${STAGING_ROOT}/current`;
const STAGING_BASE_URL = "http://127.0.0.1:3101";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MARKER_PATTERN = /^sam54-[0-9a-f]{12}$/;
const MAX_HTTP_BODY_BYTES = 4_096;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const JOURNAL_ERROR_PATTERN =
  /\b(?:Unhandled|ChunkLoadError|TypeError|ReferenceError|Internal Server Error|Cannot find module|ENOENT|fatal|exception)\b|relation\b.*\bdoes not exist\b/i;
const JOURNAL_UNAUTHORIZED_PATTERN =
  /\b(?:401|unauthori[sz]ed|inactive_account|invalid session)\b/i;

class Sam54UatError extends Error {
  constructor(code) {
    super(code);
    this.name = "Sam54UatError";
    this.code = code;
  }
}

function fail(code) {
  throw new Sam54UatError(code);
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort())
  );
}

export function parseSyntheticAlert(text, expectedReleaseSha) {
  if (!SHA_PATTERN.test(expectedReleaseSha)) fail("invalid_release_sha");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail("invalid_synthetic_alert_json");
  }
  const expectedKeys = [
    "marker",
    "reason",
    "releaseSha",
    "schemaVersion",
    "source",
    "target",
    "type",
  ];
  if (
    !exactKeys(body, expectedKeys) ||
    body.schemaVersion !== 1 ||
    body.source !== "sam54-staging-uat" ||
    body.type !== "diagnostic.requested" ||
    body.target !== "staging" ||
    body.reason !== "synthetic_acceptance" ||
    body.releaseSha !== expectedReleaseSha ||
    !MARKER_PATTERN.test(body.marker ?? "")
  ) {
    fail("synthetic_alert_contract_mismatch");
  }
  return body;
}

function parseManifest(text, releaseSha) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail("invalid_release_manifest");
  }
  if (
    !exactKeys(manifest, ["created_at", "git_sha"]) ||
    manifest.git_sha !== releaseSha
  ) {
    fail("release_manifest_mismatch");
  }
  return manifest;
}

function parseDiskPercentage(text) {
  const matches = [...String(text).matchAll(/([0-9]{1,3})%/g)];
  if (matches.length !== 1) fail("invalid_disk_usage_output");
  const value = Number(matches[0][1]);
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    fail("invalid_disk_usage_output");
  }
  return value;
}

function parseDiskBytes(text) {
  const match = String(text).trim().match(/^([0-9]+)(?:\s|$)/);
  if (!match) fail("invalid_disk_size_output");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_disk_size_output");
  }
  return value;
}

async function boundedResponseText(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_HTTP_BODY_BYTES) {
    fail("http_response_too_large");
  }
  return text;
}

async function collectHealth(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${STAGING_BASE_URL}/api/health`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return {
      httpStatus: 0,
      status: "unreachable",
      errorClass: error instanceof Error ? error.name : "UnknownError",
    };
  }
  const text = await boundedResponseText(response);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { httpStatus: response.status, status: "invalid_json" };
  }
  const status =
    typeof body?.status === "string" && /^[a-z_]{1,32}$/.test(body.status)
      ? body.status
      : "invalid_status";
  return { httpStatus: response.status, status };
}

async function collectAuthMe(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${STAGING_BASE_URL}/api/auth/me`, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return {
      httpStatus: 0,
      errorClass: error instanceof Error ? error.name : "UnknownError",
    };
  }
  await boundedResponseText(response);
  return { httpStatus: response.status };
}

async function collectServiceState(execFile) {
  let result;
  try {
    result = await execFile("systemctl", ["is-active", STAGING_SERVICE], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    });
  } catch (error) {
    const state = String(error?.stdout ?? "").trim();
    if (/^[a-z-]{1,32}$/.test(state)) return state;
    fail("service_state_probe_failed");
  }
  const state = String(result.stdout ?? "").trim();
  if (!/^[a-z-]{1,32}$/.test(state)) fail("invalid_service_state");
  return state;
}

export async function runReadOnlyDiagnostic(overrides = {}) {
  const execFile =
    overrides.execFile ?? promisify(execFileCallback);
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const readFileImpl = overrides.readFile ?? readFile;
  const realpathImpl = overrides.realpath ?? realpath;
  const now = overrides.now ?? (() => new Date());
  const releaseSha = overrides.releaseSha ?? "";
  if (!SHA_PATTERN.test(releaseSha)) fail("invalid_release_sha");

  const releaseRoot = `${STAGING_RELEASES}/${releaseSha}`;
  const manifestPath = `${releaseRoot}/manifest.json`;
  const [currentRelease, manifestText] = await Promise.all([
    realpathImpl(STAGING_CURRENT),
    readFileImpl(manifestPath, "utf8"),
  ]);
  if (currentRelease !== releaseRoot) fail("release_is_not_current");
  parseManifest(manifestText, releaseSha);

  const journalSince = new Date(
    now().getTime() - JOURNAL_WINDOW_MINUTES * 60_000,
  ).toISOString();
  const [
    serviceResult,
    health,
    authMe,
    journalResult,
    diskResult,
    sizeResult,
  ] = await Promise.all([
    collectServiceState(execFile),
    collectHealth(fetchImpl),
    collectAuthMe(fetchImpl),
    execFile(
      "journalctl",
      [
        "--unit",
        STAGING_SERVICE,
        "--since",
        journalSince,
        "--no-pager",
        "--output=cat",
      ],
      { encoding: "utf8", maxBuffer: MAX_JOURNAL_BYTES },
    ),
    execFile("df", ["--output=pcent", STAGING_ROOT], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    }),
    execFile("du", ["-sx", "--block-size=1", STAGING_ROOT], {
      encoding: "utf8",
      maxBuffer: 16 * 1024,
    }),
  ]);

  const serviceState = serviceResult;
  const journalText = String(journalResult.stdout ?? "");
  if (Buffer.byteLength(journalText, "utf8") > MAX_JOURNAL_BYTES) {
    fail("journal_output_too_large");
  }
  const journalLines = journalText.split(/\r?\n/).filter(Boolean);
  const diskUsedPercent = parseDiskPercentage(diskResult.stdout);
  const stagingBytes = parseDiskBytes(sizeResult.stdout);

  return {
    service: {
      unit: STAGING_SERVICE,
      state: serviceState,
      active: serviceState === "active",
    },
    health,
    authMe,
    journal: {
      unit: STAGING_SERVICE,
      windowMinutes: JOURNAL_WINDOW_MINUTES,
      entries: journalLines.length,
      unauthorizedMatches: journalLines.filter((line) =>
        JOURNAL_UNAUTHORIZED_PATTERN.test(line)
      ).length,
      errorMatches: journalLines.filter((line) =>
        JOURNAL_ERROR_PATTERN.test(line)
      ).length,
    },
    disk: {
      root: STAGING_ROOT,
      usedPercent: diskUsedPercent,
      alertThresholdPercent: DISK_ALERT_THRESHOLD_PERCENT,
      overThreshold: diskUsedPercent >= DISK_ALERT_THRESHOLD_PERCENT,
      stagingBytes,
    },
  };
}

export async function dispatchSyntheticAlert(text, overrides = {}) {
  const releaseSha = overrides.releaseSha ?? "";
  const alertKey = overrides.alertKey ?? "";
  const trigger = parseSyntheticAlert(text, releaseSha);
  if (alertKey !== "sam54-staging-uat") {
    fail("alert_state_dispatch_contract_mismatch");
  }
  const diagnose = overrides.diagnose ?? runReadOnlyDiagnostic;
  const checks = await diagnose({ ...overrides, releaseSha });
  return {
    schemaVersion: 1,
    linearId: "SAM-54",
    releaseSha,
    target: "staging-loopback",
    automaticDispatch: true,
    trigger: {
      alertKey,
      source: trigger.source,
      type: trigger.type,
      marker: trigger.marker,
    },
    checks,
    safety: {
      mode: "read_only",
      fixedExecutables: ["systemctl", "journalctl", "df", "du"],
      secretsRead: false,
      mutationAttempted: false,
    },
    cleanup: {
      status: "not_applicable",
      reason: "read_only_diagnostics",
      fixtureIds: [],
    },
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (process.argv.length !== 2) {
    console.error("SAM-54 staging UAT failed: unexpected_arguments");
    process.exitCode = 64;
  } else {
    try {
      const releaseSha = process.env.SAM54_EXPECTED_RELEASE_SHA ?? "";
      const alertText = process.env.SAM54_SYNTHETIC_ALERT ?? "";
      const alertKey = process.env.HERMES_ALERT_KEY ?? "";
      console.log(
        JSON.stringify(
          await dispatchSyntheticAlert(alertText, { alertKey, releaseSha }),
        ),
      );
    } catch (error) {
      const code =
        error instanceof Sam54UatError ? error.code : "unexpected_failure";
      console.error(`SAM-54 staging UAT failed: ${code}`);
      process.exitCode = 1;
    }
  }
}
