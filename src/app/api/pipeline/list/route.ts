import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"

export async function GET() {
  const supabase = await createServerSupabase()

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
      supabase.from('payments').select('amount,confirmed,contract_id'),
    ])

    const contracts = (contractsResult.data ?? []) as any[]
    const active = contracts.filter((c) => c.status !== 'terminated')
    const signingActual = active.reduce((sum, c) => sum + (c.contract_amount || 0), 0)

    const contractIds = new Set(contracts.map((c) => c.id))
    const payments = (paymentsResult.data ?? []) as any[]
    const collectionActual = payments
      .filter((p) => p.confirmed === true && contractIds.has(p.contract_id))
      .reduce((sum, p) => sum + (p.amount || 0), 0)

    kpiData = {
      kpiTargets: kpiTargetsResult.data ?? [],
      contractCount: active.length,
      signingActual,
      collectionActual,
    }
  }

  const cacheKey = `pipeline:list:${role}:${userId}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const responseData = {
    leads: (leadsResult.data ?? []) as any[],
    role,
    userId,
    salesUsers: (salesUsersResult.data ?? []) as any[],
    kpiData,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
