// S24: source-level checks of the workbench tab and pagination logic (the component has no DOM test harness here).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const src = fs.readFileSync(new URL("../../src/components/dispatch/DispatchWorkbench.tsx", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("../../src/lib/i18n/translations.ts", import.meta.url), "utf8");

test("clicking the active tab is a no-op, so the queue never sticks on loading", () => {
  assert.match(src, /if \(name === status\) return;\s*setStatus\(name\)/);
});

test("the queue request carries the offset and the effect reruns when it changes", () => {
  assert.match(src, /limit=\$\{PAGE_SIZE\}&offset=\$\{offset\}/);
  assert.match(src, /\[status, offset, reloadKey\]/);
});

test("changing tab resets to the first page; next is gated by has_more, previous by offset", () => {
  assert.match(src, /setStatus\(name\); setOffset\(0\)/);
  assert.match(src, /setHasMore\(Boolean\(result\.body\.pagination\?\.has_more\)\)/);
  assert.match(src, /disabled=\{!hasMore\}/);
  assert.match(src, /disabled=\{offset === 0\}/);
});

test("pagination labels exist in both languages", () => {
  for (const key of ["prev", "next", "pageRange"]) {
    assert.equal((i18n.match(new RegExp(`^      ${key}: `, "gm")) ?? []).length >= 2, true, key);
  }
  assert.match(i18n, /pageRange: "\{from\}-\{to\} of \{total\}"/);
  assert.match(i18n, /pageRange: "第 \{from\}-\{to\} 条，共 \{total\} 条"/);
});
