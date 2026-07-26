import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

const writeFixture = async (
  directory,
  {
    password = "test-only",
    runtimePassword = "",
    gateLines = [],
  } = {},
) => {
  const sqlPath = join(directory, "gate.sql");
  const runtimeEnvPath = join(directory, "staging.env");
  const gateEnvPath = join(directory, "live-gate.env");
  const caPath = join(directory, "supabase-ca.crt");
  await writeFile(sqlPath, "select 1 where false;\n", "utf8");
  await writeFile(caPath, "test-only-ca\n", "utf8");
  await writeFile(
    runtimeEnvPath,
    [
      `NEWME_STAGING_PROJECT_REF=${projectRef}`,
      `SUPABASE_PROJECT_REF=${projectRef}`,
      ...(runtimePassword === ""
        ? []
        : [`SUPABASE_DB_PASSWORD=${runtimePassword}`]),
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    gateEnvPath,
    [
      `SUPABASE_DB_PASSWORD=${password}`,
      `SUPABASE_DB_SSLROOTCERT=${caPath.replaceAll("\\", "/")}`,
      ...gateLines,
      "",
    ].join("\n"),
    "utf8",
  );
  return { sqlPath, runtimeEnvPath, gateEnvPath };
};

const writePsql = async (directory, output = "") => {
  const bin = join(directory, "bin");
  const path = join(bin, "psql");
  await mkdir(bin);
  await writeFile(
    path,
    `#!/usr/bin/env bash\nprintf '%s' '${output}'\n`,
    "utf8",
  );
  await chmod(path, 0o755);
  return bin;
};

test("live gate executes psql and accepts a zero-row result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "newme-live-db-pass-"));
  try {
    const fixture = await writeFixture(directory);
    const bin = await writePsql(directory);
    const result = await run(bash, [
      command,
      fixture.sqlPath,
      projectRef,
      fixture.runtimeEnvPath,
      fixture.gateEnvPath,
    ], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
    assert.match(result.stdout, /staging live security gate passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live gate fails closed on missing credentials and database violations", async () => {
  const missingDirectory = await mkdtemp(join(tmpdir(), "newme-live-db-empty-"));
  const violationDirectory = await mkdtemp(
    join(tmpdir(), "newme-live-db-violation-"),
  );
  try {
    const missing = await writeFixture(missingDirectory, { password: "" });
    const missingBin = await writePsql(missingDirectory);
    await assert.rejects(
      run(bash, [
        command,
        missing.sqlPath,
        projectRef,
        missing.runtimeEnvPath,
        missing.gateEnvPath,
      ], {
        env: {
          ...process.env,
          PATH: `${missingBin}${delimiter}${process.env.PATH}`,
        },
      }),
      /cleanroom database password is not configured/,
    );

    const violation = await writeFixture(violationDirectory);
    const violationBin = await writePsql(
      violationDirectory,
      "unsafe_search_path|get_my_role()\n",
    );
    await assert.rejects(
      run(bash, [
        command,
        violation.sqlPath,
        projectRef,
        violation.runtimeEnvPath,
        violation.gateEnvPath,
      ], {
        env: {
          ...process.env,
          PATH: `${violationBin}${delimiter}${process.env.PATH}`,
        },
      }),
      /cleanroom returned SECURITY DEFINER allowlist violations/,
    );
  } finally {
    await rm(missingDirectory, { recursive: true, force: true });
    await rm(violationDirectory, { recursive: true, force: true });
  }
});

test("live gate rejects runtime credentials, wrong refs, and unreviewed hosts", async () => {
  const runtimeSecretDirectory = await mkdtemp(
    join(tmpdir(), "newme-live-db-runtime-secret-"),
  );
  const wrongRefDirectory = await mkdtemp(
    join(tmpdir(), "newme-live-db-wrong-ref-"),
  );
  const wrongHostDirectory = await mkdtemp(
    join(tmpdir(), "newme-live-db-wrong-host-"),
  );
  try {
    for (const [directory, fixtureOptions, expectedError] of [
      [
        runtimeSecretDirectory,
        { runtimePassword: "must-not-reach-runtime" },
        /database password is forbidden in staging runtime/,
      ],
      [
        wrongRefDirectory,
        { gateLines: ["SUPABASE_PROJECT_REF=aaaaaaaaaaaaaaaaaaaa"] },
        /must not redefine project refs/,
      ],
      [
        wrongHostDirectory,
        { gateLines: ["SUPABASE_DB_HOST=attacker.example.com"] },
        /database host is not the reviewed staging endpoint/,
      ],
    ]) {
      const fixture = await writeFixture(directory, fixtureOptions);
      const bin = await writePsql(directory);
      await assert.rejects(
        run(bash, [
          command,
          fixture.sqlPath,
          projectRef,
          fixture.runtimeEnvPath,
          fixture.gateEnvPath,
        ], {
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
          },
        }),
        expectedError,
      );
    }
  } finally {
    await Promise.all([
      rm(runtimeSecretDirectory, { recursive: true, force: true }),
      rm(wrongRefDirectory, { recursive: true, force: true }),
      rm(wrongHostDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("staging deploy binds trusted gate assets to the exact release SHA", async () => {
  const [deploy, install] = await Promise.all([
    readFile(new URL("scripts/deploy-staging.sh", root), "utf8"),
    readFile(new URL("scripts/install-staging-assets.sh", root), "utf8"),
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
    /\$SHA:supabase\/security\/check-authenticated-security-definer-rpc-allowlist\.sql/,
    /installed live security gate assets do not match release SHA/,
    /live-gate\.env/,
  ]) assert.match(deploy, pattern);

  for (const pattern of [
    /run-staging-live-security-gate\.sh/,
    /check-authenticated-security-definer-rpc-allowlist\.sql/,
    /rm -f -- \/opt\/newme-staging\/control\/check-staging-live-gate-evidence\.mjs/,
  ]) assert.match(install, pattern);

  for (const obsolete of [
    /security-definer-live-gate\.json/,
    /validation\/\$SHA/,
  ]) {
    assert.doesNotMatch(deploy, obsolete);
    assert.doesNotMatch(install, obsolete);
  }
});
