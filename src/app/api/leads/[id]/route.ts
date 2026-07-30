// RBAC: authenticated organization member, or audited platform support session.
import { NextResponse } from "next/server";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "lead",
      id,
    );
    const { data, error } = await access.client
      .from("leads")
      .select("*")
      .eq("organization_id", access.organizationId)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: "lead_fetch_failed" }, { status: 503 });
    }
    if (!data) {
      return NextResponse.json({ error: "lead_not_found" }, { status: 404 });
    }
    return NextResponse.json({
      organizationId: access.organizationId,
      lead: data,
    });
  } catch (error) {
    if (error instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof RequestAuthError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { error: "lead_organization_access_unavailable" },
      { status: 503 },
    );
  }
}
