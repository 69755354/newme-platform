import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const routeUrl = new URL(
  "../../src/app/api/dashboard/weekly-review/route.ts",
  import.meta.url,
);

test("weekly review derives the sales roster from profile roles", async () => {
  const source = await readFile(routeUrl, "utf8");
  assert.ok(source.includes('const SALES_ROLES = new Set(["user", "sales", "salesperson", "boss"])'));
  assert.ok(source.includes("for (const uid of salesMap.keys()) ensure(uid)"));
  for (const legacyId of [
    "3666d8d0-baf4-45cb-8e7f-4243c999b2b1",
    "28ec618c-1210-4d5d-9c51-702b333e5760",
    "5c766c35-fda0-4077-a7b0-478b0bbb85b4",
  ]) {
    assert.equal(source.includes(legacyId), false, `hard-coded profile remains: ${legacyId}`);
  }
});

test("stage metrics and drill-downs are attributed to the lead owner", async () => {
  const source = await readFile(routeUrl, "utf8");
  for (const token of [
    "stageOwnerByLead",
    'select("id, assigned_to").in("id", stageLeadIds)',
    "const owner = stageOwnerByLead.get",
    "const row = ensure(owner)",
    "if (!lead || !owner || !isSalesUser(owner)) continue",
    "l3_by_user[owner]",
  ]) {
    assert.ok(source.includes(token), `missing owner attribution evidence: ${token}`);
  }
  assert.equal(source.includes("const row = ensure(actor)"), false);
});
