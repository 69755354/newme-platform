// Quotation discount bounds and line-item shapes (review 2026-11-03, 4b #3, 4c #9-11).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  clampDiscountRate,
  discountRateError,
  lineItemsSubtotal,
  normalizeQuotationLineItems,
} from "../../src/lib/quotation-rules.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

// The three shapes as they are actually stored, with catalogue prices.
// Calculator / wizard save (the shape of NM-2026-0056, which the detail page refused).
const CALCULATOR_ROWS = [
  { device_id: "knx_ip_router", name: "KNX IP Router", price: 2800, quantity: 1, unit: "pcs", subtotal: 2800 },
  { device_id: "switch_actuator_12", name: "Switch Actuator 12-fold", price: 1900, quantity: 3, unit: "pcs", subtotal: 5700 },
  { device_id: "bus_cable", name: "Bus Cable (per meter)", price: 8, quantity: 150, unit: "m", subtotal: 1200 },
];
// POST /api/quotations/generate (quotation-engine.ts devices_json).
const ENGINE_ROWS = {
  knx_ip_router: { name: "KNX IP Router", qty: 1, unit_price: 2800, line_total: 2800, unit: "pcs" },
  switch_actuator_12: { name: "Switch Actuator 12-fold", qty: 3, unit_price: 1900, line_total: 5700, unit: "pcs" },
  bus_cable: { name: "Bus Cable (per meter)", qty: 150, unit_price: 8, line_total: 1200, unit: "m" },
};
// /quotations/[id] "add product".
const DETAIL_ROWS = [
  { product_id: "knx_ip_router", product_name: "KNX IP Router", description: "", quantity: 1, unit_price: 2800, total_price: 2800 },
  { product_id: "switch_actuator_12", product_name: "Switch Actuator 12-fold", description: "12 ch", quantity: 3, unit_price: 1900, total_price: 5700 },
  { product_id: "bus_cable", product_name: "Bus Cable (per meter)", description: "", quantity: 150, unit_price: 8, total_price: 1200 },
];

test("all three stored shapes normalize to the same rows", () => {
  const expected = [
    ["knx_ip_router", "KNX IP Router", 1, 2800, 2800],
    ["switch_actuator_12", "Switch Actuator 12-fold", 3, 1900, 5700],
    ["bus_cable", "Bus Cable (per meter)", 150, 8, 1200],
  ];
  for (const stored of [CALCULATOR_ROWS, ENGINE_ROWS, DETAIL_ROWS]) {
    const items = normalizeQuotationLineItems(stored);
    assert.deepEqual(
      items.map((item) => [item.id, item.name, item.quantity, item.unit_price, item.line_total]),
      expected,
    );
    assert.equal(lineItemsSubtotal(items), 9700);
  }
});

test("calculator rows survive a JSON round trip and numeric strings", () => {
  const roundTripped = JSON.parse(JSON.stringify(CALCULATOR_ROWS));
  roundTripped[0].price = "2800";
  const items = normalizeQuotationLineItems(roundTripped);
  assert.equal(items[0].unit_price, 2800);
  assert.equal(items[0].quantity, 1);
});

test("empty and unreadable values", () => {
  assert.deepEqual(normalizeQuotationLineItems(null), []);
  assert.deepEqual(normalizeQuotationLineItems(undefined), []);
  assert.deepEqual(normalizeQuotationLineItems({}), []);
  assert.throws(() => normalizeQuotationLineItems("x"), /JSON array or object/);
  assert.throws(() => normalizeQuotationLineItems([{ name: "no qty" }]), /index 0/);
  assert.throws(() => normalizeQuotationLineItems([null]), /index 0/);
});

test("discount: server refuses out-of-range values, forms clamp them", () => {
  assert.equal(discountRateError(undefined), null);
  assert.equal(discountRateError(0), null);
  assert.equal(discountRateError(5), null);
  assert.equal(discountRateError(100), null);
  assert.match(discountRateError(150), /between 0 and 100/);
  assert.match(discountRateError(-10), /between 0 and 100/);
  assert.match(discountRateError("5"), /number/);
  assert.match(discountRateError(Number.NaN), /number/);

  assert.equal(clampDiscountRate(150, 20), 20);
  assert.equal(clampDiscountRate(-10, 20), 0);
  assert.equal(clampDiscountRate("7.5", 20), 7.5);
  assert.equal(clampDiscountRate("", 20), 0);
  assert.equal(clampDiscountRate(150), 100);
});

test("every line-item reader uses the shared normalizer", () => {
  for (const file of [
    "src/app/(dashboard)/quotations/[id]/page.tsx",
    "src/app/(dashboard)/quotes/quote-detail-dialog.tsx",
    "src/app/api/quotations/export/route.ts",
  ]) {
    assert.match(read(file), /normalizeQuotationLineItems\(/, file);
  }
  // The old strict parser is what refused calculator quotes.
  assert.doesNotMatch(read("src/app/(dashboard)/quotations/[id]/page.tsx"), /typeof item\.product_id !== "string"/);
});

test("every discount input and writer is bounded", () => {
  for (const file of [
    "src/app/(dashboard)/quotes/quote-calculator.tsx",
    "src/app/(dashboard)/quotes/quote-wizard.tsx",
    "src/app/(dashboard)/quotes/quotes-client.tsx",
  ]) {
    assert.match(read(file), /clampDiscountRate\(/, file);
  }
  for (const file of ["src/app/api/quotations/generate/route.ts", "src/app/api/quotations/calculate/route.ts"]) {
    assert.match(read(file), /discountRateError\(/, file);
  }
});

test("calculator and wizard export links use the parameter the export route reads", () => {
  const route = read("src/app/api/quotations/export/route.ts");
  for (const file of ["src/app/(dashboard)/quotes/quote-calculator.tsx", "src/app/(dashboard)/quotes/quote-wizard.tsx"]) {
    const source = read(file);
    const param = source.match(/\/api\/quotations\/export\?([a-z_]+)=/)?.[1];
    assert.ok(param, file);
    assert.match(route, new RegExp(`searchParams\\.get\\("${param}"\\)`), `${file} sends ?${param}=`);
  }
});

test("quote notes do not repeat the percentage the label already carries", () => {
  for (const file of ["src/app/(dashboard)/quotes/quote-calculator.tsx", "src/app/(dashboard)/quotes/quote-wizard.tsx"]) {
    assert.doesNotMatch(read(file), /installLabor"\)\} \(30%\)/, file);
  }
});

test("the pricing engine never prices a negative total, whatever the discount", async () => {
  // quotation-engine.ts imports the .mjs rules; the source check keeps this test
  // free of a TypeScript loader.
  assert.match(read("src/lib/quotation-engine.ts"), /clampDiscountRate\(input\.discount_rate/);
});

test("quote status changes report real failures and keep the dialog in step", () => {
  const client = read("src/app/(dashboard)/quotes/quotes-client.tsx");
  const dialog = read("src/app/(dashboard)/quotes/quote-detail-dialog.tsx");
  // The handler answers whether the write stuck, and checks rows, not only error.
  assert.match(client, /handleStatusChange = async \(id: string, newStatus: string\): Promise<boolean>/);
  assert.match(client, /updatedRows\.length === 0/);
  assert.match(client, /const \{ error: milestoneErr \}/);
  assert.match(client, /deletedRows\.length === 0/);
  // The dialog shows success and the badge only after a stored change.
  assert.match(dialog, /const stored = await onStatusChange\(/);
  assert.match(dialog, /if \(!stored\) return;/);
  assert.match(dialog, /const shownStatus = activeStatus \|\| quote\.status/);
  assert.doesNotMatch(dialog, /\{quote\.status === "accepted" && !quote\.contract_id/);
});

test("quotation detail edits roll back on failure and check the rows written", () => {
  const source = read("src/app/(dashboard)/quotations/[id]/page.tsx");
  assert.equal((source.match(/updatedRows\.length === 0/g) ?? []).length, 4);
  assert.equal((source.match(/setLineItems\(previousItems\)/g) ?? []).length, 3);
  assert.doesNotMatch(source, /quotation\.discount_rate \|\| 0;/);
});

test("won and lost controls disappear once a lead is closed, and the note label matches the rule", () => {
  const source = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /const isClosed =/);
  assert.match(source, /isClosed \? \(/);
  assert.doesNotMatch(source, /Stage note \(optional\)/);
  assert.match(source, /Stage note \(required\)/);
  assert.match(source, /!stageNote\.trim\(\)/);
});

test("the create-contract buttons only render for roles that can open /contracts/new", () => {
  const source = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.match(source, /canCreateContract = false/);
  assert.match(source, /canCreateContract \? <Button/);
  assert.match(source, /!hasContract && canCreateContract/);
  assert.match(
    read("src/app/(dashboard)/leads/[id]/page.tsx"),
    /canCreateContract=\{salesRole === "admin" \|\| salesRole === "boss"\}/,
  );
});
