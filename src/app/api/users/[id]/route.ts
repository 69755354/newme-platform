// RBAC: active organization admin/boss membership.
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { resolveActiveLeadReassignmentTarget } from "@/lib/lead-reassignment.mjs";
import {
  activeOrganizationMemberIds,
  OrganizationMemberAdminError,
  requireOrganizationMembership,
  resolveOrganizationMemberAdminAccess,
} from "@/lib/organization-member-admin";
import { RequestAuthError } from "@/lib/request-auth-context";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const access = await resolveOrganizationMemberAdminAccess(request);
    if (access.context.user.id === id) {
      return NextResponse.json(
        { error: "cannot_deactivate_self" },
        { status: 400 },
      );
    }
    const membership = await requireOrganizationMembership(
      access.organizationId,
      id,
    );

    const memberIds = (await activeOrganizationMemberIds(
      access.organizationId,
    )).filter((memberId) => memberId !== id);
    const reassignTo = memberIds.length === 0
      ? null
      : await resolveActiveLeadReassignmentTarget(
          supabaseAdmin
            .from("profiles")
            .select("id,role,is_active")
            .in("id", memberIds) as never,
        );

    const { data: organizationLeads, error: leadsError } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("organization_id", access.organizationId)
      .eq("assigned_to", id);
    if (leadsError) {
      throw new Error(`organization_leads_fetch_failed:${leadsError.message}`);
    }
    const leadIds = (organizationLeads ?? []).map((lead) => lead.id);
    if (leadIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("leads")
        .update({ assigned_to: reassignTo })
        .eq("organization_id", access.organizationId)
        .in("id", leadIds);
      if (error) throw new Error(`lead_reassignment_failed:${error.message}`);
    }

    const now = new Date().toISOString();
    const { data: updatedMembership, error: membershipError } = await supabaseAdmin
      .from("memberships")
      .update({
        status: "inactive",
        deactivated_at: now,
        recovery_deadline: new Date(
          Date.now() + 90 * 24 * 60 * 60 * 1_000,
        ).toISOString(),
        updated_at: now,
        version: membership.version + 1,
      })
      .eq("id", membership.id)
      .eq("organization_id", access.organizationId)
      .eq("version", membership.version)
      .select("id")
      .maybeSingle();
    if (membershipError || !updatedMembership) {
      throw new Error(
        `membership_deactivation_failed:${membershipError?.message ?? "membership_changed_concurrently"}`,
      );
    }

    const { error: auditError } = await supabaseAdmin
      .from("audit_events")
      .insert({
        organization_id: access.organizationId,
        actor_user_id: access.context.user.id,
        action: "organization.member.deactivate",
        target_type: "membership",
        target_id: membership.id,
        outcome: "success",
        request_id: access.context.requestId,
        metadata: {
          target_user_id: id,
          reassigned_lead_count: leadIds.length,
          reassign_to: reassignTo,
        },
      });
    if (auditError) {
      throw new Error(`membership_audit_failed:${auditError.message}`);
    }

    return NextResponse.json({
      success: true,
      organization_id: access.organizationId,
      reassigned_lead_count: leadIds.length,
      reassign_to: reassignTo,
    });
  } catch (error) {
    if (
      error instanceof OrganizationMemberAdminError
      || error instanceof RequestAuthError
    ) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "member_deactivation_failed" },
      { status: 503 },
    );
  }
}
