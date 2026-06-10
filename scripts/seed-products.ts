/**
 * Seed Script — Populate Products Table from Device Catalog
 * Self-contained version using Management API for keys.
 *
 * Run: npx tsx scripts/seed-products.ts
 */

async function main() {
  const PAT = "sbp_bbaf7ebe1a9a262efc5e52d3ad74341b17f1267e";
  const PROJECT_REF = "vfopmpxlhwzpxqegayew";
  const SUPABASE_URL = "https://vfopmpxlhwzpxqegayew.supabase.co";

  // Get service role key from Management API
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys`,
    { headers: { Authorization: `Bearer ${PAT}` } }
  );
  const keys = await res.json();
  const srKey = keys.find((k: any) => k.name === "service_role").api_key;

  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(SUPABASE_URL, srKey);

  // ─── Device Catalog inline (mirrors src/lib/device-catalog.ts) ───
  const DEVICE_CATALOG: {
    key: string;
    label: string;
    icon: string;
    devices: { id: string; name: string; price: number; unit?: string; note?: string }[];
  }[] = [
    {
      key: "knx_infrastructure",
      label: "KNX Infrastructure",
      icon: "🔌",
      devices: [
        { id: "knx_ip_router", name: "KNX IP Router", price: 2800, unit: "pcs" },
        { id: "knx_psu_640ma", name: "KNX Power Supply 640mA", price: 1200, unit: "pcs" },
        { id: "knx_psu_1280ma", name: "KNX Power Supply 1280mA", price: 1800, unit: "pcs" },
        { id: "line_coupler", name: "KNX Line Coupler", price: 1200, unit: "pcs" },
        { id: "area_coupler", name: "KNX Area Coupler", price: 2200, unit: "pcs" },
        { id: "knx_secure_interface", name: "KNX Secure IP Interface", price: 3500, unit: "pcs" },
        { id: "bus_cable", name: "KNX Bus Cable (per meter)", price: 8, unit: "m" },
      ],
    },
    {
      key: "lighting_control",
      label: "Lighting Control",
      icon: "💡",
      devices: [
        { id: "switch_actuator_4", name: "KNX 4-Channel Switch Actuator", price: 650, unit: "pcs" },
        { id: "switch_actuator_8", name: "KNX 8-Channel Switch Actuator", price: 950, unit: "pcs" },
        { id: "switch_actuator_12", name: "KNX 12-Channel Switch Actuator", price: 1900, unit: "pcs" },
        { id: "switch_actuator_16", name: "KNX 16-Channel Switch Actuator", price: 2400, unit: "pcs" },
        { id: "dimmer_actuator_4", name: "KNX 4-Channel Dimming Actuator", price: 1600, unit: "pcs" },
        { id: "dimmer_actuator_8", name: "KNX 8-Channel Dimming Actuator", price: 2800, unit: "pcs" },
        { id: "dali_gateway_4", name: "KNX DALI Gateway 4-fold", price: 3200, unit: "pcs" },
        { id: "dali_gateway_8", name: "KNX DALI Gateway 8-fold", price: 4800, unit: "pcs" },
        { id: "dali_led_driver", name: "DALI LED Driver DT6", price: 120, unit: "pcs" },
        { id: "dali_rgbw_driver", name: "DALI RGBW Driver DT8", price: 160, unit: "pcs" },
        { id: "dimming_driver_010v", name: "0-10V Dimming Driver", price: 80, unit: "pcs" },
      ],
    },
    {
      key: "curtain_shade",
      label: "Curtains & Shades",
      icon: "🪟",
      devices: [
        { id: "shutter_actuator_4", name: "KNX Shutter/Blind Actuator 4-Ch", price: 1500, unit: "pcs" },
        { id: "shutter_actuator_8", name: "KNX Shutter/Blind Actuator 8-Ch", price: 2400, unit: "pcs" },
        { id: "curtain_motor", name: "Curtain Motor (Somfy)", price: 2200, unit: "pcs" },
        { id: "panel_motor", name: "Panel Track Motor (Dream Curtain)", price: 2800, unit: "pcs" },
        { id: "tubular_motor", name: "Tubular Motor for Roller Blinds", price: 1200, unit: "pcs" },
        { id: "blind_motor", name: "Venetian Blind Motor", price: 1800, unit: "pcs" },
        { id: "outdoor_shade_motor", name: "Outdoor Shade Motor", price: 2800, unit: "pcs" },
      ],
    },
    {
      key: "hvac_control",
      label: "HVAC Control",
      icon: "🌡️",
      devices: [
        { id: "vrv_gateway", name: "VRV/VRF Gateway (Intesis)", price: 5500, unit: "pcs" },
        { id: "thermostat_knx", name: "KNX Thermostat / Room Controller", price: 1200, unit: "pcs" },
        { id: "valve_actuator", name: "KNX Valve Actuator", price: 200, unit: "pcs" },
        { id: "temperature_sensor", name: "KNX Temperature Sensor", price: 400, unit: "pcs" },
        { id: "fcu_controller", name: "KNX FCU Controller", price: 1800, unit: "pcs" },
      ],
    },
    {
      key: "sensors_inputs",
      label: "Sensors & Binary Inputs",
      icon: "📡",
      devices: [
        { id: "motion_sensor", name: "KNX Motion/Presence Sensor", price: 800, unit: "pcs" },
        { id: "lux_sensor", name: "KNX Luminosity Sensor", price: 600, unit: "pcs" },
        { id: "binary_input_4", name: "KNX Binary Input 4-fold", price: 400, unit: "pcs" },
        { id: "binary_input_8", name: "KNX Binary Input 8-fold", price: 650, unit: "pcs" },
        { id: "wind_sensor", name: "KNX Wind Sensor", price: 900, unit: "pcs" },
        { id: "rain_sensor", name: "KNX Rain Sensor", price: 700, unit: "pcs" },
        { id: "co2_sensor", name: "KNX CO2 Sensor", price: 850, unit: "pcs" },
      ],
    },
    {
      key: "touch_panels",
      label: "Touch Panels & Keypads",
      icon: "🎛️",
      devices: [
        { id: "touch_panel_5", name: 'KNX Touch Panel 5"', price: 3200, unit: "pcs" },
        { id: "touch_panel_7", name: 'KNX Touch Panel 7" (Gira)', price: 4800, unit: "pcs" },
        { id: "touch_panel_10", name: 'KNX Touch Panel 10"', price: 6500, unit: "pcs" },
        { id: "scene_panel", name: "KNX Scene Panel (4-scene)", price: 1500, unit: "pcs" },
        { id: "keypad_2gang", name: "KNX Keypad 2-gang", price: 600, unit: "pcs" },
        { id: "keypad_4gang", name: "KNX Keypad 4-gang", price: 1000, unit: "pcs" },
        { id: "keypad_8gang", name: "KNX Keypad 8-gang", price: 1600, unit: "pcs" },
      ],
    },
    {
      key: "multiroom_audio",
      label: "Multi-room Audio",
      icon: "🎵",
      devices: [
        { id: "sonos_amp", name: "Sonos Amp", price: 2800, unit: "pcs" },
        { id: "sonos_port", name: "Sonos Port", price: 1500, unit: "pcs" },
        { id: "bluesound_node", name: "Bluesound Node", price: 2000, unit: "pcs" },
        { id: "ceiling_speaker", name: "Ceiling Speaker (pair)", price: 800, unit: "pair" },
        { id: "outdoor_speaker", name: "Outdoor Speaker (pair)", price: 1200, unit: "pair" },
        { id: "subwoofer", name: "Subwoofer (active)", price: 2200, unit: "pcs" },
      ],
    },
    {
      key: "network_wifi",
      label: "Network & WiFi",
      icon: "🌐",
      devices: [
        { id: "wifi6_ap", name: "WiFi 6 Access Point (Ubiquiti U6-LR)", price: 1200, unit: "pcs" },
        { id: "wifi7_ap", name: "WiFi 7 Access Point (Ubiquiti U7)", price: 1800, unit: "pcs" },
        { id: "poe_switch_24", name: "PoE+ Switch 24-port (Ubiquiti)", price: 3500, unit: "pcs" },
        { id: "poe_switch_8", name: "PoE+ Switch 8-port (Ubiquiti)", price: 1200, unit: "pcs" },
        { id: "network_rack_12u", name: "Network Rack 12U", price: 2000, unit: "pcs" },
        { id: "patch_panel_24", name: "Patch Panel 24-port Cat6", price: 400, unit: "pcs" },
        { id: "ups_1500va", name: "UPS 1500VA (APC)", price: 1800, unit: "pcs" },
      ],
    },
    {
      key: "security_cctv",
      label: "Security & CCTV",
      icon: "🔒",
      devices: [
        { id: "cctv_8mp_outdoor", name: "CCTV 8MP Outdoor (Hikvision)", price: 1200, unit: "pcs" },
        { id: "cctv_4mp_indoor", name: "CCTV 4MP Indoor (Hikvision)", price: 800, unit: "pcs" },
        { id: "nvr_16ch", name: "NVR 16-channel (Hikvision)", price: 3000, unit: "pcs" },
        { id: "nvr_8ch", name: "NVR 8-channel (Hikvision)", price: 2000, unit: "pcs" },
        { id: "door_contact", name: "Door Contact Sensor", price: 200, unit: "pcs" },
        { id: "pir_detector", name: "PIR Motion Detector", price: 450, unit: "pcs" },
        { id: "smoke_detector", name: "Smoke Detector", price: 400, unit: "pcs" },
        { id: "alarm_panel", name: "Alarm Control Panel", price: 2500, unit: "pcs" },
        { id: "siren", name: "Outdoor Siren", price: 600, unit: "pcs" },
      ],
    },
    {
      key: "video_intercom",
      label: "Video Intercom",
      icon: "🏠",
      devices: [
        { id: "door_station", name: "Door Station Outdoor (2N)", price: 3500, unit: "pcs" },
        { id: "indoor_monitor_7", name: 'Indoor Monitor 7" (2N)', price: 2800, unit: "pcs" },
        { id: "indoor_monitor_10", name: 'Indoor Monitor 10" (2N)', price: 3800, unit: "pcs" },
        { id: "poe_injector", name: "PoE Injector 30W", price: 150, unit: "pcs" },
      ],
    },
    {
      key: "cables",
      label: "Cables & Wiring",
      icon: "🔌",
      devices: [
        { id: "cat6_cable", name: "CAT6 Network Cable (per meter)", price: 8, unit: "m" },
        { id: "cat6_patch", name: "CAT6 Patch Cable 1m", price: 15, unit: "pcs" },
        { id: "speaker_cable", name: "Speaker Cable 2×1.5mm (per meter)", price: 6, unit: "m" },
        { id: "hdmi_cable", name: "HDMI 2.1 Cable 5m", price: 80, unit: "pcs" },
      ],
    },
    {
      key: "services",
      label: "Services",
      icon: "⚙️",
      devices: [
        { id: "installation_service", name: "Installation & Commissioning (per day)", price: 2500, unit: "day" },
        { id: "design_service", name: "System Design & Engineering", price: 5000, unit: "project" },
        { id: "programming_service", name: "KNX Programming (per day)", price: 2000, unit: "day" },
      ],
    },
  ];

  function generateSku(catKey: string, deviceId: string): string {
    const prefixMap: Record<string, string> = {
      knx_infrastructure: "KNX",
      lighting_control: "KNX",
      curtain_shade: "SHD",
      hvac_control: "HVAC",
      sensors_inputs: "SNS",
      touch_panels: "PNL",
      multiroom_audio: "AUD",
      network_wifi: "NET",
      security_cctv: "SEC",
      video_intercom: "VDO",
      cables: "CBL",
      services: "SVC",
    };
    const prefix = prefixMap[catKey] || "GEN";
    const code = deviceId.replace(/[^a-z0-9]/gi, "_").toUpperCase().slice(0, 16);
    return `${prefix}-${code}`;
  }

  const categoryMap: Record<string, string> = {
    knx_infrastructure: "knx",
    lighting_control: "knx",
    curtain_shade: "knx",
    hvac_control: "hvac",
    sensors_inputs: "knx",
    touch_panels: "knx",
    multiroom_audio: "audio",
    network_wifi: "network",
    security_cctv: "security",
    video_intercom: "intercom",
    cables: "cable",
    services: "service",
  };

  // Build products list
  const products: any[] = [];
  for (const cat of DEVICE_CATALOG) {
    for (const device of cat.devices) {
      products.push({
        sku: generateSku(cat.key, device.id),
        name: device.name,
        description: device.note || `${device.name} — professional-grade smart home device.`,
        category: categoryMap[cat.key] || "other",
        unit: device.unit || "pcs",
        unit_price: device.price,
        is_active: true,
      });
    }
  }

  console.log(`Total products to seed: ${products.length}`);

  // Fetch existing
  const { data: existing } = await supabase.from("products").select("sku,name");
  const existingSkus = new Set(existing?.map((p: any) => p.sku) || []);
  console.log(`Existing products in DB: ${existingSkus.size}`);

  let inserted = 0;
  let skipped = 0;

  for (const product of products) {
    if (existingSkus.has(product.sku)) {
      skipped++;
      continue;
    }
    const { error } = await supabase.from("products").insert(product);
    if (error) {
      console.error(`  ✗ ${product.sku}: ${error.message}`);
    } else {
      inserted++;
    }
  }

  console.log(`\n=== Done: ${inserted} inserted, ${skipped} skipped ===`);

  // Verify
  const { count } = await supabase.from("products").select("*", { count: "exact", head: true });
  console.log(`Total products in DB now: ${count}`);

  // Show all products
  const { data: all } = await supabase.from("products").select("name,category,unit_price,sku").order("category").order("name");
  console.log("\n=== Product Catalog ===");
  let currentCat = "";
  for (const p of all || []) {
    if (p.category !== currentCat) {
      currentCat = p.category;
      console.log(`\n[${currentCat.toUpperCase()}]`);
    }
    console.log(`  ${p.sku}: ${p.name} — AED ${p.unit_price}`);
  }
}

main().catch(console.error);
