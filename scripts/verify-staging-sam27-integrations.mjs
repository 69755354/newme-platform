import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  IntegrationHttpError,
  executeBoundedIntegration,
} from "../src/lib/integration-execution.mjs";

export const STAGING_REF = "bfsiibofuzoglziltgyd";
export const PRODUCTION_REF = "vfopmpxlhwzpxqegayew";
export const REQUEST_TIMEOUT_MS = 3_000;

const RELEASES = "/opt/newme-staging/releases";
const CURRENT = "/opt/newme-staging/current";
const ENV_FILE = "/etc/newme-staging/staging.env";
const BASE_URL = "http://127.0.0.1:3101";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const META_ENVIRONMENT_KEYS = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_REDIRECT_URI",
  "META_CAPI_WEBHOOK_SECRET",
];

class Sam27UatError extends Error {
  constructor(code) {
    super(code);
    this.name = "Sam27UatError";
    this.code = code;
  }
}

function fail(code) {
  throw new Sam27UatError(code);
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
      value.length >= 2
      && (
        (value.startsWith("\"") && value.endsWith("\""))
        || (value.startsWith("'") && value.endsWith("'"))
      )
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

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    fail("invalid_json_response");
  }
}

async function assertDisabled(fetchImpl, path, init, integration) {
  const response = await fetchImpl(`${BASE_URL}${path}`, {
    ...init,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await responseJson(response);
  if (
    response.status !== 503
    || !exactNoStore(response)
    || body?.status !== "disabled"
    || body?.integration !== integration
    || body?.reason !== "not_configured"
  ) {
    fail(`${integration}_disabled_contract_failed`);
  }
  return { status: "disabled", httpStatus: 503 };
}

async function syntheticExecutionEvidence() {
  const recoveredAudits = [];
  const recoveredAlerts = [];
  const recovered = await executeBoundedIntegration({
    integration: "meta_oauth",
    operation: "synthetic_recovery",
    audit: async (event) => recoveredAudits.push(event),
    alert: async (event) => recoveredAlerts.push(event),
    sleep: async () => {},
    timeoutSignal: () => new AbortController().signal,
    execute: async ({ attempt }) => {
      if (attempt === 1) throw new IntegrationHttpError(503);
      return "recovered";
    },
  });

  const terminalAudits = [];
  const terminalAlerts = [];
  try {
    await executeBoundedIntegration({
      integration: "meta_oauth",
      operation: "synthetic_terminal_failure",
      audit: async (event) => terminalAudits.push(event),
      alert: async (event) => terminalAlerts.push(event),
      sleep: async () => {},
      timeoutSignal: () => new AbortController().signal,
      execute: async () => {
        throw new IntegrationHttpError(400);
      },
    });
    fail("terminal_failure_was_accepted");
  } catch (error) {
    if (error instanceof Sam27UatError) throw error;
    if (error?.code !== "integration_operation_failed") {
      fail("unexpected_terminal_failure");
    }
  }

  const exhaustedAudits = [];
  const exhaustedAlerts = [];
  try {
    await executeBoundedIntegration({
      integration: "meta_oauth",
      operation: "synthetic_exhaustion",
      audit: async (event) => exhaustedAudits.push(event),
      alert: async (event) => exhaustedAlerts.push(event),
      sleep: async () => {},
      timeoutSignal: () => new AbortController().signal,
      execute: async () => {
        throw new IntegrationHttpError(503);
      },
    });
    fail("retry_exhaustion_was_accepted");
  } catch (error) {
    if (error instanceof Sam27UatError) throw error;
    if (error?.code !== "integration_operation_failed") {
      fail("unexpected_retry_exhaustion");
    }
  }

  if (
    recovered.attempts !== 2
    || recoveredAudits.map((event) => event.outcome).join(",") !== "retry,success"
    || recoveredAlerts.length !== 0
    || terminalAudits.length !== 1
    || terminalAudits[0]?.outcome !== "failure"
    || terminalAlerts.length !== 1
    || terminalAlerts[0]?.reason !== "http_400"
    || exhaustedAudits.map((event) => event.outcome).join(",") !== "retry,retry,failure"
    || exhaustedAlerts.length !== 1
    || exhaustedAlerts[0]?.attempts !== 3
  ) {
    fail("synthetic_retry_audit_alert_contract_failed");
  }

  return {
    recovered: {
      status: "passed",
      attempts: 2,
      auditOutcomes: ["retry", "success"],
      finalAlerts: 0,
    },
    terminal: {
      status: "passed",
      attempts: 1,
      auditOutcomes: ["failure"],
      finalAlerts: 1,
    },
    exhausted: {
      status: "passed",
      attempts: 3,
      auditOutcomes: ["retry", "retry", "failure"],
      finalAlerts: 1,
    },
  };
}

export async function runSam27StagingUat(overrides = {}) {
  const fetchImpl = overrides.fetch ?? globalThis.fetch;
  const readFileImpl = overrides.readFile ?? readFile;
  const realpathImpl = overrides.realpath ?? realpath;
  const environment = overrides.environment ?? process.env;
  const releaseSha = environment.SAM27_EXPECTED_RELEASE_SHA ?? "";
  if (!SHA_PATTERN.test(releaseSha)) fail("invalid_release_sha");

  const releaseRoot = `${RELEASES}/${releaseSha}`;
  const [currentRelease, manifestText, environmentText] = await Promise.all([
    realpathImpl(CURRENT),
    readFileImpl(`${releaseRoot}/manifest.json`, "utf8"),
    readFileImpl(ENV_FILE, "utf8"),
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
    stagingEnvironment.NEWME_STAGING_PROJECT_REF !== STAGING_REF
    || stagingEnvironment.NEXT_PUBLIC_SUPABASE_URL
      !== `https://${STAGING_REF}.supabase.co`
    || stagingEnvironment.NEXT_PUBLIC_SUPABASE_URL.includes(PRODUCTION_REF)
  ) {
    fail("refusing_non_staging_environment");
  }
  if (META_ENVIRONMENT_KEYS.some((key) => Boolean(stagingEnvironment[key]))) {
    fail("meta_must_be_disabled_in_staging");
  }

  const healthResponse = await fetchImpl(`${BASE_URL}/api/health`, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const healthBody = await responseJson(healthResponse);
  if (
    healthResponse.status !== 200
    || !exactNoStore(healthResponse)
    || JSON.stringify(healthBody) !== JSON.stringify({ status: "ok" })
  ) {
    fail("public_health_contract_failed");
  }

  const metaOAuthStart = await assertDisabled(
    fetchImpl,
    "/api/meta/oauth-start",
    { method: "GET" },
    "meta_oauth",
  );
  const metaOAuthCallback = await assertDisabled(
    fetchImpl,
    "/api/meta/oauth-callback?code=synthetic&state=synthetic",
    { method: "GET" },
    "meta_oauth",
  );
  const metaCapi = await assertDisabled(
    fetchImpl,
    "/api/leads/meta-capi",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event_name: "Lead" }),
    },
    "meta_capi",
  );
  const synthetic = await syntheticExecutionEvidence();

  return {
    schemaVersion: 1,
    linearId: "SAM-27",
    releaseSha,
    target: "staging-loopback",
    health: {
      status: "passed",
      httpStatus: 200,
      responseFields: ["status"],
    },
    disabledIntegrations: {
      metaOAuthStart,
      metaOAuthCallback,
      metaCapi,
      productionCallbackContacted: false,
    },
    syntheticExecution: {
      mode: "versioned_in_process_contract",
      ...synthetic,
    },
    cleanup: {
      status: "not_applicable",
      reason: "read_only_disabled_routes_and_in_process_synthetic_contract",
      fixtureIds: [],
    },
  };
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  if (process.argv.length !== 2) {
    console.error("SAM-27 staging UAT failed: unexpected_arguments");
    process.exitCode = 64;
  } else {
    try {
      console.log(JSON.stringify(await runSam27StagingUat()));
    } catch (error) {
      const code = error instanceof Sam27UatError
        ? error.code
        : "unexpected_failure";
      console.error(`SAM-27 staging UAT failed: ${code}`);
      process.exitCode = 1;
    }
  }
}
