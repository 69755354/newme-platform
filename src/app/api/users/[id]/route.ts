// RBAC: user (admin, boss)
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";
import { resolveActiveLeadReassignmentTarget } from "@/lib/lead-reassignment.mjs";

// DELETE /api/users/[id] — admin/boss only, soft-delete
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createServerSupabase();
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

  try {
    const reassignTo = await resolveActiveLeadReassignmentTarget(
      supabaseAdmin.from("profiles").select("id,role,is_active").neq("id", id) as never,
    );
    const logTarget = reassignTo ?? "null (no eligible receiver available)";

    // Reassign leads assigned to this user
    const { data: orphanedLeads, error: orphanedLeadsErr } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("assigned_to", id);
    if (orphanedLeadsErr) throw new Error(`Failed to load leads for reassignment: ${orphanedLeadsErr.message}`);
    if (orphanedLeads && orphanedLeads.length > 0) {
      const leadIds = orphanedLeads.map((l: any) => l.id);
      const { error: leadErr } = await supabaseAdmin
        .from("leads")
        .update({ assigned_to: reassignTo })
        .in("id", leadIds);
      if (leadErr) throw new Error(`Failed to reassign leads: ${leadErr.message}`);
      console.log(`[user-delete] Reassigned or unassigned ${leadIds.length} lead(s) from user ${id} to ${logTarget}`);
    }

    // Reassign contracts where this user is sales_id
    const { data: orphanedContracts, error: orphanedContractsErr } = await supabaseAdmin
      .from("contracts")
      .select("id")
      .eq("sales_id", id);
    if (orphanedContractsErr) throw new Error(`Failed to load contracts for reassignment: ${orphanedContractsErr.message}`);
    if (orphanedContracts && orphanedContracts.length > 0) {
      const contractIds = orphanedContracts.map((c: any) => c.id);
      const { error: contractErr } = await supabaseAdmin
        .from("contracts")
        .update({ sales_id: reassignTo })
        .in("id", contractIds);
      if (contractErr) throw new Error(`Failed to reassign contracts: ${contractErr.message}`);
      console.log(`[user-delete] Reassigned ${contractIds.length} contract(s) from user ${id} to ${logTarget}`);
    }

    // Soft-delete: mark as inactive in profiles
    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update({ is_active: false, deleted_at: new Date().toISOString() })
      .eq("id", id);

    if (profileErr) throw new Error(profileErr.message);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
