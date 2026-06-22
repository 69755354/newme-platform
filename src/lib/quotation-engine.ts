/**
 * Quotation Engine — Shared Calculation Logic
 * Uses unified device catalog from device-catalog.ts
 */

import { DEVICE_CATALOG, QUOTATION_DEFAULTS, buildDeviceLookup } from "./device-catalog";

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface CalculateInput {
  lead_id?: string;
  devices: Record<string, number>;
  discount_rate?: number;
  notes?: string;
}

export interface BreakdownItem {
  category: string;
  items: { device_id: string; name: string; qty: number; unit_price: number; line_total: number }[];
  subtotal: number;
}

export interface CalculateResult {
  subtotal: number;
  discount_rate: number;
  discount_amount: number;
  after_discount: number;
  install_labor: number;
  commissioning: number;
  project_management: number;
  subtotal_services: number;
  taxable: number;
  tax_rate: number;
  tax_amount: number;
  total: number;
  currency: string;
  breakdown: BreakdownItem[];
  valid_until: string;
  devices_json: Record<string, any>;
}

// ──────────────────────────────────────────────
// Calculation Engine
// ──────────────────────────────────────────────

export function calculateQuotation(input: CalculateInput): CalculateResult {
  const { devices, notes } = input;
  const discount_rate = Math.max(0, Math.min(100, input.discount_rate ?? 0));

  // Build flat device lookup map: id → DeviceInfo
  const deviceLookup = buildDeviceLookup();

  // Build category reverse-lookup maps from unified DEVICE_CATALOG array
  const deviceToCategory = new Map<string, string>();
  const categoryLabels = new Map<string, string>();
  for (const cat of DEVICE_CATALOG) {
    categoryLabels.set(cat.key, cat.label);
    for (const dev of cat.devices) {
      deviceToCategory.set(dev.id, cat.key);
    }
  }

  // Compute breakdown per category
  const breakdownMap: Record<string, BreakdownItem> = {};
  let subtotal = 0;

  for (const [deviceId, qty] of Object.entries(devices)) {
    if (qty <= 0) continue;
    const info = deviceLookup.get(deviceId);
    if (!info) continue; // skip unknown devices
    const categoryKey = deviceToCategory.get(deviceId);
    if (!categoryKey) continue; // guard — should never happen
    const lineTotal = info.price * qty;
    subtotal += lineTotal;

    if (!breakdownMap[categoryKey]) {
      breakdownMap[categoryKey] = {
        category: categoryLabels.get(categoryKey) ?? categoryKey,
        items: [],
        subtotal: 0,
      };
    }
    breakdownMap[categoryKey].items.push({
      device_id: deviceId,
      name: info.name,
      qty,
      unit_price: info.price,
      line_total: lineTotal,
    });
    breakdownMap[categoryKey].subtotal += lineTotal;
  }

  const effectiveDiscountRate = discount_rate / 100;
  const discountAmount = subtotal * effectiveDiscountRate;
  const afterDiscount = subtotal - discountAmount;

  // Service percentages apply to after-discount device total
  const installLaborPct = QUOTATION_DEFAULTS.install_labor_pct / 100;
  const commissioningPct = QUOTATION_DEFAULTS.commissioning_pct / 100;
  const pmPct = QUOTATION_DEFAULTS.pm_pct / 100;

  const installLabor = Math.round(afterDiscount * installLaborPct * 100) / 100;
  const commissioning = Math.round(afterDiscount * commissioningPct * 100) / 100;
  const projectManagement = Math.round(afterDiscount * pmPct * 100) / 100;
  const subtotalServices = installLabor + commissioning + projectManagement;

  const taxable = afterDiscount + subtotalServices;
  const taxRate = QUOTATION_DEFAULTS.tax_rate / 100;
  const taxAmount = Math.round(taxable * taxRate * 100) / 100;
  const total = Math.round((taxable + taxAmount) * 100) / 100;

  // Valid until date
  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + QUOTATION_DEFAULTS.validity_days);
  const validUntilStr = validUntil.toISOString().split("T")[0];

  // Build devices_json (full detail for DB storage)
  const devicesJson: Record<string, any> = {};
  for (const [deviceId, qty] of Object.entries(devices)) {
    if (qty <= 0) continue;
    const info = deviceLookup.get(deviceId);
    if (!info) continue;
    devicesJson[deviceId] = {
      name: info.name,
      qty,
      unit_price: info.price,
      line_total: info.price * qty,
      unit: info.unit,
    };
  }

  const breakdown: BreakdownItem[] = Object.values(breakdownMap);

  return {
    subtotal,
    discount_rate,
    discount_amount: discountAmount,
    after_discount: afterDiscount,
    install_labor: installLabor,
    commissioning,
    project_management: projectManagement,
    subtotal_services: subtotalServices,
    taxable,
    tax_rate: QUOTATION_DEFAULTS.tax_rate,
    tax_amount: taxAmount,
    total,
    currency: QUOTATION_DEFAULTS.currency,
    breakdown,
    valid_until: validUntilStr,
    devices_json: devicesJson,
  };
}
