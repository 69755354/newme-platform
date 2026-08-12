// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"

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

  if (paymentsResult.error || contractsResult.error) {
    return NextResponse.json({ error: "Failed to fetch payments" }, { status: 500 })
  }

  const responseData = {
    payments: (paymentsResult.data ?? []) as any[],
    contracts: (contractsResult.data ?? []) as any[],
    role,
    userId,
  }

  return NextResponse.json(responseData, {
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  })
}
