-- ============================================================================
-- Re-contract companion: return to the strict posture after a rollback
-- ============================================================================
-- RECONTRACTS: 20260818000000_money_direct_write_contract_phase.sql
--
-- Like rollback_money_direct_write_contract_phase.sql, the name deliberately
-- does not match ^[0-9]{14}_ so the Supabase CLI will never apply it. It is run
-- by hand, by an operator, at a re-deploy after a rollback.
--
-- Why this file exists at all
-- ---------------------------
-- Review round 4 B9: "rollback enters compat but there is no verified
-- re-contract path". It was right, and the shape of the gap is worth stating
-- precisely, because the obvious fix does not work.
--
-- Once 20260818000000 has been applied it is RECORDED in
-- supabase_migrations.schema_migrations. `supabase db push` and
-- scripts/db-phase-push.mjs both skip a recorded version, so after an operator
-- has run the rollback companion — mode back to 'compat', previous release
-- redeployed — there is nothing pending that would return the database to
-- 'strict'. The release's own contract phase cannot be replayed, and a second
-- numbered forward migration would have exactly the same one-shot property: it
-- would be applied and recorded during the FIRST deploy, and the second attempt
-- would be back in the same dead end. The only thing that fixes the dead end is
-- an artifact that is repeatable by construction, which is what the rollback
-- direction already is. So this is its mirror image: same table, same one row,
-- opposite direction, runnable as many times as there are attempts.
--
-- What it does
-- ------------
-- Sets public.money_release_mode to 'strict' — the state 20260818000000 leaves —
-- after checking that the machinery that makes 'strict' mean anything is present,
-- and verifies the mode by reading it back through the function the guards
-- actually call. It writes an audit row so a posture change made by hand is not
-- an unrecorded one.
--
-- What it refuses to do, and this is the point
-- -------------------------------------------
-- Setting a column to 'strict' is a claim about a posture. On a database whose
-- guard triggers or mode function have been dropped, that claim would be false
-- and nothing would notice: every direct end-user write would still be accepted
-- while the manifest posture predicate `release-mode-row-is-strict` reported the
-- posture as restored. So the transition is refused unless
--
--   * public.money_release_mode exists, and
--   * public.money_direct_write_mode() and public.money_direct_write_is_blocked()
--     exist, and
--   * the four mode-gated guard triggers are present and ENABLED: contracts,
--     payments and quotations writes, and the contract transition graph. These
--     are the same four the `deferred_contract` posture predicate
--     `write-guards-are-still-installed` names in
--     infra/release/release-manifest.json — deliberately the same set, so the
--     artifact and the verifier cannot disagree about what the posture is. The
--     three definer-only guards from 20260812000000 (installment_plans,
--     contract_approvals, payment_allocations) are not mode-gated: they refuse a
--     session write in both modes, so they are not part of THIS transition.
--
-- The refusals are 42P01 (a required object is missing) so that an operator
-- reading the message is told which half of the posture is not there, rather
-- than being handed a green readback.
--
-- What it does NOT touch
-- ----------------------
-- One row in one table, exactly like the rollback companion. It does not create,
-- drop or alter a function, trigger, policy, grant or column: if the strict
-- posture needs anything that is not already in the database, that is a missing
-- migration and this file must fail rather than paper over it.
--
-- Verification after running it, from the runbook (§6):
--
--   node scripts/db-phase-push.mjs --phase deferred_contract --url-file FILE \
--     --verify-only
--
-- which re-checks the recorded history AND the deferred_contract posture
-- predicates in infra/release/release-manifest.json.
--
-- supabase/replay/30_assert_post_recontract.sql asserts the state this file
-- leaves, at the behaviour level, after the rollback companion has run in the
-- same replay — so the round trip strict → compat → strict is measured on every
-- MODE=branch run rather than described here.
-- ============================================================================

begin;

do $do$
declare
  v_mode     text;
  v_missing  text[] := '{}';
  v_guards   text[] := array['trg_guard_contracts_write',
                             'trg_guard_payments_write',
                             'trg_guard_quotations_write',
                             'trg_guard_contract_transition'];
  v_guard    text;
  v_previous text;
begin
  if to_regclass('public.money_release_mode') is null then
    raise exception 'public.money_release_mode does not exist; there is no contract phase to re-enter'
      using errcode = '42P01';
  end if;

  -- The mode is only as real as the code that reads it.
  if to_regprocedure('public.money_direct_write_mode()') is null then
    v_missing := v_missing || 'function public.money_direct_write_mode()';
  end if;
  if to_regprocedure('public.money_direct_write_is_blocked()') is null then
    v_missing := v_missing || 'function public.money_direct_write_is_blocked()';
  end if;

  -- And the guards are what turn 'strict' into a refusal. `tgenabled = 'O'` is
  -- the default origin setting; a trigger left DISABLED reads as present in
  -- pg_trigger and refuses nothing, which is precisely the false posture this
  -- check exists to catch.
  foreach v_guard in array v_guards loop
    if not exists (select 1 from pg_trigger g
                    where not g.tgisinternal
                      and g.tgname = v_guard
                      and g.tgenabled = 'O') then
      v_missing := v_missing || ('enabled trigger ' || v_guard);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'refusing to declare the strict posture: % is missing, so direct end-user money writes would still be accepted',
      array_to_string(v_missing, ', ')
      using errcode = '42P01';
  end if;

  select direct_write_mode into v_previous
    from public.money_release_mode where id = 'only';

  insert into public.money_release_mode (id, direct_write_mode, reason, changed_at)
  values ('only', 'strict',
          'recontract_money_direct_write_contract_phase.sql: the candidate release is '
          || 'deployed again after a rollback, so direct end-user writes are refused',
          now())
  on conflict (id) do update
     set direct_write_mode = excluded.direct_write_mode,
         reason            = excluded.reason,
         changed_at        = excluded.changed_at;

  select direct_write_mode into v_mode from public.money_release_mode where id = 'only';
  if v_mode <> 'strict' then
    raise exception 're-entering the contract phase did not take effect (mode is %)', coalesce(v_mode, 'null')
      using errcode = '22000';
  end if;
  -- Read back through the function the guards call, not just the column: a mode
  -- function that has been redefined to return a constant would pass the column
  -- check and refuse nothing.
  if public.money_direct_write_mode() <> 'strict' then
    raise exception 'the mode column says strict but public.money_direct_write_mode() says %',
      coalesce(public.money_direct_write_mode(), 'null')
      using errcode = '22000';
  end if;

  -- A posture change made by hand, recorded like one. actor_id stays null for
  -- the reason revoke_user_sessions() and clear_kpi_targets() leave it null:
  -- there is no end-user identity on an operator path, and audit_logs.actor_id
  -- references auth.users.
  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (action, target_type, details)
    values ('MONEY_CONTRACT_PHASE_REENTERED', 'money_release_mode',
            jsonb_build_object('previous_mode', coalesce(v_previous, 'absent'),
                               'mode', v_mode,
                               'artifact', 'recontract_money_direct_write_contract_phase.sql',
                               'reverses', 'rollback_money_direct_write_contract_phase.sql'));
  end if;

  raise notice 'direct end-user money writes are refused again (mode=%, was %)',
    v_mode, coalesce(v_previous, 'absent');
end
$do$;

commit;
