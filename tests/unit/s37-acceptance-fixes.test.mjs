// S37 staging acceptance fixes: quote calculator survives the post-save refresh, workbench progress card counts the same
// leads as /leads, date-only follow-ups show no clock time, the daily brief says "未记录联系".
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { formatDateTime, formatShortDate, isDateOnly } from "../../src/lib/display-format.mjs";

const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ── 1. lead detail: refresh after a quote save must not unmount the dialog ──
test("fetchData has a silent mode that never raises the loading flag or the error page", () => {
  const src = read("src/app/(dashboard)/leads/[id]/useLeadDetailData.ts");
  assert.match(src, /silent\?: boolean/);
  assert.match(src, /if \(!silent\) \{\s*setLoading\(true\);/);
  assert.match(src, /finally \{\s*if \(!silent\) setLoading\(false\);/);
  assert.match(src, /refreshData = useCallback\(\(\) => fetchData\(\{ silent: true \}\)/);
});

test("lead detail page refreshes silently after quote saves and mutations", () => {
  const page = read("src/app/(dashboard)/leads/[id]/page.tsx");
  assert.doesNotMatch(page, /onSaved=\{\(\) => \{ fetchData\(\); \}\}/, "a loading refresh unmounts the quote dialog");
  assert.equal((page.match(/onSaved=\{\(\) => \{ void refreshData\(\); \}\}/g) || []).length, 2, "calculator and quick quote");
  assert.match(page, /onContactUpdated=\{refreshData\}/);
  assert.match(page, /fetchData: refreshData,/, "mutation hook refreshes silently");
});

// ── 2. workbench progress card = /leads population (archived = false) ──
function loadRoute(mocks) {
  const ts = require("typescript");
  const output = ts.transpileModule(read("src/app/api/workbench/route.ts"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("require", "exports", output)((name) => mocks[name] ?? require(name), exports);
  return exports;
}
function fakeSupabase(leads, userId) {
  const query = (table) => {
    const filters = []; let limit = Infinity;
    const rows = () => (table === "leads" ? leads.filter((r) => filters.every((f) => f(r))).slice(0, limit) : []);
    const q = {
      select: () => q,
      eq: (c, v) => (filters.push((r) => r[c] === v), q),
      neq: () => q, in: () => q, or: () => q, order: () => q, lte: () => q, gt: () => q,
      is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), q),
      lt: (c, v) => (filters.push((r) => r[c] != null && r[c] < v), q),
      gte: (c, v) => (filters.push((r) => r[c] != null && r[c] >= v), q),
      limit: (n) => (limit = n, q),
      single: async () => ({ data: { id: userId, full_name: "Me", role: "sales" }, error: null }),
      then: (res, rej) => Promise.resolve({ data: rows(), count: 0, error: null }).then(res, rej),
    };
    return q;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: userId } }, error: null }) }, from: query };
}

test("workbench progress card does not count archived leads", async () => {
  const me = "c0000000-0000-4000-8000-0000000000aa";
  const mk = (id, archived, ms) => ({ id, assigned_to: me, archived, final_status: null, current_milestone: ms });
  const leads = [mk("a", false, "new"), mk("b", false, "new"), mk("c", false, "contacted"), mk("d", true, "new"), mk("e", true, "contacted"), mk("f", true, "contacted")];
  const { INBOX_LIMIT, inboxDayKeys, mergeInbox } = await import("../../src/lib/workbench-inbox.mjs");
  const route = loadRoute({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/api-cache.mjs": { getCached: () => null, setCache: () => {} },
    "@/lib/workbench-inbox.mjs": { INBOX_LIMIT, inboxDayKeys, mergeInbox },
    "@/lib/supabase-server": { createServerSupabase: async () => fakeSupabase(leads, me) },
  });
  const body = await (await route.GET(new Request("https://example.test/api/workbench"))).json();
  const total = body.progress.reduce((s, r) => s + r.count, 0);
  assert.equal(total, 3, "only the 3 non-archived leads");
  assert.equal(body.progress.find((r) => r.current_milestone === "new").count, 2);
});

// ── 3. date-only follow-up dates show no clock time ──
test("a date-only follow-up date is a calendar day, never 04:00", () => {
  assert.ok(isDateOnly("2026-11-24"));
  assert.equal(formatDateTime("2026-11-24", "en", new Date("2026-11-22T08:00:00Z")), "24 Nov");
  assert.equal(formatShortDate("2026-11-24", "zh", new Date("2026-11-22T08:00:00Z")), "11月24日");
  const page = read("src/app/(dashboard)/workbench/page.tsx");
  assert.match(page, /if \(isDateOnly\(value\)\) return formatShortDate\(value/);
});

// ── 4. daily brief wording ──
test("daily brief says 未记录联系, not 未联系", async () => {
  const src = read("src/lib/daily-brief.mjs");
  assert.match(src, /24小时未记录联系：/);
  assert.doesNotMatch(src, /24小时未联系/);
  assert.match(src, /仍未记录首次联系/);
});
