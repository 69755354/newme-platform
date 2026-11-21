-- S33 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s33-sync-advance-stage.sql
-- Runs in one transaction that is rolled back. Every id below is invented.
-- Covers public.sync_advance_lead_stage_from_sheet(uuid, text, text): forward only up to quotation_submitted, one audited
-- business_events row per step with the system actor marker, refusals (first-contact gate, terminal, archived, already
-- there, unknown lead), invalid targets raise, idempotent second call, and the service-role-only ACL the gate pins.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S33 ASSERT_FAIL %', p_name; end if;
  raise notice 'S33 ASSERT_OK %', p_name;
end $$;

-- 0. before: the routine does not exist (the gate's PRIOR predicate). The replayed history database has already applied
--    S33, so it is dropped first.
drop function if exists public.sync_advance_lead_stage_from_sheet(uuid, text, text);
select pg_temp.expect(to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)') is null, 'prior-state-routine-absent');

-- 1. the migration applies, and can be applied a second time
\ir ../../supabase/migrations/20261121100000_sync_advance_lead_stage_from_sheet.sql
\ir ../../supabase/migrations/20261121100000_sync_advance_lead_stage_from_sheet.sql

-- 2. after: exactly the posture the gate's PRESENT predicate pins
select pg_temp.expect((select count(*) = 1 and bool_and(p.prosecdef)
    and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
    and bool_and(p.prosrc like '%system:drive_sync%')
    and bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE'))
    and bool_and(not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    and bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE'))
  from pg_catalog.pg_proc p where p.oid = to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)')),
  'present-state-definer-service-role-only');

-- fixtures
insert into public.leads (id, source, customer_name, phone, created_at, stage, quality) values
  ('33000000-0000-4000-8000-000000000001', 'website', 'S33 new no contact', '+971500000331', now(), 'new', 'good'),
  ('33000000-0000-4000-8000-000000000002', 'website', 'S33 new with contact', '+971500000332', now(), 'new', 'good'),
  ('33000000-0000-4000-8000-000000000003', 'website', 'S33 contacted', '+971500000333', now(), 'contacted', 'normal'),
  ('33000000-0000-4000-8000-000000000004', 'website', 'S33 negotiation', '+971500000334', now(), 'negotiation', 'good'),
  ('33000000-0000-4000-8000-000000000005', 'website', 'S33 won', '+971500000335', now(), 'won', 'good'),
  ('33000000-0000-4000-8000-000000000006', 'website', 'S33 archived', '+971500000336', now(), 'contacted', 'good');
update public.leads set final_status = 'won' where id = '33000000-0000-4000-8000-000000000005';
update public.leads set archived = true, archived_at = now() where id = '33000000-0000-4000-8000-000000000006';
insert into public.follow_up_logs (lead_id, contact_time, contact_result)
  values ('33000000-0000-4000-8000-000000000002', now(), 'answered, asked for a quotation');

-- 3. a new lead without a complete contact is refused as a reason, not an error, and nothing moves
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000001') ->> 'reason') = 'first_contact_gate'
  and (select stage = 'new' from public.leads where id = '33000000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.business_events where lead_id = '33000000-0000-4000-8000-000000000001' and event_type = 'stage_change'),
  'new-without-contact-refused-unchanged');

-- 4. a new lead with contact and quality walks new -> ... -> quotation_submitted, four audited steps, system actor
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000002', 'quotation_submitted', 'run-33') ->> 'advanced')::boolean
  and (select stage = 'quotation_submitted' and final_status is null from public.leads where id = '33000000-0000-4000-8000-000000000002'),
  'new-with-contact-advanced-to-quotation');
select pg_temp.expect((select count(*) = 4 and bool_and(user_id is null) and bool_and(event_data ->> 'actor' = 'system:drive_sync')
    and bool_and(event_data ->> 'run_id' = 'run-33')
  from public.business_events where lead_id = '33000000-0000-4000-8000-000000000002' and event_type = 'stage_change'),
  'four-audit-rows-system-actor');
select pg_temp.expect((select array_agg(event_data ->> 'to' order by event_data ->> 'to') = array['contacted','quotation_submitted','requirement_confirmed','solution_submitted']
  from public.business_events where lead_id = '33000000-0000-4000-8000-000000000002' and event_type = 'stage_change'),
  'audit-rows-cover-every-step');

-- 5. a second call is a no-op (already there), no extra audit rows
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000002') ->> 'reason') = 'already_at_or_past'
  and (select count(*) = 4 from public.business_events where lead_id = '33000000-0000-4000-8000-000000000002' and event_type = 'stage_change'),
  'second-call-idempotent');

-- 6. a contacted lead needs three steps
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000003') ->> 'advanced')::boolean
  and (select stage = 'quotation_submitted' from public.leads where id = '33000000-0000-4000-8000-000000000003')
  and (select count(*) = 3 from public.business_events where lead_id = '33000000-0000-4000-8000-000000000003' and event_type = 'stage_change'),
  'contacted-advanced-three-steps');

-- 7. never backwards: a lead already past the target stays put
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000004') ->> 'reason') = 'already_at_or_past'
  and (select stage = 'negotiation' from public.leads where id = '33000000-0000-4000-8000-000000000004'),
  'never-backwards');

-- 8. never from won / lost, never archived, unknown lead
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000005') ->> 'reason') = 'terminal'
  and (select stage = 'won' and final_status = 'won' from public.leads where id = '33000000-0000-4000-8000-000000000005'),
  'won-untouched');
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000006') ->> 'reason') = 'archived'
  and (select stage = 'contacted' from public.leads where id = '33000000-0000-4000-8000-000000000006'),
  'archived-untouched');
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-0000000000ff') ->> 'reason') = 'not_found', 'unknown-lead');

-- 9. targets other than the funnel stages up to quotation_submitted raise (never won / lost / new / garbage / NULL)
do $$
declare t text;
begin
  foreach t in array array['won', 'lost', 'new', 'negotiation', 'bogus'] loop
    begin
      perform public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000003', t);
      raise exception 'S33 ASSERT_FAIL target-% should raise', t;
    exception when raise_exception then
      if sqlerrm <> 'INVALID_TARGET_STAGE' then raise; end if;
    end;
  end loop;
  begin
    perform public.sync_advance_lead_stage_from_sheet('33000000-0000-4000-8000-000000000003', null);
    raise exception 'S33 ASSERT_FAIL null target should raise';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_TARGET_STAGE' then raise; end if;
  end;
  raise notice 'S33 ASSERT_OK invalid-targets-raise';
end $$;

rollback;
