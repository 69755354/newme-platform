import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export const READINESS_TIMEOUT_MS = 3_000;
export const STAGING_REF = "bfsiibofuzoglziltgyd";
export const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";

const STAGING_SERVICE = "newme-staging.service";
const STAGING_BASE_URL = "http://127.0.0.1:3101";
const STAGING_ENV_FILE = "/etc/newme-staging/staging.env";
const STAGING_RELEASES = "/opt/newme-staging/releases";
const STAGING_CURRENT = "/opt/newme-staging/current";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const JOURNAL_ERROR_PATTERN =
  /\b(?:Unhandled|ChunkLoadError|TypeError|ReferenceError|Internal Server Error|Cannot find module|ENOENT)\b|relation\b.*\bdoes not exist\b/i;

class Sam68UatError extends Error {
  constructor(code) {
    super(code);
    this.name = "Sam68UatError";
    this.code = code;
  }
}

function fail(code) {
  throw new Sam68UatError(code);
}

export function parseEnvironmentFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail("invalid_staging_environment");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function exactNoStore(response) {
  return response.headers.get("cache-control") === "no-store, max-age=0";
}

async function scanPrivateTmp(execFile, mainPid, marker) {
  try {
    await execFile(
      "nsenter",
      ["-t", mainPid, "-m", "--", "grep", "-R", "-F", "-l", "--", marker, "/tmp"],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    fail("private_tmp_scan_failed");
  }
}

function hostileBody(marker) {
  return JSON.stringify({
    headers: {
      authorization: `Bearer hostile-token-${marker}`,
      cookie: `session=hostile-cookie-${marker}`,
    },
    nested: {
      token: `nested-token-${marker}`,
      email: `${marker}@example.invalid`,
    },
    stack: `Error: ${marker}\n    at /srv/private/${marker}.mjs:1:1`,
  });
}

export async function runSam68StagingUat(overrides = {}) {
  const execFile = overrides.execFile ?? promisify(execFileCallback);
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const readFileImpl = overrides.readFile ?? readFile;
  const realpathImpl = overrides.realpath ?? realpath;
  const now = overrides.now ?? (() => new Date());
  const monotonicNow = overrides.monotonicNow ?? (() => performance.now());
  const markerFactory =
    overrides.markerFactory ?? (() => `sam68-${randomUUID().replaceAll("-", "")}`);
  const environment = overrides.environment ?? process.env;

  const releaseSha = environment.SAM68_EXPECTED_RELEASE_SHA ?? "";
  if (!SHA_PATTERN.test(releaseSha)) fail("invalid_release_sha");

  const releaseRoot = `${STAGING_RELEASES}/${releaseSha}`;
  const manifestPath = `${releaseRoot}/manifest.json`;
  const [currentRelease, manifestText, environmentText] = await Promise.all([
    realpathImpl(STAGING_CURRENT),
    readFileImpl(manifestPath, "utf8"),
    readFileImpl(STAGING_ENV_FILE, "utf8"),
  ]);
  if (currentRelease !== releaseRoot) fail("release_is_not_current");

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail("invalid_release_manifest");
  }
  if (manifest?.git_sha !== releaseSha) fail("release_manifest_mismatch");

  const stagingEnvironment = parseEnvironmentFile(environmentText);
  if (
    stagingEnvironment.NEWME_STAGING_PROJECT_REF !== STAGING_REF ||
    stagingEnvironment.NEXT_PUBLIC_SUPABASE_URL !== `https://${STAGING_REF}.supabase.co` ||
    stagingEnvironment.NEXT_PUBLIC_SUPABASE_URL.includes(PRODUCTION_REF)
  ) {
    fail("refusing_non_staging_environment");
  }
  const readinessToken = stagingEnvironment.NEWME_READINESS_TOKEN ?? "";
  if (!readinessToken) fail("missing_readiness_token");
  if (
    stagingEnvironment.SENTRY_DSN ||
    stagingEnvironment.NEXT_PUBLIC_SENTRY_DSN
  ) {
    fail("staging_sentry_must_be_disabled");
  }

  const [{ stdout: mainPidText }, { stdout: privateTmpText }] = await Promise.all([
    execFile("systemctl", [
      "show",
      STAGING_SERVICE,
      "--property=MainPID",
      "--value",
    ], { encoding: "utf8" }),
    execFile("systemctl", [
      "show",
      STAGING_SERVICE,
      "--property=PrivateTmp",
      "--value",
    ], { encoding: "utf8" }),
  ]);
  const mainPid = mainPidText.trim();
  if (!/^[1-9][0-9]*$/.test(mainPid)) fail("invalid_staging_service_pid");
  if (privateTmpText.trim() !== "yes") fail("staging_private_tmp_required");

  const journalSince = now().toISOString();
  const marker = markerFactory();
  if (!/^sam68-[a-z0-9]+$/.test(marker)) fail("invalid_hostile_marker");

  const monitoringResponse = await fetchImpl(
    `${STAGING_BASE_URL}/api/monitoring/report`,
    {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: hostileBody(marker),
    },
  );
  const monitoringBody = await monitoringResponse.text();
  if (
    monitoringResponse.status !== 410 ||
    !exactNoStore(monitoringResponse) ||
    monitoringBody !== JSON.stringify({ error: "Monitoring endpoint retired" }) ||
    monitoringBody.includes(marker)
  ) {
    fail("monitoring_retirement_contract_failed");
  }

  const readinessStarted = monotonicNow();
  const readinessResponse = await fetchImpl(`${STAGING_BASE_URL}/api/ready`, {
    method: "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    headers: { "x-newme-readiness-token": readinessToken },
  });
  const readinessElapsedMs = Math.round(monotonicNow() - readinessStarted);
  let readinessBody;
  try {
    readinessBody = await readinessResponse.json();
  } catch {
    fail("readiness_response_invalid");
  }
  if (
    readinessElapsedMs > READINESS_TIMEOUT_MS ||
    readinessResponse.status !== 200 ||
    !exactNoStore(readinessResponse) ||
    readinessBody?.status !== "ready"
  ) {
    fail("authenticated_readiness_failed");
  }

  const hostileBodyPersisted = await scanPrivateTmp(execFile, mainPid, marker);
  if (hostileBodyPersisted) fail("hostile_body_persisted");

  const { stdout: journalText } = await execFile(
    "journalctl",
    [
      "--unit",
      STAGING_SERVICE,
      "--since",
      journalSince,
      "--no-pager",
      "--output=cat",
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (journalText.includes(marker)) fail("hostile_body_reached_journald");
  const journalLines = journalText.split(/\r?\n/).filter(Boolean);
  const journalErrorCount = journalLines.filter((line) =>
    JOURNAL_ERROR_PATTERN.test(line)
  ).length;
  if (journalErrorCount !== 0) fail("journald_error_observed");

  return {
    schemaVersion: 1,
    linearId: "SAM-68",
    releaseSha,
    target: "staging-loopback",
    monitoring: {
      status: "passed",
      httpStatus: 410,
      cacheControl: "no-store, max-age=0",
      hostileBodyPersisted: false,
    },
    readiness: {
      status: "passed",
      httpStatus: 200,
      cacheControl: "no-store, max-age=0",
      timeoutMs: READINESS_TIMEOUT_MS,
      elapsedMs: readinessElapsedMs,
    },
    observability: {
      journald: {
        status: "observed",
        unit: STAGING_SERVICE,
        entries: journalLines.length,
        hostileMarkerMatches: 0,
        errorMatches: 0,
      },
      sentry: {
        status: "not_applicable",
        reason: "staging_sentry_disabled_by_isolation_contract",
      },
    },
    cleanup: {
      status: "not_applicable",
      reason: "read_only_http_and_journal_observation",
      fixtureIds: [],
    },
  };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (process.argv.length !== 2) {
    console.error("SAM-68 staging UAT failed: unexpected_arguments");
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(await runSam68StagingUat()));
    } catch (error) {
      const code =
        error instanceof Sam68UatError ? error.code : "unexpected_failure";
      console.error(`SAM-68 staging UAT failed: ${code}`);
      process.exitCode = 1;
    }
  }
}
