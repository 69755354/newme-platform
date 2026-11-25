// RBAC: user (admin, boss) + service_role
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { addDaysToDateKey, dubaiDateKey } from "@/lib/dubai-time.mjs";
import { createClient } from "@supabase/supabase-js";
import {
  applyRequestAuthCookies,
  getRequestAuthContext,
  RequestAuthError,
  requestAuthErrorResponse,
} from "@/lib/request-auth-context";
import { calculateQuotation, CalculateResult } from "../../../../lib/quotation-engine";
import { DEVICE_CATALOG } from "@/lib/device-catalog";
import { logger, genReqId } from "@/lib/logger";
import { discountRateError, discountRateErrorZh } from "@/lib/quotation-rules.mjs";
import { buildBottomUpLabourRequest } from "@/lib/quotation-labour-request";
import { formatInstallLabourNote } from "@/lib/quotation-labour-basis.mjs";
import { advanceStageForMilestone } from "@/lib/milestone-stage-advance.mjs";
import { isCompleteContact } from "@/lib/first-contact-gate.mjs";
import { enqueueMetaCrmEventForLead, enqueueMetaCrmFunnelForLead } from "@/lib/meta-crm-events";
import { enqueueQuotedFeedback } from "@/lib/quote-feedback.mjs";
import { enqueueWebsiteQuoteForProgress, enqueueWhatsAppProgressWithDelivery } from "@/lib/website-capi-valued";

const round2 = (value: number) => Math.round(value * 100) / 100;
// leads.quotation_value / quotations.total_amount are numeric(12,2): anything from 10^10 up cannot be stored.
const MAX_MANUAL_AMOUNT = 9_999_999_999;

type ManualQuote = {
  subtotal: number; discount_rate: number; discount_amount: number; tax_rate: number; tax_amount: number; total: number;
  currency: string; valid_until: string; payment_terms: string | null; delivery_terms: string | null;
};

/** Validates and prices the hand-typed quotation. Returns a refusal message instead of throwing. */
function priceManualQuote(raw: unknown): { quote: ManualQuote } | { error: string; error_zh: string; code: string } {
  const bad = (error: string, error_zh: string, code: string) => ({ error, error_zh, code });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("manual must be an object", "金额格式不对", "manual_invalid");
  const m = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const subtotal = round2(num(m.subtotal));
  if (!Number.isFinite(subtotal) || subtotal <= 0 || subtotal > MAX_MANUAL_AMOUNT) {
    return bad("A quotation amount greater than zero is required", "请填写大于 0 的报价金额", "manual_amount_invalid");
  }
  const discountRate = m.discount_rate === undefined || m.discount_rate === null || m.discount_rate === "" ? 0 : num(m.discount_rate);
  if (!Number.isFinite(discountRate) || discountRateError(discountRate)) {
    return bad(discountRateError(discountRate) || "Invalid discount rate", discountRateErrorZh(discountRate) || "折扣率不对", "discount_rate_invalid");
  }
  const taxRate = m.tax_rate === undefined || m.tax_rate === null || m.tax_rate === "" ? 0 : num(m.tax_rate);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) return bad("Invalid tax rate", "税率不对", "tax_rate_invalid");
  const currency = m.currency === undefined || m.currency === null || m.currency === "" ? "AED" : String(m.currency);
  if (!/^[A-Z]{3}$/.test(currency)) return bad("Invalid currency", "币种不对", "currency_invalid");
  const discountAmount = round2(subtotal * (discountRate / 100));
  const taxAmount = round2((subtotal - discountAmount) * (taxRate / 100));
  const total = round2(subtotal - discountAmount + taxAmount);
  if (total <= 0 || total > MAX_MANUAL_AMOUNT) return bad("Quotation total must be greater than zero", "报价总额必须大于 0", "manual_amount_invalid");
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);
  const validUntil = typeof m.valid_until === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.valid_until)
    ? m.valid_until
    : addDaysToDateKey(dubaiDateKey() as string, 30); // N7: 30 Dubai days
  return { quote: { subtotal, discount_rate: discountRate, discount_amount: discountAmount, tax_rate: taxRate, tax_amount: taxAmount, total,
    currency, valid_until: validUntil, payment_terms: text(m.payment_terms), delivery_terms: text(m.delivery_terms) } };
}

const VALID_DEVICE_IDS = new Set<string>(
  DEVICE_CATALOG.flatMap((cat) => cat.devices.map((d) => d.id)),
);

/**
 * POST /api/quotations/generate
 * 计算报价并保存到数据库，生成 quote_no，更新 lead 阶段
 *
 * Input:  { lead_id, devices, discount_rate?, notes?,
 *           bottom_up_labour?: { area_sqm, floors, point_quantities, tier? } }
 * Output: { status, quote_id, quote_no, total, valid_until, install_labor_basis }
 *
 * Hand-typed "amount only" quotation (no device list): send `manual` instead of `devices`:
 *   { lead_id, manual: { subtotal, discount_rate?, tax_rate?, currency?, valid_until?, payment_terms?, delivery_terms? }, notes? }
 * The server works out discount, tax and total itself (the browser total is never trusted) and the quotation then gets
 * the same side effects as an engine quotation: activity, business event, stage step, Meta / WhatsApp quote feedback.
 *
 * `bottom_up_labour` switches the labour line from a percentage of the product
 * total to the cable/threading model; `point_quantities` is keyed on the cabling
 * point ids of GET /api/cable-costing/catalogue. Omitted, unusable, or with no
 * rate card injected on this server, the labour line keeps the historic
 * percentage and `install_labor_basis` says so.
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

export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const context = await getRequestAuthContext(request);
    const { supabase, user } = context;
    const respond = (body: Record<string, unknown>, init?: ResponseInit) =>
      applyRequestAuthCookies(context, NextResponse.json(body, init));

    const body = await request.json();
    const { lead_id, devices, discount_rate, notes, bottom_up_labour, manual } = body;
    const isManual = manual !== undefined && manual !== null;

    if (!lead_id) {
      return respond({ error: "lead_id is required" }, { status: 400 });
    }

    // Ownership check: caller must have access to this lead (admin/boss bypass).
    // Verified before any service_role write.
    if (!["admin", "boss", "operator"].includes(context.role)) {
      const { data: accessibleLead } = await supabase
        .from("leads")
        .select("id, assigned_to")
        .eq("id", lead_id)
        .maybeSingle();
      if (!accessibleLead || accessibleLead.assigned_to !== user.id) {
        return respond({ error: "Forbidden" }, { status: 403 });
      }
    }

    let calculation: {
      subtotal: number; discount_rate: number; discount_amount: number; tax_rate: number; tax_amount: number; total: number;
      currency: string; valid_until: string; devices_json: unknown;
      install_labor_basis?: unknown; install_labor_fallback_reason?: unknown;
    };
    let manualQuote: ManualQuote | null = null;

    if (isManual) {
      const priced = priceManualQuote(manual);
      if ("error" in priced) {
        return respond({ error: priced.error, error_zh: priced.error_zh, code: priced.code }, { status: 400 });
      }
      manualQuote = priced.quote;
      calculation = { ...manualQuote, devices_json: {} };
    } else {
    if (!devices || typeof devices !== "object" || Object.keys(devices).length === 0) {
      return respond(
        { error: "devices object is required with at least one device" },
        { status: 400 },
      );
    }

    const discountProblem = discountRateError(discount_rate);
    if (discountProblem) {
      return respond({ error: discountProblem, error_zh: discountRateErrorZh(discount_rate), code: "discount_rate_invalid" }, { status: 400 });
    }

    // Validate quantities
    for (const [key, val] of Object.entries(devices)) {
      if (typeof val !== "number" || val < 0) {
        return respond(
          { error: `Invalid quantity for "${key}": must be a non-negative number` },
          { status: 400 },
        );
      }
    }

    // Reject unknown device_ids (DEVICE_CATALOG is the single source of truth,
    // matching quotation-engine.ts lookup). Prevents silent skip → zero-total.
    const unknownDevices = Object.keys(devices).filter((id) => !VALID_DEVICE_IDS.has(id));
    if (unknownDevices.length > 0) {
      return respond(
        { error: "Unknown device_ids", unknown_devices: unknownDevices },
        { status: 400 },
      );
    }

    // 1. Calculate quotation
    const engineResult: CalculateResult = calculateQuotation({
      lead_id,
      devices,
      discount_rate: typeof discount_rate === "number" ? discount_rate : 0,
      notes,
      bottom_up_labour: buildBottomUpLabourRequest(bottom_up_labour, {
        request_id,
        operation: "quotation_generate",
      }),
    });
    calculation = engineResult;
    }

    // Guard: calculation.total maps to the DB total_amount column which has a
    // CHECK > 0. Reject here (400) instead of letting convert hit a 500 later.
    // Catches all-qty-zero, all-skipped, and zero-price paths.
    if (calculation.total <= 0) {
      return respond(
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
      return respond({ error: "Lead not found" }, { status: 404 });
    }

    // 3. Save quotation to DB. The BEFORE INSERT trigger allocates quote_no
    // in this same transaction and the returned row is the source of truth.
    const { data: quote, error: quoteErr } = await supabaseAdmin
      .from("quotations")
      .insert({
        lead_id,
        quote_no: "ALLOCATED_BY_DATABASE",
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
        // The service lines have never had columns of their own; the export
        // route re-derives them from `subtotal`. Record the basis and the
        // amounts here so a bottom-up quotation can be restated exactly as it
        // was priced, without a migration. Quotations on the percentage basis
        // get no marker, which is what keeps every earlier quotation — and
        // every fallback quotation — on its original export path.
        internal_notes: manualQuote ? null : formatInstallLabourNote(calculation as CalculateResult),
        ...(manualQuote ? { payment_terms: manualQuote.payment_terms, delivery_terms: manualQuote.delivery_terms } : {}),
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
      return respond({ error: "Failed to save quotation" }, { status: 500 });
    }
    const quoteNo = quote.quote_no;

    // 5. Create activity (quote_sent)
    const { error: activityErr } = await supabaseAdmin.from("activities").insert({
      lead_id,
      type: "quote_sent",
      content: `报价已生成 #${quoteNo} (${calculation.currency} ${calculation.total.toLocaleString()})`,
      // A hand-typed (amount only) quotation is not machine generated.
      ai_generated: !manualQuote,
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

    // 7. Move the lead towards quotation_submitted.
    // A direct stage write hits the sequential-stage trigger whenever the lead is
    // earlier than the previous step (or already later / finished), so it is never
    // done here. The audited transition_lead_stage routine is used instead, one
    // step per call, through the signed-in user's own client (the same path as
    // completing the quotation milestone). Where a rule says "not yet" (first-contact
    // gate, follow-up required, role not allowed) the stage stays and the response
    // says so; the quotation itself is already saved.
    let stageAdvance: { advanced: boolean; stage: string | null; reason: string | null } = {
      advanced: false,
      stage: null,
      reason: "stage_read_failed",
    };
    try {
      const { data: current } = await supabase
        .from("leads")
        .select("stage, final_status, quality, next_action, next_followup_date")
        .eq("id", lead_id)
        .single();
      if (current) {
        let hasCompleteContact = false;
        if (current.stage === "new") {
          const { data: logs } = await supabase
            .from("follow_up_logs")
            .select("contact_time, contact_result")
            .eq("lead_id", lead_id);
          hasCompleteContact = (logs ?? []).some(isCompleteContact);
        }
        stageAdvance = await advanceStageForMilestone(supabase, {
          leadId: lead_id,
          milestoneKey: "quotation",
          lead: current,
          hasCompleteContact,
          note: `Quotation generated ${quoteNo}`,
        });
        // S39: a skip reports every funnel step passed on the way to Quoted.
        if (stageAdvance.advanced && stageAdvance.stage) {
          await enqueueMetaCrmFunnelForLead(supabaseAdmin, lead_id, current.stage, stageAdvance.stage);
        }
      }
    } catch {
      stageAdvance = { advanced: false, stage: null, reason: "stage_update_failed" };
    }
    // A quotation with an amount is the main signal back to Meta (value = the quoted total). It is sent whenever a
    // quotation is saved, whether or not the stage could move (a quote often comes before the first contact is logged),
    // but not for a lead that is already won / lost or archived. Best effort; each path dedupes per lead.
    await enqueueQuotedFeedback(supabaseAdmin, lead_id, calculation.total, {
      form: enqueueMetaCrmEventForLead, whatsapp: enqueueWhatsAppProgressWithDelivery, website: enqueueWebsiteQuoteForProgress,
    });

    if (!stageAdvance.advanced && stageAdvance.reason) {
      const log = stageAdvance.reason === "stage_update_failed" || stageAdvance.reason === "stage_read_failed" ? logger.warn : logger.info;
      log.call(
        logger,
        {
          request_id,
          operation: "quotation_generate",
          user_id: user.id,
          lead_id,
          quote_id: quote.id,
          reason: stageAdvance.reason,
        },
        "[Quotation Generate] Lead stage not advanced automatically",
      );
    }

    // Revalidate cached pages to reflect new quotation
    revalidatePath("/quotes");
    revalidatePath("/leads");

    return respond({
      status: "ok",
      quote_id: quote.id,
      quote_no: quoteNo,
      total: calculation.total,
      currency: calculation.currency,
      valid_until: calculation.valid_until,
      // Which basis priced the labour line, so the caller never has to guess
      // whether the bottom-up model actually applied.
      install_labor_basis: calculation.install_labor_basis,
      install_labor_fallback_reason: calculation.install_labor_fallback_reason,
      // Whether the lead moved forward to quotation_submitted; when it did not,
      // the reason says which rule held it back (the quotation is saved either way).
      stage_advanced: stageAdvance.advanced,
      lead_stage: stageAdvance.stage,
      stage_advance_reason: stageAdvance.reason,
    });
  } catch (err: any) {
    if (err instanceof RequestAuthError) return requestAuthErrorResponse(err);
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
