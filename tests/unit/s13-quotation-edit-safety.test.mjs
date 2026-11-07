// S13 (NEXT-DB-BATCH item 1): the quotation detail page recalculated totals as
// "items + discount + tax" only, so editing an engine-generated quotation silently
// dropped its installation, commissioning and project-management fees
// (example: quantity 1 -> 2 saved 5,880 instead of 8,820). Quotations whose total
// contains service fees are now read-only on that page, and only drafts are editable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

// Engine shape: object keyed by device id; total includes services (not just items + tax).
const engineQuote = {
  status: "draft",
  devices_json: { "knx-ip-router": { name: "KNX IP Router", qty: 2, unit_price: 2800, line_total: 5600, unit: "pc" } },
  subtotal: 5600,
  discount_rate: 0,
  tax_rate: 5,
  total_amount: 8820, // 5600 + services 2800, + 5% tax
};

test("quotationLinesEditability: engine-generated quotations are read-only", async () => {
  const { quotationLinesEditability } = await import("../../src/lib/quotation-rules.mjs");
  assert.deepEqual(quotationLinesEditability(engineQuote), { editable: false, reason: "includes_services" });
});

test("quotationLinesEditability: array-shaped quotations whose total includes services are read-only", async () => {
  const { quotationLinesEditability } = await import("../../src/lib/quotation-rules.mjs");
  const calculator = {
    ...engineQuote,
    devices_json: [{ device_id: "a", name: "A", price: 2800, quantity: 2, unit: "pc", subtotal: 5600 }],
  };
  assert.equal(quotationLinesEditability(calculator).reason, "includes_services");
});

test("quotationLinesEditability: a plain draft whose total is items + discount + tax stays editable", async () => {
  const { quotationLinesEditability } = await import("../../src/lib/quotation-rules.mjs");
  const manual = {
    status: "draft",
    devices_json: [{ product_id: "p1", product_name: "Switch", description: "", quantity: 2, unit_price: 100, total_price: 200 }],
    subtotal: 200,
    discount_rate: 10,
    tax_rate: 5,
    total_amount: 189, // (200 - 20) * 1.05
  };
  assert.deepEqual(quotationLinesEditability(manual), { editable: true, reason: null });
  // missing tax rate means the page's 5% default, as the editor itself uses
  assert.equal(quotationLinesEditability({ ...manual, tax_rate: null }).editable, true);
  // no stored total yet: nothing to contradict
  assert.equal(quotationLinesEditability({ ...manual, total_amount: null }).editable, true);
});

test("quotationLinesEditability: only drafts are editable", async () => {
  const { quotationLinesEditability } = await import("../../src/lib/quotation-rules.mjs");
  const manual = {
    devices_json: [{ product_id: "p1", product_name: "Switch", quantity: 1, unit_price: 100, total_price: 100 }],
    subtotal: 100, discount_rate: 0, tax_rate: 5, total_amount: 105,
  };
  for (const status of ["sent", "accepted", "rejected", "expired"]) {
    assert.deepEqual(quotationLinesEditability({ ...manual, status }), { editable: false, reason: "not_draft" }, status);
  }
  assert.equal(quotationLinesEditability({ ...manual, status: "draft" }).editable, true);
});

test("the detail page only offers line editing when the quotation allows it", () => {
  const page = read("src/app/(dashboard)/quotations/[id]/page.tsx");
  assert.match(page, /quotationLinesEditability/);
  // decided from the raw stored row (the page replaces devices_json with a normalized array)
  assert.match(page, /quotationLinesEditability\(\{[\s\S]{0,200}devices_json: data\.devices_json/);
  // every mutation refuses to run on a locked quotation, not only the hidden buttons
  for (const fn of ["handleAddLineItem", "handleRemoveLineItem", "handleUpdateQuantity"]) {
    const body = page.slice(page.indexOf(`const ${fn} =`));
    assert.match(body.slice(0, 300), /!canEditLines/, `${fn} must check canEditLines first`);
  }
  // controls are rendered only when editable
  assert.match(page, /\{canEditLines && \(\s*<div className="flex gap-2">/, "add-item row hidden when locked");
  assert.match(page, /canEditLines \? \(\s*<>/, "quantity input and remove button hidden when locked");
  assert.match(page, /t\(`quotations\.linesLocked_\$\{shownLock\}`\)/);
});

test("the read-only notices exist in Chinese and English", async () => {
  const src = read("src/lib/i18n/translations.ts");
  for (const key of ["linesLocked_includes_services", "linesLocked_not_draft"]) {
    const hits = src.match(new RegExp(`${key}: "`, "g")) ?? [];
    assert.equal(hits.length, 2, `${key} must be in both languages`);
  }
  assert.match(src, /linesLocked_includes_services: "[^"]*\b(regenerate|Regenerate)[^"]*"/);
  assert.match(src, /linesLocked_includes_services: "[^"]*重新生成[^"]*"/);
});

test("quotationLinesEditability: a hand-typed total without line items is read-only with its own reason", async () => {
  const { quotationLinesEditability } = await import("../../src/lib/quotation-rules.mjs");
  const manualTotal = { status: "draft", devices_json: null, subtotal: 1000, discount_rate: 0, tax_rate: 5, total_amount: 1050 };
  assert.deepEqual(quotationLinesEditability(manualTotal), { editable: false, reason: "manual_total" });
  assert.equal(quotationLinesEditability({ ...manualTotal, devices_json: [] }).reason, "manual_total");
  // a brand-new empty draft (no total yet) can still get lines
  assert.equal(quotationLinesEditability({ ...manualTotal, devices_json: [], subtotal: 0, total_amount: 0 }).editable, true);
  assert.equal(quotationLinesEditability({ ...manualTotal, devices_json: null, total_amount: null }).editable, true);
});

test("an explicit 0% tax rate is a real rate, not 5%, and such a quotation stays editable", async () => {
  const { quotationLinesEditability } = await import("../../src/lib/quotation-rules.mjs");
  const zeroTax = {
    status: "draft",
    devices_json: [{ product_id: "p1", product_name: "Switch", quantity: 2, unit_price: 100, total_price: 200 }],
    subtotal: 200, discount_rate: 0, tax_rate: 0, total_amount: 200,
  };
  assert.deepEqual(quotationLinesEditability(zeroTax), { editable: true, reason: null });
  const page = read("src/app/(dashboard)/quotations/[id]/page.tsx");
  assert.doesNotMatch(page, /tax_rate \|\| 5/, "page must use ?? 5");
  assert.match(page, /tax_rate \?\? 5/);
  assert.doesNotMatch(read("src/lib/quotation-rules.mjs"), /tax_rate\) \|\| 5/);
});

test("the manual-total notice exists in both languages and does not say engine", () => {
  const src = read("src/lib/i18n/translations.ts");
  assert.equal((src.match(/linesLocked_manual_total: "/g) ?? []).length, 2);
  assert.match(src, /linesLocked_manual_total: "该报价为手填总价，不能逐行编辑，如需修改请重新生成或新建报价/);
  assert.match(src, /linesLocked_manual_total: "This quotation has a hand-typed total[^"]*"/);
  assert.doesNotMatch(src.match(/linesLocked_manual_total: "[^"]*"/)[0], /engine|引擎/);
});
