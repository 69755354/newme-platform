import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

const migration = read("supabase/migrations/20260817220000_notification_event_idempotency.sql");
const notifications = read("src/lib/notifications.ts");
const pg17Gate = read("supabase/replay/26_notification_event_idempotency.sh");

test("notification occurrence migration makes only non-null keys unique per recipient", () => {
  assert.match(migration, /alter table public\.notifications\s+add column if not exists event_key text;/i);
  assert.match(
    migration,
    /create unique index if not exists ux_notifications_user_event_key\s+on public\.notifications \(user_id, event_key\);/i,
  );
  assert.doesNotMatch(migration, /unique\s+nulls\s+not\s+distinct/i);
  assert.match(migration, /on conflict \(user_id, event_key\) do nothing;/i);
});

test("notification RPC is invoker-rights, service-only and transactionally installed", () => {
  assert.match(migration, /security invoker\s+set search_path = pg_catalog, public, pg_temp/i);
  assert.match(
    migration,
    /revoke all on function public\.insert_notifications_atomic\(jsonb\) from public, anon, authenticated;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.insert_notifications_atomic\(jsonb\) to service_role;/i,
  );
  const notifyAt = migration.lastIndexOf("notify pgrst, 'reload schema';");
  const commitAt = migration.lastIndexOf("commit;");
  assert.ok(notifyAt > migration.indexOf("begin;") && notifyAt < commitAt);
});

test("authenticated legacy writes retain old columns but cannot reserve event_key", () => {
  assert.match(
    migration,
    /revoke insert, update on table public\.notifications from authenticated;/i,
  );
  const insertGrant = migration.match(/grant insert \(([\s\S]*?)\) on table public\.notifications to authenticated;/i);
  const updateGrant = migration.match(/grant update \(([\s\S]*?)\) on table public\.notifications to authenticated;/i);
  assert.ok(insertGrant);
  assert.ok(updateGrant);
  for (const grant of [insertGrant[1], updateGrant[1]]) {
    assert.match(grant, /user_id/);
    assert.match(grant, /is_read/);
    assert.doesNotMatch(grant, /event_key/);
  }
});

test("application persistence has no read-before-insert path", () => {
  const start = notifications.indexOf("export async function createNotificationsBulk");
  const end = notifications.indexOf("/**\n * Get all admin/boss", start);
  const body = notifications.slice(start, end);
  assert.match(body, /\.rpc\("insert_notifications_atomic",/);
  assert.doesNotMatch(body, /\.from\("notifications"\)/);
  assert.doesNotMatch(body, /notification_deduplication_failed/);
});

test("PG17 gate proves a lock wait plus rollback, reentry and ACL", () => {
  assert.match(pg17Gate, /wait_event_type = 'Lock'/);
  assert.match(pg17Gate, /pg_advisory_lock/);
  assert.match(pg17Gate, /rollback;/);
  assert.match(pg17Gate, /has_function_privilege\('authenticated'/);
  assert.match(pg17Gate, /has_column_privilege\('authenticated'.*'event_key'.*'INSERT'/);
});
