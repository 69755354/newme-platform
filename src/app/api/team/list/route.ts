// RBAC: user (authenticated)
import { NextResponse } from "next/server"
import { createServerSupabase } from "@/lib/supabase-server"
import { getCached, setCache } from "@/lib/api-cache.mjs"

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

  const cacheKey = `team:list:${role}:${userId}`
  const cached = getCached(cacheKey)
  if (cached) return NextResponse.json(cached)

  const responseData = {
    currentUserId: userId,
    currentUserRole: role,
  }

  setCache(cacheKey, responseData, 30)
  return NextResponse.json(responseData)
}
