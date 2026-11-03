// RBAC: user (authenticated). The insert runs with the caller's own session, so
// row-level security decides who may create a lead exactly as before; only the
// duplicate lookup and the notification fan-out use the service client.
//
// POST /api/leads — create one lead from the new-lead page or the quick-create
// dialog (S3 #4, #5, #8). Previously both wrote leads directly from the
// browser: no validation (empty leads, letters as phone numbers, 3000-character
// fields), no phone normalisation, no duplicate check, and a notification that
// the page's own redirect often cancelled.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import { validateNewLead, LEAD_FIELD_LIMITS } from "@/lib/lead-contact.mjs";
import { findDuplicateLeads, presentDuplicates } from "@/lib/lead-duplicates";
import { isLeadTransferCandidate } from "@/lib/lead-transfer-candidates.mjs";
import { createFollowUpTask } from "@/lib/tasks";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { duplicateReviewDrafts, leadCreatedDrafts } from "@/lib/notification-events";
import { createNotificationsBulk } from "@/lib/notifications";
import type { Database } from "@/types/database";

export const dynamic = "force-dynamic";

const SOURCES = ["offline", "whatsapp", "ins", "fb", "show_room", "website", "referral", "other"];
const OVERRIDE_ROLES = ["admin", "boss", "operator"];

export async function POST(request: NextRequest) {
  let context;
  try {
    context = await getRequestAuthContext(request);
  } catch (error) {
    if (error instanceof RequestAuthError) return requestAuthErrorResponse(error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
  const auth = context;
  const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
    applyRequestAuthCookies(auth, NextResponse.json(body, init));

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return respond({ error: "invalid_body", code: "INVALID_REQUEST" }, { status: 400 });
  }

  const checked = validateNewLead(body);
  if (!checked.ok) {
    return respond({ error: "validation_failed", code: "VALIDATION_FAILED", errors: checked.errors }, { status: 400 });
  }
  const lead = checked.value;
  const source = typeof body.source === "string" && SOURCES.includes(body.source) ? body.source : "offline";

  const override = body.duplicateOverride && typeof body.duplicateOverride === "object"
    ? body.duplicateOverride as { reason?: unknown }
    : null;
  const overrideReason = typeof override?.reason === "string" ? override.reason.trim() : "";

  let duplicates;
  try {
    duplicates = await findDuplicateLeads(supabaseAdmin, { phone: lead.phone, email: lead.email });
  } catch {
    return respond({ error: "duplicate_lookup_failed", code: "DUPLICATE_LOOKUP_FAILED" }, { status: 503 });
  }
  // S3 #4 (coordinator decision): nobody is hard-blocked. Admin/boss/operator
  // override with a reason; a salesperson may also create after giving a
  // reason, and the new lead is then flagged (sales_manager_review) and sent
  // to the admin/operator queue for duplicate review.
  const reviewRequired = !OVERRIDE_ROLES.includes(auth.role);
  if (duplicates.length > 0) {
    const shown = presentDuplicates(duplicates, { id: auth.user.id, role: auth.role });
    if (!override) {
      return respond({ error: "duplicate_lead", code: "DUPLICATE_LEAD", duplicates: shown, canOverride: true, reviewRequired }, { status: 409 });
    }
    if (overrideReason.length < 3 || overrideReason.length > LEAD_FIELD_LIMITS.override_reason) {
      return respond({ error: "override_reason_required", code: "OVERRIDE_REASON_REQUIRED", duplicates: shown, canOverride: true, reviewRequired }, { status: 400 });
    }
  }
  const flaggedForReview = duplicates.length > 0 && reviewRequired;

  const assigneeId = isLeadTransferCandidate({ role: auth.role, is_active: auth.profile.is_active === true })
    ? auth.user.id
    : null;
  const followupDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: inserted, error: insertError } = await auth.supabase.from("leads").insert({
    source,
    customer_name: lead.customer_name,
    phone: lead.phone,
    email: lead.email,
    location: lead.location,
    quality: "pending",
    assigned_to: assigneeId,
    created_by: auth.user.id,
    next_action: "call",
    next_followup_date: followupDate,
    ...(flaggedForReview ? { sales_manager_review: true } : {}),
  }).select("id, customer_name, assigned_to").single();
  if (insertError || !inserted) {
    return respond({ error: "create_failed", code: "CREATE_FAILED" }, { status: insertError?.code === "42501" ? 403 : 500 });
  }

  const warnings: string[] = [];
  if (lead.notes) {
    const { error } = await auth.supabase.from("follow_up_logs").insert({
      lead_id: inserted.id,
      contact_type: "note",
      summary: lead.notes,
      contact_time: new Date().toISOString(),
      user_id: auth.user.id,
      no_answer: false,
    });
    if (error) warnings.push("note_failed");
  }

  const { error: taskError } = await createFollowUpTask(auth.supabase as unknown as SupabaseClient, {
    leadId: inserted.id,
    dueAt: followupDate,
    title: "Follow up",
    assigneeId,
    source: "follow_up",
  });
  if (taskError) warnings.push("task_failed");

  if (duplicates.length > 0) {
    // The override is part of the lead's history: who decided, why, and which
    // existing leads they were shown.
    const { error } = await auth.supabase.from("business_events").insert({
      lead_id: inserted.id,
      user_id: auth.user.id,
      event_type: "note_added",
      description: `Created despite possible duplicate: ${overrideReason}`,
      event_data: {
        duplicate_override: true,
        reason: overrideReason,
        duplicate_lead_ids: duplicates.map((d) => d.id),
        review_required: flaggedForReview,
      },
    });
    if (error) warnings.push("override_audit_failed");
  }

  try {
    const drafts = await leadCreatedDrafts(supabaseAdmin as SupabaseClient<Database>, inserted, auth.user.id);
    if (flaggedForReview) {
      drafts.push(...await duplicateReviewDrafts(supabaseAdmin as SupabaseClient<Database>, inserted, auth.user.id));
    }
    await createNotificationsBulk(drafts);
  } catch {
    warnings.push("notification_failed");
  }

  return respond({ success: true, id: inserted.id, assignedTo: inserted.assigned_to, flaggedForReview, warnings }, { status: 201 });
}
