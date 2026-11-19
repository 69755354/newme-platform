-- NO_ROLLBACK: additive only (one defaulted boolean column, one new server-only table, two new service-role routines); no existing row, policy, constraint or routine changes. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S25 - WhatsApp coexistence history backfill (one-time chat history and contact sync)
-- ============================================================================
-- Meta's one-time sync delivers up to 180 days of chat history (webhook field `history`) and the phone's
-- contacts (`smb_app_state_sync`). This file only adds the storage and the two writers:
--   * whatsapp_message_events.backfilled marks history rows. The history writer inserts events (and an empty
--     conversation row if none exists) and NOTHING else: it never creates or touches a lead, never writes the
--     Meta feedback queue (whatsapp_capi_events), never changes the conversation's timing columns or counts, and
--     never writes referral/click ids. Nothing here can reach Meta.
--   * whatsapp_synced_contacts keeps name and number of the phone's contacts (server-only).
-- Idempotent per (WABA, message id) like the live writer, serialised per customer phone with the same lock.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.whatsapp_message_events add column if not exists backfilled boolean not null default false;

create table if not exists public.whatsapp_synced_contacts (
  id uuid primary key default gen_random_uuid(),
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,32}$'),
  contact_key text not null check (contact_key ~ '^[0-9]{7,15}$'),
  full_name text check (full_name is null or char_length(full_name) <= 200),
  first_name text check (first_name is null or char_length(first_name) <= 200),
  removed_at timestamptz,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (waba_id, contact_key)
);

alter table public.whatsapp_synced_contacts enable row level security;
revoke all on table public.whatsapp_synced_contacts from public, anon, authenticated;
drop trigger if exists trg_require_current_session on public.whatsapp_synced_contacts;
create trigger trg_require_current_session before insert or update or delete on public.whatsapp_synced_contacts
  for each statement execute function public.require_current_session();
revoke all on table public.whatsapp_synced_contacts from service_role;
grant select, insert, update on public.whatsapp_synced_contacts to service_role;

-- ---------------------------------------------------------------------------
-- History writer. p_events: array (at most 500) of {waba_id, phone_number_id, customer_phone, direction,
-- message_id, message_type, occurred_at, body, body_kind}. Invalid entries are counted, not fatal.
-- Returns {inserted, duplicate, rejected}.
-- ---------------------------------------------------------------------------
create or replace function public.record_whatsapp_history_messages(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '30s'
as $fn$
begin
  perform public.assert_current_session_at_entry();
  declare
    e jsonb;
    v_waba text; v_phone_id text; v_key text; v_message text; v_direction text; v_type text;
    v_at timestamptz; v_kind text; v_body text; v_conv_id uuid; v_rows integer;
    v_inserted integer := 0; v_duplicate integer := 0; v_rejected integer := 0;
  begin
    if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 500 then
      raise exception using errcode = '22023', message = 'invalid_whatsapp_history';
    end if;
    for e in select * from jsonb_array_elements(p_events) loop
      v_waba := e->>'waba_id'; v_phone_id := e->>'phone_number_id';
      v_key := public.wa_phone_key(e->>'customer_phone');
      v_message := e->>'message_id'; v_direction := e->>'direction';
      v_type := coalesce(e->>'message_type', 'text'); v_at := null;
      begin v_at := (e->>'occurred_at')::timestamptz; exception when others then v_at := null; end;
      if jsonb_typeof(e) <> 'object' or v_key is null or v_at is null or v_waba is null or v_waba !~ '^[0-9]{5,32}$'
         or v_phone_id is null or v_phone_id !~ '^[0-9]{5,32}$'
         or v_message is null or char_length(v_message) not between 1 and 256
         or v_direction not in ('inbound', 'outbound') or v_type !~ '^[a-z_]{1,40}$' then
        v_rejected := v_rejected + 1;
        continue;
      end if;
      v_kind := nullif(e->>'body_kind', '');
      if v_kind is null or v_kind not in ('text', 'media', 'other') then
        v_kind := case when v_type = 'text' then 'text'
                       when v_type in ('image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts') then 'media'
                       else 'other' end;
      end if;
      v_body := case when v_kind = 'text' then nullif(left(btrim(coalesce(e->>'body', '')), 4096), '') else null end;

      -- Same per-customer lock as the live writer: history and a live message never interleave on one phone.
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wa-ctwa:' || v_key, 0));
      insert into public.whatsapp_conversations (waba_id, customer_key, phone_number_id)
      values (v_waba, v_key, v_phone_id)
      on conflict (waba_id, customer_key) do nothing;
      select id into v_conv_id from public.whatsapp_conversations where waba_id = v_waba and customer_key = v_key;

      insert into public.whatsapp_message_events
        (conversation_id, waba_id, message_id, direction, source, message_type, phone_number_id, occurred_at,
         body, body_kind, backfilled)
      values (v_conv_id, v_waba, v_message, v_direction,
         case when v_direction = 'inbound' then 'messages' else 'smb_message_echoes' end,
         v_type, v_phone_id, v_at, v_body, v_kind, true)
      on conflict (waba_id, message_id) do nothing;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then v_inserted := v_inserted + 1; else v_duplicate := v_duplicate + 1; end if;
    end loop;
    return jsonb_build_object('inserted', v_inserted, 'duplicate', v_duplicate, 'rejected', v_rejected);
  end;
end
$fn$;

revoke all on function public.record_whatsapp_history_messages(jsonb) from public, anon, authenticated;
grant execute on function public.record_whatsapp_history_messages(jsonb) to service_role;

comment on function public.record_whatsapp_history_messages(jsonb) is
  'S25: store backfilled WhatsApp history messages (backfilled=true). Never creates leads, never queues Meta events, never changes conversation timing. Idempotent per (WABA, message id). Service role only.';

-- ---------------------------------------------------------------------------
-- Contact writer. p_contacts: array (at most 500) of {waba_id, phone_number_id, phone, full_name, first_name, action}.
-- action 'remove' marks removed_at, anything else upserts. Returns {upserted, removed, rejected}.
-- ---------------------------------------------------------------------------
create or replace function public.record_whatsapp_synced_contacts(p_contacts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '30s'
as $fn$
begin
  perform public.assert_current_session_at_entry();
  declare
    c jsonb; v_waba text; v_phone_id text; v_key text; v_full text; v_first text; v_remove boolean;
    v_upserted integer := 0; v_removed integer := 0; v_rejected integer := 0;
  begin
    if jsonb_typeof(p_contacts) <> 'array' or jsonb_array_length(p_contacts) > 500 then
      raise exception using errcode = '22023', message = 'invalid_whatsapp_contacts';
    end if;
    for c in select * from jsonb_array_elements(p_contacts) loop
      v_waba := c->>'waba_id'; v_phone_id := c->>'phone_number_id'; v_key := public.wa_phone_key(c->>'phone');
      v_full := nullif(left(btrim(coalesce(c->>'full_name', '')), 200), '');
      v_first := nullif(left(btrim(coalesce(c->>'first_name', '')), 200), '');
      v_remove := coalesce(c->>'action', 'add') = 'remove';
      if jsonb_typeof(c) <> 'object' or v_key is null or v_waba is null or v_waba !~ '^[0-9]{5,32}$'
         or v_phone_id is null or v_phone_id !~ '^[0-9]{5,32}$' then
        v_rejected := v_rejected + 1;
        continue;
      end if;
      if v_remove then
        update public.whatsapp_synced_contacts set removed_at = now(), updated_at = now()
          where waba_id = v_waba and contact_key = v_key and removed_at is null;
        v_removed := v_removed + 1;
      else
        insert into public.whatsapp_synced_contacts (waba_id, phone_number_id, contact_key, full_name, first_name)
        values (v_waba, v_phone_id, v_key, v_full, v_first)
        on conflict (waba_id, contact_key) do update set
          full_name = coalesce(excluded.full_name, public.whatsapp_synced_contacts.full_name),
          first_name = coalesce(excluded.first_name, public.whatsapp_synced_contacts.first_name),
          removed_at = null, updated_at = now();
        v_upserted := v_upserted + 1;
      end if;
    end loop;
    return jsonb_build_object('upserted', v_upserted, 'removed', v_removed, 'rejected', v_rejected);
  end;
end
$fn$;

revoke all on function public.record_whatsapp_synced_contacts(jsonb) from public, anon, authenticated;
grant execute on function public.record_whatsapp_synced_contacts(jsonb) to service_role;

comment on function public.record_whatsapp_synced_contacts(jsonb) is
  'S25: store the phone contacts delivered by the one-time coexistence sync (name and number, server-only). No lead is created. Service role only.';

-- ---------------------------------------------------------------------------
-- Manual undo (not executed): remove functions record_whatsapp_history_messages(jsonb) and
-- record_whatsapp_synced_contacts(jsonb); remove table whatsapp_synced_contacts; optionally delete the
-- backfilled rows (delete from whatsapp_message_events where backfilled) and drop the column backfilled.
-- Prefer rolling the application back with WHATSAPP_HISTORY_SYNC_ENABLED=false; the data is inert.
-- ---------------------------------------------------------------------------
