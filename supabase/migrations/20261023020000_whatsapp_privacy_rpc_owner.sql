-- NO_ROLLBACK: Keep erasure and replay-suppression protections during app rollback.
-- Hosted auth schemas do not delegate grant option to the migration account.
-- Use the repository's trusted owner for two fixed, argument-free routines;
-- external EXECUTE grants and every reviewed function body remain unchanged.
begin;
lock table public.whatsapp_pilot_channels in share row exclusive mode;
do $$ begin
  if exists (select from public.whatsapp_pilot_channels where enabled) then
    raise exception 'whatsapp_channels_must_be_disabled';
  end if;
end $$;
alter function whatsapp_privacy.process_requests() owner to postgres;
alter function public.maintain_whatsapp_privacy() owner to postgres;
-- The unused NOLOGIN role retains no direct observer-data privileges.
revoke all on whatsapp_privacy.requests, whatsapp_privacy.suppressions,
  whatsapp_privacy.maintenance, public.whatsapp_pilot_events
  from newme_whatsapp_maintenance;
commit;
