// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { applyPrivateNoStore } from "@/lib/request-auth-context"
import { countsAsCash } from "@/lib/payment-state.mjs"
import { fetchAllRows, LIST_MAX_ROWS } from "@/lib/fetch-all-rows.mjs"
import { dubaiDateKey, dubaiMonthBounds, dubaiMonthKey } from "@/lib/dubai-time.mjs"
import { isWonInPeriod, wonLeadValue } from "@/lib/lead-metrics.mjs"

/**
 * GET /api/pipeline/list — leads, the sales roster, and the caller's own KPI actuals.
 *
 * Round-4 finding R5:
 *
 *   * `collectionActual` filtered on `p.confirmed === true`. It is displayed against
 *     kpi_targets.actual_amount for the same period, which confirm_payment() and
 *     void_payment() maintain from `confirmed = true and voided_at is null`, so the
 *     two numbers on that panel were computed from different sets.
 *   * the response was cached in src/lib/api-cache.ts for 30 seconds under
 *     `pipeline:list:${role}:${userId}`, with no eviction path — so a salesperson who
 *     recorded and confirmed a payment saw their collection actual unchanged for the
 *     rest of the TTL. The cache also sat AFTER the KPI queries had already run, so
 *     it did not even save the work it was there to save.
 *
 * Now force-dynamic and no-store, with the ledger's predicate.
 */
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
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

  const [leadsResult, salesUsersResult] = await Promise.all([
    // S3 #7: every visible lead, paged, with the exact total (was an
    // unordered, silent .limit(500)).
    fetchAllRows((from, to, withCount) => {
      let q = supabase.from("leads").select("*", withCount ? { count: "exact" } : undefined)
      if (isSales) q = q.eq("assigned_to", userId)
      return q.order("updated_at", { ascending: false }).order("id", { ascending: true }).range(from, to)
    }, { maxRows: LIST_MAX_ROWS }).then((result) => ({ data: result.data, error: result.error, total: result.total, truncated: result.truncated })),
    supabase
      .from("profiles")
      .select("id,email,role,full_name")
      .in("role", ["admin", "sales", "operator", "boss"]),
  ])

  // KPI data for sales dashboard — only fetch when sales user
  let kpiData: {
    kpiTargets: any[]
    contractCount: number
    signingActual: number
    collectionActual: number
  } | null = null

  if (isSales) {
    // The KPI targets are monthly, so both actuals are for the Dubai month: signing
    // is what this rep WON in the month (won_at; the one shared won amount, the same
    // figure the dashboard shows them), collection is cash dated inside the month.
    const now = new Date()
    const period = dubaiMonthKey(now) as string
    const bounds = dubaiMonthBounds(period)
    const monthStartDate = dubaiDateKey(bounds.start) as string
    const monthEndDate = dubaiDateKey(bounds.end) as string
    const [kpiTargetsResult, paymentsResult] = await Promise.all([
      supabase.from('kpi_targets').select('*').eq('period', period).eq('assigned_to', userId),
      fetchAllRows((from, to, withCount) =>
        supabase
          .from('payments')
          .select('id,amount,confirmed,voided_at,payment_date,contracts!inner(sales_id)', withCount ? { count: 'exact' } : undefined)
          .eq('contracts.sales_id', userId)
          .gte('payment_date', monthStartDate)
          .lt('payment_date', monthEndDate)
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])

    const wonThisMonth = ((leadsResult.data ?? []) as any[]).filter(
      (l) => l.assigned_to === userId && isWonInPeriod(l, bounds),
    )
    const signingActual = wonThisMonth.reduce((sum, l) => sum + wonLeadValue(l), 0)

    const payments = (paymentsResult.data ?? []) as any[]
    const collectionActual = payments
      .filter((p) => countsAsCash(p))
      .reduce((sum, p) => sum + (p.amount || 0), 0)

    kpiData = {
      kpiTargets: kpiTargetsResult.data ?? [],
      contractCount: wonThisMonth.length,
      signingActual,
      collectionActual,
    }
  }

  const responseData = {
    leads: (leadsResult.data ?? []) as any[],
    total: leadsResult.total,
    truncated: leadsResult.truncated,
    role,
    userId,
    salesUsers: (salesUsersResult.data ?? []) as any[],
    kpiData,
  }

  return applyPrivateNoStore(NextResponse.json(responseData))
}
