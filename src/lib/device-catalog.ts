/**
 * Unified Device Catalog — Single Source of Truth
 * 
 * 价格来源: ~/.hermes/knowledge/03-device-library/*.md
 * 货币: AED, 基准: 2026迪拜市场价
 * 
 * 同时导出两种格式:
 *   - DEVICE_CATALOG (嵌套对象) → quotation-engine.ts
 *   - DEVICE_CATALOG_ARRAY (扁平数组) → UI 组件
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface DeviceInfo {
  id: string;
  name: string;
  price: number;
  unit?: string;
  note?: string;
  source?: string; // KB reference
}

export interface CategoryInfo {
  key: string;
  label: string;
  icon: string;
  devices: DeviceInfo[];
}

// ──────────────────────────────────────────────
// Full Catalog — 10 Categories, 47+ Devices
// ──────────────────────────────────────────────

export const DEVICE_CATALOG: CategoryInfo[] = [
  // ════════════════════════════════════════════
  // 🔌 KNX基础设施
  // ════════════════════════════════════════════
  {
    key: "knx_infrastructure",
    label: "KNX基础设施",
    icon: "🔌",
    devices: [
      { id: "knx_ip_router", name: "KNX IP Router", price: 2800, unit: "pcs", source: "index.md L45" },
      { id: "knx_psu_640ma", name: "KNX PSU 640mA", price: 1200, unit: "pcs", source: "index.md L46" },
      { id: "line_coupler", name: "Line Coupler", price: 1200, unit: "pcs", source: "index.md L47" },
      { id: "bus_cable", name: "Bus Cable (per meter)", price: 8, unit: "m", source: "index.md L48" },
    ],
  },

  // ════════════════════════════════════════════
  // 💡 照明控制
  // ════════════════════════════════════════════
  {
    key: "lighting_control",
    label: "照明控制",
    icon: "💡",
    devices: [
      { id: "switch_actuator_12", name: "Switch Actuator 12-fold", price: 1900, unit: "pcs", source: "lighting-control.md L19" },
      { id: "switch_actuator_6", name: "Switch Actuator 6-fold", price: 1000, unit: "pcs", source: "lighting-control.md L31" },
      { id: "dali_gateway_4", name: "DALI Gateway 4-fold", price: 3200, unit: "pcs", source: "lighting-control.md L43" },
      { id: "dali_led_driver", name: "DALI LED Driver DT6", price: 120, unit: "pcs", source: "lighting-control.md L57" },
      { id: "dali_rgbw_driver", name: "DALI RGBW Driver DT8", price: 160, unit: "pcs", source: "lighting-control.md L66" },
      { id: "dimmer_actuator_4", name: "Dimmer Actuator 4-fold", price: 1600, unit: "pcs", source: "lighting-control.md L75" },
      { id: "dimming_driver_010v", name: "0-10V Dimming Driver", price: 80, unit: "pcs", source: "lighting-control.md L75" },
      { id: "motion_sensor", name: "KNX Motion Sensor", price: 800, unit: "pcs", source: "index.md reference" },
      { id: "lux_sensor", name: "KNX Lux Sensor", price: 600, unit: "pcs", source: "index.md reference" },
    ],
  },

  // ════════════════════════════════════════════
  // 🪟 窗帘/遮阳
  // ════════════════════════════════════════════
  {
    key: "curtain_shade",
    label: "窗帘/遮阳",
    icon: "🪟",
    devices: [
      { id: "shutter_actuator_4", name: "Shutter Actuator 4-fold", price: 1500, unit: "pcs", source: "curtain-shade.md L20" },
      { id: "curtain_motor", name: "Curtain Motor (Somfy)", price: 2200, unit: "pcs", source: "curtain-shade.md L38" },
      { id: "curtain_track", name: "Curtain Track (per meter)", price: 200, unit: "m", source: "curtain-shade.md reference" },
      { id: "panel_motor", name: "梦幻帘电机 (Panel Motor)", price: 2800, unit: "pcs", source: "curtain-shade.md L52" },
      { id: "tubular_motor", name: "管状电机 (Tubular Motor)", price: 1200, unit: "pcs", source: "curtain-shade.md L63" },
      { id: "blind_motor", name: "Blind Motor", price: 1800, unit: "pcs", source: "curtain-shade.md reference" },
      { id: "outdoor_shade_motor", name: "户外遮阳电机 (Outdoor Shade)", price: 2800, unit: "pcs", source: "curtain-shade.md L73" },
    ],
  },

  // ════════════════════════════════════════════
  // 🌡️ 暖通控制
  // ════════════════════════════════════════════
  {
    key: "hvac_control",
    label: "暖通控制",
    icon: "🌡️",
    devices: [
      { id: "vrv_gateway", name: "VRV Gateway (Intesis)", price: 5500, unit: "pcs", source: "hvac-control.md L21" },
      { id: "thermostat_knx", name: "KNX Thermostat", price: 1200, unit: "pcs", source: "hvac-control.md L38" },
      { id: "valve_actuator", name: "Valve Actuator", price: 200, unit: "pcs", source: "hvac-control.md L61" },
      { id: "temperature_sensor", name: "KNX Temperature Sensor", price: 400, unit: "pcs", source: "hvac-control.md reference" },
    ],
  },

  // ════════════════════════════════════════════
  // 🔒 安防/CCTV
  // ════════════════════════════════════════════
  {
    key: "security_cctv",
    label: "安防/CCTV",
    icon: "🔒",
    devices: [
      { id: "cctv_8mp_outdoor", name: "CCTV 8MP Outdoor", price: 1200, unit: "pcs", source: "index.md L54" },
      { id: "cctv_4mp_indoor", name: "CCTV 4MP Indoor", price: 800, unit: "pcs", source: "security-cctv.md reference" },
      { id: "nvr_16ch", name: "NVR 16CH", price: 3000, unit: "pcs", source: "index.md L55" },
      { id: "nvr_8ch", name: "NVR 8CH", price: 2000, unit: "pcs", source: "security-cctv.md, industry standard" },
      { id: "door_contact", name: "Door Contact Sensor", price: 200, unit: "pcs", source: "security-cctv.md L68" },
      { id: "pir_detector", name: "PIR Motion Detector", price: 450, unit: "pcs", source: "security-cctv.md reference" },
      { id: "smoke_detector", name: "烟感探测器 (Smoke Detector)", price: 400, unit: "pcs", source: "security-cctv.md L80" },
      { id: "alarm_panel", name: "Alarm Control Panel", price: 2500, unit: "pcs", source: "security-cctv.md reference" },
      { id: "siren", name: "Outdoor Siren", price: 600, unit: "pcs", source: "security-cctv.md reference" },
    ],
  },

  // ════════════════════════════════════════════
  // 🎛️ 触摸面板与按键
  // ════════════════════════════════════════════
  {
    key: "touch_panels",
    label: "触摸面板与按键",
    icon: "🎛️",
    devices: [
      { id: "touch_panel_7", name: 'Touch Panel 7" (Gira)', price: 4800, unit: "pcs", source: "index.md L56" },
      { id: "touch_panel_10", name: 'Touch Panel 10" (Gira)', price: 6500, unit: "pcs", source: "index.md reference" },
      { id: "scene_panel", name: "场景面板 (Scene Panel)", price: 1500, unit: "pcs", source: "touch-panels-keypads.md L60" },
      { id: "keypad_4gang", name: "Keypad 4-gang", price: 1000, unit: "pcs", source: "index.md L57" },
      { id: "keypad_8gang", name: "Keypad 8-gang", price: 1600, unit: "pcs", source: "index.md reference" },
    ],
  },

  // ════════════════════════════════════════════
  // 🎵 多房间音频 — 知识库待建
  // ════════════════════════════════════════════
  {
    key: "multiroom_audio",
    label: "多房间音频",
    icon: "🎵",
    devices: [
      { id: "sonos_amp", name: "Sonos Amp", price: 2800, unit: "pcs", note: "industry est., pending KB" },
      { id: "sonos_port", name: "Sonos Port", price: 1500, unit: "pcs", note: "industry est., pending KB" },
      { id: "bluesound_node", name: "Bluesound Node", price: 2000, unit: "pcs", note: "industry est., pending KB" },
      { id: "ceiling_speaker", name: "Ceiling Speaker (pair)", price: 800, unit: "pair", note: "industry est., pending KB" },
      { id: "outdoor_speaker", name: "Outdoor Speaker (pair)", price: 1200, unit: "pair", note: "industry est., pending KB" },
    ],
  },

  // ════════════════════════════════════════════
  // 🌐 网络/WiFi — 知识库待建
  // ════════════════════════════════════════════
  {
    key: "network_wifi",
    label: "网络/WiFi",
    icon: "🌐",
    devices: [
      { id: "wifi6_ap", name: "WiFi 6 Access Point", price: 1200, unit: "pcs", note: "Ubiquiti U6-LR, industry est." },
      { id: "poe_switch_24", name: "PoE Switch 24-port", price: 3500, unit: "pcs", note: "Ubiquiti USW-24-POE, industry est." },
      { id: "poe_switch_8", name: "PoE Switch 8-port", price: 1200, unit: "pcs", note: "Ubiquiti USW-Lite-8-POE, industry est." },
      { id: "network_rack_12u", name: "Network Rack 12U", price: 2000, unit: "pcs", note: "industry est., pending KB" },
      { id: "patch_panel_24", name: "Patch Panel 24-port", price: 400, unit: "pcs", note: "industry est., pending KB" },
    ],
  },

  // ════════════════════════════════════════════
  // 🏠 可视对讲 — 知识库待建
  // ════════════════════════════════════════════
  {
    key: "video_intercom",
    label: "可视对讲",
    icon: "🏠",
    devices: [
      { id: "door_station", name: "Door Station (Outdoor)", price: 3500, unit: "pcs", note: "2N/Hikvision, industry est." },
      { id: "indoor_monitor_7", name: 'Indoor Monitor 7"', price: 2800, unit: "pcs", note: "2N/Hikvision, industry est." },
      { id: "indoor_monitor_10", name: 'Indoor Monitor 10"', price: 3800, unit: "pcs", note: "2N/Hikvision, industry est." },
      { id: "poe_injector", name: "PoE Injector", price: 150, unit: "pcs", note: "industry est., pending KB" },
    ],
  },

  // ════════════════════════════════════════════
  // 🚗 停车/道闸 — 知识库待建
  // ════════════════════════════════════════════
  {
    key: "parking_gate",
    label: "停车/道闸",
    icon: "🚗",
    devices: [
      { id: "vehicle_recognition", name: "车牌识别摄像机 (Vehicle Recognition)", price: 4500, unit: "pcs", note: "Hikvision, industry est." },
      { id: "barrier_gate", name: "道闸 (Barrier Gate)", price: 6500, unit: "pcs", note: "industry est., pending KB" },
      { id: "induction_loop", name: "地感线圈 (Induction Loop)", price: 800, unit: "pcs", note: "industry est., pending KB" },
    ],
  },
];

// ──────────────────────────────────────────────
// Default parameters
// ──────────────────────────────────────────────

export const QUOTATION_DEFAULTS = {
  currency: "AED",
  discount_rate: 0,
  tax_rate: 5,
  install_labor_pct: 30,
  commissioning_pct: 12,
  pm_pct: 8,
  validity_days: 30,
} as const;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

/** Build flat device lookup map: id → DeviceInfo */
export function buildDeviceLookup(): Map<string, DeviceInfo> {
  const map = new Map<string, DeviceInfo>();
  for (const cat of DEVICE_CATALOG) {
    for (const device of cat.devices) {
      map.set(device.id, device);
    }
  }
  return map;
}

/** Get device by id */
export function findDevice(id: string): DeviceInfo | undefined {
  for (const cat of DEVICE_CATALOG) {
    const found = cat.devices.find(d => d.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Total device count */
export const TOTAL_DEVICES = DEVICE_CATALOG.reduce((sum, c) => sum + c.devices.length, 0);
