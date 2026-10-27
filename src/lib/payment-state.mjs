/**
 * One payment state model, shared by the read route and the dashboard.
 *
 * Round-4 finding B8. There were three disagreeing models of what a payment is:
 *
 *   * PostgreSQL: `confirmed` and `voided_at` are independent columns, allocation
 *     lives in payment_allocations, and every derived total counts a payment only
 *     when `confirmed = true and voided_at is null` — confirm_payment(),
 *     allocate_payment() and void_payment() all spell that same predicate.
 *   * GET /api/payments/list: `select("*, contracts(…))"` cast to `any[]`, with no
 *     allocation aggregation anywhere.
 *   * the payments page: an interface declaring a non-optional
 *     `allocated_amount: number` that no payments row has (the column is on
 *     installment_plans), no void fields at all — the columns arrived under `*`
 *     and the declaration was where they were dropped — and a two-state
 *     `confirmed ? "confirmed" : "pending"` rule that renders a VOIDED payment as
 *     pending, with a Confirm button that confirm_payment() answers with
 *     22023 'a voided payment cannot be confirmed'.
 *
 * The rules live here, as functions, for the reason given at the top of
 * payment-idempotency.mjs: a test that only reads the page's source can check
 * that a comparison is spelled somewhere, not that it is right, and "counted
 * voided money as pending cash" is exactly the class of mistake a spelling check
 * passes.
 */

/**
 * The three states a payments row can be in. There is no fourth: `confirmed` and
 * `voided_at` are the only two columns that decide it.
 */
export const PAYMENT_STATES = Object.freeze(["pending", "confirmed", "voided"]);

/** Tabs the dashboard offers. `all` is not a state, it is the absence of a filter. */
export const PAYMENT_STATE_FILTERS = Object.freeze(["all", ...PAYMENT_STATES]);

/**
 * Money as an exact integer count of fils, for comparisons only.
 *
 * numeric(12,2) arrives from PostgREST as a JSON number, so summing a dozen of
 * them gives 0.30000000000000004 and `allocated >= amount` becomes a coin flip on
 * the last fil. B10 was the same defect in the quotation schedule: the routine
 * compares round(...,2) for equality, so the UI has to compare the same way.
 *
 * Not paymentAmountMinorUnits() from payment-idempotency.mjs: that one refuses
 * zero and negatives because a *recorded payment* of 0 is not a payment. Zero is
 * a legitimate allocation total, and a stored negative amount predating the B3
 * constraint must be displayed rather than silently dropped.
 */
function fils(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

/** Fils back to a 2-decimal amount, so a sum of many rows is exact for display. */
function dirhams(minor) {
  return minor / 100;
}

/**
 * Whether the row was reversed by void_payment().
 *
 * `voided_at`, not `confirmed`: void_payment() happens to also set
 * confirmed = false, but a model that inferred "voided" from "not confirmed"
 * would call every unconfirmed payment voided, and one that let `confirmed` win
 * would show a voided-then-somehow-confirmed row as live money. The column that
 * records the reversal is the one that decides.
 */
export function isVoided(row) {
  return Boolean(row && row.voided_at);
}

export function isConfirmed(row) {
  return !isVoided(row) && Boolean(row && row.confirmed);
}

export function isPending(row) {
  return Boolean(row) && !isVoided(row) && !row.confirmed;
}

export function paymentState(row) {
  if (isVoided(row)) return "voided";
  if (isConfirmed(row)) return "confirmed";
  return "pending";
}

/**
 * The predicate every derived total in the database uses:
 * `p.confirmed = true and p.voided_at is null`. installment_plans.allocated_amount,
 * projects.paid_amount, kpi_targets.actual_amount and
 * contracts.first_payment_status are all recomputed from exactly this set, so a
 * dashboard total that used a different one would disagree with the ledger.
 */
export function countsAsCash(row) {
  return isConfirmed(row);
}

/**
 * Whether the read model actually supplied this row's allocation total.
 *
 * The B8 defect in one function: the page read `p.allocated_amount || 0` from a
 * field the route never returned, so every payment displayed as "Allocated:
 * AED 0.00" and the Total Allocated KPI was permanently zero. Absent is not zero,
 * and the caller has to be able to tell the difference — a missing aggregate is a
 * gap to show, not a balance to report.
 */
export function hasAllocationData(row) {
  return Boolean(row) && typeof row.allocated_amount === "number" && Number.isFinite(row.allocated_amount);
}

/** The allocated total, or 0 when the read model did not supply one. Check hasAllocationData() first. */
export function allocatedTotal(row) {
  return hasAllocationData(row) ? dirhams(fils(row.allocated_amount)) : 0;
}

/**
 * The part of a confirmed payment that is not yet allocated to an installment.
 *
 * Only meaningful for a payment that counts as cash: a pending payment has
 * nothing to allocate and a voided one had its allocations deleted, so both
 * answer null rather than "the whole amount is unallocated".
 */
export function unallocatedTotal(row) {
  if (!countsAsCash(row) || !hasAllocationData(row)) return null;
  return dirhams(Math.max(fils(row.amount) - fils(row.allocated_amount), 0));
}

/** Exact, in fils: the DB marks a plan 'paid' at `allocated >= amount`. */
export function isFullyAllocated(row) {
  if (!countsAsCash(row) || !hasAllocationData(row)) return false;
  return fils(row.allocated_amount) >= fils(row.amount);
}

/**
 * The dashboard's statistics.
 *
 * `recorded` excludes voided payments, and that is the finding rather than a
 * preference: the reviewed page summed every row into Total Recorded and every
 * unconfirmed row into Total Pending, so a voided payment was counted as cash
 * twice over — once in the recorded total and once as money still awaiting
 * confirmation. Voided money is reported on its own, because "reversed" is
 * information an operator needs and zero is not the same as absent.
 */
export function paymentTotals(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const totals = {
    recorded: 0,
    confirmed: 0,
    pending: 0,
    voided: 0,
    allocated: 0,
    unallocated: 0,
    counts: { all: 0, pending: 0, confirmed: 0, voided: 0 },
    allocationDataMissing: 0,
  };

  for (const row of list) {
    const amount = fils(row?.amount);
    const state = paymentState(row);
    totals.counts.all += 1;
    totals.counts[state] += 1;

    if (state === "voided") {
      totals.voided += amount;
      continue;
    }

    totals.recorded += amount;
    if (state === "confirmed") {
      totals.confirmed += amount;
      if (hasAllocationData(row)) {
        const allocated = Math.min(fils(row.allocated_amount), amount);
        totals.allocated += allocated;
        totals.unallocated += Math.max(amount - allocated, 0);
      } else {
        totals.allocationDataMissing += 1;
      }
    } else {
      totals.pending += amount;
    }
  }

  for (const key of ["recorded", "confirmed", "pending", "voided", "allocated", "unallocated"]) {
    totals[key] = dirhams(totals[key]);
  }
  return totals;
}

export function filterPaymentsByState(rows, filter) {
  const list = Array.isArray(rows) ? rows : [];
  if (filter === "all" || !PAYMENT_STATES.includes(filter)) return list;
  return list.filter((row) => paymentState(row) === filter);
}

// ─── What the routines will accept ──────────────────────────────────────────
//
// Row preconditions only. The ROLE rule is deliberately not here: it belongs to
// the caller and is coupled to the routines' own role lists by
// tests/security/money-grant-coupling.test.mjs. Round-3 P1-9 was those two rules
// written as one, so they stay two rules in two places.
//
// Each function mirrors one routine's guards, so an offered button is an action
// the database will accept and a refused action is a button that is not offered.

/** confirm_payment(): not already confirmed, not voided, and a positive amount. */
export function paymentAllowsConfirm(row) {
  return Boolean(row) && !isVoided(row) && !row.confirmed && fils(row.amount) > 0;
}

/** allocate_payment(): confirmed and not voided. */
export function paymentAllowsAllocate(row) {
  return countsAsCash(row);
}

/**
 * void_payment(): anything not already voided, confirmed or not.
 *
 * A pending payment recorded in error is voidable — the routine only refuses
 * `voided_at is not null`, with 23505. Requiring confirmation first would leave
 * the operator deleting the row, which is the DELETE the round-3 fix revoked.
 */
export function paymentAllowsVoid(row) {
  return Boolean(row) && !isVoided(row);
}

/**
 * The allocation the dialog must submit, given what is already allocated.
 *
 * allocate_payment() DELETEs every existing allocation for the payment and then
 * inserts the submitted set, so a submission is a REPLACEMENT, not an addition.
 * The reviewed dialog opened with empty inputs and called that "allocate", so
 * allocating to installment 2 silently released installment 1 — and its own
 * warning compared the new total against the payment amount while displaying a
 * separate "Previously allocated" figure, as if the two summed.
 *
 * `total` is therefore the whole intended allocation for this payment and the cap
 * is the payment amount, exactly as the routine checks it.
 */
export function allocationDraftStatus({ amount, draft } = {}) {
  const cap = fils(amount);
  const entries = Object.values(draft ?? {});
  let total = 0;
  let positives = 0;
  for (const value of entries) {
    const minor = fils(value);
    if (minor > 0) positives += 1;
    total += minor;
  }
  return {
    total: dirhams(total),
    remaining: dirhams(cap - total),
    exceeds: total > cap,
    empty: positives === 0,
    submittable: positives > 0 && total <= cap,
  };
}
