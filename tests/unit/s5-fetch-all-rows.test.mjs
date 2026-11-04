// S5: report routes read every row, whatever row cap the server applies.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

import { fetchAllRows, LIST_MAX_ROWS } from "../../src/lib/fetch-all-rows.mjs";

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

// ── Lead / pipeline lists (formerly S3's paged-rows module, merged here) ──
function listTable(n, { serverCap = Infinity } = {}) {
  const all = Array.from({ length: n }, (_, i) => ({ id: i }));
  const calls = [];
  const build = async (from, to, withCount) => {
    calls.push([from, to, withCount]);
    const end = Math.min(to + 1, from + serverCap);
    return { data: all.slice(from, end), error: null, count: withCount ? n : null };
  };
  return { build, calls };
}

test("every visible lead is read, past 500, with the exact total", async () => {
  const t = listTable(1234);
  const result = await fetchAllRows(t.build, { pageSize: 500 });
  assert.equal(result.data.length, 1234);
  assert.equal(result.total, 1234);
  assert.equal(result.truncated, false);
  assert.equal(t.calls.filter(([, , c]) => c).length, 1, "count is asked once");
});

test("a server row cap below the page size does not end paging early", async () => {
  const result = await fetchAllRows(listTable(2500, { serverCap: 1000 }).build, { pageSize: 5000 });
  assert.equal(result.data.length, 2500);
  assert.equal(result.total, 2500);
  assert.equal(result.truncated, false);
});

test("the safety ceiling is reported with the true total, never silent", async () => {
  const result = await fetchAllRows(listTable(300).build, { pageSize: 100, maxRows: 200 });
  assert.equal(result.data.length, 200);
  assert.equal(result.total, 300);
  assert.equal(result.truncated, true);
  assert.equal(LIST_MAX_ROWS, 20000);
});

test("the list and pipeline routes no longer cap at 500 and use the one reader", () => {
  for (const file of ["src/app/api/leads/list/route.ts", "src/app/api/pipeline/list/route.ts"]) {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\.limit\(500\)/, file);
    assert.match(source, /fetch-all-rows/, file);
    assert.doesNotMatch(source, /paged-rows/, file);
    assert.match(source, /fetchAllRows\(/, file);
    assert.match(source, /total/, file);
  }
  assert.equal(fs.existsSync(new URL("../../src/lib/paged-rows.mjs", import.meta.url)), false);
});
