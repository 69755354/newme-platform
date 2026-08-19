// RBAC: user (authenticated) + service_role
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { logger, genReqId } from "@/lib/logger";
import { parseInstallLabourNote } from "@/lib/quotation-labour-basis.mjs";

/**
 * GET /api/quotations/export?id=<quote_id>
 * Export quotation as CSV file
 */

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not configured — set it in production environment variables.",
    );
  }
  return createClient(url, key);
}

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
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const quoteId = searchParams.get("id");

    if (!quoteId) {
      return NextResponse.json(
        { error: "id query parameter is required (quote UUID)" },
        { status: 400 },
      );
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Fetch user role for ownership check
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const isAdminBoss = profile?.role === "admin" || profile?.role === "boss";

    // Fetch quotation with lead relationship
    const { data: quote, error: quoteErr } = await (supabaseAdmin as any)
      .from("quotations")
      .select("*, leads!inner(assigned_to)")
      .eq("id", quoteId)
      .single();

    if (quoteErr || !quote) {
      return NextResponse.json({ error: "Quotation not found" }, { status: 404 });
    }

    // Ownership check: non-admin/boss users can only export their own leads' quotations
    if (!isAdminBoss) {
      const assignedTo = quote.leads?.assigned_to;
      if (!assignedTo || assignedTo !== user.id) {
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
      const d = info as Record<string, any>;
      rows.push([
        deviceId,
        d.name || EMPTY,
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

    // Service fees. There are no columns for them: they are either restated from
    // the labour-basis marker this quotation was saved with, or — for every
    // quotation saved without one, which is all of the older ones — re-derived
    // from `subtotal` exactly as before, so their exports do not change.
    const subtotal = quote.subtotal || 0;
    const discountAmount = quote.discount_amount || 0;
    const afterDiscount = subtotal - discountAmount;
    const labourNote = parseInstallLabourNote(quote.internal_notes);

    if (labourNote) {
      const stored = (value: number | null, fallbackRate: number) =>
        String(value === null ? Math.round(afterDiscount * fallbackRate * 100) / 100 : value);
      rows.push([
        "Installation & Labor (cable & threading model):",
        "",
        "",
        "",
        String(labourNote.install_labor),
      ]);
      rows.push(["Cable Material:", "", "", "", String(labourNote.cable_material)]);
      rows.push(["Commissioning (12%):", "", "", "", stored(labourNote.commissioning, 0.12)]);
      rows.push(["Project Management (8%):", "", "", "", stored(labourNote.project_management, 0.08)]);
    } else {
      // Estimate service fees — store them if generate saved them, otherwise calculate
      const installLabor = afterDiscount * 0.3;
      const commissioning = afterDiscount * 0.12;
      const projectMgmt = afterDiscount * 0.08;

      rows.push(["Installation & Labor (30%):", "", "", "", String(Math.round(installLabor * 100) / 100)]);
      rows.push(["Commissioning (12%):", "", "", "", String(Math.round(commissioning * 100) / 100)]);
      rows.push(["Project Management (8%):", "", "", "", String(Math.round(projectMgmt * 100) / 100)]);
    }
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
  } catch (err: any) {
    logger.error(
      {
        err,
        request_id,
        operation: "quotation_export",
      },
      "[Quotation Export] Error",
    );
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
