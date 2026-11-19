-- NO_ROLLBACK: additive only (two nullable message columns, one new server-only table, one new routine) plus a replaced S18 writer that stays compatible with the old call shape; manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S21 - WhatsApp conversation text and follow-up monitor v1
-- ============================================================================
-- 1. whatsapp_message_events keeps the text of text messages (body) and a kind marker; media keeps a marker only.
-- 2. record_whatsapp_ad_event is replaced: stores the body, keeps S18 idempotency and first-click rule, and carries
--    the two S18 review corrections: (a) an archived lead being replaced does not hand its click id, ad id and
--    source time to the new lead; (b) the lead's first message and first reply come from every conversation linked
--    to it (one customer, several business numbers), not from the latest event's conversation.
-- 3. lead_followup_state (one row per lead) and upsert_lead_followup_state(): one transaction writes the state, the
--    system note (activities) and the notifications, only when the state really changed.
-- Server-only: no client grants. Safe to run twice.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1 - Message text
-- ---------------------------------------------------------------------------
alter table public.whatsapp_message_events add column if not exists body text;
alter table public.whatsapp_message_events add column if not exists body_kind text;

do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.whatsapp_message_events'::regclass and conname = 'whatsapp_message_events_body_len') then
    alter table public.whatsapp_message_events add constraint whatsapp_message_events_body_len
      check (body is null or char_length(body) <= 4096);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.whatsapp_message_events'::regclass and conname = 'whatsapp_message_events_body_kind') then
    alter table public.whatsapp_message_events add constraint whatsapp_message_events_body_kind
      check (body_kind is null or body_kind in ('text', 'media', 'other'));
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2 - The writer, replaced
-- ---------------------------------------------------------------------------
create or replace function public.record_whatsapp_ad_event(p_event jsonb, p_create_organic boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
begin
  perform public.assert_current_session_at_entry();
  declare
    v_waba text := p_event->>'waba_id';
    v_phone_id text := p_event->>'phone_number_id';
    v_key text := public.wa_phone_key(p_event->>'customer_phone');
    v_message text := p_event->>'message_id';
    v_direction text := p_event->>'direction';
    v_source text := p_event->>'source';
    v_type text := coalesce(p_event->>'message_type', 'text');
    v_at timestamptz;
    v_name text := nullif(left(btrim(coalesce(p_event->>'profile_name', '')), 200), '');
    v_ref jsonb := case when jsonb_typeof(p_event->'referral') = 'object' then p_event->'referral' else null end;
    v_clid text := v_ref->>'ctwa_clid';
    v_ref_type text := v_ref->>'source_type';
    v_ref_id text := v_ref->>'source_id';
    v_ref_url text := v_ref->>'source_url';
    v_headline text := nullif(left(coalesce(v_ref->>'headline', ''), 200), '');
    v_is_ad boolean;
    v_ad_id text;
    v_conv public.whatsapp_conversations%rowtype;
    v_inserted integer;
    v_lead_id uuid;
    v_lead_created boolean := false;
    v_attributed boolean := false;
    v_queued boolean := false;
    v_lead public.leads%rowtype;
    v_first_in timestamptz;
    v_first_reply timestamptz;
    v_followup date;
    v_kind text := nullif(p_event->>'body_kind', '');
    v_body text := p_event->>'body';
  begin
    if jsonb_typeof(p_event) <> 'object' or v_key is null or v_waba is null or v_waba !~ '^[0-9]{5,32}$'
       or v_phone_id is null or v_phone_id !~ '^[0-9]{5,32}$'
       or v_message is null or char_length(v_message) not between 1 and 256
       or v_direction not in ('inbound', 'outbound') or v_source not in ('messages', 'smb_message_echoes')
       or v_type !~ '^[a-z_]{1,40}$' then
      raise exception using errcode = '22023', message = 'invalid_whatsapp_event';
    end if;
    begin
      v_at := (p_event->>'occurred_at')::timestamptz;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid_whatsapp_event';
    end;
    if v_at is null then raise exception using errcode = '22023', message = 'invalid_whatsapp_event'; end if;
    -- Chat text (S21): only a plain text message keeps its body; media and other kinds keep a marker only.
    if v_kind is null or v_kind not in ('text', 'media', 'other') then
      v_kind := case when v_type = 'text' then 'text'
                     when v_type in ('image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts') then 'media'
                     else 'other' end;
    end if;
    v_body := case when v_kind = 'text' then nullif(left(btrim(coalesce(v_body, '')), 4096), '') else null end;
    if v_clid is not null and (v_clid !~ '^[A-Za-z0-9_-]+$' or char_length(v_clid) not between 10 and 512) then v_clid := null; end if;
    if v_ref_id is not null and v_ref_id !~ '^[0-9]{5,32}$' then v_ref_id := null; end if;
    if v_ref_url is not null and (v_ref_url !~* '^https://[^[:space:]]+$' or char_length(v_ref_url) > 500) then v_ref_url := null; end if;
    v_is_ad := v_direction = 'inbound' and (v_clid is not null or coalesce(v_ref_type = 'ad', false));
    v_ad_id := case when v_ref_type = 'ad' then v_ref_id else null end;

    -- One customer phone is handled by one transaction at a time, across WABAs, so a replayed or
    -- concurrent delivery can never create a second lead.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wa-ctwa:' || v_key, 0));

    insert into public.whatsapp_conversations (waba_id, customer_key, phone_number_id)
    values (v_waba, v_key, v_phone_id)
    on conflict (waba_id, customer_key) do nothing;
    select * into v_conv from public.whatsapp_conversations where waba_id = v_waba and customer_key = v_key for update;

    insert into public.whatsapp_message_events
      (conversation_id, waba_id, message_id, direction, source, message_type, phone_number_id, occurred_at,
       referral_ctwa_clid, referral_source_id, body, body_kind)
    values (v_conv.id, v_waba, v_message, v_direction, v_source, v_type, v_phone_id, v_at,
       case when v_direction = 'inbound' then v_clid end, case when v_direction = 'inbound' then v_ref_id end,
       v_body, v_kind)
    on conflict (waba_id, message_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      return jsonb_build_object('duplicate', true, 'lead_id', v_conv.lead_id, 'lead_created', false,
        'attributed', false, 'queued', false);
    end if;

    -- S21 (S18 review, item 1): a conversation whose lead was archived is being replaced. The click id,
    -- ad id and source time belong to the archived lead, so they are cleared here and only the current
    -- message can attribute the lead that replaces it. Inside one live lead the first click still wins.
    if v_conv.lead_id is not null
       and not exists (select 1 from public.leads where id = v_conv.lead_id and archived = false) then
      update public.whatsapp_conversations set lead_id = null, is_ad = false, first_ctwa_clid = null,
        first_ad_id = null, first_source_type = null, first_source_url = null, first_headline = null,
        first_referral_at = null
      where id = v_conv.id;
      select * into v_conv from public.whatsapp_conversations where id = v_conv.id;
    end if;

    -- Timing and counts are recomputed from the stored events, so arrival order does not matter.
    select min(occurred_at) filter (where direction = 'inbound') into v_first_in
      from public.whatsapp_message_events where conversation_id = v_conv.id;
    select min(occurred_at) into v_first_reply
      from public.whatsapp_message_events
      where conversation_id = v_conv.id and direction = 'outbound' and v_first_in is not null and occurred_at > v_first_in;
    update public.whatsapp_conversations c set
      phone_number_id = v_phone_id,
      first_inbound_at = v_first_in,
      first_reply_at = v_first_reply,
      first_outbound_at = (select min(occurred_at) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'outbound'),
      last_inbound_at = (select max(occurred_at) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'inbound'),
      last_outbound_at = (select max(occurred_at) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'outbound'),
      inbound_count = (select count(*) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'inbound'),
      outbound_count = (select count(*) from public.whatsapp_message_events e where e.conversation_id = c.id and e.direction = 'outbound'),
      is_ad = c.is_ad or v_is_ad,
      updated_at = now()
    where c.id = v_conv.id;

    -- First click wins: the conversation keeps the first referral it saw, later clicks only log
    -- their ids on the message row.
    if v_is_ad and v_conv.first_ctwa_clid is null and v_clid is not null then
      update public.whatsapp_conversations set first_ctwa_clid = v_clid, first_ad_id = v_ad_id,
        first_source_type = v_ref_type, first_source_url = v_ref_url, first_headline = v_headline,
        first_referral_at = v_at
      where id = v_conv.id;
    end if;
    select * into v_conv from public.whatsapp_conversations where id = v_conv.id;

    -- Resolve the lead: the linked one while it is active, else the oldest active lead with this
    -- phone, else (inbound only) a new lead.
    if v_conv.lead_id is not null then
      select id into v_lead_id from public.leads where id = v_conv.lead_id and archived = false;
    end if;
    if v_lead_id is null then
      select id into v_lead_id from public.leads
        where archived = false and public.wa_phone_key(phone) = v_key
        order by created_at asc nulls last, id asc limit 1;
    end if;
    if v_lead_id is null and v_direction = 'inbound' and (v_is_ad or p_create_organic) then
      v_followup := (now() at time zone 'Asia/Dubai')::date + 1;
      insert into public.leads (
        source, source_platform, source_channel, customer_name, phone,
        ad_id, meta_ad_id, lead_status, next_action, next_followup_date, first_touch_at, created_at
      ) values (
        'whatsapp', 'whatsapp', case when v_is_ad then 'whatsapp_ctwa' else 'whatsapp_direct' end,
        coalesce(v_name, '+' || v_key), '+' || v_key,
        v_ad_id, v_ad_id, 'hot', 'call', v_followup, v_at, v_at
      ) returning id into v_lead_id;
      v_lead_created := true;
    end if;

    if v_lead_id is not null then
      if v_conv.lead_id is distinct from v_lead_id then
        update public.whatsapp_conversations set lead_id = v_lead_id where id = v_conv.id;
      end if;
      select * into v_lead from public.leads where id = v_lead_id for update;
      -- Attach the first click id once; never replace it, never overwrite an ad id that is already known.
      if v_lead.ctwa_clid is null and v_conv.first_ctwa_clid is not null then
        update public.leads set
          ctwa_clid = v_conv.first_ctwa_clid,
          ad_id = coalesce(ad_id, v_conv.first_ad_id),
          meta_ad_id = coalesce(meta_ad_id, v_conv.first_ad_id),
          wa_ad_headline = coalesce(wa_ad_headline, v_conv.first_headline),
          wa_ad_source_url = coalesce(wa_ad_source_url, v_conv.first_source_url),
          source_channel = case when source_channel is null or source_channel = 'whatsapp_direct' then 'whatsapp_ctwa' else source_channel end,
          updated_at = now()
        where id = v_lead_id;
        v_attributed := true;
        insert into public.whatsapp_capi_events (lead_id, waba_id, ctwa_clid, event_name, event_time)
        values (v_lead_id, v_waba, v_conv.first_ctwa_clid, 'LeadSubmitted', extract(epoch from v_conv.first_referral_at)::bigint)
        on conflict (lead_id, event_name) do nothing;
        get diagnostics v_inserted = row_count;
        v_queued := v_inserted > 0;
      end if;
      -- S21 (S18 review, item 2): one customer may write to several business numbers (WABAs). The lead's
      -- first message and first reply come from every conversation linked to it, not from this one.
      select min(e.occurred_at) filter (where e.direction = 'inbound') into v_first_in
        from public.whatsapp_message_events e join public.whatsapp_conversations c on c.id = e.conversation_id
        where c.lead_id = v_lead_id;
      select min(e.occurred_at) into v_first_reply
        from public.whatsapp_message_events e join public.whatsapp_conversations c on c.id = e.conversation_id
        where c.lead_id = v_lead_id and e.direction = 'outbound' and v_first_in is not null and e.occurred_at > v_first_in;
      update public.leads set wa_first_inbound_at = v_first_in, wa_first_reply_at = v_first_reply
        where id = v_lead_id
          and (wa_first_inbound_at is distinct from v_first_in or wa_first_reply_at is distinct from v_first_reply);
    end if;

    return jsonb_build_object('duplicate', false, 'lead_id', v_lead_id, 'lead_created', v_lead_created,
      'attributed', v_attributed, 'queued', v_queued);
  end;
end
$fn$;

revoke all on function public.record_whatsapp_ad_event(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.record_whatsapp_ad_event(jsonb, boolean) to service_role;

comment on function public.record_whatsapp_ad_event(jsonb, boolean) is
  'S18/S21: record one WhatsApp message (text body kept for text messages), match or create the lead by canonical phone, keep the first ctwa_clid and ad id per live lead, queue LeadSubmitted. Idempotent per message id and per (WABA, phone). Service role only.';

-- ---------------------------------------------------------------------------
-- 3 - Follow-up state
-- ---------------------------------------------------------------------------
create table if not exists public.lead_followup_state (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  first_inbound_at timestamptz,
  first_reply_at timestamptz,
  first_response_minutes integer check (first_response_minutes is null or first_response_minutes >= 0),
  contact_count_5wd integer not null default 0 check (contact_count_5wd >= 0),
  last_outbound_at timestamptz,
  state text not null default 'normal' check (state in ('normal', 'at_risk', 'overdue')),
  state_since timestamptz not null default now(),
  abandon_risk boolean not null default false,
  abandon_since timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_lead_followup_state_state on public.lead_followup_state (state) where state <> 'normal' or abandon_risk;

alter table public.lead_followup_state enable row level security;
revoke all on table public.lead_followup_state from public, anon, authenticated, service_role;
grant select on public.lead_followup_state to service_role;
drop trigger if exists trg_require_current_session on public.lead_followup_state;
create trigger trg_require_current_session before insert or update or delete on public.lead_followup_state
  for each statement execute function public.require_current_session();

-- Writes the follow-up state of one lead and, only when the state (or the abandon-risk flag) changed, the
-- system note and the notifications, all in one transaction. Re-running it with the same inputs changes nothing.
-- Returns {changed, state_changed, abandon_changed, previous_state, note_written, notified}.
create or replace function public.upsert_lead_followup_state(
  p_lead_id uuid,
  p_first_inbound_at timestamptz,
  p_first_reply_at timestamptz,
  p_first_response_minutes integer,
  p_contact_count_5wd integer,
  p_last_outbound_at timestamptz,
  p_state text,
  p_abandon_risk boolean,
  p_note text default null,
  p_notify_user_ids uuid[] default '{}',
  p_notify_title text default null,
  p_notify_body text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_prev public.lead_followup_state%rowtype;
  v_had boolean;
  v_prev_state text;
  v_prev_abandon boolean;
  v_state_changed boolean;
  v_abandon_changed boolean;
  v_since timestamptz;
  v_key text;
  v_note boolean := false;
  v_notified integer := 0;
  v_uid uuid;
  v_type text;
  v_rows integer;
begin
  perform public.assert_current_session_at_entry();
  if p_lead_id is null or p_state is null or p_state not in ('normal', 'at_risk', 'overdue')
     or p_abandon_risk is null or coalesce(p_contact_count_5wd, 0) < 0
     or (p_first_response_minutes is not null and p_first_response_minutes < 0) then
    raise exception using errcode = '22023', message = 'invalid_followup_state';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('lead-followup:' || p_lead_id::text, 0));
  if not exists (select 1 from public.leads where id = p_lead_id) then
    raise exception using errcode = '22023', message = 'unknown_lead';
  end if;

  select * into v_prev from public.lead_followup_state where lead_id = p_lead_id for update;
  v_had := found;
  v_prev_state := case when v_had then v_prev.state else 'normal' end;
  v_prev_abandon := case when v_had then v_prev.abandon_risk else false end;
  v_state_changed := v_prev_state is distinct from p_state;
  v_abandon_changed := v_prev_abandon is distinct from p_abandon_risk;
  v_since := case when v_had and not v_state_changed then v_prev.state_since else now() end;

  insert into public.lead_followup_state as s (lead_id, first_inbound_at, first_reply_at, first_response_minutes,
    contact_count_5wd, last_outbound_at, state, state_since, abandon_risk, abandon_since, updated_at)
  values (p_lead_id, p_first_inbound_at, p_first_reply_at, p_first_response_minutes, coalesce(p_contact_count_5wd, 0),
    p_last_outbound_at, p_state, v_since, p_abandon_risk, case when p_abandon_risk then now() end, now())
  on conflict (lead_id) do update set
    first_inbound_at = excluded.first_inbound_at, first_reply_at = excluded.first_reply_at,
    first_response_minutes = excluded.first_response_minutes, contact_count_5wd = excluded.contact_count_5wd,
    last_outbound_at = excluded.last_outbound_at, state = excluded.state, state_since = excluded.state_since,
    abandon_risk = excluded.abandon_risk,
    abandon_since = case when excluded.abandon_risk and not s.abandon_risk then now()
                         when excluded.abandon_risk then s.abandon_since else null end,
    updated_at = now()
  where (s.first_inbound_at, s.first_reply_at, s.first_response_minutes, s.contact_count_5wd, s.last_outbound_at, s.state, s.abandon_risk)
        is distinct from
        (excluded.first_inbound_at, excluded.first_reply_at, excluded.first_response_minutes, excluded.contact_count_5wd,
         excluded.last_outbound_at, excluded.state, excluded.abandon_risk);

  if v_state_changed or v_abandon_changed then
    -- A lead seen for the first time in the normal state is not news.
    if v_had or p_state <> 'normal' or p_abandon_risk then
      v_key := 'followup:' || p_lead_id::text || ':' || p_state || ':' || case when p_abandon_risk then 'abandon' else 'ok' end
               || ':' || extract(epoch from now())::bigint::text;
      if p_note is not null and btrim(p_note) <> '' then
        insert into public.activities (lead_id, type, content, ai_generated, is_completed, metadata)
        select p_lead_id, 'note', left(p_note, 2000), false, true,
               jsonb_build_object('system', true, 'source', 'followup_monitor', 'state', p_state, 'abandon_risk', p_abandon_risk, 'key', v_key)
        where not exists (select 1 from public.activities a where a.lead_id = p_lead_id and a.metadata->>'key' = v_key);
        get diagnostics v_rows = row_count;
        v_note := v_rows > 0;
      end if;
      -- Existing allowed notification types only: overdue and abandon risk are warnings, the rest reminders.
      v_type := case when p_state = 'overdue' or (p_abandon_risk and v_abandon_changed) then 'warning' else 'reminder' end;
      if p_notify_title is not null and btrim(p_notify_title) <> '' then
        foreach v_uid in array coalesce(p_notify_user_ids, '{}'::uuid[]) loop
          insert into public.notifications (user_id, type, title, body, related_id, related_type, is_read, event_key)
          select v_uid, v_type, left(p_notify_title, 200), left(p_notify_body, 1000), p_lead_id, 'lead', false, left(v_key, 200)
          where exists (select 1 from public.profiles pr where pr.id = v_uid)
          on conflict (user_id, event_key) do nothing;
          get diagnostics v_rows = row_count;
          v_notified := v_notified + v_rows;
        end loop;
      end if;
    end if;
  end if;

  return jsonb_build_object('changed', v_state_changed or v_abandon_changed, 'state_changed', v_state_changed,
    'abandon_changed', v_abandon_changed, 'previous_state', v_prev_state, 'note_written', v_note, 'notified', v_notified);
end
$fn$;

revoke all on function public.upsert_lead_followup_state(uuid, timestamptz, timestamptz, integer, integer, timestamptz, text, boolean, text, uuid[], text, text) from public, anon, authenticated;
grant execute on function public.upsert_lead_followup_state(uuid, timestamptz, timestamptz, integer, integer, timestamptz, text, boolean, text, uuid[], text, text) to service_role;

comment on function public.upsert_lead_followup_state(uuid, timestamptz, timestamptz, integer, integer, timestamptz, text, boolean, text, uuid[], text, text) is
  'S21: write one lead follow-up state; on a state or abandon-risk change also write one system note and the notifications, atomically. Service role only.';

-- ---------------------------------------------------------------------------
-- Manual undo (not executed), in this order: remove function public.upsert_lead_followup_state(uuid, timestamptz, timestamptz, integer, integer, timestamptz, text, boolean, text, uuid[], text, text);
-- remove table public.lead_followup_state; restore record_whatsapp_ad_event(jsonb, boolean) from 20261118200000_whatsapp_ctwa_leads.sql;
-- remove whatsapp_message_events columns body and body_kind (and their two constraints).
-- Prefer stopping the follow-up cron entry (WHATSAPP_FOLLOWUP_MONITOR_ENABLED unset) and WHATSAPP_AD_LEADS_ENABLED=false over undoing the schema.
-- ---------------------------------------------------------------------------
