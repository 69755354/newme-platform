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
-- ASSERT_TOTAL: 350
-- ============================================================================

create temp table assert_log (name text, passed boolean not null);

-- Two behaviours, selected by the `replay.collect` GUC that
-- scripts/replay-migrations.sh sets (through PGOPTIONS) only in MODE=control.
--
-- Default — MODE=branch, the gate: a failed assertion raises, so the first
-- broken invariant stops the run and the job is red.
--
-- replay.collect = on — MODE=control, the negative control: a failed assertion
-- is the EXPECTED result, so it is recorded and the block continues. Round-3
-- finding P1-12 is exactly what raising cost us here: the control ran the
-- assertion file with ON_ERROR_STOP off, which continues to the next *statement*
-- but abandons the rest of the enclosing DO block, so one early failure silenced
-- every later assertion in the same block. 87 of the 187 load-bearing assertions
-- emitted a marker and 100 emitted nothing, and "no ASSERT_OK line" was being
-- read as "this assertion detected the un-remediated floor". Collecting instead
-- of raising is what makes one marker per assertion possible.
--
-- Both branches write to assert_log, so the self-check at the foot of this file
-- can prove from inside the database that every assertion declared in
-- ASSERT_TOTAL above was reached — a claim no amount of log scraping can make.
-- The count is deliberately not repeated here: a second copy of it in prose is a
-- copy that rots, and this comment has already been wrong once.
create or replace function pg_temp.assert(condition boolean, assertion_name text)
returns void
language plpgsql
as $$
begin
  if condition is not true then
    if coalesce(current_setting('replay.collect', true), 'off') = 'on' then
      insert into assert_log (name, passed) values (assertion_name, false);
      raise notice 'ASSERT_FAIL %', assertion_name;
      return;
    end if;
    raise exception 'ASSERT_FAIL %', assertion_name using errcode = '22000';
  end if;
  insert into assert_log (name, passed) values (assertion_name, true);
  raise notice 'ASSERT_OK %', assertion_name;
end
$$;

create or replace function pg_temp.collecting()
returns boolean
language sql
as $$ select coalesce(current_setting('replay.collect', true), 'off') = 'on' $$;

-- The other half of P1-12: a measurement the un-remediated floor cannot take.
--
-- Roughly a third of this file's assertions are about objects the floor does not
-- have — void_payment(), money_release_mode, profiles.password_changed_at. In
-- MODE=control the statement that measures them raises undefined_function or
-- undefined_column, which in a DO block is fatal: the block dies and every
-- assertion below it in the same block emits no marker at all. That is how 78
-- assertions came to be listed as "detected the floor" without ever running.
--
-- absorb() is called from the exception handler of the measurement instead of
-- `raise`. In MODE=branch it re-raises with the original SQLSTATE and message, so
-- the gate is exactly as strict as before. In MODE=control it records that the
-- measurement could not be taken and returns, so the block runs to its end and
-- every assertion in it reports its own verdict against the initial values of the
-- variables the measurement was supposed to set — which is a failure, and is
-- reported under the assertion's own name.
create or replace function pg_temp.absorb(p_sqlstate text, p_message text)
returns void
language plpgsql
as $$
begin
  if pg_temp.collecting() then
    raise notice 'ASSERT_UNMEASURABLE [%] %', p_sqlstate, p_message;
    return;
  end if;
  raise exception '%', p_message using errcode = p_sqlstate;
end
$$;

-- Same problem, one statement wide. A top-level `select pg_temp.assert(<expr>,
-- 'name')` whose expression names an object the floor does not have cannot even
-- be planned, so the statement errors and the assertion emits no marker. Passing
-- the expression as text lets the failure be attributed to the assertion it
-- belongs to. MODE=branch re-raises, so a typo in the expression is still a hard
-- failure rather than a silent "unmeasurable".
create or replace function pg_temp.assert_eval(p_expr text, p_name text)
returns void
language plpgsql
as $$
declare
  v_ok boolean;
begin
  begin
    execute 'select (' || p_expr || ')' into v_ok;
  exception when others then
    perform pg_temp.absorb(sqlstate, sqlerrm);
    perform pg_temp.assert(false, p_name);
    return;
  end;
  perform pg_temp.assert(v_ok, p_name);
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
select pg_temp.assert_eval($q$ to_regclass('public.meta_tokens') is not null $q$, 'baseline-meta-tokens-exists');
select pg_temp.assert_eval($q$ (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('password_changed_at', 'force_password_change')) $q$, 'baseline-profiles-revocation-columns-exist');

-- ============================================================================
-- F-09 · money authorization
-- ============================================================================
-- Leg 1: the three money RPCs the API routes call are reachable by the role a
-- logged-in browser session actually runs as, and not by anon. (They were
-- SECURITY INVOKER throughout the committed history — despite the name
-- 20260723130000_lock_definer_boundaries.sql, which only pins search_path.
-- 20260812000000 is what makes them definer; that is asserted separately below.)
select pg_temp.assert_eval($q$ has_function_privilege('authenticated', 'public.confirm_payment(uuid, uuid)', 'execute') $q$, 'f09-authenticated-can-execute-confirm-payment');
select pg_temp.assert_eval($q$ has_function_privilege('authenticated', 'public.approve_contract(uuid, uuid, text, text)', 'execute') $q$, 'f09-authenticated-can-execute-approve-contract');
select pg_temp.assert_eval($q$ has_function_privilege('authenticated', 'public.allocate_payment(uuid, jsonb, uuid)', 'execute') $q$, 'f09-authenticated-can-execute-allocate-payment');
select pg_temp.assert_eval($q$ has_function_privilege('service_role', 'public.confirm_payment(uuid, uuid)', 'execute') $q$, 'f09-service-role-can-execute-confirm-payment');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.confirm_payment(uuid, uuid)', 'execute') $q$, 'f09-anon-cannot-execute-confirm-payment');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.approve_contract(uuid, uuid, text, text)', 'execute') $q$, 'f09-anon-cannot-execute-approve-contract');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.allocate_payment(uuid, jsonb, uuid)', 'execute') $q$, 'f09-anon-cannot-execute-allocate-payment');

-- Leg 2 regression. The revision of this migration that was reviewed revoked
-- INSERT/UPDATE/DELETE on contracts, payments, installment_plans,
-- contract_approvals and quotations from `authenticated`, on the belief that all
-- money writes go through service_role. Ten call sites write these tables with
-- the CALLER'S client (createServerSupabase → role `authenticated`), so that
-- revoke would have taken every contract, payment and conversion write offline.
-- These six assertions are the outage detector; do not "tighten" them without
-- moving those call sites to supabaseAdmin first.
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.contracts', 'insert') $q$, 'f09-authenticated-retains-contracts-insert');
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.contracts', 'update') $q$, 'f09-authenticated-retains-contracts-update');
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.payments', 'insert') $q$, 'f09-authenticated-retains-payments-insert');
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.installment_plans', 'insert') $q$, 'f09-authenticated-retains-installment-plans-insert');
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.contract_approvals', 'insert') $q$, 'f09-authenticated-retains-contract-approvals-insert');
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.quotations', 'update') $q$, 'f09-authenticated-retains-quotations-update');

-- ============================================================================
-- F-06 · profiles column grants
-- ============================================================================
-- Kept: the one caller-scoped profiles write in the codebase (src/proxy.ts,
-- last_active_at) plus its audit column.
select pg_temp.assert_eval($q$ has_column_privilege('authenticated', 'public.profiles', 'last_active_at', 'update') $q$, 'f06-authenticated-can-update-last-active-at');
select pg_temp.assert_eval($q$ has_column_privilege('authenticated', 'public.profiles', 'updated_at', 'update') $q$, 'f06-authenticated-can-update-updated-at');
select pg_temp.assert_eval($q$ has_table_privilege('authenticated', 'public.profiles', 'select') $q$, 'f06-authenticated-retains-profiles-select');

-- Removed: the takeover chain. email was the live defect — change-password
-- verified the old password against profiles.email, so a user who could rewrite
-- their own profiles.email could aim the verification at another account. The
-- revocation columns are what /api/auth/me and src/proxy.ts consult to reject a
-- token minted before a password change; self-writable, they are not a control.
select pg_temp.assert_eval($q$ not has_column_privilege('authenticated', 'public.profiles', 'email', 'update') $q$, 'f06-authenticated-cannot-update-email');
select pg_temp.assert_eval($q$ not has_column_privilege('authenticated', 'public.profiles', 'password_changed_at', 'update') $q$, 'f06-authenticated-cannot-update-password-changed-at');
select pg_temp.assert_eval($q$ not has_column_privilege('authenticated', 'public.profiles', 'force_password_change', 'update') $q$, 'f06-authenticated-cannot-update-force-password-change');
select pg_temp.assert_eval($q$ not has_column_privilege('authenticated', 'public.profiles', 'is_active', 'update') $q$, 'f06-authenticated-cannot-update-is-active');
select pg_temp.assert_eval($q$ not has_column_privilege('authenticated', 'public.profiles', 'role', 'update') $q$, 'f06-authenticated-cannot-update-role');

-- ============================================================================
-- F-08 · audit / session records are server-owned
-- ============================================================================
select pg_temp.assert_eval($q$ (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and policyname = 'policy_audit_logs_insert_authenticated') $q$, 'f08-permissive-audit-insert-policy-is-gone');
select pg_temp.assert_eval($q$ (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and policyname = 'policy_activity_logs_insert_authenticated') $q$, 'f08-permissive-activity-insert-policy-is-gone');
select pg_temp.assert_eval($q$ (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'user_session_daily' and policyname = 'policy_user_session_daily_insert_authenticated') $q$, 'f08-permissive-session-insert-policy-is-gone');

-- Every INSERT policy visible to `authenticated` on the three tables must be
-- false. Enumerating instead of naming one policy is what catches a future
-- migration adding a second permissive policy beside the closed one: RLS
-- policies are permissive and OR together, so one loose policy is enough.
select pg_temp.assert_eval($q$ (select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'audit_logs' and cmd = 'INSERT' and 'authenticated' = any(roles)) $q$, 'f08-audit-insert-closed-for-authenticated');
select pg_temp.assert_eval($q$ (select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and cmd = 'INSERT' and 'authenticated' = any(roles)) $q$, 'f08-activity-insert-closed-for-authenticated');
select pg_temp.assert_eval($q$ (select bool_and(coalesce(with_check, 'true') = 'false') from pg_policies where schemaname = 'public' and tablename = 'user_session_daily' and cmd = 'INSERT' and 'authenticated' = any(roles)) $q$, 'f08-session-insert-closed-for-authenticated');

-- Behaviour, not catalog: run the forgery as the role a browser session runs as.
--
-- The session is `cccccccc-…` — active, with a profile, holding a token minted
-- after its last credential change — on purpose. Round 3 added
-- trg_require_current_session to every ordinary table, so a session that is
-- deactivated, banned or stale is refused before RLS is consulted; running this
-- as the deactivated dev account would have proved the SESSION boundary and said
-- nothing about the audit-insert policy. Both the sqlstate and the message are
-- matched so a class-28 refusal cannot pass as this closure either.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.audit_logs (actor_id, action, details)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'FORGED_BY_REPLAY', '{}');
  exception
    when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%row-level security policy%',
                         'f08-authenticated-cannot-forge-audit-row');
end
$$;

-- Same boundary with the caller's own actor_id: the previous revision of the
-- migration would have allowed this one, which is audit-log flooding.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.audit_logs (actor_id, action, details)
    values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'SELF_ATTRIBUTED_BY_REPLAY', '{}');
  exception
    when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%row-level security policy%',
                         'f08-authenticated-cannot-append-self-attributed-audit-row');
end
$$;

-- ============================================================================
-- F-10 · Meta access token exposure
-- ============================================================================
select pg_temp.assert_eval($q$ (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'meta_tokens' and policyname = 'policy_meta_tokens_select_authenticated') $q$, 'f10-permissive-select-policy-is-gone');
select pg_temp.assert_eval($q$ not has_table_privilege('authenticated', 'public.meta_tokens', 'select') $q$, 'f10-authenticated-has-no-select-grant');
select pg_temp.assert_eval($q$ not has_table_privilege('anon', 'public.meta_tokens', 'select') $q$, 'f10-anon-has-no-select-grant');
select pg_temp.assert_eval($q$ has_table_privilege('service_role', 'public.meta_tokens', 'select') $q$, 'f10-service-role-retains-select');
select pg_temp.assert_eval($q$ has_table_privilege('service_role', 'public.meta_tokens', 'insert') $q$, 'f10-service-role-retains-insert');
select pg_temp.assert_eval($q$ has_table_privilege('service_role', 'public.meta_tokens', 'update') $q$, 'f10-service-role-retains-update');

-- Behaviour: the grant is what closes this, so prove the grant, not the policy.
-- RLS alone would not have been enough — a permissive `using (true)` policy plus
-- a table grant is how every authenticated user could read the plaintext token.
--
-- The access attempt has to run through a SECURITY INVOKER routine called by a
-- top-level SET ROLE. A static statement inside a postgres-owned DO block keeps
-- the block's original privilege context even after SET LOCAL ROLE and can reach
-- RLS first; on the production baseline that reports 28003 for the deliberately
-- inactive fixture rather than measuring the table grant. This helper catches
-- the SQLSTATE while genuinely executing as authenticated.
create or replace function pg_temp.meta_tokens_read_sqlstate()
returns text
language plpgsql
security invoker
as $$
begin
  perform count(*) from public.meta_tokens;
  return '00000';
exception when others then
  return sqlstate;
end
$$;

begin;
select pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
set local role authenticated;
select set_config('replay.meta_tokens_read_sqlstate', pg_temp.meta_tokens_read_sqlstate(), true);
reset role;
-- 42501 exactly, not "it raised something". The grant is what the migration
-- revoked, so insufficient_privilege is the boundary that has to do the
-- refusing; a read that failed for any other reason would not prove it.
-- Recording the SQLSTATE rather than raising on success is also what makes this
-- assertion reportable in MODE=control: the floor still holds the grant, the
-- read succeeds, and the verdict is 00000 under this assertion's own name.
select pg_temp.assert(
  current_setting('replay.meta_tokens_read_sqlstate') = '42501',
  'f10-authenticated-cannot-read-meta-tokens'
);
commit;

-- ============================================================================
-- F-02 · default-credential admin account
-- ============================================================================
-- The migration ran against the fixture (05_seed_behaviour_fixtures.sql) during
-- the re-apply step, so these assert its effect on real rows.
select pg_temp.assert_eval($q$ (select count(*) = 1 from auth.users where email = 'dev@newme.ae') $q$, 'f02-identity-not-deleted');
select pg_temp.assert_eval($q$ (select count(*) = 1 from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd') $q$, 'f02-profile-not-deleted');
select pg_temp.assert_eval($q$ (select is_active is false and force_password_change is true from public.profiles where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd') $q$, 'f02-account-neutralised');
select pg_temp.assert_eval($q$ (select count(*) = 2 from public.audit_logs where actor_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd' and action = 'REPLAY_FIXTURE_ACTION') $q$, 'f02-audit-attribution-survives');
select pg_temp.assert_eval($q$ (select is_active is true from public.profiles where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') $q$, 'f02-other-privileged-account-untouched');

-- ============================================================================
-- KPI targets · atomic period replacement
-- ============================================================================
select pg_temp.assert_eval($q$ to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)') is not null $q$, 'kpi-replace-function-exists');
select pg_temp.assert_eval($q$ has_function_privilege('service_role', 'public.replace_kpi_targets(text, jsonb, uuid)', 'execute') $q$, 'kpi-service-role-can-execute');
select pg_temp.assert_eval($q$ not has_function_privilege('authenticated', 'public.replace_kpi_targets(text, jsonb, uuid)', 'execute') $q$, 'kpi-authenticated-cannot-execute');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.replace_kpi_targets(text, jsonb, uuid)', 'execute') $q$, 'kpi-anon-cannot-execute');
select pg_temp.assert_eval($q$ (select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'] from pg_proc where oid = to_regprocedure('public.replace_kpi_targets(text, jsonb, uuid)')) $q$, 'kpi-definer-with-pinned-search-path');

-- The index that closes the NULL hole: unique, partial, and on the right
-- predicate. All three are checked, because a plain (period, target_type) unique
-- index would break the assigned case and a non-unique one would prove nothing.
select pg_temp.assert_eval($q$
  (select i.indisunique
  and pg_get_expr(i.indpred, i.indrelid) = '(assigned_to IS NULL)'
  and pg_get_indexdef(i.indexrelid) like '%(period, target_type)%'
  from pg_index i
  where i.indexrelid = 'public.idx_kpi_targets_one_unassigned_per_period_type'::regclass)
$q$, 'kpi-unassigned-target-is-unique-per-period-and-type');

-- The defect this replaces: DELETE and INSERT as two PostgREST calls, so a bad
-- row left the period empty. One malformed target_type must now leave the
-- period exactly as it was.
do $$
declare
  before_count int;
  after_count  int;
  v_state      text := '00000';
begin
  select count(*) into before_count from public.kpi_targets where period = '2026-99';
  begin
    perform * from public.replace_kpi_targets(
      '2026-99',
      '[{"target_type":"signing","target_amount":"1"},{"target_type":"NOT_A_TARGET_TYPE","target_amount":"2"}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then v_state := sqlstate;
  end;
  select count(*) into after_count from public.kpi_targets where period = '2026-99';
  perform pg_temp.assert(before_count = 2, 'kpi-fixture-period-seeded');
  -- 23514 is the boundary that must do the refusing: the target_type check
  -- constraint, inside the function's transaction. "the period still has two
  -- rows" alone is satisfied by a database where replace_kpi_targets does not
  -- exist at all, which is why the SQLSTATE is asserted separately.
  perform pg_temp.assert(v_state = '23514', 'kpi-invalid-target-type-refused-by-a-check-constraint');
  perform pg_temp.assert(after_count = 2, 'kpi-failed-replace-preserves-period');
end
$$;

-- Empty input is rejected before the delete, not after it.
do $$
declare
  after_count int;
  v_state     text := '00000';
begin
  begin
    perform * from public.replace_kpi_targets('2026-99', '[]'::jsonb, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then v_state := sqlstate;
  end;
  select count(*) into after_count from public.kpi_targets where period = '2026-99';
  -- Same reasoning as the invalid-target-type case: 22023 from the function's own
  -- guard, not merely an unchanged row count.
  perform pg_temp.assert(v_state = '22023', 'kpi-empty-row-set-refused-as-an-invalid-parameter');
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
  begin
    perform * from public.replace_kpi_targets(
      '2026-99',
      '[{"target_type":"signing","target_amount":"7"}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  exception when others then perform pg_temp.absorb(sqlstate, sqlerrm);
  end;

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
select pg_temp.assert_eval($q$ (select count(*) = 1 from public.kpi_targets where period = '2026-99') $q$, 'kpi-successful-replace-replaces-period');

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
select pg_temp.assert_eval($q$
  (select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
  from pg_proc where oid = to_regprocedure('public.money_actor(uuid, text[])'))
$q$, 'money-actor-definer-with-pinned-search-path');

-- The counter table is the one new piece of state the money path depends on. If
-- `authenticated` can touch it, a sales user can hand themselves a duplicate
-- contract number, so the revoke matters more than usual: Supabase's default
-- privileges grant every new public table to anon and authenticated.
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.contract_no_counters', 'select')
  or has_table_privilege('authenticated', 'public.contract_no_counters', 'insert')
  or has_table_privilege('authenticated', 'public.contract_no_counters', 'update')
  or has_table_privilege('anon', 'public.contract_no_counters', 'select'))
$q$, 'money-counters-table-unreachable-by-end-user-roles');

select pg_temp.assert_eval($q$
  not (has_function_privilege('authenticated', 'public.next_contract_no(date)', 'execute')
  or has_function_privilege('anon', 'public.next_contract_no(date)', 'execute'))
$q$, 'money-next-contract-no-unreachable-by-end-user-roles');

-- tgenabled is checked, not just existence: a disabled trigger is the quiet
-- version of a dropped one.
select pg_temp.assert_eval($q$
  (select count(*) = 5
  from pg_trigger
  where not tgisinternal and tgenabled = 'O'
  and tgname in ('trg_guard_contracts_write',
  'trg_guard_payments_write',
  'trg_guard_installment_plans_write',
  'trg_guard_contract_approvals_write',
  'trg_guard_payment_allocations_write'))
$q$, 'money-write-guards-installed-and-enabled');

-- The routines have to be definer now, because they can no longer read the
-- caller's identity from an argument — they read it from the token, and then
-- they need to write rows the caller's own RLS would refuse (the installment
-- and approval rows a sales user was never able to insert).
select pg_temp.assert_eval($q$
  (select bool_and(prosecdef) from pg_proc
  where oid = any (array[
  to_regprocedure('public.approve_contract(uuid, uuid, text, text)'),
  to_regprocedure('public.confirm_payment(uuid, uuid)'),
  to_regprocedure('public.allocate_payment(uuid, jsonb, uuid)'),
  to_regprocedure('public.create_contract(jsonb)'),
  to_regprocedure('public.convert_quotation_to_contract(uuid, jsonb)'),
  to_regprocedure('public.set_contract_status(uuid, text, text)'),
  to_regprocedure('public.revoke_contract(uuid, text, boolean)')]))
$q$, 'money-routines-are-security-definer');

-- Section 12 of the migration rewrites on_lead_won() with CREATE OR REPLACE,
-- which SILENTLY DROPS both SECURITY DEFINER and SET search_path when they are
-- not restated. 20260624095205 added the first and 20260723130000 the second, so
-- forgetting either would take a production automation apart. This is the check
-- that the restatement is really there.
select pg_temp.assert_eval($q$
  (select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
  from pg_proc where oid = to_regprocedure('public.on_lead_won()'))
$q$, 'money-lead-won-trigger-kept-definer-and-pinned-search-path');

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
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
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
--
-- The sqlstate changed in round 3, deliberately, and the assertion says which
-- boundary answers: money_actor() now delegates to assert_current_session(),
-- which raises class 28 — `28003 inactive`. The distinction is not cosmetic. A
-- 42501 reaches the browser as 403 "you may not do this", which is wrong and
-- unactionable for a revoked session; 28003 reaches it as 401, which is the only
-- answer that makes the client re-authenticate instead of retrying.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('99999999-9999-9999-9999-999999999999');
    set local role authenticated;
    perform public.money_actor(null, array['admin']);
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '28003' and v_msg like '%deactivated%',
                         'money-actor-refuses-inactive-account');
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

-- The check create_contract never had (P1-4): it accepted any lead UUID, so a
-- sales user could sign a colleague's lead — and since a lead has exactly one
-- active-contract slot (idx_contracts_one_active_per_lead), doing so also took
-- that colleague's slot away.
--
-- 33333333 belongs to sales2 and still carries no contract at this point: the only
-- earlier statement aiming at it was the direct INSERT that trg_guard_contracts_write
-- refused. Three refusals now live in this routine and they must not be confused
-- with one another, so the message is matched and not only the sqlstate: 'lead not
-- found' is P0002, the duplicate pre-check is 23505, and this one is 42501.
do $$
declare
  v_state    text := '00000';
  v_msg      text := '';
  v_after    integer;
  v_mgr_st   text := '00000';
  v_mgr      jsonb;
  v_mgr_row  boolean := false;
begin
  -- The positive control runs FIRST, inside a rollback envelope. The rule is "the
  -- assignee OR a manager", so an admin must still be able to act on this lead;
  -- without it, a create_contract() that refused everyone would satisfy the refusal
  -- below. It runs first because if the ownership check is ever removed, the sales
  -- call succeeds and takes the lead's only active-contract slot — and then this
  -- block would die on the duplicate pre-check re-raised out of absorb() instead of
  -- failing the named assertion that is supposed to catch exactly that.
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    v_mgr := public.create_contract(jsonb_build_object(
      'lead_id',      '33333333-3333-3333-3333-333333333333',
      'amount',       '90000',
      'party_a_name', 'Replay manager on another lead',
      -- B4: every create_contract() call now needs a schedule that adds up. This
      -- one is a positive control for the ownership rule, so it has to be a
      -- request that is valid in every other respect.
      'installments', jsonb_build_array(
        jsonb_build_object('seq', '1', 'amount', '90000'))));
    reset role;
    v_mgr_row := (select status = 'draft'
                       and sales_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
                    from public.contracts where id = (v_mgr ->> 'id')::uuid);
    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      reset role;
      if sqlerrm <> 'REPLAY_ROLLBACK' then
        v_mgr_st := sqlstate;
        perform pg_temp.absorb(sqlstate, sqlerrm);
      end if;
  end;

  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.create_contract(jsonb_build_object(
      'lead_id',      '33333333-3333-3333-3333-333333333333',
      'amount',       '90000',
      'party_a_name', 'Replay another salespersons lead'));
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  -- Read as superuser, after `reset role`: policy_contracts_select_sales would hide
  -- a row created for sales2 from any authenticated reader, and a hidden row counts
  -- as zero — which would make this assertion pass while the contract exists.
  select count(*) into v_after from public.contracts
   where lead_id = '33333333-3333-3333-3333-333333333333';

  perform pg_temp.assert(
    v_state = '42501' and v_msg like '%only the assigned salesperson or a manager%',
    'money-create-contract-refuses-a-lead-assigned-to-another-salesperson');
  perform pg_temp.assert(v_after = 0,
    'money-create-contract-ownership-refusal-wrote-no-contract');
  perform pg_temp.assert(v_mgr_st = '00000' and v_mgr_row,
    'money-create-contract-still-allows-a-manager-on-that-lead');
  -- Both calls together left the lead exactly as the fixture had it: the manager's
  -- contract was rolled back and the sales call wrote nothing.
  perform pg_temp.assert(
    (select count(*) = 0 from public.contracts
      where lead_id = '33333333-3333-3333-3333-333333333333'),
    'money-create-contract-manager-fixture-was-rolled-back');
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

-- The happy path, all seven of the route's steps in one transaction — nine since
-- round 3, because the project and activity rows moved in here too (P1-6). They
-- used to be written by the route AFTER the commit, with failure downgraded to a
-- `warnings` entry and HTTP 200, so a conversion could and did commit without the
-- project row that the whole delivery side of the app keys off.
do $$
declare
  v_result jsonb;
  v_state  text := '00000';
  v_id     uuid;
  v_no     text;
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
  v_no := v_result ->> 'contract_no';

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

  -- The two derived rows, in the same transaction as the contract.
  perform pg_temp.assert(
    (select count(*) = 1 from public.projects where contract_id = v_id),
    'money-convert-quotation-writes-the-project-row-in-the-transaction');
  perform pg_temp.assert(
    (select count(*) = 1 from public.activities
      where lead_id = '66666666-6666-6666-6666-666666666666' and content like '%' || v_no || '%'),
    'money-convert-quotation-writes-the-activity-row-in-the-transaction');
end
$$;

-- A second conversion of the same quotation.
--
-- This assertion INVERTED in round 3, and the inversion is the finding. The
-- reviewed body refused a retry (23505 / "already converted"), which is correct
-- only if the first conversion is guaranteed complete — and it was not, because
-- the project and activity rows were written after the commit by the route. A
-- conversion that lost its project row could therefore never be repaired through
-- any entrypoint: every retry was refused, and the only fix was an operator's
-- SQL. The retry is now idempotent: it creates whatever is missing, reports it in
-- `finalized`, and never creates a second contract.
--
-- The fixture for the "missing row" case is made by deleting the project row
-- directly, as the superuser, with the request claims cleared: that is the state
-- the old code produced, and re-creating it is the only honest way to test the
-- repair.
do $$
declare
  v_result   jsonb;
  v_state    text := '00000';
  v_expected uuid;
begin
  select contract_id into v_expected from public.quotations
   where id = 'b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1';

  perform set_config('request.jwt.claims', '', true);
  delete from public.projects where contract_id = v_expected;

  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_result := public.convert_quotation_to_contract('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', '{}'::jsonb);
  exception when others then v_state := sqlstate;
  end;
  reset role;

  perform pg_temp.assert(
    v_state = '00000'
    and (v_result ->> 'already_converted')::boolean
    and (v_result ->> 'contract_id')::uuid = v_expected
    and v_result -> 'finalized' ? 'project'
    and (select count(*) = 1 from public.projects where contract_id = v_expected),
    'money-convert-quotation-retry-repairs-the-missing-derived-row');

  -- And the load-bearing negative: the repair must not have created a second
  -- contract for the lead. The old failure mode was two contracts, one of them
  -- unreachable, which idx_contracts_one_active_per_lead only catches for
  -- non-terminal statuses.
  perform pg_temp.assert(
    (select count(*) = 1 from public.contracts
      where lead_id = '66666666-6666-6666-6666-666666666666'),
    'money-convert-quotation-retry-creates-no-second-contract');
end
$$;

-- Nothing is created when the schedule does not add up, and nothing is left
-- half-created either: the invariant is checked before the first write. All three
-- refusals are measured against the same untouched quotation (b2b2…, owned by
-- sales2, still 'accepted' with no contract), so a body that wrote the contract
-- first and validated afterwards fails here.
do $$
declare
  v_none    text := '00000';
  v_short   text := '00000';
  v_zero    text := '00000';
  v_msgnone text := '';
  v_msgsh   text := '';
  v_msgzero text := '';
begin
  perform pg_temp.act_as('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
  set local role authenticated;

  begin
    perform public.convert_quotation_to_contract('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', '{}'::jsonb);
  exception when others then v_none := sqlstate; v_msgnone := sqlerrm;
  end;

  begin
    perform public.convert_quotation_to_contract(
      'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',
      jsonb_build_object('installments', jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 1000))));
  exception when others then v_short := sqlstate; v_msgsh := sqlerrm;
  end;

  begin
    perform public.convert_quotation_to_contract(
      'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2',
      jsonb_build_object('installments', jsonb_build_array(
        jsonb_build_object('seq', 1, 'amount', 80000),
        jsonb_build_object('seq', 2, 'amount', 0))));
  exception when others then v_zero := sqlstate; v_msgzero := sqlerrm;
  end;

  reset role;

  -- Each refusal names its own reason. The `coalesce(jsonb_typeof(...))` bug made
  -- the FIRST of these report the third one's message, which is how a UI that
  -- posted no body at all was told its schedule totalled 0.00.
  perform pg_temp.assert(v_none = '22023' and v_msgnone like '%none was supplied%',
                         'money-convert-quotation-refuses-a-missing-schedule-by-name');
  perform pg_temp.assert(v_short = '22023' and v_msgsh like '%totals 1000.00 but the quotation totals 80000.00%',
                         'money-convert-quotation-refuses-a-schedule-that-does-not-total-the-quotation');
  perform pg_temp.assert(v_zero = '22023' and v_msgzero like '%positive amount%',
                         'money-convert-quotation-refuses-a-non-positive-installment');
  perform pg_temp.assert(
    (select status = 'accepted' and contract_id is null
       from public.quotations where id = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2')
    and (select count(*) = 0 from public.contracts
          where lead_id = '88888888-8888-8888-8888-888888888888'),
    'money-convert-quotation-writes-nothing-when-the-schedule-is-refused');
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

-- The transition attempted here is a LEGAL one — active → completed is in the
-- graph — precisely so that the AUTHORIZATION boundary is the one under test.
-- The reviewed version of this assertion tried active → approved, which round 3's
-- trg_guard_contract_transition now refuses first with 22023, so it would have
-- passed on the strength of a different boundary and stopped proving that a
-- browser session cannot set a status at all. Both the sqlstate and the message
-- are matched for the same reason.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    update public.contracts set status = 'completed' where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '42501'
    and v_msg like '%change through approve_contract(), set_contract_status() or revoke_contract()%'
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
-- (src/app/api/payments/route.ts) and must keep working; the guard pins created_by
-- to the session identity and, since B3, requires the request's idempotency key.
--
-- The key is sent through dynamic SQL, and only where the column exists, because
-- this assertion is one of the ones that must hold on BOTH sides. Naming
-- request_key statically made it fail against the un-remediated floor with 42703
-- — not because the floor refuses the write, which is the claim, but because the
-- harness was handing that floor a column it does not have. It also took the
-- assertion below with it, which needs this row to exist before it can try to
-- confirm it. A negative control has to speak the floor's schema.
do $$
declare
  v_state text := '00000';
  v_keyed boolean := exists (
    select 1 from pg_attribute
     where attrelid = 'public.payments'::regclass
       and attname = 'request_key' and not attisdropped);
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    if v_keyed then
      execute $i$
        insert into public.payments (id, contract_id, amount, payment_date, created_by, request_key)
        values ('d3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
                1000.00, current_date, 'cccccccc-cccc-cccc-cccc-cccccccccccc',
                '3d3d3d3d-0000-4000-8000-000000000001') $i$;
    else
      execute $i$
        insert into public.payments (id, contract_id, amount, payment_date, created_by)
        values ('d3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
                1000.00, current_date, 'cccccccc-cccc-cccc-cccc-cccccccccccc') $i$;
    end if;
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
select pg_temp.assert_eval($q$
  (select bool_and(prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp'])
  from pg_proc
  where oid in (to_regprocedure('public.session_identity_enabled()'),
  to_regprocedure('public.session_token_is_current()')))
$q$, 'session-predicates-are-definer-with-pinned-search-path');

select pg_temp.assert_eval($q$
  not (has_function_privilege('anon', to_regprocedure('public.session_identity_enabled()'), 'execute')
  or has_function_privilege('anon', to_regprocedure('public.session_token_is_current()'), 'execute'))
$q$, 'session-predicates-not-executable-by-anon');

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
    raise notice 'tables reachable by authenticated with no session boundary: %', v_missing;
  end if;
  -- The list goes to the log as a notice and the verdict goes through assert(), so
  -- the failure is attributed to this assertion by name. Raising here instead put
  -- the diagnostic in an unclassified SQL error and took the rest of this block
  -- with it, which is the shape round-3 P1-12 objected to.
  perform pg_temp.assert(coalesce(array_length(v_missing, 1), 0) = 0,
                         'session-boundary-covers-every-authenticated-reachable-table');

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
-- last_active_at, the one caller-scoped profiles write in the codebase.
--
-- Round 3 changed HOW this is refused, and the change is the point. The
-- restrictive policy filtered the row out, so the statement succeeded with zero
-- rows affected — an outcome indistinguishable from "the row does not exist", and
-- one that a SECURITY DEFINER routine bypasses entirely because definer code is
-- not subject to RLS. trg_require_current_session raises instead, from a trigger,
-- which definer code does NOT bypass. So the assertion demands the exception, its
-- exact class-28 code, and that the row did not move.
do $$
declare
  v_state  text := '00000';
  v_msg    text := '';
  v_before timestamptz;
begin
  select last_active_at into v_before from public.profiles
   where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    update public.profiles set last_active_at = now() where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(
    v_state = '28003' and v_msg like '%deactivated%'
    and (select last_active_at is not distinct from v_before from public.profiles
          where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
    'session-inactive-identity-cannot-write-its-own-profile');
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
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
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
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  perform pg_temp.assert(v_stale = 0,  'session-token-issued-before-password-change-reads-nothing');
  perform pg_temp.assert(v_fresh > 0,  'session-token-issued-after-password-change-still-reads');
  perform pg_temp.assert(v_no_iat = 0, 'session-claim-set-without-iat-is-refused');
  -- The one deliberate relaxation, and its limit: src/proxy.ts needs the
  -- caller's own row to answer /login?reason=password_changed, so a stale token
  -- may read exactly that row and no other.
  perform pg_temp.assert(v_own = 1,    'session-stale-token-still-reads-its-own-profile-row');
  perform pg_temp.assert(v_others = 0, 'session-stale-token-cannot-enumerate-other-profiles');
  perform pg_temp.assert_eval($q$ (select password_changed_at is null from public.profiles
                                    where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc') $q$,
                              'session-password-change-fixture-was-rolled-back');
end
$$;

-- ============================================================================
-- 20260814000000_l0_round3_authorization_and_integrity.sql · the round-3
-- closures, each proved by running the statement that used to succeed
-- ============================================================================
-- Section I above proves the column and insert boundary. What follows is the
-- rest of round 3, and it is deliberately behavioural: every item here was
-- reproduced against a replayed schema before it was fixed, so every assertion
-- is a statement that used to do the wrong thing.

-- ---------------------------------------------------------------------------
-- K1 · the release-mode discriminator
-- ---------------------------------------------------------------------------
-- The expand/contract switch, and the trap underneath it. money_release_mode is
-- definer-only like contract_no_counters; the mode READER is definer so it can
-- see that table; and money_direct_write_is_blocked() — the discriminator the
-- guards consult — must be INVOKER, because it calls money_write_is_direct(),
-- which is `current_user in ('authenticated','anon')`.
--
-- The first revision of that wrapper was SECURITY DEFINER, which made
-- current_user the OWNER for every browser statement, so the wrapper answered
-- "not a direct write" and every guard took its compatibility path: with
-- mode = 'strict' a `set local role authenticated` insert into contracts
-- returned INSERT 0 1. The replay caught it. The three assertions below are the
-- regression detector — the catalog shape, plus the discriminator answering
-- TRUE for a browser session and FALSE for a server context, which is the pair
-- a definer wrapper cannot satisfy.
select pg_temp.assert_eval($q$ public.money_direct_write_mode() = 'strict' $q$, 'money-release-mode-is-strict-after-the-contract-phase');
select pg_temp.assert_eval($q$
  (select prosecdef from pg_proc
  where oid = to_regprocedure('public.money_direct_write_mode()'))
$q$, 'money-release-mode-reader-is-definer');
select pg_temp.assert_eval($q$
  (select not prosecdef from pg_proc
  where oid = to_regprocedure('public.money_direct_write_is_blocked()'))
$q$, 'money-direct-write-discriminator-is-security-invoker');
select pg_temp.assert_eval($q$ not public.money_direct_write_is_blocked() $q$, 'money-direct-write-discriminator-is-false-in-a-server-context');

-- Reading the mode is granted to `authenticated` — the invoker design requires
-- it, and it discloses only whether the release is past its contract phase,
-- which every refusal message already says. CHANGING it is not, in either
-- direction, and the table itself stays unreachable.
select pg_temp.assert_eval($q$ has_function_privilege('authenticated', 'public.money_direct_write_mode()', 'execute') $q$, 'money-release-mode-is-readable-by-authenticated');
select pg_temp.assert_eval($q$ not has_function_privilege('authenticated', 'public.money_set_direct_write_mode(text, text)', 'execute') $q$, 'money-release-mode-is-not-settable-by-authenticated');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.money_direct_write_mode()', 'execute') $q$, 'money-release-mode-is-not-readable-by-anon');
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.money_release_mode', 'select')
  or has_table_privilege('authenticated', 'public.money_release_mode', 'update'))
$q$, 'money-release-mode-table-is-unreachable-by-authenticated');

do $$
declare
  v_is_direct boolean;
  v_blocked   boolean;
  v_mode      text;
  v_state     text := '00000';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    select public.money_write_is_direct()        into v_is_direct;
    select public.money_direct_write_is_blocked() into v_blocked;
  exception when others then perform pg_temp.absorb(sqlstate, sqlerrm);
  end;
  reset role;

  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.money_set_direct_write_mode('compat', 'a session should not be able to do this');
  exception when others then v_state := sqlstate;
  end;
  reset role;

  begin
    select public.money_direct_write_mode() into v_mode;
  exception when others then perform pg_temp.absorb(sqlstate, sqlerrm);
  end;

  perform pg_temp.assert(v_is_direct, 'money-write-is-direct-sees-a-browser-session');
  perform pg_temp.assert(v_blocked,   'money-direct-write-discriminator-is-true-for-a-browser-session');
  -- An admin session, not just any session: the posture is an operator decision.
  perform pg_temp.assert(v_state = '42501' and v_mode = 'strict',
                         'money-release-mode-cannot-be-widened-by-an-admin-session');
end
$$;

-- ---------------------------------------------------------------------------
-- K2 · the compatibility window is real, and it does not stand down DELETE
-- ---------------------------------------------------------------------------
-- The rollback boundary. If the contract phase is reverted the previous release
-- has to keep working, so the column and insert checks stand down — and the
-- DELETE refusals and the void-column refusals do NOT, because no release of
-- this application ever issued those statements from a session, so refusing
-- them costs no compatibility. Everything here happens inside a subtransaction
-- that is rolled back, mode included.
do $$
declare
  v_mode_in      text;
  v_old_app      text := 'unset';
  v_delete_state text := '00000';
  v_delete_msg   text := '';
  v_void_state   text := '00000';
  v_void_msg     text := '';
begin
  begin
    perform public.money_set_direct_write_mode('compat', 'replay: prove the rollback boundary');
    v_mode_in := public.money_direct_write_mode();

    -- The previous release's own statement: a browser session moving a contract
    -- through a LEGAL transition with a direct UPDATE. Under strict this is the
    -- 42501 asserted in section I; under compat it must succeed, or a rollback
    -- of the contract phase would leave the old application broken.
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.contracts set status = 'completed'
       where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';
      v_old_app := (select status from public.contracts
                     where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4');
    exception when others then v_old_app := 'refused: ' || sqlstate;
    end;
    reset role;

    -- DELETE, in compat, with the privilege handed back. GRANT is transactional,
    -- so this also answers "what if a later migration re-grants it": the trigger
    -- still refuses.
    grant delete on public.payments to authenticated;
    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.payments where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';
    exception when others then v_delete_state := sqlstate; v_delete_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      update public.payments set void_reason = 'not through the reversal'
       where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';
    exception when others then v_void_state := sqlstate; v_void_msg := sqlerrm;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  perform pg_temp.assert(v_mode_in = 'compat', 'money-release-mode-fixture-entered-compat');
  perform pg_temp.assert(v_old_app = 'completed',
                         'money-compat-window-still-lets-the-previous-release-write-a-status');
  perform pg_temp.assert(v_delete_state = '42501'
                         and v_delete_msg like '%reverse the payment through void_payment() instead%',
                         'money-payment-delete-refused-even-in-compat-mode');
  perform pg_temp.assert(v_void_state = '42501'
                         and v_void_msg like '%a payment is voided through void_payment()%',
                         'money-void-columns-refused-even-in-compat-mode');
  perform pg_temp.assert_eval($q$ public.money_direct_write_mode() = 'strict' $q$,
                              'money-release-mode-fixture-was-rolled-back');
  perform pg_temp.assert((select status = 'active' from public.contracts
                          where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4'),
                         'money-compat-window-fixture-was-rolled-back');
end
$$;

-- ---------------------------------------------------------------------------
-- K3 · DELETE on the five money tables  (P1-2, first half)
-- ---------------------------------------------------------------------------
-- The reproduced defect: the trg_guard_* triggers covered INSERT and UPDATE but
-- not DELETE, and `authenticated` held DELETE on payments, so a browser session
-- deleted a confirmed payment. payment_allocations.payment_id is ON DELETE
-- CASCADE, so the allocation rows went with it while
-- installment_plans.allocated_amount, projects.paid_amount,
-- kpi_targets.actual_amount and contracts.first_payment_status kept the money.
--
-- Two independent closures, and both are asserted, because either alone is one
-- migration away from being undone. The privilege is gone:
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.contracts', 'delete')
  or has_table_privilege('anon', 'public.contracts', 'delete'))
$q$, 'money-contracts-delete-privilege-is-gone');
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.payments', 'delete')
  or has_table_privilege('anon', 'public.payments', 'delete'))
$q$, 'money-payments-delete-privilege-is-gone');
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.installment_plans', 'delete')
  or has_table_privilege('anon', 'public.installment_plans', 'delete'))
$q$, 'money-installment-plans-delete-privilege-is-gone');
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.contract_approvals', 'delete')
  or has_table_privilege('anon', 'public.contract_approvals', 'delete'))
$q$, 'money-contract-approvals-delete-privilege-is-gone');
select pg_temp.assert_eval($q$
  not (has_table_privilege('authenticated', 'public.payment_allocations', 'delete')
  or has_table_privilege('anon', 'public.payment_allocations', 'delete'))
$q$, 'money-payment-allocations-delete-privilege-is-gone');

-- And the trigger refuses it anyway. Each DELETE below is issued with the
-- privilege temporarily granted back and as an ADMIN session, so the RLS
-- *_admin_all policies match the row and the statement actually reaches the row
-- trigger — without both, "permission denied for table" or "0 rows deleted"
-- would masquerade as the guard refusing. Rolled back, grants included.
do $$
declare
  v_c_state text := '00000'; v_c_msg text := '';
  v_p_state text := '00000'; v_p_msg text := '';
  v_i_state text := '00000'; v_i_msg text := '';
  v_a_state text := '00000'; v_a_msg text := '';
  v_l_state text := '00000'; v_l_msg text := '';
  v_alloc_before int;
  v_contracts_before int;
begin
  select count(*) into v_alloc_before from public.payment_allocations;
  select count(*) into v_contracts_before from public.contracts;

  begin
    grant delete on public.contracts, public.payments, public.installment_plans,
                    public.contract_approvals, public.payment_allocations
       to authenticated;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.contracts where id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1';
    exception when others then v_c_state := sqlstate; v_c_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.payments where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';
    exception when others then v_p_state := sqlstate; v_p_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.installment_plans where id = '91111111-1111-1111-1111-111111111111';
    exception when others then v_i_state := sqlstate; v_i_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.contract_approvals where contract_id = 'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1';
    exception when others then v_a_state := sqlstate; v_a_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      delete from public.payment_allocations
       where payment_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';
    exception when others then v_l_state := sqlstate; v_l_msg := sqlerrm;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  -- The fixture had something to lose. Without this the allocation DELETE could
  -- be refused because there was no row to delete.
  perform pg_temp.assert(v_alloc_before > 0, 'money-delete-fixture-had-an-allocation-to-lose');

  perform pg_temp.assert(v_c_state = '42501'
                         and v_c_msg like '%terminate the contract through set_contract_status() instead%',
                         'money-direct-contract-delete-refused-by-the-guard');
  perform pg_temp.assert(v_p_state = '42501'
                         and v_p_msg like '%reverse the payment through void_payment() instead%',
                         'money-direct-payment-delete-refused-by-the-guard');
  perform pg_temp.assert(v_i_state = '42501'
                         and v_i_msg like '%installment plans are not deleted directly%',
                         'money-direct-installment-plan-delete-refused-by-the-guard');
  perform pg_temp.assert(v_a_state = '42501'
                         and v_a_msg like '%contract_approvals rows are not deleted%',
                         'money-direct-contract-approval-delete-refused-by-the-guard');
  perform pg_temp.assert(v_l_state = '42501'
                         and v_l_msg like '%payment_allocations rows are not deleted%',
                         'money-direct-payment-allocation-delete-refused-by-the-guard');

  perform pg_temp.assert((select count(*) = v_contracts_before from public.contracts),
                         'money-delete-refusals-left-every-contract-in-place');
  perform pg_temp.assert((select count(*) = v_alloc_before from public.payment_allocations),
                         'money-delete-refusals-left-every-allocation-in-place');
  perform pg_temp.assert(not has_table_privilege('authenticated', 'public.payments', 'delete'),
                         'money-delete-grant-fixture-was-rolled-back');
end
$$;

-- ---------------------------------------------------------------------------
-- K4 · void_payment() — the reversal that actually reverses  (P1-2, second half)
-- ---------------------------------------------------------------------------
-- Refusing the DELETE is only half a fix: the reason the DELETE was reachable is
-- that there was no supported way to undo a mistaken confirmation. The
-- assertions here are the derived totals, because that is what the DELETE got
-- wrong — it removed the payment and left every total quoting it.
select pg_temp.assert_eval($q$ has_function_privilege('authenticated', 'public.void_payment(uuid, text)', 'execute') $q$, 'money-void-payment-executable-by-authenticated');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.void_payment(uuid, text)', 'execute') $q$, 'money-void-payment-not-executable-by-anon');
select pg_temp.assert_eval($q$
  (select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
  from pg_proc where oid = to_regprocedure('public.void_payment(uuid, text)'))
$q$, 'money-void-payment-is-definer-with-pinned-search-path');

-- Role rule first, and it is the documented one: admin, boss, finance — the
-- same three /api/payments/[id]/void, confirm and allocate name. A salesperson
-- is refused by name, not by a generic 42501.
do $$
declare v_state text := '00000'; v_msg text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.void_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'sales should not be able to');
  exception when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_state = '42501' and v_msg like '%role sales may not perform this operation%',
                         'money-void-payment-refuses-a-sales-caller');
  -- assert_eval, not assert: payments.voided_at does not exist until
  -- 20260814000000 creates it, so on the un-remediated floor the expression cannot
  -- be planned. Passing it as text attributes that to this assertion instead of
  -- killing the block.
  perform pg_temp.assert_eval($q$ (select voided_at is null and confirmed
                                     from public.payments where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1') $q$,
                              'money-void-payment-refusal-left-the-payment-confirmed');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    perform public.void_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '   ');
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = '22023', 'money-void-payment-requires-a-reason');
end
$$;

do $$
declare v_state text := '00000';
begin
  begin
    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    perform public.void_payment('00000000-0000-0000-0000-0000000000ff', 'no such payment');
  exception when others then v_state := sqlstate;
  end;
  reset role;
  perform pg_temp.assert(v_state = 'P0002', 'money-void-payment-reports-a-missing-payment-as-not-found');
end
$$;

-- The reversal itself. Every derived total is asserted as a DIFFERENCE against
-- the value measured before the call, so this proves the recomputation rather
-- than restating the fixture, and it keeps holding if an earlier section's
-- amounts change.
do $$
declare
  v_result        jsonb;
  v_alloc_before  int;
  v_alloc_after   int;
  v_amount        numeric(12, 2);
  v_plan_before   numeric(12, 2);
  v_plan_after    numeric(12, 2);
  v_plan_status   text;
  v_paid_before   numeric(12, 2);
  v_paid_after    numeric(12, 2);
  v_kpi_before    numeric(12, 2);
  v_kpi_after     numeric(12, 2);
  v_fps           text;
  v_confirmed     boolean;
  v_voided_by     uuid;
  v_reason        text;
  v_row_survives  boolean;
  v_second_state  text := '00000';
  v_direct_state  text := '00000';
  v_direct_msg    text := '';
begin
  begin
    select amount into v_amount from public.payments
     where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';
    select count(*) into v_alloc_before from public.payment_allocations
     where payment_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';
    select allocated_amount into v_plan_before from public.installment_plans
     where id = '92222222-2222-2222-2222-222222222222';
    select paid_amount into v_paid_before from public.projects
     where contract_id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
    select actual_amount into v_kpi_before from public.kpi_targets
     where assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
       and period = to_char(current_date, 'YYYY-MM') and target_type = 'collection';

    perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
    set local role authenticated;
    v_result := public.void_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
                                    'replay: mistaken confirmation');
    reset role;

    select count(*) into v_alloc_after from public.payment_allocations
     where payment_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';
    select allocated_amount, status into v_plan_after, v_plan_status
      from public.installment_plans where id = '92222222-2222-2222-2222-222222222222';
    select paid_amount into v_paid_after from public.projects
     where contract_id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
    select actual_amount into v_kpi_after from public.kpi_targets
     where assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
       and period = to_char(current_date, 'YYYY-MM') and target_type = 'collection';
    select first_payment_status into v_fps from public.contracts
     where id = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3';
    select confirmed, voided_by, void_reason, true
      into v_confirmed, v_voided_by, v_reason, v_row_survives
      from public.payments where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';

    -- Idempotence is not silent here: a second void is a conflict, because the
    -- totals have already been recomputed and doing it twice would subtract the
    -- amount twice.
    begin
      perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
      set local role authenticated;
      perform public.void_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'again');
    exception when others then v_second_state := sqlstate;
    end;
    reset role;

    -- And un-voiding is not a direct write either, in either mode.
    begin
      perform pg_temp.act_as('ffffffff-ffff-ffff-ffff-ffffffffffff');
      set local role authenticated;
      update public.payments set voided_at = null, void_reason = null
       where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1';
    exception when others then v_direct_state := sqlstate; v_direct_msg := sqlerrm;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  -- Preconditions: there was money, an allocation and a total to reverse.
  perform pg_temp.assert(v_amount > 0 and v_alloc_before > 0 and v_plan_before > 0
                         and v_paid_before >= v_amount and v_kpi_before >= v_amount,
                         'money-void-fixture-had-a-confirmed-allocated-payment');

  perform pg_temp.assert((v_result ->> 'success')::boolean
                         and (v_result ->> 'payment_id') = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
                         and (v_result ->> 'plans_recomputed')::int = 1
                         and (v_result ->> 'actor_id')::uuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff',
                         'money-void-payment-succeeds-for-finance-as-itself');
  perform pg_temp.assert(v_alloc_after = 0, 'money-void-payment-releases-the-allocations');
  perform pg_temp.assert(v_plan_after = 0 and v_plan_status = 'pending',
                         'money-void-payment-recomputes-the-installment-plan');
  perform pg_temp.assert(v_paid_after = v_paid_before - v_amount,
                         'money-void-payment-recomputes-the-project-paid-amount');
  perform pg_temp.assert(v_kpi_after = v_kpi_before - v_amount,
                         'money-void-payment-reverses-the-collection-kpi');
  perform pg_temp.assert(v_fps = 'unpaid', 'money-void-payment-recomputes-first-payment-status');
  perform pg_temp.assert((v_result ->> 'contract_total_paid')::numeric = v_paid_after,
                         'money-void-payment-returns-the-recomputed-contract-total');
  -- The whole point of a void rather than a delete.
  perform pg_temp.assert(v_row_survives and not v_confirmed
                         and v_voided_by = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                         and v_reason = 'replay: mistaken confirmation',
                         'money-void-payment-keeps-an-auditable-row');
  perform pg_temp.assert(v_second_state = '23505', 'money-void-payment-refuses-a-second-void');
  perform pg_temp.assert(v_direct_state = '42501'
                         and v_direct_msg like '%a payment is voided through void_payment()%',
                         'money-void-payment-cannot-be-undone-by-a-direct-write');
  perform pg_temp.assert_eval($q$ (select confirmed and voided_at is null from public.payments
                                    where id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1') $q$,
                              'money-void-fixture-was-rolled-back');
end
$$;

-- ---------------------------------------------------------------------------
-- K5 · the contract status graph, in one place  (P1-8)
-- ---------------------------------------------------------------------------
-- The reproduced hole: revoke_contract() rejected exactly two statuses, so a
-- COMPLETED contract could be moved to 'revoking' — a finished job re-opened
-- into a revocation, with the approval chain behind it already settled. The
-- graph is now one function, every writer consults it, and a trigger enforces it
-- for writers that do not.
select pg_temp.assert_eval($q$
  (select provolatile = 'i' from pg_proc
  where oid = to_regprocedure('public.contract_transition_is_allowed(text, text)'))
$q$, 'money-transition-graph-is-immutable');
select pg_temp.assert_eval($q$ not public.contract_transition_is_allowed('completed', 'revoking') $q$, 'money-transition-graph-closes-the-completed-to-revoking-hole');
select pg_temp.assert_eval($q$
  not (public.contract_transition_is_allowed('completed', 'active')
  or public.contract_transition_is_allowed('completed', 'terminated')
  or public.contract_transition_is_allowed('completed', 'superseded'))
$q$, 'money-transition-graph-makes-completed-terminal');
select pg_temp.assert_eval($q$
  not (public.contract_transition_is_allowed('terminated', 'active')
  or public.contract_transition_is_allowed('superseded', 'active'))
$q$, 'money-transition-graph-makes-terminated-and-superseded-terminal');
select pg_temp.assert_eval($q$
  not (public.contract_transition_is_allowed(null, 'active')
  or public.contract_transition_is_allowed('active', null))
$q$, 'money-transition-graph-refuses-a-null-status');
select pg_temp.assert_eval($q$
  public.contract_transition_is_allowed('active', 'completed')
  and public.contract_transition_is_allowed('active', 'suspended')
  and public.contract_transition_is_allowed('suspended', 'active')
  and public.contract_transition_is_allowed('approved', 'active')
  and public.contract_transition_is_allowed('revoking', 'terminated')
$q$, 'money-transition-graph-still-permits-the-working-lifecycle');
-- ROW (1) | BEFORE (2) | UPDATE (16) = 19. Row-level on purpose: it compares
-- OLD.status with NEW.status, which a statement-level trigger cannot see. And
-- tgattr empty, i.e. `before update` and not `before update of status`: a column
-- list makes the trigger fire on the statement's target list rather than on what
-- the row ends up holding, so anything that assigns new.status without naming it
-- escapes. The behavioural half is two blocks below.
select pg_temp.assert_eval($q$
  (select tgtype = 19 and tgenabled = 'O' and tgattr::text = '' from pg_trigger
  where tgrelid = 'public.contracts'::regclass
  and tgname = 'trg_guard_contract_transition')
$q$, 'money-transition-trigger-is-an-unconditional-before-row-update-trigger');

-- ---------------------------------------------------------------------------
-- The guard triggers and the KPI RPCs, pinned by identity
-- ---------------------------------------------------------------------------
-- Round-4 C4-3. The posture verification asks whether each guard is present and
-- enabled. Present and enabled is not the same as unchanged: a migration can keep
-- the name and move the trigger to a different table, narrow it to UPDATE only,
-- give it a column list, or repoint it at another function, and every existence
-- check still passes. So the full identity of all seven — schema, table, trigger
-- name, function, tgtype, tgattr, tgenabled — is pinned as a set, in both
-- directions: an unexpected guard fails this too, because a guard nobody declared
-- is a guard nobody verifies on rollback.
select pg_temp.assert_eval($q$
  not exists (
    select 1
      from (
        select n.nspname || '.' || c.relname || '|' || t.tgname || '|' ||
               pn.nspname || '.' || p.proname || '|' || t.tgtype::text || '|' ||
               coalesce(t.tgattr::text, '') || '|' || t.tgenabled::text as row_id
          from pg_trigger t
          join pg_class c on c.oid = t.tgrelid
          join pg_namespace n on n.oid = c.relnamespace
          join pg_proc p on p.oid = t.tgfoid
          join pg_namespace pn on pn.oid = p.pronamespace
         where not t.tgisinternal
           and (pg_get_functiondef(p.oid) like '%money_direct_write_is_blocked%'
                or t.tgname = 'trg_guard_contract_transition')
      ) actual
      full join (
        values ('public.contract_approvals|trg_guard_contract_approvals_write|public.guard_definer_only_write|31||O'),
               ('public.contracts|trg_guard_contract_transition|public.guard_contract_transition|19||O'),
               ('public.contracts|trg_guard_contracts_write|public.guard_contracts_write|31||O'),
               ('public.installment_plans|trg_guard_installment_plans_write|public.guard_installment_plans_write|31||O'),
               ('public.payment_allocations|trg_guard_payment_allocations_write|public.guard_definer_only_write|31||O'),
               ('public.payments|trg_guard_payments_write|public.guard_payments_write|31||O'),
               ('public.quotations|trg_guard_quotations_write|public.guard_quotations_write|19||O')
      ) expected (row_id) on actual.row_id = expected.row_id
     where actual.row_id is null or expected.row_id is null
  )
$q$, 'money-guard-triggers-are-pinned-by-full-identity');

-- The two KPI routines the phase rollback affects, pinned the same way: identity
-- arguments, return type, set-returning or not, SECURITY DEFINER, the search_path
-- that makes definer safe, and the ACL. A definer routine that quietly loses its
-- search_path, gains EXECUTE for authenticated, or changes its return shape is a
-- different routine wearing the same name.
select pg_temp.assert_eval($q$
  not exists (
    select 1
      from (
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' ||
               pg_catalog.format_type(p.prorettype, null) || '|' ||
               p.proretset::text || '|' || p.prosecdef::text || '|' ||
               coalesce(array_to_string(p.proconfig, ','), '') || '|' ||
               coalesce(array_to_string(p.proacl, ' '), '') as row_id
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('clear_kpi_targets', 'replace_kpi_targets')
      ) actual
      full join (
        values ('clear_kpi_targets(p_period text, p_actor uuid)|bigint|false|true|search_path=pg_catalog, public, pg_temp|postgres=X/postgres service_role=X/postgres'),
               ('replace_kpi_targets(p_period text, p_rows jsonb, p_set_by uuid)|kpi_targets|true|true|search_path=pg_catalog, public, pg_temp|postgres=X/postgres service_role=X/postgres')
      ) expected (row_id) on actual.row_id = expected.row_id
     where actual.row_id is null or expected.row_id is null
  )
$q$, 'money-kpi-rpcs-are-pinned-by-full-identity');

-- ---------------------------------------------------------------------------
-- And unconditional as behaviour, not as a catalog column
-- ---------------------------------------------------------------------------
-- tgattr = '' says the trigger has no column list. This says what that buys. A
-- second BEFORE ROW trigger assigns new.status and sorts ahead of the guard by
-- name — the shape of any normalizer, stamp or audit hook a later migration adds.
-- The statement never names status, so `before update of status` would not fire at
-- all and a terminal 'completed' contract would re-open to 'active'. Everything
-- here is rolled back by REPLAY_ROLLBACK, DDL included.
do $$
declare
  v_st      text := '00000';
  v_msg     text := '';
  v_status  text;
  v_left    int;
begin
  begin
    update public.contracts set status = 'completed'
     where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';

    create function public.replay_status_normalizer() returns trigger
    language plpgsql as $fn$
    begin
      new.status := 'active';
      return new;
    end
    $fn$;
    create trigger aaa_replay_status_normalizer
      before update on public.contracts
      for each row execute function public.replay_status_normalizer();

    begin
      -- status is not in the target list; the normalizer puts it there.
      update public.contracts set party_a_name = party_a_name
       where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';
    exception when others then v_st := sqlstate; v_msg := sqlerrm;
    end;

    select status into v_status from public.contracts
     where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  select count(*) into v_left from pg_trigger
   where tgrelid = 'public.contracts'::regclass
     and tgname = 'aaa_replay_status_normalizer';

  perform pg_temp.assert(v_st = '22023'
                         and v_msg like '%active is not a permitted transition from completed%',
                         'money-transition-guard-fires-when-the-writer-never-names-status');
  perform pg_temp.assert(v_status = 'completed',
                         'money-transition-guard-left-the-terminal-contract-terminal');
  perform pg_temp.assert(v_left = 0
                         and (select status = 'active' from public.contracts
                              where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4'),
                         'money-transition-normalizer-fixture-was-rolled-back');
end
$$;

-- And the same three answers as statements. The contract is moved to 'completed'
-- through the supported operation first, so the refusals below are refusals of a
-- real terminal state rather than of a fixture.
do $$
declare
  v_completed   text;
  v_revoke_st   text := '00000';
  v_revoke_msg  text := '';
  v_term_st     text := '00000';
  v_direct_st   text := '00000';
  v_direct_msg  text := '';
  v_final       text;
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.set_contract_status('c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4', 'completed', null);
    reset role;
    select status into v_completed from public.contracts
     where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';

    -- The reproduced defect, as a call.
    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      perform public.revoke_contract('c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4', 'reopen it', false);
    exception when others then v_revoke_st := sqlstate; v_revoke_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      set local role authenticated;
      perform public.set_contract_status('c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4', 'terminated', 'because');
    exception when others then v_term_st := sqlstate;
    end;
    reset role;

    -- The writer that RLS never sees: no claims, no `authenticated` role — the
    -- shape of a service_role statement, a psql session or a future SECURITY
    -- DEFINER routine. trg_guard_contracts_write stands down for it, by design;
    -- the transition trigger does not.
    perform set_config('request.jwt.claims', '', true);
    begin
      update public.contracts set status = 'revoking'
       where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';
    exception when others then v_direct_st := sqlstate; v_direct_msg := sqlerrm;
    end;

    select status into v_final from public.contracts
     where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4';

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  perform pg_temp.assert(v_completed = 'completed',
                         'money-set-contract-status-completes-an-active-contract-for-a-manager');
  perform pg_temp.assert(v_revoke_st = '22023'
                         and v_revoke_msg like '%a completed contract cannot be moved to revoking%',
                         'money-revoke-contract-refuses-a-completed-contract');
  perform pg_temp.assert(v_term_st = '22023',
                         'money-set-contract-status-refuses-to-leave-a-terminal-status');
  perform pg_temp.assert(v_direct_st = '22023'
                         and v_direct_msg like '%revoking is not a permitted transition from completed%',
                         'money-transition-trigger-refuses-an-illegal-transition-from-a-trusted-writer');
  perform pg_temp.assert(v_final = 'completed',
                         'money-transition-refusals-left-the-contract-completed');
  perform pg_temp.assert((select status = 'active' from public.contracts
                          where id = 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4'),
                         'money-transition-fixture-was-rolled-back');
end
$$;

-- ---------------------------------------------------------------------------
-- K6 · the session boundary reaches the SECURITY DEFINER surface  (P0-1)
-- ---------------------------------------------------------------------------
-- The round-3 P0. 20260813000000 put the revocation boundary in RLS policies,
-- and RLS does not apply inside a SECURITY DEFINER routine — so a deactivated,
-- banned or password-changed identity holding a still-valid access token could
-- still confirm a payment, approve a contract or convert a quotation, because
-- every one of those is definer. Triggers, unlike policies, DO fire inside a
-- definer routine, so the boundary is now a BEFORE ... FOR EACH STATEMENT
-- trigger on every ordinary table in `public`, plus an explicit
-- assert_current_session() at the top of money_actor().
--
-- Coverage is computed, not listed: a table added by a later migration cannot
-- quietly fall outside it, and the statement-level shape matters — a row-level
-- trigger would not fire at all for a statement that matches no rows, which is
-- exactly the case an identity with no profile row produces.
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
          -- BEFORE (2) | INSERT (4) | DELETE (8) | UPDATE (16), statement-level
          -- (the ROW bit, 1, unset).
          and t.tgtype = 30
          and t.tgenabled = 'O');

  if array_length(v_missing, 1) > 0 then
    raise notice 'public tables with no session write boundary: %', v_missing;
  end if;
  -- Not vacuous: the floor has tables, and so does production.
  perform pg_temp.assert(v_tables >= 10, 'session-write-boundary-had-tables-to-cover');
  -- The uncovered names are a notice and the verdict is an assertion, so
  -- MODE=control records this by name instead of as an unclassified SQL error.
  perform pg_temp.assert(coalesce(array_length(v_missing, 1), 0) = 0,
                         'session-write-boundary-covers-every-public-table');
end
$$;

select pg_temp.assert_eval($q$
  (select prosecdef and proconfig @> array['search_path=pg_catalog, public, pg_temp']
  from pg_proc where oid = to_regprocedure('public.assert_current_session()'))
$q$, 'session-assert-current-session-is-definer-with-pinned-search-path');
select pg_temp.assert_eval($q$
  not (has_function_privilege('anon', to_regprocedure('public.assert_current_session()'), 'execute')
  or has_function_privilege('anon', to_regprocedure('public.session_boundary_state()'), 'execute'))
$q$, 'session-boundary-verdict-not-executable-by-anon');

-- The positive control, and it is load-bearing: every refusal below has to be
-- distinguishable from "this never worked". A current session reaches PAST the
-- boundary on both surfaces — the definer routine answers with the refusal that
-- belongs to the QUOTATION (22023, still a draft), and the ordinary-table write
-- goes through.
do $$
declare
  v_verdict text;
  v_rpc     text := '00000';
  v_rows    int  := 0;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_verdict := public.session_boundary_state();
    begin
      perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
    exception when others then v_rpc := sqlstate;
    end;
    update public.profiles set last_active_at = now()
     where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    get diagnostics v_rows = row_count;
    reset role;
    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then
        reset role;
        perform pg_temp.absorb(sqlstate, sqlerrm);
      end if;
  end;
  perform pg_temp.assert(v_verdict = 'ok', 'session-boundary-verdict-is-ok-for-a-current-session');
  perform pg_temp.assert(v_rpc = '22023',
                         'session-current-session-reaches-past-the-boundary-on-a-definer-rpc');
  perform pg_temp.assert(v_rows = 1,
                         'session-current-session-reaches-past-the-boundary-on-an-ordinary-table');
end
$$;

-- Now the four refusals, each proved on BOTH surfaces and each carrying its own
-- SQLSTATE, because src/lib/money-rpc.mjs turns class 28 into a 401 that names
-- the reason: a generic 42501 would tell the user to ask for a permission when
-- what they need is to sign in again.
--
-- The definer probe is convert_quotation_to_contract() on a DRAFT quotation the
-- caller owns: with a current session it fails with 22023 (asserted just above),
-- so a class-28 answer here can only have come from the session boundary, and
-- either way nothing is written.

-- 28005 · a validly signed token minted before the password changed.
do $$
declare v_rpc text := '00000'; v_rpc_msg text := ''; v_tbl text := '00000';
begin
  begin
    update public.profiles set password_changed_at = now()
     where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc', -interval '1 hour');
      set local role authenticated;
      perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
    exception when others then v_rpc := sqlstate; v_rpc_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc', -interval '1 hour');
      set local role authenticated;
      update public.profiles set last_active_at = now()
       where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    exception when others then v_tbl := sqlstate;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_rpc = '28005' and v_rpc_msg like '%predates the last credential change%',
                         'session-stale-token-refused-by-a-definer-money-rpc');
  perform pg_temp.assert(v_tbl = '28005', 'session-stale-token-refused-on-an-ordinary-table-write');
end
$$;

-- 28006 · the forced password change, which is P1-3: the admin reset paths write
-- profiles.force_password_change and nothing enforced it, so the reset was
-- advisory. /api/auth/change-password authenticates through GoTrue and writes
-- with the service key, so it keeps working; everything else stops.
do $$
declare v_rpc text := '00000'; v_rpc_msg text := ''; v_tbl text := '00000';
begin
  begin
    update public.profiles set force_password_change = true
     where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
    exception when others then v_rpc := sqlstate; v_rpc_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.profiles set last_active_at = now()
       where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    exception when others then v_tbl := sqlstate;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_rpc = '28006' and v_rpc_msg like '%password change is required%',
                         'session-forced-password-change-refused-by-a-definer-money-rpc');
  perform pg_temp.assert(v_tbl = '28006',
                         'session-forced-password-change-refused-on-an-ordinary-table-write');
end
$$;

-- 28004 · the Auth ban. This is the F-02 boundary: banning an identity in Auth
-- has to stop the tokens it already issued, not just the next login.
do $$
declare v_rpc text := '00000'; v_rpc_msg text := ''; v_tbl text := '00000';
begin
  begin
    update auth.users set banned_until = now() + interval '1 day'
     where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
    exception when others then v_rpc := sqlstate; v_rpc_msg := sqlerrm;
    end;
    reset role;

    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      update public.profiles set last_active_at = now()
       where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    exception when others then v_tbl := sqlstate;
    end;
    reset role;

    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_rpc = '28004' and v_rpc_msg like '%this identity is banned%',
                         'session-banned-identity-refused-by-a-definer-money-rpc');
  perform pg_temp.assert(v_tbl = '28004',
                         'session-banned-identity-refused-on-an-ordinary-table-write');
end
$$;

-- 28003 · deactivation, on the definer surface. (The ordinary-table half is
-- asserted in the previous section as
-- session-inactive-identity-cannot-write-its-own-profile, and the money_actor
-- half as money-actor-refuses-inactive-account.) No fixture is needed: the F-02
-- migration deactivates dev@newme.ae, which is the account the finding is about.
do $$
declare v_rpc text := '00000'; v_rpc_msg text := '';
begin
  begin
    perform pg_temp.act_as('dddddddd-dddd-dddd-dddd-dddddddddddd');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
  exception when others then v_rpc := sqlstate; v_rpc_msg := sqlerrm;
  end;
  reset role;
  perform pg_temp.assert(v_rpc = '28003' and v_rpc_msg like '%this account is deactivated%',
                         'session-deactivated-identity-refused-by-a-definer-money-rpc');
end
$$;

-- 28002 · a token whose subject has no profile row. The statement-level shape of
-- the trigger is what makes this observable at all: the UPDATE below matches no
-- rows, so a FOR EACH ROW trigger would never fire and the statement would
-- report success having written nothing.
do $$
declare v_rpc text := '00000'; v_rpc_msg text := ''; v_tbl text := '00000';
begin
  begin
    perform pg_temp.act_as('00000000-0000-0000-0000-0000000000fe');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '{}'::jsonb);
  exception when others then v_rpc := sqlstate; v_rpc_msg := sqlerrm;
  end;
  reset role;

  begin
    perform pg_temp.act_as('00000000-0000-0000-0000-0000000000fe');
    set local role authenticated;
    update public.profiles set last_active_at = now()
     where id = '00000000-0000-0000-0000-0000000000fe';
  exception when others then v_tbl := sqlstate;
  end;
  reset role;

  perform pg_temp.assert(v_rpc = '28002' and v_rpc_msg like '%this session has no profile%',
                         'session-identity-without-a-profile-refused-by-a-definer-money-rpc');
  perform pg_temp.assert(v_tbl = '28002',
                         'session-identity-without-a-profile-refused-on-a-zero-row-statement');
end
$$;

-- 28001 · and the one state the trigger deliberately does not raise. A statement
-- carrying no end-user identity is a trusted server path — a service_role token
-- has no `sub` and psql has no request settings — so require_current_session()
-- lets it through. assert_current_session() itself must still refuse it, because
-- money_actor() calls it on the path where a subject WAS expected.
do $$
declare v_state text := '00000'; v_verdict text;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    v_verdict := public.session_boundary_state();
  exception when others then perform pg_temp.absorb(sqlstate, sqlerrm);
  end;
  begin
    perform public.assert_current_session();
  exception when others then v_state := sqlstate;
  end;
  perform pg_temp.assert(v_verdict = 'no_session', 'session-boundary-verdict-is-no-session-without-claims');
  perform pg_temp.assert(v_state = '28001', 'session-assert-refuses-a-request-with-no-identity');
end
$$;

-- ---------------------------------------------------------------------------
-- K7 · the two role holes: no role at all, and 'operator' on the money surface
--      (P1-1, P1-9)
-- ---------------------------------------------------------------------------
-- P1-1: profiles.role is nullable, and money_actor() rejected a role with
-- `not (v_role = any (p_allowed_roles))`. For a NULL role that expression is NULL,
-- not true, so the `if not (...) then raise` never fired and a profile with no role
-- was accepted for every money operation. The fix is its own refusal, before the
-- membership test can be reached with a NULL left-hand side, and the review asked
-- for it to be tested across every money RPC — so all eight are probed here, not a
-- representative one.
--
-- P1-9: confirm_payment() and allocate_payment() allowed 'operator' while the
-- routes, the server actions and the RBAC headers all said admin/boss/finance, and
-- an operator session really did confirm and allocate through the RPC. The rule
-- kept is the documented one; the routines were narrowed to it.
--
-- Every probe below states the boundary that refused it, not just the SQLSTATE:
-- 'actor has no role and may not perform this operation' and 'role operator may
-- not perform this operation' are distinct messages from distinct branches, and a
-- generic 42501 (an RLS refusal, an ownership refusal, a missing grant) does not
-- satisfy these assertions. Each probe runs inside a REPLAY_ROLLBACK envelope,
-- because against the un-remediated floor several of these calls SUCCEED — that is
-- the finding — and a control run must not carry their writes into later
-- assertions.
create or replace function pg_temp.refused_with(p_state text, p_msg text, p_needle text)
returns boolean
language sql
as $$ select p_state = '42501' and p_msg like '%' || p_needle || '%' $$;

-- The money row signature. Both blocks below take it after their setup and again
-- after their refusals, so "nothing moved" is a comparison rather than a claim.
-- Only columns the un-remediated floor also has are read: voided_at is new in this
-- release, and reading it here would make the control run fail on a missing column
-- instead of on the role hole it is supposed to expose.
create or replace function pg_temp.money_row_signature()
returns text
language sql
as $$
  select format('contracts=%s payments=%s confirmed=%s allocations=%s approvals=%s plans=%s',
    (select count(*) from public.contracts),
    (select count(*) from public.payments),
    (select count(*) from public.payments where confirmed),
    (select count(*) from public.payment_allocations),
    (select count(*) from public.contract_approvals),
    (select count(*) from public.installment_plans))
$$;

select pg_temp.assert_eval($q$
  (select is_active and role is null
     from public.profiles where id = '0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b')
$q$, 'money-roleless-fixture-is-active-with-no-role');
select pg_temp.assert_eval($q$
  (select is_active and role = 'operator'
     from public.profiles where id = '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a')
$q$, 'money-operator-fixture-is-active-with-the-operator-role');

-- All eight money RPCs an authenticated session can call. What each probe claims is
-- not "this request was otherwise valid" but "this request reached money_actor()
-- and money_actor() is what turned it away", which is why every one of them matches
-- the message and not just the sqlstate.
--
-- Two of the eight decide something before they decide the role: set_contract_status()
-- and approve_contract() load the contract first and answer 'contract not found'
-- (P0002) for an unknown id, and approve_contract() picks which role list applies
-- from the contract's status — 'pending_admin' means admin|operator, 'pending_ceo'
-- means boss, and anything else is refused as not awaiting approval before a role is
-- ever considered. So these probes need a contract that really is awaiting admin
-- review, and C1 is already 'approved' by section F. The setup below builds one
-- through the permitted path — an admin creates it, an admin submits it — rather
-- than writing contracts.status directly, which the transition trigger refuses.
-- Whether the setup worked is its own assertion: a refusal that came from
-- 'contract not found' carries a different sqlstate but would still be a refusal,
-- and vacuity here would be invisible without saying so out loud.
do $$
declare
  v_state    text[] := '{}';
  v_msg      text[] := '{}';
  v_setup    uuid   := null;
  v_pending  boolean := false;
  v_before   text   := null;
  v_after    text   := null;
  v_needle   text   := 'has no role and may not perform this operation';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      v_setup := (public.create_contract(jsonb_build_object(
        'lead_id',      '0c0c0c0c-0c0c-0c0c-0c0c-0c0c0c0c0c0c',
        'amount',       100000,
        'party_a_name', 'Replay party A',
        -- B4: a schedule that adds up, because this is a setup call that must
        -- succeed; the named assertion below is what fails if it does not.
        'installments', jsonb_build_array(
          jsonb_build_object('seq', '1', 'amount', 40000),
          jsonb_build_object('seq', '2', 'amount', 60000)))) ->> 'id')::uuid;
      perform public.set_contract_status(v_setup, 'pending_admin', 'replay K7 setup');
    exception when others then v_setup := null;
    end;
    reset role;
    select status = 'pending_admin' into v_pending
      from public.contracts where id = v_setup;
    v_before := pg_temp.money_row_signature();

    perform pg_temp.act_as('0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b');
    set local role authenticated;

    begin
      perform public.confirm_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
                                     '0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.allocate_payment('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2',
        '[{"plan_id": "91111111-1111-1111-1111-111111111111", "amount": 10000}]'::jsonb,
        '0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.void_payment('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'replay role probe');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
        'amount',       100000,
        'party_a_name', 'Replay party A'));
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.approve_contract(v_setup, '0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b', 'approve');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.convert_quotation_to_contract('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', '{}'::jsonb);
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.set_contract_status(v_setup, 'pending_admin', 'replay role probe');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.revoke_contract(v_setup, 'replay role probe');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;

    -- After reset role on purpose: the read must not run as `authenticated`, or an
    -- RLS policy could hide a row a refused call actually wrote and turn the
    -- comparison into two equal, equally blind counts.
    reset role;
    v_after := pg_temp.money_row_signature();
    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then
        reset role;
        perform pg_temp.absorb(sqlstate, sqlerrm);
      end if;
  end;

  perform pg_temp.assert(v_pending,
                         'money-roleless-probe-setup-produced-a-contract-awaiting-approval');
  perform pg_temp.assert(pg_temp.refused_with(v_state[1], v_msg[1], v_needle),
                         'money-roleless-refused-by-confirm-payment');
  perform pg_temp.assert(pg_temp.refused_with(v_state[2], v_msg[2], v_needle),
                         'money-roleless-refused-by-allocate-payment');
  perform pg_temp.assert(pg_temp.refused_with(v_state[3], v_msg[3], v_needle),
                         'money-roleless-refused-by-void-payment');
  perform pg_temp.assert(pg_temp.refused_with(v_state[4], v_msg[4], v_needle),
                         'money-roleless-refused-by-create-contract');
  perform pg_temp.assert(pg_temp.refused_with(v_state[5], v_msg[5], v_needle),
                         'money-roleless-refused-by-approve-contract');
  perform pg_temp.assert(pg_temp.refused_with(v_state[6], v_msg[6], v_needle),
                         'money-roleless-refused-by-convert-quotation');
  perform pg_temp.assert(pg_temp.refused_with(v_state[7], v_msg[7], v_needle),
                         'money-roleless-refused-by-set-contract-status');
  perform pg_temp.assert(pg_temp.refused_with(v_state[8], v_msg[8], v_needle),
                         'money-roleless-refused-by-revoke-contract');
  perform pg_temp.assert(v_before is not null and v_after = v_before,
                         'money-roleless-refusals-changed-no-money-rows');
end
$$;

-- The operator, on the surface the documented rule reserves for admin, boss and
-- finance — and then on the surface the product rule really does give them.
do $$
declare
  v_state   text[] := '{}';
  v_msg     text[] := '{}';
  v_setup   uuid   := null;
  v_pending boolean := false;
  v_before  text   := null;
  v_after   text   := null;
  v_approve text   := '00000';
  v_moved   text   := null;
  v_needle  text   := 'role operator may not perform this operation';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      v_setup := (public.create_contract(jsonb_build_object(
        'lead_id',      '0c0c0c0c-0c0c-0c0c-0c0c-0c0c0c0c0c0c',
        'amount',       100000,
        'party_a_name', 'Replay party A',
        -- B4: a schedule that adds up, because this is a setup call that must
        -- succeed; the named assertion below is what fails if it does not.
        'installments', jsonb_build_array(
          jsonb_build_object('seq', '1', 'amount', 40000),
          jsonb_build_object('seq', '2', 'amount', 60000)))) ->> 'id')::uuid;
      perform public.set_contract_status(v_setup, 'pending_admin', 'replay K7 setup');
    exception when others then v_setup := null;
    end;
    reset role;
    select status = 'pending_admin' into v_pending
      from public.contracts where id = v_setup;
    v_before := pg_temp.money_row_signature();

    perform pg_temp.act_as('0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a');
    set local role authenticated;

    begin
      perform public.confirm_payment('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
                                     '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.allocate_payment('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2',
        '[{"plan_id": "91111111-1111-1111-1111-111111111111", "amount": 10000}]'::jsonb,
        '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;
    begin
      perform public.void_payment('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'replay role probe');
      v_state := v_state || '00000'; v_msg := v_msg || 'not refused at all';
    exception when others then v_state := v_state || sqlstate; v_msg := v_msg || sqlerrm;
    end;

    reset role;
    v_after := pg_temp.money_row_signature();

    -- The positive control, and it has to come after the comparison because it is
    -- the one call that is supposed to change something. The setup contract is
    -- pending_admin, whose step is admin_review, and the product rule for that step
    -- is admin OR operator. Without this, the three refusals above would prove
    -- nothing about the settlement rule — they could just mean "an operator can do
    -- nothing".
    --
    -- The resulting status is read, not just the absence of an error: the
    -- pre-remediation approve_contract() returns success for a contract id that
    -- matches no row, so "did not raise" is a verdict the floor can satisfy while
    -- approving nothing.
    perform pg_temp.act_as('0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a');
    set local role authenticated;
    begin
      perform public.approve_contract(v_setup, '0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'approve');
    exception when others then v_approve := sqlstate || ' ' || sqlerrm;
    end;

    reset role;
    select status into v_moved from public.contracts where id = v_setup;
    raise exception 'REPLAY_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'REPLAY_ROLLBACK' then
        reset role;
        perform pg_temp.absorb(sqlstate, sqlerrm);
      end if;
  end;

  perform pg_temp.assert(v_pending,
                         'money-operator-probe-setup-produced-a-contract-awaiting-approval');
  perform pg_temp.assert(pg_temp.refused_with(v_state[1], v_msg[1], v_needle),
                         'money-operator-refused-by-confirm-payment');
  perform pg_temp.assert(pg_temp.refused_with(v_state[2], v_msg[2], v_needle),
                         'money-operator-refused-by-allocate-payment');
  perform pg_temp.assert(pg_temp.refused_with(v_state[3], v_msg[3], v_needle),
                         'money-operator-refused-by-void-payment');
  perform pg_temp.assert(v_before is not null and v_after = v_before,
                         'money-operator-refusals-changed-no-money-rows');
  perform pg_temp.assert(v_approve = '00000' and v_moved = 'pending_ceo',
                         'money-operator-still-approves-where-the-product-rule-allows-it');
end
$$;

-- ============================================================================
-- A1 · The session boundary at SECURITY DEFINER entry
--     (20260816000000_l0_round4_definer_entry_boundary.sql)
-- ============================================================================
-- Round 3 put the boundary on table statements. Round 4 found that a routine
-- which answers WITHOUT issuing a statement never reaches it. Measured against
-- this exact floor before the migration existed, record_lead_note_atomic() on its
-- idempotent-replay branch returned `idempotent_replay: true` to a deactivated,
-- a banned, a stale-token and a forced-password-change session, and its error
-- branch told a forced session whether an arbitrary lead id exists (P0001
-- LEAD_NOT_FOUND). Both are below, as the states they must now refuse.
--
-- Two kinds of assertion, because either alone is worth little. The catalog ones
-- say every definer routine installed HERE carries the guard, which is the claim
-- that has to hold in production where routines this repo never declared also
-- live. The behaviour ones execute all three branches of the routine the finding
-- names, because "the text contains a PERFORM" is not the same as "the request
-- was refused".
-- ----------------------------------------------------------------------------

select pg_temp.assert_eval($q$ to_regprocedure('public.assert_current_session_at_entry()') is not null $q$,
  'a1-entry-guard-function-exists');

select pg_temp.assert_eval($q$ (select p.prosecdef and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%'
    from pg_proc p where p.oid = to_regprocedure('public.assert_current_session_at_entry()')) $q$,
  'a1-entry-guard-is-security-definer-with-a-pinned-search-path');

-- The gate itself. Deliberately not restricted to plpgsql: a `sql`-language
-- definer function cannot be given a PERFORM, so if this query carried the
-- transform's language filter, adding one would create an uncovered routine that
-- the gate still called covered.
select pg_temp.assert_eval($q$ (select count(*) = 0
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
     and p.oid::regprocedure::text not in (select routine from public.definer_entry_boundary_exemptions)
     and (l.lanname <> 'plpgsql'
          or p.prosrc !~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);')) $q$,
  'a1-every-definer-routine-asserts-the-session-at-entry');

-- A gate that covers nothing passes trivially. The floor plus this branch install
-- fourteen; ten is a floor low enough to survive a legitimate refactor and high
-- enough that an empty transform fails here.
select pg_temp.assert_eval($q$ (select count(*) >= 10
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
   where n.nspname = 'public' and p.prosecdef and l.lanname = 'plpgsql'
     and p.prorettype <> 'trigger'::regtype
     and p.prosrc ~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);') $q$,
  'a1-entry-boundary-covered-a-plausible-number-of-routines');

-- Every exemption is the boundary's own machinery or an RLS predicate that must
-- return a verdict rather than raise. An exemption with no stated reason is how
-- the next routine gets excused.
select pg_temp.assert_eval($q$ (select count(*) = 0 from public.definer_entry_boundary_exemptions
   where reason is null or char_length(btrim(reason)) < 30) $q$,
  'a1-entry-boundary-exemptions-each-carry-a-reason');

select pg_temp.assert_eval($q$ (select count(*) = 1
    from public.definer_entry_boundary_exemptions e
    join pg_proc p on p.oid = to_regprocedure('public.get_my_role()')
   where e.routine = 'get_my_role()'
     and p.prosrc like '%session_boundary_state()%'
     and p.prosrc not like '%assert_current_session_at_entry()%') $q$,
  'a1-get-my-role-is-an-rls-safe-exemption');

select pg_temp.assert_eval($q$ (select count(*) between 1 and 8 from public.definer_entry_boundary_exemptions) $q$,
  'a1-entry-boundary-exemption-list-is-short');

select pg_temp.assert_eval($q$ not (
       has_table_privilege('authenticated', 'public.definer_entry_boundary_exemptions', 'select')
    or has_table_privilege('authenticated', 'public.definer_entry_boundary_exemptions', 'insert')
    or has_table_privilege('anon',          'public.definer_entry_boundary_exemptions', 'select')) $q$,
  'a1-entry-boundary-exemption-table-is-unreachable-by-end-user-roles');

-- A trigger function holds EXECUTE only because CREATE FUNCTION grants it to
-- PUBLIC. Held, it lets a session evaluate a money guard outside any trigger
-- context; taken back, nothing changes, because the trigger machinery does not
-- consult it. None of the sixteen RPC names src/ calls is a trigger function.
-- This one also passes on the un-remediated floor, which carries no trigger
-- function that an end-user role can reach — it is a regression guard for the
-- revoke, not a reproduction of the finding.
select pg_temp.assert_eval($q$ (select count(*) = 0 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
     and (has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('anon', p.oid, 'execute'))) $q$,
  'a1-trigger-functions-are-off-the-end-user-rpc-surface');

-- ----------------------------------------------------------------------------
-- The behaviour matrix: three branches × four revoked states, plus the control
-- case in each branch, because a boundary that refuses everyone is not a fix.
--
-- Each probe is one subtransaction containing both the state change that sets it
-- up and the call. Whichever way it ends — the routine refuses, the routine
-- serves and REPLAY_ROLLBACK is raised deliberately, or the setup itself cannot
-- run on this floor — the subtransaction aborts and the profile and auth rows are
-- restored without a restore statement that could fail on its own.
--
-- The default state '00000' means "the request was served". It is what an
-- unmeasurable probe also reports, so no probe can pass by not running, and the
-- unmeasurable case is separately narrated through absorb(): fatal in
-- MODE=branch, a recorded ASSERT_UNMEASURABLE in MODE=control.
-- ----------------------------------------------------------------------------
do $$
declare
  v_actor      uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  v_lead       uuid := '22222222-2222-2222-2222-222222222222';
  v_replay_key uuid := 'aaaa1111-2222-3333-4444-555566667777';
  v_missing    uuid := '00000000-0000-0000-0000-0000000000ff';
  v_state      text[] := array['00000','00000','00000','00000','00000','00000','00000'];
  v_msg        text[] := array['','','','','','',''];
  v_replayed   boolean := false;
  v_wrote      boolean := false;
  v_leaked     bigint  := 0;
  v_out        jsonb;
begin
  -- 1 · deactivated, on the idempotent-replay branch (the reproduced hole)
  begin
    update public.profiles set is_active = false where id = v_actor;
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.record_lead_note_atomic(v_lead, 'replayed note', v_replay_key);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state[1] := sqlstate; v_msg[1] := sqlerrm;
      if left(sqlstate, 2) <> '28' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
    end if;
  end;

  -- 2 · deactivated, on the normal branch: the same state, the writing path. The
  -- row count is taken inside the subtransaction, before it aborts, so "served"
  -- is distinguishable from "refused" by its effect and not only by its SQLSTATE.
  begin
    update public.profiles set is_active = false where id = v_actor;
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.record_lead_note_atomic(v_lead, 'a fresh note from a revoked session', gen_random_uuid());
    reset role;
    select count(*) into v_leaked from public.follow_up_logs
     where summary = 'a fresh note from a revoked session';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state[5] := sqlstate; v_msg[5] := sqlerrm;
      if left(sqlstate, 2) <> '28' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
    end if;
  end;

  -- 3 · banned
  begin
    update auth.users set banned_until = now() + interval '1 day' where id = v_actor;
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.record_lead_note_atomic(v_lead, 'replayed note', v_replay_key);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state[2] := sqlstate; v_msg[2] := sqlerrm;
      if left(sqlstate, 2) <> '28' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
    end if;
  end;

  -- 4 · a token older than the last password change
  begin
    update public.profiles set password_changed_at = now() where id = v_actor;
    perform pg_temp.act_as(v_actor, interval '-10 minutes');
    set local role authenticated;
    perform public.record_lead_note_atomic(v_lead, 'replayed note', v_replay_key);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state[3] := sqlstate; v_msg[3] := sqlerrm;
      if left(sqlstate, 2) <> '28' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
    end if;
  end;

  -- 5 · a password change is required
  begin
    update public.profiles set force_password_change = true where id = v_actor;
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.record_lead_note_atomic(v_lead, 'replayed note', v_replay_key);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state[4] := sqlstate; v_msg[4] := sqlerrm;
      if left(sqlstate, 2) <> '28' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
    end if;
  end;

  -- 6 · the error branch, in the same forced state. Before the fix this reported
  -- P0001 LEAD_NOT_FOUND, which tells a revoked session whether a lead exists.
  begin
    update public.profiles set force_password_change = true where id = v_actor;
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.record_lead_note_atomic(v_missing, 'note on a missing lead', gen_random_uuid());
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state[6] := sqlstate; v_msg[6] := sqlerrm;
      if left(sqlstate, 2) <> '28' and sqlstate <> 'P0001' then
        perform pg_temp.absorb(sqlstate, sqlerrm);
      end if;
    end if;
  end;

  -- 7 · the control cases. A current session must be untouched on every branch,
  -- and these are NOT rolled back: the write is the evidence.
  begin
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    v_out := public.record_lead_note_atomic(v_lead, 'replayed note', v_replay_key);
    v_replayed := coalesce((v_out ->> 'idempotent_replay')::boolean, false);
    v_out := public.record_lead_note_atomic(v_lead, 'a genuinely new note', gen_random_uuid());
    v_wrote := (v_out ? 'note_id') and (v_out ->> 'idempotent_replay') is null;
    reset role;
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    perform pg_temp.absorb(sqlstate, sqlerrm);
  end;

  -- 8 · and the error branch still reports the business error to a live session.
  begin
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.record_lead_note_atomic(v_missing, 'note on a missing lead', gen_random_uuid());
    reset role;
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    v_state[7] := sqlstate; v_msg[7] := sqlerrm;
  end;

  perform pg_temp.assert(v_state[1] = '28003',
    'a1-idempotent-replay-branch-refuses-a-deactivated-session');
  perform pg_temp.assert(v_state[2] = '28004',
    'a1-idempotent-replay-branch-refuses-a-banned-session');
  perform pg_temp.assert(v_state[3] = '28005',
    'a1-idempotent-replay-branch-refuses-a-stale-token-session');
  perform pg_temp.assert(v_state[4] = '28006',
    'a1-idempotent-replay-branch-refuses-a-forced-password-change-session');
  perform pg_temp.assert(v_state[5] = '28003',
    'a1-normal-branch-refuses-a-deactivated-session');
  perform pg_temp.assert(v_leaked = 0,
    'a1-a-refused-normal-branch-request-wrote-no-follow-up-log-row');
  perform pg_temp.assert(v_state[6] = '28006' and v_msg[6] not like '%LEAD_NOT_FOUND%',
    'a1-error-branch-refuses-before-it-reports-whether-the-lead-exists');
  perform pg_temp.assert(v_state[7] = 'P0001' and v_msg[7] like '%LEAD_NOT_FOUND%',
    'a1-error-branch-still-reports-lead-not-found-to-a-current-session');
  perform pg_temp.assert(v_replayed,
    'a1-idempotent-replay-branch-still-serves-a-current-session');
  perform pg_temp.assert(v_wrote,
    'a1-normal-branch-still-writes-for-a-current-session');
end
$$;

-- One routine proves the branch; the guard has to be general. next_quote_no()
-- shares nothing with the lead routines but the boundary.
do $$
declare
  v_actor uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  v_state text := '00000';
  v_live  text := '';
begin
  begin
    update public.profiles set is_active = false where id = v_actor;
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    perform public.next_quote_no();
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      if left(sqlstate, 2) <> '28' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
    end if;
  end;

  begin
    perform pg_temp.act_as(v_actor);
    set local role authenticated;
    v_live := public.next_quote_no();
    reset role;
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    perform pg_temp.absorb(sqlstate, sqlerrm);
  end;

  perform pg_temp.assert(v_state = '28003',
    'a1-a-second-unrelated-definer-routine-also-refuses-at-entry');
  perform pg_temp.assert(v_live <> '',
    'a1-that-second-routine-still-answers-a-current-session');
end
$$;

-- ============================================================================
-- B2 · B3 · B4 · B5 · B6 · B7 · B10 — money and business integrity
--     (20260817000000_l0_round4_money_and_business_integrity.sql)
-- ============================================================================
-- Every assertion below was reproduced first, against this exact floor plus the
-- twelve branch migrations that precede the file, with the file itself moved
-- aside. The measured pre-fix behaviour, one line per finding:
--
--   B2a  update contracts set first_payment_status = 'paid'  →  00000, value 'paid'
--   B2b  allocate the whole first installment  →  plan 'paid', contract 'unpaid'
--   B3a  a payment of -100.00, then confirmed  →  the collection KPI fell to 39900
--   B3b  the same creation request twice       →  two rows of 7000.00
--   B4a  create_contract with installments []  →  a contract with no schedule
--   B4b  a 40000 schedule on a 100000 contract →  accepted
--   B5w  the owner repoints quotations.contract_id at a foreign contract → 1 row
--   B5r  converting on that crossed link  →  an approval and an activity written
--                                            against the other salesperson's contract
--   B6   converting an accepted quotation →  no customer, leads.customer_id NULL,
--                                           no 'won' event, project.customer_id NULL
--   B7a  saving the period's targets unchanged  →  60000.00 collected became 0.00
--   B7b  reassign the contract, then void       →  the credit debited from the new
--                                                  owner, the real creditor untouched
--   B7c  a replacement set that drops a pair holding 12345.00 → the row deleted
--   B10  a 79999.99 schedule against an 80000.00 quotation  →  accepted
--
-- The same probes on the same database with the file applied return 42501, 22023,
-- 23514, 23505 or the corrected value, and each one is an assertion here.
--
-- Two shapes, for the reason the A1 section gives: the catalog and data assertions
-- state the invariant the whole table has to satisfy — including rows this repo
-- never created — and the behaviour probes execute the actual statement, because a
-- constraint that exists is not the same as a request that was refused.
--
-- The behaviour probes share one structure, and it is worth reading once:
--
--     begin                          -- the envelope
--       begin                        -- the call under test
--         <statement or routine call>
--       exception when others then v_state := sqlstate; v_msg := sqlerrm;
--       end;
--       reset role;                  -- measure with full visibility, not the
--       <take every measurement>     --   session's, so "nothing was written" is
--       raise exception 'REPLAY_ROLLBACK';  --   a reading and not an RLS artefact
--     exception when others then
--       if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(...); end if;
--     end;
--     perform pg_temp.assert(...);   -- outside, or assert_log rolls back with it
--
-- Two nested subtransactions, not one, and that is the point. The inner one
-- absorbs the refusal so the measurement AFTER it is still reachable: a probe that
-- only wrapped the call could never tell a refusal that left nothing behind from a
-- refusal that left half a contract, because its own rollback would have cleaned
-- up either way. The outer one hands the fixtures to the next probe — and to the
-- rollback companions — in the state 05_seed_behaviour_fixtures.sql left them, in
-- MODE=control too, where the floor accepts what the release refuses.
--
-- The default '00000' means "the request was served", which is also what an
-- unmeasurable probe reports, so no probe can pass by not running. States that
-- neither the floor nor the release can explain reach absorb(): fatal in
-- MODE=branch, a recorded ASSERT_UNMEASURABLE in MODE=control.
-- ----------------------------------------------------------------------------

-- ── B3 · the constraints, and that nothing survived them ────────────────────
select pg_temp.assert_eval($q$ (select count(*) = 1 from pg_constraint
   where conrelid = 'public.payments'::regclass and conname = 'payments_amount_positive'
     and contype = 'c' and pg_get_constraintdef(oid) ilike '%amount > (0)%') $q$,
  'b3-a-payment-amount-must-be-positive');

select pg_temp.assert_eval($q$ (select count(*) = 1 from pg_constraint
   where conrelid = 'public.payment_allocations'::regclass
     and conname = 'payment_allocations_amount_positive'
     and contype = 'c' and pg_get_constraintdef(oid) ilike '%amount_allocated > (0)%') $q$,
  'b3-an-allocated-amount-must-be-positive');

select pg_temp.assert_eval($q$ (select count(*) = 1 from pg_constraint
   where conrelid = 'public.installment_plans'::regclass
     and conname = 'installment_plans_amount_positive'
     and contype = 'c' and pg_get_constraintdef(oid) ilike '%amount > (0)%') $q$,
  'b3-an-installment-amount-must-be-positive');

-- A data invariant, and one of the few assertions here that passes against the
-- pre-fix release too — measured: it does. That is not a weakness, it is what the
-- assertion is for. The fixtures contain no non-positive money row, so what this
-- can catch is not the finding but its regression: a grandfathered row surviving a
-- restore, or someone re-adding the constraints NOT VALID to get a migration
-- through. The refusal itself is measured by b3-a-negative-payment-is-refused.
select pg_temp.assert_eval($q$ (select count(*) = 0 from (
     select 1 from public.payments where amount <= 0
     union all select 1 from public.payment_allocations where amount_allocated <= 0
     union all select 1 from public.installment_plans where amount <= 0) s) $q$,
  'b3-no-non-positive-money-row-exists');

-- All three, and all three validated. Counting only the un-validated ones would be
-- satisfied by three constraints that do not exist: measured against the pre-fix
-- release, "no un-validated constraint" passed while there was nothing to validate.
select pg_temp.assert_eval($q$ (select count(*) = 3 and count(*) filter (where convalidated) = 3
    from pg_constraint
   where conrelid in ('public.payments'::regclass, 'public.payment_allocations'::regclass,
                      'public.installment_plans'::regclass)
     and contype = 'c'
     and conname in ('payments_amount_positive', 'payment_allocations_amount_positive',
                     'installment_plans_amount_positive')) $q$,
  'b3-the-positive-amount-constraints-are-validated');

-- Per creator and partial, so two people may legitimately hold the same key and
-- the historic rows that have none are not forced into one bucket.
select pg_temp.assert_eval($q$ (select count(*) = 1 from pg_indexes
   where schemaname = 'public' and tablename = 'payments' and indexname = 'idx_payments_request_key'
     and indexdef ilike '%unique%' and indexdef ilike '%(created_by, request_key)%'
     and indexdef ilike '%where (request_key is not null)%') $q$,
  'b3-a-request-key-is-unique-per-creator');

-- ── B2 · the derivation, and that the stored column agrees with it ──────────
select pg_temp.assert_eval($q$ (select not p.prosecdef and p.provolatile = 's'
    from pg_proc p where p.oid = to_regprocedure('public.contract_first_payment_status(uuid)')) $q$,
  'b2-the-first-payment-derivation-is-a-stable-invoker-function');

select pg_temp.assert_eval($q$ not has_function_privilege('anon',
    to_regprocedure('public.contract_first_payment_status(uuid)'), 'execute') $q$,
  'b2-the-first-payment-derivation-is-not-reachable-by-anon');

-- The reconciliation §3 performs, stated as an invariant rather than as a claim
-- about what the UPDATE touched. Every contract in the database, not the fixtures.
select pg_temp.assert_eval($q$ (select count(*) = 0 from public.contracts c
   where coalesce(c.first_payment_status, '') is distinct from public.contract_first_payment_status(c.id)) $q$,
  'b2-every-contract-agrees-with-the-derivation');

-- ── B4 / B10 · the validator ────────────────────────────────────────────────
select pg_temp.assert_eval($q$ (select not p.prosecdef and p.provolatile = 'i'
    from pg_proc p
   where p.oid = to_regprocedure('public.assert_installment_schedule(jsonb, numeric, text)')) $q$,
  'b4-the-schedule-validator-is-an-immutable-invoker-function');

-- ── B5 · the conversion link is guarded on the write side ───────────────────
select pg_temp.assert_eval($q$ (select count(*) = 1 from pg_trigger t
   where t.tgrelid = 'public.quotations'::regclass and t.tgname = 'trg_guard_quotations_write'
     and not t.tgisinternal and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
     and (t.tgtype & 16) = 16) $q$,
  'b5-a-before-update-row-guard-is-installed-on-quotations');

-- ── B6 · the finalizer ──────────────────────────────────────────────────────
select pg_temp.assert_eval($q$ (select p.prosecdef
    from pg_proc p
   where p.oid = to_regprocedure('public.finalize_lead_won(uuid, numeric, uuid, text, jsonb)')) $q$,
  'b6-the-lead-won-finalizer-exists-and-is-security-definer');

-- It takes a lead id and decides nothing about who may finalise that lead; its two
-- callers do, each after locking the lead and checking ownership. Reachable as an
-- RPC it would let any session declare an arbitrary lead won, create its customer
-- and write its 'won' event under the definer's rights — and the entry assertion
-- 20260816000000 adds would not stop that, because a current session is still a
-- session.
select pg_temp.assert_eval($q$ not (
       has_function_privilege('authenticated',
         to_regprocedure('public.finalize_lead_won(uuid, numeric, uuid, text, jsonb)'), 'execute')
    or has_function_privilege('anon',
         to_regprocedure('public.finalize_lead_won(uuid, numeric, uuid, text, jsonb)'), 'execute')) $q$,
  'b6-the-lead-won-finalizer-is-not-an-end-user-rpc');

-- Once per lead is the property the shared finalizer exists to hold. Stated over
-- the whole table so a second writer appearing anywhere fails here.
--
-- It passes against the pre-fix release, and vacuously: that release wrote no 'won'
-- event on the conversion path at all, which is the finding. What this guards is the
-- other direction — two owners of the event writing one each. The event being
-- written is measured by b6-the-conversion-records-exactly-one-won-event.
select pg_temp.assert_eval($q$ (select count(*) = 0 from (
     select lead_id from public.business_events
      where event_type = 'won' and lead_id is not null
      group by lead_id having count(*) > 1) d) $q$,
  'b6-no-lead-carries-two-won-events');

-- ── B7 · the credit identity ────────────────────────────────────────────────
select pg_temp.assert_eval($q$ (select count(*) = 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'payments' and column_name = 'credited_to'
     and data_type = 'uuid') $q$,
  'b7-a-payment-records-the-salesperson-it-credited');

select pg_temp.assert_eval($q$ (select count(*) = 1 from pg_constraint
   where conrelid = 'public.payments'::regclass and contype = 'f'
     and confrelid = 'public.profiles'::regclass
     and (select attname from pg_attribute
           where attrelid = 'public.payments'::regclass and attnum = conkey[1]) = 'credited_to') $q$,
  'b7-the-credit-identity-references-a-profile');

-- The backfill §2 performs, restricted to what it can know: a confirmed, unvoided
-- payment on a contract that has a salesperson.
select pg_temp.assert_eval($q$ (select count(*) = 0 from public.payments p
   join public.contracts c on c.id = p.contract_id
  where coalesce(p.confirmed, false) and p.voided_at is null
    and c.sales_id is not null and p.credited_to is null) $q$,
  'b7-every-confirmed-payment-carries-a-credit-identity');

-- ----------------------------------------------------------------------------
-- The behaviour probes.
-- ----------------------------------------------------------------------------

-- B2 · the column is not writable by the contract's owner (reproduced: it was)
do $$
declare
  v_state text := '00000';
  v_value text := '(not measured)';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      update public.contracts set first_payment_status = 'paid'
       where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
    exception when others then v_state := sqlstate;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select first_payment_status into v_value from public.contracts
     where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '42501' and v_value = 'unpaid',
    'b2-first-payment-status-is-refused-from-a-session');
end
$$;

-- B2 · allocation is the third writer the release had forgotten, and a void puts
-- the derived value back. Read-after-write, both directions, one envelope.
do $$
declare
  v_after_a text := '(not measured)';
  v_after_v text := '(not measured)';
  v_plan    text := '(not measured)';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.confirm_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
                                   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    perform public.allocate_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
      '[{"plan_id": "96666666-6666-6666-6666-666666666666", "amount": 40000}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select first_payment_status into v_after_a from public.contracts
     where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
    select status into v_plan from public.installment_plans
     where id = '96666666-6666-6666-6666-666666666666';

    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.void_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6', 'replay b2 probe');
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select first_payment_status into v_after_v from public.contracts
     where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_plan = 'paid' and v_after_a = 'paid',
    'b2-first-payment-status-follows-an-allocation');
  -- Both readings, not just the second one: pre-fix the allocation never moved the
  -- column off 'unpaid', so 'unpaid' after the void was a pass for the wrong reason
  -- — measured, before this was tightened. The assertion is the transition.
  perform pg_temp.assert(v_after_a = 'paid' and v_after_v = 'unpaid',
    'b2-first-payment-status-follows-a-void');
end
$$;

-- B2 · and it says 'partial', not 'paid', when the allocation is short.
do $$
declare v_fp text := '(not measured)';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.confirm_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
                                   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    perform public.allocate_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
      '[{"plan_id": "96666666-6666-6666-6666-666666666666", "amount": 15000}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select first_payment_status into v_fp from public.contracts
     where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_fp = 'partial',
    'b2-first-payment-status-is-partial-for-a-short-allocation');
end
$$;

-- B2 · the first installment is the LOWEST SEQ PRESENT, not literally seq 1
-- (reproduced: the derivation matched `seq = 1`, so a contract whose schedule is
-- numbered 2,3 — a shape assert_installment_schedule() accepted before
-- 20260817140000, and which rows written before it still carry — read 'unpaid'
-- after its first installment had been confirmed and fully allocated, the plan read
-- 'paid', and no later confirmation or void could ever move it. The stored column
-- and the derivation agreed on the wrong answer, so the table-wide reconciliation
-- invariant above could not see it either).
--
-- The renumber is done as the migration role on purpose. 20260817140000 now refuses
-- a schedule that does not start at 1, so create_contract() can no longer produce
-- this shape; rows that already carry it can, and the derivation has to be right
-- about them. Rolled back with the rest of the envelope.
do $$
declare
  v_state text := '00000';
  v_seq   integer := -1;
  v_fp    text := '(not measured)';
begin
  begin
    update public.installment_plans set seq = 2
     where id = '96666666-6666-6666-6666-666666666666';
    select seq into v_seq from public.installment_plans
     where id = '96666666-6666-6666-6666-666666666666';

    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.confirm_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
                                   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    perform public.allocate_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
      '[{"plan_id": "96666666-6666-6666-6666-666666666666", "amount": 40000}]'::jsonb,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select first_payment_status into v_fp from public.contracts
     where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_seq = 2 and v_fp = 'paid',
    'b2-first-payment-status-reads-the-lowest-seq-not-literally-one');
end
$$;

-- B3 · a payment of -100.00 (reproduced: accepted, confirmed, and it moved the
-- collection KPI down by 100)
do $$
declare
  v_state text := '00000';
  v_rows  bigint := -1;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      insert into public.payments (contract_id, amount, payment_date, created_by, request_key)
      values ('c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6', -100.00, current_date,
              'cccccccc-cccc-cccc-cccc-cccccccccccc', '0b3b3b30-0000-4000-8000-000000000001');
    exception when others then v_state := sqlstate;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.payments where amount = -100.00;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '23514' and v_rows = 0,
    'b3-a-negative-payment-is-refused');
end
$$;

-- B3 · and a payment with no idempotency key at all, once the release is strict.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      insert into public.payments (contract_id, amount, payment_date, created_by)
      values ('c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6', 11.00, current_date,
              'cccccccc-cccc-cccc-cccc-cccccccccccc');
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.payments where amount = 11.00;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023' and v_msg like '%request_key%' and v_rows = 0,
    'b3-a-payment-without-a-request-key-is-refused');
end
$$;

-- B3 · the request boundary itself: the same request twice is one payment, the
-- accepted one is exactly what was sent, and the key cannot be edited afterwards.
do $$
declare
  v_first  text := '(not measured)';
  v_second text := '(not measured)';
  v_edit   text := '(not measured)';
  v_rows   bigint := -1;
  v_stored boolean := false;
  v_key    uuid := '0b3b3b30-0000-4000-8000-00000000000b';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;

    v_first := '00000';
    begin
      insert into public.payments (id, contract_id, amount, payment_date, created_by, request_key)
      values ('0b3b0000-0000-4000-8000-000000000001', 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6',
              7000.00, current_date, 'cccccccc-cccc-cccc-cccc-cccccccccccc', v_key);
    exception when others then v_first := sqlstate;
    end;

    v_second := '00000';
    begin
      insert into public.payments (id, contract_id, amount, payment_date, created_by, request_key)
      values ('0b3b0000-0000-4000-8000-000000000002', 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6',
              7000.00, current_date, 'cccccccc-cccc-cccc-cccc-cccccccccccc', v_key);
    exception when others then v_second := sqlstate;
    end;

    v_edit := '00000';
    begin
      update public.payments set request_key = '0b3b3b30-0000-4000-8000-0000000000ff'
       where id = '0b3b0000-0000-4000-8000-000000000001';
    exception when others then v_edit := sqlstate;
    end;

    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.payments
     where contract_id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6' and amount = 7000.00;
    -- Its own subtransaction: on the floor the column does not exist, and this
    -- measurement must fail as this assertion rather than as the whole block.
    begin
      select request_key = v_key and not coalesce(confirmed, false) and voided_at is null
        into v_stored
        from public.payments where id = '0b3b0000-0000-4000-8000-000000000001';
    exception when others then v_stored := false;
    end;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_first = '00000' and coalesce(v_stored, false),
    'b3-a-keyed-payment-is-recorded-as-sent');
  perform pg_temp.assert(v_second = '23505' and v_rows = 1,
    'b3-the-same-request-twice-is-one-payment');
  perform pg_temp.assert(v_edit = '42501',
    'b3-a-request-key-cannot-be-rewritten');
end
$$;

-- B4 · a contract with no schedule at all (reproduced: created, zero installments)
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0c0c0c0c-0c0c-0c0c-0c0c-0c0c0c0c0c0c',
        'amount',       100000,
        'party_a_name', 'Replay B4 no schedule',
        'installments', '[]'::jsonb));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.contracts
     where lead_id = '0c0c0c0c-0c0c-0c0c-0c0c-0c0c0c0c0c0c';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023'
                         and v_msg like '%needs an installment schedule%'
                         and v_rows = 0,
    'b4-a-contract-without-a-schedule-is-refused');
end
$$;

-- B4 · a schedule that does not add up (reproduced: a 40000 schedule on a 100000
-- contract, accepted). The row count taken after the refusal, inside the envelope,
-- is the atomicity half: nothing may be left behind.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
        'amount',       100000,
        'party_a_name', 'Replay B4 short schedule',
        'installments', jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 40000))));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.contracts
     where lead_id = '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(
    v_state = '22023'
    and v_msg like '%totals 40000.00 but the contract totals 100000.00%'
    and v_rows = 0,
    'b4-a-schedule-that-does-not-total-is-refused');
end
$$;

-- B4 · two installments claiming the same position
do $$
declare v_state text := '00000'; v_msg text := '';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
        'amount',       100000,
        'party_a_name', 'Replay B4 duplicate seq',
        'installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 50000),
          jsonb_build_object('seq', 1, 'amount', 50000))));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023' and v_msg like '%seq 1 appears more than once%',
    'b4-a-duplicate-installment-position-is-refused');
end
$$;

-- B4 · a zero installment. The new CHECK constraint would refuse the row anyway,
-- but at the constraint it is a 23514 raised from inside a definer routine; the
-- caller deserves to be told which installment and why.
do $$
declare v_state text := '00000'; v_msg text := '';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
        'amount',       100000,
        'party_a_name', 'Replay B4 zero installment',
        'installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 100000),
          jsonb_build_object('seq', 2, 'amount', 0))));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023'
                         and v_msg like '%installment 2 needs a positive amount%',
    'b4-a-non-positive-installment-is-refused-by-name');
end
$$;

-- B4 · the positive control, and the read-after-write. A schedule that adds up is
-- stored exactly as sent — same count, same positions, same total. Without this the
-- four refusals above would also be satisfied by a validator that refuses
-- everything.
--
-- This one is expected to pass against the pre-fix release as well, and does: the
-- old code stored a correct schedule correctly. An assertion that failed on both
-- sides of the fix would not be a control.
do $$
declare
  v_id    uuid;
  v_state text := '00000';
  v_count bigint := -1;
  v_total numeric := -1;
  v_seqs  text := '';
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    v_id := (public.create_contract(jsonb_build_object(
      'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
      'amount',       100000,
      'party_a_name', 'Replay B4 exact schedule',
      'installments', jsonb_build_array(
        jsonb_build_object('seq', 1, 'amount', 30000),
        jsonb_build_object('seq', 2, 'amount', 70000)))) ->> 'id')::uuid;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*), coalesce(sum(amount), 0), string_agg(seq::text, ',' order by seq)
      into v_count, v_total, v_seqs
      from public.installment_plans where contract_id = v_id;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_count = 2
                         and v_total = 100000.00 and v_seqs = '1,2',
    'b4-an-exact-schedule-is-stored-as-sent');
end
$$;

-- B4 · a schedule with a gap (20260817140000). Reproduced against the release as
-- it stood, in both modes: [{seq:1,30000},{seq:3,70000}] on a 100000.00 contract was
-- accepted — it totals exactly and every seq is positive and used once — and
-- produced a contract whose second installment does not exist and which nothing
-- downstream can tell apart from a two-installment contract.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
        'amount',       100000,
        'party_a_name', 'Replay B4 gap',
        'installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 30000),
          jsonb_build_object('seq', 3, 'amount', 70000))));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.contracts
     where party_a_name = 'Replay B4 gap';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  -- The count is part of the assertion: a refusal that still left the contract
  -- behind would be a half-applied write, which is the shape B4 is about.
  perform pg_temp.assert(v_state = '22023'
                         and v_msg like '%numbered 1..2 with no gaps, but it is numbered 1,3%'
                         and v_rows = 0,
    'b4-a-schedule-with-a-gap-is-refused');
end
$$;

-- B4 · and a schedule that does not begin at the first installment. Reproduced the
-- same way: a single installment numbered 2 for the whole 100000.00 was accepted, and
-- the contract it created reported no first installment at all to every reader that
-- asks for one — which is precisely the B2 hazard above, arriving through the front
-- door.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    begin
      perform public.create_contract(jsonb_build_object(
        'lead_id',      '0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d',
        'amount',       100000,
        'party_a_name', 'Replay B4 no first installment',
        'installments', jsonb_build_array(
          jsonb_build_object('seq', 2, 'amount', 100000))));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_rows from public.contracts
     where party_a_name = 'Replay B4 no first installment';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023'
                         and v_msg like '%numbered 1..1 with no gaps, but it is numbered 2%'
                         and v_rows = 0,
    'b4-a-schedule-that-does-not-start-at-one-is-refused');
end
$$;

-- B5 · the write half (reproduced: one row updated, the link repointed at another
-- salesperson's contract). policy_quotations_update_sales carries a USING clause
-- and no WITH CHECK — 20260630200000_rls_policy_remediation.sql:546-548 — so RLS
-- permits the row; a guard, not a policy, is what can refuse the column.
do $$
declare
  v_state text := '00000';
  v_link  uuid;
  v_read  boolean := false;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      update public.quotations set contract_id = 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5'
       where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
    exception when others then v_state := sqlstate;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select true, contract_id into v_read, v_link from public.quotations
     where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '42501' and v_read and v_link is null,
    'b5-the-conversion-link-is-refused-from-a-session');
end
$$;

-- B5 · the read half, measured independently of the write guard: the link is
-- crossed here by the harness superuser, the way a bad historic row would be, so
-- the assertion is about what the conversion DOES with a crossed link and not about
-- the guard that now prevents one being made.
-- (Reproduced: success: true, already_converted: true, and then an approval and an
-- activity written against the other salesperson's contract.)
do $$
declare
  v_state     text := '00000';
  v_msg       text := '';
  v_approvals bigint := -1;
  v_activity  bigint := -1;
begin
  begin
    update public.quotations set contract_id = 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5'
     where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
    begin
      perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
      set local role authenticated;
      perform public.convert_quotation_to_contract('b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6',
                                                   '{}'::jsonb);
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select count(*) into v_approvals from public.contract_approvals
     where contract_id = 'c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5';
    select count(*) into v_activity from public.activities
     where lead_id = '0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023' and v_msg like '%crossed link%',
    'b5-a-crossed-conversion-link-is-refused');
  perform pg_temp.assert(v_approvals = 0 and v_activity = 0,
    'b5-a-crossed-link-writes-nothing-on-the-foreign-contract');
end
$$;

-- B6 · the conversion's lead-won side effects (reproduced: none of them happened,
-- because on_lead_won() returns early once a contract exists and the conversion
-- creates the contract before it marks the lead won).
do $$
declare
  v_state     text := '00000';
  v_lead      uuid := '0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e';
  v_customer  uuid;
  v_cust_rows bigint := -1;
  v_won       bigint := -1;
  v_project   uuid;
  v_contract  uuid;
  v_final     text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.convert_quotation_to_contract('b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6',
      jsonb_build_object('installments',
        jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 80000))));
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select customer_id, final_status into v_customer, v_final
      from public.leads where id = v_lead;
    select count(*) into v_cust_rows from public.customers where lead_id = v_lead;
    select count(*) into v_won from public.business_events
     where lead_id = v_lead and event_type = 'won';
    select customer_id into v_project from public.projects where lead_id = v_lead;
    select customer_id into v_contract from public.contracts
     where lead_id = v_lead order by created_at desc limit 1;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_customer is not null
                         and v_cust_rows = 1 and v_final = 'won',
    'b6-the-conversion-creates-the-customer-and-links-the-lead');
  perform pg_temp.assert(v_won = 1,
    'b6-the-conversion-records-exactly-one-won-event');
  perform pg_temp.assert(v_project is not null and v_project = v_customer
                         and v_contract = v_customer,
    'b6-the-conversion-puts-that-customer-on-the-project-and-the-contract');
end
$$;

-- B5 · the retry that charged twice (reproduced on the tree as it stands: one
-- conversion of the 80000.00 fixture quotation followed by two identical retries
-- left customers.total_contract_amount at 240000.00, because the idempotent
-- branch calls finalize_lead_won() again on every retry and that function added
-- p_amount unconditionally; and a retry carrying a different schedule was
-- answered success: true, because the branch never looks at p_payload).
--
-- The measurements are taken with the role reset, like B6's above: customers is
-- RLS-protected and an `authenticated` session does not see the row it just
-- caused to be written.
do $$
declare
  v_state   text := '00000';
  v_lead    uuid := '0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e';
  v_quote   uuid := 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
  v_sched   jsonb := jsonb_build_object('installments',
                       jsonb_build_array(jsonb_build_object(
                         'seq', 1,
                         'amount', 80000,
                         'due_date', '2026-09-01',
                         'description', 'Initial installment')));
  v_after1  numeric := -1;
  v_after3  numeric := -1;
  v_amount  numeric := -1;
  v_rows    bigint  := -1;
  v_retry   text    := '00000';
  v_retmsg  text    := '';
  v_due_retry text  := '00000';
  v_due_msg   text  := '';
  v_desc_retry text := '00000';
  v_desc_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform public.convert_quotation_to_contract(v_quote, v_sched);
    reset role;
    select coalesce(sum(total_contract_amount), -1) into v_after1
      from public.customers where lead_id = v_lead;

    -- the exact same call, twice more: the retry a double-submit or a retried
    -- POST /api/quotations/[id]/convert sends
    set local role authenticated;
    perform public.convert_quotation_to_contract(v_quote, v_sched);
    perform public.convert_quotation_to_contract(v_quote, v_sched);

    -- a retry that is not a retry: same quotation, a schedule the stored
    -- contract does not have
    begin
      perform public.convert_quotation_to_contract(v_quote,
        jsonb_build_object('installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 40000.00),
          jsonb_build_object('seq', 2, 'amount', 40000.00))));
    exception when others then v_retry := sqlstate; v_retmsg := sqlerrm;
    end;

    -- Same amount and sequence are not enough: the persisted due date and
    -- description are part of the request whose success a retry reports.
    begin
      perform public.convert_quotation_to_contract(v_quote,
        jsonb_build_object('installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 80000.00,
                             'due_date', '2026-09-02',
                             'description', 'Initial installment'))));
    exception when others then v_due_retry := sqlstate; v_due_msg := sqlerrm;
    end;
    begin
      perform public.convert_quotation_to_contract(v_quote,
        jsonb_build_object('installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 80000.00,
                             'due_date', '2026-09-01',
                             'description', 'Changed installment'))));
    exception when others then v_desc_retry := sqlstate; v_desc_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select coalesce(sum(total_contract_amount), -1) into v_after3
      from public.customers where lead_id = v_lead;
    select count(*), coalesce(sum(contract_amount), -1) into v_rows, v_amount
      from public.contracts where lead_id = v_lead;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_after1 = 80000.00
                         and v_after3 = 80000.00 and v_rows = 1 and v_amount = 80000.00,
    'b5-a-conversion-retry-does-not-add-the-amount-again');
  perform pg_temp.assert(v_retry = '22023' and v_retmsg like '%disagree%'
                         and v_due_retry = '22023' and v_due_msg like '%disagree%'
                         and v_desc_retry = '22023' and v_desc_msg like '%disagree%',
    'b5-a-retry-asking-for-a-different-schedule-is-refused');
end
$$;

-- R4 · the retry that only half finished. B5 above is about what the
-- already-converted branch REFUSES; this is about what it does when the retry is a
-- retry. Reproduced against the release minus only 20260817170000: a converted
-- quotation whose status was set back to 'accepted' — the quotes list writes that
-- column directly, and trg_guard_quotations_write protects the link beside it and
-- not the status — whose lead's final_status was cleared and whose contract's
-- customer_id was nulled, which is the state a first attempt that died after the
-- contract leaves and the state this branch exists to finish. The retry answered
-- success: true, already_converted: true, quotation_status: 'accepted',
-- project_id: null, finalized: [] — and afterwards all three rows still held the
-- broken values. Nothing repaired, and nothing said about not repairing it.
--
-- The three rows are read back with the role reset, like B5 and B6 above:
-- customers and contracts are RLS-protected and an `authenticated` session does
-- not necessarily see what it just caused to be written.
do $$
declare
  v_state    text := '00000';
  v_lead     uuid := '0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e';
  v_quote    uuid := 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
  v_sched    jsonb := jsonb_build_object('installments',
                        jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 80000)));
  v_contract uuid;
  v_retry    jsonb := '{}'::jsonb;
  v_qstatus  text;
  v_final    text;
  v_customer uuid;
  v_foreign  uuid := 'f6f6f6f6-f6f6-f6f6-f6f6-f6f6f6f6f6f6';
  v_contract_customer uuid;
  v_mismatch text := '00000';
  v_mismatch_msg text := '';
  v_lost     text := '00000';
  v_lostmsg  text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_contract := (public.convert_quotation_to_contract(v_quote, v_sched) ->> 'contract_id')::uuid;
    reset role;
    perform set_config('request.jwt.claims', '', true);

    -- Break it the way a deployment breaks it, not the way a test would like it
    -- broken: a status change any quotation owner can make, plus the two columns a
    -- first attempt that died after the contract never got to.
    update public.quotations set status = 'accepted' where id = v_quote;
    update public.leads      set final_status = null  where id = v_lead;
    update public.contracts  set customer_id = null   where id = v_contract;

    -- The repair call: a re-POST with no schedule restated.
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    v_retry := public.convert_quotation_to_contract(v_quote, '{}'::jsonb);
    reset role;
    perform set_config('request.jwt.claims', '', true);

    select status       into v_qstatus  from public.quotations where id = v_quote;
    select final_status into v_final    from public.leads      where id = v_lead;
    select customer_id  into v_customer from public.contracts  where id = v_contract;

    -- A non-null different customer is contradictory state rather than a NULL
    -- left by an interrupted first attempt. The retry must refuse it and leave
    -- both identities untouched.
    insert into public.customers (id, name) values (v_foreign, 'Foreign retry customer');
    update public.contracts set customer_id = v_foreign where id = v_contract;
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      perform public.convert_quotation_to_contract(v_quote, '{}'::jsonb);
    exception when others then v_mismatch := sqlstate; v_mismatch_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select customer_id into v_contract_customer from public.contracts where id = v_contract;

    -- Restore the converged link for the separate terminal-status refusal below.
    update public.contracts set customer_id = v_customer where id = v_contract;

    -- And the refusal: a lead given a different terminal decision is not a
    -- conversion waiting to be finished.
    update public.leads set final_status = 'lost' where id = v_lead;
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      perform public.convert_quotation_to_contract(v_quote, '{}'::jsonb);
    exception when others then v_lost := sqlstate; v_lostmsg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_qstatus = 'contract_created'
                         and v_retry ->> 'quotation_status' = 'contract_created',
    'r4-a-retry-restores-the-converted-quotation-status');
  perform pg_temp.assert(v_state = '00000' and v_final = 'won',
    'r4-a-retry-marks-the-lead-won-again');
  perform pg_temp.assert(v_state = '00000' and v_customer is not null
                         and v_customer = (v_retry ->> 'customer_id')::uuid,
    'r4-a-retry-backfills-the-contract-customer');
  perform pg_temp.assert(v_state = '00000' and (v_retry ->> 'project_id') is not null
                         and v_retry -> 'finalized'
                             @> '["quotation_status","lead_won","contract_customer"]'::jsonb,
    'r4-a-retry-returns-the-project-and-reports-what-it-repaired');
  perform pg_temp.assert(v_mismatch = '22023'
                         and v_mismatch_msg like '%different customer identities%'
                         and v_contract_customer = v_foreign,
    'r4-a-retry-refuses-a-conflicting-contract-customer');
  perform pg_temp.assert(v_lost = '22023' and v_lostmsg like '%rather than won%',
    'r4-a-retry-refuses-a-lead-given-a-different-terminal-status');
end
$$;

-- B10 · one cent (reproduced: a 79999.99 schedule against an 80000.00 quotation,
-- accepted, because the old check allowed 0.01 of slack per installment).
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_link  uuid;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      perform public.convert_quotation_to_contract('b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6',
        jsonb_build_object('installments', jsonb_build_array(
          jsonb_build_object('seq', 1, 'amount', 40000.00),
          jsonb_build_object('seq', 2, 'amount', 39999.99))));
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    select contract_id into v_link from public.quotations
     where id = 'b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(
    v_state = '22023'
    and v_msg like '%totals 79999.99 but the quotation totals 80000.00%'
    and v_link is null,
    'b10-a-conversion-schedule-must-equal-the-quotation-exactly');
end
$$;

-- B7 · saving the period's targets keeps what was collected (reproduced: 60000.00
-- became 0.00, from the UPDATE the finance UI issues on every edit).
--
-- On a period of its own, created inside the envelope. replace_kpi_targets() deletes
-- the whole period and re-inserts the payload, so a probe on the current period
-- would be measuring whatever every earlier assertion in this file left there.
do $$
declare
  v_state  text := '00000';
  v_before numeric := -1;
  v_after  numeric := -1;
begin
  begin
    insert into public.kpi_targets (period, target_type, target_amount, actual_amount,
                                    assigned_to, set_by)
    values ('2026-97', 'collection', 500000.00, 60000.00,
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
           ('2026-97', 'collection', 500000.00, 0.00,
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    select actual_amount into v_before from public.kpi_targets
     where period = '2026-97' and target_type = 'collection'
       and assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    -- The ordinary "set this month's targets" save: same numbers, no actuals,
    -- because actuals are not something a UI sends.
    perform * from public.replace_kpi_targets('2026-97',
      jsonb_build_array(
        jsonb_build_object('target_type', 'collection', 'target_amount', 500000,
                           'assigned_to', 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
        jsonb_build_object('target_type', 'collection', 'target_amount', 500000,
                           'assigned_to', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')),
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    select actual_amount into v_after from public.kpi_targets
     where period = '2026-97' and target_type = 'collection'
       and assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_before = 60000.00 and v_after = 60000.00,
    'b7-saving-a-period-preserves-what-was-collected');
end
$$;

-- B7 · and it refuses to drop a pair that still holds collections, rather than
-- deleting the record of them (reproduced: the row, and its 12345.00, deleted).
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
begin
  begin
    insert into public.kpi_targets (period, target_type, target_amount, actual_amount,
                                    assigned_to, set_by)
    values ('2026-96', 'collection', 500000.00, 0.00,
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
           ('2026-96', 'collection', 500000.00, 12345.00,
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    begin
      perform * from public.replace_kpi_targets('2026-96',
        jsonb_build_array(jsonb_build_object('target_type', 'collection',
          'target_amount', 500000, 'assigned_to', 'cccccccc-cccc-cccc-cccc-cccccccccccc')),
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    select count(*) into v_rows from public.kpi_targets
     where period = '2026-96' and target_type = 'collection'
       and assigned_to = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' and actual_amount = 12345.00;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023'
                         and v_msg like '%already hold collected amounts%'
                         and v_rows = 1,
    'b7-a-period-cannot-be-saved-in-a-way-that-drops-collected-amounts');
end
$$;

-- B7 · the credit and its reversal name the same person (reproduced: the void
-- debited whoever owned the contract at void time, so a reassignment between the
-- confirmation and the reversal took money off the wrong salesperson and left the
-- original credit standing).
--
-- Measured as differences, not as absolute amounts: the fixtures' current-period
-- rows are shared with the rest of this file, and the finding is about who moved.
do $$
declare
  v_state     text := '00000';
  v_credited  uuid;
  v_c1_before numeric := -1;
  v_c1_after  numeric := -1;
  v_c2_before numeric := -1;
  v_c2_after  numeric := -1;
  v_debited   text := '';
  v_period    text := to_char(current_date, 'YYYY-MM');
begin
  begin
    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    perform public.confirm_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
                                   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    reset role;
    perform set_config('request.jwt.claims', '', true);

    select credited_to into v_credited from public.payments
     where id = 'd6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6';
    select actual_amount into v_c1_before from public.kpi_targets
     where period = v_period and target_type = 'collection'
       and assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    select actual_amount into v_c2_before from public.kpi_targets
     where period = v_period and target_type = 'collection'
       and assigned_to = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

    -- The contract changes hands, the way a manager legitimately reassigns one.
    update public.contracts set sales_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
     where id = 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6';

    perform pg_temp.act_as('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    set local role authenticated;
    v_debited := coalesce(public.void_payment('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6',
                                              'replay b7 probe') ->> 'debited_from', '');
    reset role;
    perform set_config('request.jwt.claims', '', true);

    select actual_amount into v_c1_after from public.kpi_targets
     where period = v_period and target_type = 'collection'
       and assigned_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    select actual_amount into v_c2_after from public.kpi_targets
     where period = v_period and target_type = 'collection'
       and assigned_to = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000'
                         and v_credited = 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'b7-confirming-a-payment-records-who-was-credited');
  perform pg_temp.assert(v_debited = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
                         and v_c1_after = v_c1_before - 40000.00
                         and v_c2_after = v_c2_before,
    'b7-a-void-debits-the-recorded-creditor-not-the-current-owner');
end
$$;

-- B7 · and the credit identity is not something a session can write, or a
-- salesperson could pre-assign a colleague's collection to themselves.
do $$
declare
  v_state text := '00000';
  v_value uuid;
  v_read  boolean := false;
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      update public.payments set credited_to = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
       where id = 'd6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6';
    exception when others then v_state := sqlstate;
    end;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    begin
      select true, credited_to into v_read, v_value from public.payments
       where id = 'd6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6';
    exception when others then v_read := false;
    end;
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '42501' and v_read and v_value is null,
    'b7-the-credit-identity-is-refused-from-a-session');
end
$$;

-- B7 · clearing a period is a routine, not a DELETE (20260817150000). Reproduced
-- on the release as it stood: the route's own service-role
-- `delete from kpi_targets where period = P` removed two rows and took 700.00 of
-- collected money with them, took no period lock while a replace was in flight, and
-- answered to the route's role list (admin/boss/operator) instead of the table's
-- DELETE policy (admin/boss). clear_kpi_targets() takes the same period lock the save
-- path takes and refuses a period that still holds collections, with the same errcode
-- and the same shape of message as the save path's orphan guard.
--
-- Measured as the migration role, which is how the route reaches it: the function is
-- service-role only, and the third assertion below is that an end-user session cannot
-- call it at all.
do $$
declare
  v_state text := '00000';
  v_msg   text := '';
  v_rows  bigint := -1;
  v_sum   numeric := -1;
begin
  begin
    insert into public.kpi_targets (period, target_type, target_amount, actual_amount,
                                    assigned_to, set_by)
    values ('2026-95', 'collection', 500000.00, 0.00,
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
           ('2026-95', 'collection', 500000.00, 777.00,
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    begin
      perform public.clear_kpi_targets('2026-95', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    exception when others then v_state := sqlstate; v_msg := sqlerrm;
    end;
    select count(*), coalesce(sum(actual_amount), -1) into v_rows, v_sum
      from public.kpi_targets where period = '2026-95';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(v_state = '22023'
                         and v_msg like '%already hold collected amounts%'
                         and v_rows = 2 and v_sum = 777.00,
    'b7-clearing-a-period-that-holds-collections-is-refused');
end
$$;

-- B7 · and the capability itself survives: clearing a period nobody has collected
-- against is still allowed, because that is a real thing an administrator does and
-- removing it would be a different change from removing the hazard. Without this the
-- refusal above would also be satisfied by a routine that refuses everything.
do $$
declare
  v_state   text := '00000';
  v_removed bigint := -1;
  v_left    bigint := -1;
begin
  begin
    insert into public.kpi_targets (period, target_type, target_amount, actual_amount,
                                    assigned_to, set_by)
    values ('2026-94', 'collection', 500000.00, 0.00,
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
           ('2026-94', 'collection', 500000.00, 0.00,
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    v_removed := public.clear_kpi_targets('2026-94', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    select count(*) into v_left from public.kpi_targets where period = '2026-94';
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    if sqlerrm <> 'REPLAY_ROLLBACK' then
      v_state := sqlstate;
      perform pg_temp.absorb(sqlstate, sqlerrm);
    end if;
  end;
  perform pg_temp.assert(v_state = '00000' and v_removed = 2 and v_left = 0,
    'b7-clearing-a-period-that-holds-nothing-is-still-allowed');
end
$$;

-- B7 · and no browser session can reach it. The role check for this one lives in the
-- route, because the route calls it over the service-role client where auth.uid() is
-- null — so the grant is the only thing standing between an `authenticated` session
-- and a period-wide delete. Catalog, not a source grep, and written so that a database
-- on which the function does not exist fails rather than passing vacuously.
do $$
declare v_blocked boolean := false;
begin
  select coalesce((select not has_function_privilege('authenticated', p.oid, 'execute')
                     and not has_function_privilege('anon', p.oid, 'execute')
                     and has_function_privilege('service_role', p.oid, 'execute')
                   from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'clear_kpi_targets'), false)
    into v_blocked;
  perform pg_temp.assert(v_blocked,
    'b7-the-period-clear-routine-is-service-role-only');
end
$$;

-- ============================================================================
-- A3 · Administrator password reset is bound to a VERIFIED session revocation
--     (20260817120000_admin_reset_session_revocation.sql)
-- ============================================================================
-- Round 4 said the reset route "does not globally revoke sessions", so "a pre-reset
-- refresh token can mint a fresh access token". The claim about the route is right
-- and the claim about the outcome is not: measured against a real GoTrue v2.195.0
-- (scripts/gotrue-revocation-drill.sh), an admin password update already deletes
-- the target's sessions, the pre-reset refresh token comes back 400
-- refresh_token_not_found, and no fresh access token is minted. The route was
-- inheriting a guarantee it never asked for and could not observe: auth is not in
-- PostgREST's exposed schemas, both outcomes are a 200, and the platform upgrades
-- GoTrue on its own schedule.
--
-- So the release does not inherit it. revoke_user_sessions() deletes whatever is
-- left, verifies that nothing remains, and raises otherwise; the two reset paths
-- call it and fail closed. What the assertions below prove is that boundary, on a
-- faithful copy of GoTrue's session tables (supabase/replay/00_platform_bootstrap.sql
-- carries the real column types and both ON DELETE CASCADE foreign keys, read out
-- of that live GoTrue).
--
-- What the harness cannot prove, stated rather than papered over: the harness runs
-- as its own superuser, so it says nothing about whether the migration owner has
-- DELETE on auth.sessions in production. That is why the migration itself refuses
-- to install without the privilege (section 3 of the file) instead of trusting a
-- green replay.
-- ----------------------------------------------------------------------------

select pg_temp.assert_eval($q$ to_regprocedure('public.revoke_user_sessions(uuid, text)') is not null $q$,
  'a3-revocation-rpc-exists');

select pg_temp.assert_eval($q$ (select p.prosecdef and p.provolatile = 'v'
    and p.proconfig::text like '%search_path=pg_catalog, public, pg_temp%'
    from pg_proc p where p.oid = to_regprocedure('public.revoke_user_sessions(uuid, text)')) $q$,
  'a3-revocation-rpc-is-a-volatile-definer-with-a-pinned-search-path');

-- The A1 sweep covers this function generically; naming it here is the check that
-- the release's newest definer routine did not arrive after the sweep had run.
select pg_temp.assert_eval($q$ (select p.prosrc ~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);'
    from pg_proc p where p.oid = to_regprocedure('public.revoke_user_sessions(uuid, text)')) $q$,
  'a3-revocation-rpc-carries-the-definer-entry-guard');

-- Default privileges in schema public grant EXECUTE on new functions to all three
-- PostgREST roles, so "we never granted it" is not the same as "they cannot call
-- it". The migration revokes; this is the readback.
select pg_temp.assert_eval($q$ not has_function_privilege('authenticated', 'public.revoke_user_sessions(uuid, text)', 'execute') $q$,
  'a3-authenticated-cannot-execute-the-revocation-rpc');
select pg_temp.assert_eval($q$ not has_function_privilege('anon', 'public.revoke_user_sessions(uuid, text)', 'execute') $q$,
  'a3-anon-cannot-execute-the-revocation-rpc');
select pg_temp.assert_eval($q$ has_function_privilege('service_role', 'public.revoke_user_sessions(uuid, text)', 'execute') $q$,
  'a3-service-role-can-execute-the-revocation-rpc');

-- ----------------------------------------------------------------------------
-- The behaviour probe: two live sessions, three refresh tokens, one bystander.
--
-- The third token is the legacy shape — a refresh token whose session_id is null,
-- which GoTrue wrote before auth.sessions existed and which no cascade can reach.
-- The bystander is the blast radius: a revocation that signs out the whole company
-- would satisfy every "the target's sessions are gone" assertion.
--
-- One subtransaction, so the fixture rows and the audit rows the function writes
-- are rolled back by the deliberate REPLAY_ROLLBACK rather than by a cleanup
-- statement that could fail on its own. Every counter starts at -1, which no
-- passing assertion accepts, so a probe that could not run reports as a failure
-- under its own name instead of passing quietly.
-- ----------------------------------------------------------------------------
do $$
declare
  v_target        uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  v_other         uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_first         jsonb;
  v_second        jsonb;
  v_s_before      int := -1;
  v_t_before      int := -1;
  v_legacy_before int := -1;
  v_s_after       int := -1;
  v_t_after       int := -1;
  v_legacy_after  int := -1;
  v_other_s       int := -1;
  v_other_t       int := -1;
  v_audit         int := -1;
  v_audit_server  int := -1;
begin
  begin
    perform set_config('request.jwt.claims', '', true);

    insert into auth.sessions (id, user_id, created_at, not_after)
    values ('a3a30001-0000-4000-8000-000000000001', v_target, now(), now() + interval '1 day'),
           ('a3a30001-0000-4000-8000-000000000002', v_target, now(), now() + interval '1 day'),
           ('a3a30001-0000-4000-8000-000000000003', v_other,  now(), now() + interval '1 day');

    insert into auth.refresh_tokens (token, user_id, revoked, session_id)
    values ('a3-target-session-token-1', v_target::text, false, 'a3a30001-0000-4000-8000-000000000001'),
           ('a3-target-session-token-2', v_target::text, false, 'a3a30001-0000-4000-8000-000000000002'),
           ('a3-target-legacy-token',    v_target::text, false, null),
           ('a3-other-session-token',    v_other::text,  false, 'a3a30001-0000-4000-8000-000000000003');

    select count(*) into v_s_before from auth.sessions where user_id = v_target;
    select count(*) into v_t_before from auth.refresh_tokens where user_id = v_target::text;
    select count(*) into v_legacy_before from auth.refresh_tokens
     where user_id = v_target::text and session_id is null;

    v_first := public.revoke_user_sessions(v_target, 'replay a3 probe');

    select count(*) into v_s_after from auth.sessions where user_id = v_target;
    select count(*) into v_t_after from auth.refresh_tokens where user_id = v_target::text;
    select count(*) into v_legacy_after from auth.refresh_tokens
     where user_id = v_target::text and session_id is null;
    select count(*) into v_other_s from auth.sessions where user_id = v_other;
    select count(*) into v_other_t from auth.refresh_tokens where user_id = v_other::text;

    -- Called twice on purpose: the reset route retries, and a boundary that only
    -- reports success the first time is a boundary the route cannot depend on.
    v_second := public.revoke_user_sessions(v_target, 'replay a3 second call');

    select count(*), count(*) filter (where actor_id is null)
      into v_audit, v_audit_server
      from public.audit_logs
     where action = 'SESSION_REVOCATION' and target_id::text = v_target::text;

    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;

  perform pg_temp.assert(v_s_before = 2 and v_s_after = 0,
    'a3-the-revocation-removes-every-session-of-the-target');
  perform pg_temp.assert(v_t_before = 3 and v_t_after = 0,
    'a3-the-revocation-removes-every-refresh-token-of-the-target');
  perform pg_temp.assert(v_legacy_before = 1 and v_legacy_after = 0,
    'a3-a-refresh-token-with-no-session-is-removed-too');
  perform pg_temp.assert(v_first ->> 'verified' = 'true'
                         and (v_first ->> 'sessions_deleted')::int = 2
                         and (v_first ->> 'refresh_tokens_deleted')::int = 3,
    'a3-the-revocation-reports-the-rows-it-removed');
  perform pg_temp.assert(v_second ->> 'verified' = 'true'
                         and (v_second ->> 'sessions_deleted')::int = 0
                         and (v_second ->> 'refresh_tokens_deleted')::int = 0,
    'a3-a-second-revocation-is-a-verified-no-op');
  perform pg_temp.assert(v_s_after = 0 and v_other_s = 1 and v_other_t = 1,
    'a3-another-identity-keeps-its-sessions');
  perform pg_temp.assert(v_audit = 2 and v_audit_server = 2,
    'a3-every-revocation-writes-a-server-owned-audit-row');
end
$$;

-- Two locks, not one. The GRANT is what stops a browser session; the identity
-- check inside the function is what stops the same call arriving from a trusted
-- role while carrying an end-user identity — a definer wrapper, a future GRANT, or
-- a psql session with claims set. Revoking another identity's sessions is not an
-- end-user action under any circumstances.
do $$
declare
  v_grant_state text := '00000';
  v_grant_msg   text := '(not measured)';
  v_id_state    text := '00000';
  v_id_msg      text := '(not measured)';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    begin
      perform public.revoke_user_sessions('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);
    exception when others then v_grant_state := sqlstate; v_grant_msg := sqlerrm;
    end;
    reset role;

    begin
      perform public.revoke_user_sessions('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);
    exception when others then v_id_state := sqlstate; v_id_msg := sqlerrm;
    end;
    perform set_config('request.jwt.claims', '', true);
    raise exception 'REPLAY_ROLLBACK';
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    if sqlerrm <> 'REPLAY_ROLLBACK' then perform pg_temp.absorb(sqlstate, sqlerrm); end if;
  end;
  perform pg_temp.assert(pg_temp.refused_with(v_grant_state, v_grant_msg, 'permission denied for function'),
    'a3-an-authenticated-session-is-refused-by-the-grant');
  perform pg_temp.assert(pg_temp.refused_with(v_id_state, v_id_msg, 'server-only boundary'),
    'a3-a-call-carrying-an-end-user-identity-is-refused');
end
$$;

-- The two arguments it must refuse. An unknown target is not a no-op: reporting
-- "verified, 0 rows" for an identity that does not exist would let a reset path
-- that mistyped the id believe it had revoked something.
do $$
declare
  v_unknown_state text := '00000';
  v_unknown_msg   text := '(not measured)';
  v_null_state    text := '00000';
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    perform public.revoke_user_sessions('00000000-0000-0000-0000-00000000a3a3'::uuid);
  exception when others then v_unknown_state := sqlstate; v_unknown_msg := sqlerrm;
  end;
  begin
    perform public.revoke_user_sessions(null::uuid);
  exception when others then v_null_state := sqlstate;
  end;
  perform pg_temp.assert(v_unknown_state = '22023' and v_unknown_msg like '%identity that does not exist%',
    'a3-an-unknown-target-is-refused');
  perform pg_temp.assert(v_null_state = '22004',
    'a3-a-null-target-is-refused');
end
$$;

-- ============================================================================
-- R9 · A rebalance retry is the original batch, not a new load calculation.
-- The focused PG17 gate stages the two-session race and rollback. These catalog
-- assertions keep its table/function/ACL prerequisites in the main ledger too.
-- ============================================================================
select pg_temp.assert_eval($q$
  to_regclass('public.lead_rebalance_batches') is not null
$q$, 'r9-rebalance-plan-table-installed');

select pg_temp.assert_eval($q$
  (select array_agg(a.attname order by k.ord)
     from pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.conrelid = to_regclass('public.lead_rebalance_batches')
      and c.contype = 'p') = array['actor_id','batch_key']::name[]
$q$, 'r9-rebalance-plan-primary-key-is-actor-and-batch');

select pg_temp.assert_eval($q$
  coalesce((select c.relrowsecurity and c.relforcerowsecurity
              from pg_class c where c.oid = to_regclass('public.lead_rebalance_batches')), false)
$q$, 'r9-rebalance-plan-table-forces-rls');

select pg_temp.assert_eval($q$
  coalesce((
    select not exists (
             select 1
               from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
               left join pg_catalog.pg_roles r on r.oid = x.grantee
              where x.grantee = 0 or r.rolname in ('anon', 'authenticated')
           )
           and coalesce((
             select pg_catalog.array_agg(x.privilege_type::text order by x.privilege_type::text)
               from pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
               join pg_catalog.pg_roles r on r.oid = x.grantee
              where r.rolname = 'service_role'
           ), array[]::text[]) = array['SELECT']::text[]
           and not coalesce(has_table_privilege('anon', c.oid, 'select'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'insert'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'update'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'delete'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'truncate'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'references'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'trigger'), false)
           and not coalesce(has_table_privilege('anon', c.oid, 'maintain'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'select'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'insert'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'update'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'delete'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'truncate'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'references'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'trigger'), false)
           and not coalesce(has_table_privilege('authenticated', c.oid, 'maintain'), false)
           and coalesce(has_table_privilege('service_role', c.oid, 'select'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'insert'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'update'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'delete'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'truncate'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'references'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'trigger'), false)
           and not coalesce(has_table_privilege('service_role', c.oid, 'maintain'), false)
      from pg_catalog.pg_class c
     where c.oid = to_regclass('public.lead_rebalance_batches')
  ), false)
$q$, 'r9-rebalance-plan-table-is-service-read-only');

select pg_temp.assert_eval($q$
  coalesce((select p.prosecdef and p.provolatile = 'v'
                     and p.proconfig = array['search_path=""']::text[]
              from pg_proc p
             where p.oid = to_regprocedure('public.get_or_create_lead_rebalance_plan(uuid,jsonb)')), false)
$q$, 'r9-rebalance-plan-rpc-is-empty-path-definer');

select pg_temp.assert_eval($q$
  case when to_regprocedure('public.get_or_create_lead_rebalance_plan(uuid,jsonb)') is null then false else
    has_function_privilege('authenticated', 'public.get_or_create_lead_rebalance_plan(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_or_create_lead_rebalance_plan(uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.get_or_create_lead_rebalance_plan(uuid,jsonb)', 'EXECUTE')
  end
$q$, 'r9-rebalance-plan-rpc-is-authenticated-only');

select pg_temp.assert_eval($q$
  coalesce((select strpos(
                       pg_catalog.lower(p.prosrc),
                       pg_catalog.chr(10) || 'begin' || pg_catalog.chr(10)
                       || '  perform public.assert_current_session_at_entry();'
                     ) > 0
                    and strpos(p.prosrc, 'pg_catalog.pg_advisory_xact_lock')
                        < strpos(p.prosrc, 'insert into public.lead_rebalance_batches')
              from pg_proc p
             where p.oid = to_regprocedure('public.get_or_create_lead_rebalance_plan(uuid,jsonb)')), false)
  and exists (
    select 1 from pg_trigger t
     where t.tgrelid = to_regclass('public.lead_rebalance_batches')
       and t.tgname = 'trg_require_current_session'
       and not t.tgisinternal
       and t.tgenabled = 'O'
       and (t.tgtype & 1) = 0
       and (t.tgtype & 2) = 2
       and (t.tgtype & 28) = 28
       and t.tgattr::text = ''
       and t.tgqual is null
  )
$q$, 'r9-rebalance-plan-entry-lock-and-statement-boundary');

-- ============================================================================
-- Self-check: every assertion above ran.
-- ============================================================================
-- In MODE=branch "ran" and "passed" are the same number, because a failure would
-- already have raised. In MODE=control they are not, and the distinction is the
-- whole point: the ledger below is the in-database proof that all 350 assertions
-- were REACHED. A DO block that died on an unclassified SQL error takes its
-- remaining assertions out of the ledger, so the count comes up short and the
-- control run fails here rather than in a log-scraping heuristic. Reported
-- counts, unlike absent log lines, cannot be satisfied by an assertion that
-- never executed.
do $$
declare
  total  int;
  passed int;
  failed int;
begin
  select count(*), count(*) filter (where assert_log.passed), count(*) filter (where not assert_log.passed)
    into total, passed, failed
    from assert_log;
  raise notice 'ASSERT_LEDGER total=% passed=% failed=% declared=350', total, passed, failed;
  if total <> 350 then
    raise exception 'assertion file reached % assertions, ASSERT_TOTAL says 350', total
      using errcode = '22000';
  end if;
  if coalesce(current_setting('replay.collect', true), 'off') <> 'on' and passed <> 350 then
    raise exception 'assertion file passed % of 350 assertions', passed
      using errcode = '22000';
  end if;
  if exists (select 1 from assert_log group by name having count(*) > 1) then
    raise exception 'duplicate assertion name(s): %',
      (select string_agg(name, ', ' order by name) from (
         select name from assert_log group by name having count(*) > 1) d)
      using errcode = '22000';
  end if;
  raise notice 'all % assertions accounted for (% passed)', total, passed;
end
$$;
