// RBAC: user (authenticated)
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getAuthProfile, isAdminOrBoss } from "@/lib/lead-auth";
import {
  LeadOrganizationAccessError,
  resolveLeadOrganizationAccess,
} from "@/lib/lead-organization-access";
import { calculateQuotation } from "../../../../lib/quotation-engine";
import { DEVICE_CATALOG } from "@/lib/device-catalog";
import { logger, genReqId } from "@/lib/logger";

const VALID_DEVICE_IDS = new Set<string>(
  DEVICE_CATALOG.flatMap((category) => category.devices.map((device) => device.id)),
);

/**
 * POST /api/hermes/generate-quote
 * 使用内置计算引擎生成报价 (替代已下线的 Hermes 外部服务)
 *
 * Input:  { lead_id, devices_json? }
 * Output: { status, quote_id, total_aed, quote_url }
 *
 * 从 lead 的 devices_json 字段 (或 service_needs) 自动推导设备清单，
 * 调用 quotation-engine 计算，保存到数据库。
 */

function getSupabaseAuth(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!url || !key) throw new Error("Missing Supabase env vars");
  const client = createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  // Hydrate session from cookie
  const accessToken = req.cookies.get("sb-access-token")?.value;
  const refreshToken = req.cookies.get("sb-refresh-token")?.value;
  if (accessToken && refreshToken) {
    client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  }
  return client;
}

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

/**
 * Derive device quantities from lead data.
 * If lead has devices_json, use it directly.
 * Otherwise, infer from service_needs / property_type.
 */
function deriveDevices(lead: Record<string, any>): Record<string, number> {
  // If lead already has device quantities stored
  if (lead.devices_json && typeof lead.devices_json === "object") {
    const quantities: Record<string, number> = {};
    for (const [k, v] of Object.entries(lead.devices_json)) {
      if (typeof v === "number") {
        quantities[k] = v;
      } else if (typeof v === "object" && v !== null) {
        quantities[k] = (v as any).qty || 0;
      }
    }
    if (Object.keys(quantities).length > 0) return quantities;
  }

  // Infer from service_needs and property type
  const serviceNeeds: string[] = lead.service_needs || [];
  const propertyType = lead.property_type || "villa";
  const sizeSqm = lead.property_size_sqm || (propertyType === "apartment" ? 150 : 500);
  const roomCount = Math.max(Math.round(sizeSqm / 50), 3);

  const devices: Record<string, number> = {};

  // Infrastructure
  devices.knx_ip_router = 1;
  devices.knx_psu_640ma = 1;
  devices.bus_cable = Math.round(sizeSqm * 1.5);

  // Lighting
  devices.dali_gateway_4 = Math.max(Math.ceil(roomCount / 4), 1);
  devices.dali_led_driver = Math.round(roomCount * 3);
  devices.switch_actuator_12 = Math.max(Math.ceil(roomCount / 3), 1);
  devices.motion_sensor = Math.round(roomCount * 0.5);

  if (serviceNeeds.some((s) => s.toLowerCase().includes("curtain") || s.toLowerCase().includes("shade"))) {
    devices.curtain_motor = Math.round(roomCount * 1.5);
    devices.shutter_actuator_4 = Math.max(Math.ceil(roomCount / 4), 1);
  }

  if (serviceNeeds.some((s) => s.toLowerCase().includes("hvac") || s.toLowerCase().includes("ac") || s.toLowerCase().includes("climate"))) {
    devices.vrv_gateway = 1;
    devices.thermostat_knx = roomCount;
  }

  if (serviceNeeds.some((s) => s.toLowerCase().includes("cctv") || s.toLowerCase().includes("security") || s.toLowerCase().includes("alarm"))) {
    devices.cctv_8mp_outdoor = Math.round(roomCount * 0.3);
    devices.cctv_4mp_indoor = Math.round(roomCount * 0.7);
    devices.nvr_16ch = 1;
    devices.door_contact = roomCount;
    devices.pir_detector = Math.round(roomCount * 0.5);
  }

  // Touch panels
  devices.touch_panel_7 = Math.max(Math.ceil(roomCount / 3), 1);

  // Keypads per room
  devices.keypad_4gang = roomCount;

  return devices;
}

export async function POST(request: NextRequest) {
  const request_id = genReqId();
  try {
    const bearerToken = request.headers.get("authorization")?.replace("Bearer ", "") ?? undefined;
    const cookieHeader = request.headers.get("cookie") ?? "";
    const profile = await getAuthProfile(bearerToken, cookieHeader);
    if (!profile) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { lead_id, devices_json } = await request.json();
    if (!lead_id) {
      return NextResponse.json({ error: "lead_id required" }, { status: 400 });
    }
    if (
      devices_json !== undefined
      && (
        devices_json === null
        || typeof devices_json !== "object"
        || Array.isArray(devices_json)
      )
    ) {
      return NextResponse.json({ error: "devices_json must be an object" }, { status: 400 });
    }

    let organizationAccess;
    try {
      organizationAccess = await resolveLeadOrganizationAccess(
        request,
        "lead:write",
        "lead",
        lead_id,
      );
    } catch (error) {
      if (error instanceof LeadOrganizationAccessError) {
        return NextResponse.json({ error: error.code }, { status: error.status });
      }
      throw error;
    }

    const supabaseAdmin = getSupabaseAdmin();

    // 1. Fetch lead data
    const { data: lead, error: leadErr } = await (supabaseAdmin as any)
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .eq("organization_id", organizationAccess.organizationId)
      .single();

    if (leadErr && leadErr.code !== "PGRST116") {
      logger.error(
        {
          err: leadErr,
          request_id,
          operation: "quotation_generate",
          user_id: profile.userId,
          lead_id,
        },
        "[Hermes API] Failed to fetch lead",
      );
      return NextResponse.json({ error: "Failed to fetch lead data" }, { status: 500 });
    }
    if (!lead) {
      return NextResponse.json({ error: "lead not found" }, { status: 404 });
    }
    if (!isAdminOrBoss(profile) && lead.assigned_to !== profile.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 2. Derive device quantities from lead data
    const devices = deriveDevices({
      ...lead,
      ...(devices_json === undefined ? {} : { devices_json }),
    });

    // Reject invalid stored device keys instead of letting the calculation
    // engine silently ignore them and persist a zero-total quotation.
    const unknownDevices = Object.keys(devices).filter((id) => !VALID_DEVICE_IDS.has(id));
    if (unknownDevices.length > 0) {
      return NextResponse.json(
        { error: "Unknown device_ids", unknown_devices: unknownDevices },
        { status: 400 },
      );
    }

    // 3. Calculate quotation using internal engine
    const calculation = calculateQuotation({
      lead_id,
      devices,
      discount_rate: 0,
    });

    if (calculation.total <= 0) {
      return NextResponse.json(
        { error: "Quotation total must be greater than zero" },
        { status: 400 },
      );
    }

    // 4. Generate quote number
    const quoteNo = await generateQuoteNo(supabaseAdmin);

    // 5. Save quotation to DB (quotations table)
    const { data: quote, error: quoteErr } = await (supabaseAdmin as any)
      .from("quotations")
      .insert({
        lead_id,
        quote_no: quoteNo,
        version: 1,
        created_by: profile.userId,
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
      })
      .select("id, quote_no")
      .single();

    if (quoteErr) {
      logger.error(
        {
          err: quoteErr,
          request_id,
          operation: "quotation_generate",
          user_id: profile.userId,
          lead_id,
        },
        "[Hermes API] Failed to insert quotation",
      );
      return NextResponse.json({ error: "Failed to save quotation" }, { status: 500 });
    }

    // 6. Record activity
    const { error: activityErr } = await (supabaseAdmin as any).from("activities").insert({
      lead_id,
      type: "quote_sent",
      content: `报价已生成 #${quoteNo} (AED ${calculation.total.toLocaleString()})`,
      ai_generated: true,
      user_id: profile.userId,
    });
    if (activityErr) {
      logger.error(
        {
          err: activityErr,
          request_id,
          operation: "quotation_generate",
          user_id: profile.userId,
          lead_id,
          quote_id: quote.id,
        },
        "[Hermes API] Failed to insert activity",
      );
    }

    // 7. Record business event
    const { error: eventErr } = await (supabaseAdmin as any).from("business_events").insert({
      lead_id,
      event_type: "quotation_sent",
      description: `报价 ${quoteNo} 已生成，金额 AED ${calculation.total.toLocaleString()}`,
      event_data: {
        quote_id: quote.id,
        quote_no: quoteNo,
        total: calculation.total,
        currency: calculation.currency,
      },
      user_id: profile.userId,
    });
    if (eventErr) {
      logger.error(
        {
          err: eventErr,
          request_id,
          operation: "quotation_generate",
          user_id: profile.userId,
          lead_id,
          quote_id: quote.id,
        },
        "[Hermes API] Failed to insert business event",
      );
    }

    // 8. Update lead stage to 'quotation_submitted'
    const { error: updateErr } = await (supabaseAdmin as any)
      .from("leads")
      .update({ stage: "quotation_submitted", updated_at: new Date().toISOString() })
      .eq("id", lead_id);
    if (updateErr) {
      logger.error(
        {
          err: updateErr,
          request_id,
          operation: "quotation_generate",
          user_id: profile.userId,
          lead_id,
          quote_id: quote.id,
        },
        "[Hermes API] Failed to update lead stage",
      );
    }

    return NextResponse.json({
      status: "ok",
      quote_id: quote.id,
      quote_no: quoteNo,
      total_aed: calculation.total,
      currency: calculation.currency,
      quote_url: null,
      ppt_url: null,
    });
  } catch (err: any) {
    logger.error(
      {
        err,
        request_id,
        operation: "quotation_generate",
      },
      "[Hermes API] Quote generation failed",
    );
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
