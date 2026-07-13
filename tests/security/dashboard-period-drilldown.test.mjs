import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Dashboard L3 includes every lead that contributes to L2 period metrics", async () => {
  const source = await read("src/app/api/dashboard/weekly-review/route.ts");
  for (const token of ["assignedLeads", "contactedLogs", "stageEvents", "pendingQuality", "overdueTasks"]) {
    assert.ok(source.includes(token), `missing period source: ${token}`);
  }
  assert.match(source, /relevantLeadIds/);
  assert.match(source, /contactedLogs[\s\S]*relevantLeadIds|relevantLeadIds[\s\S]*contactedLogs/);
  assert.match(source, /overdueTasks[\s\S]*relevantLeadIds|relevantLeadIds[\s\S]*overdueTasks/);
});

test("L2 stage advancement counts only stage changes", async () => {
  const source = await read("src/app/api/dashboard/weekly-review/route.ts");
  assert.doesNotMatch(source, /\.in\("event_type", \["stage_change", "transfer", "owner_change"\]\)/);
  assert.match(source, /\.eq\("event_type", "stage_change"\)/);
});

test("period labels render Dubai calendar dates and an inclusive end date", async () => {
  const source = await read("src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx");
  assert.match(source, /formatDubaiDate/);
  assert.match(source, /endExclusive/);
  assert.doesNotMatch(source, /const fmtDate = \(iso\?: string \| null\) => iso \? iso\.slice\(0, 10\)/);
});

test("L3 uses sales-facing labels instead of raw database enums", async () => {
  const source = await read("src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx");
  assert.match(source, /stageLabel/);
  assert.match(source, /qualityLabel/);
  assert.match(source, /最后联系|Last contact/);
  assert.match(source, /下一步|Next action/);
});
