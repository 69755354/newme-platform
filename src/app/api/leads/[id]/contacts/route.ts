// RBAC: authenticated lead owner, admin, or boss
import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { logger, genReqId } from "@/lib/logger";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import { createServerSupabase } from "@/lib/supabase-server";

const METHODS = new Set(["phone", "whatsapp", "other"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const request_id = genReqId();
  const { id: leadId } = await params;
  try {
    const bearerToken = req.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = req.headers.get("cookie") ?? "";
    const profile = await getAuthProfile(bearerToken, cookieHeader);
    if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json();
    // bearerToken and cookieHeader already declared above
    const contactMethod = String(body?.contact_method ?? "").trim().toLowerCase();
    const contactResult = String(body?.contact_result ?? "").trim();
    const summary = String(body?.summary ?? "").trim();
    const contactTime = new Date(String(body?.contact_time ?? ""));

    if (!METHODS.has(contactMethod)) {
      return NextResponse.json({ error: "Invalid contact_method" }, { status: 400 });
    }
    if (Number.isNaN(contactTime.getTime())) {
      return NextResponse.json({ error: "Invalid contact_time" }, { status: 400 });
    }
    if (contactTime.getTime() > Date.now()) {
      return NextResponse.json({ error: "contact_time cannot be in the future" }, { status: 400 });
    }
    if (!contactResult) {
      return NextResponse.json({ error: "contact_result is required" }, { status: 400 });
    }

    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }
    if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
      return NextResponse.json({ error: "Forbidden: lead not assigned to you" }, { status: 403 });
    }

    const contactFingerprint = createHash("sha256")
      .update(JSON.stringify([
        leadId,
        profile.userId,
        contactMethod,
        contactTime.toISOString(),
        contactResult,
        summary,
      ]))
      .digest("hex");

    const { data: contact, error: insertError } = await supabase.rpc("record_lead_contact_atomic", {
      p_lead_id: leadId,
      p_contact_method: contactMethod,
      p_contact_time: contactTime.toISOString(),
      p_contact_result: contactResult,
      p_summary: summary || contactResult,
      p_contact_fingerprint: contactFingerprint,
      p_idempotency_key: randomUUID(),
    });
    if (insertError || !contact) {
      return NextResponse.json(
        { error: insertError?.message ?? "Contact record could not be created" },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, contact });
  } catch (error) {
    logger.error(
      {
        err: error,
        request_id,
        operation: "contact_create",
        lead_id: leadId,
      },
      "contact create route error",
    );
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
