-- NO_ROLLBACK: additive only (three new routines, three new row triggers, one backfill that fills only empty leads.quotation_value with real quoted amounts; no table, column, policy or grant changes). Manual undo, nothing else depends on it:
--   drop trigger if exists trg_quotation_sync_lead_value on public.quotations;
--   drop trigger if exists trg_contract_sync_lead_value on public.contracts;
--   drop trigger if exists trg_lead_won_sync_value on public.leads;
--   drop function if exists public.trg_sync_lead_quotation_value();
--   drop function if exists public.trg_lead_won_sync_quotation_value();
--   drop function if exists public.sync_lead_quotation_value(uuid, numeric);
-- The amounts the backfill wrote stay in leads.quotation_value (they are the real quoted amounts); the sales sheet sync
-- keeps writing that column exactly as before.
-- ============================================================================
-- OS fix S36 - leads.quotation_value follows the quotations
-- ============================================================================
-- Context: every KPI (dashboard signed amount, won amount, team performance, ads value, lead cards, the contract the
-- "lead won" trigger creates) reads leads.quotation_value, but only the sales-sheet sync wrote it. A quotation made in
-- the OS never reached it, so every amount showed 0.
--
-- Rule kept in ONE place, the database, so every writer (server route, the quote screens, the quotation detail page,
-- the Hermes route, future code) gets it without caring:
--   * a lead's quotation_value = the total of its newest quotation that is not rejected / expired (AED quotations only,
--     the KPI unit); created / edited / voided / deleted quotations recompute it;
--   * when the last live quotation is voided or deleted, the value is cleared only if it was that quotation's amount
--     (an amount typed by the sales sheet or at win time is left alone);
--   * a WON lead with an active (or completed) contract takes the contract amount: the contract wins;
--   * a WON lead without a contract keeps the amount it was won with (a later quotation does not rewrite history);
--   * the write never blocks the quotation: if the lead row refuses the update (for example a follow-up rule), the
--     quotation is still saved and a warning is logged.
-- It does not touch stage, ownership, or anything the sheet sync decides; the sheet sync is unchanged.
--
-- Idempotent: functions are create-or-replace, triggers are dropped and recreated, the backfill only writes rows whose
-- value differs from the rule.
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create or replace function public.sync_lead_quotation_value(p_lead_id uuid, p_removed_total numeric default null)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_final   text;
  v_current numeric;
  v_amount  numeric;
  v_from_contract boolean := false;
begin
  perform public.assert_current_session_at_entry();
  if p_lead_id is null then
    return;
  end if;
  select final_status, quotation_value into v_final, v_current from public.leads where id = p_lead_id;
  if not found then
    return;
  end if;

  if v_final = 'won' then
    select contract_amount into v_amount
      from public.contracts
     where lead_id = p_lead_id and status in ('active', 'completed') and contract_amount > 0
     order by created_at desc, id desc
     limit 1;
    v_from_contract := v_amount is not null;
    -- won without a contract: the amount it was won with stays
    if not v_from_contract and coalesce(v_current, 0) > 0 then
      return;
    end if;
  end if;

  if v_amount is null then
    select total_amount into v_amount
      from public.quotations
     where lead_id = p_lead_id
       and status not in ('rejected', 'expired')
       and total_amount > 0
       and coalesce(currency, 'AED') = 'AED'
     order by created_at desc, id desc
     limit 1;
  end if;

  if v_amount is null then
    -- nothing live left: clear only an amount that came from the quotation that just went away
    if v_final is distinct from 'won' and p_removed_total is not null and v_current = p_removed_total then
      v_amount := null;
    else
      return;
    end if;
  end if;

  if v_amount is not distinct from v_current then
    return;
  end if;
  begin
    update public.leads set quotation_value = v_amount where id = p_lead_id;
  exception when others then
    raise warning 'sync_lead_quotation_value: lead % not updated: %', p_lead_id, sqlerrm;
  end;
end
$$;

create or replace function public.trg_sync_lead_quotation_value()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.assert_current_session_at_entry();
  if tg_table_name = 'contracts' then
    if tg_op = 'DELETE' then
      perform public.sync_lead_quotation_value(old.lead_id, null);
      return old;
    end if;
    perform public.sync_lead_quotation_value(new.lead_id, null);
    if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
      perform public.sync_lead_quotation_value(old.lead_id, null);
    end if;
    return new;
  end if;
  -- quotations
  if tg_op = 'DELETE' then
    perform public.sync_lead_quotation_value(old.lead_id, old.total_amount);
    return old;
  end if;
  perform public.sync_lead_quotation_value(new.lead_id, case when tg_op = 'UPDATE' then old.total_amount else null end);
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    perform public.sync_lead_quotation_value(old.lead_id, old.total_amount);
  end if;
  return new;
end
$$;

create or replace function public.trg_lead_won_sync_quotation_value()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform public.assert_current_session_at_entry();
  perform public.sync_lead_quotation_value(new.id, null);
  return new;
end
$$;

revoke all on function public.sync_lead_quotation_value(uuid, numeric) from public, anon, authenticated;
revoke all on function public.trg_sync_lead_quotation_value() from public, anon, authenticated;
revoke all on function public.trg_lead_won_sync_quotation_value() from public, anon, authenticated;

drop trigger if exists trg_quotation_sync_lead_value on public.quotations;
create trigger trg_quotation_sync_lead_value
after insert or delete or update of total_amount, status, currency, lead_id on public.quotations
for each row execute function public.trg_sync_lead_quotation_value();

drop trigger if exists trg_contract_sync_lead_value on public.contracts;
create trigger trg_contract_sync_lead_value
after insert or delete or update of contract_amount, status, lead_id on public.contracts
for each row execute function public.trg_sync_lead_quotation_value();

drop trigger if exists trg_lead_won_sync_value on public.leads;
create trigger trg_lead_won_sync_value
after update of final_status on public.leads
for each row when (new.final_status = 'won' and old.final_status is distinct from 'won')
execute function public.trg_lead_won_sync_quotation_value();

-- ----------------------------------------------------------------------------
-- Backfill: the same rule, once, for the quotations that already exist.
-- Only leads with NO amount yet (null or 0) are filled, plus won leads whose active contract says otherwise; an amount
-- already there (the sheet sync's) is never overwritten.
-- Only rows whose value differs are written. The lead triggers that would stamp updated_at, re-flag stale leads or refuse
-- a row for a missing follow-up are switched off inside this transaction only, so history is not rewritten.
-- ----------------------------------------------------------------------------
do $backfill$
declare
  v_trigger text;
  v_disabled text[] := '{}';
  v_rows int;
begin
  foreach v_trigger in array array['trg_set_updated_at', 'trg_update_lead_metrics', 'trg_enforce_followup'] loop
    if exists (select 1 from pg_trigger where tgrelid = 'public.leads'::regclass and tgname = v_trigger and not tgisinternal) then
      execute format('alter table public.leads disable trigger %I', v_trigger);
      v_disabled := v_disabled || v_trigger;
    end if;
  end loop;

  with wanted as (
    select l.id,
           coalesce(
             case when l.final_status = 'won' then
               (select c.contract_amount from public.contracts c
                 where c.lead_id = l.id and c.status in ('active', 'completed') and c.contract_amount > 0
                 order by c.created_at desc, c.id desc limit 1)
             end,
             (select q.total_amount from public.quotations q
               where q.lead_id = l.id and q.status not in ('rejected', 'expired') and q.total_amount > 0
                 and coalesce(q.currency, 'AED') = 'AED'
               order by q.created_at desc, q.id desc limit 1)
           ) as amount,
           l.quotation_value as current_value,
           l.final_status
      from public.leads l
  )
  update public.leads l
     set quotation_value = w.amount
    from wanted w
   where l.id = w.id
     and w.amount is not null
     and w.amount is distinct from w.current_value
     -- never overwrite an amount that is already there (the sheet sync's value stays); only a won lead's active contract
     -- amount may replace it
     and (coalesce(w.current_value, 0) <= 0
          or (w.final_status = 'won'
              and exists (select 1 from public.contracts c where c.lead_id = w.id and c.status in ('active', 'completed') and c.contract_amount > 0)));
  get diagnostics v_rows = row_count;
  raise notice 'S36 backfill: % lead(s) got quotation_value from their quotations / contract', v_rows;

  foreach v_trigger in array v_disabled loop
    execute format('alter table public.leads enable trigger %I', v_trigger);
  end loop;
end
$backfill$;
