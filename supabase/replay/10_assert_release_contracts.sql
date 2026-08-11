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
-- ASSERT_TOTAL: 52
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

-- ============================================================================
-- Baseline drift (20260601010000_baseline_undeclared_production_objects.sql)
-- ============================================================================
select pg_temp.assert(to_regclass('public.meta_tokens') is not null, 'baseline-meta-tokens-exists');
select pg_temp.assert((select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('password_changed_at', 'force_password_change')), 'baseline-profiles-revocation-columns-exist');

-- ============================================================================
-- F-09 · money authorization
-- ============================================================================
-- Leg 1: the three SECURITY DEFINER money routines are reachable by the role a
-- logged-in browser session actually runs as, and not by anon.
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
    perform set_config('request.jwt.claim.sub', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true);
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
    perform set_config('request.jwt.claim.sub', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true);
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
    perform set_config('request.jwt.claim.sub', 'dddddddd-dddd-dddd-dddd-dddddddddddd', true);
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
select pg_temp.assert((select prosecdef and proconfig @> array['search_path=public, pg_temp'] from pg_proc where oid = to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')), 'kpi-definer-with-pinned-search-path');

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

-- And the happy path still replaces rather than accumulates.
do $$
declare
  after_count int;
begin
  perform * from public.replace_kpi_targets(
    '2026-99',
    '[{"target_type":"signing","target_amount":"7"}]'::jsonb,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  select count(*) into after_count from public.kpi_targets where period = '2026-99';
  perform pg_temp.assert(after_count = 1, 'kpi-successful-replace-replaces-period');
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
  if total <> 52 then
    raise exception 'assertion file ran % assertions, ASSERT_TOTAL says 52', total
      using errcode = '22000';
  end if;
  raise notice 'all % assertions passed', total;
end
$$;
