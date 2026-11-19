-- S23 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s23-opportunities-visits.sql
-- Runs in one transaction that is rolled back. Every name, phone and link below is invented.
-- The replay floor already holds the accounts used here (admin aaaa..., boss bbbb..., operator 0a0a...,
-- finance ffff..., sales eeee... and cccc...); this script only adds leads and the rows under test.
begin;
alter table public.leads add column if not exists archived boolean not null default false;
alter table public.leads drop constraint if exists leads_lead_status_check;
alter table public.leads drop constraint if exists leads_source_check;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S23 ASSERT_FAIL %', p_name; end if;
  raise notice 'S23 ASSERT_OK %', p_name;
end $$;

-- runs a statement and reports its SQLSTATE ('ok' when it succeeds); the savepoint keeps the transaction usable
create or replace function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

-- 0. the file can be applied a second time without error and without changing a row
\ir ../../supabase/migrations/20261119200000_opportunities_and_visit_reports.sql

insert into public.leads (id, source, customer_name, phone, assigned_to) values
  ('23000000-0000-4000-8000-000000000001', 'website', 'Test Lead One', '+971500000101', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('23000000-0000-4000-8000-000000000002', 'website', 'Test Lead Two', '+971500000102', 'cccccccc-cccc-cccc-cccc-cccccccccccc');

-- 1. stage configuration
select pg_temp.expect((select count(*) = 6 from public.opportunity_stages), 'six-initial-stages');
select pg_temp.expect((select array_agg(key order by key) = array['negotiation','quotation_sent','won']
  from public.opportunity_stages where requires_quote), 'quote-required-for-three-stages');
select pg_temp.expect((select bool_and(is_closed) from public.opportunity_stages where key in ('won','lost','on_hold'))
  and not (select bool_or(is_closed) from public.opportunity_stages where key in ('new','quotation_sent','negotiation')), 'closed-flags');

-- 2. opportunities: rules
insert into public.opportunities (id, lead_id, name, confirmed_requirement, owner_id, created_by)
  values ('23000000-0000-4000-8000-0000000000a1', '23000000-0000-4000-8000-000000000001', 'Villa A', '3 bedroom villa, full home control',
          'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
select pg_temp.expect((select stage = 'new' and not archived and opp_no is not null and created_at is not null from public.opportunities where id = '23000000-0000-4000-8000-0000000000a1'), 'opportunity-defaults');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set stage = 'won' where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'won-needs-quote-amount-and-link');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set stage = 'quotation_sent', quote_amount_aed = 1000 where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'quote-link-also-required');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set stage = 'quotation_sent', quote_amount_aed = 125000.50, quotation_link = 'https://files.example.test/q1.pdf' where id = '23000000-0000-4000-8000-0000000000a1'$q$) = 'ok', 'quote-stage-with-amount-and-link');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set quote_amount_aed = -1 where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'negative-amount-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set decision_target = date '2019-12-31' where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'date-before-2020-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set decision_target = date '2101-01-01' where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'date-after-2100-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set quotation_link = 'javascript:alert(1)' where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'non-https-link-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set name = '   ' where id = '23000000-0000-4000-8000-0000000000a1'$q$) = '23514', 'blank-name-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.opportunities (lead_id, name, confirmed_requirement) values ('23000000-0000-4000-8000-000000000001', 'villa a', 'again')$q$) = '23505', 'duplicate-name-same-lead-ignores-case');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.opportunities (lead_id, name, confirmed_requirement) values ('23000000-0000-4000-8000-000000000002', 'Villa A', 'other customer')$q$) = 'ok', 'same-name-other-lead-allowed');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.opportunities (lead_id, name, confirmed_requirement, stage) values ('23000000-0000-4000-8000-000000000001', 'Villa B', 'x', 'nonsense')$q$) = '23503', 'unknown-stage-refused');
update public.opportunities set archived = true where id = '23000000-0000-4000-8000-0000000000a1';
select pg_temp.expect((select archived_at is not null from public.opportunities where id = '23000000-0000-4000-8000-0000000000a1'), 'archive-stamps-time');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.opportunities (lead_id, name, confirmed_requirement) values ('23000000-0000-4000-8000-000000000001', 'Villa A', 'name freed by archive')$q$) = 'ok', 'archived-name-can-be-reused');
update public.opportunity_stages set active = false where key = 'on_hold';
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set stage = 'on_hold' where lead_id = '23000000-0000-4000-8000-000000000002'$q$) = '23514', 'inactive-stage-cannot-be-chosen');
update public.opportunity_stages set active = true where key = 'on_hold';
update public.opportunities set archived = false where id = '23000000-0000-4000-8000-0000000000a1' and false;

-- 3. visit reports: due date, uniqueness, same-lead opportunity
insert into public.visit_reports (id, lead_id, planned_at, location, person_to_meet, purpose, owner_id, created_by) values
  ('23000000-0000-4000-8000-0000000000b1', '23000000-0000-4000-8000-000000000001', '2026-11-19T06:00:00Z', 'Showroom', 'Mr Test', 'Walkthrough', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('23000000-0000-4000-8000-0000000000b2', '23000000-0000-4000-8000-000000000001', '2026-11-20T06:00:00Z', 'Site', 'Mr Test', 'Survey', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('23000000-0000-4000-8000-0000000000b3', '23000000-0000-4000-8000-000000000001', '2026-11-21T06:00:00Z', 'Site', 'Mr Test', 'Saturday visit', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('23000000-0000-4000-8000-0000000000b4', '23000000-0000-4000-8000-000000000001', '2026-11-22T06:00:00Z', 'Site', 'Mr Test', 'Sunday visit', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('23000000-0000-4000-8000-0000000000b5', '23000000-0000-4000-8000-000000000002', '2026-11-18T06:00:00Z', 'Office', 'Ms Test', 'Intro', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc');
select pg_temp.expect((select report_due_at = '2026-11-20T05:30:00Z' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'due-thursday-plan-is-friday-0930-dubai');
select pg_temp.expect((select report_due_at = '2026-11-23T05:30:00Z' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b2'), 'due-friday-plan-is-monday');
select pg_temp.expect((select report_due_at = '2026-11-23T05:30:00Z' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b3'), 'due-saturday-plan-is-monday');
select pg_temp.expect((select report_due_at = '2026-11-23T05:30:00Z' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b4'), 'due-sunday-plan-is-monday');
select pg_temp.expect((select plan_approval = 'pending' and review_status = 'pending' and submitted_at is null and visit_no is not null from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'visit-defaults');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.visit_reports (lead_id, planned_at, purpose) values ('23000000-0000-4000-8000-000000000001', '2026-11-19T06:00:00Z', 'duplicate time')$q$) = '23505', 'same-lead-same-time-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.visit_reports (lead_id, planned_at, purpose, opportunity_id) values ('23000000-0000-4000-8000-000000000002', '2026-12-01T06:00:00Z', 'x', (select id from public.opportunities where lead_id = '23000000-0000-4000-8000-000000000001' limit 1))$q$) = '23503', 'opportunity-of-another-lead-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.visit_reports (lead_id, planned_at, purpose, opportunity_id) values ('23000000-0000-4000-8000-000000000001', '2026-12-02T06:00:00Z', 'with opportunity', (select id from public.opportunities where lead_id = '23000000-0000-4000-8000-000000000001' limit 1))$q$) = 'ok', 'opportunity-of-same-lead-allowed');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.visit_reports (lead_id, planned_at, purpose) values ('23000000-0000-4000-8000-000000000001', '2026-12-03T06:00:00Z', '')$q$) = '23514', 'blank-purpose-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.visit_reports set actual_start = '2026-11-19T07:00:00Z', actual_finish = '2026-11-19T06:00:00Z' where id = '23000000-0000-4000-8000-0000000000b1'$q$) = '23514', 'finish-before-start-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.visit_reports set evidence_link = 'ftp://x/y' where id = '23000000-0000-4000-8000-0000000000b1'$q$) = '23514', 'evidence-link-must-be-https');

-- 4. derived status: one table of cases
select pg_temp.expect(public.visit_report_status('pending', null, 'pending', '2026-11-20T05:30:00Z', '2026-11-19T10:00:00Z') = 'planned', 'status-planned');
select pg_temp.expect(public.visit_report_status('approved', null, 'pending', '2026-11-20T05:30:00Z', '2026-11-19T10:00:00Z') = 'approved', 'status-approved');
select pg_temp.expect(public.visit_report_status('approved', null, 'pending', '2026-11-20T05:30:00Z', '2026-11-20T05:30:01Z') = 'overdue', 'status-overdue-after-due');
select pg_temp.expect(public.visit_report_status('approved', null, 'pending', '2026-11-20T05:30:00Z', '2026-11-20T05:30:00Z') = 'approved', 'status-not-overdue-at-the-minute');
select pg_temp.expect(public.visit_report_status('pending', null, 'pending', '2026-11-20T05:30:00Z', '2026-11-25T00:00:00Z') = 'overdue', 'status-unapproved-plan-also-overdue');
select pg_temp.expect(public.visit_report_status('rejected', null, 'pending', '2026-11-20T05:30:00Z', '2026-11-25T00:00:00Z') = 'planned', 'status-rejected-plan-never-overdue');
select pg_temp.expect(public.visit_report_status('approved', '2026-11-19T12:00:00Z', 'pending', '2026-11-20T05:30:00Z', '2026-11-25T00:00:00Z') = 'completed', 'status-completed');
select pg_temp.expect(public.visit_report_status('approved', '2026-11-19T12:00:00Z', 'needs_fix', '2026-11-20T05:30:00Z', '2026-11-25T00:00:00Z') = 'completed', 'status-needs-fix-is-completed');
select pg_temp.expect(public.visit_report_status('approved', '2026-11-19T12:00:00Z', 'accepted', '2026-11-20T05:30:00Z', '2026-11-25T00:00:00Z') = 'reviewed', 'status-reviewed');

-- 5. workflow: plan approval
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'approved')$q$) = '42501', 'sales-cannot-approve');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b1', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'approved')$q$) = '42501', 'finance-cannot-approve');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b1', '99999999-9999-9999-9999-999999999999', 'approved')$q$) = '42501', 'inactive-admin-cannot-approve');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b1', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'maybe')$q$) = '22023', 'bad-decision-refused');
select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b1', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'approved', 'ok to go') as ap1 \gset
select pg_temp.expect((:'ap1'::jsonb->>'changed')::boolean and (select plan_approval = 'approved' and plan_approved_by = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a' and plan_approved_at is not null and plan_note = 'ok to go' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'operator-approves');
select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b1', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'approved', 'ok to go') as ap2 \gset
select pg_temp.expect(not (:'ap2'::jsonb->>'changed')::boolean, 'approval-is-idempotent');
select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'rejected', 'wrong day') as ap3 \gset
select pg_temp.expect((select plan_approval = 'rejected' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b2'), 'admin-rejects');
select public.visit_report_set_plan_approval('23000000-0000-4000-8000-0000000000b5', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'approved') as ap4 \gset
select pg_temp.expect((select plan_approval = 'approved' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b5'), 'boss-approves');
-- editing an approved plan sends it back for approval
update public.visit_reports set location = 'Showroom, second floor' where id = '23000000-0000-4000-8000-0000000000b5';
select pg_temp.expect((select plan_approval = 'pending' and plan_approved_by is null and plan_approved_at is null from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b5'), 'plan-edit-resets-approval');
-- editing only the report fields does not
update public.visit_reports set next_action = 'call back' where id = '23000000-0000-4000-8000-0000000000b1';
select pg_temp.expect((select plan_approval = 'approved' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'report-edit-keeps-approval');

-- 6. workflow: submit
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_submit('23000000-0000-4000-8000-0000000000b2', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$q$) = '22023', 'submit-needs-approved-plan');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_submit('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$q$) = '22023', 'submit-needs-actual-times-and-result');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_submit('23000000-0000-4000-8000-0000000000b1', 'cccccccc-cccc-cccc-cccc-cccccccccccc')$q$) = '42501', 'other-sales-cannot-submit');
update public.visit_reports set actual_start = '2026-11-19T06:10:00Z', actual_finish = '2026-11-19T07:00:00Z', result = 'Customer liked the layout', next_followup_date = '2026-11-25', evidence_link = 'https://files.example.test/photo1' where id = '23000000-0000-4000-8000-0000000000b1';
select public.visit_report_submit('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') as sb1 \gset
select pg_temp.expect((:'sb1'::jsonb->>'changed')::boolean and (select submitted_at is not null and review_status = 'pending' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'owner-submits');
select public.visit_report_submit('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') as sb2 \gset
select pg_temp.expect(not (:'sb2'::jsonb->>'changed')::boolean, 'submit-is-idempotent');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.visit_reports set result = 'changed after submit' where id = '23000000-0000-4000-8000-0000000000b1'$q$) = '23514', 'submitted-report-is-locked');

-- 7. workflow: review
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_review('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'accepted')$q$) = '42501', 'sales-cannot-review');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_review('23000000-0000-4000-8000-0000000000b5', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'accepted')$q$) = '22023', 'review-needs-a-submitted-report');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_review('23000000-0000-4000-8000-0000000000b1', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'needs_fix')$q$) = '22023', 'needs-fix-requires-a-note');
select public.visit_report_review('23000000-0000-4000-8000-0000000000b1', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'needs_fix', 'add the photo of the site') as rv1 \gset
select pg_temp.expect((select review_status = 'needs_fix' and reviewed_by is not null and reviewed_at is not null and review_notes = 'add the photo of the site' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'operator-asks-for-a-fix');
update public.visit_reports set evidence_link = 'https://files.example.test/photo2' where id = '23000000-0000-4000-8000-0000000000b1';
select pg_temp.expect((select evidence_link like '%photo2' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'needs-fix-unlocks-editing');
select public.visit_report_submit('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') as sb3 \gset
select pg_temp.expect((:'sb3'::jsonb->>'changed')::boolean and (select review_status = 'pending' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'resubmit-returns-to-review');
select public.visit_report_review('23000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'accepted', null, true) as rv2 \gset
select pg_temp.expect((select review_status = 'accepted' and action_done and public.visit_report_status(plan_approval, submitted_at, review_status, report_due_at, now()) = 'reviewed' from public.visit_reports where id = '23000000-0000-4000-8000-0000000000b1'), 'boss-accepts');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.visit_reports set result = 'late change' where id = '23000000-0000-4000-8000-0000000000b1'$q$) = '23514', 'accepted-report-is-locked');

-- 8. overdue reminders: warning type, once per recipient, only open unrejected visits
select public.flag_overdue_visit_reports('2026-11-24T00:00:00Z') as fl1 \gset
select pg_temp.expect((:'fl1'::jsonb->>'visits')::int = 3 and (:'fl1'::jsonb->>'notified')::int > 0, 'overdue-scan-finds-open-visits');
select pg_temp.expect((select count(*) = 0 from public.notifications where event_key like 'visit-overdue:' || '23000000-0000-4000-8000-0000000000b1' || '%'), 'submitted-visit-is-not-flagged');
select pg_temp.expect((select count(*) = 0 from public.notifications where event_key like 'visit-overdue:' || '23000000-0000-4000-8000-0000000000b2' || '%'), 'rejected-plan-is-not-flagged');
select pg_temp.expect((select count(*) > 0 and bool_and(type = 'warning' and related_type = 'lead') from public.notifications where event_key like 'visit-overdue:%'), 'reminders-use-existing-types');
select pg_temp.expect((select count(*) from public.notifications where event_key like 'visit-overdue:%' and user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') > 0
  and (select count(*) from public.notifications where event_key like 'visit-overdue:%' and user_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff') = 0
  and (select count(*) from public.notifications where event_key like 'visit-overdue:%' and user_id = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a') > 0, 'recipients-are-owner-and-staff-only');
select public.flag_overdue_visit_reports('2026-11-24T00:00:00Z') as fl2 \gset
select pg_temp.expect((:'fl2'::jsonb->>'notified')::int = 0, 'overdue-scan-is-idempotent');
select public.flag_overdue_visit_reports('2027-03-01T00:00:00Z') as fl3 \gset
select pg_temp.expect((:'fl3'::jsonb->>'visits')::int = 0, 'old-overdue-visits-are-not-reminded');

-- 9. row-level security
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) from public.opportunities) > 0 and (select count(*) = 0 from public.opportunities where lead_id = '23000000-0000-4000-8000-000000000002'), 'sales-sees-own-lead-opportunities-only');
select pg_temp.expect((select count(*) = 5 from public.visit_reports where lead_id = '23000000-0000-4000-8000-000000000001') and (select count(*) = 0 from public.visit_reports where lead_id = '23000000-0000-4000-8000-000000000002'), 'sales-sees-own-lead-visits-only');
select pg_temp.expect((select count(*) = 6 from public.opportunity_stages), 'sales-reads-stages');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.visit_reports (lead_id, planned_at, purpose) values ('23000000-0000-4000-8000-000000000001', '2026-12-09T06:00:00Z', 'client write')$q$) = '42501', 'client-cannot-insert');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.opportunities set name = 'hacked'$q$) = '42501', 'client-cannot-update');
select pg_temp.expect(pg_temp.sqlstate_of($q$delete from public.visit_reports$q$) = '42501', 'client-cannot-delete');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.visit_report_review('23000000-0000-4000-8000-0000000000b1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'accepted')$q$) = '42501', 'client-cannot-call-the-workflow-functions');
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 0 from public.visit_reports where lead_id = '23000000-0000-4000-8000-000000000001') and (select count(*) = 1 from public.visit_reports where lead_id = '23000000-0000-4000-8000-000000000002'), 'other-sales-sees-only-theirs');
select set_config('request.jwt.claims', '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 0 from public.visit_reports) and (select count(*) = 0 from public.opportunities), 'finance-sees-nothing');
select set_config('request.jwt.claims', '{"sub":"0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 6 from public.visit_reports) and (select count(*) >= 3 from public.opportunities), 'operator-sees-everything');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 6 from public.visit_reports) and (select count(*) >= 3 from public.opportunities), 'boss-sees-everything');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 6 from public.visit_reports) and (select count(*) >= 3 from public.opportunities), 'admin-sees-everything');
-- a token issued before the last password change reads nothing
reset role;
update public.profiles set password_changed_at = now() + interval '1 hour' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
do $$ declare n integer; begin
  begin select count(*) into n from public.visit_reports; exception when others then n := 0; end;
  if n <> 0 then raise exception 'S23 ASSERT_FAIL stale-session-reads-nothing'; end if;
  raise notice 'S23 ASSERT_OK stale-session-reads-nothing';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update public.profiles set password_changed_at = null where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role anon;
select pg_temp.expect(pg_temp.sqlstate_of($q$select count(*) from public.visit_reports$q$) = '42501', 'anon-has-no-access');
reset role;

-- 10. grants and function properties
select pg_temp.expect(not has_table_privilege('authenticated', 'public.visit_reports', 'insert,update,delete')
  and not has_table_privilege('authenticated', 'public.opportunities', 'insert,update,delete')
  and not has_table_privilege('service_role', 'public.visit_reports', 'delete')
  and not has_table_privilege('service_role', 'public.opportunities', 'delete')
  and not has_table_privilege('anon', 'public.opportunity_stages', 'select'), 'table-grants');
select pg_temp.expect(not has_column_privilege('service_role', 'public.visit_reports', 'plan_approval', 'update')
  and not has_column_privilege('service_role', 'public.visit_reports', 'submitted_at', 'update')
  and not has_column_privilege('service_role', 'public.visit_reports', 'review_status', 'update')
  and not has_column_privilege('service_role', 'public.visit_reports', 'reviewed_by', 'update')
  and not has_column_privilege('service_role', 'public.visit_reports', 'report_due_at', 'update')
  and has_column_privilege('service_role', 'public.visit_reports', 'result', 'update')
  and not has_column_privilege('service_role', 'public.visit_reports', 'plan_approval', 'insert'), 'workflow-columns-are-not-writable-directly');
select pg_temp.expect((select count(*) = 3 and bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('opportunity_stages', 'opportunities', 'visit_reports')), 'rls-on');
select pg_temp.expect((select count(*) = 3 from pg_trigger t where t.tgname = 'trg_require_current_session' and t.tgrelid in ('public.opportunity_stages'::regclass, 'public.opportunities'::regclass, 'public.visit_reports'::regclass)), 'session-guard-triggers');
select pg_temp.expect((select count(*) = 4 and bool_and(p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]
    and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('visit_report_set_plan_approval', 'visit_report_review', 'visit_report_submit', 'flag_overdue_visit_reports')), 'definer-functions-pinned-and-service-only');
select pg_temp.expect((select bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]) from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('visit_report_status', 'next_working_day_0930', 'trg_opportunities_rules', 'trg_visit_reports_rules')), 'helpers-pin-search-path');
select pg_temp.expect((select count(*) = 5 and bool_and(pg_get_expr(pol.polqual, pol.polrelid) ~* 'select public\.session_token_is_current|select session_token_is_current')
  from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname in ('opportunity_stages', 'opportunities', 'visit_reports') and pol.polpermissive), 'session-check-is-wrapped');
rollback;
