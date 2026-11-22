-- NO_ROLLBACK: one existing trigger routine replaced in place (CREATE OR REPLACE, same signature, same security definer and pinned search_path); no table, column, policy, grant or data change. Manual undo: re-create public.derive_lead_status() with the body from supabase/replay/production-schema-baseline.sql (never contacted -> 'dormant' regardless of age).
-- ============================================================================
-- OS fix S37 - a brand-new lead is "hot", not "dormant"
-- ============================================================================
-- Context: trg_derive_lead_status (BEFORE INSERT OR UPDATE OF last_contact_date, stage) set lead_status = 'dormant'
-- whenever last_contact_date IS NULL. Every intake path (Meta lead form, WhatsApp, website, sheet sync) inserts a lead with
-- no contact yet, so every new lead was stored as dormant the moment it was created, overriding the 'hot' that the Meta
-- intake writes, and the cockpit "hot leads" list (lead_status = 'hot') could never contain a new ad lead.
--
-- New rule (lead_status keeps its allowed values hot / warm / cold / dormant; there is no 'new' value in the CHECK):
--   never contacted and created within the last 48 hours -> 'hot'   (fresh, waiting for the first call)
--   never contacted and older than 48 hours               -> 'dormant' (real inactivity)
--   contacted: unchanged (7 / 14 / 30 days -> hot / warm / cold, older -> dormant)
-- A trigger only fires on insert and on update of last_contact_date / stage, so a stored value cannot age by itself. The
-- application therefore also computes the temperature on read (src/lib/lead-metrics.mjs effectiveLeadStatus), with the
-- same rule; this routine keeps the stored column right for filters and exports.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.derive_lead_status()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
begin
  -- Don't auto-change for won/lost
  if new.stage in ('won','lost') then
    return new;
  end if;
  -- Only auto-set if lead_status is not explicitly set by user
  begin
    if new.metadata->>'lead_status_manual' = 'true' then
      return new;
    end if;
  exception when undefined_column then
    -- metadata column doesn't exist, skip this check
  end;
  if new.last_contact_date is null then
    -- Never contacted: fresh leads (48h) are hot, only an old untouched lead is dormant.
    if coalesce(new.created_at, now()) >= now() - interval '48 hours' then
      new.lead_status := 'hot';
    else
      new.lead_status := 'dormant';
    end if;
  elsif new.last_contact_date >= (current_date - interval '7 days') then
    new.lead_status := 'hot';
  elsif new.last_contact_date >= (current_date - interval '14 days') then
    new.lead_status := 'warm';
  elsif new.last_contact_date >= (current_date - interval '30 days') then
    new.lead_status := 'cold';
  else
    new.lead_status := 'dormant';
  end if;
  return new;
end;
$function$;
