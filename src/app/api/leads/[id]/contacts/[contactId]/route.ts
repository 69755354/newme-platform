// RBAC: authenticated lead owner, admin, or boss
import { NextRequest, NextResponse } from "next/server";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import { createServerSupabase } from "@/lib/supabase-server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const METHODS = new Set(["phone", "whatsapp", "other"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> },
) {
  try {
    const profile = await getAuthProfile();
    if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: leadId, contactId } = await params;
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

    // follow_up_logs is intentionally immutable through client RLS. After the
    // explicit auth/ownership checks above, use the server-only admin client for
    // this narrowly scoped correction and immediately read the stored row back.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("follow_up_logs")
      .update({
        contact_type: contactMethod,
        contact_time: contactTime.toISOString(),
        contact_result: contactResult,
        summary,
      })
      .eq("id", contactId)
      .eq("lead_id", leadId)
      .select("id, lead_id, contact_type, contact_time, contact_result, summary, user_id, created_at")
      .single();

    if (updateError || !updated) {
      return NextResponse.json(
        { error: updateError?.message ?? "Contact record not found" },
        { status: updateError?.code === "PGRST116" ? 404 : 400 },
      );
    }

    return NextResponse.json({ success: true, contact: updated });
  } catch (error) {
    console.error("contact update route error", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; contactId: string }> },
) {
  try {
    const profile = await getAuthProfile();
    if (!profile) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id: leadId, contactId } = await params;
    const supabase = await createServerSupabase();
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, assigned_to")
      .eq("id", leadId)
      .single();

    if (leadError || !lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
      return NextResponse.json({ error: "Forbidden: lead not assigned to you" }, { status: 403 });
    }

    const { data: contact, error: contactError } = await supabaseAdmin
      .from("follow_up_logs")
      .select("id, contact_type")
      .eq("id", contactId)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (contactError || !contact) return NextResponse.json({ error: "Contact record not found" }, { status: 404 });
    if (["note", "import_note"].includes(contact.contact_type)) {
      return NextResponse.json({ error: "Notes cannot be deleted as contact records" }, { status: 403 });
    }

    const { error: deleteError } = await supabaseAdmin
      .from("follow_up_logs")
      .delete()
      .eq("id", contactId)
      .eq("lead_id", leadId);
    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 400 });

    return NextResponse.json({ success: true, id: contactId });
  } catch (error) {
    console.error("contact delete route error", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
