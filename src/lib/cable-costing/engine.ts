/**
 * Cable & pulling-labour costing engine — pure arithmetic.
 *
 * PUBLIC REPOSITORY: this file must never contain a price, a labour rate, a
 * coefficient or a per-point tariff. Everything numeric arrives through
 * `CableCostingConfig` (see `./types.ts` for the config <-> spec cell map and
 * `./config.ts` for how production loads it).
 *
 * Formula provenance (Excel master, mirrored by the model spec):
 *   floorArea         = areaSqm / floors                            Inputs!B8
 *   charLength        = sqrt(floorArea)                             Inputs!B9
 *   avgFloorsCrossed  = ((m-1)m + (n-m)(n-m+1)) / (2n)              Inputs!B12
 *   busPointsPerFloor = max(1, SUM(cables of that type on BUS)/n)   Material!H
 *   perPointLength    STAR   = kStar   * (r_h*starPlanFactor*charLength
 *                                        + r_v*floorHeight*avgFloorsCrossed) + tailStar
 *                     RADIAL = kRadial * (r_h*radialPlanFactor*charLength) + tailRadial
 *                     BUS    = kBus    * (r_h*busSpacingFactor
 *                                        * sqrt(floorArea/busPointsPerFloor))
 *                                        + dropBus + tailBus        Material!I
 *   row metres        = points * cablesPerPoint * perPointLength * (1+wastage)   Material!J
 *   pull minutes/pt   = perPointLength * cablesPerPoint * minutesPerMetre * siteFactor  Labour!H
 *   cost/point        = (pull + terminate) * crewDayRate/(effectiveHours*60)     Labour!J
 */

import type {
  CableCostingConfig,
  CableCostingInput,
  CableCostingResult,
  CableGrade,
  CableLengthModelConfig,
  CableLineItem,
  CablePriceConfig,
  LabourBasis,
  LabourLineItem,
  LabourModelConfig,
  OverheadsConfig,
  PointCatalogueConfig,
  PointCatalogueEntry,
  ProcurementBasis,
  Tier,
  Topology,
} from "./types";

/** Thrown when the injected configuration is missing or structurally invalid. */
export class CableCostingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CableCostingConfigError";
  }
}

/** Thrown when the caller-supplied project input is invalid. */
export class CableCostingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CableCostingInputError";
  }
}

const TOPOLOGIES: readonly Topology[] = ["STAR", "RADIAL", "BUS"];
const GRADES: readonly CableGrade[] = ["supplier_quote", "back_solved", "estimate"];
const LABOUR_BASES: readonly LabourBasis[] = [
  "self_cost",
  "suggested_subcontract",
  "agreed_subcontract",
];
const PROCUREMENT_BASES: readonly ProcurementBasis[] = ["per_metre", "per_roll"];
const TIERS: readonly Tier[] = ["internal", "client"];

// ---------------------------------------------------------------------------
// Structural validation (no defaults, no fallbacks — a bad config always throws)
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configFail(path: string, expectation: string): never {
  throw new CableCostingConfigError(
    `CABLE_COSTING_CONFIG is invalid at "${path}": ${expectation}. ` +
      "Ask an administrator to regenerate the cable costing configuration from the cost model spec.",
  );
}

function requireRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) configFail(path, "expected an object");
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    configFail(path, "expected a non-empty array");
  }
  return value;
}

function requireString(source: UnknownRecord, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") {
    configFail(`${path}.${key}`, "expected a non-empty string");
  }
  return value;
}

function optionalString(source: UnknownRecord, key: string, path: string): string | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return requireString(source, key, path);
}

interface NumberBounds {
  min?: number;
  exclusiveMin?: number;
  integer?: boolean;
}

function requireNumber(
  source: UnknownRecord,
  key: string,
  path: string,
  bounds: NumberBounds = {},
): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    configFail(`${path}.${key}`, "expected a finite number");
  }
  if (bounds.integer === true && !Number.isInteger(value)) {
    configFail(`${path}.${key}`, "expected an integer");
  }
  if (bounds.min !== undefined && value < bounds.min) {
    configFail(`${path}.${key}`, `expected a number >= ${bounds.min}`);
  }
  if (bounds.exclusiveMin !== undefined && value <= bounds.exclusiveMin) {
    configFail(`${path}.${key}`, `expected a number > ${bounds.exclusiveMin}`);
  }
  return value;
}

function optionalNumber(
  source: UnknownRecord,
  key: string,
  path: string,
  bounds: NumberBounds = {},
): number | undefined {
  if (source[key] === undefined || source[key] === null) return undefined;
  return requireNumber(source, key, path, bounds);
}

function requireEnum<T extends string>(
  source: UnknownRecord,
  key: string,
  path: string,
  allowed: readonly T[],
): T {
  const value = source[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    configFail(`${path}.${key}`, `expected one of ${allowed.join(" | ")}`);
  }
  return value as T;
}

function requireIsoDate(value: string, path: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    configFail(path, "expected an ISO date (YYYY-MM-DD)");
  }
  return value;
}

function validateCable(raw: unknown, index: number): CablePriceConfig {
  const path = `cables[${index}]`;
  const source = requireRecord(raw, path);
  const validUntil = optionalString(source, "quoteValidUntil", path);
  return {
    id: requireString(source, "id", path),
    nameCn: requireString(source, "nameCn", path),
    nameEn: requireString(source, "nameEn", path),
    spec: optionalString(source, "spec", path),
    ratePerMetre: requireNumber(source, "ratePerMetre", path, { exclusiveMin: 0 }),
    rollMetres: requireNumber(source, "rollMetres", path, { exclusiveMin: 0 }),
    rollPrice: requireNumber(source, "rollPrice", path, { min: 0 }),
    grade: requireEnum(source, "grade", path, GRADES),
    quoteRef: optionalString(source, "quoteRef", path),
    quoteValidUntil:
      validUntil === undefined ? undefined : requireIsoDate(validUntil, `${path}.quoteValidUntil`),
  };
}

function validatePoint(raw: unknown, index: number): PointCatalogueConfig {
  const path = `points[${index}]`;
  const source = requireRecord(raw, path);
  const enabled = source.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    configFail(`${path}.enabled`, "expected a boolean");
  }
  return {
    id: requireString(source, "id", path),
    nameCn: requireString(source, "nameCn", path),
    nameEn: requireString(source, "nameEn", path),
    system: requireString(source, "system", path),
    cableId: requireString(source, "cableId", path),
    cablesPerPoint: requireNumber(source, "cablesPerPoint", path, { integer: true, min: 1 }),
    topology: requireEnum(source, "topology", path, TOPOLOGIES),
    terminateMinutes: requireNumber(source, "terminateMinutes", path, { exclusiveMin: 0 }),
    clientRatePerPoint: requireNumber(source, "clientRatePerPoint", path, { min: 0 }),
    agreedSubcontractRatePerPoint: optionalNumber(
      source,
      "agreedSubcontractRatePerPoint",
      path,
      { min: 0 },
    ),
    enabled: enabled === undefined ? true : enabled,
  };
}

function validateLengthModel(raw: unknown): CableLengthModelConfig {
  const path = "lengthModel";
  const source = requireRecord(raw, path);
  return {
    horizontalRoutingFactor: requireNumber(source, "horizontalRoutingFactor", path, { exclusiveMin: 0 }),
    verticalRoutingFactor: requireNumber(source, "verticalRoutingFactor", path, { min: 0 }),
    floorHeightM: requireNumber(source, "floorHeightM", path, { exclusiveMin: 0 }),
    mdbFloor: requireNumber(source, "mdbFloor", path, { integer: true, min: 1 }),
    tailStarM: requireNumber(source, "tailStarM", path, { min: 0 }),
    tailRadialM: requireNumber(source, "tailRadialM", path, { min: 0 }),
    dropBusM: requireNumber(source, "dropBusM", path, { min: 0 }),
    tailBusM: requireNumber(source, "tailBusM", path, { min: 0 }),
    kStar: requireNumber(source, "kStar", path, { exclusiveMin: 0 }),
    kRadial: requireNumber(source, "kRadial", path, { exclusiveMin: 0 }),
    kBus: requireNumber(source, "kBus", path, { exclusiveMin: 0 }),
    starPlanFactor: requireNumber(source, "starPlanFactor", path, { exclusiveMin: 0 }),
    radialPlanFactor: requireNumber(source, "radialPlanFactor", path, { exclusiveMin: 0 }),
    busSpacingFactor: requireNumber(source, "busSpacingFactor", path, { exclusiveMin: 0 }),
  };
}

function validateLabour(raw: unknown): LabourModelConfig {
  const path = "labour";
  const source = requireRecord(raw, path);
  return {
    crewSize: requireNumber(source, "crewSize", path, { integer: true, min: 1 }),
    crewDayRate: requireNumber(source, "crewDayRate", path, { min: 0 }),
    effectiveHoursPerDay: requireNumber(source, "effectiveHoursPerDay", path, { exclusiveMin: 0 }),
    minutesPerMetre: requireNumber(source, "minutesPerMetre", path, { min: 0 }),
    siteFactor: requireNumber(source, "siteFactor", path, { exclusiveMin: 0 }),
    subcontractMargin: requireNumber(source, "subcontractMargin", path, { min: 0 }),
    basis: requireEnum(source, "basis", path, LABOUR_BASES),
  };
}

function validateOverheads(raw: unknown): OverheadsConfig {
  const path = "overheads";
  const source = requireRecord(raw, path);
  return {
    wastageRate: requireNumber(source, "wastageRate", path, { min: 0 }),
    procurementBasis: requireEnum(source, "procurementBasis", path, PROCUREMENT_BASES),
    markup: requireNumber(source, "markup", path, { min: 0 }),
    vatRate: requireNumber(source, "vatRate", path, { min: 0 }),
  };
}

/**
 * Validate an untrusted structure (parsed JSON) into a `CableCostingConfig`.
 * Throws `CableCostingConfigError` with the failing path. Never substitutes a default.
 */
export function validateCableCostingConfig(raw: unknown): CableCostingConfig {
  const source = requireRecord(raw, "<root>");
  const currency = requireString(source, "currency", "<root>");
  if (currency !== "AED") configFail("currency", 'expected "AED"');

  const asOfDate = optionalString(source, "asOfDate", "<root>");
  const cables = requireArray(source.cables, "cables").map(validateCable);
  const points = requireArray(source.points, "points").map(validatePoint);
  const overheads = validateOverheads(source.overheads);

  const cableIds = new Set<string>();
  for (const cable of cables) {
    if (cableIds.has(cable.id)) configFail(`cables.${cable.id}`, "duplicate cable id");
    cableIds.add(cable.id);
    if (overheads.procurementBasis === "per_roll" && cable.rollPrice <= 0) {
      configFail(
        `cables.${cable.id}.rollPrice`,
        'expected a number > 0 because overheads.procurementBasis is "per_roll"',
      );
    }
  }

  const pointIds = new Set<string>();
  for (const point of points) {
    if (pointIds.has(point.id)) configFail(`points.${point.id}`, "duplicate point id");
    pointIds.add(point.id);
    if (!cableIds.has(point.cableId)) {
      configFail(`points.${point.id}.cableId`, "must reference an existing cables[].id");
    }
  }

  return {
    modelVersion: requireString(source, "modelVersion", "<root>"),
    currency: "AED",
    asOfDate: asOfDate === undefined ? undefined : requireIsoDate(asOfDate, "asOfDate"),
    points,
    cables,
    lengthModel: validateLengthModel(source.lengthModel),
    labour: validateLabour(source.labour),
    overheads,
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function inputFail(message: string): never {
  throw new CableCostingInputError(message);
}

function enabledPoints(config: CableCostingConfig): PointCatalogueConfig[] {
  return config.points.filter((point) => point.enabled !== false);
}

function validateInput(
  input: CableCostingInput,
  config: CableCostingConfig,
): { areaSqm: number; floors: number; tier: Tier; quantities: Map<string, number> } {
  if (!isRecord(input)) inputFail("cable costing input must be an object");
  const { areaSqm, floors, tier, quantities } = input;

  if (typeof areaSqm !== "number" || !Number.isFinite(areaSqm) || areaSqm <= 0) {
    inputFail("areaSqm must be a finite number greater than 0");
  }
  if (typeof floors !== "number" || !Number.isInteger(floors) || floors < 1) {
    inputFail("floors must be an integer greater than or equal to 1");
  }
  if (typeof tier !== "string" || !TIERS.includes(tier)) {
    inputFail(`tier must be one of ${TIERS.join(" | ")}`);
  }
  if (floors < config.lengthModel.mdbFloor) {
    inputFail(
      `floors (${floors}) cannot be smaller than the configured main-DB floor (${config.lengthModel.mdbFloor})`,
    );
  }
  if (!isRecord(quantities)) inputFail("quantities must be an object of pointId -> count");

  const catalogue = new Map(enabledPoints(config).map((point) => [point.id, point]));
  const parsed = new Map<string, number>();
  for (const [pointId, rawCount] of Object.entries(quantities)) {
    if (!catalogue.has(pointId)) {
      inputFail(`quantities contains unknown or disabled point id "${pointId}"`);
    }
    if (typeof rawCount !== "number" || !Number.isFinite(rawCount)) {
      inputFail(`quantities["${pointId}"] must be a finite number`);
    }
    if (!Number.isInteger(rawCount)) {
      inputFail(`quantities["${pointId}"] must be a whole number of points`);
    }
    if (rawCount < 0) {
      inputFail(`quantities["${pointId}"] must not be negative`);
    }
    parsed.set(pointId, rawCount);
  }

  return { areaSqm, floors, tier, quantities: parsed };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Inputs!B12 — average number of slabs a uniformly distributed point crosses. */
function averageFloorsCrossed(floors: number, mdbFloor: number): number {
  const below = (mdbFloor - 1) * mdbFloor;
  const above = (floors - mdbFloor) * (floors - mdbFloor + 1);
  return (below + above) / (2 * floors);
}

function perPointLength(
  topology: Topology,
  lengthModel: CableLengthModelConfig,
  geometry: { charLength: number; floorArea: number; avgFloorsCrossed: number },
  busPointsPerFloor: number,
): number {
  const {
    horizontalRoutingFactor: rh,
    verticalRoutingFactor: rv,
    floorHeightM,
    starPlanFactor,
    radialPlanFactor,
    busSpacingFactor,
  } = lengthModel;

  if (topology === "STAR") {
    return (
      lengthModel.kStar *
        (rh * starPlanFactor * geometry.charLength +
          rv * floorHeightM * geometry.avgFloorsCrossed) +
      lengthModel.tailStarM
    );
  }
  if (topology === "RADIAL") {
    return lengthModel.kRadial * (rh * radialPlanFactor * geometry.charLength) + lengthModel.tailRadialM;
  }
  return (
    lengthModel.kBus *
      (rh * busSpacingFactor * Math.sqrt(geometry.floorArea / busPointsPerFloor)) +
    lengthModel.dropBusM +
    lengthModel.tailBusM
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Price-free catalogue for rendering the input form. */
export function getPointCatalogue(config: CableCostingConfig): PointCatalogueEntry[] {
  return enabledPoints(config).map((point) => ({
    id: point.id,
    nameCn: point.nameCn,
    nameEn: point.nameEn,
    system: point.system,
    topology: point.topology,
  }));
}

export function calculateCableCosting(
  input: CableCostingInput,
  config: CableCostingConfig,
): CableCostingResult {
  const { areaSqm, floors, tier, quantities } = validateInput(input, config);
  const { lengthModel, labour, overheads } = config;
  const points = enabledPoints(config);
  const cableById = new Map(config.cables.map((cable) => [cable.id, cable]));

  const floorArea = areaSqm / floors;
  const geometry = {
    floorArea,
    charLength: Math.sqrt(floorArea),
    avgFloorsCrossed: averageFloorsCrossed(floors, lengthModel.mdbFloor),
  };

  // Material!H — BUS density is measured per cable type, not per catalogue row,
  // because a bus trunk is shared by every point on that cable.
  const busCablesPerFloor = new Map<string, number>();
  for (const point of points) {
    if (point.topology !== "BUS") continue;
    const count = quantities.get(point.id) ?? 0;
    if (count === 0) continue;
    const previous = busCablesPerFloor.get(point.cableId) ?? 0;
    busCablesPerFloor.set(point.cableId, previous + count * point.cablesPerPoint);
  }

  const perPointLengthM: Record<string, number> = {};
  const warnings: string[] = [];

  interface CableAccumulator {
    cable: CablePriceConfig;
    netMetres: number;
  }
  const cableAccumulators = new Map<string, CableAccumulator>();
  const labourLines: LabourLineItem[] = [];

  const costPerMinute = labour.crewDayRate / (labour.effectiveHoursPerDay * 60);
  let totalMinutes = 0;
  let selfCostTotal = 0;
  let basisCostTotal = 0;
  let clientSellTotal = 0;
  let missingAgreedRate = false;
  let missingClientRate = false;

  for (const point of points) {
    const count = quantities.get(point.id) ?? 0;
    const busPointsPerFloor = Math.max(
      1,
      (busCablesPerFloor.get(point.cableId) ?? 0) / floors,
    );
    const lengthPerPoint =
      count === 0
        ? 0
        : perPointLength(point.topology, lengthModel, geometry, busPointsPerFloor);
    perPointLengthM[point.id] = lengthPerPoint;
    if (count === 0) continue;

    const cable = cableById.get(point.cableId);
    if (cable === undefined) {
      // Unreachable for a validated config; kept so a hand-built config cannot silently drop money.
      throw new CableCostingConfigError(
        `Point "${point.id}" references unknown cable "${point.cableId}".`,
      );
    }

    const netMetres = count * point.cablesPerPoint * lengthPerPoint;
    const accumulator = cableAccumulators.get(cable.id) ?? { cable, netMetres: 0 };
    accumulator.netMetres += netMetres;
    cableAccumulators.set(cable.id, accumulator);

    const pullMinutes =
      lengthPerPoint * point.cablesPerPoint * labour.minutesPerMetre * labour.siteFactor;
    const minutesPerPoint = pullMinutes + point.terminateMinutes;
    const selfCostPerPoint = minutesPerPoint * costPerMinute;
    const suggestedPerPoint = selfCostPerPoint * (1 + labour.subcontractMargin);
    const agreedPerPoint = point.agreedSubcontractRatePerPoint ?? 0;
    if (labour.basis === "agreed_subcontract" && agreedPerPoint <= 0) {
      missingAgreedRate = true;
    }
    if (tier === "client" && point.clientRatePerPoint <= 0) {
      missingClientRate = true;
    }

    const basisRatePerPoint =
      labour.basis === "self_cost"
        ? selfCostPerPoint
        : labour.basis === "suggested_subcontract"
          ? suggestedPerPoint
          : agreedPerPoint;

    const rowMinutes = count * minutesPerPoint;
    totalMinutes += rowMinutes;
    selfCostTotal += count * selfCostPerPoint;
    basisCostTotal += count * basisRatePerPoint;
    clientSellTotal += count * point.clientRatePerPoint;

    labourLines.push({
      pointId: point.id,
      nameCn: point.nameCn,
      nameEn: point.nameEn,
      points: count,
      pullMinutes,
      terminateMinutes: point.terminateMinutes,
      totalHours: rowMinutes / 60,
      amount: tier === "client" ? count * point.clientRatePerPoint : count * basisRatePerPoint,
    });
  }

  const wastageFactor = 1 + overheads.wastageRate;
  const cables: CableLineItem[] = [];
  let totalMetres = 0;
  let materialSubtotal = 0;
  let perMetreTotal = 0;
  let perRollTotal = 0;
  let hasEstimatedCable = false;

  for (const { cable, netMetres } of cableAccumulators.values()) {
    const metres = netMetres * wastageFactor;
    const amount = metres * cable.ratePerMetre;
    totalMetres += metres;
    materialSubtotal += netMetres * cable.ratePerMetre;
    perMetreTotal += amount;
    perRollTotal += Math.ceil(metres / cable.rollMetres) * cable.rollPrice;
    if (cable.grade !== "supplier_quote") hasEstimatedCable = true;
    cables.push({
      cableId: cable.id,
      nameCn: cable.nameCn,
      nameEn: cable.nameEn,
      metres,
      unitPrice: cable.ratePerMetre,
      amount,
      grade: cable.grade === "supplier_quote" ? "supplier_quote" : "estimate",
    });
    if (isExpired(cable, config.asOfDate)) {
      warnings.push(
        `线材「${cable.nameCn}」的供应商报价已于 ${String(cable.quoteValidUntil)} 过期，正式报价前必须重新询价。` +
          ` / Supplier quote for "${cable.nameEn}" expired on ${String(cable.quoteValidUntil)}; re-confirm before quoting.`,
      );
    }
  }

  const materialTotal = overheads.procurementBasis === "per_roll" ? perRollTotal : perMetreTotal;
  const wastage = materialTotal - materialSubtotal;

  const labourSubtotal = tier === "client" ? clientSellTotal : basisCostTotal;
  const markupBase = tier === "client" ? materialTotal : materialTotal + labourSubtotal;
  const markup = markupBase * overheads.markup;
  const subcontractMargin =
    tier === "internal" && labour.basis === "suggested_subcontract"
      ? basisCostTotal - selfCostTotal
      : 0;

  const totalExVat = materialTotal + labourSubtotal + markup;
  const vat = totalExVat * overheads.vatRate;

  if (hasEstimatedCable) {
    warnings.push(
      "部分线材单价为估价（非供应商报价单），材料成本仅供参考。" +
        " / Some cable unit prices are estimates rather than supplier quotes; treat the material cost as indicative.",
    );
  }
  if (overheads.procurementBasis === "per_roll" && cables.length > 0) {
    warnings.push(
      `采用「按整卷」采购口径，整卷取整比按米多 ${formatAmount(perRollTotal - perMetreTotal)} AED。` +
        ` / Whole-roll procurement basis adds ${formatAmount(perRollTotal - perMetreTotal)} AED over per-metre valuation.`,
    );
  }
  if (missingAgreedRate) {
    warnings.push(
      "人工口径为「实付分包单价」，但有点位缺少已谈定的每点包干价，这些行按 0 计。" +
        " / Labour basis is the agreed subcontract rate, but some points have no agreed per-point rate and were costed at 0.",
    );
  }
  if (missingClientRate) {
    warnings.push(
      "对客口径下有点位的对客每点单价为 0，请确认这些点位的人工是否已在别处收费。" +
        " / On the client tier some points carry a zero per-point tariff; confirm their labour is billed elsewhere.",
    );
  }
  if (labour.basis !== "agreed_subcontract") {
    warnings.push(
      "穿线人工来自自下而上的工时模型（日薪与拉线速度均为估算），拿到分包包干价后应改用实付口径。" +
        " / Pulling labour comes from a bottom-up time model (crew day rate and pulling speed are estimates); switch to agreed subcontract rates once available.",
    );
  }

  return {
    currency: "AED",
    derived: {
      perPointLengthM,
      totalMetres,
      crewDays: totalMinutes / (labour.effectiveHoursPerDay * 60),
    },
    cables,
    materialSubtotal,
    wastage,
    materialTotal,
    labour: { lines: labourLines, subtotal: labourSubtotal },
    overheads: { markup, subcontractMargin },
    totalExVat,
    vat,
    total: totalExVat + vat,
    warnings,
  };
}

function isExpired(cable: CablePriceConfig, asOfDate: string | undefined): boolean {
  if (cable.quoteValidUntil === undefined) return false;
  const validUntil = Date.parse(cable.quoteValidUntil);
  if (Number.isNaN(validUntil)) return false;
  const reference = asOfDate === undefined ? Date.now() : Date.parse(asOfDate);
  if (Number.isNaN(reference)) return false;
  return reference > validUntil;
}

function formatAmount(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
