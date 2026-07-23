import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read = (file) => fs.readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("only admin and boss can manage users through UI, API, and Server Action", async () => {
  const [api, action, page] = await Promise.all([
    read("src/app/api/users/route.ts"),
    read("src/app/actions/team.ts"),
    read("src/app/(dashboard)/team/page.tsx"),
  ]);

  assert.match(api, /profile\.role !== "admin" && profile\.role !== "boss"/);
  assert.doesNotMatch(api, /profile\.role !== "sales"/);
  assert.match(action, /\['admin', 'boss'\]\.includes\(profile\.role\)/);
  assert.doesNotMatch(action, /\['admin', 'boss', 'sales'\]/);
  assert.match(page, /useRequireRole\(\["admin", "boss"\]\)/);
});
