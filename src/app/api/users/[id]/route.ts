// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";
import { requireActiveLeadTransferCandidate } from "@/lib/lead-reassignment.mjs";
import { handOverMemberLeads, readHandoverTarget } from "@/lib/member-lead-handover.mjs";
import { LEAD_TRANSFER_BATCH_KEY_PATTERN } from "@/lib/lead-transfer-batch.mjs";

// DELETE /api/users/[id] — admin/boss only, soft-delete
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
  const cookieHeader = request.headers.get("cookie") ?? "";
  const supabase = await createServerSupabase(bearerToken, cookieHeader);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();

  if (authErr || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check caller role
  const { data: caller } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!caller || (caller.role !== "admin" && caller.role !== "boss")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Prevent deleting yourself
  if (user.id === id) {
    return NextResponse.json({ error: "Cannot delete yourself" }, { status: 400 });
  }

  // S3 #6: the caller chooses the receiver of the member's leads (a user id, or
  // "unassigned" for the admin queue); there is no default. Every lead goes
  // through the audited transfer routines before the member is deactivated.
  const body = await request.json().catch(() => ({}));
  const choice = readHandoverTarget(body?.transferTo, id);
  if (!choice.ok) return NextResponse.json({ error: choice.code, code: choice.code }, { status: 400 });
  if (typeof body?.batchKey !== "string" || !LEAD_TRANSFER_BATCH_KEY_PATTERN.test(body.batchKey)) {
    return NextResponse.json({ error: "batchKey must be a UUID", code: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    if (choice.target) {
      try {
        await requireActiveLeadTransferCandidate(
          supabaseAdmin.from("profiles").select("id,role,is_active") as never,
          choice.target,
        );
      } catch {
        return NextResponse.json({ error: "HANDOVER_TARGET_INVALID", code: "HANDOVER_TARGET_INVALID" }, { status: 400 });
      }
    }

    const report = await handOverMemberLeads(supabase, {
      memberId: id,
      target: choice.target,
      batchKey: body.batchKey,
      reason: "member_removed",
    });
    if (!report.complete) {
      return NextResponse.json({
        error: "HANDOVER_INCOMPLETE",
        code: "HANDOVER_INCOMPLETE",
        conflicts: report.conflicts.length,
        failed: report.failed.length,
      }, { status: 409 });
    }

    // Contracts follow the chosen receiver; left in the queue they keep the
    // salesperson who sold them.
    if (choice.target) {
      const { error: contractErr } = await supabaseAdmin
        .from("contracts")
        .update({ sales_id: choice.target })
        .eq("sales_id", id);
      if (contractErr) throw new Error(`Failed to reassign contracts: ${contractErr.message}`);
    }

    // Soft-delete: mark as inactive in profiles
    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({ is_active: false })
      .eq("id", id);

    if (profileErr) throw new Error(profileErr.message);

    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(
      id,
      { ban_duration: "876000h" },
    );
    if (authErr) throw new Error(`Failed to revoke auth access: ${authErr.message}`);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
