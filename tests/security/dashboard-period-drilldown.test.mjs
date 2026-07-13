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


test("stage advancement drill-down explains every stage event including won and lost", async () => {
  const route = await read("src/app/api/dashboard/weekly-review/route.ts");
  assert.match(route, /addReason\(event\.lead_id, "stage_advanced"\)/);
  assert.match(route, /stageAdvanceCountByLead/);
  assert.match(route, /stage_advance_count:/);
});

test("overdue metrics use due dates and Lead Owner attribution", async () => {
  const route = await read("src/app/api/dashboard/weekly-review/route.ts");
  assert.match(route, /select\("lead_id, due_at, leads!inner\(assigned_to\)"\)/);
  assert.match(route, /\.gte\("due_at", startIso\)\.lt\("due_at", overdueEndIso\)/);
  assert.match(route, /overdueByOwner/);
  assert.doesNotMatch(route, /overdueTasks[\s\S]{0,300}\.gte\("created_at"/);
});

test("custom range includes its selected end day", async () => {
  const route = await read("src/app/api/dashboard/weekly-review/route.ts");
  const page = await read("src/app/(dashboard)/dashboard/page.tsx");
  assert.match(route, /start > end/);
  assert.match(route, /new Date\(end\.getTime\(\) \+ 24 \* 3600 \* 1000\)/);
  assert.doesNotMatch(page, /customStart >= customEnd/);
});

test("sales Dashboard rows are explicitly scoped to the signed-in profile", async () => {
  const route = await read("src/app/api/dashboard/weekly-review/route.ts");
  assert.match(route, /profilesQuery = profilesQuery\.eq\("id", user\.id\)/);
  assert.match(route, /contactedLogsQuery = contactedLogsQuery\.eq\("leads\.assigned_to", user\.id\)/);
  assert.match(route, /pendingQualityQuery = pendingQualityQuery\.eq\("assigned_to", user\.id\)/);
  assert.match(route, /stageEventsQuery = stageEventsQuery\.eq\("leads\.assigned_to", user\.id\)/);
});
