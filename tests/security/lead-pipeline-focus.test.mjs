import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("pipeline summary focuses the selected stage column", async () => {
  const page = await read("src/app/(dashboard)/leads/page.tsx");

  assert.match(page, /const handlePipelineStageChange/);
  assert.match(page, /scrollTo\(\{ left: stageIndex \* 316, behavior: "smooth" \}\)/);
  assert.match(page, /onStageFilterChange=\{handlePipelineStageChange\}/);
});
