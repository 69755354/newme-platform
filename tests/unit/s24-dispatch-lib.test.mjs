import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENTION_STATUSES, DECISION_ACTIONS, DISPATCH_STATUSES, DUPLICATE_DECISIONS, STAFF_ROLES,
  allowedActions, canDecide, isUuid, mapDbError, parseDecideInput, parseReopenInput, parseResolveInput, sweepWindowStart,
} from "../../src/lib/lead-dispatch.mjs";

test("the seven states are listed, attention states first", () => {
  assert.deepEqual([...DISPATCH_STATUSES], ["missing_intake_data", "review_phone", "duplicate_review", "unassigned", "delivered", "duplicate_not_dispatched", "excluded_test"]);
  assert.deepEqual([...ATTENTION_STATUSES], ["missing_intake_data", "review_phone", "duplicate_review", "unassigned"]);
  assert.deepEqual([...DUPLICATE_DECISIONS], ["merged", "kept_separate", "invalid"]);
  assert.equal(DECISION_ACTIONS.length, 7);
});

test("admin, boss and operator decide; admin and boss are equal; sales and others do not", () => {
  for (const role of ["admin", "boss", "operator"]) assert.equal(canDecide(role), true, role);
  for (const role of ["sales", "finance", "designer", "", undefined, null]) assert.equal(canDecide(role), false, String(role));
  assert.deepEqual([...STAFF_ROLES].sort(), ["admin", "boss", "operator"]);
});

test("decide input: action must be known and the reason rules match the database", () => {
  assert.equal(parseDecideInput({ action: "teleport" }).ok, false);
  assert.equal(parseDecideInput(null).ok, false);
  assert.deepEqual(parseDecideInput({ action: "reevaluate" }), { ok: true, value: { action: "reevaluate", reason: null } });
  assert.deepEqual(parseDecideInput({ action: "confirm_phone", reason: "  called  " }).value, { action: "confirm_phone", reason: "called" });
  assert.equal(parseDecideInput({ action: "release_missing", reason: "too short" }).ok, false);
  assert.equal(parseDecideInput({ action: "release_missing", reason: "approved hand-over by the manager" }).ok, true);
  assert.equal(parseDecideInput({ action: "mark_test", reason: "ab" }).ok, false);
  assert.equal(parseDecideInput({ action: "unmark_test", reason: "real customer" }).ok, true);
  assert.equal(parseDecideInput({ action: "note", reason: "  " }).ok, false);
  assert.equal(parseDecideInput({ action: "note", reason: "x".repeat(1001) }).ok, false);
  assert.deepEqual(parseDecideInput({ action: "release_missing", reason: "short" }).errors, { reason: "required" });
});

test("duplicate decisions: notes are required for invalid and kept_separate", () => {
  assert.equal(parseResolveInput({ decision: "merged" }).ok, true);
  assert.equal(parseResolveInput({ decision: "merged", notes: "same person" }).value.notes, "same person");
  assert.equal(parseResolveInput({ decision: "kept_separate" }).ok, false);
  assert.equal(parseResolveInput({ decision: "kept_separate", notes: "two people" }).ok, true);
  assert.equal(parseResolveInput({ decision: "invalid", notes: "no" }).ok, false);
  assert.equal(parseResolveInput({ decision: "withdrawn", notes: "x".repeat(10) }).ok, false);
  assert.equal(parseResolveInput({ decision: "pending" }).ok, false);
  assert.equal(parseReopenInput({ reason: "mistake" }).ok, true);
  assert.equal(parseReopenInput({ reason: "no" }).ok, false);
  assert.equal(parseReopenInput({}).ok, false);
});

test("allowed actions follow the state row", () => {
  assert.deepEqual(allowedActions({ status: "review_phone", phone_flag: "suspect", missing_fields: [], release_reason: null }),
    ["confirm_phone", "mark_test", "note", "reevaluate"]);
  assert.deepEqual(allowedActions({ status: "review_phone", phone_flag: "invalid", missing_fields: [], release_reason: null }),
    ["mark_test", "note", "reevaluate"]);
  assert.deepEqual(allowedActions({ status: "missing_intake_data", phone_flag: "ok", missing_fields: ["customer_name"], release_reason: null }),
    ["release_missing", "mark_test", "note", "reevaluate"]);
  assert.deepEqual(allowedActions({ status: "delivered", phone_flag: "ok", missing_fields: ["customer_name"], release_reason: "approved by the manager" }),
    ["revoke_release", "mark_test", "note", "reevaluate"]);
  assert.deepEqual(allowedActions({ status: "excluded_test", phone_flag: "ok", missing_fields: [], release_reason: null }),
    ["unmark_test", "note", "reevaluate"]);
});

test("database errors map to stable codes", () => {
  assert.deepEqual(mapDbError({ code: "42P01" }), { status: 503, code: "feature_unavailable" });
  assert.deepEqual(mapDbError({ code: "PGRST202" }), { status: 503, code: "feature_unavailable" });
  assert.deepEqual(mapDbError({ code: "42883" }), { status: 503, code: "feature_unavailable" });
  assert.deepEqual(mapDbError({ code: "42501" }), { status: 403, code: "forbidden" });
  assert.deepEqual(mapDbError({ code: "22023", message: "unknown_review" }), { status: 404, code: "unknown_review" });
  assert.deepEqual(mapDbError({ code: "22023", message: "unknown_lead" }), { status: 404, code: "unknown_lead" });
  assert.deepEqual(mapDbError({ code: "22023", message: "review_already_decided" }), { status: 409, code: "review_already_decided" });
  assert.deepEqual(mapDbError({ code: "22023", message: "reason_required" }), { status: 422, code: "reason_required" });
  assert.deepEqual(mapDbError({ code: "22023", message: "phone_not_confirmable" }), { status: 409, code: "phone_not_confirmable" });
  assert.deepEqual(mapDbError({ code: "22023", message: "something else" }), { status: 422, code: "invalid_value" });
  assert.deepEqual(mapDbError({ code: "XX000", message: "secret detail" }), { status: 500, code: "internal" });
  assert.deepEqual(mapDbError(null), { status: 500, code: "internal" });
});

test("the sweep window is seven days and the id check is strict", () => {
  assert.equal(sweepWindowStart(new Date("2026-11-19T10:00:00Z")), "2026-11-12T10:00:00.000Z");
  assert.equal(isUuid("24000000-0000-4000-8000-000000000001"), true);
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(undefined), false);
});
