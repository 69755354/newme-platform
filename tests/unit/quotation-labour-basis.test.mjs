import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BOTTOM_UP_TIER,
  INSTALL_LABOR_BASIS_BOTTOM_UP,
  INSTALL_LABOR_BASIS_PRODUCT_PCT,
  INSTALL_LABOR_FALLBACK_REASONS,
  appendInstallLabourNote,
  formatInstallLabourNote,
  parseInstallLabourNote,
  resolveInstallLabour,
} from "../../src/lib/quotation-labour-basis.mjs";
import { calculateCableCosting } from "../../src/lib/cable-costing/engine.ts";
import { syntheticConfig } from "../fixtures/cable-costing-synthetic-config.mjs";

/**
 * Three paths are under test: the new bottom-up basis, the fallback to the
 * historic percentage, and the case where no rate card was injected at all.
 *
 * Every rate here comes from the synthetic fixture — this repository is public,
 * so the real rate card is never in a test file. Expected bottom-up amounts are
 * taken from the cable-costing engine itself rather than written out as
 * literals: the point of these assertions is that the quotation uses that engine
 * and reports honestly which basis it used, not that a particular price is right
 * (tests/unit/cable-costing.test.mjs already pins the model's arithmetic).
 */

const PCT = 30; // the historic percentage; mirrors QUOTATION_DEFAULTS.install_labor_pct
const AFTER_DISCOUNT = 123456.78;
const round2 = (value) => Math.round(value * 100) / 100;
const legacyAmount = (afterDiscount, pct) => round2(afterDiscount * (pct / 100));

const POINTS = { bus_panel: 4, radial_motor: 3, star_camera: 2 };

// The engine is injected through the request, the way the server-only
// `quotation-labour-request` builder does it in production.
const bottomUpRequest = (overrides = {}) => ({
  config: syntheticConfig(),
  calculate: calculateCableCosting,
  area_sqm: 400,
  floors: 1,
  point_quantities: { ...POINTS },
  ...overrides,
});

const resolve = (overrides = {}) =>
  resolveInstallLabour({
    afterDiscount: AFTER_DISCOUNT,
    installLaborPct: PCT,
    ...overrides,
  });

/** What the engine says on its own, for the same project. */
const reference = (tier, config = syntheticConfig()) =>
  calculateCableCosting({ areaSqm: 400, floors: 1, quantities: { ...POINTS }, tier }, config);

// ---------------------------------------------------------------------------
// Path 1 — the new basis
// ---------------------------------------------------------------------------

test("bottom-up basis takes the labour figure from the cable-costing engine", () => {
  const expected = reference("client");
  const out = resolve({ request: bottomUpRequest({ tier: "client" }) });

  assert.equal(out.install_labor_basis, INSTALL_LABOR_BASIS_BOTTOM_UP);
  assert.equal(out.install_labor_pct, null);
  assert.equal(out.install_labor_fallback_reason, null);
  assert.equal(out.install_labor, round2(expected.labour.subtotal));

  // The whole point of the change: the labour line no longer tracks the
  // product total.
  assert.notEqual(out.install_labor, legacyAmount(AFTER_DISCOUNT, PCT));
});

test("bottom-up basis splits the ex-VAT model total into labour and cable material", () => {
  const expected = reference("client");
  const out = resolve({ request: bottomUpRequest({ tier: "client" }) });

  assert.equal(out.cable_material, round2(expected.totalExVat - expected.labour.subtotal));
  assert.ok(out.cable_material > 0, "the cable material must not vanish from the quotation");
  // Nothing may be double-counted or dropped between the two halves.
  assert.ok(
    Math.abs(out.install_labor + out.cable_material - expected.totalExVat) < 0.02,
    "labour + material must reconstruct the model's ex-VAT total",
  );
  // The quotation applies its own tax_rate, so the model's VAT is excluded.
  assert.ok(out.install_labor + out.cable_material < expected.total);
});

test("bottom-up basis defaults to the client tier and reports the model it used", () => {
  const asClient = resolve({ request: bottomUpRequest({ tier: "client" }) });
  const withoutTier = resolve({ request: bottomUpRequest() });

  assert.equal(DEFAULT_BOTTOM_UP_TIER, "client");
  assert.equal(withoutTier.install_labor, asClient.install_labor);
  assert.equal(withoutTier.cable_material, asClient.cable_material);

  const detail = withoutTier.install_labor_detail;
  assert.equal(detail.model_version, "synthetic-test");
  assert.equal(detail.tier, "client");
  assert.equal(detail.point_count, 4 + 3 + 2);
  assert.equal(detail.area_sqm, 400);
  assert.equal(detail.floors, 1);
  assert.ok(detail.total_metres > 0, "metres pulled must be reported");
  assert.ok(detail.crew_days > 0, "crew-days must be reported");
  // Engine warnings must survive: they decide whether a figure may be sent out.
  assert.ok(Array.isArray(detail.warnings) && detail.warnings.length > 0);
});

test("bottom-up labour responds to the point count, not to the product total", () => {
  const few = resolve({ request: bottomUpRequest({ point_quantities: { bus_panel: 2 } }) });
  const many = resolve({ request: bottomUpRequest({ point_quantities: { bus_panel: 8 } }) });

  assert.equal(few.install_labor_basis, INSTALL_LABOR_BASIS_BOTTOM_UP);
  assert.ok(many.install_labor > few.install_labor);

  // Same points, ten times the product value: the labour line does not move.
  const richer = resolveInstallLabour({
    afterDiscount: AFTER_DISCOUNT * 10,
    installLaborPct: PCT,
    request: bottomUpRequest({ point_quantities: { bus_panel: 2 } }),
  });
  assert.equal(richer.install_labor, few.install_labor);
});

// ---------------------------------------------------------------------------
// Path 2 — fallback to the historic percentage
// ---------------------------------------------------------------------------

test("no bottom-up request keeps the historic percentage, to the cent", () => {
  for (const afterDiscount of [0, 1, 1000, 123456.78, 99999.99]) {
    const out = resolveInstallLabour({
      afterDiscount,
      installLaborPct: PCT,
      request: null,
    });
    assert.equal(out.install_labor_basis, INSTALL_LABOR_BASIS_PRODUCT_PCT);
    assert.equal(out.install_labor, legacyAmount(afterDiscount, PCT));
    assert.equal(out.install_labor_pct, PCT);
    assert.equal(out.cable_material, 0, "the percentage basis must not add a material line");
    assert.equal(out.install_labor_detail, null);
    assert.equal(out.install_labor_fallback_reason, INSTALL_LABOR_FALLBACK_REASONS.NOT_REQUESTED);
  }
});

test("each unusable bottom-up request falls back and names its reason", () => {
  const cases = [
    [{ point_quantities: {} }, INSTALL_LABOR_FALLBACK_REASONS.POINT_QUANTITIES_MISSING],
    [{ point_quantities: { bus_panel: 0 } }, INSTALL_LABOR_FALLBACK_REASONS.POINT_QUANTITIES_MISSING],
    [{ point_quantities: undefined }, INSTALL_LABOR_FALLBACK_REASONS.POINT_QUANTITIES_MISSING],
    [{ area_sqm: 0 }, INSTALL_LABOR_FALLBACK_REASONS.GEOMETRY_MISSING],
    [{ area_sqm: undefined }, INSTALL_LABOR_FALLBACK_REASONS.GEOMETRY_MISSING],
    [{ floors: 0 }, INSTALL_LABOR_FALLBACK_REASONS.GEOMETRY_MISSING],
    [{ floors: 1.5 }, INSTALL_LABOR_FALLBACK_REASONS.GEOMETRY_MISSING],
    // The engine owns input validation; its rejection must not become a zero.
    [{ point_quantities: { not_a_point: 3 } }, INSTALL_LABOR_FALLBACK_REASONS.ENGINE_REJECTED_INPUT],
    [{ point_quantities: { retired_row: 3 } }, INSTALL_LABOR_FALLBACK_REASONS.ENGINE_REJECTED_INPUT],
    [{ point_quantities: { bus_panel: 2.5 } }, INSTALL_LABOR_FALLBACK_REASONS.ENGINE_REJECTED_INPUT],
  ];

  for (const [overrides, reason] of cases) {
    const out = resolve({ request: bottomUpRequest(overrides) });
    assert.equal(out.install_labor_basis, INSTALL_LABOR_BASIS_PRODUCT_PCT, `${reason}: basis`);
    assert.equal(out.install_labor_fallback_reason, reason);
    assert.equal(out.install_labor, legacyAmount(AFTER_DISCOUNT, PCT), `${reason}: amount`);
    assert.equal(out.cable_material, 0);
  }
});

test("a model that prices labour at zero is refused, not quoted", () => {
  // Every point carries a zero client tariff, so the client tier would bill
  // nothing for labour. That must never leave the resolver as 0.
  const zeroRated = syntheticConfig();
  for (const point of zeroRated.points) point.clientRatePerPoint = 0;

  const out = resolve({ request: bottomUpRequest({ config: zeroRated, tier: "client" }) });

  assert.equal(out.install_labor_basis, INSTALL_LABOR_BASIS_PRODUCT_PCT);
  assert.equal(out.install_labor_fallback_reason, INSTALL_LABOR_FALLBACK_REASONS.NON_POSITIVE_LABOUR);
  assert.equal(out.install_labor, legacyAmount(AFTER_DISCOUNT, PCT));
  assert.ok(out.install_labor > 0);
});

// ---------------------------------------------------------------------------
// Path 3 — no rate card injected
// ---------------------------------------------------------------------------

test("a missing rate card falls back to the percentage and never to zero labour", () => {
  for (const config of [null, undefined]) {
    const out = resolve({ request: bottomUpRequest({ config }) });

    assert.equal(out.install_labor_basis, INSTALL_LABOR_BASIS_PRODUCT_PCT);
    assert.equal(out.install_labor_fallback_reason, INSTALL_LABOR_FALLBACK_REASONS.CONFIG_UNAVAILABLE);
    assert.equal(out.install_labor, legacyAmount(AFTER_DISCOUNT, PCT));
    assert.ok(out.install_labor > 0, "a missing configuration must never zero the labour line");
    assert.equal(out.cable_material, 0);
    assert.equal(out.install_labor_detail, null);
  }
});

test("no argument shape yields a zero or absent labour figure", () => {
  const requests = [
    undefined,
    null,
    "not an object",
    {},
    { config: {} },
    { config: syntheticConfig() },
    bottomUpRequest({ config: null }),
    bottomUpRequest({ point_quantities: {} }),
    // A request that never got the engine injected — e.g. assembled by browser
    // code, which cannot import it.
    bottomUpRequest({ calculate: undefined }),
    bottomUpRequest({ calculate: null }),
    bottomUpRequest({ calculate: "not a function" }),
  ];

  for (const request of requests) {
    const out = resolve({ request });
    assert.equal(typeof out.install_labor, "number");
    assert.ok(Number.isFinite(out.install_labor) && out.install_labor > 0);
    assert.ok(
      out.install_labor_basis === INSTALL_LABOR_BASIS_PRODUCT_PCT ||
        out.install_labor_basis === INSTALL_LABOR_BASIS_BOTTOM_UP,
    );
  }
});

// ---------------------------------------------------------------------------
// The persisted marker — how a saved quotation keeps the basis it was priced on
// ---------------------------------------------------------------------------

test("only a bottom-up quotation gets a marker, so older ones are left alone", () => {
  const bottomUp = {
    ...resolve({ request: bottomUpRequest({ tier: "client" }) }),
    commissioning: 14814.81,
    project_management: 9876.54,
  };
  const note = formatInstallLabourNote(bottomUp);
  assert.ok(typeof note === "string" && note.startsWith("[labour-basis]"));

  const parsed = parseInstallLabourNote(note);
  assert.equal(parsed.install_labor, bottomUp.install_labor);
  assert.equal(parsed.cable_material, bottomUp.cable_material);
  assert.equal(parsed.commissioning, 14814.81);
  assert.equal(parsed.project_management, 9876.54);
  assert.equal(parsed.model_version, "synthetic-test");

  // The percentage basis writes nothing: no marker means "export as before".
  assert.equal(formatInstallLabourNote({ ...bottomUp, install_labor_basis: INSTALL_LABOR_BASIS_PRODUCT_PCT }), null);
  assert.equal(formatInstallLabourNote(null), null);
});

test("anything without a usable marker reads as absent", () => {
  for (const text of [
    null,
    undefined,
    "",
    "Property: villa, Area: 400sqm",
    "[labour-basis] basis=product_pct; install_labor=10.00; cable_material=0.00",
    "[labour-basis] basis=bottom_up_cable; cable_material=1.00",
    "[labour-basis] basis=bottom_up_cable; install_labor=oops; cable_material=1.00",
  ]) {
    assert.equal(parseInstallLabourNote(text), null, `should not parse: ${String(text)}`);
  }
});

test("the marker survives being appended to notes a human already wrote", () => {
  const note = "[labour-basis] basis=bottom_up_cable; install_labor=1.50; cable_material=2.25; model=synthetic-test";
  const combined = appendInstallLabourNote("Client asked for a 2-week programme.", note);

  assert.ok(combined.includes("2-week programme"));
  const parsed = parseInstallLabourNote(combined);
  assert.equal(parsed.install_labor, 1.5);
  assert.equal(parsed.cable_material, 2.25);
  assert.equal(parsed.commissioning, null);

  assert.equal(appendInstallLabourNote("", null), null);
  assert.equal(appendInstallLabourNote(null, note), note);
  assert.equal(appendInstallLabourNote("kept", null), "kept");
});

test("a model version cannot break the marker's own field separator", () => {
  const out = resolve({ request: bottomUpRequest({ config: syntheticConfig({ modelVersion: "v1; basis=product_pct" }) }) });
  const parsed = parseInstallLabourNote(
    formatInstallLabourNote({ ...out, commissioning: 1, project_management: 2 }),
  );
  assert.equal(parsed.install_labor_basis, INSTALL_LABOR_BASIS_BOTTOM_UP);
  assert.equal(parsed.model_version, "v1 basis=product_pct");
});
