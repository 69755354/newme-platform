-- NO_ROLLBACK: two routines replaced in place (same signatures, SECURITY DEFINER, pinned search_path, grants unchanged) and one trigger recreated with one more watched column. Manual undo: re-apply the definitions and the trg_contract_sync_lead_value trigger from 20261122200000_quotation_value_follows_quotations.sql. No data is written.
-- ============================================================================
-- OS fix S46 - leads.quotation_value: old quotation currency, foreign-currency contracts, one recomputation per lead
-- ============================================================================
-- PR #600 follow-ups, on top of 20261122200000 (which stays untouched):
--   * the lead value is cleared when its last live quotation goes away only if the quotation that went away was an AED one
--     (a USD total equal to the lead value no longer clears it);
--   * a won lead's value follows an active / completed contract only when that contract is in AED (the value is an AED figure);
--     changing a contract's currency recomputes too;
--   * the recomputation locks the lead row (select ... for update) before reading, so two concurrent writers are serialised.
-- No backfill: no existing value is rewritten.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

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
  -- S46: the lead row is locked (to the end of the transaction) before anything is read, so two concurrent writers recompute one
  -- after the other and the later one sees the earlier one's committed rows. The lead row is also what the lead-won trigger and
  -- the stage routines already hold, so taking it first keeps one lock order (an advisory lock taken first could deadlock them).
  select final_status, quotation_value into v_final, v_current from public.leads where id = p_lead_id for update;
  if not found then
    return;
  end if;

  if v_final = 'won' then
    select contract_amount into v_amount
      from public.contracts
     where lead_id = p_lead_id and status in ('active', 'completed') and contract_amount > 0
       -- S46: leads.quotation_value is an AED figure; a foreign-currency contract never becomes it
       and coalesce(currency, 'AED') = 'AED'
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
  -- quotations. S46: an old quotation's total may only clear the lead value when that quotation was in AED; a foreign-currency
  -- total that happens to equal the lead value is not what the lead value came from.
  if tg_op = 'DELETE' then
    perform public.sync_lead_quotation_value(old.lead_id, case when coalesce(old.currency, 'AED') = 'AED' then old.total_amount end);
    return old;
  end if;
  perform public.sync_lead_quotation_value(new.lead_id,
    case when tg_op = 'UPDATE' and coalesce(old.currency, 'AED') = 'AED' then old.total_amount end);
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then
    perform public.sync_lead_quotation_value(old.lead_id, case when coalesce(old.currency, 'AED') = 'AED' then old.total_amount end);
  end if;
  return new;
end
$$;

revoke all on function public.sync_lead_quotation_value(uuid, numeric) from public, anon, authenticated;
revoke all on function public.trg_sync_lead_quotation_value() from public, anon, authenticated;

drop trigger if exists trg_contract_sync_lead_value on public.contracts;
create trigger trg_contract_sync_lead_value
after insert or delete or update of contract_amount, status, currency, lead_id on public.contracts
for each row execute function public.trg_sync_lead_quotation_value();
