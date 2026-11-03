import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pages = ["src/app/(dashboard)/ads/page.tsx", "src/app/(dashboard)/settings/ads/page.tsx"];

const metrics = () => fs.readFileSync(path.join(repoRoot, "src/lib/lead-metrics.mjs"), "utf8");

// leads.quality is constrained to good/normal/poor/pending. Counting "valid"
// kept the attribution pages' "valid" column at 0 for every source. Both pages
// now count through the one shared module, which holds the rule.
test("attribution pages count quality values that exist in the database", () => {
  for (const page of pages) {
    const source = fs.readFileSync(path.join(repoRoot, page), "utf8");
    assert.doesNotMatch(source, /quality\s*===\s*"valid"/, page);
    assert.match(source, /aggregateAttribution/, `${page} must use the shared attribution counting`);
  }
  const shared = metrics();
  assert.doesNotMatch(shared, /quality\s*===\s*"valid"/);
  assert.match(shared, /bucket === "good" \|\| bucket === "normal"/);
});

test("attribution pages group by lead source before platform", () => {
  const shared = metrics();
  assert.match(shared, /lead\?\.source \|\| lead\?\.source_platform \|\| "other"/);
  const ads = fs.readFileSync(path.join(repoRoot, pages[0]), "utf8");
  assert.match(ads, /l\.source \|\| l\.source_platform \|\| "other"/, pages[0]);
  const settings = fs.readFileSync(path.join(repoRoot, pages[1]), "utf8");
  assert.doesNotMatch(settings, /source_platform \|\| /, "settings page groups with the shared default key");
});
