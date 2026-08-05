// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache"

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

  const cacheKey = `payments:list:${role}:${userId}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const isSales = role === "sales"

  const [paymentsResult, contractsResult] = await Promise.all([
    supabase
      .from("payments")
      .select("*, contracts(contract_no, party_a_name)")
      .order("created_at", { ascending: false }),
    (async () => {
      let q = supabase
        .from("contracts")
        .select("id, contract_no, contract_amount, status, party_a_name, sales_id")
        .in("status", ["signed", "active"])
        .order("contract_no", { ascending: true })
      if (isSales) q = q.eq("sales_id", userId)
      return q
    })(),
  ])

  const responseData = {
    payments: (paymentsResult.data ?? []) as any[],
    contracts: (contractsResult.data ?? []) as any[],
    role,
    userId,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
