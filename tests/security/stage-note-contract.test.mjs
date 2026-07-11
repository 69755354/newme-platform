import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("stage API validates and records optional stage context", async () => {
  const source = await read("src/app/api/leads/[id]/stage/route.ts");
  assert.ok(source.includes('const note = String(body?.note ?? "").trim()'));
  assert.ok(source.includes("note.length > 1000"));
  assert.ok(source.includes("Stage note must be 1000 characters or fewer"));
  assert.ok(source.includes("event_data: { from: lead.stage, to: stage, ...(note ? { note } : {}) }"));
});

test("sales process sends the same note for normal, won, and lost transitions", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  assert.ok(source.includes("Stage note (optional)"));
  assert.ok(source.includes("maxLength={1000}"));
  assert.ok(source.includes("onStageChange(s, stageNote)"));
  assert.ok(source.includes("onWon(stageNote)"));
  assert.ok(source.includes("onLost(stageNote)"));
  assert.ok(source.includes('if (changed) setStageNote("")'));
});

test("stage mutation forwards notes without bypassing the owned stage endpoint", async () => {
  const source = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");
  assert.ok(source.includes('updateStage = useCallback(async (stage: string, note = "")'));
  assert.ok(source.includes("JSON.stringify({ stage, note: note.trim() })"));
  assert.equal(source.includes('.from("leads").update({ stage'), false);
});
