// RBAC: user (admin, boss) + service_role
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/supabase-server";
import { getAuthProfile, canAccessLead } from "@/lib/lead-auth";
import { calculateQuotation, CalculateResult } from "../../../../lib/quotation-engine";
import { DEVICE_CATALOG } from "@/lib/device-catalog";
import { logger, genReqId } from "@/lib/logger";

const VALID_DEVICE_IDS = new Set<string>(
  DEVICE_CATALOG.flatMap((cat) => cat.devices.map((d) => d.id)),
);

/**
 * POST /api/quotations/generate
 * 计算报价并保存到数据库，生成 quote_no，更新 lead 阶段
 *
 * Input:  { lead_id, devices, discount_rate?, notes? }
 * Output: { status, quote_id, quote_no, total, valid_until }
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

/** Generate quote number: NM-YYYY-XXXX (sequential) */
async function generateQuoteNo(supabase: any): Promise<string> {
  const year = new Date().getFullYear().toString();

  // Find current max sequence for this year
  const { data } = await (supabase as any)
    .from("quotations")
    .select("quote_no")
    .like("quote_no", `NM-${year}-%`)
    .order("quote_no", { ascending: false })
    .limit(1);

  let nextSeq = 1;
  if (data && data.length > 0) {
    const lastNo: string = data[0].quote_no;
    const parts = lastNo.split("-");
    const lastSeq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(lastSeq)) {
      nextSeq = lastSeq + 1;
    }
  }

  const seqStr = nextSeq.toString().padStart(4, "0");
  return `NM-${year}-${seqStr}`;
}

export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const supabase = await createServerSupabase();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { lead_id, devices, discount_rate, notes } = body;

    if (!lead_id) {
      return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
    }

    // Ownership check: caller must have access to this lead (admin/boss bypass).
    // Verified before any service_role write.
    const profile = await getAuthProfile();
    if (!profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!(await canAccessLead(lead_id, profile))) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!devices || typeof devices !== "object" || Object.keys(devices).length === 0) {
      return NextResponse.json(
        { error: "devices object is required with at least one device" },
        { status: 400 },
      );
    }

    // Validate quantities
    for (const [key, val] of Object.entries(devices)) {
      if (typeof val !== "number" || val < 0) {
        return NextResponse.json(
          { error: `Invalid quantity for "${key}": must be a non-negative number` },
          { status: 400 },
        );
      }
    }

    // Reject unknown device_ids (DEVICE_CATALOG is the single source of truth,
    // matching quotation-engine.ts lookup). Prevents silent skip → zero-total.
    const unknownDevices = Object.keys(devices).filter((id) => !VALID_DEVICE_IDS.has(id));
    if (unknownDevices.length > 0) {
      return NextResponse.json(
        { error: "Unknown device_ids", unknown_devices: unknownDevices },
        { status: 400 },
      );
    }

    // 1. Calculate quotation
    const calculation: CalculateResult = calculateQuotation({
      lead_id,
      devices,
      discount_rate: typeof discount_rate === "number" ? discount_rate : 0,
      notes,
    });

    // Guard: calculation.total maps to the DB total_amount column which has a
    // CHECK > 0. Reject here (400) instead of letting convert hit a 500 later.
    // Catches all-qty-zero, all-skipped, and zero-price paths.
    if (calculation.total <= 0) {
      return NextResponse.json(
        { error: "Quotation total must be greater than zero" },
        { status: 400 },
      );
    }

    const supabaseAdmin = getSupabaseAdmin();

    // 2. Verify lead exists
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("id, customer_name")
      .eq("id", lead_id)
      .single();

    if (leadErr || !lead) {
      logger.error(
        {
          err: leadErr,
          request_id,
          operation: "quotation_generate",
          user_id: user.id,
          lead_id,
        },
        "[Quotation Generate] Lead not found",
      );
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    // 3. Generate quote number
    const quoteNo = await generateQuoteNo(supabaseAdmin);

    // 4. Save quotation to DB
    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from("quotations")
      .insert({
        lead_id,
        quote_no: quoteNo,
        version: 1,
        created_by: user.id,
        subtotal: calculation.subtotal,
        discount_rate: calculation.discount_rate,
        discount_amount: calculation.discount_amount,
        tax_rate: calculation.tax_rate,
        tax_amount: calculation.tax_amount,
        total_amount: calculation.total,
        currency: calculation.currency,
        valid_until: calculation.valid_until,
        status: "draft",
        devices_json: calculation.devices_json,
        notes: notes || null,
      })
      .select("id, quote_no")
      .single();

    if (quoteErr) {
      logger.error(
        {
          err: quoteErr,
          request_id,
          operation: "quotation_generate",
          user_id: user.id,
          lead_id,
        },
        "[Quotation Generate] Failed to insert quotation",
      );
      return NextResponse.json({ error: "Failed to save quotation" }, { status: 500 });
    }

    // 5. Create activity (quote_sent)
    const { error: activityErr } = await supabaseAdmin.from("activities").insert({
      lead_id,
      type: "quote_sent",
      content: `报价已生成 #${quoteNo} (${calculation.currency} ${calculation.total.toLocaleString()})`,
      ai_generated: true,
      user_id: user.id,
    });
    if (activityErr) {
      logger.error(
        {
          err: activityErr,
          request_id,
          operation: "quotation_generate",
          user_id: user.id,
          lead_id,
          quote_id: quote.id,
        },
        "[Quotation Generate] Failed to insert activity",
      );
    }

    // 6. Create business event
    const { error: eventErr } = await supabaseAdmin.from("business_events").insert({
      lead_id,
      event_type: "quotation_sent",
      description: `报价 ${quoteNo} 已生成，金额 ${calculation.currency} ${calculation.total.toLocaleString()}`,
      event_data: {
        quote_id: quote.id,
        quote_no: quoteNo,
        total: calculation.total,
        currency: calculation.currency,
      },
      user_id: user.id,
    });
    if (eventErr) {
      logger.error(
        {
          err: eventErr,
          request_id,
          operation: "quotation_generate",
          user_id: user.id,
          lead_id,
          quote_id: quote.id,
        },
        "[Quotation Generate] Failed to insert business event",
      );
    }

    // 7. Update lead stage
    const { error: updateErr } = await supabaseAdmin
      .from("leads")
      .update({
        stage: "quotation_submitted",
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id);
    if (updateErr) {
      logger.error(
        {
          err: updateErr,
          request_id,
          operation: "quotation_generate",
          user_id: user.id,
          lead_id,
          quote_id: quote.id,
        },
        "[Quotation Generate] Failed to update lead stage",
      );
    }

    // Revalidate cached pages to reflect new quotation
    revalidatePath("/quotes");
    revalidatePath("/leads");

    return NextResponse.json({
      status: "ok",
      quote_id: quote.id,
      quote_no: quoteNo,
      total: calculation.total,
      currency: calculation.currency,
      valid_until: calculation.valid_until,
    });
  } catch (err: any) {
    logger.error(
      {
        err,
        request_id,
        operation: "quotation_generate",
      },
      "[Quotation Generate] Error",
    );
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
