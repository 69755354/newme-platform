-- ============================================================================
-- Replay harness — step 2: release contract assertions
-- ============================================================================
-- Executed by scripts/replay-migrations.sh against a database built by replaying
-- every migration in supabase/migrations/ from empty. These are behaviour
-- assertions against a real schema: catalog privileges, catalog policies, and —
-- for the boundaries that matter most — actual statements run as the
-- `authenticated` role with a JWT subject set, so RLS and GRANT are enforced the
-- way PostgREST enforces them.
--
-- They are deliberately not source greps. A source grep proving that a migration
-- file contains the word "revoke" is what let F-05 ship green.
--
-- Failure raises. The runner additionally cross-checks the number of ASSERT_OK
-- notices against ASSERT_TOTAL below, so an assertion file that stops early
-- fails the job instead of passing quietly.
--
-- ASSERT_TOTAL: 131
-- ============================================================================

create temp table assert_log (name text);

create or replace function pg_temp.assert(condition boolean, assertion_name text)
returns void
language plpgsql
as $$
begin
  if condition is not true then
    raise exception 'ASSERT_FAIL %', assertion_name using errcode = '22000';
  end if;
  insert into assert_log (name) values (assertion_name);
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
-- Baseline drift (20260806000000_baseline_undeclared_production_objects.sql)
-- ============================================================================
select pg_temp.assert(to_regclass('public.meta_tokens') is not null, 'baseline-meta-tokens-exists');
select pg_temp.assert((select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('password_changed_at', 'force_password_change')), 'baseline-profiles-revocation-columns-exist');

-- ============================================================================
-- F-09 · money authorization
-- ============================================================================
-- Leg 1: the three money RPCs the API routes call are reachable by the role a
-- logged-in browser session actually runs as, and not by anon. (They were
-- SECURITY INVOKER throughout the committed history — despite the name
-- 20260723130000_lock_definer_boundaries.sql, which only pins search_path.
-- 20260812000000 is what makes them definer; that is asserted separately below.)
select pg_temp.assert(has_function_privilege('authenticated', 'public.confirm_payment(uuid, uuid)', 'execute'), 'f09-authenticated-can-execute-confirm-payment');
select pg_temp.assert(has_function_privilege('authenticated', 'public.approve_contract(uuid, uuid, text, text)', 'execute'), 'f09-authenticated-can-execute-approve-contract');
select pg_temp.assert(has_function_privilege('authenticated', 'public.allocate_payment(uuid, jsonb, uuid)', 'execute'), 'f09-authenticated-can-execute-allocate-payment');
select pg_temp.assert(has_function_privilege('service_role', 'public.confirm_payment(uuid, uuid)', 'execute'), 'f09-service-role-can-execute-confirm-payment');
select pg_temp.assert(not has_function_privilege('anon', 'public.confirm_payment(uuid, uuid)', 'execute'), 'f09-anon-cannot-execute-confirm-payment');
select pg_temp.assert(not has_function_privilege('anon', 'public.approve_contract(uuid, uuid, text, text)', 'execute'), 'f09-anon-cannot-execute-approve-contract');
select pg_temp.assert(not has_function_privilege('anon', 'public.allocate_payment(uuid, jsonb, uuid)', 'execute'), 'f09-anon-cannot-execute-allocate-payment');

-- Leg 2 regression. The revision of this migration that was reviewed revoked
-- INSERT/UPDATE/DELETE on contracts, payments, installment_plans,
-- contract_approvals and quotations from `authenticated`, on the belief that all
-- money writes go through service_role. Ten call sites write these tables with
-- the CALLER'S client (createServerSupabase → role `authenticated`), so that
-- revoke would have taken every contract, payment and conversion write offline.
-- These six assertions are the outage detector; do not "tighten" them without
-- moving those call sites to supabaseAdmin first.
select pg_temp.assert(has_table_privilege('authenticated', 'public.contracts', 'insert'), 'f09-authenticated-retains-contracts-insert');
select pg_temp.assert(has_table_privilege('authenticated', 'public.contracts', 'update'), 'f09-authenticated-retains-contracts-update');
select pg_temp.assert(has_table_privilege('authenticated', 'public.payments', 'insert'), 'f09-authenticated-retains-payments-insert');
select pg_temp.assert(has_table_privilege('authenticated', 'public.installment_plans', 'insert'), 'f09-authenticated-retains-installment-plans-insert');
select pg_temp.assert(has_table_privilege('authenticated', 'public.contract_approvals', 'insert'), 'f09-authenticated-retains-contract-approvals-insert');
select pg_temp.assert(has_table_privilege('authenticated', 'public.quotations', 'update'), 'f09-authenticated-retains-quotations-update');

-- ============================================================================
-- F-06 · profiles column grants
-- ============================================================================
-- Kept: the one caller-scoped profiles write in the codebase (src/proxy.ts,
-- last_active_at) plus its audit column.
select pg_temp.assert(has_column_privilege('authenticated', 'public.profiles', 'last_active_at', 'update'), 'f06-authenticated-can-update-last-active-at');
select pg_temp.assert(has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'update'), 'f06-authenticated-can-update-updated-at');
select pg_temp.assert(has_table_privilege('authenticated', 'public.profiles', 'select'), 'f06-authenticated-retains-profiles-select');

-- Removed: the takeover chain. email was the live defect — change-password
-- verified the old password against profiles.email, so a user who could rewrite
-- their own profiles.email could aim the verification at another account. The
-- revocation columns are what /api/auth/me and src/proxy.ts consult to reject a
-- token minted before a password change; self-writable, they are not a control.
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'email', 'update'), 'f06-authenticated-cannot-update-email');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'password_changed_at', 'update'), 'f06-authenticated-cannot-update-password-changed-at');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'force_password_change', 'update'), 'f06-authenticated-cannot-update-force-password-change');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'is_active', 'update'), 'f06-authenticated-cannot-update-is-active');
select pg_temp.assert(not has_column_privilege('authenticated', 'public.profiles', 'role', 'update'), 'f06-authenticated-cannot-update-role');

-- ============================================================================
-- F-08 · audit / session records are server-owned
-- ============================================================================
select pg_temp.assert((select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'policy_audit_logs_insert_authenticated'), 'f08-permissive-audit-insert-policy-is-gone');
select pg_temp.assert((select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and policyname = 'policy_activity_logs_insert_authenticated'), 'f08-permissive-activity-insert-policy-is-gone');
select pg_temp.assert((select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'user_session_daily' and policyname = 'policy_user_session_daily_insert_authenticated'), 'f08-permissive-session-insert-policy-is-gone');

-- Every INSERT policy visible to `authenticated` on the three tables must be
-- false. Enumerating instead of naming one policy is what catches a future
-- migration adding a second permissive policy beside the closed one: RLS
-- policies are permissive and OR together, so one loose policy is enough.
select pg_temp.assert((select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and cmd = 'INSERT' and 'authenticated' = any(roles)), 'f08-audit-insert-closed-for-authenticated');
select pg_temp.assert((select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and cmd = 'INSERT' and 'authenticated' = any(roles)), 'f08-activity-insert-closed-for-authenticated');
select pg_temp.assert((select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'user_session_daily' and cmd = 'INSERT' and 'authenticated' = any(roles)), 'f08-session-insert-closed-for-authenticated');

-- Behaviour, not catalog: run the forgery as the role a browser session runs as.
do $$
begin
  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    insert into public.audit_logs (actor_id, action, details)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'FORGED_BY_REPLAY', '{}');
    raise exception 'authenticated inserted a forged audit row' using errcode = '22000';
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert(true, 'f08-authenticated-cannot-forge-audit-row');
end
$$;

-- Same boundary with the caller's own actor_id: the previous revision of the
-- migration would have allowed this one, which is audit-log flooding.
do $$
begin
  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    insert into public.audit_logs (actor_id, action, details)
    values ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'SELF_ATTRIBUTED_BY_REPLAY', '{}');
    raise exception 'authenticated inserted a self-attributed audit row' using errcode = '22000';
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert(true, 'f08-authenticated-cannot-append-self-attributed-audit-row');
end
$$;

-- ============================================================================
-- F-10 · Meta access token exposure
-- ============================================================================
select pg_temp.assert((select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'meta_tokens' and policyname = 'policy_meta_tokens_select_authenticated'), 'f10-permissive-select-policy-is-gone');
select pg_temp.assert(not has_table_privilege('authenticated', 'public.meta_tokens', 'select'), 'f10-authenticated-has-no-select-grant');
select pg_temp.assert(not has_table_privilege('anon', 'public.meta_tokens', 'select'), 'f10-anon-has-no-select-grant');
select pg_temp.assert(has_table_privilege('service_role', 'public.meta_tokens', 'select'), 'f10-service-role-retains-select');
select pg_temp.assert(has_table_privilege('service_role', 'public.meta_tokens', 'insert'), 'f10-service-role-retains-insert');
select pg_temp.assert(has_table_privilege('service_role', 'public.meta_tokens', 'update'), 'f10-service-role-retains-update');

-- Behaviour: the grant is what closes this, so prove the grant, not the policy.
-- RLS alone would not have been enough — a permissive `using (true)` policy plus
-- a table grant is how every authenticated user could read the plaintext token.
do $$
begin
  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    perform count(*) from public.meta_tokens;
    raise exception 'authenticated read meta_tokens' using errcode = '22000';
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert(true, 'f10-authenticated-cannot-read-meta-tokens');
end
$$;

-- ============================================================================
-- F-02 · default-credential admin account
-- ============================================================================
-- The migration ran against the fixture (05_seed_behaviour_fixtures.sql) during
-- the re-apply step, so these assert its effect on real rows.
select pg_temp.assert((select count(*) = 1 from auth.users where email = 'dev@newme.ae'), 'f02-identity-not-deleted');
select pg_temp.assert((select count(*) = 1 from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'f02-profile-not-deleted');
select pg_temp.assert((select is_active is false and force_password_change is true from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'f02-account-neutralised');
select pg_temp.assert((select count(*) = 2 from public.audit_logs where actor_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' and action = 'REPLAY_FIXTURE_ACTION'), 'f02-audit-attribution-survives');
select pg_temp.assert((select is_active is true from public.profiles where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 'f02-other-privileged-account-untouched');

-- ============================================================================
-- KPI targets · atomic period replacement
-- ============================================================================
select pg_temp.assert(to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)') is not null, 'kpi-replace-function-exists');
select pg_temp.assert(has_function_privilege('service_role', 'public.replace_kpi_targets(text, jsonb, uuid)', 'execute'), 'kpi-service-role-can-execute');
select pg_temp.assert(not has_function_privilege('authenticated', 'public.replace_kpi_targets(text, jsonb, uuid)', 'execute'), 'kpi-authenticated-cannot-execute');
select pg_temp.assert(not has_function_privilege('anon', 'public.replace_kpi_targets(text, jsonb, uuid)', 'execute'), 'kpi-anon-cannot-execute');
select pg_temp.assert((select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'] from pg_proc where oid = to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')), 'kpi-definer-with-pinned-search-path');

-- The index that closes the NULL hole: unique, partial, and on the right
-- predicate. All three are checked, because a plain (period, target_type) unique
-- index would break the assigned case and a non-unique one would prove nothing.
select pg_temp.assert((select i.indisunique
                            and pg_get_expr(i.indpred, i.indrelid) = '(assigned_to IS NULL)'
                            and pg_get_indexdef(i.indexrelid) like '%(period, target_type)%'
                       from pg_index i
                       where i.indexrelid = 'public.idx_kpi_targets_one_unassigned_per_period_type'::regclass),
                      'kpi-unassigned-target-is-unique-per-period-and-type');

-- The defect this replaces: DELETE and INSERT as two PostgREST calls, so a bad
-- row left the period empty. One malformed target_type must now leave the
-- period exactly as it was.
do $$
declare
  before_count int;
  after_count  int;
begin
  select count(*) into before_count from public.kpi_targets where period = '2026-99';
  begin
    perform * from public.replace_kpi_targets(
      '2026-99',
      '[{"target_type":"signing","target_amount":"1"},{"target_type":"NOT_A_TARGET_TYPE","target_amount":"2"}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'replace_kpi_targets accepted an invalid target_type' using errcode = '22000';
  exception
    when check_violation then null;
  end;
  select count(*) into after_count from public.kpi_targets where period = '2026-99';
  perform pg_temp.assert(before_count = 2, 'kpi-fixture-period-seeded');
  perform pg_temp.assert(after_count = 2, 'kpi-failed-replace-preserves-period');
end
$$;

-- Empty input is rejected before the delete, not after it.
do $$
declare
  after_count int;
begin
  begin
    perform * from public.replace_kpi_targets('2026-99', '[]'::jsonb, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    raise exception 'replace_kpi_targets accepted an empty row set' using errcode = '22000';
  exception
    when invalid_parameter_value then null;
  end;
  select count(*) into after_count from public.kpi_targets where period = '2026-99';
  perform pg_temp.assert(after_count = 2, 'kpi-empty-replace-preserves-period');
end
$$;

-- Two rows, same target_type, both unassigned. No index can reject this — NULL is
-- never equal to NULL — so before this release the period ended up holding both
-- and every view that reads kpi_targets counted the target twice.
do $$
declare
  v_state     text := '00000';
  after_count int;
begin
  begin
    perform * from public.replace_kpi_targets(
      '2026-99',
      '[{"target_type":"signing","target_amount":"1"},{"target_type":"signing","target_amount":"2"}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then v_state := sqlstate;
  end;
  select count(*) into after_count from public.kpi_targets where period = '2026-99';
  perform pg_temp.assert(v_state = '23505', 'kpi-replace-refuses-duplicate-unassigned-keys');
  perform pg_temp.assert(after_count = 2, 'kpi-duplicate-key-replace-preserves-period');
end
$$;

-- Serialization. Two sessions cannot be run from one psql connection, so what is
-- asserted here is precisely what can be: that the function takes a transaction
-- level advisory lock, and that its key is the one derived from the period rather
-- than a constant (a constant would serialize every period against every other).
-- The lock is held to commit, so it is still visible in pg_locks when the DO block
-- that called the function inspects it. Mutual exclusion between two concurrent
-- transactions then follows from pg_advisory_xact_lock's own semantics, which is
-- not this repository's to test.
do $$
declare
  v_key      bigint := hashtextextended('public.kpi_targets:2026-99', 0);
  v_other    bigint := hashtextextended('public.kpi_targets:2026-98', 0);
  v_held     boolean;
  v_unrelated boolean;
begin
  perform * from public.replace_kpi_targets(
    '2026-99',
    '[{"target_type":"signing","target_amount":"7"}]'::jsonb,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

  select exists (
    select 1 from pg_locks
     where locktype = 'advisory'
       and pid = pg_backend_pid()
       and objsubid = 1
       and classid::bigint = ((v_key >> 32) & 4294967295)
       and objid::bigint   = (v_key & 4294967295)
  ) into v_held;

  select exists (
    select 1 from pg_locks
     where locktype = 'advisory'
       and pid = pg_backend_pid()
       and objsubid = 1
       and classid::bigint = ((v_other >> 32) & 4294967295)
       and objid::bigint   = (v_other & 4294967295)
  ) into v_unrelated;

  perform pg_temp.assert(v_held, 'kpi-replace-holds-a-period-scoped-advisory-lock');
  perform pg_temp.assert(not v_unrelated, 'kpi-replace-lock-key-is-derived-from-the-period');
end
$$;

-- And the happy path still replaces rather than accumulates. (The call above did
-- the replacing; this checks its result outside that transaction, so it is also
-- the proof that the advisory lock did not hold the write open or roll it back.)
select pg_temp.assert((select count(*) = 1 from public.kpi_targets where period = '2026-99'),
                      'kpi-successful-replace-replaces-period');

-- ============================================================================
-- Money path · 20260812000000_money_actor_identity_and_atomicity.sql
-- ============================================================================
-- Everything below runs statements, not catalog queries, and runs them as the
-- role and JWT subject a real request carries. The reviewed head asserted the
-- money boundary with privilege checks alone, which is why it could report F-09
-- closed while the routines still took the caller's word for who the caller was:
-- a GRANT says who may call approve_contract, and says nothing about whose uuid
-- the caller may put in p_approver_id.
--
-- The negative direction is the load-bearing one and is listed in
-- CONTROL_MUST_FAIL in scripts/replay-migrations.sh, so MODE=control proves each
-- of these fails against the un-remediated floor — which carries the real
-- pre-remediation bodies, not stubs.

-- ---------------------------------------------------------------------------
-- A · installation
-- ---------------------------------------------------------------------------
select pg_temp.assert((select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
                       from pg_proc where oid = to_regprocedure('public.money_actor(uuid, text[])')),
                      'money-actor-definer-with-pinned-search-path');

-- The counter table is the one new piece of state the money path depends on. If
-- `authenticated` can touch it, a sales user can hand themselves a duplicate
-- contract number, so the revoke matters more than usual: Supabase's default
-- privileges grant every new public table to anon and authenticated.
select pg_temp.assert(not (has_table_privilege('authenticated', 'public.contract_no_counters', 'select')
                        or has_table_privilege('authenticated', 'public.contract_no_counters', 'insert')
                        or has_table_privilege('authenticated', 'public.contract_no_counters', 'update')
                        or has_table_privilege('anon', 'public.contract_no_counters', 'select')),
                      'money-counters-table-unreachable-by-end-user-roles');

select pg_temp.assert(not (has_function_privilege('authenticated', 'public.next_contract_no(date)', 'execute')
                        or has_function_privilege('anon', 'public.next_contract_no(date)', 'execute')),
                      'money-next-contract-no-unreachable-by-end-user-roles');

-- tgenabled is checked, not just existence: a disabled trigger is the quiet
-- version of a dropped one.
select pg_temp.assert((select count(*) = 5
                       from pg_trigger
                       where not tgisinternal and tgenabled = 'O'
                         and tgname in ('trg_guard_contracts_write',
                                        'trg_guard_payments_write',
                                        'trg_guard_installment_plans_write',
                                        'trg_guard_contract_approvals_write',
                                        'trg_guard_payment_allocations_write')),
                      'money-write-guards-installed-and-enabled');

-- The routines have to be definer now, because they can no longer read the
-- caller's identity from an argument — they read it from the token, and then
-- they need to write rows the caller's own RLS would refuse (the installment
-- and approval rows a sales user was never able to insert).
select pg_temp.assert((select bool_and(prosecdef) from pg_proc
                       where oid = any (array[
                         to_regprocedure('public.approve_contract(uuid, uuid, text, text)'),
                         to_regprocedure('public.confirm_payment(uuid, uuid)'),
                         to_regprocedure('public.allocate_payment(uuid, jsonb, uuid)'),
                         to_regprocedure('public.create_contract(jsonb)'),
                         to_regprocedure('public.convert_quotation_to_contract(uuid, jsonb)'),
                         to_regprocedure('public.set_contract_status(uuid, text, text)'),
                         to_regprocedure('public.revoke_contract(uuid, text, boolean)')])),
                      'money-routines-are-security-definer');

-- Section 12 of the migration rewrites on_lead_won() with CREATE OR REPLACE,
-- which SILENTLY DROPS both SECURITY DEFINER and SET search_path when they are
-- not restated. 20260624095205 added the first and 20260723130000 the second, so
-- forgetting either would take a production automation apart. This is the check
-- that the restatement is really there.
select pg_temp.assert((select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
                       from pg_proc where oid = to_regprocedure('public.on_lead_won()')),
                      'money-lead-won-trigger-kept-definer-and-pinned-search-path');

-- ---------------------------------------------------------------------------
-- B · contract numbers come from a counter, not a count
-- ---------------------------------------------------------------------------
-- The fixture already holds NEW-<today>-007. The old numbering was
-- lpad(count(*) WHERE contract_date = today) — one contract today means 001,
-- which is both wrong and possibly taken; on the second contract of a day it
-- raised unique_violation and, in the won-lead trigger, took the whole
-- final_status='won' UPDATE down with it.
--
-- Rolled back afterwards so the numbers the create/convert assertions get are
-- not shifted by this probe: the plpgsql variables survive the rollback, the
-- counter row does not.
do $$
declare
  v_first  text;
  v_second text;
begin
  begin
    v_first  := public.next_contract_no(current_date);
    v_second := public.next_contract_no(current_date);
    raise exception 'REPLAY_ROLLBACK' using errcode = '22000';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;
  perform pg_temp.assert(v_first  = 'NEW-' || to_char(current_date, 'YYYYMMDD') || '-008',
                         'money-contract-no-seeded-from-highest-issued-number');
  perform pg_temp.assert(v_second = 'NEW-' || to_char(current_date, 'YYYYMMDD') || '-009',
                         'money-contract-no-increments-under-repeat-calls');
end
$$;

-- ---------------------------------------------------------------------------
-- C · money_actor — the identity decision itself
-- ---------------------------------------------------------------------------
do $$
declare
  v_actor uuid;
  v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_actor := public.money_actor(null, array['sales']);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '00000' and v_actor = 'cccccccc-cccc-cccc-cccc-cccccccccccc',
                         'money-actor-returns-session-subject-for-end-user-call');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.money_actor('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', array['admin', 'sales']);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501', 'money-actor-refuses-claimed-id-that-is-not-the-session');
end
$$;

-- The database half of the revocation boundary. A valid, unexpired token for a
-- deactivated privileged account must not move money, because the proxy check
-- that reads is_active is bypassed entirely by talking to PostgREST directly.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('99999999-9999-9999-9999-999999999999');
    set local role authenticated;
    perform public.money_actor(null, array['admin']);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501', 'money-actor-refuses-inactive-account');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.money_actor(null, array['admin', 'boss']);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501', 'money-actor-refuses-disallowed-role');
end
$$;

-- No request context at all (psql, pg_cron, or a service_role token, which
-- carries no subject): the actor id becomes mandatory instead of optional.
do $$
declare v_state text := '00000';
begin
  begin
    perform set_config('request.jwt.claim.sub', '', true);
    perform public.money_actor(null, array['admin']);
  exception when others then v_state := sqlstate;
  end;
  perform pg_temp.assert(v_state = '22023', 'money-actor-requires-an-actor-id-in-a-server-context');
end
$$;

-- ---------------------------------------------------------------------------
-- D · confirm_payment
-- ---------------------------------------------------------------------------
-- The pre-remediation body has NO authorization check of any kind, and takes
-- p_confirmer_id on trust: any caller who could reach the function could record
-- money as confirmed by anyone.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.confirm_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
                                   'ffffffff-ffff-ffff-ffff-ffffffffffff');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%does not match the session%',
                         'f09-confirm-payment-refuses-impersonated-confirmer');
end
$$;

do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.confirm_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', null);
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%may not perform this operation%',
                         'f09-confirm-payment-refuses-unauthorised-role');
end
$$;

-- The positive path, and the two cascades the composite-null bug skipped.
-- `IF v_contract IS NOT NULL` is false unless EVERY field of the composite is
-- non-null, which for this table never happens, so projects.paid_amount and
-- kpi_targets.actual_amount were never updated by a confirmation.
do $$
declare
  v_result jsonb;
  v_state  text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    v_result := public.confirm_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and (v_result ->> 'success')::boolean
    and (select confirmed and confirmed_by = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
           from public.payments where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'),
    'f09-confirm-payment-succeeds-for-finance-as-itself');

  perform pg_temp.assert(
    (select paid_amount = 70000.00 from public.projects
      where id = '99991111-1111-1111-1111-111111111111'),
    'money-confirm-payment-updates-project-paid-amount');

  perform pg_temp.assert(
    (select actual_amount = 60000.00 from public.kpi_targets
      where assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
        and period = to_char(current_date, 'YYYY-MM')
        and target_type = 'collection'),
    'money-confirm-payment-increments-kpi-actual-amount');
end
$$;

-- Already confirmed. The old body RETURNED {"error": ...} with HTTP 200, so a
-- double confirmation looked like a success to every caller that did not inspect
-- the body — and none of them did.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    perform public.confirm_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '22023', 'money-confirm-payment-refuses-second-confirmation');
end
$$;

-- ---------------------------------------------------------------------------
-- E · allocate_payment
-- ---------------------------------------------------------------------------
-- The message is matched, not just the sqlstate, and this one is why: against the
-- un-remediated floor this call is ALSO refused with 42501, because
-- payment_allocations has no INSERT policy for the sales role and the old routine
-- was SECURITY INVOKER, so RLS stopped it. A sqlstate-only assertion therefore
-- passed with the impersonation defect fully present. Naming the boundary that
-- did the refusing is the difference between testing money_actor and testing
-- whatever happens to say no first.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.allocate_payment(
      'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
      '[{"plan_id":"91111111-1111-1111-1111-111111111111","amount":"1"}]'::jsonb,
      'ffffffff-ffff-ffff-ffff-ffffffffffff');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%does not match the session%',
                         'f09-allocate-payment-refuses-impersonated-allocator');
end
$$;

-- The binding defect: plan 94444444 belongs to contract C4, the payment to C3.
-- The old body inserted the allocation anyway, so a payment on one contract
-- could mark another contract's instalment paid.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    perform public.allocate_payment(
      'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
      '[{"plan_id":"94444444-4444-4444-4444-444444444444","amount":"1000"}]'::jsonb,
      null);
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%does not belong to the payment%',
                         'money-allocate-payment-refuses-plan-from-another-contract');
  perform pg_temp.assert(
    (select allocated_amount = 0 and status = 'pending' from public.installment_plans
      where id = '94444444-4444-4444-4444-444444444444'),
    'money-allocate-payment-leaves-the-other-contract-untouched');
end
$$;

do $$
declare
  v_result jsonb;
  v_state  text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    v_result := public.allocate_payment(
      'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
      '[{"plan_id":"91111111-1111-1111-1111-111111111111","amount":"50000"},
        {"plan_id":"92222222-2222-2222-2222-222222222222","amount":"10000"}]'::jsonb,
      null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and (v_result ->> 'allocations_count')::int = 2
    and (select allocated_amount = 50000.00 and status = 'paid' from public.installment_plans
          where id = '91111111-1111-1111-1111-111111111111')
    and (select allocated_amount = 10000.00 and status = 'partial' from public.installment_plans
          where id = '92222222-2222-2222-2222-222222222222'),
    'money-allocate-payment-binds-and-recomputes-plans');
end
$$;

-- Reallocation. The old body recomputed only the plans in the NEW set, so plan 1
-- kept allocated_amount = 50000 and status 'paid' after the money was moved off
-- it — an instalment reported as paid with nothing allocated to it.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    perform public.allocate_payment(
      'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
      '[{"plan_id":"92222222-2222-2222-2222-222222222222","amount":"60000"}]'::jsonb,
      null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and (select allocated_amount = 0 and status = 'pending' from public.installment_plans
          where id = '91111111-1111-1111-1111-111111111111')
    and (select allocated_amount = 60000.00 and status = 'paid' from public.installment_plans
          where id = '92222222-2222-2222-2222-222222222222'),
    'money-allocate-payment-resets-de-allocated-plans');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    perform public.allocate_payment(
      'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
      '[{"plan_id":"91111111-1111-1111-1111-111111111111","amount":"999999"}]'::jsonb,
      null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '22023', 'money-allocate-payment-refuses-total-over-payment-amount');
end
$$;

-- ---------------------------------------------------------------------------
-- F · approve_contract
-- ---------------------------------------------------------------------------
-- The impersonation is the whole finding: the old body read the ROLE OF THE
-- ID IT WAS HANDED, so a sales user passing a director's uuid approved their own
-- contract, and the approval record named the director.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.approve_contract('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1',
                                    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'approve', 'self-approved');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%does not match the session%',
                         'f09-approve-contract-refuses-impersonated-approver');
  perform pg_temp.assert(
    (select status = 'pending_admin' from public.contracts
      where id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1'),
    'f09-approve-contract-impersonation-left-the-contract-unapproved');
end
$$;

do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.approve_contract('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', null, 'approve', null);
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%may not perform this operation%',
                         'f09-approve-contract-refuses-sales-role');
end
$$;

-- Admin step. Two things are asserted that the old body got wrong: the EXISTING
-- pending row for this step is the one that settles (it read the earliest
-- pending row of any step and appended a new one), and the next step's pending
-- row is opened — without it, `ceo_review` was unreachable and no contract could
-- ever leave pending_ceo through the approvals list.
do $$
declare
  v_result jsonb;
  v_state  text := '00000';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    v_result := public.approve_contract('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', null, 'approve', 'ok');
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and v_result ->> 'new_status' = 'pending_ceo'
    and (select status = 'pending_ceo' from public.contracts where id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1')
    and (select status = 'approved' and approver_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
           from public.contract_approvals where id = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1')
    and (select count(*) = 1 from public.contract_approvals
          where contract_id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1'
            and step = 'ceo_review' and status = 'pending'),
    'money-approve-contract-admin-step-settles-pending-row-and-opens-ceo-review');
end
$$;

do $$
declare
  v_result jsonb;
  v_state  text := '00000';
begin
  begin
    perform pg_temp.act_as('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    set local role authenticated;
    v_result := public.approve_contract('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', null, 'approve', 'ok');
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and v_result ->> 'new_status' = 'approved'
    and (select status = 'approved' from public.contracts where id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1')
    and (select count(*) = 0 from public.contract_approvals
          where contract_id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1' and status = 'pending')
    and (select count(*) = 1 from public.contract_approvals
          where contract_id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1'
            and step = 'ceo_review' and status = 'approved'
            and approver_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    'money-approve-contract-ceo-step-settles-and-approves');
end
$$;

-- Errors raise. Every failure in the old body was a 200 with {"error": ...}, and
-- src/app/api/contracts/[id]/approve/route.ts does not read the body, so an
-- unapprovable contract reported success to the operator.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.approve_contract('c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2', null, 'approve', null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '22023', 'money-approve-contract-raises-instead-of-returning-error-json');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.approve_contract('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', null, 'sign-it', null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '22023', 'money-approve-contract-rejects-unknown-action');
end
$$;

-- ---------------------------------------------------------------------------
-- G · create_contract
-- ---------------------------------------------------------------------------
-- Atomicity AND reachability. The route did this in three transactions, and the
-- installment and approval INSERT policies are manager-only, so a sales user
-- creating a contract got the contract and neither of the rows that make it
-- usable — with no error, because a PostgREST insert filtered out by RLS is not
-- an error the route checked for.
do $$
declare
  v_result jsonb;
  v_state  text := '00000';
  v_id     uuid;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_result := public.create_contract(jsonb_build_object(
      'lead_id',      '22222222-2222-2222-2222-222222222222',
      'amount',       '90000',
      'party_a_name', 'Replay created party',
      'installments', jsonb_build_array(
        jsonb_build_object('seq', '1', 'amount', '45000'),
        jsonb_build_object('seq', '2', 'amount', '45000'))));
  exception when others then v_state := sqlstate;
  end;
  reset role;
  v_id := (v_result ->> 'id')::uuid;

  perform pg_temp.assert(
    v_state = '00000'
    and v_result ->> 'status' = 'draft'
    and (v_result ->> 'installments_count')::int = 2
    and (select sales_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
              and created_by = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
              and status = 'draft'
           from public.contracts where id = v_id)
    and (select count(*) = 2 from public.installment_plans where contract_id = v_id)
    and (select count(*) = 1 from public.contract_approvals
          where contract_id = v_id and step = 'admin_review' and status = 'pending'),
    'money-create-contract-is-atomic-for-a-sales-caller');

  -- Not 001 or 002: the number comes from the counter seeded at the highest
  -- issued number for the date, so it is strictly above the fixture's 007.
  perform pg_temp.assert(
    (select contract_no ~ ('^NEW-' || to_char(current_date, 'YYYYMMDD') || '-[0-9]{3}$')
         and substring(contract_no from '^NEW-[0-9]{8}-0*([0-9]+)$')::int > 7
       from public.contracts where id = v_id),
    'money-create-contract-issues-a-counter-based-number');
end
$$;

-- The duplicate pre-check runs with the definer's visibility, so a sales user
-- who cannot SEE a colleague's contract on the same lead still gets the intended
-- conflict instead of a 500 from the unique index.
do $$
declare
  v_state text := '00000';
  v_count int;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.create_contract(jsonb_build_object(
      'lead_id', '22222222-2222-2222-2222-222222222222',
      'amount',  '90000'));
  exception when others then v_state := sqlstate;
  end;
  reset role;
  select count(*) into v_count from public.contracts
   where lead_id = '22222222-2222-2222-2222-222222222222';
  perform pg_temp.assert(v_state = '23505' and v_count = 1,
                         'money-create-contract-refuses-second-active-contract-for-a-lead');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.create_contract(jsonb_build_object(
      'lead_id', '33333333-3333-3333-3333-333333333333', 'amount', '0'));
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '22023', 'money-create-contract-refuses-non-positive-amount');
end
$$;

-- ---------------------------------------------------------------------------
-- H · convert_quotation_to_contract
-- ---------------------------------------------------------------------------
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', '{}'::jsonb);
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and v_msg like '%only the quotation owner or a manager%'
    and (select contract_id is null from public.quotations where id = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1'),
    'money-convert-quotation-refuses-non-owner-sales');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '22023'
    and (select contract_id is null from public.quotations where id = 'b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3'),
    'money-convert-quotation-refuses-unaccepted-quotation');
end
$$;

-- The happy path, all seven of the route's steps in one transaction.
do $$
declare
  v_result jsonb;
  v_state  text := '00000';
  v_id     uuid;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_result := public.convert_quotation_to_contract(
      'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1',
      jsonb_build_object('installments', jsonb_build_array(
        jsonb_build_object('seq', '1', 'amount', '40000'),
        jsonb_build_object('seq', '2', 'amount', '40000'))));
  exception when others then v_state := sqlstate;
  end;
  reset role;
  v_id := (v_result ->> 'contract_id')::uuid;

  perform pg_temp.assert(
    v_state = '00000'
    and (select status = 'draft' and contract_amount = 80000.00
              and quotation_id = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1'
              and lead_id = '66666666-6666-6666-6666-666666666666'
           from public.contracts where id = v_id)
    and (select count(*) = 2 from public.installment_plans where contract_id = v_id)
    and (select count(*) = 1 from public.contract_approvals
          where contract_id = v_id and step = 'admin_review' and status = 'pending')
    and (select status = 'contract_created' and contract_id = v_id
           from public.quotations where id = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1')
    and (select final_status = 'won' from public.leads where id = '66666666-6666-6666-6666-666666666666'),
    'money-convert-quotation-is-atomic-for-the-owner');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', '{}'::jsonb);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '23505', 'money-convert-quotation-refuses-second-conversion');
end
$$;

-- ---------------------------------------------------------------------------
-- I · the direct-PostgREST write boundary
-- ---------------------------------------------------------------------------
-- RLS decides which ROWS a statement may touch and cannot see OLD, so it cannot
-- say "status may not change". These are the trigger's job, and each one is run
-- as `authenticated` with a JWT subject — the exact shape of a request that
-- skips the Next.js routes entirely and talks to PostgREST with the anon key and
-- a user token.
-- An INSERT is the one direction where an RLS WITH CHECK failure and a guard
-- failure are indistinguishable by sqlstate — both are 42501. So the four INSERT
-- cases below match the guard's own message as well: without that, "RLS filtered
-- this out" would read as "the guard refused it", and the guard could be missing.
-- (For UPDATE and DELETE the ambiguity does not exist in the dangerous direction:
-- an RLS USING mismatch removes the row from consideration and succeeds with zero
-- rows affected, which fails these assertions rather than satisfying them.)
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.contracts (lead_id, sales_id, created_by, contract_no, contract_amount,
                                  party_a_name, status)
    values ('33333333-3333-3333-3333-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'REPLAY-DIRECT-1', 1, 'x', 'active');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%direct insert is not permitted%',
                         'money-direct-contract-insert-refused');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.contracts set status = 'approved' where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and (select status = 'active' from public.contracts where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'),
    'money-direct-contract-status-update-refused');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.contracts set contract_amount = 1 where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501', 'money-direct-contract-amount-update-refused');
end
$$;

-- The regression this pair exists to prevent. An earlier revision narrowed the
-- sales UPDATE policy by status, which would have made the signed-PDF upload at
-- src/app/api/contracts/[id]/confirm-upload/route.ts:98 match zero rows on an
-- approved or active contract — and a PostgREST update that matches no rows
-- returns no error, so the route would have reported success having written
-- nothing. Ownership decides the row; the trigger decides the column.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.contracts set file_url = 'https://example.invalid/replay.pdf'
     where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and (select file_url = 'https://example.invalid/replay.pdf' from public.contracts
          where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'),
    'money-direct-contract-file-url-update-still-allowed');
end
$$;

-- Defence in depth, and honestly labelled: this one is refused on BOTH sides of
-- the migration and is not listed in CONTROL_MUST_FAIL. Reusing USING as the
-- WITH CHECK is precisely the case the old policy did stop — `sales_id =
-- auth.uid()` evaluated against the NEW row blocks handing the row away. What it
-- did not stop is every OTHER column, which is what the two assertions above
-- cover and what the trigger is for. The invariant is still worth pinning: the
-- migration rewrites that policy, and a rewrite that dropped the WITH CHECK
-- would reopen it.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.contracts set sales_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
     where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and (select sales_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc' from public.contracts
          where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'),
    'money-direct-contract-sales-reassignment-refused');
end
$$;

-- Recording an unconfirmed payment is a legitimate direct write
-- (src/app/api/payments/route.ts:70) and must keep working; the guard only pins
-- created_by to the session identity.
do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.payments (id, contract_id, amount, payment_date, created_by)
    values ('d3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
            1000.00, current_date, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and (select not coalesce(confirmed, false) from public.payments
          where id = 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3'),
    'money-direct-payment-insert-unconfirmed-still-allowed');
end
$$;

do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.payments (contract_id, amount, payment_date, confirmed, created_by)
    values ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 5000.00, current_date, true,
            'cccccccc-cccc-cccc-cccc-cccccccccccc');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%already confirmed%',
                         'money-direct-payment-insert-preconfirmed-refused');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.payments set confirmed = true, confirmed_by = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
     where id = 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and (select not coalesce(confirmed, false) from public.payments
          where id = 'd3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3'),
    'money-direct-payment-confirmation-refused');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.payments set amount = 1 where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and (select amount = 10000.00 from public.payments where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2'),
    'money-confirmed-payment-amount-immutable');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.payments set notes = 'cheque reference corrected'
     where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and (select notes = 'cheque reference corrected' from public.payments
          where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2'),
    'money-confirmed-payment-notes-still-editable');
end
$$;

-- Run as an ADMIN, not as sales: these three tables have manager-wide policies,
-- so a sales caller would be filtered out by RLS and the trigger would never
-- fire. The point is that even a manager cannot forge an approval, an allocation
-- or a schedule change directly — those are the money routines' records.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    insert into public.contract_approvals (contract_id, step, approver_id, status)
    values ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 'ceo_review',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'approved');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%written only through the money routines%',
                         'money-direct-contract-approval-insert-refused');
end
$$;

do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    insert into public.payment_allocations (payment_id, plan_id, amount_allocated, allocated_by)
    values ('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', '91111111-1111-1111-1111-111111111111',
            10000.00, 'ffffffff-ffff-ffff-ffff-ffffffffffff');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%written only through the money routines%',
                         'money-direct-payment-allocation-insert-refused');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    delete from public.installment_plans where id = '92222222-2222-2222-2222-222222222222';
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and (select count(*) = 1 from public.installment_plans
          where id = '92222222-2222-2222-2222-222222222222'),
    'money-direct-installment-plan-delete-refused');
end
$$;

-- ---------------------------------------------------------------------------
-- J · set_contract_status / revoke_contract
-- ---------------------------------------------------------------------------
-- The contract page PATCHes /api/contracts/[id] with a status out of a
-- nine-button grid and the route exports only GET, so every one of those clicks
-- has been a 405. A handler that wrote whatever it was sent would have been
-- worse: 'approved' and 'pending_ceo' are in that grid.
do $$
declare
  v_result jsonb;
  v_state  text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_result := public.set_contract_status('c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2', 'pending_admin', null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '00000'
    and v_result ->> 'status' = 'pending_admin'
    and (select status = 'pending_admin' from public.contracts where id = 'c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2'),
    'money-set-contract-status-permits-owner-submission-for-approval');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.set_contract_status('c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2', 'approved', null);
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '22023'
    and (select status = 'pending_admin' from public.contracts where id = 'c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2'),
    'money-set-contract-status-refuses-approval-chain-transition');
end
$$;

do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.revoke_contract('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 'because I want to', false);
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and v_msg like '%may not perform this operation%'
    and (select status = 'active' from public.contracts where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'),
    'money-revoke-contract-requires-a-manager');
end
$$;

-- ============================================================================
-- 20260813000000_session_revocation_boundary.sql · deactivation, ban and
-- password change take effect at the DATA boundary
-- ============================================================================
-- Every one of these acts as a browser session over the tables directly, which
-- is the path PostgREST gives a credential holder and the path none of the
-- Next.js checks are on. Positive cases are included deliberately: a boundary
-- that refuses everyone is not a boundary, it is an outage, and without them a
-- "reads no rows" assertion could pass because there was nothing to read.

-- Shape of the predicates. Definer with a pinned search_path, and not reachable
-- by anon — anon has no auth.uid(), so granting it would only widen the surface.
select pg_temp.assert((select bool_and(prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'])
                       from pg_proc
                       where oid in (to_regprocedure('public.session_identity_enabled()'),
                                     to_regprocedure('public.session_token_is_current()'))),
                      'session-predicates-are-definer-with-pinned-search-path');

select pg_temp.assert(not (has_function_privilege('anon', to_regprocedure('public.session_identity_enabled()'), 'execute')
                        or has_function_privilege('anon', to_regprocedure('public.session_token_is_current()'), 'execute')),
                      'session-predicates-not-executable-by-anon');

-- Completeness, computed rather than listed: every table with a PERMISSIVE
-- policy an authenticated session can use must also carry the restrictive
-- overlay. A table added by a later migration cannot quietly fall outside it.
do $$
declare
  v_missing text[];
begin
  select coalesce(array_agg(distinct c.relname order by c.relname), '{}')
    into v_missing
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
    join pg_policy p on p.polrelid = c.oid
   where ns.nspname = 'public'
     and c.relkind = 'r'
     and c.relrowsecurity
     and p.polpermissive
     and (p.polroles = '{0}'::oid[] or 'authenticated'::regrole::oid = any(p.polroles))
     and not exists (
       select 1 from pg_policy q
        where q.polrelid = c.oid
          and not q.polpermissive
          and q.polname like 'restrict%active_session%'
     );
  if array_length(v_missing, 1) > 0 then
    raise exception 'tables reachable by authenticated with no session boundary: %', v_missing
      using errcode = '22000';
  end if;
  perform pg_temp.assert(true, 'session-boundary-covers-every-authenticated-reachable-table');

  -- And the overlay is the right KIND of policy. A permissive one would be OR-ed
  -- with the existing policies and would grant, not restrict.
  perform pg_temp.assert(
    (select bool_and(not polpermissive and polroles = array['authenticated'::regrole]::oid[])
       from pg_policy
      where polname like 'restrict%active_session%'),
    'session-boundary-policies-are-restrictive-and-scoped-to-authenticated');
end
$$;

-- Positive: an active identity holding a current token still reads its own rows.
do $$
declare
  v_sales int;
  v_admin int;
begin
  perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
  set local role authenticated;
  select count(*) into v_sales from public.contracts;
  reset role;
  perform pg_temp.assert(v_sales > 0, 'session-active-current-token-reads-own-contracts');

  perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  set local role authenticated;
  select count(*) into v_admin from public.contracts;
  reset role;
  perform pg_temp.assert(v_admin >= v_sales, 'session-active-admin-identity-reads-contracts');
end
$$;

-- F-02, at the data boundary. dddddddd-…-dddd is the published credential:
-- 20260811100300 set is_active = false, and its role is still 'admin', so the
-- pre-existing `contracts_admin_all` policy would hand it every contract. This
-- is the assertion that says the two flipped columns now mean something to
-- PostgREST, and it is one of the ones that fails against the floor.
do $$
declare
  v_contracts int;
  v_profiles  int;
begin
  perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
  set local role authenticated;
  select count(*) into v_contracts from public.contracts;
  select count(*) into v_profiles  from public.profiles;
  reset role;
  perform pg_temp.assert(v_contracts = 0, 'session-inactive-admin-identity-reads-no-contracts');
  -- Not even its own row: the read relaxation below is for a stale token, not
  -- for a deactivated identity.
  perform pg_temp.assert(v_profiles = 0, 'session-inactive-identity-reads-no-profile-row');
end
$$;

-- A write, not a read: an inactive identity cannot even record its own
-- last_active_at, the one caller-scoped profiles write in the codebase. A
-- restrictive USING that does not match filters the row out, so this is checked
-- by row count rather than by an exception.
do $$
declare
  v_rows int;
begin
  perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
  set local role authenticated;
  update public.profiles set last_active_at = now() where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  get diagnostics v_rows = row_count;
  reset role;
  perform pg_temp.assert(v_rows = 0, 'session-inactive-identity-cannot-write-its-own-profile');
end
$$;

-- Ban. The identity is active in `profiles`; only auth.users.banned_until moves.
-- This is the postcondition the authorised F-02 cutover depends on: once an
-- operator bans the identity, access stops at the database immediately, rather
-- than when the last issued token happens to expire.
do $$
declare
  v_before int;
  v_after  int;
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    select count(*) into v_before from public.contracts;
    reset role;

    update auth.users set banned_until = now() + interval '1 day'
     where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    select count(*) into v_after from public.contracts;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;
  perform pg_temp.assert(v_before > 0, 'session-ban-fixture-had-rows-to-lose');
  perform pg_temp.assert(v_after = 0, 'session-banned-identity-reads-no-contracts');
  perform pg_temp.assert((select banned_until is null from auth.users
                          where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
                         'session-ban-fixture-was-rolled-back');
end
$$;

-- Password change. The access token cannot be unsigned, so the gate compares its
-- `iat` with profiles.password_changed_at — the column both admin reset paths
-- already write and neither could enforce. Four cases in one subtransaction: the
-- token minted before the change is dead, a token minted after it is not, a
-- claim set with no `iat` at all is refused rather than waved through, and the
-- read relaxation on profiles is exactly one row wide.
do $$
declare
  v_stale   int;
  v_fresh   int;
  v_no_iat  int;
  v_own     int;
  v_others  int;
begin
  begin
    update public.profiles set password_changed_at = now()
     where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc', -interval '1 hour');
    set local role authenticated;
    select count(*) into v_stale  from public.contracts;
    select count(*) into v_own    from public.profiles where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    select count(*) into v_others from public.profiles where id <> 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    reset role;

    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc', interval '1 minute');
    set local role authenticated;
    select count(*) into v_fresh from public.contracts;
    reset role;

    -- A GoTrue JWT always carries iat. A claim set without one is either not a
    -- GoTrue token or has been shaped by something that should not be trusted,
    -- so the predicate must not read "no iat" as "no password change".
    perform set_config('request.jwt.claims',
                       '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","role":"authenticated"}',
                       true);
    set local role authenticated;
    select count(*) into v_no_iat from public.contracts;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then raise; end if;
  end;

  perform pg_temp.assert(v_stale = 0,  'session-token-issued-before-password-change-reads-nothing');
  perform pg_temp.assert(v_fresh > 0,  'session-token-issued-after-password-change-still-reads');
  perform pg_temp.assert(v_no_iat = 0, 'session-claim-set-without-iat-is-refused');
  -- The one deliberate relaxation, and its limit: src/proxy.ts needs the
  -- caller's own row to answer /login?reason=password_changed, so a stale token
  -- may read exactly that row and no other.
  perform pg_temp.assert(v_own = 1,    'session-stale-token-still-reads-its-own-profile-row');
  perform pg_temp.assert(v_others = 0, 'session-stale-token-cannot-enumerate-other-profiles');
  perform pg_temp.assert((select password_changed_at is null from public.profiles
                          where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
                         'session-password-change-fixture-was-rolled-back');
end
$$;

-- ============================================================================
-- Self-check: every assertion above ran.
-- ============================================================================
do $$
declare
  total int;
begin
  select count(*) into total from assert_log;
  if total <> 131 then
    raise exception 'assertion file ran % assertions, ASSERT_TOTAL says 131', total
      using errcode = '22000';
  end if;
  raise notice 'all % assertions passed', total;
end
$$;
