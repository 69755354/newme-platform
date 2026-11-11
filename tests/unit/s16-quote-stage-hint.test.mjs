// S16: a generated quotation that did not move the lead stage says why, in both languages.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { quoteStageHintKey, QUOTE_STAGE_HINT_REASONS } = await import("../../src/lib/quote-stage-hint.mjs");

/** The leadFlow.quoteStageHint blocks, one per language, read from the translation source. */
function hintBlocks() {
  const source = fs.readFileSync(path.join(root, "src/lib/i18n/translations.ts"), "utf8");
  const blocks = [...source.matchAll(/quoteStageHint:\s*\{([^}]*)\}/g)].map((match) => match[1]);
  return blocks.map((block) => new Map([...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]])));
}

test("a saved quotation whose stage did not move gets the reason's message key", () => {
  for (const reason of QUOTE_STAGE_HINT_REASONS) {
    assert.equal(quoteStageHintKey({ status: "ok", stage_advanced: false, lead_stage: "new", stage_advance_reason: reason }),
      `leadFlow.quoteStageHint.${reason}`);
  }
});

test("nothing is said when the stage moved, was already past quotation, or the reason is unknown", () => {
  assert.equal(quoteStageHintKey({ stage_advanced: true, stage_advance_reason: null }), null);
  assert.equal(quoteStageHintKey({ stage_advanced: false, stage_advance_reason: null }), null);
  assert.equal(quoteStageHintKey({ stage_advanced: false, stage_advance_reason: "something_new" }), null);
  assert.equal(quoteStageHintKey({}), null);
  assert.equal(quoteStageHintKey(null), null);
  assert.equal(quoteStageHintKey("x"), null);
});

test("every reason has a message in English and in Chinese, and nothing else is defined", () => {
  const blocks = hintBlocks();
  assert.equal(blocks.length, 2, "one English and one Chinese block");
  const [en, zh] = blocks;
  for (const block of blocks) {
    assert.deepEqual([...block.keys()].sort(), [...QUOTE_STAGE_HINT_REASONS].sort());
    for (const text of block.values()) assert.ok(text.length > 10);
  }
  for (const text of en.values()) assert.doesNotMatch(text, /[一-鿿]/, "English block has no Chinese");
  for (const text of zh.values()) assert.match(text, /[一-鿿]/, "Chinese block is Chinese");
});

test("the route's possible reasons are all covered by a message", () => {
  const route = fs.readFileSync(path.join(root, "src/app/api/quotations/generate/route.ts"), "utf8");
  const routeReasons = [...route.matchAll(/reason:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(routeReasons.length > 0);
  for (const reason of routeReasons) assert.ok(QUOTE_STAGE_HINT_REASONS.includes(reason), reason);
  const advance = fs.readFileSync(path.join(root, "src/lib/milestone-stage-advance.mjs"), "utf8");
  const advanceReasons = [...advance.matchAll(/(?:reason: |\? |: )"([a-z_]+)"/g)].map((m) => m[1])
    .filter((value) => /followup|gate|permitted|concurrently|failed/.test(value));
  for (const reason of advanceReasons) assert.ok(QUOTE_STAGE_HINT_REASONS.includes(reason), reason);
});
