import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("next task uses the canonical follow-up event type", async () => {
  const mutations = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");

  assert.match(mutations, /writeEvent\("followup_scheduled", description, updates\)/);
  assert.doesNotMatch(mutations, /writeEvent\("next_action_updated"/);
});

test("auditable timeline includes milestone notes", async () => {
  const page = await read("src/app/(dashboard)/leads/[id]/page.tsx");
  const timeline = await read("src/app/(dashboard)/leads/[id]/LeadTimeline.tsx");

  assert.match(page, /milestones={leadMilestones}/);
  assert.match(timeline, /milestones: LeadMilestone\[\]/);
  assert.match(timeline, /milestones\.map/);
  assert.match(timeline, /milestone\.notes/);
});

test("completed milestones expose their saved details and a reopen path", async () => {
  const process = await read("src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx");
  const mutations = await read("src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts");

  assert.match(process, /milestone\.notes/);
  assert.match(process, /milestone\.completed_at/);
  assert.match(process, /重开此阶段/);
  assert.match(process, /重开原因/);
  assert.match(process, /onReopenMilestone/);
  assert.match(mutations, /method: "PATCH"/);
  assert.match(mutations, /reason: normalizedReason/);
});

test("milestone reopen is owner-scoped for sales and global for management", async () => {
  const auth = await read("src/lib/lead-auth.ts");
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");

  assert.match(auth, /profile\.role === "operator"/);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /lead\.assigned_to !== profile\.userId/);
  assert.match(route, /Reopen reason is required/);
  assert.match(route, /action: "milestone_reopened"/);
  assert.match(route, /completed_at: null/);
});

test("a reopened milestone can be completed again in order", async () => {
  const route = await read("src/app/api/leads/[id]/milestone/route.ts");

  assert.match(route, /existingMilestone && !existingMilestone\.completed_at/);
  assert.match(route, /filter\(\(milestone\) => milestone\.completed_at\)/);
  assert.match(route, /action: "milestone_recompleted"/);
});
