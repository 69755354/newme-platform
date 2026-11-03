// S5: report routes read every row, whatever row cap the server applies.
import assert from "node:assert/strict";
import test from "node:test";

import { fetchAllRows } from "../../src/lib/fetch-all-rows.mjs";

const rows = Array.from({ length: 2350 }, (_, i) => ({ id: i }));
function source({ cap = 1000, withCount = true } = {}) {
  const calls = [];
  const build = async (from, to, wantCount) => {
    calls.push([from, to]);
    const data = rows.slice(from, Math.min(to, from + cap - 1) + 1);
    return { data, error: null, ...(wantCount && withCount ? { count: rows.length } : {}) };
  };
  return { build, calls };
}

test("reads every page past the 1000-row cap, in order, without gaps", async () => {
  const { build, calls } = source();
  const result = await fetchAllRows(build);
  assert.equal(result.data.length, 2350);
  assert.deepEqual(result.data.map((r) => r.id), rows.map((r) => r.id));
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 3);
});

test("a server cap below the page size is followed row by row, never skipped", async () => {
  const { build } = source({ cap: 400 });
  const result = await fetchAllRows(build);
  assert.deepEqual(result.data.map((r) => r.id), rows.map((r) => r.id));
});

test("no count from the server: stops at the first short page", async () => {
  const { build } = source({ withCount: false });
  const result = await fetchAllRows(build);
  assert.equal(result.data.length, 2350);
});

test("an error on any page is reported, not turned into a short list", async () => {
  const build = async (from) => (from >= 1000 ? { data: null, error: { message: "boom" } } : { data: rows.slice(0, 1000), error: null, count: 2350 });
  const result = await fetchAllRows(build);
  assert.equal(result.data.length, 0);
  assert.equal(result.error.message, "boom");
});

test("the safety ceiling is reported as truncated", async () => {
  const { build } = source();
  const result = await fetchAllRows(build, { maxRows: 1500 });
  assert.equal(result.data.length, 1500);
  assert.equal(result.truncated, true);
});
