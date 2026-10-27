// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { applyPrivateNoStore } from "@/lib/request-auth-context"
import { countsAsCash } from "@/lib/payment-state.mjs"

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
    (() => {
      let q = supabase.from("leads").select("*").limit(500)
      if (isSales) q = q.eq("assigned_to", userId)
      return q
    })(),
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
    const period = new Date().toISOString().slice(0, 7)
    const [kpiTargetsResult, contractsResult, paymentsResult] = await Promise.all([
      supabase.from('kpi_targets').select('*').eq('period', period).eq('assigned_to', userId),
      supabase.from('contracts').select('id,contract_amount,status').eq('sales_id', userId),
      supabase.from('payments').select('amount,confirmed,voided_at,contract_id'),
    ])

    const contracts = (contractsResult.data ?? []) as any[]
    const active = contracts.filter((c) => c.status !== 'terminated')
    const signingActual = active.reduce((sum, c) => sum + (c.contract_amount || 0), 0)

    const contractIds = new Set(contracts.map((c) => c.id))
    const payments = (paymentsResult.data ?? []) as any[]
    const collectionActual = payments
      .filter((p) => countsAsCash(p) && contractIds.has(p.contract_id))
      .reduce((sum, p) => sum + (p.amount || 0), 0)

    kpiData = {
      kpiTargets: kpiTargetsResult.data ?? [],
      contractCount: active.length,
      signingActual,
      collectionActual,
    }
  }

  const responseData = {
    leads: (leadsResult.data ?? []) as any[],
    role,
    userId,
    salesUsers: (salesUsersResult.data ?? []) as any[],
    kpiData,
  }

  return applyPrivateNoStore(NextResponse.json(responseData))
}
