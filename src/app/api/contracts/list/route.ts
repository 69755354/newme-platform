// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"
import { logger, genReqId } from "@/lib/logger"

export async function GET(request: Request) {
  const request_id = genReqId()
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

  const { searchParams } = new URL(request.url)
  const statusFilter = searchParams.get("status") || "all"
  const page = parseInt(searchParams.get("page") || "1", 10)
  const pageSize = parseInt(searchParams.get("pageSize") || "10", 10)

  const cacheKey = `contracts:list:${role}:${userId}:${statusFilter}:${page}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const isSales = role === "sales"
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  let q = supabase
    .from("contracts")
    .select(
      `*, leads(customer_name), profiles!contracts_sales_id_fkey(full_name, email),
      installment_plans(id, amount, due_date, status, paid_amount, seq)`,
      { count: "exact" }
    )
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

  const responseData = {
    contracts: (data ?? []) as any[],
    role,
    totalCount: count ?? 0,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
