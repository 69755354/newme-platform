-- NO_ROLLBACK: additive only (nullable leads columns, four new server-only tables, three new routines); no existing row, policy or constraint changes. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S18 - Click-to-WhatsApp ad leads: Meta click id (ctwa_clid) and ad id on the lead,
-- automatic lead creation, first-response timing, and a Conversions API outbox.
-- ============================================================================
-- Metadata only. The customer's phone number is stored (it is the join key to the lead, the same
-- number the CRM already holds); chat text, ad body text and media links are never stored.
-- Everything the webhook writes goes through record_whatsapp_ad_event(), one transaction per
-- message, serialised per customer phone, idempotent per (WABA, customer phone) and per message id.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1 - Canonical phone key (mirrors normalizeWhatsAppPhoneKey in src/lib/whatsapp-ctwa.mjs)
-- ---------------------------------------------------------------------------
create or replace function public.wa_phone_key(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public, pg_temp
as $fn$
  select case when length(d) between 7 and 15 then d else null end
  from (
    select case
      when n like '9710%' and length(n) = 13 then '971' || substr(n, 5)
      when n like '0%' and length(n) between 9 and 10 then '971' || substr(n, 2)
      when length(n) = 9 and n like '5%' then '971' || n
      else n
    end as d
    from (
      select case when s like '00%' then substr(s, 3) else s end as n
      from (select pg_catalog.regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as s) a
    ) b
  ) c
$fn$;

revoke all on function public.wa_phone_key(text) from public, anon;
grant execute on function public.wa_phone_key(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 - Lead columns. The click id is the FIRST one seen for the lead; the guard trigger below
--     keeps it (and the timing columns) server-owned.
-- ---------------------------------------------------------------------------
alter table public.leads add column if not exists ctwa_clid text;
alter table public.leads add column if not exists wa_first_inbound_at timestamptz;
alter table public.leads add column if not exists wa_first_reply_at timestamptz;
alter table public.leads add column if not exists wa_ad_headline text;
alter table public.leads add column if not exists wa_ad_source_url text;

do $do$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.leads'::regclass and conname = 'leads_ctwa_clid_format') then
    alter table public.leads add constraint leads_ctwa_clid_format
      check (ctwa_clid is null or (ctwa_clid ~ '^[A-Za-z0-9_-]+$' and char_length(ctwa_clid) between 10 and 512)) not valid;
    alter table public.leads validate constraint leads_ctwa_clid_format;
  end if;
end
$do$;

create index if not exists idx_leads_ctwa_clid on public.leads (ctwa_clid) where ctwa_clid is not null;
create index if not exists idx_leads_wa_phone_key on public.leads (public.wa_phone_key(phone));

create or replace function public.guard_leads_whatsapp_attribution()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  -- A request carrying an end-user identity may not write or move the attribution columns.
  -- The server path (no identity) may set them once; the click id is never replaced afterwards.
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.ctwa_clid := null; new.wa_first_inbound_at := null; new.wa_first_reply_at := null;
      new.wa_ad_headline := null; new.wa_ad_source_url := null;
    else
      new.ctwa_clid := old.ctwa_clid; new.wa_first_inbound_at := old.wa_first_inbound_at;
      new.wa_first_reply_at := old.wa_first_reply_at; new.wa_ad_headline := old.wa_ad_headline;
      new.wa_ad_source_url := old.wa_ad_source_url;
    end if;
  elsif tg_op = 'UPDATE' and old.ctwa_clid is not null then
    new.ctwa_clid := old.ctwa_clid;
  end if;
  return new;
end
$fn$;

revoke all on function public.guard_leads_whatsapp_attribution() from public, anon, authenticated;

drop trigger if exists trg_guard_leads_whatsapp_attribution on public.leads;
create trigger trg_guard_leads_whatsapp_attribution
before insert or update on public.leads
for each row execute function public.guard_leads_whatsapp_attribution();

-- ---------------------------------------------------------------------------
-- 3 - Conversations (one per WABA + customer phone), message metadata, Meta outbox
-- ---------------------------------------------------------------------------
create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  customer_key text not null check (customer_key ~ '^[0-9]{7,15}$'),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,32}$'),
  lead_id uuid references public.leads(id) on delete cascade,
  is_ad boolean not null default false,
  first_ctwa_clid text check (first_ctwa_clid is null or (first_ctwa_clid ~ '^[A-Za-z0-9_-]+$' and char_length(first_ctwa_clid) between 10 and 512)),
  first_ad_id text check (first_ad_id is null or first_ad_id ~ '^[0-9]{5,32}$'),
  first_source_type text,
  first_source_url text,
  first_headline text,
  first_referral_at timestamptz,
  first_inbound_at timestamptz,
  first_outbound_at timestamptz,
  first_reply_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  inbound_count integer not null default 0 check (inbound_count >= 0),
  outbound_count integer not null default 0 check (outbound_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id, customer_key)
);
create index if not exists idx_whatsapp_conversations_lead on public.whatsapp_conversations (lead_id) where lead_id is not null;

create table if not exists public.whatsapp_message_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  message_id text not null check (char_length(message_id) between 1 and 256),
  direction text not null check (direction in ('inbound', 'outbound')),
  source text not null check (source in ('messages', 'smb_message_echoes')),
  message_type text not null check (message_type ~ '^[a-z_]{1,40}$'),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,32}$'),
  occurred_at timestamptz not null,
  referral_ctwa_clid text,
  referral_source_id text,
  created_at timestamptz not null default now(),
  unique (waba_id, message_id)
);
create index if not exists idx_whatsapp_message_events_conversation on public.whatsapp_message_events (conversation_id, occurred_at);

create table if not exists public.whatsapp_capi_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  ctwa_clid text not null check (ctwa_clid ~ '^[A-Za-z0-9_-]+$' and char_length(ctwa_clid) between 10 and 512),
  event_name text not null check (event_name in ('LeadSubmitted', 'QualifiedLead', 'Purchase')),
  event_time bigint not null check (event_time > 0),
  value numeric(14,2) check (value is null or value >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'delivered', 'failed', 'review_required')),
  attempts integer not null default 0 check (attempts >= 0),
  lease_id uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (lead_id, event_name)
);
create index if not exists idx_whatsapp_capi_events_queue on public.whatsapp_capi_events (created_at) where status in ('pending', 'failed', 'sending');

-- Server-side only: service_role bypasses RLS; no policy is granted to clients.
do $do$
declare t text;
begin
  foreach t in array array['whatsapp_conversations', 'whatsapp_message_events', 'whatsapp_capi_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('drop trigger if exists trg_require_current_session on public.%I', t);
    execute format('create trigger trg_require_current_session before insert or update or delete on public.%I for each statement execute function public.require_current_session()', t);
  end loop;
end
$do$;
revoke all on table public.whatsapp_conversations, public.whatsapp_message_events, public.whatsapp_capi_events from service_role;
grant select, insert, update on public.whatsapp_conversations, public.whatsapp_message_events, public.whatsapp_capi_events to service_role;

-- ---------------------------------------------------------------------------
-- 4 - The one writer: record one webhook message
-- ---------------------------------------------------------------------------
-- p_event keys: waba_id, phone_number_id, customer_phone, direction, source, message_id,
-- message_type, occurred_at, profile_name, referral{source_type, source_id, source_url, headline, ctwa_clid}
-- Returns {duplicate, lead_id, lead_created, attributed, queued}.
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
       referral_ctwa_clid, referral_source_id)
    values (v_conv.id, v_waba, v_message, v_direction, v_source, v_type, v_phone_id, v_at,
       case when v_direction = 'inbound' then v_clid end, case when v_direction = 'inbound' then v_ref_id end)
    on conflict (waba_id, message_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      return jsonb_build_object('duplicate', true, 'lead_id', v_conv.lead_id, 'lead_created', false,
        'attributed', false, 'queued', false);
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
      update public.leads set wa_first_inbound_at = v_conv.first_inbound_at, wa_first_reply_at = v_conv.first_reply_at
        where id = v_lead_id
          and (wa_first_inbound_at is distinct from v_conv.first_inbound_at or wa_first_reply_at is distinct from v_conv.first_reply_at);
    end if;

    return jsonb_build_object('duplicate', false, 'lead_id', v_lead_id, 'lead_created', v_lead_created,
      'attributed', v_attributed, 'queued', v_queued);
  end;
end
$fn$;

revoke all on function public.record_whatsapp_ad_event(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.record_whatsapp_ad_event(jsonb, boolean) to service_role;

comment on function public.record_whatsapp_ad_event(jsonb, boolean) is
  'S18: record one WhatsApp message (metadata only), match or create the lead by canonical phone, keep the first ctwa_clid and ad id, queue LeadSubmitted. Idempotent per message id and per (WABA, phone). Service role only.';

-- ---------------------------------------------------------------------------
-- Manual undo (not executed), in this order: remove trigger trg_guard_leads_whatsapp_attribution from public.leads;
-- remove functions record_whatsapp_ad_event(jsonb, boolean), guard_leads_whatsapp_attribution() and wa_phone_key(text);
-- remove tables whatsapp_capi_events, whatsapp_message_events, whatsapp_conversations (in that order);
-- remove leads columns ctwa_clid, wa_first_inbound_at, wa_first_reply_at, wa_ad_headline, wa_ad_source_url.
-- Prefer rolling the application back with WHATSAPP_AD_LEADS_ENABLED=false; the tables only hold metadata.
-- ---------------------------------------------------------------------------
