import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gateSource = path.join(repoRoot, "scripts/check-supabase-boundaries.mjs");

function runFixture(files, maxFindings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "supabase-boundary-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(gateSource, path.join(root, "scripts/check-supabase-boundaries.mjs"));
  fs.writeFileSync(
    path.join(root, "scripts/supabase-boundary-allowlist.json"),
    JSON.stringify({ max_findings: maxFindings }),
  );
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const result = spawnSync(process.execPath, ["scripts/check-supabase-boundaries.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}

test("gate rejects a multiline client Supabase chain", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
const result = supabase
  .from("leads")
  .insert({ name: "new" })
  .select("id");
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /client-side-supabase-mutation/);
});

test("gate rejects expansion beyond a rule/file baseline count", () => {
  const file = "src/components/Example.tsx";
  const key = `client-side-supabase-mutation:${file}`;
  const result = runFixture({
    [file]: `"use client";
supabase.from("leads").insert({ name: "one" });
supabase.from("leads").insert({ name: "two" });
`,
  }, { [key]: 1 });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /count=2 baseline=1/);
});

test("gate follows client imports into shared libraries", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { createTask } from "@/lib/tasks";
void createTask;
`,
    "src/lib/tasks.ts": `export function createTask() {
  return supabase
    .from("tasks")
    .insert({ title: "hidden mutation" });
}
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /src\/lib\/tasks.ts/);
});

test("gate stops at a top-level use-server action boundary", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { runTask } from "@/app/actions";
void runTask;
`,
    "src/app/actions.ts": `"use server";
import { readTask } from "@/lib/task-dal";
export async function runTask() { return readTask(); }
`,
    "src/lib/task-dal.ts": `import "server-only";
export function readTask() { return supabase.from("tasks").select("id"); }
`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("gate rejects a direct runtime import of a server-only module", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { readTask } from "@/lib/task-dal";
void readTask;
`,
    "src/lib/task-dal.ts": `import "server-only";
export function readTask() { return supabase.from("tasks").select("id"); }
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /server-only-module-imported-by-browser/);
});

test("gate ignores erased type-only imports of server-only modules", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import type { TaskRow } from "@/lib/task-dal";
const row: TaskRow | null = null;
void row;
`,
    "src/lib/task-dal.ts": `import "server-only";
export type TaskRow = { id: string };
export function readTask() { return supabase.from("tasks").select("id"); }
`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("gate follows dynamic imports into shared libraries", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
void import("@/lib/tasks");
`,
    "src/lib/tasks.ts": `export function createTask() {
  return supabase.from("tasks").insert({ title: "dynamic mutation" });
}
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /client-side-supabase-mutation/);
});

test("gate still follows mixed type-and-runtime named imports", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { type TaskRow, createTask } from "@/lib/tasks";
void (null as TaskRow | null);
void createTask;
`,
    "src/lib/tasks.ts": `export type TaskRow = { id: string };
export function createTask() {
  return supabase.from("tasks").insert({ title: "mixed import" });
}
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /client-side-supabase-mutation/);
});
