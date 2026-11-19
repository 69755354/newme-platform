-- S18 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -f tests/database/s18-whatsapp-ctwa.sql
-- Runs in one transaction that is rolled back. The synthetic replay floor lacks some production
-- lead columns, so the prelude adds the ones this feature reads or writes (no-ops in production).
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
  if p_ok is not true then raise exception 'S18 ASSERT_FAIL %', p_name; end if;
  raise notice 'S18 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.ev(p_id text, p_dir text, p_at text, p_phone text default '971501234567',
  p_clid text default null, p_ad text default '120210000000001', p_name text default null) returns jsonb
language sql as $$
  select jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'customer_phone', p_phone,
    'direction', p_dir, 'source', case when p_dir = 'inbound' then 'messages' else 'smb_message_echoes' end,
    'message_id', p_id, 'message_type', 'text', 'occurred_at', p_at, 'profile_name', p_name,
    'referral', case when p_clid is null then null else jsonb_build_object('source_type', 'ad', 'source_id', p_ad,
      'source_url', 'https://fb.me/x', 'headline', 'Smart home', 'ctwa_clid', p_clid) end)
$$;

-- phone keys
select pg_temp.expect(public.wa_phone_key('+971 050 123 4567') = '971501234567'
  and public.wa_phone_key('0501234567') = '971501234567' and public.wa_phone_key('00971501234567') = '971501234567'
  and public.wa_phone_key('501234567') = '971501234567' and public.wa_phone_key('+447911123456') = '447911123456'
  and public.wa_phone_key('abc') is null, 'phone-key-matches-the-application-rules');

-- 1. ad message, unknown phone -> lead created with click id, ad id, source fields, no owner
select public.record_whatsapp_ad_event(pg_temp.ev('m1', 'inbound', '2026-11-18T08:00:00Z', p_clid => 'AfcClickIdAAAAA_01', p_name => 'Aisha')) as r1 \gset
select pg_temp.expect((:'r1'::jsonb->>'lead_created')::boolean and (:'r1'::jsonb->>'attributed')::boolean and (:'r1'::jsonb->>'queued')::boolean, 'ad-message-creates-and-attributes');
select l.id as lead1 from public.leads l where l.ctwa_clid = 'AfcClickIdAAAAA_01' \gset
select pg_temp.expect((select source = 'whatsapp' and source_channel = 'whatsapp_ctwa' and ad_id = '120210000000001' and meta_ad_id = '120210000000001'
  and phone = '+971501234567' and assigned_to is null and wa_first_inbound_at = '2026-11-18T08:00:00Z' and wa_first_reply_at is null
  and customer_name = 'Aisha' and wa_ad_headline = 'Smart home' from public.leads where id = :'lead1'), 'created-lead-fields');
select pg_temp.expect((select count(*) = 1 and min(event_name) = 'LeadSubmitted' and min(event_time) = extract(epoch from timestamptz '2026-11-18T08:00:00Z')::bigint
  from public.whatsapp_capi_events where lead_id = :'lead1'), 'lead-submitted-queued-once-at-click-time');

-- 2. replay of the same message, and a different message id with the same click id: still one lead
select public.record_whatsapp_ad_event(pg_temp.ev('m1', 'inbound', '2026-11-18T08:00:00Z', p_clid => 'AfcClickIdAAAAA_01')) as r2 \gset
select pg_temp.expect((:'r2'::jsonb->>'duplicate')::boolean and not (:'r2'::jsonb->>'lead_created')::boolean, 'replay-is-a-noop');
select public.record_whatsapp_ad_event(pg_temp.ev('m2', 'inbound', '2026-11-18T08:00:30Z', p_phone => '0501234567', p_clid => 'AfcClickIdBBBBB_02', p_ad => '120210000000002')) as r3 \gset
select pg_temp.expect((select count(*) = 1 from public.leads where phone = '+971501234567'), 'one-lead-per-phone-across-spellings');
select pg_temp.expect((select ctwa_clid = 'AfcClickIdAAAAA_01' and ad_id = '120210000000001' from public.leads where id = :'lead1')
  and (select count(*) = 1 from public.whatsapp_capi_events where lead_id = :'lead1'), 'first-attribution-is-never-overwritten');
select pg_temp.expect((select referral_ctwa_clid = 'AfcClickIdBBBBB_02' from public.whatsapp_message_events where message_id = 'm2'), 'later-click-id-is-logged-on-the-message-only');

-- 3. out-of-order: a reply that happened before the first message arrives later; first reply is after the first inbound
select public.record_whatsapp_ad_event(pg_temp.ev('o2', 'outbound', '2026-11-18T08:10:00Z')) as r4 \gset
select public.record_whatsapp_ad_event(pg_temp.ev('o1', 'outbound', '2026-11-18T08:05:00Z')) as r5 \gset
select public.record_whatsapp_ad_event(pg_temp.ev('o0', 'outbound', '2026-11-18T07:00:00Z')) as r6 \gset
select pg_temp.expect((select wa_first_reply_at = '2026-11-18T08:05:00Z' and wa_first_inbound_at = '2026-11-18T08:00:00Z' from public.leads where id = :'lead1'), 'first-reply-is-the-earliest-send-after-the-first-message-regardless-of-arrival-order');
select pg_temp.expect((select inbound_count = 2 and outbound_count = 3 from public.whatsapp_conversations where lead_id = :'lead1'), 'counts');

-- 4. phone matches an existing active lead: attach without creating, keep its owner and ad id
insert into public.leads (id, source, phone, customer_name, ad_id, assigned_to)
  values ('f1800000-0000-4000-8000-000000000001', 'website', '+971 55 777 1234', 'Existing', '999999999', (select id from public.profiles limit 1));
select public.record_whatsapp_ad_event(pg_temp.ev('x1', 'inbound', '2026-11-18T09:00:00Z', p_phone => '971557771234', p_clid => 'AfcClickIdCCCCC_03', p_ad => '120210000000003')) as r7 \gset
select pg_temp.expect(not (:'r7'::jsonb->>'lead_created')::boolean and (:'r7'::jsonb->>'attributed')::boolean
  and (select ctwa_clid = 'AfcClickIdCCCCC_03' and ad_id = '999999999' and assigned_to is not null and source = 'website' and customer_name = 'Existing'
       from public.leads where id = 'f1800000-0000-4000-8000-000000000001'), 'existing-lead-gets-click-id-and-keeps-its-owner-and-ad');

-- 5. archived lead is not matched: a new lead is created
update public.leads set archived = true where id = 'f1800000-0000-4000-8000-000000000001';
select public.record_whatsapp_ad_event(pg_temp.ev('x2', 'inbound', '2026-11-18T09:05:00Z', p_phone => '971557771234', p_clid => 'AfcClickIdDDDDD_04')) as r8 \gset
select pg_temp.expect((:'r8'::jsonb->>'lead_created')::boolean
  and (select count(*) = 2 from public.leads where phone in ('+971 55 777 1234', '+971557771234')), 'archived-lead-is-skipped');

-- 6. organic stranger: lead created, flagged non-ad, no click id, no outbox row; switch off honoured
select public.record_whatsapp_ad_event(pg_temp.ev('y1', 'inbound', '2026-11-18T10:00:00Z', p_phone => '971521112222')) as r9 \gset
select pg_temp.expect((select source_channel = 'whatsapp_direct' and ctwa_clid is null and ad_id is null from public.leads where phone = '+971521112222')
  and not exists (select 1 from public.whatsapp_capi_events e join public.leads l on l.id = e.lead_id where l.phone = '+971521112222'), 'organic-lead-flagged-non-ad');
select public.record_whatsapp_ad_event(pg_temp.ev('y2', 'inbound', '2026-11-18T10:00:00Z', p_phone => '971523334444'), false) as r10 \gset
select pg_temp.expect(not exists (select 1 from public.leads where phone = '+971523334444') and (:'r10'::jsonb->>'lead_id') is null, 'organic-switch-off-creates-no-lead');
-- an ad click later turns the organic lead into an attributed one
select public.record_whatsapp_ad_event(pg_temp.ev('y3', 'inbound', '2026-11-18T11:00:00Z', p_phone => '971521112222', p_clid => 'AfcClickIdEEEEE_05')) as r11 \gset
select pg_temp.expect((select ctwa_clid = 'AfcClickIdEEEEE_05' and source_channel = 'whatsapp_ctwa' from public.leads where phone = '+971521112222')
  and (select count(*) = 1 from public.leads where phone = '+971521112222'), 'later-ad-click-attributes-the-organic-lead');

-- 7. our own outbound to an unknown number never creates a lead
select public.record_whatsapp_ad_event(pg_temp.ev('z1', 'outbound', '2026-11-18T10:00:00Z', p_phone => '971529990000')) as r12 \gset
select pg_temp.expect(not exists (select 1 from public.leads where phone = '+971529990000'), 'outbound-only-creates-no-lead');

-- 8. invalid input is refused
do $$ begin
  begin perform public.record_whatsapp_ad_event('{"waba_id":"1"}'::jsonb); raise exception 'S18 ASSERT_FAIL invalid-event-accepted';
  exception when sqlstate '22023' then raise notice 'S18 ASSERT_OK invalid-event-refused'; end;
end $$;

-- 9. grants: only the service role may call the writer or read the tables; clients may not
select pg_temp.expect(has_function_privilege('service_role', 'public.record_whatsapp_ad_event(jsonb,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_whatsapp_ad_event(jsonb,boolean)', 'execute')
  and not has_function_privilege('anon', 'public.record_whatsapp_ad_event(jsonb,boolean)', 'execute')
  and not has_table_privilege('authenticated', 'public.whatsapp_conversations', 'select')
  and not has_table_privilege('authenticated', 'public.whatsapp_capi_events', 'select')
  and not has_table_privilege('anon', 'public.whatsapp_message_events', 'select')
  and not has_table_privilege('service_role', 'public.whatsapp_capi_events', 'delete'), 'grants');
select pg_temp.expect((select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[]
  from pg_proc p where p.oid = to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)')), 'definer-with-pinned-search-path');
select pg_temp.expect((select count(*) = 3 and bool_and(c.relrowsecurity) from pg_class c where c.relname in ('whatsapp_conversations', 'whatsapp_message_events', 'whatsapp_capi_events') and c.relnamespace = 'public'::regnamespace), 'rls-on');

-- 10. an end user cannot write or move the attribution columns; the server path cannot replace a click id
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","role":"authenticated","iat":' || (extract(epoch from now())::bigint + 5) || '}', true);
insert into public.leads (id, source, phone, ctwa_clid, wa_first_inbound_at) values ('f1800000-0000-4000-8000-0000000000bb', 'website', '+971500000001', 'AbcdefghIJ_1234', now());
select pg_temp.expect((select ctwa_clid is null and wa_first_inbound_at is null from public.leads where id = 'f1800000-0000-4000-8000-0000000000bb'), 'end-user-insert-cannot-set-click-id');
update public.leads set ctwa_clid = 'ForgedClickId_999', wa_first_reply_at = now() where id = :'lead1';
select pg_temp.expect((select ctwa_clid = 'AfcClickIdAAAAA_01' and wa_first_reply_at = '2026-11-18T08:05:00Z' from public.leads where id = :'lead1'), 'end-user-update-cannot-move-attribution');
select set_config('request.jwt.claims', '', true);
update public.leads set ctwa_clid = 'ServerReplaceTry_88' where id = :'lead1';
select pg_temp.expect((select ctwa_clid = 'AfcClickIdAAAAA_01' from public.leads where id = :'lead1'), 'server-cannot-replace-an-existing-click-id');
rollback;
