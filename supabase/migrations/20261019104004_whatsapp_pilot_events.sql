-- Metadata-only, opt-in coexistence pilot. No CRM facts, roles or assignments change.
-- NO_ROLLBACK: Additive observer tables retain event evidence; roll back the app with the pilot flag disabled instead of automatically dropping collected data.
begin;
create table if not exists public.whatsapp_pilot_channels (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 1 and 80),
  purpose text not null check (purpose in ('intake', 'follow_up')),
  owner_profile_id uuid not null references public.profiles(id),
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  phone_number_id text not null unique check (phone_number_id ~ '^[0-9]{5,32}$'),
  business_phone text not null unique check (business_phone ~ '^[0-9]{7,15}$'),
  enabled boolean not null default false,
  accept_since timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.whatsapp_pilot_events (
  channel_id uuid not null references public.whatsapp_pilot_channels(id),
  message_id text not null check (char_length(message_id) between 1 and 256),
  customer_key text not null check (customer_key ~ '^[a-f0-9]{64}$'),
  direction text not null check (direction in ('inbound','outbound')),
  source text not null check (source in ('messages','smb_message_echoes')),
  message_type text not null check (message_type ~ '^[a-z_]{1,40}$'),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (channel_id, message_id),
  constraint whatsapp_pilot_direction_source check (
    (direction = 'inbound' and source = 'messages') or
    (direction = 'outbound' and source = 'smb_message_echoes')
  )
);
create index if not exists whatsapp_pilot_events_channel_time on public.whatsapp_pilot_events (channel_id, occurred_at desc);
-- These optional tables sort after the release-wide session-trigger sweep.
-- Install its canonical statement boundary here so a single ordered apply and
-- the compatibility rollback retain the same protection as an idempotency replay.
drop trigger if exists trg_require_current_session on public.whatsapp_pilot_channels;
create trigger trg_require_current_session
before insert or update or delete on public.whatsapp_pilot_channels
for each statement execute function public.require_current_session();
drop trigger if exists trg_require_current_session on public.whatsapp_pilot_events;
create trigger trg_require_current_session
before insert or update or delete on public.whatsapp_pilot_events
for each statement execute function public.require_current_session();
-- No direct browser/anonymous access or end-user writes. Management reads go
-- through the active-session boss/admin route; signed webhook is the only writer.
alter table public.whatsapp_pilot_channels enable row level security;
alter table public.whatsapp_pilot_events enable row level security;
revoke all on public.whatsapp_pilot_channels, public.whatsapp_pilot_events from public, anon, authenticated;
revoke all on public.whatsapp_pilot_channels, public.whatsapp_pilot_events from service_role;
grant select, insert, update on public.whatsapp_pilot_channels to service_role;
grant select, insert on public.whatsapp_pilot_events to service_role;
commit;
