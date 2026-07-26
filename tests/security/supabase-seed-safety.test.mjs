import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seedSql = fs.readFileSync(path.join(repoRoot, "supabase/seed.sql"), "utf8");
const executableSql = seedSql
  .split(/\r?\n/)
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

test("Supabase seed cannot rewrite or delete existing data", () => {
  assert.doesNotMatch(
    executableSql,
    /\b(?:UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i,
    "supabase/seed.sql must only add deterministic synthetic fixtures",
  );
});
