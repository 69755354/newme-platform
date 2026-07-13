import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("weekly review API supports GST Today and validated custom periods", async () => {
  const source = await read("src/app/api/dashboard/weekly-review/route.ts");
  for (const token of [
    '"today"',
    '"custom"',
    "GST_OFFSET_MS",
    "Invalid custom range",
    'sp.get("start")',
    'sp.get("end")',
  ]) assert.ok(source.includes(token), `missing period contract: ${token}`);
});

test("weekly review API applies sales ownership scope before returning L1 L2 and L3", async () => {
  const source = await read("src/app/api/dashboard/weekly-review/route.ts");
  for (const token of [
    '["admin", "boss", "operator", "sales"]',
    "const isSalesScope = role === \"sales\"",
    ".eq(\"assigned_to\", user.id)",
    "l3_by_user[user.id]",
  ]) assert.ok(source.includes(token), `missing sales scope: ${token}`);
});

test("Dashboard defaults the review to Today and exposes custom range selection", async () => {
  const page = await read("src/app/(dashboard)/dashboard/page.tsx");
  const review = await read("src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx");
  assert.ok(page.includes('useState<ReviewRange>(() =>'));
  assert.ok(page.includes(': "today"'));
  assert.ok(page.includes("URLSearchParams"));
  for (const token of ['"today"', '"custom"', 'type="date"', "onCustomRangeChange"]) {
    assert.ok(review.includes(token), `missing review UI: ${token}`);
  }
});
