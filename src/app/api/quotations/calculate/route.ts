// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { calculateQuotation } from "../../../../lib/quotation-engine";
import { logger, genReqId } from "@/lib/logger";
import { buildBottomUpLabourRequest } from "@/lib/quotation-labour-request";

/**
 * POST /api/quotations/calculate
 * 实时计算报价（不保存到数据库）
 *
 * Input:  { lead_id?, devices: { "dali_gateway_4": 3, ... }, discount_rate?, notes?,
 *           bottom_up_labour?: { area_sqm, floors, point_quantities, tier? } }
 * Output: { subtotal, discount_amount, after_discount, install_labor,
 *           install_labor_basis, cable_material, commissioning, ... }
 *
 * `bottom_up_labour` prices the labour line from the cable/threading model
 * instead of a percentage of the product total. `point_quantities` is keyed on
 * the cabling point ids from GET /api/cable-costing/catalogue, which are NOT
 * device catalogue ids. Leave it out and the labour line keeps the historic
 * percentage; `install_labor_basis` always states which one was used.
 */
export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    // Simple auth check: just verify user is logged in
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const supabase = await createServerSupabase(bearerToken, cookieHeader);
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { devices, discount_rate, notes, bottom_up_labour } = body;

    if (!devices || typeof devices !== "object" || Object.keys(devices).length === 0) {
      return NextResponse.json(
        { error: "devices object is required with at least one device" },
        { status: 400 },
      );
    }

    // Validate all quantities are positive numbers
    for (const [key, val] of Object.entries(devices)) {
      if (typeof val !== "number" || val < 0) {
        return NextResponse.json(
          { error: `Invalid quantity for "${key}": must be a non-negative number` },
          { status: 400 },
        );
      }
    }

    const result = calculateQuotation({
      lead_id: body.lead_id,
      devices,
      discount_rate: typeof discount_rate === "number" ? discount_rate : 0,
      notes,
      bottom_up_labour: buildBottomUpLabourRequest(bottom_up_labour, {
        request_id,
        operation: "quotation_calculate",
      }),
    });

    return NextResponse.json(result);
  } catch (err: any) {
    logger.error(
      {
        err,
        request_id,
        operation: "quotation_calculate",
      },
      "[Quotation Calculate] Error",
    );
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
