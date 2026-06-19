import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// DELETE /api/leads/delete?id=<lead_id>
// Application-level protection: only admin/boss can delete leads.
// PostgREST DELETE RLS on leads table is broken (2026-06-18) -
// 6 different policy approaches tested, all ignored by PostgREST.
export async function DELETE(request: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Get session from cookie to identify user
    const cookieStore = await cookies();
    const sbAccessToken = cookieStore.get("sb-access-token")?.value;
    const sbRefreshToken = cookieStore.get("sb-refresh-token")?.value;

    if (!sbAccessToken && !sbRefreshToken) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    // Verify user and get role
    let userId: string | null = null;
    if (sbAccessToken) {
      const { data: { user } } = await createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      }).auth.getUser(sbAccessToken);
      userId = user?.id ?? null;
    }

    if (!userId) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { data: profile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", userId)
      .single();

    if (!profile || !["admin", "boss"].includes(profile.role)) {
      return NextResponse.json(
        { error: "Forbidden: only admin/boss can delete leads" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Missing lead ID" }, { status: 400 });
    }

    const { error } = await adminClient.from("leads").delete().eq("id", id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 }
    );
  }
}
