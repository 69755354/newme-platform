// S43 (B13): leave cover. Pure routing rules, the database-free recipient expansion, the intake notification,
// the reminder plan and the static contract of the migration, the users API and the team page mount.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  LEAVE_COVER_SWITCH, activeCoverId, expandReminderItems, expandWithCovers, leaveCoverEnabled, withCoverRecipients,
} from "../../src/lib/leave-cover.mjs";
import { notifyNewLead } from "../../src/lib/lead-intake-notify.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SALES = "a0000000-0000-4000-8000-000000000001";
const COVER = "a0000000-0000-4000-8000-000000000002";
const GONE = "a0000000-0000-4000-8000-000000000003";
const ADMIN = "a0000000-0000-4000-8000-000000000004";
const onLeave = { id: SALES, is_active: true, cover_user_id: COVER, cover_start: "2026-12-01", cover_end: "2026-12-05" };
const coverProfile = { id: COVER, is_active: true, cover_user_id: null, cover_start: null, cover_end: null };
const ON = { [LEAVE_COVER_SWITCH]: "true" };
const OFF = {};
const dubai = (day, hm) => new Date(`${day}T${hm}:00+04:00`);

test("the switch is off by default and only the exact word true turns it on", () => {
  assert.equal(leaveCoverEnabled({}), false);
  assert.equal(leaveCoverEnabled({ [LEAVE_COVER_SWITCH]: "1" }), false);
  assert.equal(leaveCoverEnabled({ [LEAVE_COVER_SWITCH]: "TRUE" }), true);
  assert.equal(leaveCoverEnabled({ [LEAVE_COVER_SWITCH]: "true" }), true);
});

test("a cover is active on Dubai calendar days from start to end inclusive, and never for oneself", () => {
  assert.equal(activeCoverId(onLeave, dubai("2026-11-30", "23:59")), null);
  assert.equal(activeCoverId(onLeave, dubai("2026-12-01", "00:00")), COVER);
  assert.equal(activeCoverId(onLeave, dubai("2026-12-05", "23:30")), COVER);
  // 20:30 UTC on 5 Dec is already 6 Dec in Dubai: the cover has ended.
  assert.equal(activeCoverId(onLeave, new Date("2026-12-05T20:30:00Z")), null);
  assert.equal(activeCoverId({ ...onLeave, cover_user_id: SALES }, dubai("2026-12-02", "10:00")), null);
  assert.equal(activeCoverId({ ...onLeave, cover_end: null }, dubai("2026-12-02", "10:00")), null);
  assert.equal(activeCoverId(null, dubai("2026-12-02", "10:00")), null);
});

test("expandWithCovers adds the active cover once and leaves an inactive cover out", () => {
  const when = dubai("2026-12-02", "10:00");
  assert.deepEqual(expandWithCovers([SALES], [onLeave, coverProfile], when), [SALES, COVER]);
  assert.deepEqual(expandWithCovers([SALES, COVER], [onLeave, coverProfile], when), [SALES, COVER]);
  assert.deepEqual(expandWithCovers([SALES], [onLeave, { ...coverProfile, is_active: false }], when), [SALES]);
  assert.deepEqual(expandWithCovers([SALES], [onLeave, coverProfile], dubai("2026-12-20", "10:00")), [SALES]);
});

function fakeDb(profiles, calls = []) {
  return {
    from(table) {
      const filters = [];
      const q = {
        select: () => q,
        eq: (col, val) => (filters.push((r) => r[col] === val), q),
        in: (col, vals) => (filters.push((r) => vals.includes(r[col])), q),
        then: (res, rej) => {
          calls.push(table);
          const rows = table === "profiles" ? profiles.filter((r) => filters.every((f) => f(r))) : [];
          return Promise.resolve({ data: rows, error: null }).then(res, rej);
        },
      };
      return q;
    },
    rpc: async () => ({ data: { created: 0, skipped: 0 }, error: null }),
  };
}

test("withCoverRecipients reads nothing while the switch is off, and adds the active cover when it is on", async () => {
  const calls = [];
  const db = fakeDb([onLeave, coverProfile], calls);
  assert.deepEqual(await withCoverRecipients(db, [SALES], { now: dubai("2026-12-02", "10:00"), env: OFF }), [SALES]);
  assert.equal(calls.length, 0);
  assert.deepEqual(await withCoverRecipients(db, [SALES], { now: dubai("2026-12-02", "10:00"), env: ON }), [SALES, COVER]);
  assert.deepEqual(await withCoverRecipients(db, [SALES], { now: dubai("2026-12-09", "10:00"), env: ON }), [SALES]);
  // a cover whose own profile is deactivated is not told
  const gone = fakeDb([{ ...onLeave, cover_user_id: GONE }, { id: GONE, is_active: false }]);
  assert.deepEqual(await withCoverRecipients(gone, [SALES], { now: dubai("2026-12-02", "10:00"), env: ON }), [SALES]);
});

test("a new lead assigned to someone on leave notifies the owner and the cover (switch on), only the owner (switch off)", async () => {
  const saved = process.env[LEAVE_COVER_SWITCH];
  const rows = [];
  const db = {
    ...fakeDb([onLeave, coverProfile, { id: ADMIN, role: "admin", is_active: true }]),
    rpc: async (name, args) => { rows.push(...args.p_notifications); return { data: { created: args.p_notifications.length, skipped: 0 }, error: null }; },
  };
  const lead = { id: "b0000000-0000-4000-8000-000000000001", customer_name: "Cover Test", assigned_to: SALES, created_at: dubai("2026-12-02", "09:00").toISOString() };
  try {
    delete process.env[LEAVE_COVER_SWITCH];
    await notifyNewLead(db, lead, { now: dubai("2026-12-02", "10:00").getTime() });
    assert.deepEqual(rows.map((r) => r.user_id), [SALES]);
    rows.length = 0;
    process.env[LEAVE_COVER_SWITCH] = "true";
    await notifyNewLead(db, lead, { now: dubai("2026-12-02", "10:00").getTime() });
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [SALES, COVER].sort());
    assert.ok(rows.every((r) => r.event_key === `lead_created:${lead.id}`));
  } finally {
    if (saved === undefined) delete process.env[LEAVE_COVER_SWITCH]; else process.env[LEAVE_COVER_SWITCH] = saved;
  }
});

test("reminder items are duplicated for the active cover only when the switch is on", () => {
  const items = [{ lead_id: "L1", assigned_to: SALES }, { lead_id: "L2", assigned_to: null }];
  const when = dubai("2026-12-02", "10:00");
  assert.deepEqual(expandReminderItems(items, [onLeave, coverProfile], when, OFF), items);
  const expanded = expandReminderItems(items, [onLeave, coverProfile], when, ON);
  assert.equal(expanded.length, 3);
  assert.deepEqual(expanded[1], { lead_id: "L1", assigned_to: COVER, cover_for: SALES });
  assert.equal(expandReminderItems(items, [onLeave, coverProfile], dubai("2026-12-09", "10:00"), ON).length, 2);
});

test("migration contract: additive columns, both constraints, definer routine with pinned search_path, admin/boss only, manual undo", () => {
  const sql = read("supabase/migrations/20261124300000_s43_leave_cover.sql");
  assert.match(sql, /^-- NO_ROLLBACK:/);
  for (const col of ["cover_user_id", "cover_start", "cover_end"]) assert.match(sql, new RegExp(`add column if not exists ${col}`));
  assert.match(sql, /profiles_cover_not_self/);
  assert.match(sql, /profiles_cover_dates/);
  assert.match(sql, /create or replace function public\.set_leave_cover\(p_user uuid, p_cover uuid, p_start date, p_end date\)[\s\S]*security definer\s*\n\s*set search_path = pg_catalog, public, pg_temp/);
  assert.match(sql, /not in \('admin', 'boss'\)/);
  assert.match(sql, /revoke all on function public\.set_leave_cover\(uuid, uuid, date, date\) from public, anon;/);
  assert.match(sql, /-- Manual undo/);
  assert.ok(fs.existsSync(path.join(ROOT, "tests/database/s43-leave-cover.sql")));
});

test("the users API returns the cover columns, the team page mounts the panel once, the panel is admin-facing and the API refuses other roles", () => {
  assert.match(read("src/app/api/users/route.ts"), /cover_user_id, cover_start, cover_end/);
  const page = read("src/app/(dashboard)/team/page.tsx");
  assert.equal(page.match(/<LeaveCoverPanel /g)?.length, 1);
  const panel = read("src/components/team/LeaveCoverPanel.tsx");
  assert.match(panel, /data-testid="leave-cover-panel"/);
  assert.match(panel, /fetch\("\/api\/team\/leave-cover"/);
  const route = read("src/app/api/team/leave-cover/route.ts");
  assert.match(route, /^\/\/ RBAC: admin, boss/);
  assert.match(route, /context\.supabase\.rpc\("set_leave_cover"/);
  assert.doesNotMatch(route, /supabaseAdmin/);
  // the three recipients paths carry the cover
  assert.match(read("src/lib/notification-events.ts"), /case "lead_assigned": \{[\s\S]*withCoverRecipients\(db, \[lead\.assigned_to\]/);
  assert.match(read("src/app/api/cron/check-whatsapp-followups/route.ts"), /withCoverRecipients\(supabaseAdmin, ownerAndCover/);
  assert.match(read("scripts/daily-brief.mjs"), /planAdReminders\(expandReminderItems\(adItems, data\.profiles, now, env\)/);
});
