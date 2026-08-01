import { NextRequest, NextResponse } from "next/server";
import {
  OrganizationMemberAdminError,
  resolveOrganizationMemberAdminAccess,
} from "@/lib/organization-member-admin";
import { applyRequestAuthCookies } from "@/lib/request-auth-context";
import { supabaseAdmin } from "@/lib/supabase-admin";

type ExportPackage = {
  contract_version: number;
  data_sha256: string;
  data: unknown;
  generated_at: string;
};

function mappedError(error: unknown): { code: string; status: number } {
  if (error instanceof OrganizationMemberAdminError) {
    return { code: error.code, status: error.status };
  }
  const message = error !== null
    && typeof error === "object"
    && "message" in error
    && typeof error.message === "string"
    ? error.message
    : "";
  for (const [code, status] of [
    ["organization_export_owner_required", 403],
    ["organization_export_unavailable", 409],
    ["organization_not_found", 404],
  ] as const) {
    if (message.includes(code)) return { code, status };
  }
  return { code: "organization_export_unavailable", status: 503 };
}

function isExportPackage(value: unknown): value is ExportPackage {
  return value !== null
    && typeof value === "object"
    && "contract_version" in value
    && value.contract_version === 1
    && "data_sha256" in value
    && typeof value.data_sha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.data_sha256)
    && "generated_at" in value
    && typeof value.generated_at === "string"
    && "data" in value;
}

export async function GET(request: NextRequest) {
  try {
    const access = await resolveOrganizationMemberAdminAccess(request);
    const { data, error } = await supabaseAdmin.rpc(
      "export_organization_customer_data",
      {
        p_organization_id: access.organizationId,
        p_actor_user_id: access.context.user.id,
        p_request_id: access.context.requestId,
      },
    );
    if (error || !isExportPackage(data)) {
      const mapped = mappedError(error);
      return NextResponse.json(
        { error: mapped.code },
        { status: mapped.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    const filename = `newme-organization-${access.organizationId}-${data.data_sha256.slice(0, 12)}.json`;
    return applyRequestAuthCookies(
      access.context,
      new NextResponse(JSON.stringify(data), {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      }),
    );
  } catch (error) {
    const mapped = mappedError(error);
    return NextResponse.json(
      { error: mapped.code },
      { status: mapped.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
