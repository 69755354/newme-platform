-- ============================================================================
-- Replay harness — step 4: the strict posture, re-entered after a rollback
-- ============================================================================
-- Executed by scripts/replay-migrations.sh immediately after every
-- supabase/migrations/recontract_*.sql file has been applied, which happens
-- after the rollback companions and after 20_assert_post_rollback.sql. The
-- database this file measures has therefore been through the whole round trip:
--
--   expand + contract  →  strict        (the migrations)
--   rollback companion →  compat        (20_assert_post_rollback.sql measured it)
--   recontract         →  strict        (this file)
--
-- Review round 4 B9: "rollback enters compat but there is no verified re-contract
-- path". The path is recontract_money_direct_write_contract_phase.sql; this file
-- is the "verified" half, and it is deliberately behavioural. The two things a
-- posture check must not be are a column read and a catalog read: after the
-- round trip, `direct_write_mode = 'strict'` is a claim, and the only evidence
-- that the claim is true is that a browser session's direct money write is
-- refused again. 20_assert_post_rollback.sql proves the same statements SUCCEED
-- in compat, so the pair measures the transition rather than a constant.
--
-- The companion is applied TWICE by the runner before this file runs. An
-- operator who re-runs a hand-run artifact — or who cannot tell whether the
-- first run committed — must not be punished for it, and a second application
-- must leave one row in one state rather than two rows or a raised exception.
-- 'recontract-is-idempotent-one-row-one-audit-trail-per-run' is where that is
-- measured.
--
-- Failure raises, and the runner fails the job. The ASSERT_OK count is
-- cross-checked against ASSERT_TOTAL, so a file that stops early cannot pass
-- quietly.
--
-- ASSERT_TOTAL: 19
-- ============================================================================

create temp table if not exists post_recontract_assert_log (name text);
truncate post_recontract_assert_log;

create or replace function pg_temp.assert(condition boolean, assertion_name text)
returns void
language plpgsql
as $$
begin
  if condition is not true then
    raise exception 'ASSERT_FAIL %', assertion_name using errcode = '22000';
  end if;
  insert into post_recontract_assert_log (name) values (assertion_name);
  raise notice 'ASSERT_OK %', assertion_name;
end
$$;

-- The browser session fixture, identical to the other two assertion files: sub,
-- role and iat, because the restrictive session boundary fails closed when `iat`
-- is absent and a fixture without it would be refused on every table for the
-- wrong reason.
create or replace function pg_temp.act_as(p_uid uuid, p_iat_offset interval default interval '0')
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub',  p_uid,
      'role', 'authenticated',
      'iat',  floor(extract(epoch from now() + p_iat_offset))::bigint
    )::text,
    true);
end
$$;

-- ============================================================================
-- Proof that the re-contract ran, and that it ran from 'compat'
-- ============================================================================
-- Checked first and by name: if the artifact did not run, every assertion below
-- is measuring the forward state the migrations already left, which is the shape
-- of a rubber stamp. The audit row is the discriminator — it records where the
-- transition came from, so a database that was never rolled back cannot produce
-- `previous_mode = 'compat'`.
select pg_temp.assert((select count(*) = 1 from public.audit_logs
                        where action = 'MONEY_CONTRACT_PHASE_REENTERED'
                          and details ->> 'previous_mode' = 'compat'),
                      'recontract-actually-executed-from-the-rolled-back-state');
select pg_temp.assert((select details ->> 'artifact' = 'recontract_money_direct_write_contract_phase.sql'
                       from public.audit_logs
                       where action = 'MONEY_CONTRACT_PHASE_REENTERED'
                         and details ->> 'previous_mode' = 'compat'),
                      'recontract-audit-row-names-the-artifact-that-wrote-it');
-- Two runs, one row in money_release_mode, and one audit row per run: the second
-- application reports 'strict' as its previous mode, so re-running is recorded
-- as a re-run rather than being silently collapsed or raising.
select pg_temp.assert((select count(*) = 1 from public.money_release_mode)
                      and (select count(*) = 2 from public.audit_logs
                            where action = 'MONEY_CONTRACT_PHASE_REENTERED')
                      and (select count(*) = 1 from public.audit_logs
                            where action = 'MONEY_CONTRACT_PHASE_REENTERED'
                              and details ->> 'previous_mode' = 'strict'),
                      'recontract-is-idempotent-one-row-one-audit-trail-per-run');

-- ============================================================================
-- The mode itself, through the function the guards actually call
-- ============================================================================
select pg_temp.assert((select direct_write_mode = 'strict' from public.money_release_mode where id = 'only'),
                      'recontract-release-mode-row-is-strict-again');
select pg_temp.assert(public.money_direct_write_mode() = 'strict',
                      'recontract-mode-function-reports-strict-again');
-- The exact guard bodies below all delegate to this closure. Pinning the
-- closure here mirrors both manifest phases and prevents a same-signature gate
-- that always returns false from turning a strict mode row into a false claim.
select pg_temp.assert((select count(*) = 4
                              and bool_and(coalesce(
                                    p.prokind = 'f'
                                    and pg_catalog.encode(
                                          pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')),
                                          'hex'
                                        ) = d.prosrc_sha256
                                    and l.lanname = d.lanname
                                    and p.provolatile = d.provolatile
                                    and p.prosecdef = d.prosecdef,
                                    false))
                         from (values ('public.money_direct_write_is_blocked()', '7e441dc681f66aa2f58c001a9c8a705fe6b01400a80b50491dd98b95e6093ed5', 'plpgsql', 'v', false),
                                      ('public.money_write_is_direct()',          '79bf852b44dea5fdfc5e5f9799fa5cff7253929d30cbd87dc012e0b57ba06a5d', 'sql',     's', false),
                                      ('public.money_direct_write_mode()',        'adabfffdd1b4f00dbac0f37a062225cafc954084db8e0d38fd749d293d811dde', 'sql',     's', true),
                                      ('public.money_release_mode_lock_key()',    'a58de3a00df07a1ccfe3250cf009c3a77675df80ce268f092124b236192cf26a', 'sql',     'i', false))
                                as d(proregprocedure, prosrc_sha256, lanname, provolatile, prosecdef)
                         left join pg_catalog.pg_proc p
                           on p.oid = to_regprocedure(d.proregprocedure)
                         left join pg_catalog.pg_language l on l.oid = p.prolang),
                      'recontract-money-gate-dependency-closure-is-exact');
-- The manifest's `deferred_contract` posture predicates read exactly these two,
-- the six mode-gated guards below, the transition guard and the two KPI write
-- routines. Asserting the same sets here is deliberate: `--verify-only` after a
-- re-contract must be answering the same question this gate answers, or the
-- operator's check and the gate's check are two different claims wearing one name.
--
-- Round-4 C4-2 · what this block used to assert
-- --------------------------------------------
-- One assertion, `count(*) = 4` over trg_guard_contracts_write,
-- trg_guard_payments_write, trg_guard_quotations_write and
-- trg_guard_contract_transition, with the comment above it claiming that set was
-- deliberately the same as the manifest's. The set was the same, and both were
-- wrong in both directions: trg_guard_contract_transition does not read the
-- release mode at all, and trg_guard_installment_plans_write,
-- trg_guard_contract_approvals_write and trg_guard_payment_allocations_write have
-- read it since 20260814000000 rewrote them to stand down during the compatibility
-- window. Measured on PG 17.10 after both phases: SIX enabled triggers whose
-- function body calls public.money_direct_write_is_blocked(), and the transition
-- guard is not one of them. Because a name was counted that could not fail, the
-- count still reached four with three real guards dropped.
--
-- The trigger name alone is not the guard: trg_require_current_session proves one
-- name can be attached to twenty tables, and guard_definer_only_write() backs two
-- of these six under two different trigger names. So each declaration binds the
-- trigger, table, function and exact SHA-256 of pg_proc.prosrc, matched both ways.
-- The digest prevents a no-op replacement with the gate name left in a comment or
-- string from passing. `tgenabled = 'O'` because a DISABLED trigger reads as
-- present in pg_trigger and refuses nothing.
select pg_temp.assert((select count(*) = 6
                       from (values ('trg_guard_contracts_write',           'contracts',           'public.guard_contracts_write()',         '4cf1b6b7264ec7e8228f51ea57c8acb0f0aa09d5806c041cea520d52c8e92012'),
                                    ('trg_guard_payments_write',            'payments',            'public.guard_payments_write()',          'c32179d89b956eb24a187b441a706b82ee04e4462067406edb92d2552b32a1e8'),
                                    ('trg_guard_installment_plans_write',   'installment_plans',   'public.guard_installment_plans_write()', 'fcf92768dc68b6450e200c4b22b30ce27b0aa90471b5a18f39f78b461683e052'),
                                    ('trg_guard_contract_approvals_write',  'contract_approvals',  'public.guard_definer_only_write()',       '0ac33b97358b40023346fb09647c5927613ac6888be443c3aff47984c82615bb'),
                                    ('trg_guard_payment_allocations_write', 'payment_allocations', 'public.guard_definer_only_write()',       '0ac33b97358b40023346fb09647c5927613ac6888be443c3aff47984c82615bb'),
                                    ('trg_guard_quotations_write',          'quotations',          'public.guard_quotations_write()',         '830b4dabef7df1e3709e23a33cbeda27c065964e7a737b632c8670d591e36e45')) as d(tgname, relname, proregprocedure, prosrc_sha256)
                       where exists (select 1
                                       from pg_trigger g
                                       join pg_class c on c.oid = g.tgrelid
                                       join pg_namespace n on n.oid = c.relnamespace
                                       join pg_proc p on p.oid = g.tgfoid
                                      where not g.tgisinternal
                                        and g.tgenabled = 'O'
                                        and n.nspname = 'public'
                                        and g.tgname = d.tgname
                                        and c.relname = d.relname
                                        and p.prokind = 'f'
                                        and not p.prosecdef
                                        and g.tgfoid = to_regprocedure(d.proregprocedure)
                                        and pg_catalog.encode(
                                              pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')),
                                              'hex'
                                            ) = d.prosrc_sha256)),
                      'recontract-the-six-mode-gated-guards-are-still-enabled');
-- The other direction, which is what stops this list from silently ceasing to be
-- the list: a trigger whose function consults the release mode and is not declared
-- above is a guard nobody verified. A future migration that adds one fails here
-- until it is declared in all three places
-- (tests/release/mode-controlled-guards.test.mjs enforces the "all three").
select pg_temp.assert((select count(*) = 0
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
                                          from (values ('trg_guard_contracts_write',           'contracts',           'public.guard_contracts_write()',         '4cf1b6b7264ec7e8228f51ea57c8acb0f0aa09d5806c041cea520d52c8e92012'),
                                                       ('trg_guard_payments_write',            'payments',            'public.guard_payments_write()',          'c32179d89b956eb24a187b441a706b82ee04e4462067406edb92d2552b32a1e8'),
                                                       ('trg_guard_installment_plans_write',   'installment_plans',   'public.guard_installment_plans_write()', 'fcf92768dc68b6450e200c4b22b30ce27b0aa90471b5a18f39f78b461683e052'),
                                                       ('trg_guard_contract_approvals_write',  'contract_approvals',  'public.guard_definer_only_write()',       '0ac33b97358b40023346fb09647c5927613ac6888be443c3aff47984c82615bb'),
                                                       ('trg_guard_payment_allocations_write', 'payment_allocations', 'public.guard_definer_only_write()',       '0ac33b97358b40023346fb09647c5927613ac6888be443c3aff47984c82615bb'),
                                                       ('trg_guard_quotations_write',          'quotations',          'public.guard_quotations_write()',         '830b4dabef7df1e3709e23a33cbeda27c065964e7a737b632c8670d591e36e45')) as d(tgname, relname, proregprocedure, prosrc_sha256)
                                          where d.tgname = g.tgname::text
                                            and d.relname = c.relname::text
                                            and g.tgfoid = to_regprocedure(d.proregprocedure)
                                            and pg_catalog.encode(
                                                  pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')),
                                                  'hex'
                                                ) = d.prosrc_sha256)),
                      'recontract-no-undeclared-mode-gated-guard-exists');
-- The seventh guard trigger, which the mode does NOT stand down: it refuses an
-- impossible status change in both modes. Checked separately so the count of
-- mode-gated guards above stays a measurement rather than a habit — the previous
-- revision of this block is what counting it produced.
select pg_temp.assert((select count(*) = 1
                       from pg_trigger g
                       join pg_class c on c.oid = g.tgrelid
                       join pg_namespace n on n.oid = c.relnamespace
                      where not g.tgisinternal
                        and g.tgenabled = 'O'
                        and n.nspname = 'public'
                        and g.tgname = 'trg_guard_contract_transition'
                        and c.relname = 'contracts'),
                      'recontract-the-transition-guard-is-still-enabled');
-- And still unconditional: `before update`, not `before update of status`. A
-- column list would make the graph depend on which columns a writer names, and
-- re-declaring 'strict' over that is declaring a posture that is not there.
select pg_temp.assert((select tgtype = 19 and tgattr::text = '' from pg_trigger
                       where tgrelid = 'public.contracts'::regclass
                         and tgname = 'trg_guard_contract_transition'),
                      'recontract-the-transition-guard-is-still-unconditional');
-- The KPI write path, which is here because the rollback direction can remove it
-- and the mode cannot put it back. 20_assert_post_rollback.sql asserts both
-- routines survive the companions; this asserts the re-contract did not declare
-- 'strict' over a database that has no way to change a period's targets except the
-- direct table write 20260817150000 exists to remove.
select pg_temp.assert((select count(*) = 2 from pg_proc p
                        where p.prokind = 'f'
                          and p.oid in (to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)'),
                                        to_regprocedure('public.clear_kpi_targets(text, uuid)'))),
                      'recontract-kpi-write-routines-are-installed');
select pg_temp.assert((select count(*) = 2
                         and bool_and(p.prosecdef)
                         and bool_and(has_function_privilege('service_role', p.oid, 'execute'))
                         and not bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
                         and not bool_or(has_function_privilege('anon', p.oid, 'execute'))
                       from pg_proc p
                       where p.prokind = 'f'
                         and p.oid in (to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)'),
                                       to_regprocedure('public.clear_kpi_targets(text, uuid)'))),
                      'recontract-kpi-write-routines-are-server-only');

-- ============================================================================
-- Behaviour: the writes the compatibility window accepted are refused again
-- ============================================================================
-- Each of these three statements is asserted to SUCCEED in
-- 20_assert_post_rollback.sql under 'compat'
-- (money-post-rollback-previous-release-can-write-a-contract-status,
--  -can-insert-a-contract, and the round-4 first_payment_status write). Here the
-- same statements, from the same session identity, must be refused with 42501.
do $$
declare
  v_status_state text := '00000';
  v_status       text := 'unset';
  v_insert_state text := '00000';
  v_insert_msg   text := '';
  -- false, not true. 20_assert_post_rollback.sql initialises the same variable to
  -- true because there the insert is expected to SUCCEED and the initial value is
  -- always overwritten. Here the insert is expected to be refused, so the
  -- exception path is the normal one and it never reaches the assignment: an
  -- optimistic initial value would report "the row was inserted" for a statement
  -- that raised 42501.
  v_inserted     boolean := false;
  v_fps_state    text := '00000';
  v_fps_msg      text := '';
begin
  begin
    -- The previous release's status write.
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.contracts set status = 'completed'
       where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';
      v_status := (select status from public.contracts
                    where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4');
    exception when others then v_status_state := sqlstate;
    end;
    reset role;

    -- The previous release's contract insert. Its own lead, for the reason the
    -- post-rollback file gives: idx_contracts_one_active_per_lead permits one
    -- non-terminal contract per lead, so a shared lead would fail with 23505 and
    -- say nothing about the release mode. A different id from the post-rollback
    -- fixture's, because that statement committed nothing but this file runs on
    -- the same database.
    insert into public.leads (id, assigned_to, stage, customer_name, source)
    values ('13131313-1313-1313-1313-131313131313',
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'won', 'Replay post-recontract lead', 'other');
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      insert into public.contracts (lead_id, sales_id, created_by, contract_no,
                                    contract_amount, party_a_name, status)
      values ('13131313-1313-1313-1313-131313131313',
              'cccccccc-cccc-cccc-cccc-cccccccccccc',
              'cccccccc-cccc-cccc-cccc-cccccccccccc',
              'REPLAY-POST-RECONTRACT-1', 1, 'x', 'draft');
      v_inserted := exists (select 1 from public.contracts
                             where contract_no = 'REPLAY-POST-RECONTRACT-1');
    exception when others then v_insert_state := sqlstate; v_insert_msg := sqlerrm;
    end;
    reset role;

    -- And the round-4 derived-column write: first_payment_status is derived by
    -- contract_first_payment_status() and is not a field a session may set.
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.contracts set first_payment_status = 'paid'
       where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';
    exception when others then v_fps_state := sqlstate; v_fps_msg := sqlerrm;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;

  if v_status_state <> '42501' then
    raise notice 'the re-entered strict posture accepted a direct contract status write: sqlstate %', v_status_state;
  end if;
  perform pg_temp.assert(v_status_state = '42501' and v_status = 'unset',
                         'recontract-direct-contract-status-update-is-refused-again');
  if v_insert_state <> '42501' then
    raise notice 'the re-entered strict posture accepted a direct contract insert: sqlstate %, %',
      v_insert_state, v_insert_msg;
  end if;
  perform pg_temp.assert(v_insert_state = '42501' and not v_inserted,
                         'recontract-direct-contract-insert-is-refused-again');
  perform pg_temp.assert(v_fps_state = '42501' and v_fps_msg like '%first_payment_status%',
                         'recontract-direct-derived-column-write-is-refused-again');
  perform pg_temp.assert((select status = 'active' from public.contracts
                          where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4')
                         and not exists (select 1 from public.contracts
                                          where contract_no = 'REPLAY-POST-RECONTRACT-1'),
                         'recontract-fixture-was-rolled-back');
end
$$;

-- ============================================================================
-- What the round trip must not have cost
-- ============================================================================
-- The rollback direction is where a companion can quietly re-open a hole, and
-- 20_assert_post_rollback.sql spends fifty-three assertions on that. The forward
-- direction has the mirror-image risk: an artifact that restores 'strict' by
-- recreating objects could restore an OLD definition of them. This one is
-- allowed to touch one row in one table, so the check is that the routines the
-- strict posture depends on are still the release's own — definer, with a pinned
-- search_path — and that the RPCs a session must now use are all still callable.
select pg_temp.assert((select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
                       from pg_proc where oid = to_regprocedure('public.money_actor(uuid, text[])')),
                      'recontract-actor-identity-is-still-definer-with-a-pinned-search-path');
select pg_temp.assert((select count(*) = 7 from (values ('create_contract'),
                                                        ('approve_contract'),
                                                        ('revoke_contract'),
                                                        ('confirm_payment'),
                                                        ('allocate_payment'),
                                                        ('void_payment'),
                                                        ('convert_quotation_to_contract')) as r(n)
                       where exists (select 1 from pg_proc p
                                       join pg_namespace s on s.oid = p.pronamespace
                                      where s.nspname = 'public' and p.proname = r.n)),
                      'recontract-all-seven-money-rpcs-are-still-installed');
-- F-02 again, in one assertion rather than three: the published credential must
-- still be neutralised after the round trip, because "we rolled back and rolled
-- forward again" is exactly the window in which a re-enabled identity would go
-- unnoticed.
select pg_temp.assert((select is_active is false and force_password_change is true
                       from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
                      'recontract-f02-published-credential-is-still-neutralised');

-- ============================================================================
-- Self-check: every assertion above ran.
-- ============================================================================
do $$
declare
  total int;
begin
  select count(*) into total from post_recontract_assert_log;
  if total <> 19 then
    raise exception 'post-recontract assertion file ran % assertions, ASSERT_TOTAL says 19', total
      using errcode = '22000';
  end if;
  raise notice 'all % post-recontract assertions passed', total;
end
$$;
