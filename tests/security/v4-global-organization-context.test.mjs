import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [switcher, layout, contextRoute] = await Promise.all([
  readFile("src/components/OrganizationContextSwitcher.tsx", "utf8"),
  readFile("src/app/(dashboard)/layout.tsx", "utf8"),
  readFile("src/app/api/organizations/context/route.ts", "utf8"),
]);

test("V4 global organization switcher uses only the server-validated context endpoint", () => {
  assert.match(layout, /<OrganizationContextSwitcher\s*\/>/);
  assert.match(switcher, /fetch\("\/api\/organizations\/context"/);
  assert.match(switcher, /method:\s*"POST"/);
  assert.match(switcher, /JSON\.stringify\(\{ organizationId \}\)/);
  assert.doesNotMatch(switcher, /supabaseAdmin|createClient|Authorization:/);
  assert.match(contextRoute, /active_organization_membership_required/);
});

test("V4 global organization switcher keeps the established Lead selector as the scoped migration boundary", () => {
  assert.match(switcher, /pathname\.startsWith\("\/leads"\)/);
  assert.match(switcher, /window\.location\.reload\(\)/);
  assert.match(switcher, /aria-label="Current organization"/);
});
