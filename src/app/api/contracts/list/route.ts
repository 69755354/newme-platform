// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { canReadContracts, contractsScopedToOwner } from "@/lib/contract-access.mjs"
import { createServerSupabase } from "@/lib/supabase-server"
import { applyPrivateNoStore } from "@/lib/request-auth-context"
import { logger, genReqId } from "@/lib/logger"
import type { ContractListRow, ContractListResponse } from "@/types/contracts"

/**
 * GET /api/contracts/list — the contracts list page's read model.
 *
 * Round-4 finding R5. Two things were wrong here, and both were invisible from the
 * page:
 *
 *   * the response was held in src/lib/api-cache.ts for 30 seconds under
 *     `contracts:list:${role}:${userId}:${statusFilter}:${page}`. That module has no
 *     eviction export and `revalidatePath()` cannot reach it, so after a payment is
 *     confirmed, voided or re-allocated this list kept serving the pre-write
 *     first_payment_status badge, first_payment_due_date and installment rows for the
 *     rest of the TTL — while /api/payments/list, which is force-dynamic, served the
 *     new ones. Two pages, two answers about the same money. The badge is not
 *     cosmetic: `needsReminder` drives the Remind button off it, so a stale unpaid
 *     status invites a dunning message about money already received.
 *   * `select("*", …)` was cast `as any[]`, and the page declared its own interface
 *     over the result. See src/types/contracts.ts for what the two declarations
 *     disagreed about.
 *
 * So: no module cache, `force-dynamic` and a no-store header — the posture
 * /api/payments/list and /api/leads/list already take for the same reason — and the
 * columns are named so the row type is the generated one. The list is cheap to
 * recompute (one paginated query with two embeds); serving a wrong badge is not
 * cheap.
 */
export const dynamic = "force-dynamic"

/**
 * Only what the page renders, plus the two ids it links and scopes on.
 *
 * One long string literal on purpose: postgrest-js infers the row type by parsing
 * this argument at the type level, so a select assembled with `.join(", ")` has type
 * `string`, the parse fails, and the result arrives as `{ error: true } & String` —
 * which is how `as any[]` got in here. Keeping it a literal is what makes
 * ContractListRow a real promise rather than a comment.
 *
 * installment_plans carries allocated_amount as well as paid_amount because they
 * answer different questions (what a payment has been assigned to, versus what the
 * trigger has recorded as paid) and the page must not read one for the other.
 */
const CONTRACT_SELECT =
  "id, contract_no, contract_amount, status, party_a_name, contract_date, sales_id, lead_id, created_at, first_payment_status, first_payment_due_date, leads(customer_name), profiles!contracts_sales_id_fkey(full_name, email), installment_plans(id, amount, due_date, status, paid_amount, allocated_amount, seq)"

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

  // The database is the boundary -- the RLS SELECT policies on public.contracts
  // return no rows to a role that is not one of these -- but an unlisted role
  // used to receive 200 with an empty page, which reads as "no contracts yet"
  // rather than "not for you". Refusing explicitly says which one it is, and
  // keeps this route's answer identical to GET /api/contracts.
  if (!canReadContracts(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get("status") || "all"
  const page = parseInt(searchParams.get("page") || "1", 10)
  const pageSize = parseInt(searchParams.get("pageSize") || "10", 10)

  const isSales = contractsScopedToOwner(role)
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let q = supabase
    .from("contracts")
    .select(CONTRACT_SELECT, { count: "exact" })
    .order("created_at", { ascending: false })

  if (isSales) q = q.eq("sales_id", userId)
  if (statusFilter !== "all") q = q.eq("status", statusFilter)

  q = q.range(from, to)

  const { data, error: err, count } = await q

  if (err) {
    logger.error(
      {
        err: err,
        request_id,
        operation: "contract_list",
        user_id: userId,
      },
      "[API Contracts List] contracts fetch failed",
    )
    return NextResponse.json({ error: "Failed to fetch contracts" }, { status: 500 })
  }

  // Assigned, not cast. This is the one line the old `as any[]` was hiding behind:
  // if the select above and ContractListRow ever disagree about a column or its
  // nullability, it has to fail here rather than at whatever the page happens to
  // render.
  const contracts: ContractListRow[] = data ?? []

  const responseData: ContractListResponse = {
    contracts,
    role,
    totalCount: count ?? 0,
  }

  return applyPrivateNoStore(NextResponse.json(responseData))
}
