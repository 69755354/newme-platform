/**
 * Synthetic cable-costing configuration for unit tests.
 *
 * Every number here is INVENTED and chosen to keep the arithmetic exact in
 * binary floating point (integers, halves, quarters). It is not a rate card and
 * must never be treated as one: the real prices, labour rates and coefficients
 * live outside this public repository, injected through CABLE_COSTING_CONFIG.
 *
 * Handy consequences of these values:
 *   crew cost per minute        = 600 / (10 * 60)            = 1 AED/minute
 *   STAR length   (400 m2, 1 floor)  = 2*0.5*sqrt(400) + 1*4*0 + 1   = 21 m
 *   RADIAL length (400 m2, 1 floor)  = 2*0.5*sqrt(400) + 2           = 22 m
 *   BUS length    (400 m2, 1 floor, 4 bus cables) = 2*1*sqrt(400/4) + 3 + 4 = 27 m
 */

const BASE = {
  modelVersion: "synthetic-test",
  currency: "AED",
  asOfDate: "2026-01-01",
  cables: [
    {
      id: "bus_cable",
      nameCn: "合成总线线",
      nameEn: "Synthetic bus cable",
      spec: "synthetic",
      ratePerMetre: 10,
      rollMetres: 100,
      rollPrice: 1000,
      grade: "supplier_quote",
      quoteRef: "SYNTHETIC-1",
      quoteValidUntil: "2030-01-01",
    },
    {
      id: "radial_cable",
      nameCn: "合成辐射线",
      nameEn: "Synthetic radial cable",
      ratePerMetre: 20,
      rollMetres: 100,
      rollPrice: 2500,
      grade: "estimate",
    },
    {
      id: "star_cable",
      nameCn: "合成星形线",
      nameEn: "Synthetic star cable",
      ratePerMetre: 5,
      rollMetres: 50,
      rollPrice: 300,
      grade: "back_solved",
      quoteValidUntil: "2020-01-01",
    },
  ],
  points: [
    {
      id: "bus_panel",
      nameCn: "合成总线面板",
      nameEn: "Synthetic bus panel",
      system: "BusSystem",
      cableId: "bus_cable",
      cablesPerPoint: 1,
      topology: "BUS",
      terminateMinutes: 10,
      clientRatePerPoint: 100,
    },
    {
      id: "radial_motor",
      nameCn: "合成辐射电机",
      nameEn: "Synthetic radial motor",
      system: "RadialSystem",
      cableId: "radial_cable",
      cablesPerPoint: 2,
      topology: "RADIAL",
      terminateMinutes: 20,
      clientRatePerPoint: 200,
      agreedSubcontractRatePerPoint: 50,
    },
    {
      id: "star_camera",
      nameCn: "合成星形摄像机",
      nameEn: "Synthetic star camera",
      system: "StarSystem",
      cableId: "star_cable",
      cablesPerPoint: 1,
      topology: "STAR",
      terminateMinutes: 30,
      clientRatePerPoint: 0,
    },
    {
      id: "retired_row",
      nameCn: "合成停用点位",
      nameEn: "Synthetic retired point",
      system: "StarSystem",
      cableId: "star_cable",
      cablesPerPoint: 1,
      topology: "STAR",
      terminateMinutes: 10,
      clientRatePerPoint: 100,
      enabled: false,
    },
  ],
  lengthModel: {
    horizontalRoutingFactor: 2,
    verticalRoutingFactor: 1,
    floorHeightM: 4,
    mdbFloor: 1,
    tailStarM: 1,
    tailRadialM: 2,
    dropBusM: 3,
    tailBusM: 4,
    kStar: 1,
    kRadial: 1,
    kBus: 1,
    starPlanFactor: 0.5,
    radialPlanFactor: 0.5,
    busSpacingFactor: 1,
  },
  labour: {
    crewSize: 2,
    crewDayRate: 600,
    effectiveHoursPerDay: 10,
    minutesPerMetre: 2,
    siteFactor: 1,
    subcontractMargin: 0.5,
    basis: "suggested_subcontract",
  },
  overheads: {
    wastageRate: 0.25,
    procurementBasis: "per_metre",
    markup: 0.5,
    vatRate: 0.1,
  },
};

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Build a synthetic config, shallow-merging each top-level section so a test can
 * override just one knob: syntheticConfig({ overheads: { procurementBasis: "per_roll" } }).
 */
export function syntheticConfig(overrides = {}) {
  const base = clone(BASE);
  const merged = { ...base, ...overrides };
  for (const section of ["lengthModel", "labour", "overheads"]) {
    if (overrides[section] !== undefined) {
      merged[section] = { ...base[section], ...overrides[section] };
    }
  }
  return merged;
}

/** The reference project used by most assertions: 400 m2, single floor. */
export const syntheticInput = (overrides = {}) => ({
  areaSqm: 400,
  floors: 1,
  tier: "internal",
  quantities: { bus_panel: 4, radial_motor: 3, star_camera: 2 },
  ...overrides,
});
