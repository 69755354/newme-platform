-- NO_ROLLBACK: widens one CHECK constraint by one value ('warning'); every old value is kept, the guard refuses the file if production allows a value this list lacks, and no row is changed. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S16 (follow-up) - the no-answer alert needs notifications.type = 'warning'
-- ============================================================================
-- The "customer did not answer 3 times" cron (src/app/api/cron/check-no-answer) inserts
-- type 'warning', related_type 'lead'. notifications_type_check never listed 'warning',
-- every insert failed with SQLSTATE 23514 and the cron swallowed the error, so the
-- alert was never delivered. Written drop-then-add so the file can be applied again, with the
-- same guard as 20261112100000 (it raises if the live constraint allows a value this list
-- lacks). This file adds no policy.
-- 20261112100000 lists 'warning' as well, so on a database that applies both files in order this
-- one changes nothing. It exists as the regular way to bring a database that already recorded
-- the earlier version of 20261112100000 (the staging database) up to date, because the
-- migration tooling never re-runs a recorded version.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $guard$
declare
  v_type_allowed constant text[] := array[
    'lead_created', 'lead_stage_change', 'lead_stage_changed', 'lead_assigned',
    'quote_created', 'followup_reminder', 'follow_up_reminder', 'follow_up_overdue',
    'contract_signed', 'contract_rejected', 'contract_superseded', 'contract_approved',
    'contract_pending_approval', 'payment_received', 'payment_overdue', 'payment_due',
    'first_payment_reminder', 'kpi_target_set', 'team_member_added',
    'contract_created', 'reminder', 'warning'];
  v_def     text;
  v_missing text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
  if v_def is not null then
    select array_agg(m[1]) into v_missing
      from regexp_matches(v_def, '''([^'']+)''::character varying', 'g') as m
     where m[1] <> all (v_type_allowed);
    if v_missing is not null then
      raise exception 'notifications_type_check currently allows values this migration would drop: %', v_missing;
    end if;
  end if;
end
$guard$;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type::text = any (array[
    'lead_created'::character varying, 'lead_stage_change'::character varying,
    'lead_stage_changed'::character varying, 'lead_assigned'::character varying,
    'quote_created'::character varying, 'followup_reminder'::character varying,
    'follow_up_reminder'::character varying, 'follow_up_overdue'::character varying,
    'contract_signed'::character varying, 'contract_rejected'::character varying,
    'contract_superseded'::character varying, 'contract_approved'::character varying,
    'contract_pending_approval'::character varying, 'payment_received'::character varying,
    'payment_overdue'::character varying, 'payment_due'::character varying,
    'first_payment_reminder'::character varying, 'kpi_target_set'::character varying,
    'team_member_added'::character varying, 'contract_created'::character varying,
    'reminder'::character varying, 'warning'::character varying]::text[]));

-- ---------------------------------------------------------------------------
-- Manual undo (not part of the release flow; production changes go through the gate)
-- ---------------------------------------------------------------------------
-- Drop notifications_type_check and add it back without 'warning' (the list in
-- 20261112100000_notification_constraints_and_lead_owner_contracts.sql). Delete any
-- notification row with type 'warning' first, or the add fails.
