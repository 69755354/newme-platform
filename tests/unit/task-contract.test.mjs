import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);

test("task detail fields are persisted through the typed contract", async () => {
  const [migration, database, action, page, route] = await Promise.all([
    readFile(new URL("supabase/migrations/20260723090000_add_task_detail_fields.sql", root), "utf8"),
    readFile(new URL("src/types/database.ts", root), "utf8"),
    readFile(new URL("src/app/actions/tasks.ts", root), "utf8"),
    readFile(new URL("src/app/(dashboard)/tasks/[id]/page.tsx", root), "utf8"),
    readFile(new URL("src/app/api/tasks/[id]/route.ts", root), "utf8"),
  ]);

  assert.match(migration, /ADD COLUMN IF NOT EXISTS description text/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS priority text/);
  assert.match(database, /tasks:[\s\S]*description: string \| null[\s\S]*priority: string \| null/);
  assert.match(action, /description: updates\.description/);
  assert.match(action, /priority: updates\.priority/);
  assert.match(page, /description: editDescription\.trim\(\) \|\| null/);
  assert.match(page, /assignee_id: editAssignedTo \|\| null/);
  assert.match(page, /Due date is required/);
  assert.match(route, /updateData\.description = body\.description/);
  assert.match(route, /updateData\.priority = body\.priority/);
});

test("tasks due_at remains required by the generated production contract", async () => {
  const database = await readFile(new URL("src/types/database.ts", root), "utf8");
  const tasksSection = database.slice(database.indexOf("      tasks: {"), database.indexOf("      transfer_history:"));
  assert.match(tasksSection, /due_at: string\n/);
  assert.doesNotMatch(tasksSection, /due_at: string \| null/);
});
