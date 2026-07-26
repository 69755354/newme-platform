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

const writeFixture = async (directory, { password = "test-only" } = {}) => {
  const sqlPath = join(directory, "gate.sql");
  const envPath = join(directory, "staging.env");
  await writeFile(sqlPath, "select 1 where false;\n", "utf8");
  await writeFile(
    envPath,
    [
      `NEWME_STAGING_PROJECT_REF=${projectRef}`,
      `SUPABASE_PROJECT_REF=${projectRef}`,
      `SUPABASE_DB_PASSWORD=${password}`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { sqlPath, envPath };
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
      fixture.envPath,
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
        missing.envPath,
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
        violation.envPath,
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

test("staging deploy binds trusted gate assets to the exact release SHA", async () => {
  const [deploy, install] = await Promise.all([
    readFile(new URL("scripts/deploy-staging.sh", root), "utf8"),
    readFile(new URL("scripts/install-staging-assets.sh", root), "utf8"),
  ]);

  for (const pattern of [
    /git hash-object "\$0"/,
    /\$SHA:scripts\/deploy-staging\.sh/,
    /\$SHA:scripts\/run-staging-live-security-gate\.sh/,
    /\$SHA:supabase\/security\/check-authenticated-security-definer-rpc-allowlist\.sql/,
    /installed live security gate assets do not match release SHA/,
    /run-staging-live-security-gate\.sh/,
  ]) assert.match(deploy, pattern);

  for (const pattern of [
    /run-staging-live-security-gate\.sh/,
    /check-authenticated-security-definer-rpc-allowlist\.sql/,
  ]) assert.match(install, pattern);
});
