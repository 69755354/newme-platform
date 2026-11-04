// S7 item 8: the two disabled reminders (follow-ups, alerts) are replaced by ONE
// daily digest that is dedup-safe, count-only and silent when nothing is due.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { buildDailyDigest, dubaiDate } from "../../src/lib/daily-digest.mjs";

const today = "2026-11-05";
const managers = [{ id: "m1" }, { id: "m2" }];

test("Dubai date rolls over at 20:00 UTC", () => {
  assert.equal(dubaiDate(new Date("2026-11-04T19:59:00Z")), "2026-11-04");
  assert.equal(dubaiDate(new Date("2026-11-04T20:00:00Z")), "2026-11-05");
});

test("one draft per rep and one per manager, with a per-day event key and no names", () => {
  const leads = [
    { assigned_to: "r1", next_followup_date: "2026-11-01", stage: "new", customer_name: "Fatima" },
    { assigned_to: "r1", next_followup_date: "2026-11-05", stage: "contacted" },
    { assigned_to: "r1", next_followup_date: "2026-11-02", stage: "won" },
    { assigned_to: "r2", next_followup_date: "2026-11-04", stage: "quoted" },
    { assigned_to: "r2", next_followup_date: "2026-11-09", stage: "quoted" },
    { assigned_to: null, next_followup_date: "2026-11-01", stage: "new" },
  ];
  const drafts = buildDailyDigest({ leads, managers, today });
  assert.deepEqual(drafts.map((d) => d.userId), ["r1", "r2", "m1", "m2"]);
  assert.ok(drafts.every((d) => d.eventKey === "daily_digest:2026-11-05"));
  assert.match(drafts[0].title, /1 overdue, 1 due today/);
  assert.match(drafts[2].title, /2 overdue, 1 due today/);
  assert.ok(!JSON.stringify(drafts).includes("Fatima"));
  assert.ok(/[一-鿿]/.test(drafts[0].body) && /overdue/.test(drafts[0].body), "bilingual");
});

test("nothing due means nothing sent", () => {
  assert.deepEqual(buildDailyDigest({ leads: [{ assigned_to: "r1", next_followup_date: "2026-11-30", stage: "new" }], managers, today }), []);
});

const require = createRequire(import.meta.url);
test("route stays disabled unless explicitly enabled and demands the cron secret", async () => {
  const ts = require("typescript");
  const out = ts.transpileModule(fs.readFileSync(new URL("../../src/app/api/cron/daily-digest/route.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [];
  const exports = {};
  const mocks = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/supabase-admin": { supabaseAdmin: { from() { calls.push("db"); throw new Error("must not query"); } } },
    "@/lib/notifications": { createNotificationsBulk: async () => { calls.push("notify"); return { created: 0, skipped: 0 }; } },
    "@/lib/logger": { logger: { error() {} } },
    "@/lib/daily-digest.mjs": await import("../../src/lib/daily-digest.mjs"),
  };
  new Function("require", "exports", out)((name) => mocks[name] ?? require(name), exports);
  const saved = { ...process.env };
  try {
    process.env.CRON_SECRET = "s3cret";
    delete process.env.DAILY_DIGEST_ENABLED;
    assert.equal((await exports.GET(new Request("https://x.test"))).status, 401);
    const off = await exports.GET(new Request("https://x.test", { headers: { "x-cron-secret": "s3cret" } }));
    assert.equal(off.status, 200);
    assert.equal((await off.json()).message, "Disabled");
    assert.deepEqual(calls, [], "disabled route touches neither the database nor notifications");
  } finally {
    process.env = saved;
  }
});
