import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("SAM-22 disposable PostgreSQL apply, org A/B, cleanup, and rollback gate", {
  timeout: 240_000,
}, () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["scripts/run-sam22-database-gate.mjs"],
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
      timeout: 220_000,
    },
  );
  assert.equal(
    result.status,
    0,
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  const evidence = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(evidence, {
    status: "passed",
    image: "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193",
    apply: "verified",
    org_a_b_rls: "verified",
    import_uniqueness: "verified",
    rollback_fail_closed: "verified",
    rollback: "verified",
    fixture_cleanup: "verified",
  });
});
