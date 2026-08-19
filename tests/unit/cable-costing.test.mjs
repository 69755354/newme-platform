import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CableCostingConfigError,
  CableCostingInputError,
  calculateCableCosting,
  getPointCatalogue,
  validateCableCostingConfig,
} from "../../src/lib/cable-costing/engine.ts";
import { syntheticConfig, syntheticInput } from "../fixtures/cable-costing-synthetic-config.mjs";

/**
 * All numbers in this file come from the synthetic fixture, never from the real
 * rate card: this repository is public. The assertions pin the STRUCTURE of the
 * model (how length scales with area/floors/topology, how wastage, markup and
 * VAT stack, what the two tiers differ by), not any commercial value.
 */

const EPSILON = 1e-9;
const close = (actual, expected, label) => {
  assert.equal(typeof actual, "number", `${label}: expected a number, got ${typeof actual}`);
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < EPSILON,
    `${label}: expected ${expected}, got ${actual}`,
  );
};

const lineFor = (result, cableId) => {
  const line = result.cables.find((item) => item.cableId === cableId);
  assert.ok(line, `no cable line for ${cableId}`);
  return line;
};
const labourFor = (result, pointId) => {
  const line = result.labour.lines.find((item) => item.pointId === pointId);
  assert.ok(line, `no labour line for ${pointId}`);
  return line;
};

// ---------------------------------------------------------------------------
// Length model
// ---------------------------------------------------------------------------

test("per-point length follows the topology formulas of the model", () => {
  const result = calculateCableCosting(syntheticInput(), syntheticConfig());
  // 400 m2 on one floor: characteristic edge = sqrt(400) = 20 m, no slab crossings.
  close(result.derived.perPointLengthM.bus_panel, 27, "BUS length");     // 2*1*sqrt(400/4) + 3 + 4
  close(result.derived.perPointLengthM.radial_motor, 22, "RADIAL length"); // 2*0.5*20 + 2
  close(result.derived.perPointLengthM.star_camera, 21, "STAR length");    // 2*0.5*20 + 0 + 1
});

test("length grows with the square root of area, not with area", () => {
  const config = syntheticConfig();
  const small = calculateCableCosting(syntheticInput({ areaSqm: 400 }), config).derived.perPointLengthM;
  const big = calculateCableCosting(syntheticInput({ areaSqm: 1600 }), config).derived.perPointLengthM;

  // Quadrupling the area doubles the routed part of every topology; the fixed
  // tails (1 / 2 / 7 m) do not scale.
  close(big.star_camera - 1, 2 * (small.star_camera - 1), "STAR routed part");
  close(big.radial_motor - 2, 2 * (small.radial_motor - 2), "RADIAL routed part");
  close(big.bus_panel - 7, 2 * (small.bus_panel - 7), "BUS routed part");
  assert.ok(big.star_camera < 4 * small.star_camera, "length must not scale linearly with area");
});

test("only STAR reaches through the risers, so only STAR reacts to floors and floor height", () => {
  const config = syntheticConfig();
  const twoFloors = calculateCableCosting(
    syntheticInput({ floors: 2 }),
    config,
  ).derived.perPointLengthM;
  const charLength = Math.sqrt(200); // 400 m2 over 2 floors

  // avgFloorsCrossed = ((1-1)*1 + (2-1)*2) / (2*2) = 0.5 -> 1 * 4 * 0.5 = 2 m of riser
  close(twoFloors.star_camera, charLength + 2 + 1, "STAR over two floors");
  close(twoFloors.radial_motor, charLength + 2, "RADIAL over two floors");

  const tallerFloors = calculateCableCosting(
    syntheticInput({ floors: 2 }),
    syntheticConfig({ lengthModel: { floorHeightM: 8 } }),
  ).derived.perPointLengthM;
  close(tallerFloors.star_camera, charLength + 4 + 1, "STAR with doubled floor height");
  close(tallerFloors.radial_motor, charLength + 2, "RADIAL ignores floor height");
  close(tallerFloors.bus_panel, twoFloors.bus_panel, "BUS ignores floor height");
});

test("BUS length falls as the bus gets denser, and is clamped at one cable per floor", () => {
  const config = syntheticConfig();
  const sparse = calculateCableCosting(syntheticInput(), config).derived.perPointLengthM;
  const dense = calculateCableCosting(
    syntheticInput({ quantities: { bus_panel: 16, radial_motor: 3, star_camera: 2 } }),
    config,
  ).derived.perPointLengthM;

  close(dense.bus_panel, 2 * Math.sqrt(400 / 16) + 7, "dense BUS length");
  assert.ok(dense.bus_panel < sparse.bus_panel, "denser bus must shorten per-point length");
  close(dense.radial_motor, sparse.radial_motor, "RADIAL is unaffected by point counts");
  close(dense.star_camera, sparse.star_camera, "STAR is unaffected by point counts");

  // 4 bus cables over 10 floors is 0.4 per floor; the model clamps the density to 1.
  const thin = calculateCableCosting(syntheticInput({ floors: 10 }), config).derived.perPointLengthM;
  close(thin.bus_panel, 2 * Math.sqrt(40 / 1) + 7, "clamped BUS density");
});

// ---------------------------------------------------------------------------
// Roll-up: cables per point and topology
// ---------------------------------------------------------------------------

test("metres roll up by cable type using point count x cables per point x length", () => {
  const result = calculateCableCosting(syntheticInput(), syntheticConfig());

  // wastage 25% is included in the metres you buy
  close(lineFor(result, "bus_cable").metres, 4 * 1 * 27 * 1.25, "bus metres");
  close(lineFor(result, "radial_cable").metres, 3 * 2 * 22 * 1.25, "radial metres (2 cables/point)");
  close(lineFor(result, "star_cable").metres, 2 * 1 * 21 * 1.25, "star metres");
  close(result.derived.totalMetres, 135 + 165 + 52.5, "total metres");

  close(lineFor(result, "radial_cable").amount, 165 * 20, "radial amount = metres x unit price");
  assert.equal(lineFor(result, "bus_cable").unitPrice, 20 / 2, "unit price passes through from config");
  assert.equal(result.currency, "AED");
});

test("cable lines with two points sharing one cable type are merged into one line", () => {
  const config = syntheticConfig();
  config.points.push({
    id: "second_star",
    nameCn: "第二星形点",
    nameEn: "Second star point",
    system: "StarSystem",
    cableId: "star_cable",
    cablesPerPoint: 1,
    topology: "STAR",
    terminateMinutes: 10,
    clientRatePerPoint: 100,
  });
  const result = calculateCableCosting(
    syntheticInput({ quantities: { star_camera: 2, second_star: 3 } }),
    config,
  );
  assert.equal(result.cables.length, 1, "one cable type -> one line");
  close(lineFor(result, "star_cable").metres, 5 * 21 * 1.25, "merged metres");
  assert.equal(result.labour.lines.length, 2, "labour stays per point type");
});

// ---------------------------------------------------------------------------
// Wastage, procurement basis, markup, VAT — and the order they stack in
// ---------------------------------------------------------------------------

test("wastage sits between the net material value and the material total", () => {
  const result = calculateCableCosting(syntheticInput(), syntheticConfig());
  close(result.materialSubtotal, 108 * 10 + 132 * 20 + 42 * 5, "net material value");
  close(result.wastage, result.materialSubtotal * 0.25, "wastage money");
  close(result.materialTotal, result.materialSubtotal + result.wastage, "material total identity");
  close(result.materialTotal, 4912.5, "material total");
});

test("markup applies after wastage and VAT applies after markup", () => {
  const withWastage = calculateCableCosting(syntheticInput(), syntheticConfig());
  const noWastage = calculateCableCosting(
    syntheticInput(),
    syntheticConfig({ overheads: { wastageRate: 0 } }),
  );

  // internal tier: (material + labour) * (1 + markup), then VAT on top.
  close(withWastage.overheads.markup, (4912.5 + 1086) * 0.5, "markup money");
  close(withWastage.totalExVat, 4912.5 + 1086 + 2999.25, "total ex VAT");
  close(withWastage.vat, withWastage.totalExVat * 0.1, "VAT");
  close(withWastage.total, withWastage.totalExVat * 1.1, "total incl VAT");

  // The extra wastage money is itself marked up and taxed, never the other way round.
  close(
    withWastage.totalExVat - noWastage.totalExVat,
    982.5 * 1.5,
    "wastage flows through markup",
  );
  close(noWastage.wastage, 0, "no wastage configured");
});

test("whole-roll procurement rounds up per cable type and keeps the subtotal identity", () => {
  const result = calculateCableCosting(
    syntheticInput(),
    syntheticConfig({ overheads: { procurementBasis: "per_roll" } }),
  );
  // 135 m / 100 -> 2 rolls, 165 m / 100 -> 2 rolls, 52.5 m / 50 -> 2 rolls
  close(result.materialTotal, 2 * 1000 + 2 * 2500 + 2 * 300, "whole-roll material total");
  close(result.materialSubtotal, 3930, "net material value is basis independent");
  close(result.wastage, result.materialTotal - result.materialSubtotal, "wastage identity holds");
  close(result.overheads.markup, (7600 + 1086) * 0.5, "markup follows the adopted material total");
  assert.ok(
    result.warnings.some((warning) => warning.includes("2687.5")),
    "the roll rounding difference is reported",
  );
});

// ---------------------------------------------------------------------------
// Labour
// ---------------------------------------------------------------------------

test("labour minutes are driven by length, cables per point, speed and site factor", () => {
  const result = calculateCableCosting(syntheticInput(), syntheticConfig());

  const bus = labourFor(result, "bus_panel");
  close(bus.pullMinutes, 27 * 1 * 2 * 1, "bus pull minutes per point");
  close(bus.terminateMinutes, 10, "bus terminate minutes per point");
  close(bus.totalHours, (4 * (54 + 10)) / 60, "bus crew hours");

  const radial = labourFor(result, "radial_motor");
  close(radial.pullMinutes, 22 * 2 * 2 * 1, "two cables per point doubles pulling");

  // crew cost per minute = 600 / (10 h * 60) = 1 AED
  close(result.derived.crewDays, 724 / 600, "crew days");
  const slower = calculateCableCosting(
    syntheticInput(),
    syntheticConfig({ labour: { minutesPerMetre: 4 } }),
  );
  close(labourFor(slower, "bus_panel").pullMinutes, 2 * bus.pullMinutes, "pull speed scales minutes");
  close(
    calculateCableCosting(syntheticInput(), syntheticConfig({ labour: { siteFactor: 2 } })
    ).labour.lines[0].pullMinutes,
    2 * bus.pullMinutes,
    "site factor scales minutes",
  );
});

test("the labour basis switch chooses which per-point rate is charged", () => {
  const selfCost = calculateCableCosting(
    syntheticInput(),
    syntheticConfig({ labour: { basis: "self_cost" } }),
  );
  close(selfCost.labour.subtotal, 724, "self cost = total minutes x 1 AED/minute");
  close(selfCost.overheads.subcontractMargin, 0, "no subcontract margin on self cost");

  const suggested = calculateCableCosting(syntheticInput(), syntheticConfig());
  close(suggested.labour.subtotal, 724 * 1.5, "suggested = self cost x (1 + margin)");
  close(suggested.overheads.subcontractMargin, 362, "reported subcontract margin money");
  close(labourFor(suggested, "star_camera").amount, 2 * 72 * 1.5, "per row suggested amount");

  const agreed = calculateCableCosting(
    syntheticInput(),
    syntheticConfig({ labour: { basis: "agreed_subcontract" } }),
  );
  close(agreed.labour.subtotal, 3 * 50, "only the row with an agreed rate is charged");
  assert.ok(
    agreed.warnings.some((warning) => warning.includes("实付分包单价")),
    "missing agreed rates must be warned about",
  );
});

// ---------------------------------------------------------------------------
// Two tiers
// ---------------------------------------------------------------------------

test("internal tier marks up material and labour cost together", () => {
  const result = calculateCableCosting(syntheticInput({ tier: "internal" }), syntheticConfig());
  close(result.labour.subtotal, 1086, "labour billed at cost basis");
  close(result.overheads.markup, (result.materialTotal + result.labour.subtotal) * 0.5, "markup base");
  close(result.totalExVat, (4912.5 + 1086) * 1.5, "internal total ex VAT");
  close(result.total, 9897.525, "internal total incl VAT");
});

test("client tier bills labour at the per-point tariff and never marks it up", () => {
  const result = calculateCableCosting(syntheticInput({ tier: "client" }), syntheticConfig());
  close(result.labour.subtotal, 4 * 100 + 3 * 200 + 2 * 0, "labour billed at client tariff");
  close(labourFor(result, "radial_motor").amount, 600, "row amount is the client tariff");
  close(result.overheads.markup, 4912.5 * 0.5, "markup covers material only");
  close(result.overheads.subcontractMargin, 0, "no subcontract margin on the client tier");
  close(result.totalExVat, 4912.5 * 1.5 + 1000, "client total ex VAT");
  close(result.total, 9205.625, "client total incl VAT");

  // The client tariff is independent of the internal labour basis...
  const selfCostBasis = calculateCableCosting(
    syntheticInput({ tier: "client" }),
    syntheticConfig({ labour: { basis: "self_cost" } }),
  );
  close(selfCostBasis.labour.subtotal, 1000, "client tariff ignores the cost basis");
  close(selfCostBasis.overheads.markup, result.overheads.markup, "markup ignores the cost basis");

  // ...and the two tiers differ only in the labour leg and the markup base.
  const internal = calculateCableCosting(syntheticInput({ tier: "internal" }), syntheticConfig());
  close(internal.materialTotal, result.materialTotal, "material is tier independent");
  close(internal.derived.totalMetres, result.derived.totalMetres, "metres are tier independent");
  assert.notEqual(internal.totalExVat, result.totalExVat);
  assert.ok(
    result.warnings.some((warning) => warning.includes("对客每点单价为 0")),
    "a zero client tariff must be flagged on the client tier",
  );
});

// ---------------------------------------------------------------------------
// Degenerate input
// ---------------------------------------------------------------------------

test("no quantities means no money anywhere", () => {
  for (const quantities of [{}, { bus_panel: 0, radial_motor: 0, star_camera: 0 }]) {
    const result = calculateCableCosting(syntheticInput({ quantities }), syntheticConfig());
    assert.deepEqual(result.cables, []);
    assert.deepEqual(result.labour.lines, []);
    assert.deepEqual(result.derived.perPointLengthM, {
      bus_panel: 0,
      radial_motor: 0,
      star_camera: 0,
    });
    for (const [key, value] of Object.entries({
      totalMetres: result.derived.totalMetres,
      crewDays: result.derived.crewDays,
      materialSubtotal: result.materialSubtotal,
      wastage: result.wastage,
      materialTotal: result.materialTotal,
      labourSubtotal: result.labour.subtotal,
      markup: result.overheads.markup,
      subcontractMargin: result.overheads.subcontractMargin,
      totalExVat: result.totalExVat,
      vat: result.vat,
      total: result.total,
    })) {
      close(value, 0, `${key} on an empty project`);
    }
  }
});

test("a zero-count point contributes nothing and does not thin out the bus", () => {
  const config = syntheticConfig();
  const withZero = calculateCableCosting(
    syntheticInput({ quantities: { bus_panel: 4, radial_motor: 0, star_camera: 2 } }),
    config,
  );
  assert.equal(withZero.derived.perPointLengthM.radial_motor, 0, "zero count -> zero length");
  assert.equal(
    withZero.labour.lines.some((line) => line.pointId === "radial_motor"),
    false,
    "no labour line for a zero count",
  );
  assert.equal(
    withZero.cables.some((line) => line.cableId === "radial_cable"),
    false,
    "no cable line for a zero count",
  );
  close(withZero.derived.perPointLengthM.bus_panel, 27, "bus density ignores zero-count rows");
});

// ---------------------------------------------------------------------------
// Input rejection
// ---------------------------------------------------------------------------

test("bad project input is rejected instead of silently costing zero", () => {
  const config = syntheticConfig();
  const cases = [
    ["negative count", { quantities: { bus_panel: -1 } }],
    ["fractional count", { quantities: { bus_panel: 2.5 } }],
    ["NaN count", { quantities: { bus_panel: Number.NaN } }],
    ["infinite count", { quantities: { bus_panel: Number.POSITIVE_INFINITY } }],
    ["string count", { quantities: { bus_panel: "4" } }],
    ["null count", { quantities: { bus_panel: null } }],
    ["unknown point id", { quantities: { ghost_point: 1 } }],
    ["disabled point id", { quantities: { retired_row: 1 } }],
    ["zero area", { areaSqm: 0 }],
    ["negative area", { areaSqm: -400 }],
    ["NaN area", { areaSqm: Number.NaN }],
    ["string area", { areaSqm: "400" }],
    ["zero floors", { floors: 0 }],
    ["fractional floors", { floors: 1.5 }],
    ["string floors", { floors: "2" }],
    ["unknown tier", { tier: "reseller" }],
    ["missing quantities", { quantities: null }],
    ["array quantities", { quantities: [1, 2] }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () => calculateCableCosting(syntheticInput(overrides), config),
      CableCostingInputError,
      label,
    );
  }
});

test("a project with fewer floors than the configured main DB floor is rejected", () => {
  assert.throws(
    () => calculateCableCosting(syntheticInput({ floors: 1 }), syntheticConfig({ lengthModel: { mdbFloor: 3 } })),
    CableCostingInputError,
  );
});

// ---------------------------------------------------------------------------
// Config validation — never a default, always a throw
// ---------------------------------------------------------------------------

test("structural configuration faults throw CableCostingConfigError with a path", () => {
  const mutate = (mutator) => {
    const config = syntheticConfig();
    mutator(config);
    return config;
  };
  const cases = [
    ["not an object", null],
    ["array root", []],
    ["missing currency", mutate((c) => delete c.currency)],
    ["wrong currency", mutate((c) => { c.currency = "USD"; })],
    ["missing modelVersion", mutate((c) => delete c.modelVersion)],
    ["empty cables", mutate((c) => { c.cables = []; })],
    ["empty points", mutate((c) => { c.points = []; })],
    ["missing lengthModel", mutate((c) => delete c.lengthModel)],
    ["missing labour", mutate((c) => delete c.labour)],
    ["missing overheads", mutate((c) => delete c.overheads)],
    ["dangling cableId", mutate((c) => { c.points[0].cableId = "no_such_cable"; })],
    ["duplicate point id", mutate((c) => { c.points[1].id = c.points[0].id; })],
    ["duplicate cable id", mutate((c) => { c.cables[1].id = c.cables[0].id; })],
    ["bad topology", mutate((c) => { c.points[0].topology = "MESH"; })],
    ["bad grade", mutate((c) => { c.cables[0].grade = "guess"; })],
    ["bad labour basis", mutate((c) => { c.labour.basis = "hourly"; })],
    ["bad procurement basis", mutate((c) => { c.overheads.procurementBasis = "per_box"; })],
    ["string rate", mutate((c) => { c.cables[0].ratePerMetre = "10"; })],
    ["zero rate", mutate((c) => { c.cables[0].ratePerMetre = 0; })],
    ["negative wastage", mutate((c) => { c.overheads.wastageRate = -1; })],
    ["negative markup", mutate((c) => { c.overheads.markup = -1; })],
    ["negative vat", mutate((c) => { c.overheads.vatRate = -1; })],
    ["fractional cablesPerPoint", mutate((c) => { c.points[0].cablesPerPoint = 1.5; })],
    ["zero terminate minutes", mutate((c) => { c.points[0].terminateMinutes = 0; })],
    ["negative client rate", mutate((c) => { c.points[0].clientRatePerPoint = -1; })],
    ["zero effective hours", mutate((c) => { c.labour.effectiveHoursPerDay = 0; })],
    ["zero roll metres", mutate((c) => { c.cables[0].rollMetres = 0; })],
    ["NaN coefficient", mutate((c) => { c.lengthModel.kBus = Number.NaN; })],
    ["bad asOfDate", mutate((c) => { c.asOfDate = "20 Aug 2026"; })],
    ["non-boolean enabled", mutate((c) => { c.points[0].enabled = "Y"; })],
    [
      "whole-roll basis without roll prices",
      mutate((c) => {
        c.overheads.procurementBasis = "per_roll";
        c.cables[0].rollPrice = 0;
      }),
    ],
  ];
  for (const [label, candidate] of cases) {
    assert.throws(() => validateCableCostingConfig(candidate), CableCostingConfigError, label);
  }
});

test("a valid configuration round-trips and normalises the include flag", () => {
  const config = validateCableCostingConfig(syntheticConfig());
  assert.equal(config.currency, "AED");
  assert.equal(config.points[0].enabled, true, "missing include flag defaults to true");
  assert.equal(config.points[3].enabled, false);
  assert.equal(config.cables.length, 3);
  // The validated object is what the engine consumes.
  close(calculateCableCosting(syntheticInput(), config).materialTotal, 4912.5, "validated config prices");
});

test("configuration errors name the offending path and tell the admin what to do", () => {
  try {
    validateCableCostingConfig(syntheticConfig({ overheads: { markup: "20%" } }));
    assert.fail("expected a configuration error");
  } catch (error) {
    assert.ok(error instanceof CableCostingConfigError);
    assert.match(error.message, /overheads\.markup/);
    assert.match(error.message, /administrator/i);
  }
});

// ---------------------------------------------------------------------------
// Catalogue and warnings
// ---------------------------------------------------------------------------

test("the point catalogue is price free and hides disabled rows", () => {
  const catalogue = getPointCatalogue(syntheticConfig());
  assert.deepEqual(
    catalogue.map((entry) => entry.id),
    ["bus_panel", "radial_motor", "star_camera"],
  );
  for (const entry of catalogue) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "nameCn", "nameEn", "system", "topology"]);
  }
  const serialised = JSON.stringify(catalogue);
  for (const commercialValue of ["100", "200", "50", "Rate", "rate", "price", "Price", "minutes"]) {
    assert.equal(
      serialised.includes(commercialValue),
      false,
      `catalogue must not leak ${commercialValue}`,
    );
  }
});

test("estimated prices and expired quotes are warned about, bilingually", () => {
  const result = calculateCableCosting(syntheticInput(), syntheticConfig());
  assert.ok(result.warnings.length > 0, "warnings are produced");
  for (const warning of result.warnings) {
    assert.match(warning, /[一-鿿]/, `warning has no Chinese: ${warning}`);
    assert.match(warning, /[A-Za-z]{4,}/, `warning has no English: ${warning}`);
    assert.ok(warning.includes(" / "), `warning is not a bilingual pair: ${warning}`);
  }
  assert.ok(
    result.warnings.some((warning) => warning.includes("估价")),
    "an estimate-grade cable must be flagged",
  );
  assert.ok(
    result.warnings.some((warning) => warning.includes("2020-01-01")),
    "an expired supplier quote must be flagged with its date",
  );

  // Only supplier-quoted cables in play -> no estimate or expiry warning.
  const cleanConfig = syntheticConfig();
  for (const cable of cleanConfig.cables) {
    cable.grade = "supplier_quote";
    delete cable.quoteValidUntil;
  }
  cleanConfig.labour.basis = "agreed_subcontract";
  const clean = calculateCableCosting(
    syntheticInput({ quantities: { radial_motor: 3 } }),
    cleanConfig,
  );
  assert.deepEqual(clean.warnings, [], "a fully quoted project warns about nothing");
  assert.equal(lineFor(clean, "radial_cable").grade, "supplier_quote");
});

test("back-solved prices are surfaced to callers as estimates", () => {
  const result = calculateCableCosting(syntheticInput(), syntheticConfig());
  assert.equal(lineFor(result, "bus_cable").grade, "supplier_quote");
  assert.equal(lineFor(result, "radial_cable").grade, "estimate");
  assert.equal(lineFor(result, "star_cable").grade, "estimate", "back_solved is not a quote");
});

// ---------------------------------------------------------------------------
// Public-repository guard rails
// ---------------------------------------------------------------------------

test("the engine stays a pure function and the loader keeps no built-in rate card", async () => {
  const read = (name) =>
    readFile(new URL(`../../src/lib/cable-costing/${name}`, import.meta.url), "utf8");
  const [engine, config, index, types] = await Promise.all([
    read("engine.ts"),
    read("config.ts"),
    read("index.ts"),
    read("types.ts"),
  ]);

  assert.equal(engine.includes("process.env"), false, "the engine must not read the environment");
  assert.equal(index.includes("process.env"), false, "the barrel must not read the environment");
  assert.equal(index.includes('from "./config"'), false, "the barrel must stay browser-importable");
  assert.ok(config.startsWith('import "server-only";'), "the loader must be server-only");
  assert.ok(config.includes("CABLE_COSTING_CONFIG"), "the loader reads the injected config");

  // No default/fallback business numbers anywhere in the loader, and no decimal
  // rates hardcoded in the engine or the loader.
  for (const [name, source] of [["engine.ts", engine], ["config.ts", config], ["types.ts", types]]) {
    assert.equal(
      /(\?\?|\|\|)\s*-?\d*\.\d/.test(source),
      false,
      `${name} must not fall back to a hardcoded rate`,
    );
  }
  assert.equal(/\d+\.\d+/.test(config), false, "config.ts must contain no numeric rate literals");
  assert.equal(/\d+\.\d+/.test(engine), false, "engine.ts must contain no numeric rate literals");
});
