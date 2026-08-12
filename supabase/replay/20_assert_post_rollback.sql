-- ============================================================================
-- Replay harness — step 3: what the rollback is not allowed to restore
-- ============================================================================
-- Executed by scripts/replay-migrations.sh immediately after every rollback
-- companion in supabase/migrations/rollback_*.sql has been applied on top of the
-- fully-replayed schema.
--
-- The previous revision of this branch had no such step. The rollback gate was
-- "the SQL executes", and the SQL that executed re-enabled a credential
-- published in a public git history, re-granted a plaintext third-party access
-- token to every authenticated user, restored self-writable profiles.is_active /
-- email, and recreated a `with check (true)` audit-insert policy. All of that ran
-- cleanly, so the gate was green. SQL that opens a hole runs exactly as cleanly
-- as SQL that closes one; execution is not a security property.
--
-- So this file asserts the STATE the rollback leaves behind. Every assertion is
-- a security invariant that must survive a revert, plus two that must survive
-- for a different reason: the rollback must not brick the one legitimate
-- caller-scoped profiles write, and it must actually have run at all.
--
-- Failure raises, and the runner fails the job with "rollback restored a
-- security hole". The ASSERT_OK count is cross-checked against ASSERT_TOTAL, so
-- a file that stops early cannot pass quietly.
--
-- ASSERT_TOTAL: 50
-- ============================================================================

create temp table if not exists post_rollback_assert_log (name text);
truncate post_rollback_assert_log;

create or replace function pg_temp.assert(condition boolean, assertion_name text)
returns void
language plpgsql
as $$
begin
  if condition is not true then
    raise exception 'ASSERT_FAIL %', assertion_name using errcode = '22000';
  end if;
  insert into post_rollback_assert_log (name) values (assertion_name);
  raise notice 'ASSERT_OK %', assertion_name;
end
$$;

-- Acting as a browser session.
--
-- Since 20260813000000_session_revocation_boundary.sql the restrictive session
-- boundary reads the access token's `iat` claim and fails closed when it is
-- absent, so a fixture that sets only `request.jwt.claim.sub` would be refused
-- on every table and would prove nothing about the policy under test. This sets
-- the claim set to the shape GoTrue actually issues — sub, role and iat — which
-- is also what PostgREST puts in `request.jwt.claims`.
--
-- p_iat_offset exists for the revocation assertions: a negative offset produces
-- exactly the artefact the gate is for, a validly-signed token minted before the
-- password changed.
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
-- Proof that the rollback ran
-- ============================================================================
-- Exactly one thing in the companion is executable: it drops the KPI atomic
-- replace function, because removing a function opens nothing. If this assertion
-- fails, the companion did not run and every assertion below is measuring the
-- forward state instead of the post-rollback state — which is the shape of a
-- rubber stamp, so it is checked first and by name.
select pg_temp.assert(to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)') is null, 'rollback-actually-executed-kpi-function-dropped');

-- The same section of the companion drops the function and deliberately does NOT
-- drop the partial unique index it shipped alongside. Dropping a uniqueness
-- constraint on business data is not a revert: it re-permits the duplicate
-- unassigned targets that make every KPI view double-count.
select pg_temp.assert(to_regclass('public.idx_kpi_targets_one_unassigned_per_period_type') is not null, 'kpi-post-rollback-unassigned-uniqueness-survives');

-- ============================================================================
-- F-02 · the published credential stays neutralised
-- ============================================================================
-- The reviewed companion set is_active = true, force_password_change = false on
-- this profile. Re-enabling a credential that is readable in a public git
-- history is not part of reverting a deployment.
select pg_temp.assert((select is_active is false from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'f02-post-rollback-profile-still-inactive');
select pg_temp.assert((select force_password_change is true from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'f02-post-rollback-force-password-change-still-set');
-- And the other direction: a rollback must not delete the identity either, or
-- the audit attribution that points at it.
select pg_temp.assert((select count(*) = 1 from auth.users where email = 'dev@newme.ae'), 'f02-post-rollback-identity-still-present');

-- ============================================================================
-- F-10 · the Meta access token stays unreadable
-- ============================================================================
select pg_temp.assert(not has_table_privilege('authenticated', 'public.meta_tokens', 'select'), 'f10-post-rollback-authenticated-has-no-select-grant');
select pg_temp.assert(not has_table_privilege('anon', 'public.meta_tokens', 'select'), 'f10-post-rollback-anon-has-no-select-grant');
select pg_temp.assert(not (has_table_privilege('authenticated', 'public.meta_tokens', 'insert')
                        or has_table_privilege('authenticated', 'public.meta_tokens', 'update')
                        or has_table_privilege('authenticated', 'public.meta_tokens', 'delete')), 'f10-post-rollback-authenticated-has-no-write-grant');

-- Enumerated, not named: the hole was one permissive policy, and RLS policies OR
-- together, so a companion that adds a differently-named `using (true)` policy
-- reopens it just as effectively as one that recreates the original name.
select pg_temp.assert((select count(*) = 0
                       from pg_policies
                       where schemaname = 'public'
                         and tablename = 'meta_tokens'
                         and cmd in ('SELECT', 'ALL')
                         and (roles = '{public}' or 'authenticated' = any(roles) or 'anon' = any(roles))
                         and coalesce(qual, 'true') <> 'false'), 'f10-post-rollback-no-readable-select-policy');

-- Behaviour, as the role a browser session actually runs as.
--
-- The SQLSTATE is captured and asserted rather than swallowed by a
-- `when insufficient_privilege then null` handler. Two reasons, both from the
-- round-3 review: a denied path has to name the boundary that denied it, and an
-- assertion whose marker does not depend on the measurement is a tautology. Here
-- the distinction is real — 42501 means the grant is gone, while a rollback that
-- left the grant and relied on a policy would return zero rows and no error at
-- all, which this now fails on.
do $$
declare
  v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform count(*) from public.meta_tokens;
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501',
                         'f10-post-rollback-authenticated-cannot-read-meta-tokens');
end
$$;

-- ============================================================================
-- F-06 · profiles stays column-scoped
-- ============================================================================
-- email is the live takeover vector (change-password verified the old password
-- against profiles.email); the two revocation columns are what /api/auth/me and
-- src/proxy.ts consult, so self-writable they are not a control.
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'email', 'update'), 'f06-post-rollback-authenticated-cannot-update-email');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'is_active', 'update'), 'f06-post-rollback-authenticated-cannot-update-is-active');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'), 'f06-post-rollback-authenticated-cannot-update-role');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'password_changed_at', 'update'), 'f06-post-rollback-authenticated-cannot-update-password-changed-at');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'force_password_change', 'update'), 'f06-post-rollback-authenticated-cannot-update-force-password-change');

-- Not a security invariant: a rollback that leaves the previous release unable
-- to record last_active_at is a rollback that fails for its own reasons. This is
-- the one caller-scoped profiles write in the codebase (src/proxy.ts).
select pg_temp.assert(has_column_privilege('authenticated', 'public.profiles', 'last_active_at', 'update'), 'f06-post-rollback-authenticated-retains-last-active-at');

-- ============================================================================
-- F-08 · audit and session records stay server-owned
-- ============================================================================
select pg_temp.assert((select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and cmd = 'INSERT' and 'authenticated' = any(roles)), 'f08-post-rollback-audit-insert-closed-for-authenticated');
select pg_temp.assert((select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and cmd = 'INSERT' and 'authenticated' = any(roles)), 'f08-post-rollback-activity-insert-closed-for-authenticated');
select pg_temp.assert((select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'user_session_daily' and cmd = 'INSERT' and 'authenticated' = any(roles)), 'f08-post-rollback-session-insert-closed-for-authenticated');

-- The behaviour behind those three policy assertions, with the SQLSTATE carried
-- out of the subtransaction and asserted. 42501 is the boundary either way here —
-- a `with_check false` policy violation and a missing INSERT grant both raise it,
-- and the three assertions above say which of the two is in force — but a
-- rollback that left the row insertable would raise nothing at all, and that is
-- the case an `exception when insufficient_privilege then null` handler followed
-- by assert(true) cannot report.
do $$
declare
  v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.audit_logs (actor_id, action, details)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'FORGED_AFTER_ROLLBACK', '{}');
  exception
    when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501',
                         'f08-post-rollback-authenticated-cannot-forge-audit-row');
end
$$;

-- ============================================================================
-- F-09 · the money routines keep their ACL
-- ============================================================================
-- Checked over every money routine at once, and checked for BOTH ways PUBLIC can
-- hold EXECUTE: an explicit grant, and a null proacl. A null ACL is the harder
-- one to see and the easier one to reintroduce — `create or replace function`
-- does not reset it, but a companion that drops and recreates a routine gets the
-- PostgreSQL default back, which is EXECUTE to PUBLIC. That default is the exact
-- state F-09 reported.
do $$
declare
  sigs text[] := array[
    'public.approve_contract(uuid, uuid, text, text)',
    'public.confirm_payment(uuid, uuid)',
    'public.allocate_payment(uuid, jsonb, uuid)',
    'public.create_contract(jsonb)',
    'public.convert_quotation_to_contract(uuid, jsonb)',
    'public.set_contract_status(uuid, text, text)',
    'public.revoke_contract(uuid, text, boolean)',
    'public.money_actor(uuid, text[])'
  ];
  sig            text;
  o              oid;
  missing        int := 0;
  default_acl    int := 0;
  public_execute int := 0;
  anon_execute   int := 0;
begin
  foreach sig in array sigs loop
    o := to_regprocedure(sig);
    if o is null then
      missing := missing + 1;
      raise notice 'missing routine after rollback: %', sig;
      continue;
    end if;
    if (select proacl is null from pg_proc where oid = o) then
      default_acl := default_acl + 1;
      raise notice 'routine holds default (PUBLIC) EXECUTE after rollback: %', sig;
      continue;
    end if;
    public_execute := public_execute + (
      select count(*) from pg_proc p, aclexplode(p.proacl) a
      where p.oid = o and a.grantee = 0 and a.privilege_type = 'EXECUTE');
    if has_function_privilege('anon', o, 'execute') then
      anon_execute := anon_execute + 1;
      raise notice 'anon can execute after rollback: %', sig;
    end if;
  end loop;

  -- A revert may not delete the routines either: the previous release calls them.
  perform pg_temp.assert(missing = 0, 'money-post-rollback-all-routines-still-present');
  perform pg_temp.assert(default_acl = 0, 'f09-post-rollback-no-routine-fell-back-to-default-public-execute');
  perform pg_temp.assert(public_execute = 0, 'f09-post-rollback-no-explicit-public-execute');
  perform pg_temp.assert(anon_execute = 0, 'f09-post-rollback-anon-cannot-execute-any-money-routine');
end
$$;

-- ============================================================================
-- Money write boundary survives the revert
-- ============================================================================
-- 20260812000000 is declared NO_ROLLBACK, so its actor-identity function and its
-- five write guards must still be installed and enabled afterwards. A disabled
-- trigger is the quiet version of a dropped one, so tgenabled is checked, not
-- just existence.
select pg_temp.assert((select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
                       from pg_proc where oid = to_regprocedure('public.money_actor(uuid, text[])')), 'money-post-rollback-actor-identity-still-definer-with-pinned-search-path');

select pg_temp.assert((select count(*) = 5
                       from pg_trigger
                       where not tgisinternal
                         and tgenabled = 'O'
                         and tgname in ('trg_guard_contracts_write',
                                        'trg_guard_payments_write',
                                        'trg_guard_installment_plans_write',
                                        'trg_guard_contract_approvals_write',
                                        'trg_guard_payment_allocations_write')), 'money-post-rollback-all-five-write-guards-enabled');

-- ============================================================================
-- The contract phase is rolled back, and ONLY the contract phase
-- ============================================================================
-- This is the part of the rollback story that is a rollback. 20260818000000
-- flipped public.money_release_mode to 'strict'; its companion puts it back to
-- 'compat', which is the state 20260814000000 seeded and the posture production
-- has today. While the mode is 'compat' the previous release (f37c203 / 81956f2)
-- can create contracts and confirm payments through PostgREST with the caller's
-- own token, which is what makes an application-only revert possible at all.
--
-- Stated rather than buried, because it is the honest cost: these two assertions
-- prove that a browser session CAN write a contract directly after a rollback.
-- They are not a security invariant — they are the compatibility invariant, and
-- the sections after them are what keeps the revert from being a hole.
select pg_temp.assert(public.money_direct_write_mode() = 'compat',
                      'money-post-rollback-release-mode-is-compat');

do $$
declare
  v_status_state text := '00000';
  v_status       text := 'unset';
  v_insert_state text := '00000';
  v_insert_msg   text := '';
  v_inserted     boolean := false;
begin
  begin
    -- The previous release's status write: a direct UPDATE from a browser
    -- session. Under 'strict' this is the 42501 that
    -- money-direct-contract-status-update-refused asserts in the forward file.
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

    -- And the previous release's contract insert, which is the statement
    -- money-direct-contract-insert-refused proves is closed under 'strict'.
    -- On a lead of its own: idx_contracts_one_active_per_lead permits one
    -- non-terminal contract per lead, and the forward assertions have already
    -- used the seeded leads, so a shared one would fail with 23505 and say
    -- nothing about the release mode.
    insert into public.leads (id, assigned_to, stage, customer_name)
    values ('12121212-1212-1212-1212-121212121212',
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'won', 'Replay post-rollback lead');
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      insert into public.contracts (lead_id, sales_id, created_by, contract_no,
                                    contract_amount, party_a_name, status)
      values ('12121212-1212-1212-1212-121212121212',
              'cccccccc-cccc-cccc-cccc-cccccccccccc',
              'cccccccc-cccc-cccc-cccc-cccccccccccc',
              'REPLAY-POST-ROLLBACK-1', 1, 'x', 'draft');
      v_inserted := exists (select 1 from public.contracts
                             where contract_no = 'REPLAY-POST-ROLLBACK-1');
    exception when others then v_insert_state := sqlstate; v_insert_msg := sqlerrm;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;

  perform pg_temp.assert(v_status_state = '00000' and v_status = 'completed',
                         'money-post-rollback-previous-release-can-write-a-contract-status');
  -- The diagnostic carries the SQLSTATE and message, which the assertion's
  -- boolean cannot; the assertion carries the measurement, which the diagnostic
  -- cannot. Both, in that order — a marker that reads `assert(true, ...)` after
  -- an `if ... raise` is load-bearing only for as long as nobody moves it.
  if not (v_insert_state = '00000' and v_inserted) then
    raise notice 'the compatibility window did not accept the previous release''s contract insert: sqlstate %, %',
      v_insert_state, v_insert_msg;
  end if;
  perform pg_temp.assert(v_insert_state = '00000' and v_inserted,
                         'money-post-rollback-previous-release-can-insert-a-contract');
  perform pg_temp.assert((select status = 'active' from public.contracts
                          where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4')
                         and not exists (select 1 from public.contracts
                                          where contract_no = 'REPLAY-POST-ROLLBACK-1'),
                         'money-post-rollback-compat-fixture-was-rolled-back');
end
$$;

-- The two refusals round 4 added — contracts.first_payment_status (B2) and
-- quotations.contract_id (B5) — are gated on money_direct_write_is_blocked(), so
-- they must stand down here for exactly the same reason the two above do. This is
-- not a restatement of the assertions in the forward file: those measure the
-- refusal under 'strict', and a guard gated on money_write_is_direct() alone would
-- satisfy every one of them while breaking the previous release from the moment the
-- expand phase applied. trg_guard_quotations_write was first written that way.
-- supabase/preflight/expand-contract-rollback.md §2 lists both as state-4 refusals.
do $$
declare
  v_fps_state  text := '00000';
  v_fps_msg    text := '';
  v_fps        text := '(not measured)';
  v_link_state text := '00000';
  v_link_msg   text := '';
  v_link       uuid;
begin
  begin
    -- The previous release's PUT /api/contracts, which writes this column
    -- directly (src/app/api/contracts/route.ts:341 at PR base 81956f2).
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.contracts set first_payment_status = 'paid'
       where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
      v_fps := (select first_payment_status from public.contracts
                 where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6');
    exception when others then v_fps_state := sqlstate; v_fps_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);

    -- And the previous release's conversion, which links the quotation to the
    -- contract it just created with a direct UPDATE
    -- (src/app/api/quotations/[id]/convert/route.ts:173 at the same base).
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.quotations set contract_id = 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5'
       where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
      v_link := (select contract_id from public.quotations
                  where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6');
    exception when others then v_link_state := sqlstate; v_link_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      reset role;
      perform set_config('request.jwt.claims', '', true);
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;

  if not (v_fps_state = '00000' and v_fps = 'paid') then
    raise notice 'the compatibility window did not accept the previous release''s first_payment_status write: sqlstate %, %',
      v_fps_state, v_fps_msg;
  end if;
  perform pg_temp.assert(v_fps_state = '00000' and v_fps = 'paid',
                         'money-post-rollback-previous-release-can-write-first-payment-status');

  if not (v_link_state = '00000'
          and v_link = 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5'::uuid) then
    raise notice 'the compatibility window did not accept the previous release''s conversion link: sqlstate %, %',
      v_link_state, v_link_msg;
  end if;
  perform pg_temp.assert(v_link_state = '00000'
                         and v_link = 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5'::uuid,
                         'money-post-rollback-previous-release-can-write-the-conversion-link');

  perform pg_temp.assert((select first_payment_status = 'unpaid' from public.contracts
                           where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6')
                         and (select contract_id is null from public.quotations
                               where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6'),
                         'money-post-rollback-round4-compat-fixture-was-rolled-back');
end
$$;

-- ============================================================================
-- What the compatibility window does NOT stand down
-- ============================================================================
-- DELETE on the five money tables. No release of this application has ever
-- deleted a contract, payment, installment plan, approval or allocation from a
-- browser session, so refusing it costs no compatibility and the refusal is
-- unconditional in both modes. It was the P1-2 defect: the guards covered INSERT
-- and UPDATE only, and `authenticated` held DELETE on payments, so a session
-- deleted a confirmed payment while every derived total kept its money.
select pg_temp.assert(not (has_table_privilege('authenticated', 'public.contracts', 'delete')
                        or has_table_privilege('authenticated', 'public.payments', 'delete')
                        or has_table_privilege('authenticated', 'public.installment_plans', 'delete')
                        or has_table_privilege('authenticated', 'public.contract_approvals', 'delete')
                        or has_table_privilege('authenticated', 'public.payment_allocations', 'delete')),
                      'money-post-rollback-delete-privilege-still-gone-on-all-five-tables');

do $$
declare
  v_del_state  text := '00000';
  v_del_msg    text := '';
  v_void_state text := '00000';
  v_void_msg   text := '';
begin
  begin
    -- Granted back on purpose: the trigger, not the GRANT, is what is under test
    -- here, and a future migration that re-grants the privilege still meets it.
    grant delete on public.payments to authenticated;
    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.payments where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';
    exception when others then v_del_state := sqlstate; v_del_msg := sqlerrm;
    end;
    reset role;

    -- The void columns are new in this release, so no version of the application
    -- writes them: standing them down would buy nothing and cost the reversal's
    -- integrity.
    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      update public.payments set voided_at = now(), void_reason = 'not through the reversal'
       where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';
    exception when others then v_void_state := sqlstate; v_void_msg := sqlerrm;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;

  perform pg_temp.assert(v_del_state = '42501'
                         and v_del_msg like '%reverse the payment through void_payment() instead%',
                         'money-post-rollback-payment-delete-still-refused-by-the-guard');
  perform pg_temp.assert(v_void_state = '42501'
                         and v_void_msg like '%a payment is voided through void_payment()%',
                         'money-post-rollback-void-columns-still-refused');
  perform pg_temp.assert((select count(*) = 1 from public.payments
                          where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2'
                            and voided_at is null),
                         'money-post-rollback-the-payment-is-still-there-and-not-voided');
end
$$;

-- The reversal that makes the DELETE refusal reasonable has to survive too: if
-- void_payment() went away, "payments are not deleted" would mean "a mistaken
-- confirmation can never be undone".
select pg_temp.assert(to_regprocedure('public.void_payment(uuid, text)') is not null
                      and has_function_privilege('authenticated', to_regprocedure('public.void_payment(uuid, text)'), 'execute')
                      and not has_function_privilege('anon', to_regprocedure('public.void_payment(uuid, text)'), 'execute'),
                      'money-post-rollback-void-payment-still-present-with-its-acl');

do $$
declare v_state text := '00000'; v_msg text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.void_payment('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'sales should not be able to');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%role sales may not perform this operation%',
                         'money-post-rollback-void-payment-still-refuses-a-sales-caller');
end
$$;

-- The contract status graph lives in a function and a trigger, not in the mode,
-- so the reproduced 'completed' -> 'revoking' hole stays closed after a revert.
select pg_temp.assert(to_regprocedure('public.contract_transition_is_allowed(text, text)') is not null
                      and not public.contract_transition_is_allowed('completed', 'revoking')
                      and not public.contract_transition_is_allowed('terminated', 'active')
                      and public.contract_transition_is_allowed('active', 'completed'),
                      'money-post-rollback-transition-graph-survives');
select pg_temp.assert((select tgenabled = 'O' from pg_trigger
                       where tgrelid = 'public.contracts'::regclass
                         and tgname = 'trg_guard_contract_transition'),
                      'money-post-rollback-transition-trigger-still-enabled');

-- ============================================================================
-- The session revocation boundary survives the revert
-- ============================================================================
-- 20260813000000 is declared NO_ROLLBACK for the same reason F-02 and F-10 have
-- nothing to revert: dropping these policies hands every deactivated, banned and
-- stale-token identity full PostgREST access again. Checked as state, and by
-- behaviour, because a policy that exists but has been made permissive would
-- satisfy a existence-only check while granting instead of restricting.
select pg_temp.assert((select bool_and(prosecdef)
                       from pg_proc
                       where oid in (to_regprocedure('public.session_identity_enabled()'),
                                     to_regprocedure('public.session_token_is_current()'))),
                      'session-post-rollback-predicates-still-definer');

select pg_temp.assert((select count(*) > 0 and bool_and(not polpermissive
                                                    and polroles = array['authenticated'::regrole]::oid[])
                       from pg_policy
                       where polname like 'restrict%active_session%'),
                      'session-post-rollback-overlay-still-restrictive');

-- Behaviour: the published credential still reads nothing. dddddddd-…-dddd is
-- left inactive by the companion (asserted above), so this is the F-02 data
-- boundary holding after a revert.
do $$
declare
  v_rows int;
begin
  perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
  set local role authenticated;
  select count(*) into v_rows from public.contracts;
  reset role;
  perform pg_temp.assert(v_rows = 0, 'session-post-rollback-inactive-identity-still-reads-no-contracts');
end
$$;

-- ============================================================================
-- The class-28 write boundary survives the revert  (P0-1)
-- ============================================================================
-- 20260814000000 is NO_ROLLBACK for this reason. The 20260813000000 policies
-- close PostgREST; they do not close a SECURITY DEFINER routine, because RLS does
-- not apply inside one — which is how a deactivated, banned or password-changed
-- identity holding a still-valid access token could confirm a payment or convert
-- a quotation. The closure is a BEFORE ... FOR EACH STATEMENT trigger on every
-- ordinary table in `public`, and it has nothing to do with the release mode.
--
-- Coverage is computed, not listed, so a table a rollback leaves behind cannot
-- fall outside it unnoticed.
do $$
declare
  v_tables  int;
  v_missing text[];
begin
  select count(*) into v_tables
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relispartition;

  select coalesce(array_agg(c.relname order by c.relname), '{}')
    into v_missing
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and not c.relispartition
     and not exists (
       select 1 from pg_trigger t
        where t.tgrelid = c.oid
          and t.tgname = 'trg_require_current_session'
          and not t.tgisinternal
          -- BEFORE (2) | INSERT (4) | DELETE (8) | UPDATE (16), statement-level.
          and t.tgtype = 30
          and t.tgenabled = 'O');

  -- The notice names the tables; the assertion is the count, so the marker fails
  -- with the measurement rather than passing next to it.
  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise notice 'public tables with no session write boundary after rollback: %', v_missing;
  end if;
  perform pg_temp.assert(v_tables >= 10, 'session-post-rollback-boundary-had-tables-to-cover');
  perform pg_temp.assert(coalesce(array_length(v_missing, 1), 0) = 0,
                         'session-post-rollback-boundary-covers-every-public-table');
end
$$;

-- And by behaviour, on both surfaces, using the published credential the F-02
-- migration deactivated — the identity the whole finding is about. A generic
-- 42501 would not be enough: src/lib/money-rpc.mjs maps class 28 to a 401 that
-- tells the holder to re-authenticate, so the SQLSTATE is part of the closure and
-- is asserted as such.
do $$
declare
  v_rpc     text := '00000';
  v_rpc_msg text := '';
  v_tbl     text := '00000';
begin
  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
  exception when others then v_rpc := sqlstate; v_rpc_msg := sqlerrm;
  end;
  reset role;

  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    update public.profiles set last_active_at = now()
     where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  exception when others then v_tbl := sqlstate;
  end;
  reset role;

  perform pg_temp.assert(v_rpc = '28003' and v_rpc_msg like '%this account is deactivated%',
                         'session-post-rollback-deactivated-identity-refused-inside-a-definer-rpc');
  perform pg_temp.assert(v_tbl = '28003',
                         'session-post-rollback-deactivated-identity-cannot-write-an-ordinary-table');
end
$$;

-- The verdict function itself, and the one state it must NOT refuse: a statement
-- with no end-user identity is a trusted server path (a service_role token has no
-- `sub`, psql has no request settings), so the trigger lets it through. If that
-- stopped being true, every server-side write in the previous release would fail.
do $$
declare v_state text := '00000'; v_rows int := 0;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.assert_current_session();
  exception when others then v_state := sqlstate;
  end;
  begin
    update public.profiles set last_active_at = now()
     where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    get diagnostics v_rows = row_count;
    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;
  perform pg_temp.assert(v_state = '28001',
                         'session-post-rollback-assert-still-refuses-a-request-with-no-identity');
  perform pg_temp.assert(v_rows = 1,
                         'session-post-rollback-server-paths-are-still-allowed-to-write');
end
$$;

-- ============================================================================
-- Self-check: every assertion above ran.
-- ============================================================================
do $$
declare
  total int;
begin
  select count(*) into total from post_rollback_assert_log;
  if total <> 50 then
    raise exception 'post-rollback assertion file ran % assertions, ASSERT_TOTAL says 50', total
      using errcode = '22000';
  end if;
  raise notice 'all % post-rollback assertions passed', total;
end
$$;
