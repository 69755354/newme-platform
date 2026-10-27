/**
 * Installation-labour basis for a quotation — which of the two ways of pricing
 * the labour line is in force, and the fallback rules between them.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC REPOSITORY — NO BUSINESS NUMBERS IN THIS FILE.
 * The only percentage this module knows is the one handed to it by the caller
 * (`QUOTATION_DEFAULTS.install_labor_pct`, already in the repository). The
 * bottom-up rate card never appears here: it arrives as a validated
 * `CableCostingConfig` object that the caller loaded from
 * `CABLE_COSTING_CONFIG` (see `./cable-costing/config.ts`).
 * ---------------------------------------------------------------------------
 *
 * TWO BASES
 *
 *   "product_pct"      the historic estimate: labour = a fixed percentage of
 *                      the after-discount product total. Cheap, but it says
 *                      that a villa with expensive dimmers is expensive to
 *                      wire, which is not how threading is paid for.
 *
 *   "bottom_up_cable"  the model in `src/lib/cable-costing`: metres of cable
 *                      per point from the topology, crew-hours from the pull
 *                      and termination norms, priced at the injected rates.
 *
 * The arithmetic of the second basis is NOT restated here (rule_014). This
 * module only decides which basis applies, calls the cable-costing engine
 * through the function the caller injects, and reports what it used.
 *
 * WHY THE PERCENTAGE BASIS STAYS
 *
 * The bottom-up model needs project geometry and a count of cabling POINTS.
 * Most quotations in this system are built from the device catalogue
 * (`src/lib/device-catalog.ts`), whose ids are not cabling points, and the
 * quote wizard runs in the browser where the rate card is deliberately
 * unreachable. Those quotations legitimately have nothing to feed the model
 * with, so the percentage remains the documented fallback rather than being
 * deleted.
 *
 * THE ONE THING THIS MODULE MUST NEVER DO
 *
 * Return zero (or a missing) labour figure because configuration or input was
 * absent. A silently-zero labour line under-quotes the job, and an under-quote
 * that reaches a customer is worse than an estimate that is admittedly rough.
 * Every failure path therefore returns the percentage figure and names the
 * reason in `install_labor_fallback_reason`; there is no path that yields 0.
 *
 * VAT / TAX BOUNDARY
 *
 * The figures taken from the cable-costing result are ex-VAT
 * (`totalExVat` and `labour.subtotal`). The quotation applies its own
 * `tax_rate` further down, so taking the cable model's VAT as well would tax
 * the same money twice.
 */

export const INSTALL_LABOR_BASIS_PRODUCT_PCT = "product_pct";
export const INSTALL_LABOR_BASIS_BOTTOM_UP = "bottom_up_cable";

/**
 * Machine-readable reasons for falling back to the percentage basis. They are
 * codes, not prose, because they are logged and (for the persisted marker)
 * parsed back out.
 */
export const INSTALL_LABOR_FALLBACK_REASONS = {
  /** No bottom-up request was made at all — e.g. the browser quote wizard. */
  NOT_REQUESTED: "bottom_up_not_requested",
  /** `CABLE_COSTING_CONFIG` is absent or invalid on this server. */
  CONFIG_UNAVAILABLE: "cable_costing_config_unavailable",
  /** Floor area / storey count missing or not usable. */
  GEOMETRY_MISSING: "project_geometry_missing",
  /** No cabling point counts, or every count is zero. */
  POINT_QUANTITIES_MISSING: "point_quantities_missing",
  /** The cable-costing engine rejected the request (unknown point id, etc.). */
  ENGINE_REJECTED_INPUT: "cable_costing_input_rejected",
  /** The model produced a non-positive labour figure — refuse to quote it. */
  NON_POSITIVE_LABOUR: "bottom_up_labour_non_positive",
};

/** Customer-facing quotations price labour at the client tariff, not at cost. */
export const DEFAULT_BOTTOM_UP_TIER = "client";

const NOTE_PREFIX = "[labour-basis]";

const round2 = (value) => Math.round(value * 100) / 100;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveFinite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Decide the installation-labour figure for one quotation.
 *
 * @param {object} args
 * @param {number} args.afterDiscount  product total after discount, in quote currency.
 * @param {number} args.installLaborPct  the historic percentage (e.g. 30), used by the fallback.
 * @param {object|null|undefined} args.request  bottom-up request — the rate card AND the
 *        cable-costing entry point to run it with, or null to stay on the percentage.
 * @returns {object} the labour fields to merge into a quotation result.
 */
export function resolveInstallLabour(args) {
  const { afterDiscount, installLaborPct, request = null } = isObject(args) ? args : {};

  // Kept as a single expression so the percentage basis produces exactly the
  // number it produced before this module existed.
  const percentageAmount = round2(afterDiscount * (installLaborPct / 100));

  const fallback = (reason) => ({
    install_labor: percentageAmount,
    install_labor_basis: INSTALL_LABOR_BASIS_PRODUCT_PCT,
    install_labor_pct: installLaborPct,
    install_labor_fallback_reason: reason,
    cable_material: 0,
    install_labor_detail: null,
  });

  if (!isObject(request)) return fallback(INSTALL_LABOR_FALLBACK_REASONS.NOT_REQUESTED);
  // Both the rate card and the engine to run it with are injected by a
  // server-only caller, so a browser caller structurally cannot reach this
  // basis — and does not have to carry the engine in its bundle either.
  const calculate = request.calculate;
  if (typeof calculate !== "function" || !isObject(request.config)) {
    return fallback(INSTALL_LABOR_FALLBACK_REASONS.CONFIG_UNAVAILABLE);
  }

  const areaSqm = request.area_sqm;
  const floors = request.floors;
  if (!isPositiveFinite(areaSqm) || !Number.isInteger(floors) || floors < 1) {
    return fallback(INSTALL_LABOR_FALLBACK_REASONS.GEOMETRY_MISSING);
  }

  const quantities = request.point_quantities;
  if (!isObject(quantities)) {
    return fallback(INSTALL_LABOR_FALLBACK_REASONS.POINT_QUANTITIES_MISSING);
  }
  let pointCount = 0;
  for (const value of Object.values(quantities)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) pointCount += value;
  }
  if (pointCount <= 0) {
    return fallback(INSTALL_LABOR_FALLBACK_REASONS.POINT_QUANTITIES_MISSING);
  }

  const tier = typeof request.tier === "string" ? request.tier : DEFAULT_BOTTOM_UP_TIER;

  // The engine is the only thing that knows which point ids exist, which are
  // enabled and what a legal quantity is, so its rejection is authoritative.
  // A rejection is not a reason to quote zero labour: fall back and say why.
  let result;
  try {
    result = calculate({ areaSqm, floors, quantities, tier }, request.config);
  } catch {
    return fallback(INSTALL_LABOR_FALLBACK_REASONS.ENGINE_REJECTED_INPUT);
  }

  const labourSubtotal = isObject(result) && isObject(result.labour)
    ? result.labour.subtotal
    : undefined;
  const totalExVat = isObject(result) ? result.totalExVat : undefined;
  if (
    !isPositiveFinite(labourSubtotal) ||
    typeof totalExVat !== "number" ||
    !Number.isFinite(totalExVat) ||
    totalExVat < labourSubtotal
  ) {
    return fallback(INSTALL_LABOR_FALLBACK_REASONS.NON_POSITIVE_LABOUR);
  }

  // `totalExVat - labour.subtotal` is the cable material with its cost-plus
  // markup, whichever tier is in force. Splitting it this way keeps the
  // identity `install_labor + cable_material === totalExVat` exact, so neither
  // half of the model can be double-counted or dropped.
  const cableMaterial = round2(totalExVat - labourSubtotal);
  const derived = isObject(result.derived) ? result.derived : {};

  return {
    install_labor: round2(labourSubtotal),
    install_labor_basis: INSTALL_LABOR_BASIS_BOTTOM_UP,
    install_labor_pct: null,
    install_labor_fallback_reason: null,
    cable_material: cableMaterial,
    install_labor_detail: {
      model_version: typeof request.config.modelVersion === "string"
        ? request.config.modelVersion
        : "unknown",
      tier,
      area_sqm: areaSqm,
      floors,
      point_count: pointCount,
      total_metres: typeof derived.totalMetres === "number" ? round2(derived.totalMetres) : 0,
      crew_days: typeof derived.crewDays === "number" ? round2(derived.crewDays) : 0,
      labour_subtotal: round2(labourSubtotal),
      material_total: cableMaterial,
      warnings: Array.isArray(result.warnings) ? [...result.warnings] : [],
    },
  };
}

// `;` and newlines are the marker's own separators, so a value may not contain
// them; runs of whitespace are collapsed so the result is stable to compare.
const sanitiseNoteValue = (value) =>
  String(value).replace(/[;\r\n]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Serialise the labour basis of a saved quotation into one machine-readable
 * line for the `internal_notes` column.
 *
 * WHY A TEXT MARKER AND NOT A COLUMN: the `quotations` table has no column for
 * any service line — labour, commissioning and project management were never
 * persisted, they were re-derived from `subtotal` at export time with the
 * percentages hardcoded. Adding columns means a migration, and a migration in
 * this repository drags in the whole schema-authority chain. So the basis and
 * the four service amounts are written to `internal_notes` (staff-only, never
 * printed on the customer CSV) and read back by the export route.
 *
 * Quotations on the percentage basis get NO marker: their export path stays
 * byte-for-byte what it was, which is what keeps every already-saved quotation
 * showing the basis and the money it was written with.
 *
 * @returns {string|null} the marker line, or null when nothing needs recording.
 */
export function formatInstallLabourNote(source) {
  if (!isObject(source)) return null;
  if (source.install_labor_basis !== INSTALL_LABOR_BASIS_BOTTOM_UP) return null;

  const model = isObject(source.install_labor_detail)
    ? sanitiseNoteValue(source.install_labor_detail.model_version ?? "unknown")
    : "unknown";
  const amount = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0).toFixed(2);

  return [
    `${NOTE_PREFIX} basis=${INSTALL_LABOR_BASIS_BOTTOM_UP}`,
    `install_labor=${amount(source.install_labor)}`,
    `cable_material=${amount(source.cable_material)}`,
    `commissioning=${amount(source.commissioning)}`,
    `project_management=${amount(source.project_management)}`,
    `model=${model}`,
  ].join("; ");
}

/** Append the marker to whatever the caller already wanted in `internal_notes`. */
export function appendInstallLabourNote(existing, note) {
  const base = typeof existing === "string" ? existing.trim() : "";
  if (typeof note !== "string" || note.trim() === "") return base === "" ? null : base;
  return base === "" ? note : `${base}\n${note}`;
}

/**
 * Read a labour-basis marker back out of `internal_notes`.
 *
 * @returns {object|null} null for anything without a marker — which includes
 *          every quotation saved before this feature, so those keep the legacy
 *          export behaviour instead of being reinterpreted.
 */
export function parseInstallLabourNote(text) {
  if (typeof text !== "string" || !text.includes(NOTE_PREFIX)) return null;

  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(NOTE_PREFIX));
  if (line === undefined) return null;

  const fields = new Map();
  for (const chunk of line.slice(NOTE_PREFIX.length).split(";")) {
    const separator = chunk.indexOf("=");
    if (separator === -1) continue;
    fields.set(chunk.slice(0, separator).trim(), chunk.slice(separator + 1).trim());
  }
  if (fields.get("basis") !== INSTALL_LABOR_BASIS_BOTTOM_UP) return null;

  const numeric = (key) => {
    const raw = fields.get(key);
    if (raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const installLabor = numeric("install_labor");
  const cableMaterial = numeric("cable_material");
  // A marker that lost its two headline amounts cannot be trusted to restate a
  // saved quotation, so it is treated as absent rather than half-read.
  if (installLabor === null || cableMaterial === null) return null;

  return {
    install_labor_basis: INSTALL_LABOR_BASIS_BOTTOM_UP,
    install_labor: installLabor,
    cable_material: cableMaterial,
    commissioning: numeric("commissioning"),
    project_management: numeric("project_management"),
    model_version: fields.get("model") ?? null,
  };
}
