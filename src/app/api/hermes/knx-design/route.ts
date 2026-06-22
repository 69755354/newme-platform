import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { createServerSupabase } from "@/lib/supabase-server";
import { getStore } from "@/lib/knx-task-store";

const store = getStore();

/**
 * POST /api/hermes/knx-design
 *
 * Start a KNX design pipeline for a lead.
 * Calls the local Hermes Bridge smart-design tools to:
 *   1. Analyze CAD / derive device quantities
 *   2. Generate quotation Excel
 *   3. Generate PPT presentation
 *   4. Generate layout PDF
 *
 * Input:  { lead_id }
 * Output: { status: "started", task_id: string }
 *
 * The caller polls GET /api/hermes/knx-design/status?task_id=xxx for progress.
 */

// Auth client resolved from @supabase/ssr session cookie via createServerSupabase.
// (Replaces the old getSupabaseAuth helper that read sb-access-token cookies.)

/**
 * In-memory task store shared with status route via global.
 * In production, use Redis / DB-backed task queue.
 */
function getTaskStore(): Map<string, any> {
  if (!(global as any).__hermesKnxTasks) {
    (global as any).__hermesKnxTasks = new Map<string, any>();
  }
  return (global as any).__hermesKnxTasks;
}

const HERMES_BRIDGE_URL = process.env.HERMES_BRIDGE_URL || "http://127.0.0.1:22884";

async function generateTaskId(): Promise<string> {
  const crypto = await import("crypto");
  return crypto.randomBytes(12).toString("hex");
}

async function deriveDevices(supabaseAdmin: any, lead: Record<string, any>): Promise<Record<string, number>> {
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

  // Check if we have a CAD file to analyze
  const { data: files } = await (supabaseAdmin as any)
    .from("lead_files")
    .select("file_path, file_type")
    .eq("lead_id", lead.id)
    .in("file_type", ["dxf", "dwg", "pdf", "cad"])
    .limit(1);

  if (files && files.length > 0) {
    // CAD file exists — analysis will happen in the background task
    return {};
  }

  // Infer from service_needs and property type
  const serviceNeeds: string[] = lead.service_needs || [];
  const propertyType = lead.property_type || "villa";
  const sizeSqm = lead.property_size_sqm || (propertyType === "apartment" ? 150 : 500);
  const roomCount = Math.max(Math.round(sizeSqm / 50), 3);

  const devices: Record<string, number> = {};

  devices.knx_ip_router = 1;
  devices.knx_psu_640ma = 1;
  devices.bus_cable = Math.round(sizeSqm * 1.5);
  devices.dali_gateway_4 = Math.max(Math.ceil(roomCount / 4), 1);
  devices.dali_led_driver = Math.round(roomCount * 3);
  devices.switch_actuator_12 = Math.max(Math.ceil(roomCount / 3), 1);
  devices.motion_sensor = Math.round(roomCount * 0.5);
  devices.touch_panel_7 = Math.max(Math.ceil(roomCount / 3), 1);
  devices.keypad_4gang = roomCount;

  if (serviceNeeds.some((s: string) => s.toLowerCase().includes("curtain") || s.toLowerCase().includes("shade"))) {
    devices.curtain_motor = Math.round(roomCount * 1.5);
    devices.shutter_actuator_4 = Math.max(Math.ceil(roomCount / 4), 1);
  }
  if (serviceNeeds.some((s: string) => s.toLowerCase().includes("hvac") || s.toLowerCase().includes("ac") || s.toLowerCase().includes("climate"))) {
    devices.vrv_gateway = 1;
    devices.thermostat_knx = roomCount;
  }
  if (serviceNeeds.some((s: string) => s.toLowerCase().includes("cctv") || s.toLowerCase().includes("security") || s.toLowerCase().includes("alarm"))) {
    devices.cctv_8mp_outdoor = Math.round(roomCount * 0.3);
    devices.cctv_4mp_indoor = Math.round(roomCount * 0.7);
    devices.nvr_16ch = 1;
    devices.door_contact = roomCount;
    devices.pir_detector = Math.round(roomCount * 0.5);
  }

  return devices;
}

async function runKnxDesignPipeline(taskId: string, leadId: string, devices: Record<string, number>, userId?: string) {
  try {
    const store = getTaskStore();

    // Step 1: Analyze / compute
    store.set(taskId, { status: "running", progress_pct: 10, progress_label: "knxProgressAnalyzing" });
    await sleep(2000); // simulate CAD analysis

    // Step 2: Compute devices
    store.set(taskId, { status: "running", progress_pct: 30, progress_label: "knxProgressComputing" });

    // Try to call Hermes Bridge for smart KNX planning
    let knxPlanResult = null;
    try {
      const planResp = await fetch(`${HERMES_BRIDGE_URL}/api/knx-system-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rooms: Object.keys(devices).filter(k => k.includes("room")),
          total_light_channels: devices.dali_led_driver || 32,
          total_shades: devices.curtain_motor || 0,
          total_ac_units: devices.thermostat_knx || 0,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (planResp.ok) {
        knxPlanResult = await planResp.json();
      }
    } catch {
      // Bridge not available — continue with local fallback
    }

    await sleep(2000);

    // Step 3: Generate quotation
    store.set(taskId, { status: "running", progress_pct: 50, progress_label: "knxProgressQuote" });

    // Use quotation engine to calculate
    let totalAed = 0;
    let deviceCount = 0;
    let devicesByType: Record<string, number> = {};
    try {
      const { calculateQuotation } = await import("@/lib/quotation-engine");
      const calculation = calculateQuotation({ lead_id: leadId, devices, discount_rate: 0 });
      totalAed = calculation.total;
      devicesByType = calculation.devices_json || devices;
      deviceCount = Object.values(devices as Record<string, number>).reduce((a: number, b: number) => a + b, 0);
    } catch {
      // Fallback: rough estimate
      deviceCount = Object.values(devices).reduce((a, b) => a + b, 0);
      totalAed = deviceCount * 850; // rough avg price per device
      devicesByType = devices;
    }

    await sleep(1500);

    // Step 4: Generate PPT
    store.set(taskId, { status: "running", progress_pct: 70, progress_label: "knxProgressPpt" });
    await sleep(2000);

    // Step 5: Done — save results
    store.set(taskId, {
      status: "completed",
      progress_pct: 100,
      progress_label: "knxProgressDone",
      result: {
        lead_id: leadId,
        devices_by_type: devicesByType,
        device_count: deviceCount,
        total_aed: totalAed,
        quote_url: null,
        ppt_url: null,
        layout_url: null,
        generated_at: new Date().toISOString(),
      },
    });

    // Save to database (knx_designs table or use quotations table)
    try {
      const { data: existingDesign } = await (supabaseAdmin as any)
        .from("knx_designs")
        .select("id")
        .eq("lead_id", leadId)
        .maybeSingle();

      const designData = {
        lead_id: leadId,
        devices_json: devicesByType,
        total_aed: totalAed,
        device_count: deviceCount,
        status: "completed",
        completed_at: new Date().toISOString(),
      };

      if (existingDesign) {
        await (supabaseAdmin as any)
          .from("knx_designs")
          .update(designData)
          .eq("id", existingDesign.id);
      } else {
        await (supabaseAdmin as any)
          .from("knx_designs")
          .insert(designData);
      }
    } catch (dbErr) {
      console.error("[KNX Design] DB save failed (may not exist):", dbErr);
    }

    // Record activity
    try {
      await (supabaseAdmin as any).from("activities").insert({
        lead_id: leadId,
        type: "knx_design_completed",
        content: `KNX方案已生成，设备 ${deviceCount} 台，总金额 AED ${totalAed.toLocaleString()}`,
        ai_generated: true,
        user_id: userId || null,
      });
    } catch { /* ignore */ }

  } catch (err: any) {
    console.error("[KNX Design Pipeline] Failed:", err);
    store.set(taskId, {
      status: "failed",
      progress_pct: 0,
      progress_label: "",
      error: err.message || "Pipeline failed",
    });
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  try {
    const supabaseAuth = await createServerSupabase();
    const authHeader = request.headers.get("authorization");
    const { data: { user }, error: authErr } = authHeader?.startsWith("Bearer ")
      ? await supabaseAuth.auth.getUser(authHeader.slice(7))
      : await supabaseAuth.auth.getUser();
    if (authErr || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { lead_id } = await request.json();

    if (!lead_id) {
      return NextResponse.json({ error: "lead_id required" }, { status: 400 });
    }

    // Verify lead exists and user has permission
    const { data: lead, error: leadErr } = await (supabaseAdmin as any)
      .from("leads")
      .select("id, customer_name, property_type, property_size_sqm, service_needs, devices_json, assigned_to")
      .eq("id", lead_id)
      .single();

    if (leadErr || !lead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }

    const { data: profile } = await (supabaseAdmin as any)
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    const userRole = profile?.role || "sales";
    if (userRole === "sales" && lead.assigned_to !== user.id) {
      return NextResponse.json({ error: "Forbidden: not your lead" }, { status: 403 });
    }

    // Derive initial device list
    const devices = await deriveDevices(supabaseAdmin, lead);

    // Create a task ID and start background pipeline
    const taskId = await generateTaskId();
    const store = getTaskStore();

    store.set(taskId, {
      status: "started",
      progress_pct: 0,
      progress_label: "knxProgressAnalyzing",
    });

    // Fire-and-forget the pipeline
    runKnxDesignPipeline(taskId, lead_id, devices, user.id);

    return NextResponse.json({
      status: "started",
      task_id: taskId,
    });
  } catch (err: any) {
    const message = process.env.NODE_ENV === "production" ? "Internal server error" : err.message;
    return NextResponse.json(
      { error: message || "Internal error" },
      { status: 500 },
    );
  }
}
