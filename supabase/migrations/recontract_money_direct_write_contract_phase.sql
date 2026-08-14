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
--   * the SIX mode-gated guard triggers are present, ENABLED, still bound to
--     their declared trigger functions, and those functions still consult the
--     release-mode gate as SECURITY INVOKER: contracts,
--     payments, installment_plans, contract_approvals, payment_allocations and
--     quotations. These are the same six the `deferred_contract` posture predicate
--     `strict-mode-controlled-guards-match-the-declaration` names in
--     infra/release/release-manifest.json — deliberately the same set, so the
--     artifact and the verifier cannot disagree about what the posture is, and
--     tests/release/mode-controlled-guards.test.mjs derives the set from the
--     migrations themselves so neither of them can drift from the SQL again, and
--   * the seventh guard trigger, trg_guard_contract_transition, which is NOT
--     mode-gated — it refuses an impossible status change in both modes — but is
--     still part of what makes a money write safe, so it is checked separately
--     rather than counted among the six, and
--   * the two KPI write routines, public.replace_kpi_targets(text, jsonb, uuid)
--     and public.clear_kpi_targets(text, uuid). They are here because the rollback
--     path can remove them and the mode cannot put them back: rollback_l0_20260811
--     reverts 20260811100500 by dropping replace_kpi_targets, and a re-contract
--     that declared 'strict' without it would leave the KPI save route with no
--     routine to call and no way to change a period's targets except the direct
--     table write 20260817150000 exists to remove.
--
-- Round-4 C4-2 · what this list used to say, and why it was wrong
-- --------------------------------------------------------------
-- It named four triggers — contracts, payments, quotations, contract transition —
-- and claimed the other three "are not mode-gated: they refuse a session write in
-- both modes". That was true of 20260812000000 and stopped being true at
-- 20260814000000, which rewrote guard_installment_plans_write() and
-- guard_definer_only_write() to return early while
-- public.money_direct_write_is_blocked() is false, so that the previous release
-- could keep writing during the compatibility window. Measured on PG 17.10 after
-- both phases: six enabled triggers whose function body calls that gate, and
-- trg_guard_contract_transition is not one of them. So the old set was wrong in
-- both directions at once, and with the three real ones dropped this file still
-- declared 'strict' and exited 0.
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
  -- The six mode-gated guards, as (trigger, table, function, exact prosrc SHA-256)
  -- declarations. A trigger name alone is not the guard, because
  -- trg_require_current_session proves one name can be attached to twenty tables,
  -- and guard_definer_only_write() backs two of these six under two different
  -- trigger names. The digest is over pg_proc.prosrc's UTF-8 bytes after a clean
  -- replay of the numbered migrations; it prevents a no-op body from satisfying
  -- this check merely by retaining the gate name in a comment or string literal.
  v_guards   text[][] := array[['trg_guard_contracts_write',           'contracts',           'public.guard_contracts_write()',         '4cf1b6b7264ec7e8228f51ea57c8acb0f0aa09d5806c041cea520d52c8e92012'],
                               ['trg_guard_payments_write',            'payments',            'public.guard_payments_write()',          'c32179d89b956eb24a187b441a706b82ee04e4462067406edb92d2552b32a1e8'],
                               ['trg_guard_installment_plans_write',   'installment_plans',   'public.guard_installment_plans_write()', 'fcf92768dc68b6450e200c4b22b30ce27b0aa90471b5a18f39f78b461683e052'],
                               ['trg_guard_contract_approvals_write',  'contract_approvals',  'public.guard_definer_only_write()',       '0ac33b97358b40023346fb09647c5927613ac6888be443c3aff47984c82615bb'],
                               ['trg_guard_payment_allocations_write', 'payment_allocations', 'public.guard_definer_only_write()',       '0ac33b97358b40023346fb09647c5927613ac6888be443c3aff47984c82615bb'],
                               ['trg_guard_quotations_write',          'quotations',          'public.guard_quotations_write()',         '830b4dabef7df1e3709e23a33cbeda27c065964e7a737b632c8670d591e36e45']];
  v_routines text[] := array['public.replace_kpi_targets(text, jsonb, uuid)',
                             'public.clear_kpi_targets(text, uuid)'];
  v_routine  text;
  v_extra    text;
  v_previous text;
begin
  if to_regclass('public.money_release_mode') is null then
    raise exception 'public.money_release_mode does not exist; there is no contract phase to re-enter'
      using errcode = '42P01';
  end if;

  -- Round-4 C4-3 · the exclusive flip lock, taken BEFORE the posture checks and
  -- not merely before the write.
  --
  -- The order matters here more than in the other two artifacts: everything
  -- below reads the database to decide whether 'strict' would be true, and a
  -- posture measured before the lock is a posture measured while the writes it
  -- describes are still in flight. Taking the lock first means the guard set,
  -- the KPI routines and the mode row are all read after the direct writes
  -- admitted under 'compat' have drained, so the readback that follows is a
  -- statement about a quiet database rather than about a moving one.
  if to_regprocedure('public.money_release_mode_lock_key()') is null then
    v_missing := v_missing || 'function public.money_release_mode_lock_key()';
    raise exception 'refusing to declare the strict posture: % is missing, so this re-contract could not be serialized against in-flight direct writes',
      array_to_string(v_missing, ', ')
      using errcode = '42P01';
  end if;
  perform set_config('lock_timeout',
                     coalesce(nullif(current_setting('lock_timeout'), '0'), '15s'),
                     true);
  perform pg_advisory_xact_lock(public.money_release_mode_lock_key());

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
  -- check exists to catch. The table and function are named as well as the
  -- trigger, so a guard re-attached to the wrong relation or rebound to a
  -- different function is a miss rather than a match. Requiring the exact shipped
  -- function-body digest catches in-place no-op replacements, including bodies
  -- that mention money_direct_write_is_blocked() only in a comment or literal.
  for i in 1 .. array_length(v_guards, 1) loop
    if not exists (select 1
                     from pg_trigger g
                     join pg_class c on c.oid = g.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                     join pg_proc p on p.oid = g.tgfoid
                    where not g.tgisinternal
                      and g.tgenabled = 'O'
                      and n.nspname = 'public'
                      and g.tgname = v_guards[i][1]
                      and c.relname = v_guards[i][2]
                      and p.prokind = 'f'
                      and not p.prosecdef
                      and g.tgfoid = to_regprocedure(v_guards[i][3])
                      and pg_catalog.encode(
                            pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')),
                            'hex'
                          ) = v_guards[i][4]) then
      v_missing := v_missing || ('enabled mode-gated trigger ' || v_guards[i][1]
                                 || ' on public.' || v_guards[i][2]
                                 || ' backed by ' || v_guards[i][3]);
    end if;
  end loop;

  -- The transition graph, which the mode does NOT stand down. Checked separately
  -- from the six above so that the count of mode-gated guards stays a measurement
  -- rather than a habit; see the header.
  if not exists (select 1
                   from pg_trigger g
                   join pg_class c on c.oid = g.tgrelid
                   join pg_namespace n on n.oid = c.relnamespace
                  where not g.tgisinternal
                    and g.tgenabled = 'O'
                    and n.nspname = 'public'
                    and g.tgname = 'trg_guard_contract_transition'
                    and c.relname = 'contracts'
                    -- `before update`, not `before update of status`: a column list
                    -- makes the graph fire on the writer's target list instead of on
                    -- the row, so a conditional form here is a posture this file
                    -- must not declare.
                    and g.tgtype = 19
                    and g.tgattr::text = '') then
    v_missing := v_missing || 'enabled unconditional trigger trg_guard_contract_transition on public.contracts';
  end if;

  -- The other direction, and the reason this file can be trusted as the mirror of
  -- the posture predicate: a guard that reads the mode and is NOT on the list is
  -- a guard nobody verified. It is reported here rather than tolerated, because
  -- the alternative is a set that silently stops being the set.
  for v_extra in
    select g.tgname || ' on public.' || c.relname
      from pg_trigger g
      join pg_class c on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = g.tgfoid
     where not g.tgisinternal
       and g.tgenabled = 'O'
       and n.nspname = 'public'
       and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%money_direct_write_is_blocked%'
       and not exists (select 1
                         from generate_subscripts(v_guards, 1) as s
                        where v_guards[s][1] = g.tgname
                          and v_guards[s][2] = c.relname)
  loop
    v_missing := v_missing || ('undeclared mode-gated trigger ' || v_extra);
  end loop;

  -- The KPI write path. Present, SECURITY DEFINER, and reachable only by
  -- service_role: 20260817150000 grants EXECUTE to service_role alone precisely
  -- so the route cannot be replaced by a session-side call, and a re-contract that
  -- accepted a routine granted to `authenticated` would restore that surface while
  -- reporting the posture as re-entered.
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
