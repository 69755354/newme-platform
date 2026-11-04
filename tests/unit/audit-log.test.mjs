// S7: application-layer audit rows (login, role assignment, export). Rows carry
// the actor id only, short codes and counts -- never e-mail, names, notes or IPs.
import assert from "node:assert/strict";
import test from "node:test";
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

test("account key is stable, case-insensitive and does not contain the address", () => {
  assert.equal(accountKey(" Rep@Example.com "), accountKey("rep@example.com"));
  assert.match(accountKey("rep@example.com"), /^[0-9a-f]{16}$/);
  assert.ok(!accountKey("rep@example.com").includes("rep"));
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
