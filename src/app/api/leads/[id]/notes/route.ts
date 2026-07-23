import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { getAuthProfile } from "@/lib/lead-auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearerToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = req.headers.get("cookie") ?? "";
  if (!await getAuthProfile(bearerToken, cookieHeader)) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note || note.length > 4000 || !UUID.test(body.idempotencyKey ?? "")) {
    return NextResponse.json({ error: "A note and valid idempotency key are required", code: "INVALID_NOTE_REQUEST" }, { status: 400 });
  }
  const { id: leadId } = await params;
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data, error } = await supabase.rpc("record_lead_note_atomic", {
    p_lead_id: leadId,
    p_note: note,
    p_idempotency_key: body.idempotencyKey,
  });
  if (error) {
    const message = error.message || "Note save failed";
    const status = message.includes("UNAUTHORIZED") ? 401
      : message.includes("FORBIDDEN") ? 403
      : message.includes("NOT_FOUND") ? 404
      : 400;
    return NextResponse.json({ error: message, code: message }, { status });
  }
  return NextResponse.json({ success: true, result: data });
}
