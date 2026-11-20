-- S25 database behaviour test, local PostgreSQL only, never production.
--   PGDATABASE=<replayed database> psql -v ON_ERROR_STOP=1 -f tests/database/s25-whatsapp-history.sql
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
  if p_ok is not true then raise exception 'S25 ASSERT_FAIL %', p_name; end if;
  raise notice 'S25 ASSERT_OK %', p_name;
end $$;

create or replace function pg_temp.h(p_id text, p_dir text, p_at text, p_phone text default '971501234567', p_body text default null,
  p_type text default 'text') returns jsonb language sql as $$
  select jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'customer_phone', p_phone, 'direction', p_dir,
    'message_id', p_id, 'message_type', p_type, 'occurred_at', p_at, 'body', p_body, 'body_kind', case when p_type = 'text' then 'text' else 'media' end)
$$;

select count(*) as leads_before from public.leads \gset
select count(*) as capi_before from public.whatsapp_capi_events \gset

-- 1. history is stored as backfilled rows, with payload timestamps and S21 text rules
select public.record_whatsapp_history_messages(jsonb_build_array(
  pg_temp.h('h1', 'inbound', '2026-06-01T08:00:00Z', p_body => 'Hello from history'),
  pg_temp.h('h2', 'outbound', '2026-06-01T08:05:00Z', p_body => 'Staff reply'),
  pg_temp.h('h3', 'inbound', '2026-06-01T08:06:00Z', p_type => 'image', p_body => 'must-not-be-kept'),
  pg_temp.h('h4', 'inbound', '2026-06-01T08:07:00Z', p_body => repeat('x', 5000)),
  jsonb_build_object('message_id', 'broken')
)) as r1 \gset
select pg_temp.expect((:'r1'::jsonb->>'inserted')::int = 4 and (:'r1'::jsonb->>'rejected')::int = 1 and (:'r1'::jsonb->>'duplicate')::int = 0, 'four-stored-one-rejected');
select pg_temp.expect((select bool_and(backfilled) and count(*) = 4 from public.whatsapp_message_events where message_id in ('h1','h2','h3','h4')), 'all-rows-marked-backfilled');
select pg_temp.expect((select direction = 'inbound' and occurred_at = '2026-06-01T08:00:00Z' and body = 'Hello from history' and body_kind = 'text' and source = 'messages' and referral_ctwa_clid is null from public.whatsapp_message_events where message_id = 'h1'), 'customer-message-fields');
select pg_temp.expect((select direction = 'outbound' and source = 'smb_message_echoes' from public.whatsapp_message_events where message_id = 'h2'), 'staff-message-direction');
select pg_temp.expect((select body is null and body_kind = 'media' from public.whatsapp_message_events where message_id = 'h3'), 'media-marker-only');
select pg_temp.expect((select char_length(body) = 4096 from public.whatsapp_message_events where message_id = 'h4'), 'body-capped');

-- 2. no lead, no Meta queue, conversation timing untouched
select pg_temp.expect((select count(*) = :leads_before from public.leads), 'no-lead-created');
select pg_temp.expect((select count(*) = :capi_before from public.whatsapp_capi_events), 'no-meta-event-queued');
select pg_temp.expect((select lead_id is null and first_inbound_at is null and first_reply_at is null and inbound_count = 0 and outbound_count = 0 and not is_ad and first_ctwa_clid is null
  from public.whatsapp_conversations where waba_id = '987654321' and customer_key = '971501234567'), 'conversation-untouched');

-- 3. replay is idempotent, in either order with the live writer
select public.record_whatsapp_history_messages(jsonb_build_array(pg_temp.h('h1', 'inbound', '2026-06-01T08:00:00Z', p_body => 'different text on replay'))) as r2 \gset
select pg_temp.expect((:'r2'::jsonb->>'inserted')::int = 0 and (:'r2'::jsonb->>'duplicate')::int = 1
  and (select body = 'Hello from history' from public.whatsapp_message_events where message_id = 'h1'), 'replay-is-a-noop');
select public.record_whatsapp_ad_event(jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'customer_phone', '971507777777',
  'direction', 'inbound', 'source', 'messages', 'message_id', 'live1', 'message_type', 'text', 'occurred_at', '2026-11-19T09:00:00Z', 'body', 'live', 'body_kind', 'text')) as r3 \gset
select public.record_whatsapp_history_messages(jsonb_build_array(pg_temp.h('live1', 'inbound', '2026-11-19T09:00:00Z', p_phone => '971507777777', p_body => 'history copy'))) as r4 \gset
select pg_temp.expect((:'r4'::jsonb->>'duplicate')::int = 1 and (select not backfilled and body = 'live' from public.whatsapp_message_events where message_id = 'live1'), 'live-row-wins-over-history');

-- 4. contacts
select public.record_whatsapp_synced_contacts(jsonb_build_array(
  jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'phone', '971501234567', 'full_name', 'Aisha Khan', 'first_name', 'Aisha', 'action', 'add'),
  jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'phone', '0509999999', 'full_name', 'Old', 'action', 'add'),
  jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'phone', 'bad')
)) as c1 \gset
select pg_temp.expect((:'c1'::jsonb->>'upserted')::int = 2 and (:'c1'::jsonb->>'rejected')::int = 1, 'contacts-upserted');
select pg_temp.expect((select full_name = 'Aisha Khan' from public.whatsapp_synced_contacts where contact_key = '971501234567') and (select count(*) = 1 from public.whatsapp_synced_contacts where contact_key = '971509999999'), 'contact-rows-and-uae-normalisation');
select public.record_whatsapp_synced_contacts(jsonb_build_array(jsonb_build_object('waba_id', '987654321', 'phone_number_id', '123456789', 'phone', '971509999999', 'action', 'remove'))) as c2 \gset
select pg_temp.expect((select removed_at is not null from public.whatsapp_synced_contacts where contact_key = '971509999999'), 'contact-remove-marks-removed_at');
select pg_temp.expect((select count(*) = :leads_before + 1 from public.leads), 'contacts-create-no-lead-live-writer-created-one');

-- 5. posture: server-only
select pg_temp.expect((select c.relrowsecurity and not has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
  from pg_class c where c.oid = to_regclass('public.whatsapp_synced_contacts')), 'contacts-table-server-only');
select pg_temp.expect(not has_function_privilege('authenticated', 'public.record_whatsapp_history_messages(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.record_whatsapp_synced_contacts(jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.record_whatsapp_history_messages(jsonb)', 'EXECUTE'), 'routines-service-role-only');
rollback;
