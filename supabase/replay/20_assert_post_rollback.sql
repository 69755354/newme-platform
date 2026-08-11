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
-- ASSERT_TOTAL: 30
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
do $$
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    perform count(*) from public.meta_tokens;
    raise exception 'authenticated read meta_tokens after rollback' using errcode = '22000';
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert(true, 'f10-post-rollback-authenticated-cannot-read-meta-tokens');
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

do $$
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.audit_logs (actor_id, action, details)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'FORGED_AFTER_ROLLBACK', '{}');
    raise exception 'authenticated forged an audit row after rollback' using errcode = '22000';
  exception
    when insufficient_privilege then null;
  end;
  perform pg_temp.assert(true, 'f08-post-rollback-authenticated-cannot-forge-audit-row');
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

-- Behaviour: a direct PostgREST-shaped insert into contracts is still refused.
-- The sqlstate AND the guard's own message are pinned. Both matter: an unrelated
-- schema change (a new NOT NULL column, say) would fail with a different state,
-- and — since 20260813000000 — a deactivated or stale-token identity is refused
-- with the same 42501 by the restrictive session boundary. This assertion is
-- about the write guard, so it acts as an active identity holding a current
-- token and requires the guard's message; otherwise it could pass while the
-- guard was gone.
do $$
declare
  v_state text;
  v_msg   text := '';
begin
  begin
    perform pg_temp.act_as('cccccccc-cccc-cccc-cccc-cccccccccccc');
    set local role authenticated;
    insert into public.contracts (contract_no, lead_id, sales_id, created_by, contract_amount, status)
    values ('NEW-19700101-9999', null, 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 1, 'draft');
    v_state := '00000';
  exception
    when others then v_state := sqlstate; v_msg := sqlerrm;
  end;
  reset role;

  if v_state = '00000' then
    raise exception 'authenticated inserted a contract directly after rollback' using errcode = '22000';
  elsif v_state <> '42501' then
    raise exception 'direct contract insert was refused with sqlstate % rather than 42501, so this assertion is not exercising the write guard', v_state
      using errcode = '22000';
  elsif v_msg not like '%direct insert is not permitted%' then
    raise exception 'direct contract insert was refused by something other than the write guard (%), so this assertion is not exercising the guard', v_msg
      using errcode = '22000';
  end if;
  perform pg_temp.assert(true, 'money-post-rollback-direct-contract-insert-refused');
end
$$;

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
-- Self-check: every assertion above ran.
-- ============================================================================
do $$
declare
  total int;
begin
  select count(*) into total from post_rollback_assert_log;
  if total <> 30 then
    raise exception 'post-rollback assertion file ran % assertions, ASSERT_TOTAL says 30', total
      using errcode = '22000';
  end if;
  raise notice 'all % post-rollback assertions passed', total;
end
$$;
