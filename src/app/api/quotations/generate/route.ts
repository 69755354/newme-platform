import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";
import { calculateQuotation, CalculateResult } from "../../../../lib/quotation-engine";

/**
 * POST /api/quotations/generate
 * 计算报价并保存到数据库，生成 quote_no，更新 lead 阶段
 *
 * Input:  { lead_id, devices, discount_rate?, notes? }
 * Output: { status, quote_id, quote_no, total, valid_until }
 */

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

    // 1. Calculate quotation
    const calculation: CalculateResult = calculateQuotation({
      lead_id,
      devices,
      discount_rate: typeof discount_rate === "number" ? discount_rate : 0,
      notes,
    });

    // 2. Verify lead exists
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("id, customer_name")
      .eq("id", lead_id)
      .single();

    if (leadErr || !lead) {
      console.error("[Quotation Generate] Lead not found:", leadErr);
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
      console.error("[Quotation Generate] Failed to insert quotation:", quoteErr);
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
      console.error("[Quotation Generate] Failed to insert activity:", activityErr);
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
      console.error("[Quotation Generate] Failed to insert business event:", eventErr);
    }

    // 7. Update lead stage + backfill quotation_value (P0 fix: pipeline value)
    const { error: updateErr } = await supabaseAdmin
      .from("leads")
      .update({
        stage: "quotation_submitted",
        quotation_value: calculation.total,
        updated_at: new Date().toISOString(),
      })
      .eq("id", lead_id);
    if (updateErr) {
      console.error("[Quotation Generate] Failed to update lead stage:", updateErr);
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
    console.error("[Quotation Generate] Error:", err);
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
