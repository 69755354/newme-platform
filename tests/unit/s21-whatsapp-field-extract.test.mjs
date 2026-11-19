import assert from "node:assert/strict";
import test from "node:test";
import { extractLeadFields, buildFieldDraftNote } from "../../src/lib/whatsapp-field-extract.mjs";

// Every message below is invented.
const msg = (id, text, direction = "inbound") => ({ id, text, direction });
const field = (result, name) => result.fields.find((f) => f.field === name);

test("English: bedrooms, area, budget, property type, renovation and next step", () => {
  const r = extractLeadFields([
    msg("m1", "Hi, I own a 2 bedroom apartment in Dubai Marina, about 1,200 sqft."),
    msg("m2", "Budget is around AED 150,000. The flat is under renovation right now."),
    msg("m3", "Can you call me tomorrow?"),
  ]);
  assert.equal(field(r, "rooms").value, 2);
  assert.equal(field(r, "rooms").source_message_id, "m1");
  assert.equal(field(r, "property_type").value, "apartment");
  assert.equal(field(r, "area_sqm").value, 111.5);
  assert.equal(field(r, "budget_aed").value, 150000);
  assert.equal(field(r, "budget_aed").source_message_id, "m2");
  assert.equal(field(r, "renovation").value, "in_progress");
  assert.equal(field(r, "next_step").value, "call");
  for (const f of r.fields) assert.ok(f.confidence >= 0.5 && f.confidence <= 1, f.field);
});

test("English shorthand: 3BR villa, 250 sqm, 1.2M, 85k", () => {
  const r = extractLeadFields([msg("a", "3BR villa 250 sqm, budget 1.2M AED")]);
  assert.equal(field(r, "rooms").value, 3);
  assert.equal(field(r, "property_type").value, "villa");
  assert.equal(field(r, "area_sqm").value, 250);
  assert.equal(field(r, "budget_aed").value, 1_200_000);
  const k = extractLeadFields([msg("b", "my budget: 85k")]);
  assert.equal(field(k, "budget_aed").value, 85000);
});

test("studio counts as zero bedrooms", () => {
  const r = extractLeadFields([msg("s", "I have a studio in JLT")]);
  assert.equal(field(r, "rooms").value, 0);
  assert.equal(field(r, "property_type").value, "apartment");
});

test("Chinese: 户型, 面积, 预算, 装修中, 下一步", () => {
  const r = extractLeadFields([
    msg("c1", "你好，我有一套三室两厅的公寓，面积 120 平米"),
    msg("c2", "预算大概 20万 迪拉姆，现在正在装修中"),
    msg("c3", "想先看看方案，明天可以上门量尺吗"),
  ]);
  assert.equal(field(r, "rooms").value, 3);
  assert.equal(field(r, "property_type").value, "apartment");
  assert.equal(field(r, "area_sqm").value, 120);
  assert.equal(field(r, "budget_aed").value, 200000);
  assert.equal(field(r, "renovation").value, "in_progress");
  assert.equal(field(r, "next_step").value, "visit");
});

test("Arabic-Indic digits are read", () => {
  const r = extractLeadFields([msg("d", "غرفتين نوم، المساحة ١٢٠ متر، الميزانية ١٥٠٠٠٠ درهم")]);
  assert.equal(field(r, "area_sqm").value, 120);
  assert.equal(field(r, "budget_aed").value, 150000);
});

test("only customer messages are read; our own text is never a source", () => {
  const r = extractLeadFields([msg("o1", "Our 3 bedroom villa package starts at AED 90,000", "outbound"), msg("i1", "ok thanks")]);
  assert.equal(r.fields.length, 0);
});

test("a later customer message wins when the same field is stated twice", () => {
  const r = extractLeadFields([msg("1", "budget 100k"), msg("2", "sorry, budget is actually 180k")]);
  assert.equal(field(r, "budget_aed").value, 180000);
  assert.equal(field(r, "budget_aed").source_message_id, "2");
});

test("numbers that are not a budget, area or room count are ignored", () => {
  const r = extractLeadFields([msg("x", "My number is 0501234567, I called at 3 pm, reference 4455 2026")]);
  assert.equal(r.fields.length, 0);
});

test("keyword without a unit has lower confidence than keyword with a unit", () => {
  const a = extractLeadFields([msg("a", "2 bedroom, 100 sqm")]);
  const b = extractLeadFields([msg("b", "area 100")]);
  assert.ok(field(a, "area_sqm").confidence >= 0.9);
  assert.ok(field(b, "area_sqm").confidence < 0.9);
});

test("the draft note lists each suggestion with its source message and says it needs confirmation", () => {
  const r = extractLeadFields([msg("m1", "2 bedroom apartment, budget AED 150,000")]);
  const note = buildFieldDraftNote(r);
  assert.match(note, /^\[Draft/);
  assert.match(note, /m1/);
  assert.match(note, /150,000/);
  assert.match(note, /草稿/);
  assert.equal(buildFieldDraftNote({ fields: [] }), null);
});

test("empty, non-string and oversized input is safe", () => {
  assert.deepEqual(extractLeadFields([]).fields, []);
  assert.deepEqual(extractLeadFields([{ id: "1", text: null, direction: "inbound" }, null]).fields, []);
  assert.doesNotThrow(() => extractLeadFields([msg("big", "9".repeat(100_000))]));
});
