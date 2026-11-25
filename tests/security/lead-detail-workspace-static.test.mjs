import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("milestone UI requires a real note instead of a generated template", async () => {
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  const mutations = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");

  // S39: the progress note and the quality rating are optional; one contact record is still required
  assert.ok(process.includes("推进备注（选填）"));
  assert.equal(process.includes("请填写推进备注后再完成此阶段"), false);
  assert.ok(process.includes("请先添加 1 条完整联系记录"));
  assert.equal(process.includes("请先选择线索质量，再完成初次接触"), false);
  assert.ok(mutations.includes("const normalizedNotes = notes.trim()"));
  assert.ok(mutations.includes("notes: normalizedNotes"));
  assert.equal(mutations.includes("手动完成里程碑:"), false);
});

test("Guided Deal Canvas keeps one milestone completion path instead of direct stage jumps", async () => {
  const page = await read("src/app/(dashboard)/leads/[id]/page.tsx");
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");

  assert.ok(page.includes("Deal workspace · next action"));
  assert.ok(page.includes("Auditable timeline"));
  assert.ok(process.includes('t("s41.stageNote.hint")')); // S41: stages advance from logged contacts/quotes; no "unlock in sequence"
  assert.equal(process.includes("onStageChange={"), false);
});

test("contact deletion is owner-authorized, exact, and excludes audit notes", async () => {
  const timeline = await read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");
  const route = await read("src/app/api/leads/[id]/contacts/[contactId]/route.ts");

  assert.ok(timeline.includes('method: "DELETE"'));
  assert.ok(timeline.includes("await onContactUpdated()"));
  for (const token of [
    "export async function DELETE",
    "getRequestAuthContext",
    "applyRequestAuthCookies",
    'lead.assigned_to !== context.user.id',
    '.eq("id", contactId)',
    '.eq("lead_id", leadId)',
    '["note", "import_note"]',
  ]) assert.ok(route.includes(token), `missing deletion protection: ${token}`);
});

test("quality selection never fails silently", async () => {
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");

  assert.ok(process.includes("const [qualitySaveError, setQualitySaveError]"));
  assert.ok(process.includes("setQualitySaveError"));
  assert.ok(process.includes("qualitySaveError &&"));
});

test("locked milestones explain the immediate prerequisite", async () => {
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");

  assert.ok(process.includes("previousMilestoneKey"));
  assert.ok(process.includes("Complete ${t(`leadDetail.milestone_${previousMilestoneKey}`)} to unlock"));
});
