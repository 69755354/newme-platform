-- ============================================================================
-- Rollback companion: return to the compatibility window
-- ============================================================================
-- ROLLS_BACK: 20260818000000_money_direct_write_contract_phase.sql
--
-- The name deliberately does not match ^[0-9]{14}_ so the Supabase CLI will never
-- apply it. It is run by hand, by an operator, at a rollback.
--
-- What it does: puts public.money_release_mode back to 'compat', which is the
-- state 20260814000000 seeded. The column and insert guards stand down for direct
-- end-user writes again, so the PREVIOUS release (f37c203 / 81956f2) can create
-- contracts, installment plans and approvals and confirm payments through
-- PostgREST exactly as it does in production today.
--
-- What it does NOT do, and this is the part that matters
-- -----------------------------------------------------
-- The reviewed round-2 rollback companion re-enabled the published credential's
-- profile, re-granted meta_tokens to authenticated, re-granted profiles UPDATE
-- and recreated the with_check(true) audit-insert policy: it rolled the security
-- fixes back along with the schema, and the gate was green because SQL that opens
-- a hole runs as cleanly as SQL that closes one. This companion touches exactly
-- one row in one table. Everything else stays closed:
--
--   * money_actor() still binds the actor to the session's JWT subject, still
--     refuses a NULL role, and still calls assert_current_session()
--   * the class-28 session boundary and trg_require_current_session stay on every
--     table, so revoked, banned, stale-token and password-change-owing sessions
--     are still refused inside every SECURITY DEFINER RPC
--   * DELETE on contracts, payments, installment_plans, contract_approvals and
--     payment_allocations stays refused and stays un-granted — no release has
--     ever issued it from a session, so it is not part of the compatibility story
--   * the contract transition graph, lead ownership in create_contract(), the
--     installment invariant in convert_quotation_to_contract(), the plan locking
--     in allocate_payment() and the admin/boss/finance payment rule are all
--     unaffected: they live in the routines, not in the mode
--   * F-02, F-06, F-08, F-09 and F-10 are untouched
--
-- The honest cost, stated rather than buried: while the mode is 'compat' a
-- browser session can write contracts.status and payments.confirmed directly.
-- That is the posture production has today. Reverting to it is a return to the
-- status quo, not a new hole — and it is the only thing that makes an
-- application-only rollback a rollback rather than a rename for roll-forward.
--
-- Round-4 R7 · the list above used to be prose only
-- ------------------------------------------------
-- Every bullet was a claim about the database this file leaves behind, and this
-- file checked none of them. It updated one row and read that same row back, so
-- the only way it could fail was if the UPDATE itself failed. Two consequences
-- review found, both of which this revision closes:
--
--   * the read-back went to the column, never through public.money_direct_write_mode().
--     The guards call the function, so a function redefined to return a constant
--     — or dropped and recreated wrong — passes a column check and refuses
--     nothing. The recontract companion already read back through the function;
--     the rollback did not, which is the direction where an unnoticed mismatch
--     re-opens direct writes without anyone being told.
--   * "everything else stays closed" was asserted in a comment. If the session
--     boundary, the transition graph or the KPI routines are missing when this
--     runs, then rolling the mode back to 'compat' is not "a return to the status
--     quo", it is a return to something the previous release never ran under. The
--     checks below make that case a refusal instead of a green rollback.
--
-- And a posture change made by hand is now recorded like one, in audit_logs,
-- with the mode it replaced — the same row shape recontract_* writes, so the two
-- directions of a rollback/roll-forward cycle can be read off one table.
--
-- What is NOT checked here, deliberately: the six mode-gated guards. This file's
-- whole purpose is to stand them down, so requiring them present would be
-- requiring the state this file exists to leave. The recontract companion checks
-- them, because it is the direction that must find them enabled.
--
-- supabase/replay/20_assert_post_rollback.sql asserts both halves at the
-- behaviour level after this file runs, and
-- supabase/replay/24_rollback_companion_guards.sh runs the negative directions:
-- a redefined mode function, a disabled session boundary and a missing KPI
-- routine each have to make this file refuse.
-- ============================================================================

begin;

do $do$
declare
  v_mode     text;
  v_previous text;
  v_missing  text[] := '{}';
  v_routine  text;
  v_routines text[] := array['public.replace_kpi_targets(text, jsonb, uuid)',
                             'public.clear_kpi_targets(text, uuid)'];
  v_uncovered text;
  v_covered  int := 0;
begin
  if to_regclass('public.money_release_mode') is null then
    raise exception 'public.money_release_mode does not exist; there is no contract phase to roll back'
      using errcode = '42P01';
  end if;

  -- Round-4 C4-3 · the same exclusive lock the contract phase takes, for the
  -- same reason in the other direction: a write that is in flight under 'strict'
  -- is a write the RPCs admitted, and re-opening direct writes underneath it
  -- would leave two postures in effect inside one transaction's lifetime. This
  -- also serializes a rollback against a concurrent re-contract, so the last
  -- posture to commit is the one the row records rather than a race.
  if to_regprocedure('public.money_release_mode_lock_key()') is null then
    raise exception 'public.money_release_mode_lock_key() does not exist; this database predates the serialized flip, so a rollback here cannot be ordered against in-flight money writes. Apply 20260814000000 before rolling back'
      using errcode = '42P01';
  end if;
  perform set_config('lock_timeout',
                     coalesce(nullif(current_setting('lock_timeout'), '0'), '15s'),
                     true);
  perform pg_advisory_xact_lock(public.money_release_mode_lock_key());

  -- ── The header's promises, checked ────────────────────────────────────────
  -- Read after the lock, for the reason the recontract companion states: a
  -- posture measured before the lock is measured while the writes it describes
  -- are still in flight.

  -- The mode is only as real as the code that reads it, and this file is about to
  -- make a claim about what that code will return.
  -- Every append is cast: `text[] || 'literal'` resolves to array_cat against an
  -- unknown-typed literal and fails with "malformed array literal", so an
  -- uncast one turns a named refusal into a parse error at the moment it is
  -- needed most.
  if to_regprocedure('public.money_direct_write_mode()') is null then
    v_missing := v_missing || 'function public.money_direct_write_mode()'::text;
  end if;
  if to_regprocedure('public.money_direct_write_is_blocked()') is null then
    v_missing := v_missing || 'function public.money_direct_write_is_blocked()'::text;
  end if;

  -- money_actor(uuid, text[]) binds the actor to the session's JWT subject and
  -- refuses a NULL role. 'compat' does not stand it down, and the previous release
  -- depends on it, so its absence means the state this rollback would produce is
  -- not the state production ran under. The argument types are part of the check:
  -- a same-named routine with a different signature is not this one.
  if to_regprocedure('public.money_actor(uuid, text[])') is null then
    v_missing := v_missing || 'function public.money_actor(uuid, text[])'::text;
  end if;
  if to_regprocedure('public.assert_current_session()') is null then
    v_missing := v_missing || 'function public.assert_current_session()'::text;
  end if;

  -- The class-28 session boundary, on every public base table, which is how
  -- 20260816000000 installs it: a revoked, banned, stale-token or
  -- password-change-owing session must still be refused after this file runs.
  -- Named tables rather than a count, so a boundary re-attached to the wrong
  -- relation is a miss instead of a match.
  for v_uncovered in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and not c.relispartition
       and not exists (select 1
                         from pg_trigger g
                        where g.tgrelid = c.oid
                          and not g.tgisinternal
                          and g.tgenabled = 'O'
                          and g.tgname = 'trg_require_current_session')
     order by 1
  loop
    v_missing := v_missing || ('enabled trigger trg_require_current_session on public.' || v_uncovered);
  end loop;
  select count(*) into v_covered
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relispartition;
  if v_covered = 0 then
    v_missing := v_missing || 'any public base table (the session boundary matched nothing, which cannot be right)'::text;
  end if;

  -- The contract transition graph, which the mode does NOT gate. `before update`
  -- unconditionally, not `before update of status`: a column list makes the graph
  -- fire on the writer's target list instead of on the row, and under 'compat' a
  -- session writes contracts.status directly — so this is exactly the release
  -- state where a conditional form would be a hole.
  if not exists (select 1
                   from pg_trigger g
                   join pg_class c on c.oid = g.tgrelid
                   join pg_namespace n on n.oid = c.relnamespace
                  where not g.tgisinternal
                    and g.tgenabled = 'O'
                    and n.nspname = 'public'
                    and g.tgname = 'trg_guard_contract_transition'
                    and c.relname = 'contracts'
                    and g.tgtype = 19
                    and g.tgattr::text = '') then
    v_missing := v_missing || 'enabled unconditional trigger trg_guard_contract_transition on public.contracts'::text;
  end if;

  -- The KPI write path: present, SECURITY DEFINER, service_role only. This is the
  -- dead end rollback_l0_20260811.sql documents — a database left in a posture
  -- whose KPI save path is absent — reported here rather than produced.
  foreach v_routine in array v_routines loop
    if to_regprocedure(v_routine) is null then
      v_missing := v_missing || ('function ' || v_routine);
    elsif not (select p.prosecdef
                 and has_function_privilege('service_role', p.oid, 'execute')
                 and not has_function_privilege('authenticated', p.oid, 'execute')
                 and not has_function_privilege('anon', p.oid, 'execute')
                 from pg_proc p where p.oid = to_regprocedure(v_routine)) then
      v_missing := v_missing || ('the server-only definer posture of ' || v_routine);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'refusing to return to the compatibility window: % is missing, so ''compat'' here would not be the posture the previous release ran under',
      array_to_string(v_missing, ', ')
      using errcode = '42P01';
  end if;

  select direct_write_mode into v_previous
    from public.money_release_mode where id = 'only';

  update public.money_release_mode
     set direct_write_mode = 'compat',
         reason            = 'rolled back to the compatibility window so the previous '
                             || 'release can write money rows directly',
         changed_at        = now()
   where id = 'only';

  if not found then
    insert into public.money_release_mode (id, direct_write_mode, reason)
    values ('only', 'compat', 'restored the compatibility window at a rollback');
  end if;

  select direct_write_mode into v_mode from public.money_release_mode where id = 'only';
  if v_mode <> 'compat' then
    raise exception 'the rollback did not take effect (mode is %)', coalesce(v_mode, 'null')
      using errcode = '22000';
  end if;
  -- Read back through the function the guards call, not just the column. A mode
  -- function redefined to return a constant passes the column check above and
  -- keeps refusing the previous release's writes, which is a rollback that
  -- reports success and leaves the application broken.
  if public.money_direct_write_mode() <> 'compat' then
    raise exception 'the mode column says compat but public.money_direct_write_mode() says %',
      coalesce(public.money_direct_write_mode(), 'null')
      using errcode = '22000';
  end if;
  -- public.money_direct_write_is_blocked() is deliberately NOT called here. It
  -- returns false whenever `not money_write_is_direct()`, and current_user on an
  -- operator path is never `authenticated` — so from this session it answers
  -- 'false' no matter what the mode says. Asserting it would be a check that
  -- cannot fail. Its presence is verified above; the mode readback is the check,
  -- and supabase/replay/20_assert_post_rollback.sql evaluates the predicate from a
  -- session where it means something.

  -- A posture change made by hand, recorded like one. actor_id stays null for the
  -- reason revoke_user_sessions() and clear_kpi_targets() leave it null: there is
  -- no end-user identity on an operator path, and audit_logs.actor_id references
  -- auth.users.
  if to_regclass('public.audit_logs') is not null then
    insert into public.audit_logs (action, target_type, details)
    values ('MONEY_CONTRACT_PHASE_ROLLED_BACK', 'money_release_mode',
            jsonb_build_object('previous_mode', coalesce(v_previous, 'absent'),
                               'mode', v_mode,
                               'artifact', 'rollback_money_direct_write_contract_phase.sql',
                               'reversed_by', 'recontract_money_direct_write_contract_phase.sql'));
  end if;

  raise notice 'direct end-user money writes are accepted again (mode=%, was %)',
    v_mode, coalesce(v_previous, 'absent');
end
$do$;

commit;
