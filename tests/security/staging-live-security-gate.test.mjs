import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const bash = process.platform === "win32"
  ? "C:\\Program Files\\Git\\bin\\bash.exe"
  : "bash";
const root = new URL("../../", import.meta.url);
const command = fileURLToPath(
  new URL("scripts/run-staging-live-security-gate.sh", root),
);
const projectRef = "bfsiibofuzoglziltgyd";
const passingBody = JSON.stringify({
  gate_version: "sam61-allowlist-v2",
  violations: [],
});

const writeFixture = async (
  directory,
  {
    project = projectRef,
    urlProject = projectRef,
    secret = "sb_secret_test_only",
    password = "",
    pat = "",
  } = {},
) => {
  const envPath = join(directory, "staging.env");
  await writeFile(
    envPath,
    [
      `NEWME_STAGING_PROJECT_REF=${project}`,
      `SUPABASE_PROJECT_REF=${project}`,
      `NEXT_PUBLIC_SUPABASE_URL=https://${urlProject}.supabase.co`,
      `SUPABASE_SERVICE_ROLE_KEY=${secret}`,
      `SUPABASE_DB_PASSWORD=${password}`,
      `SUPABASE_PAT=${pat}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return envPath;
};

const writeCurl = async (directory) => {
  const path = join(directory, "bash-env");
  await writeFile(
    path,
    `curl() {
  local output=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) output="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  [ -n "$output" ]
  local body="\${FAKE_CURL_BODY-}"
  [ -n "$body" ] || body='{}'
  printf '%s' "$body" > "$output"
  printf '%s' "\${FAKE_CURL_CODE:-200}"
}
`,
    "utf8",
  );
  return path;
};

const runGate = async (
  directory,
  fixtureOptions = {},
  { body = passingBody, code = "200", expectedRef = projectRef } = {},
) => {
  const envPath = await writeFixture(directory, fixtureOptions);
  const bashEnv = await writeCurl(directory);
  return run(
    bash,
    [command, expectedRef, envPath],
    {
      env: {
        ...process.env,
        BASH_ENV: bashEnv,
        FAKE_CURL_BODY: body,
        FAKE_CURL_CODE: code,
      },
    },
  );
};

test("live gate accepts the exact version with zero violations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-live-gate-pass-"));
  try {
    const result = await runGate(directory);
    assert.match(
      result.stdout,
      /staging live security gate passed.*sam61-allowlist-v2/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live gate fails closed on HTTP errors, stale versions, and violations", async () => {
  const cases = [
    {
      body: JSON.stringify({
        gate_version: "sam61-allowlist-v2",
        violations: [],
      }),
      code: "403",
      expected: /returned HTTP 403/,
    },
    {
      body: JSON.stringify({ gate_version: "stale", violations: [] }),
      code: "200",
      expected: /stale gate or SECURITY DEFINER violations/,
    },
    {
      body: JSON.stringify({
        gate_version: "sam61-allowlist-v2",
        violations: [{ violation: "anon_execute", regprocedure: "unsafe()" }],
      }),
      code: "200",
      expected: /stale gate or SECURITY DEFINER violations/,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const directory = await mkdtemp(
      join(tmpdir(), `newme-live-gate-fail-${index}-`),
    );
    try {
      await assert.rejects(
        runGate(directory, {}, item),
        item.expected,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("live gate rejects target drift and administrative runtime credentials", async () => {
  const cases = [
    {
      fixture: { project: "aaaaaaaaaaaaaaaaaaaa" },
      expected: /NEWME_STAGING_PROJECT_REF does not match/,
    },
    {
      fixture: { urlProject: "aaaaaaaaaaaaaaaaaaaa" },
      expected: /staging Supabase URL does not match/,
    },
    {
      fixture: { secret: "" },
      expected: /dedicated staging Supabase secret key is missing/,
    },
    {
      fixture: { password: "must-not-reach-runtime" },
      expected: /database password is forbidden in staging runtime/,
    },
    {
      fixture: { pat: "must-not-reach-runtime" },
      expected: /Supabase PAT is forbidden in staging runtime/,
    },
  ];

  for (const [index, item] of cases.entries()) {
    const directory = await mkdtemp(
      join(tmpdir(), `newme-live-gate-boundary-${index}-`),
    );
    try {
      await assert.rejects(
        runGate(directory, item.fixture),
        item.expected,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const productionDirectory = await mkdtemp(
    join(tmpdir(), "newme-live-gate-production-"),
  );
  try {
    await assert.rejects(
      runGate(
        productionDirectory,
        {
          project: "vfopmpxlhwzpxqegayew",
          urlProject: "vfopmpxlhwzpxqegayew",
        },
        { expectedRef: "vfopmpxlhwzpxqegayew" },
      ),
      /production Supabase ref is forbidden/,
    );
  } finally {
    await rm(productionDirectory, { recursive: true, force: true });
  }
});

test("staging deploy binds and runs the live gate before promotion", async () => {
  const [deploy, install, runner, migration] = await Promise.all([
    readFile(new URL("scripts/deploy-staging.sh", root), "utf8"),
    readFile(new URL("scripts/install-staging-assets.sh", root), "utf8"),
    readFile(new URL("scripts/run-staging-live-security-gate.sh", root), "utf8"),
    readFile(
      new URL(
        "supabase/migrations/20260726215500_harden_security_definer_allowlist_gate_rpc.sql",
        root,
      ),
      "utf8",
    ),
  ]);

  const orderedPatterns = [
    /release SHA must equal canonical remote staging branch/,
    /git hash-object "\$0"/,
    /"\$LIVE_GATE_RUNNER" \\\n/,
    /artifact checksum mismatch/,
    /tar --no-same-owner/,
    /PROMOTED=1\r?\n\r?\nln -s "\$RELEASE" "\$CURRENT_NEXT"\r?\nmv -Tf "\$CURRENT_NEXT" "\$CURRENT"/,
  ];
  let lastIndex = -1;
  for (const pattern of orderedPatterns) {
    const match = deploy.match(pattern);
    assert.ok(match, `missing deploy pattern ${pattern}`);
    const index = deploy.indexOf(match[0]);
    assert.ok(index > lastIndex, `${pattern} is out of fail-closed order`);
    lastIndex = index;
  }

  for (const pattern of [
    /\$SHA:scripts\/deploy-staging\.sh/,
    /\$SHA:scripts\/run-staging-live-security-gate\.sh/,
    /installed live security gate assets do not match release SHA/,
  ]) assert.match(deploy, pattern);

  for (const pattern of [
    /run-staging-live-security-gate\.sh/,
    /rm -f -- \/opt\/newme-staging\/control\/check-staging-live-gate-evidence\.mjs/,
  ]) assert.match(install, pattern);

  for (const obsolete of [
    /security-definer-live-gate\.json/,
    /validation\/\$SHA/,
    /SUPABASE_DB_PASSWORD/,
    /live-gate\.env/,
  ]) {
    assert.doesNotMatch(deploy, obsolete);
    assert.doesNotMatch(install, obsolete);
  }

  assert.match(runner, /GATE_VERSION="sam61-allowlist-v2"/);
  assert.match(runner, /printf 'header = "apikey: %s"/);
  assert.match(runner, /curl \\\r?\n\s+--config -/);
  assert.doesNotMatch(runner, /Authorization: Bearer/);
  assert.doesNotMatch(runner, /--header "apikey:/);

  assert.match(migration, /'gate_version', 'sam61-allowlist-v2'/);
  assert.match(migration, /SECURITY INVOKER/);
  assert.match(migration, /FROM actual AS a\r?\n\s+WHERE NOT \(/);
  assert.doesNotMatch(
    migration,
    /FROM actual AS a\r?\n\s+JOIN expected AS e USING \(regprocedure\)\r?\n\s+WHERE NOT \(/,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION public\.security_definer_rpc_allowlist_gate\(\)\r?\nFROM PUBLIC, anon, authenticated;/,
  );
});

