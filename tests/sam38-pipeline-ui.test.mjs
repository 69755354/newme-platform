import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SAM-38 keeps the reassignment trigger and menu in one anchored container", () => {
  const source = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");
  assert.match(source, /min-h-7 px-2 rounded-md bg-blue-500\/10/);
  assert.match(source, /<div className="relative shrink-0" ref=\{reassignRef\}>/);
  assert.match(source, /absolute left-0 top-full mt-1 z-50 w-56/);
});

test("SAM-38 focuses the selected Kanban column", () => {
  const board = read("src/app/(dashboard)/leads/_components/LeadsKanbanBoard.tsx");
  const page = read("src/app/(dashboard)/leads/page.tsx");
  assert.match(board, /data-kanban-stage=\{stage\.key\}/);
  assert.match(page, /const selectPipelineStage = useCallback/);
  assert.match(page, /scrollIntoView\(\{ behavior: "smooth", block: "nearest", inline: "center" \}\)/);
  assert.match(page, /onStageFilterChange=\{selectPipelineStage\}/);
});
