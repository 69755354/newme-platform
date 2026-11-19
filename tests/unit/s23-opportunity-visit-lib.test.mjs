import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  STAFF_ROLES, canWorkOnLead, canReviewVisits, nextWorkingDay0930, visitReportStatus,
  parseOpportunityInput, parseVisitInput, mapDbError, dubaiLocalToIso, isoToDubaiLocal,
} from "../../src/lib/opportunity-visit.mjs";

const LEAD = "23000000-0000-4000-8000-000000000001";
const STAGES = [
  { key: "new", requires_quote: false, active: true },
  { key: "quotation_sent", requires_quote: true, active: true },
  { key: "won", requires_quote: true, active: true },
  { key: "on_hold", requires_quote: false, active: false },
];

test("who may work on a lead and who may approve or review", () => {
  assert.deepEqual([...STAFF_ROLES].sort(), ["admin", "boss", "operator"]);
  assert.equal(canWorkOnLead("admin", "u1", { assigned_to: "u2" }), true);
  assert.equal(canWorkOnLead("boss", "u1", { assigned_to: "u2" }), true, "admin and boss are equal");
  assert.equal(canWorkOnLead("operator", "u1", { assigned_to: null }), true);
  assert.equal(canWorkOnLead("sales", "u1", { assigned_to: "u1" }), true);
  assert.equal(canWorkOnLead("sales", "u1", { assigned_to: "u2" }), false);
  assert.equal(canWorkOnLead("sales", "u1", { assigned_to: null }), false);
  for (const role of ["finance", "designer", "", undefined]) assert.equal(canWorkOnLead(role, "u1", { assigned_to: "u1" }), false);
  assert.equal(canReviewVisits("admin"), true);
  assert.equal(canReviewVisits("boss"), true);
  assert.equal(canReviewVisits("operator"), true);
  assert.equal(canReviewVisits("sales"), false);
});

test("report due time is 09:30 Dubai on the next working day (Monday to Friday)", () => {
  assert.equal(nextWorkingDay0930("2026-11-19T06:00:00Z"), "2026-11-20T05:30:00.000Z"); // Thursday -> Friday
  assert.equal(nextWorkingDay0930("2026-11-20T06:00:00Z"), "2026-11-23T05:30:00.000Z"); // Friday -> Monday
  assert.equal(nextWorkingDay0930("2026-11-21T06:00:00Z"), "2026-11-23T05:30:00.000Z"); // Saturday -> Monday
  assert.equal(nextWorkingDay0930("2026-11-22T06:00:00Z"), "2026-11-23T05:30:00.000Z"); // Sunday -> Monday
  // 22:30 UTC on Thursday is already Friday in Dubai
  assert.equal(nextWorkingDay0930("2026-11-19T22:30:00Z"), "2026-11-23T05:30:00.000Z");
  assert.equal(nextWorkingDay0930("not a date"), null);
});

test("the status rule matches the database function on every case of the database test", () => {
  const sql = fs.readFileSync(new URL("../../tests/database/s23-opportunities-visits.sql", import.meta.url), "utf8");
  const cases = [...sql.matchAll(/visit_report_status\('(\w+)', (null|'[^']+'), '(\w+)', '([^']+)', '([^']+)'\) = '(\w+)'/g)];
  assert.ok(cases.length >= 9, "the database test lists the status cases");
  for (const [, approval, submitted, review, due, now, expected] of cases) {
    const got = visitReportStatus({ plan_approval: approval, submitted_at: submitted === "null" ? null : submitted.slice(1, -1), review_status: review, report_due_at: due }, now);
    assert.equal(got, expected, `${approval}/${submitted}/${review}/${due}/${now}`);
  }
});

test("opportunity input: required fields, ranges, link shape and the quote rule", () => {
  const ok = parseOpportunityInput({ lead_id: LEAD, name: "  Villa A ", confirmed_requirement: "3 bedrooms" }, { stages: STAGES });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { lead_id: LEAD, name: "Villa A", confirmed_requirement: "3 bedrooms" });
  const bad = (body, field, code, options = {}) => {
    const r = parseOpportunityInput(body, { stages: STAGES, ...options });
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.errors[field], code, `${field}: ${JSON.stringify(r.errors)}`);
  };
  bad({ name: "x", confirmed_requirement: "y" }, "lead_id", "required");
  bad({ lead_id: "nope", name: "x", confirmed_requirement: "y" }, "lead_id", "invalid");
  bad({ lead_id: LEAD, name: "   ", confirmed_requirement: "y" }, "name", "required");
  bad({ lead_id: LEAD, name: "x".repeat(201), confirmed_requirement: "y" }, "name", "too_long");
  bad({ lead_id: LEAD, name: "x" }, "confirmed_requirement", "required");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", quote_amount_aed: -1 }, "quote_amount_aed", "out_of_range");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", quote_amount_aed: "abc" }, "quote_amount_aed", "invalid");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", quote_amount_aed: 1e10 }, "quote_amount_aed", "out_of_range");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", decision_target: "2019-12-31" }, "decision_target", "out_of_range");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", decision_target: "2101-01-01" }, "decision_target", "out_of_range");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", decision_target: "2026-02-30" }, "decision_target", "invalid");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", quotation_link: "javascript:alert(1)" }, "quotation_link", "invalid");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", quotation_link: "http://plain.example.test/q" }, "quotation_link", "invalid");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", stage: "nonsense" }, "stage", "unknown_stage");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", stage: "on_hold" }, "stage", "inactive_stage");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", stage: "won" }, "quote_amount_aed", "quote_required");
  bad({ lead_id: LEAD, name: "x", confirmed_requirement: "y", stage: "won", quote_amount_aed: 5 }, "quotation_link", "quote_required");
  const won = parseOpportunityInput({ lead_id: LEAD, name: "x", confirmed_requirement: "y", stage: "won", quote_amount_aed: "1250.5", quotation_link: "https://files.example.test/q.pdf", decision_target: "2026-12-01" }, { stages: STAGES });
  assert.equal(won.ok, true);
  assert.equal(won.value.quote_amount_aed, 1250.5);
  // unknown keys never reach the database
  const extra = parseOpportunityInput({ lead_id: LEAD, name: "x", confirmed_requirement: "y", archived: true, created_by: "u9", id: "z" }, { stages: STAGES });
  assert.deepEqual(Object.keys(extra.value).sort(), ["confirmed_requirement", "lead_id", "name"]);
});

test("opportunity update keeps only the fields sent and checks the quote rule against the stored row", () => {
  const stored = { stage: "new", quote_amount_aed: null, quotation_link: null };
  const r1 = parseOpportunityInput({ stage: "quotation_sent" }, { stages: STAGES, partial: true, existing: stored });
  assert.equal(r1.ok, false);
  assert.equal(r1.errors.quote_amount_aed, "quote_required");
  const r2 = parseOpportunityInput({ stage: "quotation_sent" }, { stages: STAGES, partial: true, existing: { ...stored, quote_amount_aed: 10, quotation_link: "https://files.example.test/a" } });
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.value, { stage: "quotation_sent" });
  const r3 = parseOpportunityInput({}, { stages: STAGES, partial: true, existing: stored });
  assert.equal(r3.ok, false);
  assert.equal(r3.errors._, "nothing_to_update");
  const r4 = parseOpportunityInput({ archived: true }, { stages: STAGES, partial: true, existing: stored });
  assert.deepEqual(r4.value, { archived: true });
});

test("visit input: plan fields, times, links", () => {
  const ok = parseVisitInput({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00+04:00", purpose: " Walkthrough ", location: "Showroom" });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.planned_at, "2026-11-25T02:00:00.000Z");
  assert.equal(ok.value.purpose, "Walkthrough");
  const bad = (body, field, code, options = {}) => {
    const r = parseVisitInput(body, options);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(r.errors[field], code, `${field}: ${JSON.stringify(r.errors)}`);
  };
  bad({ planned_at: "2026-11-25T06:00:00Z", purpose: "x" }, "lead_id", "required");
  bad({ lead_id: LEAD, purpose: "x" }, "planned_at", "required");
  bad({ lead_id: LEAD, planned_at: "tomorrow", purpose: "x" }, "planned_at", "invalid");
  bad({ lead_id: LEAD, planned_at: "2019-01-01T00:00:00Z", purpose: "x" }, "planned_at", "out_of_range");
  bad({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: " " }, "purpose", "required");
  bad({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: "x", opportunity_id: "bad" }, "opportunity_id", "invalid");
  bad({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: "x", evidence_link: "ftp://a/b" }, "evidence_link", "invalid");
  bad({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: "x", actual_start: "2026-11-25T08:00:00Z", actual_finish: "2026-11-25T07:00:00Z" }, "actual_finish", "before_start");
  bad({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: "x", next_followup_date: "2101-01-01" }, "next_followup_date", "out_of_range");
  bad({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: "x", result: "r".repeat(4001) }, "result", "too_long");
  const extra = parseVisitInput({ lead_id: LEAD, planned_at: "2026-11-25T06:00:00Z", purpose: "x", plan_approval: "approved", submitted_at: "2026-01-01T00:00:00Z", review_status: "accepted", report_due_at: "2026-01-01T00:00:00Z" });
  assert.deepEqual(Object.keys(extra.value).sort(), ["lead_id", "planned_at", "purpose"]);
  const partial = parseVisitInput({ result: "done" }, { partial: true });
  assert.deepEqual(partial.value, { result: "done" });
  // partial updates cannot move the visit to another lead
  assert.equal("lead_id" in parseVisitInput({ result: "x", lead_id: LEAD }, { partial: true }).value, false);
});

test("database errors become stable codes and statuses", () => {
  assert.deepEqual(mapDbError({ code: "23505" }), { status: 409, code: "duplicate" });
  assert.deepEqual(mapDbError({ code: "23514", message: "opportunity_quote_required" }), { status: 422, code: "opportunity_quote_required" });
  assert.deepEqual(mapDbError({ code: "23514", message: "visit_report_locked" }), { status: 409, code: "visit_report_locked" });
  assert.deepEqual(mapDbError({ code: "23514", message: "new row violates check constraint" }), { status: 422, code: "invalid_value" });
  assert.deepEqual(mapDbError({ code: "23503" }), { status: 422, code: "unknown_reference" });
  assert.deepEqual(mapDbError({ code: "42501" }), { status: 403, code: "forbidden" });
  assert.deepEqual(mapDbError({ code: "22023", message: "visit_plan_not_approved" }), { status: 409, code: "visit_plan_not_approved" });
  assert.deepEqual(mapDbError({ code: "22023", message: "unknown_visit" }), { status: 404, code: "unknown_visit" });
  assert.deepEqual(mapDbError({ code: "42P01" }), { status: 503, code: "feature_unavailable" });
  assert.deepEqual(mapDbError({ code: "PGRST205" }), { status: 503, code: "feature_unavailable" });
  assert.deepEqual(mapDbError({ code: "42883" }), { status: 503, code: "feature_unavailable" });
  assert.deepEqual(mapDbError({ code: "XX000", message: "secret internals" }), { status: 500, code: "internal" });
});

test("datetime-local values are Dubai time and round-trip", () => {
  assert.equal(dubaiLocalToIso("2026-11-25T14:30"), "2026-11-25T10:30:00.000Z");
  assert.equal(isoToDubaiLocal("2026-11-25T10:30:00.000Z"), "2026-11-25T14:30");
  assert.equal(isoToDubaiLocal(dubaiLocalToIso("2026-12-31T23:45")), "2026-12-31T23:45");
  assert.equal(dubaiLocalToIso(""), null);
  assert.equal(isoToDubaiLocal(null), "");
});
