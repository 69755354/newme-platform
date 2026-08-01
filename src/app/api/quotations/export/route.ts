// RBAC: authenticated organization member; support sessions cannot export.
import { NextRequest, NextResponse } from "next/server";
import { logger, genReqId } from "@/lib/logger";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { RequestAuthError } from "@/lib/request-auth-context";

/**
 * GET /api/quotations/export?id=<quote_id>
 * Export quotation as CSV file
 */

/** Escape a CSV field value */
function csvEscape(val: unknown): string {
  const str = val == null ? "" : String(val);
  // If contains comma, quote, or newline — wrap in double quotes
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Build CSV content from a 2D array of rows */
function buildCsv(rows: string[][]): string {
  // BOM for Excel compatibility with Arabic/Chinese
  return "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

export async function GET(request: NextRequest) {
  const request_id = genReqId();
  try {
    const access = await resolveLeadOrganizationAccess(
      request,
      "lead:read",
      "quotation_export",
      null,
    );
    if (access.supportSessionId) {
      return NextResponse.json(
        { error: "support_export_not_permitted" },
        { status: 403 },
      );
    }

    const { searchParams } = new URL(request.url);
    const quoteId = searchParams.get("id");

    if (!quoteId) {
      return NextResponse.json(
        { error: "id query parameter is required (quote UUID)" },
        { status: 400 },
      );
    }

    const isManagement = ["admin", "boss", "operator"].includes(
      access.context.role,
    );

    // Fetch quotation with lead relationship
    const { data: quote, error: quoteErr } = await access.client
      .from("quotations")
      .select("*, leads!quotations_lead_id_fkey!inner(assigned_to,organization_id)")
      .eq("id", quoteId)
      .eq("organization_id", access.organizationId)
      .eq("leads.organization_id", access.organizationId)
      .single();

    if (quoteErr || !quote) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }

    // Ownership check: non-admin/boss users can only export their own leads' quotations
    if (!isManagement) {
      const lead = Array.isArray(quote.leads) ? quote.leads[0] : quote.leads;
      const assignedTo = lead?.assigned_to;
      if (!assignedTo || assignedTo !== access.context.user.id) {
        return NextResponse.json({ error: "Forbidden: not assigned to this lead" }, { status: 403 });
      }
    }

    // Build CSV rows
    const rows: string[][] = [];
    const EMPTY = "";

    // Header section
    rows.push(["NewMe Smart Home Quotation"]);
    rows.push(["Quote No:", quote.quote_no]);
    rows.push(["Date:", quote.created_at ? new Date(quote.created_at).toLocaleDateString() : EMPTY]);
    rows.push(["Valid Until:", quote.valid_until ? new Date(quote.valid_until).toLocaleDateString() : EMPTY]);
    rows.push(["Currency:", quote.currency || "AED"]);
    rows.push(["Status:", quote.status]);
    rows.push([EMPTY]);

    // Device breakdown
    rows.push(["Device ID", "Name", "Qty", "Unit Price", "Line Total"]);

    const devicesJson = quote.devices_json || {};
    for (const [deviceId, info] of Object.entries(devicesJson)) {
      const d = info as Record<string, unknown>;
      rows.push([
        deviceId,
        String(d.name ?? EMPTY),
        String(d.qty || 0),
        String(d.unit_price || 0),
        String(d.line_total || 0),
      ]);
    }

    rows.push([EMPTY]);

    // Totals section
    rows.push(["Subtotal:", "", "", "", String(quote.subtotal || 0)]);
    rows.push(["Discount Rate:", "", "", "", `${quote.discount_rate || 0}%`]);
    rows.push(["Discount Amount:", "", "", "", `-${String(quote.discount_amount || 0)}`]);
    rows.push(["After Discount:", "", "", "", String((quote.subtotal || 0) - (quote.discount_amount || 0))]);

    // Service fees (calculate from stored values or from devices_json)
    const subtotal = quote.subtotal || 0;
    const discountAmount = quote.discount_amount || 0;
    const afterDiscount = subtotal - discountAmount;

    // Estimate service fees — store them if generate saved them, otherwise calculate
    const installLabor = afterDiscount * 0.3;
    const commissioning = afterDiscount * 0.12;
    const projectMgmt = afterDiscount * 0.08;

    rows.push(["Installation & Labor (30%):", "", "", "", String(Math.round(installLabor * 100) / 100)]);
    rows.push(["Commissioning (12%):", "", "", "", String(Math.round(commissioning * 100) / 100)]);
    rows.push(["Project Management (8%):", "", "", "", String(Math.round(projectMgmt * 100) / 100)]);
    rows.push([EMPTY]);
    rows.push(["Tax Rate:", "", "", "", `${quote.tax_rate || 5}%`]);
    rows.push(["Tax Amount:", "", "", "", String(quote.tax_amount || 0)]);
    rows.push(["Total Amount:", "", "", "", String(quote.total_amount || 0)]);
    rows.push([EMPTY]);

    // Notes
    if (quote.notes) {
      rows.push(["Notes:", quote.notes]);
    }

    const csvContent = buildCsv(rows);
    const filename = `quotation_${quote.quote_no || quoteId}.csv`;

    return new NextResponse(csvContent, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err: unknown) {
    if (err instanceof LeadOrganizationAccessError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    if (err instanceof RequestAuthError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    logger.error(
      {
        err,
        request_id,
        operation: "quotation_export",
      },
      "[Quotation Export] Error",
    );
    const message = process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal error";
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
