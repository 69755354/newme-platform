-- S46 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s46-milestone-reopen.sql
-- Runs in one transaction that is rolled back. Every id below is invented; the profiles are the replay fixtures.
-- Covers check_milestone_order(): a reopened milestone (completed_at null) no longer counts as done, so an earlier step can
-- be added after it; a completed later milestone still blocks an earlier one; posture unchanged.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S46 ASSERT_FAIL %', p_name; end if;
  raise notice 'S46 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

-- 0a. put the routine back in the state before S46 (the replayed database already carries the migration)
\ir ../../supabase/migrations/20261123100000_s39_stage_rules_relaxed.sql

insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date, assigned_to) values
  ('46000000-0000-4000-8000-000000000011', 'website', 'S46 reopened',  '+971500004611', now(), 'new', null, 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('46000000-0000-4000-8000-000000000012', 'website', 'S46 completed', '+971500004612', now(), 'new', null, 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
insert into public.follow_up_logs (lead_id, contact_time, contact_result) values
  ('46000000-0000-4000-8000-000000000011', now(), 'answered'),
  ('46000000-0000-4000-8000-000000000012', now(), 'answered');
insert into public.lead_milestones (lead_id, milestone_key, notes) values
  ('46000000-0000-4000-8000-000000000011', 'first_contact', 'n'),
  ('46000000-0000-4000-8000-000000000011', 'quotation', 'skip'),
  ('46000000-0000-4000-8000-000000000012', 'first_contact', 'n'),
  ('46000000-0000-4000-8000-000000000012', 'quotation', 'skip');
update public.lead_milestones set completed_at = null
 where lead_id = '46000000-0000-4000-8000-000000000011' and milestone_key = 'quotation';

-- 0. before: the reopened step still blocks an earlier one (the gap)
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.lead_milestones (lead_id, milestone_key, notes) values ('46000000-0000-4000-8000-000000000011', 'solution', 'x')$q$) like 'Cannot go backwards%', 'prior-state-reopened-step-blocks-earlier-step');

\ir ../../supabase/migrations/20261126000200_s46_milestone_order_ignores_reopened.sql
\ir ../../supabase/migrations/20261126000200_s46_milestone_order_ignores_reopened.sql

select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef) and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
  and bool_and(p.prosrc like '%completed_at IS NOT NULL%') and bool_and(p.prosrc like '%skipping a milestone going forward%')
  from pg_proc p where p.oid = to_regprocedure('public.check_milestone_order()')), 'posture-and-markers');

-- 1. reopened quotation: an earlier step can be added
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.lead_milestones (lead_id, milestone_key, notes) values ('46000000-0000-4000-8000-000000000011', 'solution', 'x')$q$) = 'ok', 'reopened-step-does-not-block-earlier-step');
-- 2. completed quotation: an earlier step is still refused, a later one still allowed
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.lead_milestones (lead_id, milestone_key, notes) values ('46000000-0000-4000-8000-000000000012', 'solution', 'x')$q$) like 'Cannot go backwards%', 'completed-step-still-blocks-earlier-step');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.lead_milestones (lead_id, milestone_key, notes) values ('46000000-0000-4000-8000-000000000012', 'meeting', 'x')$q$) = 'ok', 'later-step-still-allowed');

rollback;
