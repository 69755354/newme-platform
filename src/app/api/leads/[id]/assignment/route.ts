import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearerToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = req.headers.get("cookie") ?? "";
  const profile = await getAuthProfile(bearerToken, cookieHeader);
  if (!profile) return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  if (!isAdminOrBoss(profile) && profile.role !== "operator") {
    return NextResponse.json({ error: "Forbidden", code: "FORBIDDEN_REASSIGNMENT" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  if (!validUuid(body.assignedTo) || !validUuid(body.idempotencyKey)) {
    return NextResponse.json({ error: "assignedTo and idempotencyKey must be UUIDs", code: "INVALID_REQUEST" }, { status: 400 });
  }
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : "manual_reassign";
  const { id: leadId } = await params;
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data, error } = await supabase.rpc("reassign_lead_atomic", {
    p_lead_id: leadId,
    p_new_assignee: body.assignedTo,
    p_expected_updated_at: expectedUpdatedAt,
    p_idempotency_key: body.idempotencyKey,
    p_reason: reason,
  });

  if (error) {
    const message = error.message || "Lead reassignment failed";
    const status = message.includes("UNAUTHORIZED") ? 401
      : message.includes("FORBIDDEN") ? 403
      : message.includes("NOT_FOUND") ? 404
      : message.includes("CONCURRENT") ? 409
      : 400;
    return NextResponse.json({ error: message, code: message }, { status });
  }
  return NextResponse.json({ success: true, result: data });
}
