-- S32 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s32-tasks-future-only.sql
-- Runs in one transaction that is rolled back. Every id below is invented.
-- Covers: the migration turns the validated, time-dependent tasks_future_only into the same constraint NOT VALID
-- (the exact posture the s32 provisioning gate pins), existing rows older than the window survive, an INSERT
-- older than the window is still rejected, a second run is a no-op, and a pg_dump-style reload (data first,
-- constraint after) of a historic row succeeds where it failed before.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S32 ASSERT_FAIL %', p_name; end if;
  raise notice 'S32 ASSERT_OK %', p_name;
end $$;

-- 0. before: the production state the gate's PRIOR predicate expects (validated, 30-day expression).
--    The replayed history database has already applied S32 (replay-migrations.sh runs every pending manifest
--    migration), so the validated constraint is put back first; the table is empty there, so VALIDATE succeeds.
alter table public.tasks drop constraint if exists tasks_future_only;
alter table public.tasks add constraint tasks_future_only check (due_at > (now() - '30 days'::interval));
select pg_temp.expect((select count(*) = 1 and bool_and(c.convalidated)
    and bool_and(pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((due_at > (now() - ''30 days''::interval)))')
  from pg_catalog.pg_constraint c
  where c.conrelid = to_regclass('public.tasks') and c.conname = 'tasks_future_only' and c.contype = 'c'),
  'prior-state-validated-30-days');

-- a historic row written while it was valid: with the validated constraint it cannot even be inserted today
insert into public.leads (id, source, customer_name, phone, created_at)
  values ('32000000-0000-4000-8000-000000000001', 'website', 'Test Lead S32', '+971500000032', '2026-07-01T08:00:00Z');
do $$
begin
  insert into public.tasks (id, lead_id, title, due_at, status, created_at)
    values ('32000000-0000-4000-8000-000000000011', '32000000-0000-4000-8000-000000000001', 'historic', '2026-07-19T09:00:00Z', 'pending', '2026-07-18T08:00:00Z');
  raise exception 'S32 ASSERT_FAIL historic-insert-should-fail-before-migration';
exception when check_violation then
  raise notice 'S32 ASSERT_OK historic-insert-rejected-before-migration';
end $$;

-- 1. the migration applies and can be applied a second time
\ir ../../supabase/migrations/20261120200000_tasks_future_only_not_valid.sql
\ir ../../supabase/migrations/20261120200000_tasks_future_only_not_valid.sql

-- 2. after: exactly the posture the gate's PRESENT predicate pins (same expression, NOT VALID)
select pg_temp.expect((select count(*) = 1 and bool_and(not c.convalidated)
    and bool_and(pg_catalog.pg_get_constraintdef(c.oid) = 'CHECK ((due_at > (now() - ''30 days''::interval))) NOT VALID')
  from pg_catalog.pg_constraint c
  where c.conrelid = to_regclass('public.tasks') and c.conname = 'tasks_future_only' and c.contype = 'c'),
  'present-state-not-valid-same-expression');

-- 3. inserts and updates are still checked
do $$
begin
  insert into public.tasks (id, lead_id, title, due_at, status, created_at)
    values ('32000000-0000-4000-8000-000000000012', '32000000-0000-4000-8000-000000000001', 'too old', now() - interval '90 days', 'pending', now());
  raise exception 'S32 ASSERT_FAIL old-insert-should-still-fail';
exception when check_violation then
  raise notice 'S32 ASSERT_OK old-insert-still-rejected';
end $$;
insert into public.tasks (id, lead_id, title, due_at, status, created_at)
  values ('32000000-0000-4000-8000-000000000013', '32000000-0000-4000-8000-000000000001', 'today', now(), 'pending', now());
do $$
begin
  update public.tasks set due_at = now() - interval '90 days' where id = '32000000-0000-4000-8000-000000000013';
  raise exception 'S32 ASSERT_FAIL old-update-should-still-fail';
exception when check_violation then
  raise notice 'S32 ASSERT_OK old-update-still-rejected';
end $$;

-- 4. the restore path: pg_dump emits a NOT VALID check after the data. Replay that order on a copy of the table:
--    data first (a historic row), the constraint afterwards; the historic row survives and is still counted.
create table pg_temp.tasks_restore (like public.tasks including defaults);
insert into pg_temp.tasks_restore (id, lead_id, title, due_at, status, created_at)
  values ('32000000-0000-4000-8000-000000000011', '32000000-0000-4000-8000-000000000001', 'historic', '2026-07-19T09:00:00Z', 'pending', '2026-07-18T08:00:00Z');
alter table pg_temp.tasks_restore add constraint tasks_future_only check (due_at > (now() - '30 days'::interval)) not valid;
select pg_temp.expect((select count(*) = 1 from pg_temp.tasks_restore where id = '32000000-0000-4000-8000-000000000011'), 'historic-row-survives-restore-order');
do $$
begin
  insert into pg_temp.tasks_restore (id, lead_id, title, due_at, status, created_at)
    values ('32000000-0000-4000-8000-000000000014', '32000000-0000-4000-8000-000000000001', 'too old', now() - interval '90 days', 'pending', now());
  raise exception 'S32 ASSERT_FAIL restored-table-old-insert-should-fail';
exception when check_violation then
  raise notice 'S32 ASSERT_OK restored-table-still-checks-new-rows';
end $$;

rollback;
