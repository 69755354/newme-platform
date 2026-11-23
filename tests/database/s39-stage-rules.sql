-- S39 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s39-stage-rules.sql
-- Runs in one transaction that is rolled back. Every id below is invented; the profiles are the replay fixtures.
-- Covers the relaxed stage rules: a stage can be skipped going forward (trigger and audited routine), never backwards;
-- leaving "new" needs one complete contact record and no quality rating; milestones may skip forward, never backwards;
-- the follow-up rule and the won / lost paths are unchanged; posture of the seven replaced routines.
begin;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S39 ASSERT_FAIL %', p_name; end if;
  raise notice 'S39 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;

\ir ../../supabase/migrations/20261123100000_s39_stage_rules_relaxed.sql
\ir ../../supabase/migrations/20261123100000_s39_stage_rules_relaxed.sql

-- posture: definer / invoker modes, pinned search_path, the transition routine keeps its grants, the markers are present
select pg_temp.expect((select count(*) = 7 and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
  from pg_proc p where p.oid in (to_regprocedure('public.trg_check_stage_sequence()'), to_regprocedure('public.trg_check_first_contact_gate()'),
    to_regprocedure('public.check_milestone_order()'), to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)'),
    to_regprocedure('public.trg_enforce_first_contact_milestone()'), to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)'),
    to_regprocedure('public.recomplete_lead_milestone(uuid,text,text)'))), 'search-path-pinned');
select pg_temp.expect((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.check_milestone_order()'))
  and (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)'))
  and not (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.trg_check_stage_sequence()'))
  and not (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.trg_check_first_contact_gate()')), 'security-modes-unchanged');
select pg_temp.expect(has_function_privilege('authenticated', to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)'), 'EXECUTE')
  and not has_function_privilege('anon', to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)'), 'EXECUTE'), 'transition-grants-unchanged');
select pg_temp.expect(has_function_privilege('service_role', to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)'), 'EXECUTE')
  and not has_function_privilege('authenticated', to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)'), 'EXECUTE')
  and (select prosrc like '%system:drive_sync%' and prosrc not like '%v_lead.quality%' from pg_proc where oid = to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)'))
  and (select position('lead_quality' in prosrc) = 0 from pg_proc where oid = to_regprocedure('public.trg_enforce_first_contact_milestone()')), 'sheet-and-milestone-gate-posture');
select pg_temp.expect((select prosrc like '%S39: a stage may be skipped%' from pg_proc where oid = to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)'))
  and (select prosrc like '%Stage can only move forward%' from pg_proc where oid = to_regprocedure('public.trg_check_stage_sequence()'))
  and (select prosrc not like '%NEW.quality%' from pg_proc where oid = to_regprocedure('public.trg_check_first_contact_gate()'))
  and (select prosrc like '%skipping a milestone going forward%' from pg_proc where oid = to_regprocedure('public.check_milestone_order()')), 'markers-present');

insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date, assigned_to) values
  ('39000000-0000-4000-8000-000000000001', 'website', 'S39 skip no quality', '+971500003901', now(), 'new', null, 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('39000000-0000-4000-8000-000000000002', 'website', 'S39 no contact',      '+971500003902', now(), 'new', 'good', 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('39000000-0000-4000-8000-000000000003', 'website', 'S39 backwards',       '+971500003903', now(), 'quotation_submitted', 'good', 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('39000000-0000-4000-8000-000000000004', 'website', 'S39 routine skip',    '+971500003904', now(), 'new', null, 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('39000000-0000-4000-8000-000000000005', 'website', 'S39 no followup',     '+971500003905', now(), 'contacted', 'good', 'call', current_date + 1, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
insert into public.follow_up_logs (lead_id, contact_time, contact_result) values
  ('39000000-0000-4000-8000-000000000001', now(), 'answered'),
  ('39000000-0000-4000-8000-000000000004', now(), 'answered');

-- 1. trigger: new -> quotation_submitted in one update, no quality, one contact record
-- (the call and the state check are separate statements: a sub-select in the same expression reads the state from before the call)
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.leads set stage = 'quotation_submitted' where id = '39000000-0000-4000-8000-000000000001'$q$) = 'ok', 'trigger-skips-forward-update-ok');
select pg_temp.expect((select stage = 'quotation_submitted' from public.leads where id = '39000000-0000-4000-8000-000000000001'), 'trigger-skips-forward-without-quality');
-- 2. leaving new still needs one complete contact record
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.leads set stage = 'contacted' where id = '39000000-0000-4000-8000-000000000002'$q$) like 'first_contact gate:%'
  and (select stage = 'new' from public.leads where id = '39000000-0000-4000-8000-000000000002'), 'trigger-still-needs-one-contact');
-- 3. never backwards
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.leads set stage = 'contacted' where id = '39000000-0000-4000-8000-000000000003'$q$) like 'Stage can only move forward%'
  and (select stage = 'quotation_submitted' from public.leads where id = '39000000-0000-4000-8000-000000000003'), 'trigger-refuses-backwards');
-- 4. won / lost reachable from any open stage, and the follow-up rule still stops an update with no next action
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.leads set next_followup_date = null where id = '39000000-0000-4000-8000-000000000005'$q$) like 'Next follow-up date is required%', 'followup-rule-unchanged');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.leads set stage = 'lost', final_status = 'lost' where id = '39000000-0000-4000-8000-000000000005'$q$) = 'ok', 'lost-still-reachable');

-- 5. milestones: skip forward allowed, backwards refused
insert into public.lead_milestones (lead_id, milestone_key, notes) values ('39000000-0000-4000-8000-000000000004', 'first_contact', 'n');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.lead_milestones (lead_id, milestone_key, notes) values ('39000000-0000-4000-8000-000000000004', 'quotation', 'skip')$q$) = 'ok', 'milestone-skip-insert-ok');
select pg_temp.expect((select current_milestone = 'quotation' from public.leads where id = '39000000-0000-4000-8000-000000000004'), 'milestone-skips-forward');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.lead_milestones (lead_id, milestone_key, notes) values ('39000000-0000-4000-8000-000000000004', 'solution', 'back')$q$) like 'Cannot go backwards%', 'milestone-refuses-backwards');

-- 5b. sheet routine: a new lead with a contact record and no quality rating now advances
insert into public.leads (id, source, customer_name, phone, created_at, stage, quality, next_action, next_followup_date) values
  ('39000000-0000-4000-8000-000000000006', 'website', 'S39 sheet no quality', '+971500003906', now(), 'new', null, 'call', current_date + 1);
insert into public.follow_up_logs (lead_id, contact_time, contact_result) values ('39000000-0000-4000-8000-000000000006', now(), 'answered');
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('39000000-0000-4000-8000-000000000006') ->> 'advanced')::boolean, 'sheet-routine-advances-without-quality');
select pg_temp.expect((public.sync_advance_lead_stage_from_sheet('39000000-0000-4000-8000-000000000002') ->> 'reason') = 'first_contact_gate', 'sheet-routine-still-needs-contact');

-- 5c. re-completing a reopened milestone after a skip: quotation (skipped over solution) is reopened and completed again
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.lead_milestones set completed_at = null where lead_id = '39000000-0000-4000-8000-000000000004' and milestone_key = 'quotation'$q$) = 'ok', 'reopen-quotation');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.recomplete_lead_milestone('39000000-0000-4000-8000-000000000004', 'quotation', 'again')$q$) = 'ok', 'recomplete-after-skip');
reset role;

-- 6. the audited routine, as a signed-in salesperson: skip forward without quality, backwards refused
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((public.transition_lead_stage('39000000-0000-4000-8000-000000000004', 'new', 'quotation_submitted', 'quote sent', '39000000-0000-4000-8000-0000000000a1') ->> 'stage') = 'quotation_submitted', 'routine-skips-forward-without-quality');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.transition_lead_stage('39000000-0000-4000-8000-000000000004', 'quotation_submitted', 'contacted', 'back', '39000000-0000-4000-8000-0000000000a2')$q$) like 'Invalid stage transition%', 'routine-refuses-backwards');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.transition_lead_stage('39000000-0000-4000-8000-000000000002', 'new', 'quotation_submitted', 'no contact', '39000000-0000-4000-8000-0000000000a3')$q$) like 'First Contact requirements%', 'routine-still-needs-one-contact');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.transition_lead_stage('39000000-0000-4000-8000-000000000004', 'quotation_submitted', 'negotiation', '', '39000000-0000-4000-8000-0000000000a4')$q$) like 'Stage note is required%', 'routine-note-rule-unchanged');
reset role;

rollback;
