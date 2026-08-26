import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SAM-38 removes card-side stage shortcuts and duplicate editors", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");
  const board = read("src/app/(dashboard)/leads/_components/LeadsKanbanBoard.tsx");

  for (const pattern of [
    /onQuickAdvance/,
    /nextStages\.slice/,
    /openStageEditor/,
    /Expandable Inline Editors/,
    /MoreHorizontal/,
    /Edit3/,
    /changeStage/,
    /changeProbability/,
    /changeStatus/,
    /changeLostReason/,
    /addQuickNote/,
    /updateNextAction/,
    /updateNextFollowup/,
  ]) {
    assert.doesNotMatch(card, pattern);
  }

  for (const pattern of [
    /changeStage=\{changeStage\}/,
    /changeProbability=/,
    /changeStatus=/,
    /changeLostReason=/,
    /addQuickNote=/,
    /updateNextAction=/,
    /updateNextFollowup=/,
  ]) {
    assert.doesNotMatch(board, pattern);
  }
});

test("SAM-38 renders reassignment outside clipped Kanban columns", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");

  assert.match(card, /title=\{t\("leads\.transfer"\)\}/);
  assert.match(card, /aria-label=\{t\("leads\.transfer"\)\}/);
  assert.match(card, /inline-flex h-8 w-8/);
  assert.match(card, /createPortal\(/);
  assert.match(card, /document\.body/);
  assert.match(card, /className="fixed z-\[1000\]/);
  assert.doesNotMatch(card, /absolute left-0 top-full/);
});

test("SAM-38 focuses either selected stage control on its Kanban column", () => {
  const board = read("src/app/(dashboard)/leads/_components/LeadsKanbanBoard.tsx");
  const page = read("src/app/(dashboard)/leads/page.tsx");

  assert.match(board, /data-kanban-stage=\{stage\.key\}/);
  assert.match(page, /const selectPipelineStage = useCallback/);
  assert.match(page, /scrollIntoView\(\{ behavior: "smooth", block: "nearest", inline: "center" \}\)/);
  assert.match(page, /onStageFilterChange=\{selectPipelineStage\}/);
  assert.match(page, /onStageChange=\{\(v\) => \{ selectPipelineStage\(v\); setAlertFilter\("all"\); \}\}/);
});

test("SAM-38 keeps horizontal scroll controls in a dedicated normal-flow rail", () => {
  const board = read("src/app/(dashboard)/leads/_components/LeadsKanbanBoard.tsx");

  assert.match(board, /data-kanban-scroll-controls/);
  assert.match(board, /flex h-9 items-center justify-between/);
  assert.doesNotMatch(board, /className="absolute (?:left|right)-6/);
  assert.doesNotMatch(board, /top-(?:3|1\/2)/);
});

test("SAM-38 keeps the bulk checkbox in normal flow beside the quotation", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");

  assert.match(card, /flex shrink-0 items-start gap-2/);
  assert.match(card, /type="checkbox" checked=\{selected\}/);
  assert.doesNotMatch(card, /absolute top-2 right-2/);
});

test("SAM-38 keeps the search clear button outside the input rectangle", () => {
  const filters = read("src/app/(dashboard)/leads/_components/LeadsFilters.tsx");

  assert.match(filters, /flex flex-1 min-w-\[180px\] max-w-xs items-center gap-1/);
  assert.match(filters, /inline-flex h-9 w-9 shrink-0/);
  assert.doesNotMatch(filters, /absolute right-2\.5 top-1\/2/);
});

test("SAM-38 renders exactly one prioritized action prompt per card", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");

  assert.match(card, /const actionPrompt = \(\(\) =>/);
  assert.match(card, /\{actionPrompt &&/);
  assert.equal((card.match(/data-testid="lead-card-action-prompt"/g) || []).length, 1);
  assert.match(card, /timeZone: "Asia\/Dubai"/);
  assert.match(card, /lead\.project_type/);
  assert.match(card, /lead\.project_status/);
  assert.doesNotMatch(card, /\{lead\.next_action && <span/);
  assert.doesNotMatch(card, /\{lead\.next_followup_date && \(/);
  assert.doesNotMatch(card, /\{lead\.followup_count != null &&/);
});

test("SAM-38 batches prompt fields in the existing leads list request", () => {
  const route = read("src/app/api/leads/list/route.ts");
  const hook = read("src/app/(dashboard)/leads/_hooks/useLeadsData.ts");

  assert.match(route, /property_type,project_type,project_status,property_size_sqm/);
  assert.match(hook, /project_type: string \| null; project_status: string \| null;/);
  assert.doesNotMatch(route, /lead_milestones|follow_up_logs|contracts/);
});


test("SAM-38 limits reassignment candidates to active sales-capable profiles", () => {
  const route = read("src/app/api/leads/list/route.ts");
  const policy = read("src/lib/lead-transfer-candidates.mjs");

  assert.match(route, /filterLeadTransferCandidateQuery\(/);
  assert.match(policy, /"sales",\s*"operator",\s*"boss"/);
  assert.match(policy, /\.eq\("is_active", true\)/);
  assert.doesNotMatch(policy, /"admin"/);
});
