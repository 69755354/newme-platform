-- S21 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -f tests/database/s21-followup-monitor.sql
-- Runs in one transaction that is rolled back. Every phone, name and message below is invented.
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
  if p_ok is not true then raise exception 'S21 ASSERT_FAIL %', p_name; end if;
  raise notice 'S21 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.ev(p_id text, p_dir text, p_at text, p_phone text default '971501234567',
  p_clid text default null, p_ad text default '120210000000001', p_waba text default '987654321',
  p_type text default 'text', p_body text default null) returns jsonb
language sql as $$
  select jsonb_build_object('waba_id', p_waba, 'phone_number_id', case when p_waba = '987654321' then '123456789' else '555666777' end,
    'customer_phone', p_phone, 'direction', p_dir, 'source', case when p_dir = 'inbound' then 'messages' else 'smb_message_echoes' end,
    'message_id', p_id, 'message_type', p_type, 'occurred_at', p_at, 'body', p_body,
    'referral', case when p_clid is null then null else jsonb_build_object('source_type', 'ad', 'source_id', p_ad,
      'source_url', 'https://fb.me/x', 'headline', 'Smart home', 'ctwa_clid', p_clid) end)
$$;

-- 1. text bodies are stored; media keeps a marker and no text; replays are no-ops
select public.record_whatsapp_ad_event(pg_temp.ev('t1', 'inbound', '2026-11-18T08:00:00Z', p_clid => 'AfcClickIdAAAAA_01', p_body => 'Hello, I have a 2 bedroom flat')) as r1 \gset
select pg_temp.expect((select body = 'Hello, I have a 2 bedroom flat' and body_kind = 'text' from public.whatsapp_message_events where message_id = 't1'), 'text-body-stored');
select public.record_whatsapp_ad_event(pg_temp.ev('t2', 'inbound', '2026-11-18T08:01:00Z', p_type => 'image', p_body => 'should-not-be-kept')) as r2 \gset
select pg_temp.expect((select body is null and body_kind = 'media' from public.whatsapp_message_events where message_id = 't2'), 'media-keeps-marker-only');
select public.record_whatsapp_ad_event(pg_temp.ev('t3', 'inbound', '2026-11-18T08:02:00Z', p_type => 'reaction')) as r2b \gset
select pg_temp.expect((select body is null and body_kind = 'other' from public.whatsapp_message_events where message_id = 't3'), 'other-kind-marker');
select public.record_whatsapp_ad_event(pg_temp.ev('t4', 'inbound', '2026-11-18T08:03:00Z', p_body => repeat('x', 5000))) as r2c \gset
select pg_temp.expect((select char_length(body) = 4096 from public.whatsapp_message_events where message_id = 't4'), 'body-is-capped');
select public.record_whatsapp_ad_event(pg_temp.ev('t1', 'inbound', '2026-11-18T08:00:00Z', p_clid => 'AfcClickIdAAAAA_01', p_body => 'different text on replay')) as r3 \gset
select pg_temp.expect((:'r3'::jsonb->>'duplicate')::boolean and (select body = 'Hello, I have a 2 bedroom flat' from public.whatsapp_message_events where message_id = 't1'), 'replay-keeps-the-first-copy');
select l.id as lead1 from public.leads l where l.ctwa_clid = 'AfcClickIdAAAAA_01' \gset

-- 2. S18 review item 1: archived lead replaced -> attribution is reset, the new lead gets the new click only
select public.record_whatsapp_ad_event(pg_temp.ev('a1', 'outbound', '2026-11-18T08:10:00Z')) as r4 \gset
update public.leads set archived = true where id = :'lead1';
select public.record_whatsapp_ad_event(pg_temp.ev('a2', 'inbound', '2026-11-19T09:00:00Z', p_clid => 'AfcClickIdNEWNEW_02', p_ad => '120210000000009', p_body => 'Back again')) as r5 \gset
select pg_temp.expect((:'r5'::jsonb->>'lead_created')::boolean and (:'r5'::jsonb->>'attributed')::boolean, 'replacement-lead-created-and-attributed');
select (:'r5'::jsonb->>'lead_id')::uuid as lead2 \gset
select pg_temp.expect((select ctwa_clid = 'AfcClickIdNEWNEW_02' and ad_id = '120210000000009' from public.leads where id = :'lead2')
  and (select first_ctwa_clid = 'AfcClickIdNEWNEW_02' and first_ad_id = '120210000000009' and first_referral_at = '2026-11-19T09:00:00Z' and lead_id = :'lead2' from public.whatsapp_conversations where waba_id = '987654321' and customer_key = '971501234567'), 'conversation-attribution-follows-the-new-click');
select pg_temp.expect((select event_time = extract(epoch from timestamptz '2026-11-19T09:00:00Z')::bigint from public.whatsapp_capi_events where lead_id = :'lead2' and event_name = 'LeadSubmitted'), 'new-lead-submitted-uses-the-new-click-time');
select pg_temp.expect((select ctwa_clid = 'AfcClickIdAAAAA_01' from public.leads where id = :'lead1'), 'archived-lead-keeps-its-own-history');
-- a replacement without a new click carries no old attribution
update public.leads set archived = true where id = :'lead2';
select public.record_whatsapp_ad_event(pg_temp.ev('a3', 'inbound', '2026-11-19T10:00:00Z', p_body => 'plain follow up')) as r6 \gset
select pg_temp.expect((select ctwa_clid is null and ad_id is null and source_channel = 'whatsapp_direct' from public.leads where id = (:'r6'::jsonb->>'lead_id')::uuid)
  and (select first_ctwa_clid is null and not is_ad from public.whatsapp_conversations where waba_id = '987654321' and customer_key = '971501234567'), 'replacement-without-a-click-has-no-old-attribution');
-- inside one live lead the first click is still never replaced
select public.record_whatsapp_ad_event(pg_temp.ev('a4', 'inbound', '2026-11-19T10:05:00Z', p_clid => 'AfcClickIdLATER_03')) as r7 \gset
select public.record_whatsapp_ad_event(pg_temp.ev('a5', 'inbound', '2026-11-19T10:06:00Z', p_clid => 'AfcClickIdLATER_04')) as r8 \gset
select pg_temp.expect((select ctwa_clid = 'AfcClickIdLATER_03' from public.leads where id = (:'r6'::jsonb->>'lead_id')::uuid), 'first-click-still-wins-within-a-live-lead');

-- 3. S18 review item 2: one customer, two business numbers -> lead first message and first reply from all conversations
select public.record_whatsapp_ad_event(pg_temp.ev('w1', 'inbound', '2026-11-19T11:00:00Z', p_phone => '971552223333', p_waba => '987654321', p_clid => 'AfcClickIdWABA1_01')) as r9 \gset
select (:'r9'::jsonb->>'lead_id')::uuid as lead3 \gset
select public.record_whatsapp_ad_event(pg_temp.ev('w2', 'outbound', '2026-11-19T11:30:00Z', p_phone => '971552223333', p_waba => '987654321')) as r10 \gset
select public.record_whatsapp_ad_event(pg_temp.ev('w3', 'inbound', '2026-11-19T12:00:00Z', p_phone => '971552223333', p_waba => '111222333')) as r11 \gset
select public.record_whatsapp_ad_event(pg_temp.ev('w4', 'outbound', '2026-11-19T12:10:00Z', p_phone => '971552223333', p_waba => '111222333')) as r12 \gset
select pg_temp.expect((select wa_first_inbound_at = '2026-11-19T11:00:00Z' and wa_first_reply_at = '2026-11-19T11:30:00Z' from public.leads where id = :'lead3'), 'later-conversation-does-not-overwrite-first-message-or-first-reply');
select pg_temp.expect((select count(*) = 2 from public.whatsapp_conversations where lead_id = :'lead3'), 'two-conversations-one-lead');
-- the other business number answers first, arriving late: it becomes the first reply
select public.record_whatsapp_ad_event(pg_temp.ev('w5', 'outbound', '2026-11-19T11:10:00Z', p_phone => '971552223333', p_waba => '111222333')) as r13 \gset
select pg_temp.expect((select wa_first_reply_at = '2026-11-19T11:10:00Z' from public.leads where id = :'lead3'), 'earliest-reply-over-all-conversations-wins');

-- 4. upsert_lead_followup_state: first normal row is silent, changes write one note and the notifications, replays change nothing
select id as uid from public.profiles limit 1 \gset
select public.upsert_lead_followup_state(:'lead3', '2026-11-19T11:00:00Z', '2026-11-19T11:10:00Z', 10, 1, '2026-11-19T12:10:00Z', 'normal', false, 'ignored', array[:'uid'::uuid], 't', 'b') as u0 \gset
select pg_temp.expect(not (:'u0'::jsonb->>'changed')::boolean and (select count(*) = 0 from public.activities where lead_id = :'lead3' and metadata->>'source' = 'followup_monitor'), 'first-normal-state-is-silent');
select public.upsert_lead_followup_state(:'lead3', '2026-11-19T11:00:00Z', '2026-11-19T11:10:00Z', 10, 1, '2026-11-19T12:10:00Z', 'at_risk', false, '[System] at risk', array[:'uid'::uuid], 'Follow-up at risk', 'body') as u1 \gset
select pg_temp.expect((:'u1'::jsonb->>'state_changed')::boolean and (:'u1'::jsonb->>'note_written')::boolean and (:'u1'::jsonb->>'notified')::int = 1 and :'u1'::jsonb->>'previous_state' = 'normal', 'state-change-writes-note-and-notification');
select public.upsert_lead_followup_state(:'lead3', '2026-11-19T11:00:00Z', '2026-11-19T11:10:00Z', 10, 1, '2026-11-19T12:10:00Z', 'at_risk', false, '[System] at risk', array[:'uid'::uuid], 'Follow-up at risk', 'body') as u2 \gset
select pg_temp.expect(not (:'u2'::jsonb->>'changed')::boolean and (select count(*) = 1 from public.activities where lead_id = :'lead3' and metadata->>'source' = 'followup_monitor')
  and (select count(*) = 1 from public.notifications where related_id = :'lead3' and type = 'reminder'), 'same-state-twice-writes-nothing-more');
select public.upsert_lead_followup_state(:'lead3', '2026-11-19T11:00:00Z', '2026-11-19T11:10:00Z', 10, 1, '2026-11-19T12:10:00Z', 'overdue', true, '[System] overdue', array[:'uid'::uuid], 'Follow-up overdue', 'body') as u3 \gset
select pg_temp.expect((:'u3'::jsonb->>'changed')::boolean and (select count(*) = 1 from public.notifications where related_id = :'lead3' and type = 'warning')
  and (select count(*) = 2 from public.activities where lead_id = :'lead3' and metadata->>'source' = 'followup_monitor'), 'worsening-writes-a-warning');
select public.upsert_lead_followup_state(:'lead3', '2026-11-19T11:00:00Z', '2026-11-19T11:10:00Z', 10, 2, '2026-11-19T13:00:00Z', 'normal', false, '[System] recovered', array[:'uid'::uuid], 'Follow-up recovered', 'body') as u4 \gset
select pg_temp.expect((:'u4'::jsonb->>'state_changed')::boolean and (select state = 'normal' and not abandon_risk and contact_count_5wd = 2 from public.lead_followup_state where lead_id = :'lead3')
  and (select count(*) = 3 from public.activities where lead_id = :'lead3' and metadata->>'source' = 'followup_monitor'), 'recovery-is-written-too');
-- metrics refresh without a state change writes the row but no note
select public.upsert_lead_followup_state(:'lead3', '2026-11-19T11:00:00Z', '2026-11-19T11:10:00Z', 10, 3, '2026-11-19T14:00:00Z', 'normal', false) as u5 \gset
select pg_temp.expect(not (:'u5'::jsonb->>'changed')::boolean and (select contact_count_5wd = 3 from public.lead_followup_state where lead_id = :'lead3'), 'metric-refresh-without-news');
do $$ begin
  begin perform public.upsert_lead_followup_state('f2100000-0000-4000-8000-000000000000', null, null, null, 0, null, 'normal', false); raise exception 'S21 ASSERT_FAIL unknown-lead-accepted';
  exception when sqlstate '22023' then raise notice 'S21 ASSERT_OK unknown-lead-refused'; end;
  begin perform public.upsert_lead_followup_state(null, null, null, null, 0, null, 'bogus', false); raise exception 'S21 ASSERT_FAIL bad-state-accepted';
  exception when sqlstate '22023' then raise notice 'S21 ASSERT_OK bad-state-refused'; end;
end $$;

-- 5. grants and shape
select pg_temp.expect(has_function_privilege('service_role', 'public.upsert_lead_followup_state(uuid,timestamptz,timestamptz,integer,integer,timestamptz,text,boolean,text,uuid[],text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.upsert_lead_followup_state(uuid,timestamptz,timestamptz,integer,integer,timestamptz,text,boolean,text,uuid[],text,text)', 'execute')
  and not has_function_privilege('anon', 'public.upsert_lead_followup_state(uuid,timestamptz,timestamptz,integer,integer,timestamptz,text,boolean,text,uuid[],text,text)', 'execute')
  and has_function_privilege('service_role', 'public.record_whatsapp_ad_event(jsonb,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_whatsapp_ad_event(jsonb,boolean)', 'execute')
  and not has_table_privilege('authenticated', 'public.lead_followup_state', 'select')
  and not has_table_privilege('anon', 'public.lead_followup_state', 'select')
  and has_table_privilege('service_role', 'public.lead_followup_state', 'select')
  and not has_table_privilege('service_role', 'public.lead_followup_state', 'insert,update,delete'), 'grants');
select pg_temp.expect((select count(*) = 2 and bool_and(p.prosecdef) and bool_and(p.proconfig @> array['search_path=pg_catalog, public, pg_temp']::text[])
  from pg_proc p where p.oid in (to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)'), to_regprocedure('public.upsert_lead_followup_state(uuid,timestamptz,timestamptz,integer,integer,timestamptz,text,boolean,text,uuid[],text,text)'))), 'definer-with-pinned-search-path');
select pg_temp.expect((select relrowsecurity from pg_class where oid = 'public.lead_followup_state'::regclass), 'rls-on');
rollback;
