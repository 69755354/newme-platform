// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { applyPrivateNoStore } from "@/lib/request-auth-context"
import { logger, genReqId } from "@/lib/logger"
import type { PaymentListRow, PaymentListResponse } from "@/types/payments"

/**
 * GET /api/payments/list — the payments dashboard's read model.
 *
 * Round-4 finding B8. The reviewed revision returned
 * `select("*, contracts(contract_no, party_a_name)")` cast to `any[]`, and the
 * route-side half of the finding is the allocation total:
 *
 *   * there was no allocation aggregation at all. The page's own interface declared
 *     `allocated_amount: number`, but no such column exists on payments — it is on
 *     installment_plans — so no select could have supplied it. Every payment
 *     arrived with the field absent, the Total Allocated KPI was permanently
 *     AED 0.00 and the per-payment allocation line never rendered. TypeScript could
 *     not see it because `as any[]` erased the row type at the one point where the
 *     route and the page have to agree.
 *   * the void columns, in contrast, were on the wire: `*` returns voided_at,
 *     voided_by and void_reason. What dropped them was the page's interface, which
 *     did not declare them — so nothing rendered or filtered on them, and a
 *     reversed payment displayed as Pending with a Confirm button that
 *     confirm_payment() answers with 22023 'a voided payment cannot be confirmed'.
 *     Naming the columns here is what gives that page a typed promise to read.
 *
 * So the columns are now named explicitly, the row type is the generated one, and
 * `allocated_amount` is computed here — from payment_allocations, the table the
 * database itself sums — rather than hoped for downstream. The state rules that
 * read these fields live in src/lib/payment-state.mjs so the page and this route
 * cannot drift into two models again.
 *
 * Cache invalidation, the third part of the finding: the handler reads the
 * request's own headers, so Next never prerenders it, and `force-dynamic` is
 * declared anyway — the same posture the other authenticated read routes here
 * take — so a refactor that stops reading the request cannot quietly make a money
 * list cacheable. The no-store header is for the browser and any proxy in front of
 * it, and the three write paths (POST /api/payments, the confirm and allocate
 * server actions, POST /api/payments/[id]/void) each revalidate the pages that
 * render payment-derived totals.
 */
export const dynamic = "force-dynamic"

/**
 * Only what the dashboard renders: the identity, the money, the confirmation
 * fields and the void fields, plus the contract label and the allocation rows.
 * `request_key` and `credited_to` stay behind — they are server-side bookkeeping
 * and nothing on the page reads them.
 *
 * One long string literal on purpose. postgrest-js infers the row type by parsing
 * this argument at the type level, so a select built with `[...].join(", ")` has
 * type `string`, the parse fails, and the result comes back as
 * `{ error: true } & String` — which is how `as any[]` got into this route in the
 * first place. Keeping it a literal is what makes the response type real.
 */
const PAYMENT_SELECT =
  "id, contract_id, amount, payment_date, payment_method, reference_no, notes, confirmed, confirmed_at, confirmed_by, voided_at, voided_by, void_reason, created_by, created_at, contracts(contract_no, party_a_name), payment_allocations(plan_id, amount_allocated)"

const CONTRACT_COLUMNS = "id, contract_no, contract_amount, status, party_a_name, sales_id"

export async function GET(request: Request) {
  const request_id = genReqId()
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader)

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single()

  if (profileError || !profile) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const role = profile.role
  const userId = user.id

  const isSales = role === "sales"

  // Deliberately sequential for `sales`: the contract set decides the payment
  // scope, so it has to be known first. policy_payments_select_sales already
  // restricts the rows to contracts the caller owns and RLS remains the boundary
  // — this is the same second, explicit answer GET /api/payments gives, so a
  // future policy edit cannot widen the page by itself.
  const contractsResult = await (isSales
    ? supabase
        .from("contracts")
        .select(CONTRACT_COLUMNS)
        .eq("sales_id", userId)
        .order("contract_no", { ascending: true })
    : supabase
        .from("contracts")
        .select(CONTRACT_COLUMNS)
        .in("status", ["signed", "active"])
        .order("contract_no", { ascending: true }))

  if (contractsResult.error) {
    logger.error(
      { err: contractsResult.error, request_id, operation: "payment_list", user_id: userId },
      "[API Payments List] Failed to fetch contracts",
    )
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 })
  }

  const ownedContracts = contractsResult.data ?? []
  // A salesperson with no contracts has no payments; the `.in()` below would be an
  // empty list, which PostgREST answers with every row rather than none.
  if (isSales && ownedContracts.length === 0) {
    const empty: PaymentListResponse = { payments: [], contracts: [], role, userId }
    return applyPrivateNoStore(NextResponse.json(empty))
  }

  // payment_allocations is embedded rather than fetched by id list: the page is
  // unpaginated, so a second query filtered by `.in(payment_id, …)` would grow the
  // request URL with the table. The rows come back through
  // policy_payment_allocations_select_*, which scopes them to exactly the payments
  // this caller can already see, so the sum is complete for every row returned.
  let paymentsQuery = supabase
    .from("payments")
    .select(PAYMENT_SELECT)
    .order("created_at", { ascending: false })

  if (isSales) {
    paymentsQuery = paymentsQuery.in("contract_id", ownedContracts.map((contract) => contract.id))
  }

  const paymentsResult = await paymentsQuery

  if (paymentsResult.error) {
    logger.error(
      { err: paymentsResult.error, request_id, operation: "payment_list", user_id: userId },
      "[API Payments List] Failed to fetch payments",
    )
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 })
  }

  // Summed in fils. numeric(12,2) arrives as a JSON number, and a float sum of
  // several allocations is what makes `allocated >= amount` disagree with the
  // routine that wrote them.
  //
  // The per-plan breakdown is returned alongside the sum, from this one read: the
  // allocate dialog has to open on the existing allocation, and deriving both here
  // is what keeps the figure in the list and the figures in the dialog from being
  // two different answers — and keeps the client from querying money rows itself.
  const payments: PaymentListRow[] = (paymentsResult.data ?? []).map((row) => {
    const { payment_allocations, ...payment } = row
    const allocations: Record<string, number> = {}
    let allocatedFils = 0
    for (const allocation of payment_allocations ?? []) {
      const fils = Math.round(Number(allocation.amount_allocated ?? 0) * 100)
      allocatedFils += fils
      // Summed per plan rather than assigned: payment_allocations has no unique
      // constraint on (payment_id, plan_id), so two rows for one plan are
      // representable and the last one must not win.
      allocations[allocation.plan_id] = (Math.round((allocations[allocation.plan_id] ?? 0) * 100) + fils) / 100
    }
    return { ...payment, allocated_amount: allocatedFils / 100, allocations }
  })

  // The dropdown offers contracts a payment can be recorded against. For `sales`
  // the query above is the ownership scope, so the status filter is applied here
  // instead of narrowing the scope itself.
  const contracts = isSales
    ? ownedContracts.filter((contract) => contract.status === "signed" || contract.status === "active")
    : ownedContracts

  const body: PaymentListResponse = { payments, contracts, role, userId }
  return applyPrivateNoStore(NextResponse.json(body))
}
