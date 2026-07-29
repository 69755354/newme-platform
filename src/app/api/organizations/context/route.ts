import { NextResponse } from "next/server";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
} from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  getRequestedOrganizationId,
  ORGANIZATION_CONTEXT_COOKIE,
  parseOrganizationId,
} from "@/lib/organization-context";

interface OrganizationOption {
  id: string;
  name: string;
  slug: string;
  industryKey: string;
}

function authErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestAuthError) {
    return NextResponse.json({ error: error.code }, { status: error.status });
  }
  return NextResponse.json(
    { error: "organization_context_unavailable" },
    { status: 503 },
  );
}

async function listOrganizations(userId: string): Promise<OrganizationOption[]> {
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from("memberships")
    .select("organization_id")
    .eq("user_id", userId)
    .eq("status", "active");
  if (membershipError) throw membershipError;

  const organizationIds = [
    ...new Set((memberships ?? []).map((row) => row.organization_id)),
  ];
  if (organizationIds.length === 0) return [];

  const { data: organizations, error: organizationError } = await supabaseAdmin
    .from("organizations")
    .select("id, name, slug, industry_key")
    .in("id", organizationIds)
    .eq("status", "active")
    .order("name", { ascending: true });
  if (organizationError) throw organizationError;

  return (organizations ?? []).map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    industryKey: organization.industry_key,
  }));
}

export async function GET(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    const organizations = await listOrganizations(context.user.id);
    const requestedOrganizationId = getRequestedOrganizationId(request);
    const currentOrganizationId = organizations.some(
      (organization) => organization.id === requestedOrganizationId,
    )
      ? requestedOrganizationId
      : null;
    return applyRequestAuthCookies(
      context,
      NextResponse.json({ organizations, currentOrganizationId }),
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const context = await getRequestAuthContext(request);
    const body = await request.json().catch(() => null);
    const organizationId = parseOrganizationId(body?.organizationId);
    if (!organizationId) {
      return NextResponse.json(
        { error: "invalid_organization_id" },
        { status: 400 },
      );
    }

    const organizations = await listOrganizations(context.user.id);
    if (!organizations.some((organization) => organization.id === organizationId)) {
      return NextResponse.json(
        { error: "active_organization_membership_required" },
        { status: 403 },
      );
    }

    const response = applyRequestAuthCookies(
      context,
      NextResponse.json({ organizationId }),
    );
    response.cookies.set(ORGANIZATION_CONTEXT_COOKIE, organizationId, {
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}

