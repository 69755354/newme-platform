import type { CableCostingConfig, CableCostingInput, CableCostingResult, Tier } from "./cable-costing";

export type InstallLabourBasis = "product_pct" | "bottom_up_cable";

/**
 * What the quotation knows about a bottom-up labour request. Every field is
 * re-validated at runtime because it normally arrives from an untyped JSON body;
 * anything unusable makes the resolver fall back to the percentage basis.
 */
export interface BottomUpLabourRequest {
  /**
   * The rate card, already loaded and validated by the caller (server-side
   * only). `null` means this deployment has no `CABLE_COSTING_CONFIG`, which is
   * a fallback reason and never a reason to quote zero labour.
   */
  config: CableCostingConfig | null;
  /**
   * The cable-costing engine entry point. Injected by
   * `./quotation-labour-request.ts` (server-only) rather than imported by the
   * quotation engine, which also runs in the browser: this keeps the model out
   * of the client bundle and makes the bottom-up basis unreachable from there.
   */
  calculate?: ((input: CableCostingInput, config: CableCostingConfig) => CableCostingResult) | null;
  area_sqm?: number;
  floors?: number;
  /** cabling point id -> count, keyed on the cable-costing catalogue. */
  point_quantities?: Record<string, number>;
  /** Defaults to "client": a quotation sells labour at the client tariff. */
  tier?: Tier;
}

export interface InstallLabourDetail {
  model_version: string;
  tier: string;
  area_sqm: number;
  floors: number;
  point_count: number;
  total_metres: number;
  crew_days: number;
  labour_subtotal: number;
  material_total: number;
  /** Bilingual engine warnings; they gate whether a figure may go to a customer. */
  warnings: string[];
}

export interface InstallLabourResolution {
  install_labor: number;
  install_labor_basis: InstallLabourBasis;
  /** The percentage actually applied, or null on the bottom-up basis. */
  install_labor_pct: number | null;
  /** A code from INSTALL_LABOR_FALLBACK_REASONS, or null on the bottom-up basis. */
  install_labor_fallback_reason: string | null;
  /** Cable material incl. markup, ex-VAT. Always 0 on the percentage basis. */
  cable_material: number;
  install_labor_detail: InstallLabourDetail | null;
}

export interface ResolveInstallLabourArgs {
  afterDiscount: number;
  installLaborPct: number;
  request?: BottomUpLabourRequest | null;
}

export interface InstallLabourNoteSource {
  install_labor_basis: InstallLabourBasis;
  install_labor: number;
  cable_material: number;
  commissioning: number;
  project_management: number;
  install_labor_detail?: InstallLabourDetail | null;
}

export interface InstallLabourNote {
  install_labor_basis: "bottom_up_cable";
  install_labor: number;
  cable_material: number;
  commissioning: number | null;
  project_management: number | null;
  model_version: string | null;
}

export const INSTALL_LABOR_BASIS_PRODUCT_PCT: "product_pct";
export const INSTALL_LABOR_BASIS_BOTTOM_UP: "bottom_up_cable";
export const DEFAULT_BOTTOM_UP_TIER: Tier;
export const INSTALL_LABOR_FALLBACK_REASONS: {
  NOT_REQUESTED: string;
  CONFIG_UNAVAILABLE: string;
  GEOMETRY_MISSING: string;
  POINT_QUANTITIES_MISSING: string;
  ENGINE_REJECTED_INPUT: string;
  NON_POSITIVE_LABOUR: string;
};

export function resolveInstallLabour(args: ResolveInstallLabourArgs): InstallLabourResolution;
export function formatInstallLabourNote(source: InstallLabourNoteSource | null | undefined): string | null;
export function appendInstallLabourNote(
  existing: string | null | undefined,
  note: string | null | undefined,
): string | null;
export function parseInstallLabourNote(text: string | null | undefined): InstallLabourNote | null;
