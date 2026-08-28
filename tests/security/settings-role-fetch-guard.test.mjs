import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../src/app/(dashboard)/settings/page.tsx", import.meta.url), "utf8");

test("settings data is fetched only after the role guard grants access", () => {
  assert.match(source, /const SETTINGS_ROLES = \["admin", "boss", "operator"\]/);
  assert.match(source, /useRequireRole\(SETTINGS_ROLES\)/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(roleLoading \|\| blocked \|\| !role \|\| !SETTINGS_ROLES\.includes\(role\)\) return;\s*const timer = window\.setTimeout\(\(\) => \{ void fetchData\(\); \}, 0\);\s*return \(\) => window\.clearTimeout\(timer\);\s*\}, \[fetchData, roleLoading, blocked, role\]\)/,
  );
  assert.doesNotMatch(source, /useEffect\(\(\) => \{ fetchData\(\); \}, \[fetchData\]\)/);
});
