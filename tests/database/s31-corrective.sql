-- S31 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -q -f tests/database/s31-corrective.sql
-- Runs in one transaction that is rolled back. Every name, phone, link and message below is invented.
-- Covers the four S31 corrections: (a) null-safe phone confirmation, (b) canonical phone matching,
-- (c) re-evaluation of a newer lead when its older duplicate candidate changes, (d) promotion of a backfilled
-- WhatsApp history message when its live delivery arrives.
begin;
alter table public.leads add column if not exists archived boolean not null default false;
alter table public.leads add column if not exists source_channel text;
alter table public.leads add column if not exists source_platform text;
alter table public.leads add column if not exists ad_id text;
alter table public.leads add column if not exists meta_ad_id text;
alter table public.leads add column if not exists lead_status text;
alter table public.leads add column if not exists next_action text;
alter table public.leads add column if not exists next_followup_date date;
alter table public.leads add column if not exists first_touch_at timestamptz;
alter table public.leads drop constraint if exists leads_lead_status_check;
alter table public.leads drop constraint if exists leads_source_check;

create or replace function pg_temp.expect(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'S31 ASSERT_FAIL %', p_name; end if;
  raise notice 'S31 ASSERT_OK %', p_name;
end $$;

-- 0. the file applies on top of S24 and S25 and can be applied a second time
\ir ../../supabase/migrations/20261120100000_dispatch_and_history_corrections.sql
\ir ../../supabase/migrations/20261120100000_dispatch_and_history_corrections.sql
select pg_temp.expect((select count(*) = 5 and bool_and(p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]
    and p.prosrc like '%S31 corrective v1%'
    and has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
    and not has_function_privilege('anon', p.oid, 'execute'))
  from pg_proc p where p.oid in (to_regprocedure('public.evaluate_lead_dispatch(uuid,uuid)'), to_regprocedure('public.dispatch_decide(uuid,uuid,text,text)'),
    to_regprocedure('public.sweep_lead_dispatch(timestamptz,integer)'), to_regprocedure('public.dispatch_reevaluate_dependents(uuid,uuid)'),
    to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)'))), 'routines-replaced-pinned-and-service-only');

-- (a) a suspect phone stays in review on every evaluation until exactly that number is confirmed
insert into public.leads (id, source, customer_name, phone, assigned_to, created_at) values
  ('31000000-0000-4000-8000-000000000001', 'website', 'Hala Mansour', '+971500000000', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-05T08:00:00Z');
select public.evaluate_lead_dispatch('31000000-0000-4000-8000-000000000001');
select pg_temp.expect((select status = 'review_phone' and phone_confirmed_norm is null from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000001'), 'a-first-evaluation-reviews-phone');
select public.evaluate_lead_dispatch('31000000-0000-4000-8000-000000000001') as a2 \gset
select pg_temp.expect(:'a2'::jsonb->>'status' = 'review_phone'
  and (select status = 'review_phone' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000001'), 'a-second-evaluation-without-confirmation-still-reviews-phone');
update public.lead_dispatch_state set evaluated_at = now() - interval '1 hour' where lead_id = '31000000-0000-4000-8000-000000000001';
update public.leads set customer_name = 'Hala Mansoor' where id = '31000000-0000-4000-8000-000000000001';
select public.sweep_lead_dispatch(now() - interval '7 days', 100);
select pg_temp.expect((select status = 'review_phone' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000001'), 'a-sweep-re-evaluation-still-reviews-phone');
select public.dispatch_decide('31000000-0000-4000-8000-000000000001', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'confirm_phone', 'called the customer, number is right');
select pg_temp.expect((select status = 'delivered' and phone_confirmed_norm = '+971500000000' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000001'), 'a-confirmation-moves-the-lead-on');
select public.evaluate_lead_dispatch('31000000-0000-4000-8000-000000000001');
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000001'), 'a-confirmation-survives-re-evaluation');

-- (b) canonical phone matching: a landline written with a stray trunk zero after +971 is the same number,
-- although wa_phone_key gives two different keys for the two spellings
select pg_temp.expect(public.dispatch_phone_norm('043456781') = public.dispatch_phone_norm('+971 0 4 345 6781')
  and public.wa_phone_key('043456781') is distinct from public.wa_phone_key('+971 0 4 345 6781'), 'b-fixture-keys-really-disagree');
insert into public.leads (id, source, customer_name, phone, assigned_to, created_at) values
  ('31000000-0000-4000-8000-000000000011', 'website', 'Omar Rashed',  '043456781',         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-05T09:00:00Z'),
  ('31000000-0000-4000-8000-000000000012', 'website', 'Omar R.',      '+971 0 4 345 6781', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-05T09:05:00Z'),
  ('31000000-0000-4000-8000-000000000013', 'website', 'Other Person', '043456782',         'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-05T09:10:00Z');
select public.evaluate_lead_dispatch(id) from public.leads where id::text like '31000000-0000-4000-8000-00000000001%' order by created_at;
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000012')
  and (select candidate_ids = array['31000000-0000-4000-8000-000000000011']::uuid[] and matched_on = array['phone'] from public.duplicate_reviews
        where lead_id = '31000000-0000-4000-8000-000000000012' and decision = 'pending'), 'b-canonical-twin-is-found');
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000013')
  and (select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000011'), 'b-a-different-number-and-the-original-are-not-flagged');

-- (c1) an older candidate marked as a test: the decision re-evaluates the newer lead at once
insert into public.leads (id, source, customer_name, phone, assigned_to, created_at) values
  ('31000000-0000-4000-8000-000000000021', 'website', 'Rania Fouad', '+971503130021', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-06T08:00:00Z'),
  ('31000000-0000-4000-8000-000000000022', 'website', 'Rania F.',    '0503130021',    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-06T08:05:00Z');
select public.evaluate_lead_dispatch(id) from public.leads where id::text like '31000000-0000-4000-8000-00000000002%' order by created_at;
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000022'), 'c1-newer-lead-in-review');
select public.dispatch_decide('31000000-0000-4000-8000-000000000021', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'mark_test', 'internal trial entry') as c1 \gset
select pg_temp.expect((:'c1'::jsonb->>'dependents_reevaluated')::int >= 1
  and (select status = 'excluded_test' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000021')
  and (select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000022')
  and (select decision = 'withdrawn' from public.duplicate_reviews where lead_id = '31000000-0000-4000-8000-000000000022'), 'c1-test-mark-withdraws-the-newer-review');
-- unmarking the original makes the pair a question again
select public.dispatch_decide('31000000-0000-4000-8000-000000000021', '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'unmark_test', 'real customer after all');
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000022')
  and (select count(*) = 1 from public.duplicate_reviews where lead_id = '31000000-0000-4000-8000-000000000022' and decision = 'pending'), 'c1-unmark-test-reopens-the-question');

-- (c2) an older candidate archived through the application: only the candidate's row changes. The newer lead's
-- own updated_at is older than its last evaluation, so the S24 sweep alone would never revisit it.
insert into public.leads (id, source, customer_name, phone, email, assigned_to, created_at, updated_at) values
  ('31000000-0000-4000-8000-000000000031', 'website', 'Samir Haddad', '+971503130031', 'samir.h@clientmail.ae', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-07T08:00:00Z', now() - interval '2 hours'),
  ('31000000-0000-4000-8000-000000000032', 'website', 'Samir H.',     '+971503130032', 'SAMIR.H@clientmail.ae', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-07T08:05:00Z', now() - interval '2 hours');
select public.evaluate_lead_dispatch(id) from public.leads where id::text like '31000000-0000-4000-8000-00000000003%' order by created_at;
select pg_temp.expect((select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000032'), 'c2-newer-lead-in-review');
update public.lead_dispatch_state set evaluated_at = now() - interval '1 hour' where lead_id in ('31000000-0000-4000-8000-000000000031', '31000000-0000-4000-8000-000000000032');
update public.leads set archived = true where id = '31000000-0000-4000-8000-000000000031';
select pg_temp.expect((select updated_at < (select evaluated_at from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000032')
  from public.leads where id = '31000000-0000-4000-8000-000000000032'), 'c2-fixture-newer-lead-itself-unchanged');
select public.sweep_lead_dispatch(now() - interval '7 days', 1000);
select pg_temp.expect((select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000032')
  and (select decision = 'withdrawn' from public.duplicate_reviews where lead_id = '31000000-0000-4000-8000-000000000032'), 'c2-archived-candidate-reaches-the-newer-lead-through-the-sweep');
select public.sweep_lead_dispatch(now() - interval '7 days', 1000);
select pg_temp.expect((select count(*) = 1 from public.duplicate_reviews where lead_id = '31000000-0000-4000-8000-000000000032') and (select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000032'), 'c2-sweep-settles');

-- (c3) an older lead edited so that it now matches a newer one: the sweep refreshes the older lead and then
-- re-evaluates its newer twin
insert into public.leads (id, source, customer_name, phone, assigned_to, created_at, updated_at) values
  ('31000000-0000-4000-8000-000000000041', 'website', 'Yara Khalil', '+971503130041', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-08T08:00:00Z', now() - interval '2 hours'),
  ('31000000-0000-4000-8000-000000000042', 'website', 'Yara K.',     '+971503130042', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '2026-11-08T08:05:00Z', now() - interval '2 hours');
select public.evaluate_lead_dispatch(id) from public.leads where id::text like '31000000-0000-4000-8000-00000000004%' order by created_at;
select pg_temp.expect((select bool_and(status = 'delivered') from public.lead_dispatch_state where lead_id::text like '31000000-0000-4000-8000-00000000004%'), 'c3-two-separate-leads');
update public.lead_dispatch_state set evaluated_at = now() - interval '1 hour' where lead_id::text like '31000000-0000-4000-8000-00000000004%';
update public.leads set phone = '+971503130042' where id = '31000000-0000-4000-8000-000000000041';
select public.sweep_lead_dispatch(now() - interval '7 days', 1000) as c3 \gset
select pg_temp.expect((:'c3'::jsonb->>'dependents_reevaluated')::int >= 1
  and (select status = 'duplicate_review' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000042')
  and (select status = 'delivered' from public.lead_dispatch_state where lead_id = '31000000-0000-4000-8000-000000000041'), 'c3-edited-older-lead-opens-the-newer-review');

-- (d) a message first stored by the history backfill is promoted when its live delivery arrives
create or replace function pg_temp.live(p_id text, p_at text, p_phone text default '971503139001', p_body text default null,
  p_clid text default null) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'customer_phone', p_phone,
    'direction', 'inbound', 'source', 'messages', 'message_id', p_id, 'message_type', 'text', 'occurred_at', p_at,
    'body', p_body, 'body_kind', 'text', 'profile_name', 'Lina Saad',
    'referral', case when p_clid is not null then jsonb_build_object('ctwa_clid', p_clid, 'source_type', 'ad', 'source_id', '120200000000001',
      'source_url', 'https://fb.me/example', 'headline', 'Spring offer') end))
$$;
select count(*) as leads_before from public.leads \gset
select public.record_whatsapp_history_messages(jsonb_build_array(jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789',
  'customer_phone', '971503139001', 'direction', 'inbound', 'message_id', 'wamid.S31D1', 'message_type', 'text',
  'occurred_at', '2026-11-19T10:00:00Z', 'body', 'Hello from history', 'body_kind', 'text'))) as h1 \gset
select pg_temp.expect((:'h1'::jsonb->>'inserted')::int = 1 and (select backfilled from public.whatsapp_message_events where message_id = 'wamid.S31D1')
  and (select count(*) = :leads_before from public.leads), 'd-history-row-stored-backfilled-without-a-lead');
select public.record_whatsapp_ad_event(pg_temp.live('wamid.S31D1', '2026-11-19T10:00:00Z', p_body => 'Hello live', p_clid => 'S31clickid0000000001')) as d1 \gset
select pg_temp.expect(not (:'d1'::jsonb->>'duplicate')::boolean and (:'d1'::jsonb->>'promoted')::boolean
  and (:'d1'::jsonb->>'lead_created')::boolean and (:'d1'::jsonb->>'attributed')::boolean and (:'d1'::jsonb->>'queued')::boolean, 'd-live-delivery-promotes-instead-of-returning-early');
select pg_temp.expect((select not backfilled and body = 'Hello live' and source = 'messages' and referral_ctwa_clid = 'S31clickid0000000001'
  and referral_source_id = '120200000000001' from public.whatsapp_message_events where message_id = 'wamid.S31D1'), 'd-row-carries-the-live-fields');
select pg_temp.expect((select c.lead_id = (:'d1'::jsonb->>'lead_id')::uuid and c.first_inbound_at = '2026-11-19T10:00:00Z' and c.inbound_count = 1 and c.is_ad
  and c.first_ctwa_clid = 'S31clickid0000000001'
  from public.whatsapp_conversations c where c.waba_id = '987654321' and c.customer_key = '971503139001'), 'd-conversation-timing-and-first-click');
select pg_temp.expect((select l.ctwa_clid = 'S31clickid0000000001' and l.wa_first_inbound_at = '2026-11-19T10:00:00Z' and l.source_channel = 'whatsapp_ctwa'
  from public.leads l where l.id = (:'d1'::jsonb->>'lead_id')::uuid)
  and (select count(*) = 1 from public.whatsapp_capi_events where lead_id = (:'d1'::jsonb->>'lead_id')::uuid and event_name = 'LeadSubmitted'), 'd-lead-attributed-and-queued-once');
-- the same live delivery again is a true duplicate and changes nothing
select public.record_whatsapp_ad_event(pg_temp.live('wamid.S31D1', '2026-11-19T10:00:00Z', p_body => 'Hello live', p_clid => 'S31clickid0000000001')) as d2 \gset
select pg_temp.expect((:'d2'::jsonb->>'duplicate')::boolean and (select count(*) = :leads_before + 1 from public.leads)
  and (select count(*) = 1 from public.whatsapp_capi_events where lead_id = (:'d1'::jsonb->>'lead_id')::uuid), 'd-second-live-delivery-is-a-duplicate');
-- a history copy arriving after the live row still leaves the live row alone
select public.record_whatsapp_history_messages(jsonb_build_array(jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789',
  'customer_phone', '971503139001', 'direction', 'inbound', 'message_id', 'wamid.S31D1', 'message_type', 'text',
  'occurred_at', '2026-11-19T10:00:00Z', 'body', 'history copy', 'body_kind', 'text'))) as h2 \gset
select pg_temp.expect((:'h2'::jsonb->>'duplicate')::int = 1 and (select not backfilled and body = 'Hello live' from public.whatsapp_message_events where message_id = 'wamid.S31D1'), 'd-history-after-live-is-a-noop');
-- a brand-new live message still goes through the ordinary insert path
select public.record_whatsapp_ad_event(pg_temp.live('wamid.S31D2', '2026-11-19T10:05:00Z', p_body => 'second')) as d3 \gset
select pg_temp.expect(not (:'d3'::jsonb->>'duplicate')::boolean and not (:'d3'::jsonb->>'promoted')::boolean and not (:'d3'::jsonb->>'lead_created')::boolean
  and (:'d3'::jsonb->>'lead_id')::uuid = (:'d1'::jsonb->>'lead_id')::uuid, 'd-new-live-message-uses-the-normal-path');
rollback;
