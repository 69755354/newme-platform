// RBAC: authenticated organization member. Support sessions cannot export.
import { NextResponse } from "next/server";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";

const COLUMNS = [
  "id",
  "customer_name",
  "email",
  "phone",
  "source",
  "stage",
  "lead_status",
  "assigned_to",
  "created_at",
] as const;

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const formulaSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  try {
    const access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "lead_export",
      null,
    );
    if (access.supportSessionId) {
      return NextResponse.json(
        { error: "support_export_not_permitted" },
        { status: 403 },
      );
    }

    const { data, error } = await access.client
      .from("leads")
      .select(COLUMNS.join(","))
      .eq("organization_id", access.organizationId)
      .order("created_at", { ascending: false })
      .limit(5_000);
    if (error) {
      return NextResponse.json({ error: "lead_export_failed" }, { status: 503 });
    }

    const exportRows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    const rows = [
      COLUMNS.map(csvCell).join(","),
      ...exportRows.map((lead) =>
        COLUMNS.map((column) =>
          csvCell(lead[column])).join(",")),
    ];
    return new NextResponse(rows.join("\r\n"), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="leads-${access.organizationId}.csv"`,
        "x-newme-organization-id": access.organizationId,
      },
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
