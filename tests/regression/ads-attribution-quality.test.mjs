import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pages = ["src/app/(dashboard)/ads/page.tsx", "src/app/(dashboard)/settings/ads/page.tsx"];

// leads.quality is constrained to good/normal/poor/pending. Counting "valid"
// kept the attribution pages' "valid" column at 0 for every source.
test("attribution pages count quality values that exist in the database", () => {
  for (const page of pages) {
    const source = fs.readFileSync(path.join(repoRoot, page), "utf8");
    assert.doesNotMatch(source, /quality\s*===\s*"valid"/, page);
    assert.match(source, /"good"/, page);
    assert.match(source, /"normal"/, page);
  }
});

test("attribution pages group by lead source before platform", () => {
  for (const page of pages) {
    const source = fs.readFileSync(path.join(repoRoot, page), "utf8");
    assert.match(source, /l\.source \|\| l\.source_platform \|\| "other"/, page);
  }
});
