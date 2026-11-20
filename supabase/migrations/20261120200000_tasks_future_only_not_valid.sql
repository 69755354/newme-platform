-- NO_ROLLBACK: same CHECK expression as production has today, only re-created as NOT VALID; no row, column, policy or routine changes. Manual undo: ALTER TABLE public.tasks VALIDATE CONSTRAINT tasks_future_only (only possible once no row is older than the window).
-- ============================================================================
-- OS fix S34 - make public.tasks restorable: tasks_future_only becomes NOT VALID
-- ============================================================================
-- Found by the first restore drill (2026-11-20): public.tasks restored 0 of 112 rows.
-- tasks_future_only is CHECK (due_at > now() - interval '30 days'), a time-dependent
-- expression. Production still holds the rows that were valid when they were written
-- (82 of 112 are older than the window today), and pg_dump emits a VALIDATED check
-- constraint inline in CREATE TABLE, so on restore COPY re-checks every historic row
-- against today's clock, the first old row aborts the COPY and the whole table is lost.
-- This happens on any target, Supabase included: it is a property of the dump.
--
-- Fix: the same constraint re-created NOT VALID. Semantics for the application are
-- unchanged (INSERT and UPDATE are still checked); only existing rows are not
-- re-validated, and pg_dump then emits the constraint AFTER the table data, so a
-- restore loads the rows first. Verified on the drill instance: 112/112 rows round-trip,
-- an INSERT with a 90-day-old due_at is still rejected.
-- Safe to run twice: a second run sees convalidated = false and does nothing.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_def text;
begin
  select pg_get_constraintdef(c.oid) into v_def
  from pg_constraint c
  where c.conrelid = 'public.tasks'::regclass and c.conname = 'tasks_future_only' and c.contype = 'c' and c.convalidated;
  if v_def is null then
    return;  -- already NOT VALID (or absent): nothing to do
  end if;
  execute 'alter table public.tasks drop constraint tasks_future_only';
  execute 'alter table public.tasks add constraint tasks_future_only ' || v_def || ' not valid';
end
$$;
