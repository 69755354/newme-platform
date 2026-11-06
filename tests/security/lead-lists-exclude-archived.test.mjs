/**
 * S10: the lead list and the pipeline board return only live (non-archived) leads.
 *
 * Archiving is a bulk soft-archive that moves leads out of the working set and
 * can be undone by batch; the dashboard, analytics, workbench and every other
 * metric already exclude archived leads. The two list endpoints did not, so
 * archived leads showed up unmarked in the leads page and the board and the
 * totals disagreed (82 counted vs 141 listed on staging).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("/api/leads/list reads only non-archived leads", () => {
  assert.match(read("src/app/api/leads/list/route.ts"), /from\("leads"\)\.select\(LEAD_LIST_COLUMNS[^\n]*\)\.eq\("archived", false\)/);
});

test("/api/pipeline/list reads only non-archived leads", () => {
  assert.match(read("src/app/api/pipeline/list/route.ts"), /from\("leads"\)\.select\("\*"[^\n]*\)\.eq\("archived", false\)/);
});

test("restoring an archive batch does not depend on either list endpoint", () => {
  const archive = read("src/app/api/leads/archive/route.ts");
  assert.doesNotMatch(archive, /api\/(leads|pipeline)\/list/);
  assert.match(archive, /from\("leads"\)/);
});
