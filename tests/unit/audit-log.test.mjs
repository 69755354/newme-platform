// S7: application-layer audit rows (login, role assignment, export). Rows carry
// the actor id only, short codes and counts -- never e-mail, names, notes or IPs.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { AUDIT_ACTIONS, accountKey, buildAuditRow, createThrottle } from "../../src/lib/audit-log-row.mjs";

const ACTOR = "7c4f1a2e-1111-4111-8111-111111111111";
const TARGET = "8d5f2b3f-2222-4222-8222-222222222222";

test("row keeps actor and target ids and safe codes only", () => {
  const row = buildAuditRow({
    actorId: ACTOR, action: AUDIT_ACTIONS.ROLE_ASSIGNED, targetType: "user", targetId: TARGET,
    details: { new_role: "sales", previous_role: "none", email: "a@b.co", customer_name: "Fatima Al Mansouri", note: "free text with spaces", count: 3 },
  });
  assert.deepEqual(row, {
    actor_id: ACTOR, action: "role_assigned", target_type: "user", target_id: TARGET,
    details: { new_role: "sales", previous_role: "none", count: 3 },
  });
  assert.ok(!("actor_email" in row) && !("ip_address" in row) && !("user_agent" in row));
});

test("non-uuid actor or target ids are dropped, bad actions refused", () => {
  const row = buildAuditRow({ actorId: "not-a-uuid", action: "login_failure", targetId: "also-bad" });
  assert.equal(row.actor_id, null);
  assert.equal(row.target_id, null);
  assert.throws(() => buildAuditRow({ action: "Login Failure!" }), /audit_action_invalid/);
});

test("account key is a keyed HMAC: stable, case-insensitive, secret-dependent, not a plain hash", () => {
  const secret = "test-only-audit-secret-0123456789";
  assert.equal(accountKey(" Rep@Example.com ", secret), accountKey("rep@example.com", secret));
  assert.match(accountKey("rep@example.com", secret), /^[0-9a-f]{16}$/);
  assert.notEqual(accountKey("rep@example.com", secret), accountKey("rep@example.com", "another-test-secret-0123456789"));
  const plain = createHash("sha256").update("rep@example.com").digest("hex").slice(0, 16);
  assert.notEqual(accountKey("rep@example.com", secret), plain, "an attacker hashing known e-mails must not match");
});

test("account key is null (identifier omitted) when the secret is missing or too short", () => {
  assert.equal(accountKey("rep@example.com", undefined), null);
  assert.equal(accountKey("rep@example.com", ""), null);
  assert.equal(accountKey("rep@example.com", "short"), null);
});

test("failure throttle lets one row per key through per window and is bounded", () => {
  let now = 1000;
  const allow = createThrottle({ windowMs: 60_000, maxKeys: 3, now: () => now });
  assert.equal(allow("a:x"), true);
  assert.equal(allow("a:x"), false);
  now += 61_000;
  assert.equal(allow("a:x"), true);
  assert.equal(allow("b:x"), true);
  assert.equal(allow("c:x"), true);
  assert.equal(allow("d:x"), false, "table full of live keys refuses instead of growing");
});

test("S7 review: both export routes (quotation CSV and cable-costing workbook) write a data_export audit row", async () => {
  for (const path of ["../../src/app/api/quotations/export/route.ts", "../../src/app/api/cable-costing/export/route.ts"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /from "@\/lib\/audit-log"/, path);
    assert.match(source, /action: AUDIT_ACTIONS\.DATA_EXPORT/, path);
    assert.match(source, /actorId: user\.id/, path);
  }
  const cable = await readFile(new URL("../../src/app/api/cable-costing/export/route.ts", import.meta.url), "utf8");
  const call = cable.match(/writeAuditLog\(\{[\s\S]*?\}\);/)[0];
  assert.ok(!/result|config|quantities|areaSqm/.test(call), "no workbook figures in the audit row");
  const row = buildAuditRow({ actorId: ACTOR, action: AUDIT_ACTIONS.DATA_EXPORT, targetType: "cable_costing", details: { format: "xlsx", tier: "internal" } });
  assert.deepEqual(row.details, { format: "xlsx", tier: "internal" });
});
