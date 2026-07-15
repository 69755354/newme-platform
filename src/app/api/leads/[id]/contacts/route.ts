// RBAC: authenticated lead owner, admin, or boss
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const METHODS = new Set(["phone", "whatsapp", "other"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const profile = await getAuthProfile();
    if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: leadId } = await params;
    const body = await req.json();
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

    const supabase = await createServerSupabase();
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

    // follow_up_logs is intentionally immutable through client RLS. After the
    // explicit auth/ownership check above, this narrowly scoped server write
    // creates the contact and returns the persisted row for readback.
    const { data: contact, error: insertError } = await supabaseAdmin
      .from("follow_up_logs")
      .upsert({
        lead_id: leadId,
        user_id: profile.userId,
        contact_type: contactMethod,
        contact_time: contactTime.toISOString(),
        contact_result: contactResult,
        summary: summary || null,
        no_answer: false,
        contact_fingerprint: contactFingerprint,
      }, { onConflict: "contact_fingerprint" })
      .select("id, lead_id, contact_type, contact_time, contact_result, summary, user_id, created_at")
      .single();

    if (insertError || !contact) {
      return NextResponse.json(
        { error: insertError?.message ?? "Contact record could not be created" },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, contact });
  } catch (error) {
    console.error("contact create route error", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
