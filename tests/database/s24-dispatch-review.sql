-- S24 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s24-dispatch-review.sql
-- Runs in one transaction that is rolled back. Every name, phone and link below is invented.
-- The replay floor already holds the accounts used here (admin aaaa..., boss bbbb..., operator 0a0a...,
-- finance ffff..., sales eeee... and cccc...); this script only adds leads and the rows under test.
begin;
alter table public.leads add column if not exists archived boolean not null default false;
alter table public.leads drop constraint if exists leads_lead_status_check;
alter table public.leads drop constraint if exists leads_source_check;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S24 ASSERT_FAIL %', p_name; end if;
  raise notice 'S24 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.sqlstate_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

-- 0. the file can be applied a second time without error and without changing a row
\ir ../../supabase/migrations/20261119300000_lead_dispatch_and_review.sql
\ir ../../supabase/migrations/20261119300000_lead_dispatch_and_review.sql

-- 1. phone helpers (the same cases are run against src/lib/lead-contact.mjs by a unit test)
select pg_temp.expect(public.dispatch_phone_norm('0501234567') = '+971501234567', 'norm-local-mobile');
select pg_temp.expect(public.dispatch_phone_norm('050 123 4567') = '+971501234567', 'norm-spaced');
select pg_temp.expect(public.dispatch_phone_norm('501234567') = '+971501234567', 'norm-no-zero');
select pg_temp.expect(public.dispatch_phone_norm('042345678') = '+97142345678', 'norm-landline');
select pg_temp.expect(public.dispatch_phone_norm('00971501234567') = '+971501234567', 'norm-00-prefix');
select pg_temp.expect(public.dispatch_phone_norm('971501234567') = '+971501234567', 'norm-971-prefix');
select pg_temp.expect(public.dispatch_phone_norm('+971 050 123 4567') = '+971501234567', 'norm-stray-trunk-zero');
select pg_temp.expect(public.dispatch_phone_norm('+44 7911 123456') = '+447911123456', 'norm-international');
select pg_temp.expect(public.dispatch_phone_norm('12345') is null and public.dispatch_phone_norm('abc') is null
  and public.dispatch_phone_norm('') is null and public.dispatch_phone_norm(null) is null
  and public.dispatch_phone_norm('+971 4 12') is null and public.dispatch_phone_norm('+') is null, 'norm-rejects-unreadable');
select pg_temp.expect(public.dispatch_phone_flag(null) = 'empty' and public.dispatch_phone_flag('  ') = 'empty'
  and public.dispatch_phone_flag('12345') = 'invalid' and public.dispatch_phone_flag('0501234567') = 'ok'
  and public.dispatch_phone_flag('+971500000000') = 'suspect' and public.dispatch_phone_flag('0501234567890') = 'invalid'
  and public.dispatch_phone_flag('+447911123456') = 'ok' and public.dispatch_phone_flag('+449876543210') = 'suspect'
  and public.dispatch_phone_flag('0587654321') = 'ok', 'flag-values');

-- 2. fixtures
insert into public.leads (id, source, customer_name, phone, email, assigned_to, created_at) values
  ('24000000-0000-4000-8000-000000000001', 'website', 'Amira Hassan',  '+971501110001', 'amira.h@clientmail.ae', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:00:00Z'),
  ('24000000-0000-4000-8000-000000000002', 'website', 'Bilal Karim',   '+971501110002', null,                      null,                                     '2026-11-01T08:05:00Z'),
  ('24000000-0000-4000-8000-000000000003', 'website', 'C',             '+971501110003', null,                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:10:00Z'),
  ('24000000-0000-4000-8000-000000000004', 'website', 'Dana Youssef',  null,            null,                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:15:00Z'),
  ('24000000-0000-4000-8000-000000000005', 'website', 'Eman Saleh',    '12345',         null,                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:20:00Z'),
  ('24000000-0000-4000-8000-000000000006', 'website', 'Farid Nasser',  '+971500000000', null,                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:25:00Z'),
  ('24000000-0000-4000-8000-000000000007', 'website', 'Test Customer', '+971501110007', null,                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:30:00Z'),
  ('24000000-0000-4000-8000-000000000008', 'website', 'Contest Winner','+971501110008', null,                      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:35:00Z'),
  ('24000000-0000-4000-8000-000000000009', 'website', 'Archived Person','+971501110009', null,                     'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-01T08:40:00Z');
update public.leads set archived = true where id = '24000000-0000-4000-8000-000000000009';

-- 3. evaluation of single leads
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000001') as e1 \gset
select pg_temp.expect(:'e1'::jsonb->>'status' = 'delivered' and (:'e1'::jsonb->>'changed')::boolean, 'complete-assigned-lead-is-delivered');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000001') as e1b \gset
select pg_temp.expect(:'e1b'::jsonb->>'status' = 'delivered' and not (:'e1b'::jsonb->>'changed')::boolean
  and (select count(*) = 1 from public.lead_dispatch_events where lead_id = '24000000-0000-4000-8000-000000000001'), 'evaluation-is-idempotent');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000002');
select pg_temp.expect((select status = 'unassigned' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000002'), 'no-owner-is-unassigned');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000003');
select pg_temp.expect((select status = 'missing_intake_data' and missing_fields = array['customer_name'] and routing_note like 'missing:%' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000003'), 'short-name-is-missing-intake-data');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000004');
select pg_temp.expect((select status = 'missing_intake_data' and missing_fields = array['phone_or_email'] from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000004'), 'no-contact-is-missing-intake-data');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000005');
select pg_temp.expect((select status = 'review_phone' and phone_flag = 'invalid' and phone_norm is null from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000005'), 'unreadable-phone-is-review-phone');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000006');
select pg_temp.expect((select status = 'review_phone' and phone_flag = 'suspect' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000006'), 'suspect-phone-is-review-phone');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000007');
select pg_temp.expect((select status = 'excluded_test' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000007'), 'test-name-is-excluded');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000008');
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000008'), 'contest-is-not-a-test-word');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000009') as e9 \gset
select pg_temp.expect(:'e9'::jsonb->>'status' = 'skipped' and not exists (select 1 from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000009'), 'archived-lead-is-skipped');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.evaluate_lead_dispatch('24000000-0000-4000-8000-0000000000ff')$q$) = '22023', 'unknown-lead-is-refused');
-- the lead row is never touched
select pg_temp.expect((select count(*) = 0 from public.leads where id::text like '24000000-%' and updated_at > now() + interval '1 second'), 'evaluation-does-not-write-leads');

-- 4. duplicates: only the newer lead is flagged
insert into public.leads (id, source, customer_name, phone, email, assigned_to, created_at, meta_leadgen_id) values
  ('24000000-0000-4000-8000-000000000011', 'website', 'Amira H.',   '050 111 0001', null, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-02T08:00:00Z', null),
  ('24000000-0000-4000-8000-000000000012', 'website', 'Amira Hass', '+971509990012', 'AMIRA.H@clientmail.ae', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-02T08:05:00Z', null),
  ('24000000-0000-4000-8000-000000000013', 'meta',    'Leila Omar', '+971509990013', null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-11-02T08:10:00Z', null),
  ('24000000-0000-4000-8000-000000000014', 'meta',    'Leila O.',   '0509990013', null, 'cccccccc-cccc-cccc-cccc-cccccccccccc', '2026-11-02T08:15:00Z', null);
select public.evaluate_lead_dispatch(id) from public.leads where id::text like '24000000-0000-4000-8000-00000000001%' order by created_at;
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000011'), 'newer-phone-duplicate-in-review');
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000001'), 'original-is-not-flagged');
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000012'), 'email-duplicate-matches-case-insensitively');
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000014')
  and (select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000013'), 'local-format-phone-duplicate-in-review');
select pg_temp.expect((select duplicate_of_lead_id = '24000000-0000-4000-8000-000000000001' and decision = 'pending' and matched_on = array['phone']
  and candidate_ids = array['24000000-0000-4000-8000-000000000001']::uuid[] from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000011'), 'review-row-names-the-original');
select pg_temp.expect((select matched_on @> array['email'] from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000012'), 'review-row-names-the-match-kind');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000011');
select pg_temp.expect((select count(*) = 1 from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000011'), 'second-evaluation-keeps-one-review');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.duplicate_reviews (lead_id, duplicate_of_lead_id) values ('24000000-0000-4000-8000-000000000011', '24000000-0000-4000-8000-000000000001')$q$) = '23505', 'one-pending-review-per-lead');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.duplicate_reviews (lead_id, duplicate_of_lead_id, decision) values ('24000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000002', 'pending')$q$) = '23514', 'lead-cannot-duplicate-itself');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.duplicate_reviews (lead_id, duplicate_of_lead_id, decision) values ('24000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001', 'merged')$q$) = '23514', 'decision-needs-a-stamp');

-- 5. duplicate decisions
select id as rv11 from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000011' \gset
select id as rv12 from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000012' \gset
select id as rv14 from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000014' \gset
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.resolve_duplicate_review(%L, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'merged', null)$q$, :'rv11')) = '42501', 'sales-cannot-resolve');
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.resolve_duplicate_review(%L, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'merged', null)$q$, :'rv11')) = '42501', 'finance-cannot-resolve');
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.resolve_duplicate_review(%L, '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'maybe', null)$q$, :'rv11')) = '22023', 'unknown-decision-refused');
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.resolve_duplicate_review(%L, '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'invalid', 'no')$q$, :'rv11')) = '22023', 'invalid-needs-a-real-note');
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.resolve_duplicate_review(%L, '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'kept_separate', '')$q$, :'rv11')) = '22023', 'kept-separate-needs-a-note');
select public.resolve_duplicate_review(:'rv11', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'merged', 'same person, second form') as r1 \gset
select pg_temp.expect((:'r1'::jsonb->>'changed')::boolean and (select decision = 'merged' and decided_by = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a' and decided_at is not null and notes = 'same person, second form'
  from public.duplicate_reviews where id = :'rv11'::uuid), 'operator-merges');
select pg_temp.expect((select status = 'duplicate_not_dispatched' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000011'), 'merged-lead-is-not-dispatched');
select public.resolve_duplicate_review(:'rv11', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'merged', 'same person, second form') as r1b \gset
select pg_temp.expect(not (:'r1b'::jsonb->>'changed')::boolean, 'resolve-is-idempotent');
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.resolve_duplicate_review(%L, '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'kept_separate', 'two people')$q$, :'rv11')) = '22023', 'decided-review-needs-reopening-first');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000011');
select pg_temp.expect((select status = 'duplicate_not_dispatched' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000011'), 'decision-survives-re-evaluation');
select public.resolve_duplicate_review(:'rv12', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'kept_separate', 'family members, different people') as r2 \gset
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000012'), 'admin-keeps-both-and-lead-moves-on');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000012');
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000012')
  and (select count(*) = 1 from public.duplicate_reviews where lead_id = '24000000-0000-4000-8000-000000000012'), 'kept-pair-is-not-flagged-again');
select public.resolve_duplicate_review(:'rv14', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'invalid', 'spam submission by a bot') as r3 \gset
select pg_temp.expect((select status = 'duplicate_not_dispatched' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000014'), 'boss-marks-invalid');
select public.reopen_duplicate_review(:'rv11', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'merged by mistake') as ro1 \gset
select pg_temp.expect((select decision = 'pending' and decided_at is null and decided_by is null from public.duplicate_reviews where id = :'rv11'::uuid)
  and (select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000011'), 'reopen-returns-to-review');
select pg_temp.expect(pg_temp.sqlstate_of(format($q$select public.reopen_duplicate_review(%L, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'let me in')$q$, :'rv11')) = '42501', 'sales-cannot-reopen');
-- a corrected number makes the candidate disappear: the open review is withdrawn by the system
update public.leads set phone = '+971509990099' where id = '24000000-0000-4000-8000-000000000011';
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000011');
select pg_temp.expect((select decision = 'withdrawn' and decided_by is null and decided_at is not null from public.duplicate_reviews where id = :'rv11'::uuid)
  and (select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000011'), 'vanished-candidate-withdraws-the-review');

-- 6. other decisions
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000006', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'confirm_phone', null)$q$) = '42501', 'sales-cannot-decide');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000006', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'do_magic', null)$q$) = '22023', 'unknown-action-refused');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000005', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'confirm_phone', null)$q$) = '22023', 'unreadable-phone-cannot-be-confirmed');
select public.dispatch_decide('24000000-0000-4000-8000-000000000006', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'confirm_phone', 'called the customer, number is right') as d1 \gset
select pg_temp.expect((:'d1'::jsonb->>'changed')::boolean and (select status = 'delivered' and phone_confirmed_norm = '+971500000000' and decided_by is not null from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000006'), 'confirm-phone-moves-the-lead-on');
select public.dispatch_decide('24000000-0000-4000-8000-000000000006', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'confirm_phone', null) as d1b \gset
select pg_temp.expect(not (:'d1b'::jsonb->>'changed')::boolean, 'confirm-phone-is-idempotent');
update public.leads set phone = '+971500000001' where id = '24000000-0000-4000-8000-000000000006';
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000006');
select pg_temp.expect((select status = 'review_phone' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000006'), 'a-different-number-is-reviewed-again');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000003', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'release_missing', 'short')$q$) = '22023', 'release-needs-a-written-reason');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000001', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'release_missing', 'nothing is missing here at all')$q$) = '22023', 'nothing-to-release-is-refused');
select public.dispatch_decide('24000000-0000-4000-8000-000000000003', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'release_missing', 'approved initial hand-over by the manager') as d2 \gset
select pg_temp.expect((select status = 'delivered' and release_reason is not null and release_by = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a' and missing_fields = array['customer_name'] from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000003'), 'release-lets-the-lead-move-on');
select public.dispatch_decide('24000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'revoke_release', null);
select pg_temp.expect((select status = 'missing_intake_data' and release_reason is null from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000003'), 'revoke-release-returns-to-missing');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000008', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'mark_test', '')$q$) = '22023', 'mark-test-needs-a-reason');
select public.dispatch_decide('24000000-0000-4000-8000-000000000008', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'mark_test', 'internal trial entry');
select pg_temp.expect((select status = 'excluded_test' and test_mark = 'manual' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000008'), 'manual-test-mark');
select public.dispatch_decide('24000000-0000-4000-8000-000000000007', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'unmark_test', 'real customer called Test');
select pg_temp.expect((select status = 'delivered' and test_mark = 'not_test' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000007'), 'unmark-test-stops-the-pattern');
select public.evaluate_lead_dispatch('24000000-0000-4000-8000-000000000007');
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000007'), 'not-test-survives-re-evaluation');
select public.dispatch_decide('24000000-0000-4000-8000-000000000002', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'note', 'waiting for the area manager');
select pg_temp.expect((select admin_note = 'waiting for the area manager' and status = 'unassigned' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000002'), 'admin-note-is-kept');
select pg_temp.expect((select count(*) > 0 and bool_and(actor is not null) from public.lead_dispatch_events where kind = 'decision' and lead_id = '24000000-0000-4000-8000-000000000003'), 'decisions-are-in-the-history');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.lead_dispatch_events set note = 'edited'$q$) = 'P0001' or pg_temp.sqlstate_of($q$update public.lead_dispatch_events set note = 'edited'$q$) = '23514', 'history-cannot-be-edited');

-- 7. sweep: new leads and changed leads, bounded, idempotent
insert into public.leads (id, source, customer_name, phone, assigned_to, created_at) values
  ('24000000-0000-4000-8000-000000000021', 'whatsapp', 'WhatsApp Ad Lead', '+971507770021', null, now()),
  ('24000000-0000-4000-8000-000000000022', 'whatsapp', 'Old Lead',         '+971507770022', null, '2020-01-05T00:00:00Z');
select public.sweep_lead_dispatch(now() - interval '7 days', 100) as s1 \gset
select pg_temp.expect((select status = 'unassigned' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000021')
  and not exists (select 1 from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000022')
  and (:'s1'::jsonb->>'evaluated')::int >= 1, 'sweep-picks-up-new-leads-inside-the-window-only');
update public.leads set assigned_to = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' where id = '24000000-0000-4000-8000-000000000021';
-- inside one transaction now() does not move, so the evaluation time is set back to stand for "evaluated earlier"
update public.lead_dispatch_state set evaluated_at = now() - interval '1 hour' where lead_id = '24000000-0000-4000-8000-000000000021';
select public.sweep_lead_dispatch(now() - interval '7 days', 100);
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000021'), 'sweep-refreshes-changed-leads');
select public.sweep_lead_dispatch(now() - interval '7 days', 100) as s3 \gset
select pg_temp.expect((:'s3'::jsonb->>'evaluated')::int = 0, 'sweep-is-idempotent');
insert into public.leads (id, source, customer_name, phone, assigned_to, created_at) values
  ('24000000-0000-4000-8000-000000000023', 'import', 'Old Lead Three', '+971507770023', null, '2020-01-06T00:00:00Z'),
  ('24000000-0000-4000-8000-000000000024', 'import', 'Old Lead Four',  '+971507770024', null, '2020-01-07T00:00:00Z'),
  ('24000000-0000-4000-8000-000000000025', 'import', 'Old Lead Five',  '+971507770025', null, '2020-01-08T00:00:00Z'),
  ('24000000-0000-4000-8000-000000000026', 'import', 'Old Lead Six',   '+971507770026', null, '2020-01-09T00:00:00Z');
select public.sweep_lead_dispatch('1970-01-01', 3) as s4 \gset
select pg_temp.expect((:'s4'::jsonb->>'evaluated')::int = 3, 'sweep-respects-the-limit');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.sweep_lead_dispatch(null, 10)$q$) = '22023', 'sweep-needs-a-start-time');
select public.sweep_lead_dispatch('1970-01-01', 1000);
select pg_temp.expect(exists (select 1 from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000022'), 'backfill-window-reaches-old-leads');

-- 8. row-level security
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) > 0 from public.lead_dispatch_state)
  and (select count(*) = 0 from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000013'), 'sales-reads-own-lead-states-only');
select pg_temp.expect((select count(*) = 0 from public.duplicate_reviews) and (select count(*) = 0 from public.lead_dispatch_events), 'sales-reads-no-reviews-or-history');
select pg_temp.expect(pg_temp.sqlstate_of($q$update public.lead_dispatch_state set status = 'delivered'$q$) = '42501', 'client-cannot-update-state');
select pg_temp.expect(pg_temp.sqlstate_of($q$insert into public.duplicate_reviews (lead_id, duplicate_of_lead_id) values ('24000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000001')$q$) = '42501', 'client-cannot-insert-review');
select pg_temp.expect(pg_temp.sqlstate_of($q$delete from public.lead_dispatch_events$q$) = '42501', 'client-cannot-delete-history');
select pg_temp.expect(pg_temp.sqlstate_of($q$select public.dispatch_decide('24000000-0000-4000-8000-000000000002', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'reevaluate', null)$q$) = '42501', 'client-cannot-call-the-routines');
select set_config('request.jwt.claims', '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 0 from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000001')
  and (select count(*) > 0 from public.lead_dispatch_state where lead_id = '24000000-0000-4000-8000-000000000013'), 'other-sales-sees-only-theirs');
select set_config('request.jwt.claims', '{"sub":"ffffffff-ffff-ffff-ffff-ffffffffffff","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) = 0 from public.lead_dispatch_state) and (select count(*) = 0 from public.duplicate_reviews), 'finance-sees-nothing');
select set_config('request.jwt.claims', '{"sub":"0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) >= 15 from public.lead_dispatch_state) and (select count(*) >= 3 from public.duplicate_reviews) and (select count(*) > 10 from public.lead_dispatch_events), 'operator-sees-everything');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) >= 15 from public.lead_dispatch_state) and (select count(*) >= 3 from public.duplicate_reviews), 'boss-sees-everything');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
select pg_temp.expect((select count(*) >= 15 from public.lead_dispatch_state) and (select count(*) >= 3 from public.duplicate_reviews), 'admin-sees-everything-like-boss');
reset role;
update public.profiles set password_changed_at = now() + interval '1 hour' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
do $$ declare n integer; begin
  begin select count(*) into n from public.lead_dispatch_state; exception when others then n := 0; end;
  if n <> 0 then raise exception 'S24 ASSERT_FAIL stale-session-reads-nothing'; end if;
  raise notice 'S24 ASSERT_OK stale-session-reads-nothing';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update public.profiles set password_changed_at = null where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role anon;
select pg_temp.expect(pg_temp.sqlstate_of($q$select count(*) from public.lead_dispatch_state$q$) = '42501', 'anon-has-no-access');
reset role;

-- 9. grants and function properties
select pg_temp.expect(not has_table_privilege('authenticated', 'public.lead_dispatch_state', 'insert,update,delete')
  and not has_table_privilege('authenticated', 'public.duplicate_reviews', 'insert,update,delete')
  and not has_table_privilege('authenticated', 'public.lead_dispatch_events', 'insert,update,delete')
  and not has_table_privilege('service_role', 'public.lead_dispatch_state', 'insert,update,delete')
  and not has_table_privilege('service_role', 'public.duplicate_reviews', 'insert,update,delete')
  and not has_table_privilege('service_role', 'public.lead_dispatch_events', 'insert,update,delete')
  and has_table_privilege('service_role', 'public.lead_dispatch_state', 'select')
  and not has_table_privilege('anon', 'public.lead_dispatch_state', 'select'), 'table-grants');
select pg_temp.expect((select count(*) = 3 and bool_and(c.relrowsecurity) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('lead_dispatch_state', 'duplicate_reviews', 'lead_dispatch_events')), 'rls-on');
select pg_temp.expect((select count(*) = 3 from pg_trigger t where t.tgname = 'trg_require_current_session' and t.tgrelid in ('public.lead_dispatch_state'::regclass, 'public.duplicate_reviews'::regclass, 'public.lead_dispatch_events'::regclass)), 'session-guard-triggers');
select pg_temp.expect((select count(*) = 6 and bool_and(p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]
    and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('evaluate_lead_dispatch', 'dispatch_decide', 'resolve_duplicate_review', 'reopen_duplicate_review', 'sweep_lead_dispatch', 'dispatch_record_event')), 'definer-functions-pinned-and-service-only');
select pg_temp.expect((select bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]) from pg_proc p where p.pronamespace = 'public'::regnamespace
  and p.proname in ('dispatch_phone_norm', 'dispatch_phone_flag', 'dispatch_is_test_pattern', 'trg_lead_dispatch_events_append_only')), 'helpers-pin-search-path');
select pg_temp.expect((select count(*) = 3 and bool_and(pg_get_expr(pol.polqual, pol.polrelid) ~* 'select public\.session_token_is_current|select session_token_is_current')
  from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname in ('lead_dispatch_state', 'duplicate_reviews', 'lead_dispatch_events') and pol.polpermissive
  and pol.polname not like '%sales%'), 'session-check-is-wrapped-staff-policies');
select pg_temp.expect((select bool_and(pg_get_expr(pol.polqual, pol.polrelid) ~* 'select public\.session_token_is_current|select session_token_is_current')
  from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname in ('lead_dispatch_state', 'duplicate_reviews', 'lead_dispatch_events')), 'session-check-is-wrapped-everywhere');
-- no existing table was changed by this batch: leads has no new column
select pg_temp.expect(not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name in ('dispatch_status', 'routing_note', 'is_test', 'phone_norm')), 'leads-table-is-untouched');
rollback;
