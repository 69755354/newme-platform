import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("task due-date constraint remains valid when wall-clock time advances", async () => {
  const [migration, databaseFixture, cleanupFixture, taskSource, gate] = await Promise.all([
    read("supabase/migrations/20260801184548_replace_time_relative_tasks_constraint.sql"),
    read("tests/database/tasks-restorable-due-constraint.sql"),
    read("tests/database/tasks-restorable-due-cleanup.sql"),
    read("src/lib/tasks.ts"),
    read("scripts/run-sam23-database-gate.mjs"),
  ]);

  assert.match(
    migration,
    /CHECK \(due_at > created_at - interval '1 day'\)/,
  );
  assert.doesNotMatch(migration, /CHECK[\s\S]{0,120}\bnow\s*\(/i);
  assert.match(migration, /VALIDATE CONSTRAINT tasks_future_only/);
  assert.match(databaseFixture, /creation-time due-date violation accepted/);
  assert.match(databaseFixture, /tasks due-date constraint is not stable/);
  assert.match(cleanupFixture, /restorable task fixture cleanup failed/);
  assert.match(taskSource, /created_at-based 24h creation grace/);
  assert.match(gate, /tasks-restorable-due-constraint\.sql/);
  assert.match(gate, /task_backup_restore/);
  assert.match(gate, /task_backup_fixture_cleanup/);
  assert.match(gate, /"--clean",\s*"--if-exists"/);
});
