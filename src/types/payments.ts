/**
 * The payments dashboard's read model, declared once.
 *
 * Round-4 finding B8: GET /api/payments/list returned a wildcard select cast to
 * `any[]` and the page declared its own `Payment` interface with an
 * `allocated_amount: number` that no payments row carries and no void fields at
 * all — so voided_at, voided_by and void_reason arrived under `*` and were dropped
 * right here, at the declaration. Two declarations, neither checked against the
 * other, and the cast at the boundary meant TypeScript could not notice they
 * disagreed.
 *
 * So there is one declaration and both sides import it: the route's return value
 * has to satisfy it, and the page can only read fields the route promises. The
 * state rules over these fields live in src/lib/payment-state.mjs.
 */

/**
 * The three states a payment can be in, as types.
 *
 * The runtime lists live in src/lib/payment-state.mjs (PAYMENT_STATES and
 * PAYMENT_STATE_FILTERS) because that is where the rules that produce them are;
 * tests/security/payment-state-model.test.mjs holds these two declarations
 * against those two arrays so a fourth state cannot be added to one and not the
 * other.
 */
export type PaymentState = "pending" | "confirmed" | "voided"

/** A state, or the absence of a filter. `all` is not a state. */
export type PaymentStateFilter = "all" | PaymentState

/**
 * A payments row as the dashboard receives it.
 *
 * Column names and nullability follow src/types/database.ts. The one field that is
 * not a column is `allocated_amount`: the route derives it by summing this
 * payment's payment_allocations, which is what the database's own derived totals
 * do (`sum(amount_allocated)` over confirmed, unvoided payments). It is not
 * optional here, because "the route forgot to send it" is the defect, and
 * hasAllocationData() in the state model is what distinguishes a real zero from a
 * missing aggregate at runtime.
 */
export interface PaymentListRow {
  id: string
  contract_id: string
  amount: number
  payment_date: string
  payment_method: string | null
  reference_no: string | null
  notes: string | null
  confirmed: boolean | null
  confirmed_at: string | null
  confirmed_by: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  created_by: string | null
  created_at: string | null
  allocated_amount: number
  /**
   * What this payment currently allocates, per installment plan: plan_id → amount.
   *
   * The allocate dialog has to open on the existing allocation rather than on empty
   * inputs, because allocate_payment() deletes every existing allocation before
   * inserting the submitted set — so a submission replaces the whole allocation and
   * an empty dialog silently releases the installments it does not mention. It
   * comes from the same embedded read as `allocated_amount`, so the sum shown in the
   * list and the amounts shown in the dialog cannot disagree; and it keeps the page
   * from making a second, client-side query for money rows.
   */
  allocations: Record<string, number>
  contracts: { contract_no: string; party_a_name: string } | null
}

/**
 * A contract the dashboard offers as a recording target.
 *
 * `sales_id` is nullable because the column is: contracts.sales_id has no NOT NULL
 * constraint, so an unassigned contract is representable and the page must not
 * assume an owner.
 */
export interface PaymentContractOption {
  id: string
  contract_no: string
  contract_amount: number
  status: string
  party_a_name: string
  sales_id: string | null
}

/** The whole response of GET /api/payments/list. */
export interface PaymentListResponse {
  payments: PaymentListRow[]
  contracts: PaymentContractOption[]
  role: string | null
  userId: string
}
