// S3 #7 — lists/kanban were silently capped at 500 leads.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { fetchAllRows } from "../../src/lib/paged-rows.mjs";

function table(n, { serverCap = Infinity } = {}) {
  const all = Array.from({ length: n }, (_, i) => ({ id: i }));
  const calls = [];
  return {
    calls,
    makeQuery: (withCount) => ({
      async range(from, to) {
        calls.push([from, to, withCount]);
        const end = Math.min(to + 1, from + serverCap);
        return { data: all.slice(from, end), error: null, count: withCount ? n : null };
      },
    }),
  };
}

test("every visible lead is read, past 500, with the exact total", async () => {
  const t = table(1234);
  const result = await fetchAllRows(t.makeQuery, { pageSize: 500 });
  assert.equal(result.rows.length, 1234);
  assert.equal(result.total, 1234);
  assert.equal(result.truncated, false);
  assert.equal(t.calls.filter(([, , c]) => c).length, 1, "count is asked once");
});

test("a server row cap below the page size does not end paging early", async () => {
  const result = await fetchAllRows(table(2500, { serverCap: 1000 }).makeQuery, { pageSize: 5000 });
  assert.equal(result.rows.length, 2500);
  assert.equal(result.truncated, false);
});

test("the safety ceiling is reported, never silent", async () => {
  const result = await fetchAllRows(table(300).makeQuery, { pageSize: 100, maxRows: 200 });
  assert.equal(result.rows.length, 200);
  assert.equal(result.total, 300);
  assert.equal(result.truncated, true);
});

test("the list and pipeline routes no longer cap at 500", () => {
  for (const file of ["src/app/api/leads/list/route.ts", "src/app/api/pipeline/list/route.ts"]) {
    const source = fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(source, /\.limit\(500\)/, file);
    assert.match(source, /fetchAllRows\(/, file);
    assert.match(source, /total/, file);
  }
});
