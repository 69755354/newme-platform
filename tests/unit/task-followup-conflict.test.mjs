import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  isTaskFollowupConflict,
  taskMutationMatchesReadback,
  taskFollowupConflictResponse,
  TASK_FOLLOWUP_CONFLICT_CODE,
  TASK_FOLLOWUP_CONFLICT_MESSAGE,
} from "../../src/lib/task-followup-conflict.ts";

const root = new URL("../../", import.meta.url);

test("task follow-up conflict matches only the exact live Postgres contract", () => {
  assert.equal(isTaskFollowupConflict({
    code: "P0001",
    message: "Next follow-up date is required",
  }), true);
  assert.equal(isTaskFollowupConflict({
    code: "P0001",
    message: "Another database rule failed",
  }), false);
  assert.equal(isTaskFollowupConflict({
    code: "23514",
    message: "Next follow-up date is required",
  }), false);
  assert.equal(isTaskFollowupConflict(null), false);
  assert.equal(TASK_FOLLOWUP_CONFLICT_CODE, "NEXT_FOLLOWUP_REQUIRED");
  assert.match(TASK_FOLLOWUP_CONFLICT_MESSAGE, /another pending follow-up task/i);

  assert.deepEqual(taskFollowupConflictResponse({
    code: "P0001",
    message: "Next follow-up date is required",
  }), {
    status: 409,
    body: {
      error: TASK_FOLLOWUP_CONFLICT_MESSAGE,
      code: TASK_FOLLOWUP_CONFLICT_CODE,
    },
  });
  assert.equal(taskFollowupConflictResponse({
    code: "P0001",
    message: "Another database rule failed",
  }), null);
});

test("task mutation readback requires exact fields and canonical completion semantics", () => {
  const completed = {
    status: "completed",
    title: "Call customer",
    description: null,
    priority: "high",
    assignee_id: "11111111-1111-4111-8111-111111111111",
    due_at: "2026-08-10T04:00:00.000Z",
    completed_at: "2026-08-09T04:00:00.000Z",
  };
  const expected = {
    status: "completed",
    title: "Call customer",
    description: null,
    priority: "high",
    assignee_id: "11111111-1111-4111-8111-111111111111",
    due_at: "2026-08-10T08:00:00+04:00",
  };

  assert.equal(taskMutationMatchesReadback(completed, expected), true);
  assert.equal(taskMutationMatchesReadback({ ...completed, status: "pending" }, expected), false);
  assert.equal(taskMutationMatchesReadback({ ...completed, completed_at: null }, expected), false);
  assert.equal(taskMutationMatchesReadback({ ...completed, priority: "low" }, expected), false);
  assert.equal(taskMutationMatchesReadback({ ...completed, due_at: "2026-08-10T05:00:00.000Z" }, expected), false);
  assert.equal(taskMutationMatchesReadback({
    ...completed,
    status: "cancelled",
    completed_at: null,
  }, { status: "cancelled" }), true);
  assert.equal(taskMutationMatchesReadback({
    ...completed,
    status: "cancelled",
  }, { status: "cancelled" }), false);
});

test("task mutation boundaries expose the conflict through the BFF and use production status values", async () => {
  const [detailRoute, tasksRoute, listPage, detailPage] = await Promise.all([
    readFile(new URL("src/app/api/tasks/[id]/route.ts", root), "utf8"),
    readFile(new URL("src/app/api/tasks/route.ts", root), "utf8"),
    readFile(new URL("src/app/(dashboard)/tasks/page.tsx", root), "utf8"),
    readFile(new URL("src/app/(dashboard)/tasks/[id]/page.tsx", root), "utf8"),
  ]);

  for (const route of [detailRoute, tasksRoute]) {
    assert.match(route, /const conflict = taskFollowupConflictResponse\(error\)/);
    assert.match(route, /respond\(conflict\.body, \{ status: conflict\.status \}\)/);
  }
  assert.match(detailPage, /fetch\(`\/api\/tasks\/\$\{taskId\}`,[\s\S]*method: "PATCH"/);
  assert.match(detailPage, /response\.status === 409 && payload\.code === TASK_FOLLOWUP_CONFLICT_CODE/);
  assert.match(detailPage, /fetch\("\/api\/tasks", \{[\s\S]*method: "POST"/);
  const createIndex = detailPage.indexOf('const createResponse = await fetch("/api/tasks"');
  const retryIndex = detailPage.indexOf("const retry = await patchTask(task.id, blockedMutation)");
  assert.ok(createIndex >= 0, "task detail must create the successor through the BFF");
  assert.ok(retryIndex > createIndex, "task detail must create the successor before retrying the blocked mutation");
  assert.equal(
    (detailPage.match(/taskMutationMatchesReadback\(/g) ?? []).length,
    3,
    "save, status change, and successor retry must all require an exact mutation readback",
  );
  assert.doesNotMatch(detailPage, /@\/app\/actions\/tasks/);
  assert.doesNotMatch(listPage, /"in_progress"|"done"/);
  assert.doesNotMatch(listPage, /assigned_to/);
  assert.match(listPage, /assignee_id/);
  assert.match(
    listPage,
    /if \(!dueAt \|\| status === "completed" \|\| status === "cancelled"\) return false;/,
    "completed and cancelled tasks must never render as overdue",
  );
  assert.match(
    tasksRoute,
    /const status: string = statusParam \?\? 'pending'/,
    "the task list API must default to the canonical pending status",
  );
  assert.doesNotMatch(detailPage, /value: "in_progress"|value: "done"/);
  assert.match(listPage, /"pending", "completed", "cancelled"/);
  assert.match(detailPage, /value: "completed"/);
});

test("successor creation is caller-scoped, replay-safe, and returns an exact pending readback", async () => {
  const route = await readFile(new URL("src/app/api/tasks/route.ts", root), "utf8");

  assert.match(route, /export async function POST\(request: Request\)/);
  assert.match(route, /body\.id[\s\S]*UUID_PATTERN\.test\(body\.id\)/);
  assert.match(route, /body\.lead_id[\s\S]*UUID_PATTERN\.test\(body\.lead_id\)/);
  assert.match(route, /\.from\('leads'\)[\s\S]*\.select\('id'\)[\s\S]*\.eq\('id', body\.lead_id\)[\s\S]*\.maybeSingle\(\)/);
  assert.match(route, /assignee_id: user\.id/);
  assert.match(route, /status: 'pending' as const/);
  assert.match(route, /source: 'follow_up' as const/);
  assert.match(route, /\.insert\(taskInput\)[\s\S]*\.select\(TASK_SELECT\)[\s\S]*\.single\(\)/);
  assert.match(route, /replayed: false \}, \{ status: 201 \}/);
  assert.match(route, /error\?\.code === '23505'/);
  assert.match(route, /existing\?\.status === 'pending'/);
  assert.match(route, /existing\.completed_at === null/);
  assert.match(route, /existing\.source === taskInput\.source/);
  assert.match(route, /typeof existing\.due_at === 'string'/);
  assert.match(route, /replayed: true/);
});

test("every task open/overdue consumer filters the canonical pending status", async () => {
  const entries = await Promise.all([
    ["workbench", "src/app/api/workbench/route.ts", 3],
    ["weekly review", "src/app/api/dashboard/weekly-review/route.ts", 2],
    ["dashboard summary", "src/app/api/dashboard/summary/route.ts", 4],
    ["command center", "src/app/api/command-center/route.ts", 1],
    ["daily reminder", "src/app/api/cron/daily-reminder/route.ts", 1],
    ["daily metrics", "src/app/api/metrics/daily/route.ts", 2],
    ["lead detail", "src/app/(dashboard)/leads/[id]/useLeadDetailData.ts", 1],
  ].map(async ([name, path, expected]) => [
    name,
    await readFile(new URL(path, root), "utf8"),
    expected,
  ]));

  for (const [name, source, expected] of entries) {
    assert.doesNotMatch(source, /\.neq\(["']status["'],\s*["']done["']\)/, `${name} must not use the legacy done status`);
    const pendingFilters = source.match(/\.from\(["']tasks["']\)[\s\S]{0,500}?\.eq\(["']status["'],\s*["']pending["']\)/g) ?? [];
    assert.equal(pendingFilters.length, expected, `${name} must bind every open-task query to pending`);
  }
});
