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

test("gate stops browser reachability at a use server boundary", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { createTask } from "@/app/actions/tasks";
void createTask;
`,
    "src/app/actions/tasks.ts": `"use server";
import { createTaskRecord } from "@/lib/task-records";
export async function createTask() {
  return createTaskRecord();
}
`,
    "src/lib/task-records.ts": `export function createTaskRecord() {
  return supabase.from("tasks").insert({ title: "server mutation" });
}
`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("gate stops browser reachability at an explicit server-only module", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { createTask } from "@/lib/tasks";
void createTask;
`,
    "src/lib/tasks.ts": `import { createTaskRecord } from "@/lib/task-records";
export function createTask() {
  return createTaskRecord();
}
`,
    "src/lib/task-records.ts": `import "server-only";
export function createTaskRecord() {
  return supabase.from("tasks").insert({ title: "server mutation" });
}
`,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("gate does not treat an inline use server directive as a module boundary", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { unsafeTask } from "@/lib/tasks";
void unsafeTask;
`,
    "src/lib/tasks.ts": `export async function serverAction() {
  "use server";
}
export function unsafeTask() {
  return supabase.from("tasks").insert({ title: "client-reachable mutation" });
}
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /client-side-supabase-mutation/);
});

test("gate does not treat a commented server-only import as a boundary", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
import { unsafeTask } from "@/lib/tasks";
void unsafeTask;
`,
    "src/lib/tasks.ts": `/*
import "server-only";
*/
export function unsafeTask() {
  return supabase.from("tasks").insert({ title: "client-reachable mutation" });
}
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /client-side-supabase-mutation/);
});

test("gate does not allow conflicting client and server module directives", () => {
  const result = runFixture({
    "src/components/Example.tsx": `"use client";
"use server";
export function unsafeTask() {
  return supabase.from("tasks").insert({ title: "client mutation" });
}
`,
  });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /client-side-supabase-mutation/);
});
