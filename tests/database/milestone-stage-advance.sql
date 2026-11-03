-- S3 #1 behaviour scenario for 20261104120100_milestone_completion_advances_lead_stage.sql.
-- Runs inside one transaction that is ROLLED BACK; for a throwaway database
-- built from supabase/replay/production-schema-baseline.sql only.
-- Prints "name|value" lines that tests/security/milestone-stage-advance.test.mjs checks.
begin;
insert into auth.users(id) values ('aaaaaaaa-0000-4000-8000-000000000001');
insert into public.profiles(id, role, full_name, is_active)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'sales', 'QA stage', true)
on conflict (id) do update set role = 'sales', is_active = true;

-- L1: normal lead. L2: lead with no contact record (gate not met).
insert into public.leads(id, source, customer_name, phone, assigned_to, stage, quality) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'offline', 'Stage test 1', '+971501234561', 'aaaaaaaa-0000-4000-8000-000000000001', 'new', 'pending'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'offline', 'Stage test 2', '+971501234562', 'aaaaaaaa-0000-4000-8000-000000000001', 'new', 'good'),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'offline', 'Stage test 3', '+971501234563', 'aaaaaaaa-0000-4000-8000-000000000001', 'new', 'good');

insert into public.follow_up_logs(lead_id, contact_type, summary, contact_time, contact_result, user_id)
values ('bbbbbbbb-0000-4000-8000-000000000001', 'phone', 'called', now() - interval '1 hour', 'answered', 'aaaaaaaa-0000-4000-8000-000000000001'),
       ('bbbbbbbb-0000-4000-8000-000000000003', 'phone', 'called', now() - interval '1 hour', 'answered', 'aaaaaaaa-0000-4000-8000-000000000001');
update public.leads set quality = 'good' where id = 'bbbbbbbb-0000-4000-8000-000000000001';

-- A system-written first_contact without a note does not move the lead.
insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes)
values ('bbbbbbbb-0000-4000-8000-000000000003', 'first_contact', null, null);
select 'unconfirmed_first_contact|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000003';
-- Confirming it (the milestone route's manual confirmation) does.
update public.lead_milestones set notes = 'confirmed', completed_at = now()
 where lead_id = 'bbbbbbbb-0000-4000-8000-000000000003' and milestone_key = 'first_contact';
select 'confirmed_first_contact|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000003';

insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes)
values ('bbbbbbbb-0000-4000-8000-000000000001', 'first_contact', 'aaaaaaaa-0000-4000-8000-000000000001', 'called');
select 'after_first_contact|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000001';

insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'basic_info', 'aaaaaaaa-0000-4000-8000-000000000001', 'n'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'drawings', 'aaaaaaaa-0000-4000-8000-000000000001', 'n');
select 'after_drawings|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000001';

insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'requirements', 'aaaaaaaa-0000-4000-8000-000000000001', 'n');
select 'after_requirements|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000001';
insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'solution', 'aaaaaaaa-0000-4000-8000-000000000001', 'n');
insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'quotation', 'aaaaaaaa-0000-4000-8000-000000000001', 'n');
insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'meeting', 'aaaaaaaa-0000-4000-8000-000000000001', 'n');
select 'after_all|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000001';
select 'stage_events|' || count(*) from public.business_events
 where lead_id = 'bbbbbbbb-0000-4000-8000-000000000001' and event_type = 'stage_change' and event_data->>'source' = 'milestone';

-- Idempotent: re-running changes nothing.
select 'rerun|' || public.advance_lead_stage_from_milestones('bbbbbbbb-0000-4000-8000-000000000001', null);
select 'stage_events_after_rerun|' || count(*) from public.business_events
 where lead_id = 'bbbbbbbb-0000-4000-8000-000000000001' and event_type = 'stage_change';

-- Gate not met (no contact record): the milestone row is written by legacy
-- data paths only, but even then the stage must stay `new` without an error.
alter table public.lead_milestones disable trigger trg_enforce_first_contact_milestone;
insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes)
values ('bbbbbbbb-0000-4000-8000-000000000002', 'first_contact', 'aaaaaaaa-0000-4000-8000-000000000001', 'legacy');
alter table public.lead_milestones enable trigger trg_enforce_first_contact_milestone;
insert into public.lead_milestones(lead_id, milestone_key, completed_by, notes) values
  ('bbbbbbbb-0000-4000-8000-000000000002', 'basic_info', 'aaaaaaaa-0000-4000-8000-000000000001', 'n');
select 'gate_not_met|' || stage from public.leads where id = 'bbbbbbbb-0000-4000-8000-000000000002';

-- A won lead is never touched.
update public.leads set stage = 'won', final_status = 'won' where id = 'bbbbbbbb-0000-4000-8000-000000000003';
select 'won_rerun|' || public.advance_lead_stage_from_milestones('bbbbbbbb-0000-4000-8000-000000000003', null);

-- Clients cannot call the helper.
select 'authenticated_can_execute|' || has_function_privilege('authenticated', 'public.advance_lead_stage_from_milestones(uuid, uuid)', 'EXECUTE');
rollback;
