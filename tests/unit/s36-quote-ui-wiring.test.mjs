// S36 F01 / F10 / B10 wiring in the screens: every quotation made in the browser goes through the server route, the quick
// "amount only" quotation is reachable at any time, the fake "send to customer" button is gone, the calculator stays open
// after saving, and a lead cannot be marked won in the UI without an amount.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const calculator = read("src/app/(dashboard)/quotes/quote-calculator.tsx");
const wizard = read("src/app/(dashboard)/quotes/quote-wizard.tsx");
const client = read("src/app/(dashboard)/quotes/quotes-client.tsx");
const quick = read("src/app/(dashboard)/quotes/quick-quote-dialog.tsx");
const leadPage = read("src/app/(dashboard)/leads/[id]/page.tsx");
const process_ = read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
const mutations = read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
const drag = read("src/shared/hooks/usePipelineDragDrop.ts");

test("no quote screen writes the quotations table itself; all save through the server route", () => {
  for (const [name, source] of [["calculator", calculator], ["wizard", wizard], ["quotes page", client], ["quick quote", quick]]) {
    assert.doesNotMatch(source, /from\("quotations"\)\s*\.insert/, `${name} must not insert into quotations`);
  }
  for (const [name, source] of [["calculator", calculator], ["wizard", wizard], ["quotes page", client], ["quick quote", quick]]) {
    assert.match(source, /saveQuoteViaServer\(/, name);
  }
  assert.match(read("src/lib/quote-save-client.ts"), /\/api\/quotations\/generate/);
});

test("the calculator keeps the dialog open after saving and the fake 'send to customer' button is gone", () => {
  const save = calculator.slice(calculator.indexOf("const handleSave"), calculator.indexOf("const handleExport"));
  assert.doesNotMatch(save, /onOpenChange\(false\)/, "saving must not close the dialog before Export Excel can be used");
  assert.match(save, /setSavedQuoteId\(saved\.quoteId\)/);
  assert.doesNotMatch(calculator, /quotes\.calc\.quoteSaved/, "no 'saved' toast pretending to be a send");
  assert.doesNotMatch(calculator, /sendToClient/);
  assert.match(calculator, /buildWhatsAppUrl\(/, "the honest option: open WhatsApp with the text typed");
  assert.match(calculator, /clipboard\.writeText\(text\)/, "or copy the text when the lead has no usable phone");
});

test("the amount-only quotation is reachable at any time from the quotes page and the lead page", () => {
  const header = client.slice(client.indexOf("{/* ─── Header ─── */}"), client.indexOf("{/* ─── Filters ─── */}"));
  assert.match(header, /onClick=\{openCreateDialog\}/, "header button, not only the empty-list state");
  assert.match(leadPage, /<QuickQuoteDialog/);
  assert.match(process_, /onClick=\{onOpenQuickQuote\}/);
  assert.match(quick, /manual: \{ subtotal: value/);
});

test("marking a lead won in the UI asks for an amount when there is none, and sends it", () => {
  assert.match(process_, /id="won-amount"/);
  assert.match(process_, /onWon\(stageNote, wonAmount\)/);
  assert.match(mutations, /amount: amount\.trim\(\)/);
  // Dragging onto Won goes through the same server route (the dialog asks for the note and, when missing, the amount).
  assert.match(drag, /if \(targetStage === "won"\) \{\s*setWonPrompt\(/);
  assert.match(drag, /submitWonFromDrag\(fetch, leadId/);
  assert.match(read("src/lib/won-drag.mjs"), /\/api\/leads\/\$\{encodeURIComponent\(leadId\)\}\/stage/);
  const dropBody = drag.slice(drag.indexOf("const onDrop"), drag.indexOf("const confirmWon"));
  const beforeWon = dropBody.slice(0, dropBody.indexOf('if (targetStage === "won")'));
  const afterWon = dropBody.slice(dropBody.indexOf('if (targetStage === "won")'));
  assert.doesNotMatch(beforeWon, /final_status: targetStage|\.update\(/, "no direct write before the Won branch returns");
  assert.match(afterWon.slice(0, afterWon.indexOf("return;")), /needsAmount: !leadHasWonAmount\(lead\)/);
  assert.doesNotMatch(drag, /Dragging cannot ask/);
  for (const page of ["src/app/(dashboard)/leads/page.tsx", "src/app/(dashboard)/pipeline/page.tsx"]) {
    assert.match(read(page), /<WonDropDialog prompt=\{wonPrompt\}/, page);
  }
});
