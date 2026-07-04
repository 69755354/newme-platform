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
  const cacheKey = `pipeline:list:${role}:${userId}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

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

  const responseData = {
    leads: (leadsResult.data ?? []) as any[],
    role,
    userId,
    salesUsers: (salesUsersResult.data ?? []) as any[],
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
