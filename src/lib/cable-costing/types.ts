/**
 * Cable & pulling-labour costing — type contracts.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC REPOSITORY — NO BUSINESS NUMBERS IN THIS DIRECTORY.
 * Every price, rate, coefficient and per-point tariff lives in a
 * `CableCostingConfig` object injected at call time (production: from
 * `process.env.CABLE_COSTING_CONFIG`, see `./config.ts`; tests: synthetic
 * fixtures). This directory contains arithmetic only.
 * ---------------------------------------------------------------------------
 *
 * CONFIG <-> SPEC MAP (spec = the machine-readable cost model spec
 * `model_spec.json`, which mirrors the Excel master
 * `NewMe_Cable_Costing_TEMPLATE.xlsx`). Excel cells are quoted so a config
 * generator can be written straight off the spec.
 *
 *   CableCostingConfig.modelVersion    <- spec `_meta.model_version`
 *   CableCostingConfig.currency        <- spec `_meta.currency` ("AED")
 *   CableCostingConfig.asOfDate        <- optional valuation date used for
 *                                        supplier-quote expiry warnings (spec
 *                                        `materials.quote_documents.*.valid_until`).
 *                                        Omit in production to use "now"; set it
 *                                        to make warnings deterministic.
 *
 *   CableCostingConfig.points[]        <- spec `points.list[]` (sheet `Points`, rows 4:20)
 *     .id                             <- stable slug for the row (spec has `sn`/`row`;
 *                                        the UI and `CableCostingInput.quantities` key on `id`)
 *     .nameCn / .nameEn               <- spec `name_cn` / `name_en`            (Points!D)
 *     .system                         <- spec `system`                        (Points!B)
 *     .cableId                        <- spec `cable`, resolved against `cables[].id` (Points!C)
 *     .cablesPerPoint                 <- spec `cables_per_point`              (Points!F)
 *     .topology                       <- spec `topology`                     (Points!G)
 *     .terminateMinutes               <- spec `terminate_min`                 (Points!H)
 *     .clientRatePerPoint             <- spec `client_rate_aed_per_point`     (Points!J)
 *     .agreedSubcontractRatePerPoint  <- Points!I paid subcontract rate per point
 *                                        (optional; only used when labour.basis =
 *                                        "agreed_subcontract")
 *     .enabled                        <- Points!K Include Y/N (default true; false rows are
 *                                        hidden from the catalogue and never priced)
 *
 *   CableCostingConfig.cables[]        <- spec `materials.cables[]` (sheet `Cable Prices`, rows 4:13)
 *     .id                             <- spec `name` (the value Points!C matches on)
 *     .nameCn / .nameEn               <- display names (spec carries one trade name;
 *                                        the generator supplies both)
 *     .spec                           <- spec `spec` (free text, optional)
 *     .ratePerMetre                   <- spec `rate`       (Cable Prices!C, AED/m)
 *     .rollMetres                     <- spec `roll_m`     (Cable Prices!D)
 *     .rollPrice                      <- spec `roll_price` (Cable Prices!E, AED/roll)
 *     .grade                          <- spec `grade` ("supplier_quote" | "back_solved" | "estimate")
 *     .quoteRef                       <- spec `source` / quote document id (optional)
 *     .quoteValidUntil                <- spec `materials.quote_documents.*.valid_until`
 *                                        (ISO date, optional)
 *
 *   CableCostingConfig.lengthModel     <- spec `cable_length_model`
 *     .horizontalRoutingFactor        <- r_h          Inputs!B15
 *     .verticalRoutingFactor          <- r_v          Inputs!B16
 *     .floorHeightM                   <- H_floor      Inputs!B10
 *     .mdbFloor                       <- F_mdb        Inputs!B11
 *     .tailStarM                      <- tail_star    Inputs!B17
 *     .tailRadialM                    <- tail_radial  Inputs!B18
 *     .dropBusM                       <- drop_bus     Inputs!B19
 *     .tailBusM                       <- tail_bus     Inputs!B20
 *     .kStar / .kRadial / .kBus       <- Inputs!B21 / B22 / B23 (calibration factors)
 *     .starPlanFactor                 <- the 0.5 hardcoded inside Material!I for STAR
 *     .radialPlanFactor               <- the 0.5 hardcoded inside Material!I for RADIAL
 *     .busSpacingFactor               <- the 0.7 hardcoded inside Material!I for BUS
 *                                        (spec `open_questions[1]`: these three were literals in
 *                                        the Excel formula with no Inputs cell; they are config
 *                                        here so they can be calibrated)
 *
 *   CableCostingConfig.labour          <- spec `labour`
 *     .crewSize                       <- Inputs!B32
 *     .crewDayRate                    <- Inputs!B33 (AED per crew-day, all-in)
 *     .effectiveHoursPerDay           <- Inputs!B34
 *     .minutesPerMetre                <- Inputs!B36
 *     .siteFactor                     <- Inputs!B37
 *     .subcontractMargin              <- Inputs!B38
 *     .basis                          <- Inputs!B39, the labour-basis switch:
 *                                        "self_cost"             = self-computed cost   (Labour!J)
 *                                        "suggested_subcontract" = suggested sub rate   (Labour!K)
 *                                        "agreed_subcontract"    = agreed paid sub rate (Labour!L)
 *
 *   CableCostingConfig.overheads       <- spec `overheads`
 *     .wastageRate                    <- Inputs!B26
 *     .procurementBasis               <- Inputs!B27: "per_metre" / "per_roll"
 *     .markup                         <- Inputs!B28 (cost-plus markup, NOT a gross margin)
 *     .vatRate                        <- Inputs!B29
 *
 * TIERS (`Tier`) map onto the quotation-basis switch Inputs!B40:
 *   "internal" = tier A - everything cost-plus: (material + labour cost) x (1 + markup)
 *   "client"   = tier B - material cost-plus + labour billed at the per-point client
 *                tariff (Points!J). Never add another margin on top of B (spec
 *                `overheads.summary_formulas` row 12 hard rule).
 */

export type Tier = "internal" | "client";

export type Topology = "STAR" | "RADIAL" | "BUS";

/** Confidence of a cable unit price. Mirrors spec `materials.grade_meaning`. */
export type CableGrade = "supplier_quote" | "back_solved" | "estimate";

/** Inputs!B39 - which per-point labour rate column is in force. */
export type LabourBasis = "self_cost" | "suggested_subcontract" | "agreed_subcontract";

/** Inputs!B27 - how purchased cable is priced. */
export type ProcurementBasis = "per_metre" | "per_roll";

export interface CablePriceConfig {
  id: string;
  nameCn: string;
  nameEn: string;
  spec?: string;
  ratePerMetre: number;
  rollMetres: number;
  rollPrice: number;
  grade: CableGrade;
  quoteRef?: string;
  /** ISO date (YYYY-MM-DD). A past date raises an expiry warning. */
  quoteValidUntil?: string;
}

export interface PointCatalogueConfig {
  id: string;
  nameCn: string;
  nameEn: string;
  system: string;
  cableId: string;
  cablesPerPoint: number;
  topology: Topology;
  terminateMinutes: number;
  clientRatePerPoint: number;
  agreedSubcontractRatePerPoint?: number;
  enabled?: boolean;
}

export interface CableLengthModelConfig {
  horizontalRoutingFactor: number;
  verticalRoutingFactor: number;
  floorHeightM: number;
  mdbFloor: number;
  tailStarM: number;
  tailRadialM: number;
  dropBusM: number;
  tailBusM: number;
  kStar: number;
  kRadial: number;
  kBus: number;
  starPlanFactor: number;
  radialPlanFactor: number;
  busSpacingFactor: number;
}

export interface LabourModelConfig {
  crewSize: number;
  crewDayRate: number;
  effectiveHoursPerDay: number;
  minutesPerMetre: number;
  siteFactor: number;
  subcontractMargin: number;
  basis: LabourBasis;
}

export interface OverheadsConfig {
  wastageRate: number;
  procurementBasis: ProcurementBasis;
  markup: number;
  vatRate: number;
}

export interface CableCostingConfig {
  modelVersion: string;
  currency: "AED";
  /** Optional ISO date used as "today" for quote-expiry warnings. */
  asOfDate?: string;
  points: PointCatalogueConfig[];
  cables: CablePriceConfig[];
  lengthModel: CableLengthModelConfig;
  labour: LabourModelConfig;
  overheads: OverheadsConfig;
}

export interface CableCostingInput {
  areaSqm: number;
  floors: number;
  /** point id -> point count. Keys must exist and be enabled in the catalogue. */
  quantities: Record<string, number>;
  tier: Tier;
}

export interface CableLineItem {
  cableId: string;
  nameCn: string;
  nameEn: string;
  /** Metres to buy/pull, wastage already included (Material!J rolled up per cable type). */
  metres: number;
  unitPrice: number;
  /** metres x unitPrice - per-metre valuation of this cable, wastage included. */
  amount: number;
  /** `back_solved` is surfaced as `estimate`: anything not on a supplier quote is an estimate. */
  grade: "supplier_quote" | "estimate";
}

export interface LabourLineItem {
  pointId: string;
  nameCn: string;
  nameEn: string;
  points: number;
  /** Minutes of pulling PER POINT (Labour!H). */
  pullMinutes: number;
  /** Minutes of termination PER POINT (Points!H / Labour!G). */
  terminateMinutes: number;
  /** points x (pullMinutes + terminateMinutes) / 60 - crew-hours for the whole row. */
  totalHours: number;
  /**
   * Money for this row in the selected tier:
   *   tier "internal" -> labour cost at `config.labour.basis`
   *   tier "client"   -> points x Points!J client tariff
   */
  amount: number;
}

export interface CableCostingResult {
  currency: "AED";
  derived: {
    /** point id -> metres of cable per point (Material!I). 0 when the point count is 0. */
    perPointLengthM: Record<string, number>;
    /** Sum of metres over all cables, wastage included (Material!J22). */
    totalMetres: number;
    /** Total minutes / (effectiveHoursPerDay x 60) - crew-days, not man-days. */
    crewDays: number;
  };
  cables: CableLineItem[];
  /** Sum of (metres excluding wastage x unit price). */
  materialSubtotal: number;
  /**
   * materialTotal - materialSubtotal. On `per_metre` basis this is exactly the wastage
   * money; on `per_roll` basis it also carries the round-up-to-whole-roll difference
   * (a warning states that difference separately). The identity
   * `materialSubtotal + wastage === materialTotal` always holds.
   */
  wastage: number;
  materialTotal: number;
  labour: { lines: LabourLineItem[]; subtotal: number };
  overheads: {
    /** Markup money included in totalExVat. */
    markup: number;
    /**
     * Subcontractor margin money embedded in the labour subtotal.
     * Non-zero only for tier "internal" on the "suggested_subcontract" basis, where the
     * margin is a known function of the self-computed cost.
     */
    subcontractMargin: number;
  };
  totalExVat: number;
  vat: number;
  total: number;
  /** Bilingual, formatted "<chinese> / <english>". */
  warnings: string[];
}

export interface PointCatalogueEntry {
  id: string;
  nameCn: string;
  nameEn: string;
  system: string;
  topology: string;
}
