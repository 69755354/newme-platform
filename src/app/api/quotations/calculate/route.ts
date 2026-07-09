// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase-server";
import { calculateQuotation } from "../../../../lib/quotation-engine";

/**
 * POST /api/quotations/calculate
 * 实时计算报价（不保存到数据库）
 *
 * Input:  { lead_id?, devices: { "dali_gateway_4": 3, ... }, discount_rate?, notes? }
 * Output: { subtotal, discount_amount, after_discount, install_labor, commissioning, ... }
 */
export async function POST(request: NextRequest) {
  try {
    // Simple auth check: just verify user is logged in
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { devices, discount_rate, notes } = body;

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
    });

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[Quotation Calculate] Error:", err);
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
