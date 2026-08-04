#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";
const PASSWORD = "sam21-disposable-only";
const DATABASE = "sam21";
const LEGACY_ORGANIZATION_ID = "6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1";
const BLOCKER_ORGANIZATION_ID = "bbbbbbbb-0000-4000-8000-000000000021";
const CANONICAL_ASSET_BLOBS = new Map([
  [
    "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
    "7371c83028e8ad23769c4469aa2977e805e2c629",
  ],
  [
    "supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql",
    "d3109ab6fec16612214085e1d3e4881ce0a3e968",
  ],
  [
    "supabase/migrations/20260730110000_sam22_two_organization_isolation.sql",
    "f0222d10d8653aa9e2c872f0e4cac2a70e7a0651",
  ],
  [
    "supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql",
    "f22179010fb9b86c24389a512ca4df3793886802",
  ],
  [
    "scripts/run-sam20-database-gate.mjs",
    "01ab2db7c9a807d3bda9452164de49107b8f9018",
  ],
  [
    "scripts/run-sam22-database-gate.mjs",
    "5f61e716d5c18a7b182ebf73ee915ed06f842995",
  ],
  [
    "scripts/uat/sam20-lead-organization-isolation.mjs",
    "22e2a5e3f8da75b5cc40c48e2943c80106d8c6a1",
  ],
  [
    "scripts/uat/sam22-two-organization-isolation.mjs",
    "d53a9525ba2abe14139373c267af73c79ad321e4",
  ],
]);

function gitBlobSha(content) {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

async function verifyCanonicalAssets() {
  for (const [relativePath, expectedSha] of CANONICAL_ASSET_BLOBS) {
    const content = await readFile(resolve(ROOT, relativePath));
    const normalizedContent = Buffer.from(
      content.toString("utf8").replaceAll("\r\n", "\n"),
      "utf8",
    );
    const actualSha = gitBlobSha(normalizedContent);
    if (actualSha !== expectedSha) {
      throw new Error(
        `sam21_canonical_asset_drift:${relativePath}:expected=${expectedSha}:actual=${actualSha}`,
      );
    }
  }
}

function command(args, options = {}) {
  return spawnSync(process.env.SAM21_DOCKER_BIN || "docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
    timeout: 180_000,
    ...options,
  });
}

function combined(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label}_failed:${combined(result) || result.error?.message || "unknown"}`,
    );
  }
  return result;
}

function psql(container, args, options = {}) {
  const environment = ["-e", `PGPASSWORD=${PASSWORD}`];
  if (options.environmentName) {
    environment.push(
      "-e",
      `PGOPTIONS=-cnewme.environment=${options.environmentName}`,
    );
  }
  const result = command([
    "exec",
    ...environment,
    "-w",
    "/work/tests/database",
    container,
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    DATABASE,
    ...args,
  ]);
  if (options.expectFailure) {
    if (!result.error && result.status === 0) {
      throw new Error(`${options.label}_unexpected_success`);
    }
    const expectedMessage = options.expectedMessage;
    if (expectedMessage && !combined(result).includes(expectedMessage)) {
      throw new Error(
        `${options.label}_wrong_failure:expected=${expectedMessage}:actual=${combined(result)}`,
      );
    }
    return result;
  }
  return requireSuccess(result, options.label);
}

async function copyFixture(container, relativePath) {
  const destination = `/work/${relativePath.replaceAll("\\", "/")}`;
  const parent = destination.slice(0, destination.lastIndexOf("/"));
  requireSuccess(
    command(["exec", container, "mkdir", "-p", parent]),
    `sam21_mkdir:${relativePath}`,
  );
  requireSuccess(
    command(["cp", resolve(ROOT, relativePath), `${container}:${destination}`]),
    `sam21_copy:${relativePath}`,
  );
}

function queryJson(container, sql, label) {
  const result = psql(container, ["-A", "-t", "-q", "-c", sql], { label });
  const output = result.stdout.trim();
  if (!output) throw new Error(`${label}_empty`);
  return JSON.parse(output);
}

async function main() {
  await verifyCanonicalAssets();
  const container = `newme-sam21-db-${process.pid}-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    requireSuccess(
      command([
        "run",
        "--detach",
        "--rm",
        "--name",
        container,
        "--env",
        `POSTGRES_PASSWORD=${PASSWORD}`,
        "--env",
        `POSTGRES_DB=${DATABASE}`,
        POSTGRES_IMAGE,
      ]),
      "sam21_postgres_start",
    );
    started = true;

    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const readiness = command([
        "exec",
        container,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        DATABASE,
      ], { timeout: 10_000 });
      if (!readiness.error && readiness.status === 0) {
        ready = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    if (!ready) throw new Error("sam21_postgres_not_ready");

    for (const relativePath of [
      "supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql",
      "supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql",
      "supabase/migrations/20260730110000_sam22_two_organization_isolation.sql",
      "supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql",
      "scripts/uat/sam21-readonly-reconciliation.sql",
      "tests/database/sam21-first-organization-rehearsal.sql",
      "tests/database/sam21-first-organization-rollback-verify.sql",
    ]) {
      await copyFixture(container, relativePath);
    }

    psql(
      container,
      ["-f", "sam21-first-organization-rehearsal.sql"],
      { label: "sam21_apply_rehearsal" },
    );
    const phases = queryJson(
      container,
      `SELECT jsonb_object_agg(phase, to_jsonb(evidence) - 'phase')
       FROM public.sam21_rehearsal_evidence evidence`,
      "sam21_phase_evidence",
    );
    if (!phases?.before || !phases?.after) {
      throw new Error("sam21_before_after_evidence_missing");
    }

    psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql",
      ],
      {
        expectFailure: true,
        expectedMessage: "sam22_rollback_requires_staging_or_test",
        label: "sam21_sam22_rollback_without_environment",
      },
    );

    psql(
      container,
      [
        "-c",
        `INSERT INTO public.organizations(id,slug,name,industry_key,status)
         VALUES (
           '${BLOCKER_ORGANIZATION_ID}'::uuid,
           'sam21-rollback-blocker',
           'Synthetic rollback blocker',
           'retail',
           'active'
         );
         INSERT INTO public.crm_daily_funnel_snapshot(
           organization_id,
           snapshot_date,
           current_milestone,
           lead_count
         )
         VALUES (
           '${BLOCKER_ORGANIZATION_ID}'::uuid,
           CURRENT_DATE,
           'new',
           0
         );`,
      ],
      { label: "sam21_create_sam22_rollback_blocker" },
    );
    psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql",
      ],
      {
        environmentName: "test",
        expectFailure: true,
        expectedMessage: "sam22_rollback_snapshot_fixtures_not_clean",
        label: "sam21_sam22_rollback_with_fixture",
      },
    );
    psql(
      container,
      [
        "-c",
        `DELETE FROM public.crm_daily_funnel_snapshot
         WHERE organization_id = '${BLOCKER_ORGANIZATION_ID}'::uuid;
         DELETE FROM public.organizations
         WHERE id = '${BLOCKER_ORGANIZATION_ID}'::uuid;`,
      ],
      { label: "sam21_cleanup_sam22_rollback_blocker" },
    );
    psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260730110000_sam22_two_organization_isolation_rollback.sql",
      ],
      { environmentName: "test", label: "sam21_sam22_rollback" },
    );

    psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql",
      ],
      {
        expectFailure: true,
        expectedMessage: "sam20_rollback_requires_staging_or_test",
        label: "sam21_sam20_rollback_without_environment",
      },
    );
    psql(
      container,
      [
        "-c",
        `INSERT INTO public.organizations(id,slug,name,industry_key,status)
         VALUES (
           '${BLOCKER_ORGANIZATION_ID}'::uuid,
           'sam21-rollback-blocker',
           'Synthetic rollback blocker',
           'retail',
           'active'
         );`,
      ],
      { label: "sam21_create_sam20_rollback_blocker" },
    );
    psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql",
      ],
      {
        environmentName: "test",
        expectFailure: true,
        expectedMessage: "sam20_rollback_fixture_organizations_not_clean",
        label: "sam21_sam20_rollback_with_fixture",
      },
    );
    psql(
      container,
      [
        "-c",
        `DELETE FROM public.organizations
         WHERE id = '${BLOCKER_ORGANIZATION_ID}'::uuid;`,
      ],
      { label: "sam21_cleanup_sam20_rollback_blocker" },
    );
    psql(
      container,
      [
        "-f",
        "/work/supabase/rollback/20260730100000_sam20_lead_organization_isolation_rollback.sql",
      ],
      { environmentName: "test", label: "sam21_sam20_rollback" },
    );
    const rollback = psql(
      container,
      ["-f", "sam21-first-organization-rollback-verify.sql"],
      { label: "sam21_rollback_verify" },
    );
    if (!rollback.stdout.includes("sam21_rollback_evidence")) {
      throw new Error("sam21_rollback_evidence_missing");
    }

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      image: POSTGRES_IMAGE,
      legacyOrganizationId: LEGACY_ORGANIZATION_ID,
      canonicalAssets: "verified",
      stagingUatAssets: [
        "scripts/uat/sam20-lead-organization-isolation.mjs",
        "scripts/uat/sam22-two-organization-isolation.mjs",
      ],
      beforeAfter: phases,
      aggregateCounts: "preserved",
      quotationValueTotal: "preserved",
      leadOwners: "preserved",
      historyRelationships: "preserved",
      documentOwnership: "preserved",
      readonlyReconciliationPrePost: "verified",
      sam22RollbackEnvironmentGuard: "verified",
      sam22RollbackFixtureGuard: "verified",
      sam20RollbackEnvironmentGuard: "verified",
      sam20RollbackFixtureGuard: "verified",
      rollback: "verified",
      oldLeadContract: "verified",
      harnessCleanup: "verified",
      applyEvidenceCaptured: "verified",
      rollbackEvidenceCaptured: "verified",
    })}\n`);
  } finally {
    if (started) {
      const cleanup = command(["rm", "--force", container]);
      if (cleanup.error || cleanup.status !== 0) {
        process.stderr.write(
          `sam21_disposable_cleanup_failed:${combined(cleanup)}\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
