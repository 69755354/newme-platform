/**
 * One payment state model, and it is the database's.
 *
 * Round-4 finding B8. Three components disagreed about what a payment is:
 *
 *   PostgreSQL   `confirmed` and `voided_at` are independent columns; every derived
 *                total is recomputed from `p.confirmed = true and p.voided_at is null`.
 *   list route   `select("*, contracts(contract_no, party_a_name)")` cast to `any[]`,
 *                with no allocation aggregation anywhere.
 *   the page     an interface declaring a non-optional `allocated_amount` that no
 *                payments row carries, no void fields at all, and
 *                `confirmed ? "confirmed" : "pending"` — which renders a VOIDED
 *                payment as pending cash, with a Confirm button that
 *                confirm_payment() answers with 22023 'a voided payment cannot be
 *                confirmed'.
 *
 * The two halves failed in different places, and the review item merges them. The
 * void columns did reach the client: `*` returns them. What dropped them was the
 * page's own interface, which did not declare them, so nothing rendered or filtered
 * on them. The allocation total is the route-side half — payments has no
 * `allocated_amount` column at all, so no select could have supplied it.
 *
 * The observable damage was arithmetic, so the deciding functions are EXECUTED here
 * rather than grepped: a source-reading test cannot tell "sums the right rows" from
 * "sums every row", and both spell the same keywords. What is read from source is
 * only the wiring — that the route sends the fields, that the page uses the model
 * instead of a second copy of it, and that the model's row guards still match the
 * routines' own refusals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  PAYMENT_STATES,
  PAYMENT_STATE_FILTERS,
  allocatedTotal,
  allocationDraftStatus,
  countsAsCash,
  filterPaymentsByState,
  hasAllocationData,
  isConfirmed,
  isFullyAllocated,
  isPending,
  isVoided,
  paymentAllowsAllocate,
  paymentAllowsConfirm,
  paymentAllowsVoid,
  paymentState,
  paymentTotals,
  unallocatedTotal,
} from "../../src/lib/payment-state.mjs";

const MODEL = "src/lib/payment-state.mjs";
const TYPES = "src/types/payments.ts";
const LIST_ROUTE = "src/app/api/payments/list/route.ts";
const PAGE = "src/app/(dashboard)/payments/page.tsx";
const ACTIONS = "src/app/actions/payments.ts";
const HELPER = "src/lib/request-auth-context.ts";
const VOID_ROUTE = "src/app/api/payments/[id]/void/route.ts";
const ROUND4 = "supabase/migrations/20260817000000_l0_round4_money_and_business_integrity.sql";

const read = (file) => fs.readFileSync(file, "utf8");

/**
 * Comments stripped. Every file involved here documents the defect it fixes by
 * quoting it, so a check that read the whole file would match its own header — the
 * mistake the B1 boundary test made.
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The last installed definition of a routine, which is what applying the migrations leaves. */
function routineBody(sql, routine) {
  const pattern = new RegExp(`create or replace function public\\.${routine}\\s*\\([\\s\\S]*?\\n\\$\\$;`, "g");
  const matches = [...sql.matchAll(pattern)];
  assert.ok(matches.length > 0, `${routine} is not defined in ${ROUND4}`);
  return matches[matches.length - 1][0];
}

// ── Rows, as the database can actually produce them ───────────────────────────

const PENDING = {
  id: "p1",
  amount: 1000,
  confirmed: false,
  voided_at: null,
  void_reason: null,
  allocated_amount: 0,
};
const CONFIRMED = { ...PENDING, id: "p2", confirmed: true };
/**
 * A voided row as void_payment() leaves it: `confirmed = false`, `voided_at` set,
 * allocations deleted. This is the row the reviewed page rendered as "Pending" and
 * offered a Confirm button on.
 */
const VOIDED = {
  ...PENDING,
  id: "p3",
  confirmed: false,
  voided_at: "2026-08-12T10:00:00Z",
  void_reason: "duplicate transfer",
  allocated_amount: 0,
};
/** A payment voided after it had been confirmed. `confirmed` is false again. */
const VOIDED_AFTER_CONFIRM = { ...VOIDED, id: "p4" };
/** Not producible by the routines, but representable: a direct write leaving both set. */
const CONTRADICTORY = { ...CONFIRMED, id: "p5", voided_at: "2026-08-12T10:00:00Z" };

// ── The three states, executed ────────────────────────────────────────────────

test("a voided payment is voided, not pending and not confirmed", () => {
  assert.equal(paymentState(VOIDED), "voided");
  assert.equal(isVoided(VOIDED), true);
  assert.equal(isPending(VOIDED), false, "a voided payment counted as awaiting confirmation is the B8 defect");
  assert.equal(isConfirmed(VOIDED), false);
  assert.equal(countsAsCash(VOIDED), false);
  assert.equal(paymentState(VOIDED_AFTER_CONFIRM), "voided");
});

test("voided wins over confirmed, because the reversal is the later fact", () => {
  // Not producible by void_payment() (it sets confirmed = false), but a row with
  // both set must not display as live money.
  assert.equal(paymentState(CONTRADICTORY), "voided");
  assert.equal(countsAsCash(CONTRADICTORY), false);
  assert.equal(paymentAllowsConfirm(CONTRADICTORY), false);
  assert.equal(paymentAllowsAllocate(CONTRADICTORY), false);
});

test("the other two states are what the columns say", () => {
  assert.equal(paymentState(PENDING), "pending");
  assert.equal(isPending(PENDING), true);
  assert.equal(paymentState(CONFIRMED), "confirmed");
  assert.equal(countsAsCash(CONFIRMED), true);
  // `confirmed` is a nullable column; null is not confirmed.
  assert.equal(paymentState({ ...PENDING, confirmed: null }), "pending");
});

test("there is no fourth state, and the filters are the states plus `all`", () => {
  assert.deepEqual([...PAYMENT_STATES], ["pending", "confirmed", "voided"]);
  assert.deepEqual([...PAYMENT_STATE_FILTERS], ["all", "pending", "confirmed", "voided"]);
  // The two type aliases the route and the page share must list exactly these.
  // A state added to one side only is how the read model and the UI drifted apart.
  const types = read(TYPES);
  const state = /export type PaymentState = ([^\n]*)/.exec(types);
  assert.ok(state, `${TYPES} must declare PaymentState`);
  assert.deepEqual(
    [...state[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(),
    [...PAYMENT_STATES].sort(),
  );
  const filter = /export type PaymentStateFilter = ([^\n]*)/.exec(types);
  assert.ok(filter, `${TYPES} must declare PaymentStateFilter`);
  assert.match(filter[1], /"all"/);
  assert.match(filter[1], /PaymentState/);
});

test("filtering by a state returns exactly that state", () => {
  const rows = [PENDING, CONFIRMED, VOIDED, VOIDED_AFTER_CONFIRM];
  assert.deepEqual(filterPaymentsByState(rows, "all").length, 4);
  assert.deepEqual(filterPaymentsByState(rows, "pending").map((r) => r.id), ["p1"]);
  assert.deepEqual(filterPaymentsByState(rows, "confirmed").map((r) => r.id), ["p2"]);
  assert.deepEqual(filterPaymentsByState(rows, "voided").map((r) => r.id), ["p3", "p4"]);
  // An unknown filter shows everything rather than silently hiding money.
  assert.equal(filterPaymentsByState(rows, "settled").length, 4);
  assert.deepEqual(filterPaymentsByState(null, "all"), []);
});

// ── The statistics, executed ──────────────────────────────────────────────────

test("voided money is reported once, as voided, and not as cash", () => {
  const totals = paymentTotals([
    { ...PENDING, amount: 100 },
    { ...CONFIRMED, amount: 200, allocated_amount: 200 },
    { ...VOIDED, amount: 400 },
  ]);
  // The reviewed page summed every row into Total Recorded and every unconfirmed
  // row into Total Pending, so the 400 above was counted twice: 700 recorded and
  // 500 awaiting confirmation.
  assert.equal(totals.recorded, 300);
  assert.equal(totals.pending, 100);
  assert.equal(totals.confirmed, 200);
  assert.equal(totals.voided, 400);
  assert.deepEqual(totals.counts, { all: 3, pending: 1, confirmed: 1, voided: 1 });
});

test("allocation totals count only the payments the database counts", () => {
  const totals = paymentTotals([
    { ...CONFIRMED, amount: 500, allocated_amount: 200 },
    // A voided payment's allocations were deleted by void_payment(); a stale
    // allocated_amount on the row must not re-enter the total.
    { ...VOIDED, amount: 900, allocated_amount: 900 },
    // A pending payment cannot be allocated at all.
    { ...PENDING, amount: 700, allocated_amount: 700 },
  ]);
  assert.equal(totals.allocated, 200);
  assert.equal(totals.unallocated, 300);
});

test("an allocation cannot exceed the payment it belongs to, in the totals either", () => {
  const totals = paymentTotals([{ ...CONFIRMED, amount: 100, allocated_amount: 150 }]);
  assert.equal(totals.allocated, 100);
  assert.equal(totals.unallocated, 0);
});

test("a missing aggregate is counted as missing, not as zero", () => {
  // The whole B8 read-model defect in one assertion: the route did not send the
  // field, so the page reported "Allocated: AED 0.00" for every payment and a
  // Total Allocated KPI of AED 0.00 with complete confidence.
  const withoutField = { ...CONFIRMED, amount: 500 };
  delete withoutField.allocated_amount;
  assert.equal(hasAllocationData(withoutField), false);
  assert.equal(unallocatedTotal(withoutField), null);
  assert.equal(isFullyAllocated(withoutField), false);

  const totals = paymentTotals([withoutField, { ...CONFIRMED, id: "p9", amount: 100, allocated_amount: 100 }]);
  assert.equal(totals.allocationDataMissing, 1);
  assert.equal(totals.allocated, 100, "an unknown allocation must not be summed as 0");
  assert.equal(totals.unallocated, 0, "nor inverted into 500 unallocated");

  for (const absent of [null, undefined, NaN, "200"]) {
    assert.equal(hasAllocationData({ ...CONFIRMED, allocated_amount: absent }), false, `accepted ${absent}`);
  }
  assert.equal(hasAllocationData({ ...CONFIRMED, allocated_amount: 0 }), true, "a real zero is data");
});

test("totals are exact in fils, so they agree with the routine that wrote them", () => {
  // numeric(12,2) arrives as a JSON number. Summed as floats, these three give
  // 0.6000000000000001 and `allocated >= amount` becomes a coin flip on the last
  // fil — the same defect as B10's exact round(...,2) equality.
  const totals = paymentTotals([
    { ...CONFIRMED, id: "a", amount: 0.1, allocated_amount: 0.1 },
    { ...CONFIRMED, id: "b", amount: 0.2, allocated_amount: 0.2 },
    { ...CONFIRMED, id: "c", amount: 0.3, allocated_amount: 0.3 },
  ]);
  assert.equal(totals.confirmed, 0.6);
  assert.equal(totals.allocated, 0.6);
  assert.equal(totals.unallocated, 0);
  assert.equal(isFullyAllocated({ ...CONFIRMED, amount: 0.3, allocated_amount: 0.1 + 0.2 }), true);
  assert.equal(allocatedTotal({ ...CONFIRMED, allocated_amount: 0.1 + 0.2 }), 0.3);
});

test("unallocated is only meaningful for money that counts", () => {
  assert.equal(unallocatedTotal({ ...CONFIRMED, amount: 500, allocated_amount: 200 }), 300);
  // Not "the whole amount is unallocated": there is nothing to allocate.
  assert.equal(unallocatedTotal({ ...PENDING, amount: 500 }), null);
  assert.equal(unallocatedTotal({ ...VOIDED, amount: 500 }), null);
  // Never negative, even if a row carries more allocation than amount.
  assert.equal(unallocatedTotal({ ...CONFIRMED, amount: 100, allocated_amount: 150 }), 0);
});

// ── What the routines will accept, executed ───────────────────────────────────

test("Confirm is offered exactly where confirm_payment() does not refuse", () => {
  assert.equal(paymentAllowsConfirm(PENDING), true);
  // 22023 'a voided payment cannot be confirmed' — the button the reviewed page
  // offered on every voided row.
  assert.equal(paymentAllowsConfirm(VOIDED), false);
  // 22023 'payment is already confirmed'
  assert.equal(paymentAllowsConfirm(CONFIRMED), false);
  // 22023 'an amount must be positive'
  assert.equal(paymentAllowsConfirm({ ...PENDING, amount: 0 }), false);
  assert.equal(paymentAllowsConfirm({ ...PENDING, amount: -100 }), false);
  assert.equal(paymentAllowsConfirm(null), false);
});

test("Allocate is offered exactly where allocate_payment() does not refuse", () => {
  assert.equal(paymentAllowsAllocate(CONFIRMED), true);
  // 22023 'payment must be confirmed before allocation'
  assert.equal(paymentAllowsAllocate(PENDING), false);
  // 22023 'a voided payment cannot be allocated'
  assert.equal(paymentAllowsAllocate(VOIDED), false);
  assert.equal(paymentAllowsAllocate(null), false);
});

test("Void is offered on anything not already voided, confirmed or not", () => {
  // void_payment() only refuses `voided_at is not null` (23505). A pending payment
  // recorded in error is voidable — requiring confirmation first would leave the
  // operator reaching for the DELETE that round 3 revoked from every role.
  assert.equal(paymentAllowsVoid(PENDING), true);
  assert.equal(paymentAllowsVoid(CONFIRMED), true);
  assert.equal(paymentAllowsVoid(VOIDED), false);
  assert.equal(paymentAllowsVoid(null), false);
});

test("the row guards match the refusals the installed routines actually raise", () => {
  const sql = read(ROUND4);

  const confirm = routineBody(sql, "confirm_payment");
  assert.match(confirm, /if coalesce\(v_payment\.confirmed, false\) then/);
  assert.match(confirm, /voided_at is not null[\s\S]*?a voided payment cannot be confirmed/);
  assert.match(confirm, /an amount must be positive/);

  const allocate = routineBody(sql, "allocate_payment");
  assert.match(allocate, /if not coalesce\(v_payment\.confirmed, false\) then/);
  assert.match(allocate, /voided_at is not null[\s\S]*?a voided payment cannot be allocated/);
  assert.match(allocate, /exceeds the payment amount/);

  const voidRoutine = routineBody(sql, "void_payment");
  assert.match(voidRoutine, /voided_at is not null[\s\S]*?payment is already voided/);
  // The reason is required by the routine, so it is required by the dialog.
  assert.match(voidRoutine, /a reason is required to void a payment/);
  // And it does NOT require a prior confirmation, which is why paymentAllowsVoid()
  // says yes to a pending payment. A guard added here without changing the model
  // would start offering a button the routine refuses.
  assert.doesNotMatch(voidRoutine, /must be confirmed before/i);
});

test("every derived total in the routines uses the predicate countsAsCash() implements", () => {
  const sql = read(ROUND4);
  for (const routine of ["confirm_payment", "allocate_payment", "void_payment"]) {
    const body = routineBody(sql, routine);
    assert.match(
      body,
      /p\.confirmed = true[\s\S]{0,60}p\.voided_at is null/,
      `${routine} recomputes a total without the confirmed-and-unvoided predicate`,
    );
  }
});

// ── The allocation draft, executed ────────────────────────────────────────────

test("a submission is the whole allocation, because allocate_payment() replaces it", () => {
  const sql = read(ROUND4);
  const allocate = routineBody(sql, "allocate_payment");
  // The premise: every existing allocation is deleted before the submitted set is
  // inserted. The reviewed dialog opened with empty inputs, so allocating to
  // installment 2 silently released installment 1.
  assert.match(allocate, /delete from public\.payment_allocations where payment_id = p_payment_id/);

  const draft = allocationDraftStatus({ amount: 1000, draft: { plan1: 400, plan2: 600 } });
  assert.equal(draft.total, 1000);
  assert.equal(draft.remaining, 0);
  assert.equal(draft.exceeds, false);
  assert.equal(draft.submittable, true);
});

test("the draft cap is the payment amount, exactly as the routine checks it", () => {
  const over = allocationDraftStatus({ amount: 1000, draft: { plan1: 600, plan2: 600 } });
  assert.equal(over.exceeds, true);
  assert.equal(over.submittable, false, "a submittable form must not be how an operator meets 22023");
  // Exactly the amount is allowed; a fil over is not.
  assert.equal(allocationDraftStatus({ amount: 1000, draft: { p: 1000 } }).submittable, true);
  assert.equal(allocationDraftStatus({ amount: 1000, draft: { p: 1000.01 } }).submittable, false);
  // Fils again: three tenths must not exceed a cap of 0.30.
  assert.equal(allocationDraftStatus({ amount: 0.3, draft: { a: 0.1, b: 0.2 } }).exceeds, false);
});

test("an empty or zero draft is not an allocation", () => {
  for (const draft of [undefined, {}, { plan1: 0 }, { plan1: "" }, { plan1: null }]) {
    const status = allocationDraftStatus({ amount: 1000, draft });
    assert.equal(status.empty, true, `treated as an allocation: ${JSON.stringify(draft)}`);
    assert.equal(status.submittable, false);
  }
  // allocate_payment() raises 22023 'allocations must be a non-empty array'.
  assert.match(routineBody(read(ROUND4), "allocate_payment"), /allocations must be a non-empty array/);
});

// ── The read route sends what the model reads ─────────────────────────────────

test("the list route names the void metadata the page renders", () => {
  const route = code(read(LIST_ROUTE));
  // The columns are now enumerated instead of arriving under `*`, which is what
  // makes the response type real (see below). The cost of naming them is that
  // omitting one becomes possible, so each is asserted.
  for (const column of ["voided_at", "voided_by", "void_reason", "confirmed", "confirmed_at"]) {
    assert.match(route, new RegExp(`\\b${column}\\b`), `the list route does not select ${column}`);
  }
});

test("the list route aggregates allocation itself instead of hoping for a column", () => {
  const route = code(read(LIST_ROUTE));
  // payments has no allocated_amount column — that column is on installment_plans
  // — so the field the page reads has to be computed from payment_allocations.
  assert.match(route, /payment_allocations\(plan_id, amount_allocated\)/);
  assert.match(route, /allocated_amount: allocatedFils \/ 100/);
  assert.match(route, /Math\.round\(Number\(allocation\.amount_allocated/, "allocation must be summed in fils");
  // The cast that hid the disagreement between the route and the page.
  assert.doesNotMatch(route, /as any\[\]/);
  // Any wildcard, not just a bare one: the reviewed select was
  // `"*, contracts(contract_no, party_a_name)"`, and under `*` the row type is
  // whatever the generated types happen to say rather than what this route promised.
  assert.doesNotMatch(route, /select\("\*/);
});

test("the list route's response is typed against the declaration the page imports", () => {
  const route = code(read(LIST_ROUTE));
  assert.match(route, /from "@\/types\/payments"/);
  assert.match(route, /const body: PaymentListResponse =/);
  assert.match(route, /PaymentListRow\[\]/);
  const types = read(TYPES);
  assert.match(types, /export interface PaymentListRow/);
  assert.match(types, /export interface PaymentListResponse/);
});

test("the money list is not cached at any layer", () => {
  const route = code(read(LIST_ROUTE));
  assert.match(route, /export const dynamic = "force-dynamic"/);
  // R5 replaced this route's own `Cache-Control` literal with the shared helper, so
  // the assertion follows the delegation rather than the string: the route has to
  // call it on the responses that carry payments, and the helper has to be what
  // sends no-store. Asserting the literal here is what let six routes each keep a
  // shorter private copy of the header.
  assert.match(route, /import \{ applyPrivateNoStore \} from "@\/lib\/request-auth-context"/);
  assert.match(route, /return applyPrivateNoStore\(NextResponse\.json\(empty\)\)/);
  assert.match(route, /return applyPrivateNoStore\(NextResponse\.json\(body\)\)/);
  assert.match(read(HELPER), /private, no-store, max-age=0, must-revalidate/);
  assert.doesNotMatch(route, /force-static|revalidate\s*=/);
  // And the client asks for a fresh copy, because every write below re-fetches.
  assert.match(code(read(PAGE)), /fetch\("\/api\/payments\/list", \{ cache: "no-store" \}\)/);
});

test("every settlement write invalidates the pages whose totals it moved", () => {
  // confirm_payment() and allocate_payment() move projects.paid_amount,
  // kpi_targets.actual_amount and contracts.first_payment_status. The reviewed
  // actions revalidated nothing, so /contracts and /dashboard kept rendering the
  // figures from before the write; only the void route did this.
  const actions = code(read(ACTIONS));
  assert.match(actions, /import \{ revalidatePath \} from 'next\/cache'/);
  const paths = /const SETTLEMENT_PATHS = \[([^\]]*)\]/.exec(actions);
  assert.ok(paths, `${ACTIONS} must declare SETTLEMENT_PATHS`);
  for (const page of ["/contracts", "/payments", "/dashboard"]) {
    assert.match(paths[1], new RegExp(`'${page}'`), `SETTLEMENT_PATHS omits ${page}`);
  }
  // Each action checked within its own body, so one call cannot cover for both.
  const confirmAt = actions.indexOf("export async function confirmPayment");
  const allocateAt = actions.indexOf("export async function allocatePayment");
  assert.ok(confirmAt !== -1 && allocateAt > confirmAt, `${ACTIONS} no longer declares both actions in order`);
  assert.match(actions.slice(confirmAt, allocateAt), /revalidateSettlementPaths\(\)/);
  assert.match(actions.slice(allocateAt), /revalidateSettlementPaths\(\)/);
  assert.match(code(read(VOID_ROUTE)), /revalidatePath/);
});

// ── The page uses the model rather than a second copy of it ───────────────────

test("the page reads its statistics and filter from the model", () => {
  const page = code(read(PAGE));
  assert.match(page, /from "@\/lib\/payment-state\.mjs"/);
  assert.match(page, /const totals = paymentTotals\(payments\)/);
  assert.match(page, /filterPaymentsByState\(payments, activeTab\)/);
  // The four reducers that produced the double-counted figures.
  assert.doesNotMatch(page, /const totalRecorded =/);
  assert.doesNotMatch(page, /const totalPending =/);
  assert.doesNotMatch(page, /const totalAllocated =/);
  assert.doesNotMatch(
    page,
    /payments\.filter\(\(p\) => !?p\.confirmed\)/,
    "a two-state count over `confirmed` puts voided payments in the pending column",
  );
});

test("the page declares no second opinion about the row shape", () => {
  const page = code(read(PAGE));
  assert.match(page, /from "@\/types\/payments"/);
  assert.doesNotMatch(page, /interface Payment \{/, "the fabricated local Payment interface is back");
  assert.doesNotMatch(page, /interface Contract \{/);
});

test("the page renders three states and offers the void action", () => {
  const page = code(read(PAGE));
  assert.match(page, /const state = paymentState\(payment\)/);
  assert.match(page, /state === "voided"/);
  assert.match(page, /TabsTrigger value="voided"/, "there is no way to see voided payments");
  assert.match(page, /payments\.voidedStatus/);
  assert.match(page, /payment\.void_reason/, "a reversal without its reason is not auditable on screen");
  assert.match(page, /openVoidDialog\(payment\)/);
  assert.match(page, /fetch\(`\/api\/payments\/\$\{voidTarget\.id\}\/void`/);
  assert.match(page, /payments\.voidReasonRequired/);
});

test("the allocate dialog prefills the allocation it is about to replace", () => {
  const page = code(read(PAGE));
  // Opening empty is what made allocating to installment 2 release installment 1.
  assert.match(page, /setAllocAmounts\(\{ \.\.\.payment\.allocations \}\)/);
  assert.match(page, /allocationDraftStatus\(\{ amount: allocatePayment\.amount, draft: allocAmounts \}\)/);
  assert.match(page, /payments\.allocationReplaces/);
  // The figure that implied the existing and the new allocation summed.
  assert.doesNotMatch(page, /payments\.previouslyAllocated/);
  assert.doesNotMatch(page, /getAllocatedTotal/);
  // The prefill comes from the read model, not from a second client-side query for
  // money rows: the list route already reads payment_allocations for the sum, so a
  // browser query would be a second answer to the same question and one more
  // caller-scoped read of a money table.
  assert.doesNotMatch(page, /from\("payment_allocations"\)/);
});

test("the per-plan breakdown and the sum come from the same read", () => {
  const route = code(read(LIST_ROUTE));
  assert.match(route, /payment_allocations\(plan_id, amount_allocated\)/);
  assert.match(route, /allocations\[allocation\.plan_id\]/);
  assert.match(route, /allocations: Record<string, number>/);
  assert.match(route, /allocated_amount: allocatedFils \/ 100, allocations/);
  assert.match(read(TYPES), /allocations: Record<string, number>/);
});

test("the model carries no role rule, and the page carries no row rule of its own", () => {
  // Round-3 P1-9 was the role rule and the row rule written as one. They stay two
  // rules in two places: SETTLEMENT_ROLES on the page (coupled to the routines by
  // tests/security/money-grant-coupling.test.mjs) and paymentAllows* here.
  const model = code(read(MODEL));
  for (const role of ["admin", "boss", "finance", "operator", "sales"]) {
    assert.doesNotMatch(model, new RegExp(`["']${role}["']`), `${MODEL} names the role ${role}`);
  }
  const page = code(read(PAGE));
  assert.match(page, /canSettle && paymentAllowsConfirm\(payment\)/);
  assert.match(page, /canSettle && paymentAllowsAllocate\(payment\)/);
  assert.match(page, /canSettle && paymentAllowsVoid\(payment\)/);
});
