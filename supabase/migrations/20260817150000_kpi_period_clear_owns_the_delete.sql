-- ============================================================================
-- B7 · the routine that owns the KPI write also owns the KPI delete
-- ============================================================================
-- NO_ROLLBACK: this file adds one function, grants EXECUTE on it to service_role
-- only, and redefines nothing. Reverting it restores the state measured below, in
-- which the only way to clear a KPI period is the route's own service-role DELETE
-- against the table: it destroys every actual_amount in the period, takes no
-- period lock, and answers to the route's role list instead of the table's DELETE
-- policy. It writes no data and takes no privilege away, so there is nothing for a
-- rollback to undo except the refusal itself. The manual revert, if it is ever
-- needed, is `drop function if exists public.clear_kpi_targets(text, uuid);` and
-- the route reverting with it — the route has no other way to clear a period once
-- this lands.
--
-- Version note: stamped 20260817150000, below the contract phase
-- 20260818000000_money_direct_write_contract_phase.sql, because the expand phase
-- has to stay a contiguous prefix of the pending set; see
-- tests/release/expand-contract-rollback-contract.test.mjs.
--
-- 20260817000000_l0_round4_money_and_business_integrity.sql §14 closed the loss
-- on the SAVE path: replace_kpi_targets() now carries actual_amount forward for
-- every (target_type, assigned_to) pair that survives a replacement, and refuses
-- a payload that drops a pair still holding collected money. Reproduced on an
-- isolated PG17 with the floor, the fourteen branch migrations and
-- 05_seed_behaviour_fixtures.sql, under BOTH release modes:
--
--   replace_kpi_targets, same pairs   compat 00000  actual sum 700.00 -> 700.00
--                                     strict 00000  actual sum 700.00 -> 700.00
--   replace_kpi_targets, pair dropped compat 22023  actual sum 700.00 -> 700.00
--                                     strict 22023  actual sum 700.00 -> 700.00
--
-- The save path is therefore not the remaining hole. This one is:
--
--   src/app/api/kpi/targets/route.ts DELETE ran, through the service-role client,
--     await supabaseAdmin.from("kpi_targets").delete().eq("period", period);
--
-- which reaches the table without reaching the routine. Measured, same harness,
-- both modes:
--
--   service_role  DELETE where period = P   00000  deleted 2  actual sum 700.00 -> 0
--   authenticated DELETE as sales           00000  deleted 0  (RLS filtered)
--   authenticated DELETE as operator        00000  deleted 0  (RLS filtered)
--   authenticated DELETE as boss            00000  deleted 1
--
-- Three separate consequences, all from the one statement:
--
--   1 · It destroys actuals with no guard at all. The 22023 refusal above exists
--       precisely so that collected money cannot be dropped by a target edit; a
--       DELETE next to it drops the same money by a different verb. The recorded
--       collection facts are in payments, but nothing recomputes kpi_targets from
--       them, so the period simply reads zero afterwards.
--
--   2 · It takes no period lock. replace_kpi_targets() serializes same-period
--       saves on pg_advisory_xact_lock(hashtextextended('public.kpi_targets:'||
--       period, 0)). Measured with two connections: while an uncommitted
--       service-role DELETE of period P was in flight, a second connection's
--       pg_try_advisory_xact_lock on P's key returned TRUE and pg_locks held zero
--       advisory locks on that key. The serialization the routine documents does
--       not cover the delete path, and a replace that commits at t can have its
--       whole period removed by a DELETE that commits at t+1s.
--
--   3 · It bypasses RLS, so the route's own role list is the entire authorization.
--       That list was admin/boss/operator; the production DELETE policy
--       (20260701000000_non_core_tables_rls_fix.sql:227) is admin/boss. An
--       operator's identical statement is refused by the database and accepted by
--       the route — the same shape as B1, where revoke_contract() existed and the
--       list page wrote around it.
--
-- The fix is a routine that owns the delete, so the delete cannot be issued
-- without the rule. clear_kpi_targets() takes the SAME period lock as
-- replace_kpi_targets() and refuses to remove a row that still holds a non-zero
-- actual_amount, with the same errcode and the same shape of message as the save
-- path's orphan guard. Clearing a period nobody has collected against is still
-- allowed, because that is a real thing an administrator does and removing the
-- capability would be a different change from removing the hazard.
--
-- Why p_actor is a parameter and not money_actor(): the route calls this over the
-- service-role client, where auth.uid() is null and there is no JWT subject to
-- resolve. That is exactly how replace_kpi_targets() already takes p_set_by, and
-- keeping the two entry points identical is the point of this file. The role check
-- consequently lives in the route, which is why the route's list is narrowed to
-- admin/boss in the same change. assert_current_session_at_entry() is still the
-- first statement, so a call that DOES arrive with an end-user identity must come
-- from a current session.
--
-- Forward-only and idempotent: it adds one function and grants nothing to
-- authenticated or anon. Re-applying it is a no-op. No existing routine is
-- redefined by this file, so none of the round-3/round-4 guards can be reverted by
-- a partial body.
--
-- Rollback: drop function if exists public.clear_kpi_targets(text, uuid);
-- The route is the only caller, so roll the release back together with it. Do NOT
-- restore the direct service-role delete as a fallback: that is the finding.
-- ============================================================================

begin;

create or replace function public.clear_kpi_targets(
  p_period text,
  p_actor  uuid
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lock_key bigint;
  v_holding  bigint;
  v_removed  bigint;
begin
  perform public.assert_current_session_at_entry();

  if p_period is null or btrim(p_period) = '' then
    raise exception 'period is required' using errcode = '22023';
  end if;

  -- The same key replace_kpi_targets() uses, so a clear and a save of one period
  -- serialize against each other instead of racing. Held to commit or rollback.
  v_lock_key := hashtextextended('public.kpi_targets:' || p_period, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Read under the lock, so the count cannot go stale between the check and the
  -- delete. Same rule as the save path's orphan guard: collected money may not be
  -- dropped by an edit to targets, and choosing where to put it is not a decision
  -- this routine may make silently.
  select count(*) into v_holding
    from public.kpi_targets
   where period = p_period
     and coalesce(actual_amount, 0) <> 0;

  if v_holding > 0 then
    raise exception 'cannot clear %: % of its target(s) already hold collected amounts; edit the period through replace_kpi_targets instead, keeping those rows (with target_amount 0 if they are no longer targets)',
      p_period, v_holding using errcode = '22023';
  end if;

  delete from public.kpi_targets where period = p_period;
  get diagnostics v_removed = row_count;

  -- Server-owned evidence, written the way revoke_user_sessions() writes its own
  -- (20260817120000:203): actor_id stays null because this arrives on a
  -- service-role path with no end-user identity, and audit_logs.actor_id
  -- references auth.users, which a profiles id is not guaranteed to satisfy. The
  -- claimed actor goes in details, where it is evidence rather than an assertion.
  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (action, target_type, details)
    values ('KPI_PERIOD_CLEARED', 'kpi_targets',
            jsonb_build_object('period', p_period,
                               'rows_removed', v_removed,
                               'claimed_actor', p_actor));
  end if;

  return v_removed;
end;
$$;

comment on function public.clear_kpi_targets(text, uuid) is
  'Removes every kpi_targets row for a period, under the same period-scoped advisory lock replace_kpi_targets() takes, and only if none of them holds a non-zero actual_amount. The delete that the KPI route used to issue directly through the service-role client, with the rule attached.';

revoke all on function public.clear_kpi_targets(text, uuid) from public, anon, authenticated;
grant execute on function public.clear_kpi_targets(text, uuid) to service_role;

commit;
