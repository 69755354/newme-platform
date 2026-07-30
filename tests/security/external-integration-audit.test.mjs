import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditExternalIntegrationSurface } from "../../scripts/audit-external-integration-surface.mjs";

test("offline audit inventories guarded integration and observability entrypoints without reading secrets", async () => {
  const report = await auditExternalIntegrationSurface(process.cwd());
  assert.equal(report.mode, "offline");
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((check) => check.id),
    [
      "health-minimal-response",
      "readiness-token-and-timeout",
      "monitoring-endpoint-retired",
      "meta-oauth-state",
      "meta-oauth-bounded-delivery",
      "enabled-integration-runtime-policies",
      "authenticated-notification-trigger",
      "webhook-cron-audit-alert-contract",
      "cron-route-guards",
    ],
  );
  assert.ok(report.checks.every((check) => check.status === "pass"));
  assert.doesNotMatch(JSON.stringify(report), /SUPABASE_SERVICE_ROLE_KEY|CRON_SECRET=|META_APP_SECRET=/);
});

test("offline audit fails closed when an expected guard is absent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "newme-sam27-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "health.ts"), "export function GET() { return {}; }\n");
  const report = await auditExternalIntegrationSurface(root, {
    checks: [{ id: "must-have-token", file: "health.ts", patterns: ["NEWME_READINESS_TOKEN"] }],
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks, [{ id: "must-have-token", status: "fail", missing: ["NEWME_READINESS_TOKEN"] }]);
});
