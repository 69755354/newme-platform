-- ============================================================================
-- Round-3 closure: one session boundary for the whole definer surface, and the
-- money invariants the routines were still missing
-- ============================================================================
-- NO_ROLLBACK: reverting the session boundary re-admits revoked, banned and
-- stale-token sessions to every SECURITY DEFINER RPC, and reverting money_actor()
-- re-admits a NULL-role actor. There is no way back from this file that does not
-- reopen P0-1 or P1-1, so it ships without a companion rather than with one that
-- undoes the fix. The part of 20260812000000 that DID need a way back — the
-- direct-write refusal that the previous release's application depends on — is
-- separated out below into an expand phase (this file, compatibility default) and
-- a contract phase (20260818000000, which does have a companion). See §0.
--
-- Forward-only: this file modifies no applied migration. It redefines functions
-- introduced by 20260812000000 and 20260813000000 (neither of which has been
-- applied to production) and adds columns and triggers that the previous
-- release's application does not read.
--
-- Every item below was reproduced against a local Postgres 17.10 replay of the
-- floor plus this branch's migrations before it was written. The reproduction
-- and the closing assertion are both in
-- supabase/replay/10_assert_release_contracts.sql.
--
-- ----------------------------------------------------------------------------
-- 1 · The session boundary stopped at the table edge  (P0-1, P1-3)
-- ----------------------------------------------------------------------------
-- 20260813000000 installs RESTRICTIVE policies, and a policy is only consulted
-- for a statement whose privileges are being checked against the table. A
-- SECURITY DEFINER function owned by the database owner is exempt from RLS
-- altogether, so every restrictive policy that file adds is invisible to:
--
--     select public.confirm_payment('<id>', '<self>');
--     select public.delete_lead_atomic('<id>');
--
-- Reproduced: with profiles.password_changed_at = now() and a token whose `iat`
-- was one hour old, `select count(*) from payments` returned 0 rows (the overlay
-- working) while confirm_payment() on the same session returned
-- {"success": true} (the overlay bypassed).
--
-- money_actor() checked is_active and role. It did not look at
-- auth.users.banned_until, at password_changed_at, or at force_password_change,
-- and the non-money definer RPCs — delete_lead_atomic, reassign_lead_atomic,
-- record_lead_contact_atomic, record_lead_note_atomic, transition_lead_stage,
-- reopen_lead_milestone, recomplete_lead_milestone — check none of the five.
--
-- force_password_change had no server-side enforcement at all: it was set by
-- src/app/actions/team.ts and by POST /api/users, reported by /api/auth/login
-- and /api/auth/me, and acted on only by src/hooks/useAuthRedirect.ts:85, a
-- client-side `router.replace`. The session it describes holds ordinary cookies
-- and a valid access token, so PostgREST and every RPC accepted it.
--
-- The closure has two halves, and neither of them is a body rewrite of twenty
-- functions:
--
--   a) assert_current_session() raises a DISTINCT SQLSTATE per boundary, so a
--      test can prove WHICH check refused a call rather than observing a generic
--      42501. money_actor() calls it, which covers all seven money RPCs.
--   b) trg_require_current_session, a BEFORE ... FOR EACH STATEMENT trigger on
--      every ordinary table in `public`, calls it for any statement that carries
--      an end-user identity. current_user is the definer's owner inside a
--      definer routine, but request.jwt.claims is a GUC and is unchanged by it,
--      so auth.uid() inside the trigger is still the real caller. This is what
--      makes the boundary hold for definer RPCs nobody has rewritten, including
--      ones a later migration adds.
--
-- Statement-level, not row-level: it is an authorization decision about the
-- session, identical for every row, and it must also fire for a statement that
-- matches no rows.
--
-- ----------------------------------------------------------------------------
-- 2 · What else this file closes
-- ----------------------------------------------------------------------------
-- P1-1  money_actor() rejected a role with `not (v_role = any (allowed))`. With
--       profiles.role NULL — the column is nullable — that expression is NULL,
--       not true, so `if not (...) then raise` never fired. Reproduced: a
--       NULL-role profile was ACCEPTED for array['admin','boss'].
-- P1-2  The guard triggers covered INSERT and UPDATE. DELETE was granted to
--       authenticated, the permissive policies were FOR ALL, and
--       payment_allocations.payment_id is ON DELETE CASCADE. Reproduced: an
--       admin session DELETEd a confirmed payment; its allocation row vanished
--       while installment_plans.allocated_amount stayed at 50000.00 and
--       projects.paid_amount stayed at 70000.00.
-- P1-4  create_contract() accepted any lead_id and never read leads.assigned_to.
--       Reproduced: sales1 created NEW-20260811-008 against sales2's lead and
--       consumed that lead's one active-contract slot.
-- P1-5  The convert dialog POSTs with no body, the route turns that into
--       installments: [], and the loop over an empty array creates no rows.
--       Reproduced: installments_count 0, one approval row, the quotation marked
--       contract_created — and the direct repair insert is refused by
--       trg_guard_installment_plans_write, so nothing could fix it afterwards.
-- P1-6  The project and activity rows were written by the route AFTER the RPC
--       committed, and a failure became a `warnings` entry on a 200. The exact
--       retry then raised 23505 'quotation is already converted' (reproduced),
--       so the missing rows could not be created by repeating the request.
-- P1-7  allocate_payment() locked the payment and recomputed each plan's total
--       with an unlocked SUM. Reproduced with two concurrent sessions allocating
--       100 and 200 to plan 9111...1111: both returned success,
--       allocated_amount was 200.00 and sum(amount_allocated) was 300.00.
-- P1-8  revoke_contract() rejected only 'superseded' and 'revoking', so a
--       completed contract could be moved back to 'revoking' (reproduced), and
--       set_contract_status() carried the same NULL-role hole as money_actor().
-- P1-9  confirm_payment() and allocate_payment() allowed 'operator', while the
--       routes, the server actions and their RBAC headers all say
--       admin/boss/finance. Reproduced: an operator session confirmed and
--       allocated a payment through the RPCs that POST /api/payments/[id]/confirm
--       refuses. The product rule kept is the documented one — admin, boss,
--       finance — and src/app/(dashboard)/payments/page.tsx no longer offers the
--       buttons to operator.
--
-- ----------------------------------------------------------------------------
-- 3 · P0-2: the rollback boundary, and why this file is the expand phase
-- ----------------------------------------------------------------------------
-- 20260812000000 declared NO_ROLLBACK and accepted that the previous release
-- would take 42501 on its direct writes. Reproduced against this branch's schema
-- as the `authenticated` role, all three of the previous release's direct money
-- paths are refused:
--
--   contracts INSERT              -> 'contracts are created through create_contract()...'
--   installment_plans INSERT      -> 'installment plans are created with their contract...'
--   payments confirm UPDATE       -> 'payment confirmation, amount and linkage change through...'
--
-- Production runs f37c203 and the PR base is 81956f2; both use those writes. So
-- "roll back the application" was not a rollback: it produced a release the old
-- application cannot write through, and the declared recovery was roll-forward
-- wearing a rollback's name.
--
-- This file makes the refusal a two-phase change with a real compatibility
-- window:
--
--   expand   (this file)     public.money_direct_write_mode() = 'compat'.
--                            The column and insert guards stand down for direct
--                            end-user writes, so the previous release AND the
--                            candidate release both work. Every other closure in
--                            this file — actor identity, the session boundary,
--                            the NULL-role refusal, DELETE closure, the
--                            transition graph, lead ownership, the installment
--                            invariant — is unconditional and applies in both
--                            modes.
--   deploy                   the candidate application, which writes money rows
--                            only through the RPCs.
--   contract (20260818000000) mode = 'strict'. Direct end-user money writes are
--                            refused. This is the point after which the previous
--                            release can no longer write, and it is therefore a
--                            separate, separately reversible step.
--
-- rollback_money_direct_write_contract_phase.sql returns the mode to 'compat',
-- which restores exactly the posture production has today — no more, no less —
-- and leaves every authorization fix in place. supabase/replay/20_assert_post_rollback.sql
-- asserts both halves of that: the previous release's direct writes work again,
-- and none of the authorization closures came back off.
--
-- The compatibility window is not free, and the cost is stated rather than
-- hidden: while the mode is 'compat', a browser session can still write
-- contracts.status and payments.confirmed directly, exactly as it can in
-- production today. That is the pre-existing exposure, it is not a regression
-- introduced here, and closing it is the contract phase — a production action
-- that needs its own authorisation and is tracked as unfinished on TASKBOARD.
--
-- ----------------------------------------------------------------------------
-- 4 · What this file deliberately does NOT do
-- ----------------------------------------------------------------------------
--   * It does not ban an Auth identity, delete a session or rotate a
--     credential. F-02 stays open; supabase/preflight/f02-credential-cutover.md
--     is the authorised procedure.
--   * It does not close refresh-token replay. A refresh token minted before a
--     password change still produces a fresh `iat`. Only GoTrue can revoke one.
--   * It does not flip the direct-write mode to 'strict'. See §3.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0 · The expand/contract switch  (P0-2)
-- ---------------------------------------------------------------------------
-- One row, definer-only, and an audited setter. Not a GUC: a GUC can be set by
-- the session it is meant to constrain, and `set role authenticated` does not
-- prevent `set money.direct_write_mode = 'compat'`.
create table if not exists public.money_release_mode (
  id                text        not null default 'only' primary key,
  direct_write_mode text        not null default 'compat',
  reason            text,
  changed_by        uuid,
  changed_at        timestamptz not null default now(),
  constraint money_release_mode_singleton check (id = 'only'),
  constraint money_release_mode_known     check (direct_write_mode in ('compat', 'strict'))
);

alter table public.money_release_mode enable row level security;
-- No policies at all: the table is definer-only, like contract_no_counters.
revoke all on public.money_release_mode from public, anon, authenticated;
grant select, insert, update on public.money_release_mode to service_role;

insert into public.money_release_mode (id, direct_write_mode, reason)
values ('only', 'compat',
        'expand phase: the previous release writes money rows directly, so the '
        || 'column and insert guards stand down until the contract phase')
on conflict (id) do nothing;

comment on table public.money_release_mode is
  'Expand/contract switch for direct end-user money writes. compat = the previous release can still write directly (rollback boundary); strict = only the money RPCs may write. Changed through money_set_direct_write_mode().';

create or replace function public.money_direct_write_mode()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  -- Fails closed: an absent row means strict, so a truncated or half-migrated
  -- table cannot silently reopen direct writes.
  select coalesce((select m.direct_write_mode from public.money_release_mode m where m.id = 'only'),
                  'strict')
$$;

comment on function public.money_direct_write_mode() is
  'compat or strict. Defaults to strict when the row is missing, so losing the row closes writes rather than opening them.';

create or replace function public.money_set_direct_write_mode(p_mode text, p_reason text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_mode not in ('compat', 'strict') then
    raise exception 'mode must be compat or strict, got %', coalesce(p_mode, 'null')
      using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to change the direct write mode' using errcode = '22023';
  end if;

  insert into public.money_release_mode (id, direct_write_mode, reason, changed_by, changed_at)
  values ('only', p_mode, btrim(p_reason), v_actor, now())
  on conflict (id) do update
     set direct_write_mode = excluded.direct_write_mode,
         reason            = excluded.reason,
         changed_by        = excluded.changed_by,
         changed_at        = excluded.changed_at;

  return p_mode;
end
$$;

-- CHANGING the posture stays service_role only: an end-user session must not be
-- able to widen or narrow it in either direction.
--
-- READING it is granted to `authenticated`, and the reason is a bug this file
-- reproduced rather than a preference. See money_direct_write_is_blocked() below.
revoke all on function public.money_direct_write_mode()             from public, anon, authenticated;
revoke all on function public.money_set_direct_write_mode(text, text) from public, anon, authenticated;
grant execute on function public.money_direct_write_mode()             to authenticated, service_role;
grant execute on function public.money_set_direct_write_mode(text, text) to service_role;

-- The discriminator the guards use for their column and insert checks. DELETE is
-- deliberately NOT routed through here: no release of this application has ever
-- deleted a contract, payment, installment plan, approval or allocation from a
-- browser session (verified across 81956f2 — the only `.delete()` calls are on
-- leads, quotations, kpi_targets, notifications, funnel snapshots and lead
-- contacts), so closing DELETE costs no compatibility and is unconditional.
--
-- SECURITY INVOKER, and that is load-bearing. The first revision of this function
-- was SECURITY DEFINER so that it could read money_release_mode without granting
-- `authenticated` anything — and that silently disabled the entire strict posture.
-- Inside a definer function `current_user` is the OWNER, so the
-- money_write_is_direct() call underneath it answered "postgres, not a direct
-- write" for every browser statement, the wrapper returned false, and every guard
-- took its compatibility path. Reproduced against a replayed schema with the
-- contract phase applied: `set local role authenticated` then a direct
-- `insert into public.contracts` returned INSERT 0 1 with mode = 'strict'.
--
-- So the discriminator has to be evaluated in the invoker's context, which means
-- this function must be invoker, which means `authenticated` needs EXECUTE on the
-- mode reader. That grant leaks one thing — whether the release is past its
-- contract phase — which every refusal message already tells the same caller.
-- supabase/replay/10_assert_release_contracts.sql asserts both halves: that
-- current_user still discriminates through this wrapper, and that a direct insert
-- is actually refused under strict.
create or replace function public.money_direct_write_is_blocked()
returns boolean
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select public.money_write_is_direct() and public.money_direct_write_mode() = 'strict'
$$;

comment on function public.money_direct_write_is_blocked() is
  'True when this statement is a direct end-user write AND the release is past the contract phase. The column and insert guards use this; the DELETE refusals do not, because no release ever deleted these rows from a session.';

revoke all on function public.money_direct_write_is_blocked() from public, anon;
grant execute on function public.money_direct_write_is_blocked() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1 · The session boundary, as one function with named outcomes
-- ---------------------------------------------------------------------------
-- One reason string per refusal, one SQLSTATE per refusal. Class 28 is
-- "invalid authorization specification", which is what every one of these is:
-- the session, not the operation, is what is being rejected. src/lib/money-rpc.mjs
-- maps the whole class to 401 so a revoked session is told to re-authenticate
-- instead of being told it lacks a permission it might later be granted.
--
--   28001  no session identity in the request
--   28002  the session's profile row does not exist
--   28003  the profile is deactivated
--   28004  the Auth identity is banned
--   28005  the access token predates the last password change
--   28006  a password change is required before anything else
--
-- Ordered from the most fundamental to the most specific, so the code a caller
-- sees names the first thing that is actually wrong.
create or replace function public.session_boundary_state()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select case
    when auth.uid() is null then 'no_session'
    when not exists (select 1 from public.profiles p where p.id = auth.uid()) then 'no_profile'
    when not coalesce((select p.is_active from public.profiles p where p.id = auth.uid()), false)
      then 'inactive'
    when exists (
      select 1 from auth.users u
       where u.id = auth.uid() and u.banned_until is not null and u.banned_until > now()
    ) then 'banned'
    when not exists (select 1 from auth.users u where u.id = auth.uid()) then 'no_profile'
    when nullif(auth.jwt() ->> 'iat', '') is null then 'token_stale'
    when to_timestamp((auth.jwt() ->> 'iat')::bigint)
         < coalesce((select p.password_changed_at from public.profiles p where p.id = auth.uid()),
                    '-infinity'::timestamptz)
      then 'token_stale'
    when coalesce((select p.force_password_change from public.profiles p where p.id = auth.uid()), false)
      then 'password_change_required'
    else 'ok'
  end
$$;

comment on function public.session_boundary_state() is
  'The single verdict on the calling session: ok, no_session, no_profile, inactive, banned, token_stale or password_change_required. Fails closed on a missing profile, a missing auth.users row and an absent iat claim.';

create or replace function public.assert_current_session()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_state text := public.session_boundary_state();
begin
  case v_state
    when 'ok' then
      return;
    when 'no_session' then
      raise exception 'session boundary: no session identity in this request'
        using errcode = '28001';
    when 'no_profile' then
      raise exception 'session boundary: this session has no profile'
        using errcode = '28002';
    when 'inactive' then
      raise exception 'session boundary: this account is deactivated'
        using errcode = '28003';
    when 'banned' then
      raise exception 'session boundary: this identity is banned'
        using errcode = '28004';
    when 'token_stale' then
      raise exception 'session boundary: this access token predates the last credential change'
        using errcode = '28005';
    when 'password_change_required' then
      raise exception 'session boundary: a password change is required before this operation'
        using errcode = '28006';
    else
      -- Unreachable by construction, and therefore the one case that must not
      -- fall through to a success: an unknown verdict is a refusal.
      raise exception 'session boundary: unknown session state %', v_state
        using errcode = '28000';
  end case;
end
$$;

comment on function public.assert_current_session() is
  'Raises a class-28 SQLSTATE naming the exact boundary that refused the calling session, or returns quietly when the session is current. 28001 no session, 28002 no profile, 28003 inactive, 28004 banned, 28005 stale token, 28006 password change required.';

revoke all on function public.session_boundary_state() from public, anon;
revoke all on function public.assert_current_session() from public, anon;
grant execute on function public.session_boundary_state() to authenticated, service_role;
grant execute on function public.assert_current_session() to authenticated, service_role;

-- The two predicates 20260813000000 installed, restated in terms of the single
-- verdict so the policy overlay and the RPC boundary cannot drift apart.
--
-- session_token_is_current() now also refuses a session that owes a password
-- change. That is the P1-3 boundary: the change-password route authenticates
-- through GoTrue and writes through the service key, so it keeps working, and
-- the profiles relaxation below keeps /api/auth/me able to tell the user why.
create or replace function public.session_identity_enabled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.session_boundary_state() in ('ok', 'token_stale', 'password_change_required')
$$;

comment on function public.session_identity_enabled() is
  'True when the calling session belongs to an active, unbanned identity with a profile. Ignores token staleness and a pending password change, which session_token_is_current() covers.';

create or replace function public.session_token_is_current()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.session_boundary_state() = 'ok'
$$;

comment on function public.session_token_is_current() is
  'True only for a session whose profile is active, whose identity is not banned, whose access token postdates the last password change, and which does not owe a password change.';

-- ---------------------------------------------------------------------------
-- 2 · The same boundary for every write, whoever runs it
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER on purpose, exactly like the trg_guard_* functions: it must
-- not acquire the owner's rights, it only needs the request GUC.
--
-- The condition is `auth.uid() is not null`, i.e. "this statement carries an
-- end-user identity". A service_role token has no subject and a psql or pg_cron
-- session has no request settings at all, so trusted server paths are
-- unaffected — they are authorised by holding the key, not by a session.
create or replace function public.require_current_session()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    perform public.assert_current_session();
  end if;
  return null;
end
$$;

comment on function public.require_current_session() is
  'BEFORE ... FOR EACH STATEMENT guard: any statement carrying an end-user identity must come from a current session. Applies inside SECURITY DEFINER routines, which RLS does not reach.';

do $do$
declare
  r       record;
  applied int := 0;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and not c.relispartition
     order by 1
  loop
    execute format('drop trigger if exists trg_require_current_session on public.%I', r.relname);
    execute format(
      'create trigger trg_require_current_session '
      || 'before insert or update or delete on public.%I '
      || 'for each statement execute function public.require_current_session()',
      r.relname);
    applied := applied + 1;
  end loop;

  if applied = 0 then
    raise exception 'the session write boundary matched no tables, which cannot be right; refusing to report success'
      using errcode = '22000';
  end if;
  raise notice 'session write boundary applied to % table(s)', applied;
end
$do$;

-- next_quote_no() is called from the browser with the caller's own token
-- (src/app/(dashboard)/quotes/quote-wizard.tsx:217) and writes nothing, so the
-- statement trigger above never sees it. It reads every quotation as the owner,
-- which is the point of the function and also a disclosure, so it gets the
-- boundary directly. The body is carried over unchanged from
-- 20260624000000_next_quote_no_rpc.sql; search_path is pinned properly while we
-- are here (it was `public` alone).
create or replace function public.next_quote_no()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_year text := to_char(now(), 'YYYY');
  v_max  int;
  v_next int;
begin
  perform public.assert_current_session();

  select coalesce(max(cast(split_part(quote_no, '-', 3) as int)), 0)
    into v_max
    from public.quotations
   where quote_no like 'NM-' || v_year || '-%';

  v_next := v_max + 1;
  return 'NM-' || v_year || '-' || lpad(v_next::text, 4, '0');
end
$$;

revoke all on function public.next_quote_no() from public, anon;
grant execute on function public.next_quote_no() to authenticated, service_role;

-- get_my_role() is deliberately NOT gated. It is called from inside the
-- profiles, contracts and payments POLICIES (20260701000004_fix_profiles_rls_recursion.sql:55
-- and others); raising inside a policy expression turns every read on those
-- tables into an error instead of an empty result, and revoking EXECUTE from
-- authenticated would make the policies unevaluable. It discloses the caller's
-- own role and nothing else, and the restrictive overlay still decides what the
-- caller may then read.

-- ---------------------------------------------------------------------------
-- 3 · money_actor: the session boundary, and a NULL role is not an allowed role
-- ---------------------------------------------------------------------------
create or replace function public.money_actor(p_claimed uuid, p_allowed_roles text[])
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_jwt_uid  uuid := auth.uid();
  v_jwt_role text := auth.role();
  v_actor    uuid;
  v_role     text;
  v_active   boolean;
begin
  if v_jwt_uid is not null then
    -- End-user request. Before anything else: is this session still one?
    -- Deactivation, an Auth ban, a password change and a pending forced change
    -- are all refusals here, each with its own SQLSTATE.
    perform public.assert_current_session();

    -- The subject of the token is the actor, always. A parameter is accepted
    -- only when it agrees with the token.
    if p_claimed is not null and p_claimed <> v_jwt_uid then
      raise exception 'actor identity does not match the session'
        using errcode = '42501';
    end if;
    v_actor := v_jwt_uid;
  elsif v_jwt_role = 'service_role' or (v_jwt_role is null and auth.jwt() is null) then
    -- Trusted server context: service_role tokens carry no subject, and a psql
    -- or pg_cron session carries no request settings at all.
    if p_claimed is null then
      raise exception 'actor id is required when there is no session identity'
        using errcode = '22023';
    end if;
    v_actor := p_claimed;
  else
    -- A token that is neither a subject-bearing user token nor service_role.
    -- Fail closed rather than guess.
    raise exception 'no usable session identity' using errcode = '42501';
  end if;

  select p.role, coalesce(p.is_active, false)
    into v_role, v_active
    from public.profiles p
   where p.id = v_actor;

  if not found then
    raise exception 'actor has no profile' using errcode = '42501';
  end if;
  if not v_active then
    raise exception 'actor account is not active' using errcode = '42501';
  end if;

  -- profiles.role is nullable, and `not (NULL = any (array[...]))` is NULL, not
  -- true — so `if not (...) then raise` did not fire and a NULL-role profile was
  -- accepted for every operation. The NULL case is now its own refusal, before
  -- the membership test can be reached with a NULL left-hand side.
  if p_allowed_roles is not null and array_length(p_allowed_roles, 1) is not null then
    if v_role is null then
      raise exception 'actor has no role and may not perform this operation'
        using errcode = '42501';
    end if;
    if not (v_role = any (p_allowed_roles)) then
      raise exception 'role % may not perform this operation', v_role
        using errcode = '42501';
    end if;
  end if;

  return v_actor;
end
$$;

-- ---------------------------------------------------------------------------
-- 4 · DELETE is not a money operation  (P1-2)
-- ---------------------------------------------------------------------------
-- The reversal path, and the columns it needs. Expand-only: nothing reads them
-- yet, so the previous release is unaffected by their presence.
alter table public.payments
  add column if not exists voided_at   timestamptz,
  add column if not exists voided_by   uuid references public.profiles(id),
  add column if not exists void_reason text;

comment on column public.payments.voided_at is
  'Set by void_payment(). A voided payment keeps its row: the reversal is recorded, not erased.';

-- Two of the five guard functions returned early for DELETE or were not attached
-- to it at all. A confirmed payment is a record of money received and an
-- approved contract is a record of a decision; neither is deletable from a
-- browser session, and the reversal that IS supported recomputes every derived
-- total in the same transaction.
create or replace function public.guard_contracts_write()
returns trigger
language plpgsql
as $$
begin
  -- DELETE first, and unconditionally: it is refused in both release modes,
  -- because deleting a contract cascades installment_plans, payments,
  -- payment_allocations and contract_approvals, and leaves projects and
  -- kpi_targets holding its amounts — and no release of this application has
  -- ever issued it from a session, so refusing it costs no compatibility.
  -- Termination is the supported end state.
  if public.money_write_is_direct() and tg_op = 'DELETE' then
    raise exception 'contracts are not deleted; terminate the contract through set_contract_status() instead'
      using errcode = '42501';
  end if;

  -- The column and insert boundary, which the expand phase stands down so the
  -- previous release keeps working at the rollback boundary. See §0 and §3.
  if not public.money_direct_write_is_blocked() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'contracts are created through create_contract(); direct insert is not permitted'
      using errcode = '42501';
  end if;

  if new.status        is distinct from old.status
     or new.contract_amount is distinct from old.contract_amount
     or new.contract_no     is distinct from old.contract_no
     or new.sales_id        is distinct from old.sales_id
     or new.created_by      is distinct from old.created_by
     or new.lead_id         is distinct from old.lead_id
     or new.quotation_id    is distinct from old.quotation_id
     or new.currency        is distinct from old.currency
     or new.contract_date   is distinct from old.contract_date then
    raise exception 'contract status, amount, number, ownership and dates change through approve_contract(), set_contract_status() or revoke_contract()'
      using errcode = '42501';
  end if;

  return new;
end
$$;

create or replace function public.guard_payments_write()
returns trigger
language plpgsql
as $$
begin
  -- Unconditional, both release modes: payment_allocations.payment_id is
  -- ON DELETE CASCADE, so this delete silently removed allocation rows while
  -- installment_plans.allocated_amount, projects.paid_amount and
  -- kpi_targets.actual_amount kept the deleted amount. Reproduced before this
  -- change; void_payment() is the reversal.
  if public.money_write_is_direct() and tg_op = 'DELETE' then
    raise exception 'payments are not deleted; reverse the payment through void_payment() instead'
      using errcode = '42501';
  end if;

  -- Also unconditional: the void columns are new in this release, so no version
  -- of the application writes them directly and standing this check down during
  -- the compatibility window would buy nothing and cost the reversal's integrity.
  if public.money_write_is_direct() then
    if tg_op = 'INSERT' and (new.voided_at is not null or new.voided_by is not null
                             or new.void_reason is not null) then
      raise exception 'void fields are set by void_payment()' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.voided_at is distinct from old.voided_at
                             or new.voided_by is distinct from old.voided_by
                             or new.void_reason is distinct from old.void_reason) then
      raise exception 'a payment is voided through void_payment()' using errcode = '42501';
    end if;
  end if;

  if not public.money_direct_write_is_blocked() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.confirmed, false) then
      raise exception 'a payment cannot be created already confirmed; use confirm_payment()'
        using errcode = '42501';
    end if;
    if new.confirmed_by is not null or new.confirmed_at is not null then
      raise exception 'confirmation fields are set by confirm_payment()'
        using errcode = '42501';
    end if;
    if new.created_by is distinct from auth.uid() then
      raise exception 'created_by must be the session identity' using errcode = '42501';
    end if;
    return new;
  end if;

  if coalesce(old.confirmed, false) then
    if new.amount              is distinct from old.amount
       or new.confirmed        is distinct from old.confirmed
       or new.confirmed_by     is distinct from old.confirmed_by
       or new.confirmed_at     is distinct from old.confirmed_at
       or new.contract_id      is distinct from old.contract_id
       or new.installment_plan_id is distinct from old.installment_plan_id
       or new.created_by       is distinct from old.created_by
       or new.payment_date     is distinct from old.payment_date
       or new.payment_method   is distinct from old.payment_method
       or new.reference_no     is distinct from old.reference_no
       or new.currency         is distinct from old.currency then
      raise exception 'a confirmed payment is immutable except for notes'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.confirmed    is distinct from old.confirmed
     or new.confirmed_by is distinct from old.confirmed_by
     or new.confirmed_at is distinct from old.confirmed_at
     or new.amount       is distinct from old.amount
     or new.contract_id  is distinct from old.contract_id
     or new.installment_plan_id is distinct from old.installment_plan_id
     or new.created_by   is distinct from old.created_by then
    raise exception 'payment confirmation, amount and linkage change through confirm_payment() and allocate_payment()'
      using errcode = '42501';
  end if;

  return new;
end
$$;

-- The other three guards get the same treatment: the mode controls their
-- INSERT/UPDATE checks so the previous release keeps working during the
-- compatibility window, and their DELETE refusals are unconditional.
create or replace function public.guard_installment_plans_write()
returns trigger
language plpgsql
as $$
begin
  if public.money_write_is_direct() and tg_op = 'DELETE' then
    raise exception 'installment plans are not deleted directly' using errcode = '42501';
  end if;

  if not public.money_direct_write_is_blocked() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'installment plans are created with their contract; direct insert is not permitted'
      using errcode = '42501';
  end if;

  if new.amount is distinct from old.amount
     or new.allocated_amount is distinct from old.allocated_amount
     or new.status      is distinct from old.status
     or new.contract_id is distinct from old.contract_id
     or new.seq         is distinct from old.seq then
    raise exception 'installment amount, allocation and status change through allocate_payment()'
      using errcode = '42501';
  end if;

  return new;
end
$$;

create or replace function public.guard_definer_only_write()
returns trigger
language plpgsql
as $$
begin
  if public.money_write_is_direct() and tg_op = 'DELETE' then
    raise exception '% rows are not deleted', tg_table_name using errcode = '42501';
  end if;

  if not public.money_direct_write_is_blocked() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  raise exception '% is written only through the money routines', tg_table_name
    using errcode = '42501';
end
$$;

drop trigger if exists trg_guard_contracts_write on public.contracts;
create trigger trg_guard_contracts_write
  before insert or update or delete on public.contracts
  for each row execute function public.guard_contracts_write();

drop trigger if exists trg_guard_payments_write on public.payments;
create trigger trg_guard_payments_write
  before insert or update or delete on public.payments
  for each row execute function public.guard_payments_write();

-- Belt as well as braces: the trigger refuses the statement, and the privilege
-- is gone. Either alone would be enough; a future permissive policy cannot
-- re-grant a privilege that was never granted, and a future migration that
-- re-grants it still meets the trigger.
revoke delete on public.contracts           from authenticated, anon;
revoke delete on public.payments            from authenticated, anon;
revoke delete on public.installment_plans   from authenticated, anon;
revoke delete on public.contract_approvals  from authenticated, anon;
revoke delete on public.payment_allocations from authenticated, anon;

-- The supported reversal. One transaction: drop the allocations, mark the
-- payment voided, and recompute every total that quoted it — the installment
-- plans it fed, the project's paid_amount and the collection KPI. This is the
-- operation whose absence made a DELETE look like the only way to undo a
-- mistaken confirmation.
create or replace function public.void_payment(
  p_payment_id uuid,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor       uuid;
  v_payment     record;
  v_contract    record;
  v_plan_id     uuid;
  v_affected    uuid[];
  v_allocated   numeric(12, 2);
  v_plan_amount numeric(12, 2);
  v_total_paid  numeric(12, 2);
  v_released    integer := 0;
begin
  v_actor := public.money_actor(null, array['admin', 'boss', 'finance']);

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to void a payment' using errcode = '22023';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'payment is already voided' using errcode = '23505';
  end if;

  select * into v_contract from public.contracts where id = v_payment.contract_id for update;

  -- Same stable order as allocate_payment(), for the same reason.
  select coalesce(array_agg(distinct plan_id order by plan_id), '{}')
    into v_affected
    from public.payment_allocations
   where payment_id = p_payment_id;

  if array_length(v_affected, 1) is not null then
    perform 1 from public.installment_plans
      where id = any (v_affected)
      order by id
      for update;
  end if;

  delete from public.payment_allocations where payment_id = p_payment_id;

  update public.payments
     set confirmed    = false,
         voided_at    = now(),
         voided_by    = v_actor,
         void_reason  = btrim(p_reason),
         updated_at   = now()
   where id = p_payment_id;

  foreach v_plan_id in array coalesce(v_affected, '{}'::uuid[]) loop
    select coalesce(sum(pa.amount_allocated), 0)
      into v_allocated
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
     where pa.plan_id = v_plan_id and p.confirmed = true and p.voided_at is null;
    select amount into v_plan_amount from public.installment_plans where id = v_plan_id;

    update public.installment_plans
       set allocated_amount = v_allocated,
           status = case
             when v_allocated >= v_plan_amount then 'paid'
             when v_allocated > 0              then 'partial'
             else 'pending'
           end,
           updated_at = now()
     where id = v_plan_id;
    v_released := v_released + 1;
  end loop;

  select coalesce(sum(p.amount), 0)
    into v_total_paid
    from public.payments p
   where p.contract_id = v_payment.contract_id
     and p.confirmed = true
     and p.voided_at is null;

  if to_regclass('public.projects') is not null then
    update public.projects
       set paid_amount = v_total_paid, updated_at = now()
     where contract_id = v_payment.contract_id;
  end if;

  if v_contract.id is not null and coalesce(v_payment.confirmed, false) then
    update public.kpi_targets
       set actual_amount = greatest(coalesce(actual_amount, 0) - v_payment.amount, 0),
           updated_at    = now()
     where assigned_to = v_contract.sales_id
       and period      = to_char(v_payment.payment_date, 'YYYY-MM')
       and target_type = 'collection';
  end if;

  -- first_payment_status follows the same recomputation as confirm_payment().
  update public.contracts c
     set first_payment_status = case
           when fp.allocated >= fp.amount then 'paid'
           when fp.allocated > 0          then 'partial'
           else 'unpaid'
         end,
         updated_at = now()
    from (
      select ip.id, ip.amount,
             coalesce((select sum(pa.amount_allocated)
                         from public.payment_allocations pa
                         join public.payments p on p.id = pa.payment_id
                        where pa.plan_id = ip.id and p.confirmed = true and p.voided_at is null), 0)
               as allocated
        from public.installment_plans ip
       where ip.contract_id = v_payment.contract_id and ip.seq = 1
       order by ip.created_at asc, ip.id asc
       limit 1
    ) fp
   where c.id = v_payment.contract_id;

  return jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'amount',            v_payment.amount,
    'plans_recomputed',  v_released,
    'contract_total_paid', v_total_paid,
    'actor_id',          v_actor
  );
end
$$;

revoke all on function public.void_payment(uuid, text) from public, anon;
grant execute on function public.void_payment(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5 · The contract transition graph, in one place  (P1-8)
-- ---------------------------------------------------------------------------
-- revoke_contract() rejected exactly two statuses, so 'completed' -> 'revoking'
-- was permitted (reproduced), and set_contract_status()'s if/elsif chain was the
-- only other description of the graph. One function now answers "is this
-- transition legal", every writer consults it, and a trigger on contracts
-- enforces it for every writer including a future one.
create or replace function public.contract_transition_is_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
as $$
  select p_from is not null
     and p_to is not null
     and (p_from, p_to) in (
       -- submission and the approval chain
       ('draft',         'pending_admin'),
       ('rejected',      'pending_admin'),
       ('rejected',      'draft'),
       ('pending_admin', 'pending_ceo'),
       ('pending_admin', 'rejected'),
       ('pending_ceo',   'approved'),
       ('pending_ceo',   'rejected'),
       -- the live contract
       ('approved',      'active'),
       ('active',        'completed'),
       ('active',        'suspended'),
       ('suspended',     'active'),
       -- ending it
       ('approved',      'terminated'),
       ('active',        'terminated'),
       ('suspended',     'terminated'),
       ('revoking',      'terminated'),
       -- revocation and replacement
       ('approved',      'revoking'),
       ('active',        'revoking'),
       ('suspended',     'revoking'),
       ('approved',      'superseded'),
       ('active',        'superseded'),
       ('suspended',     'superseded'),
       ('revoking',      'superseded')
     )
$$;

comment on function public.contract_transition_is_allowed(text, text) is
  'The whole contract status graph. completed, terminated and superseded are terminal: no pair leaves them.';

create or replace function public.guard_contract_transition()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if not public.contract_transition_is_allowed(old.status, new.status) then
    raise exception '% is not a permitted transition from %', new.status, old.status
      using errcode = '22023';
  end if;
  return new;
end
$$;

drop trigger if exists trg_guard_contract_transition on public.contracts;
create trigger trg_guard_contract_transition
  before update of status on public.contracts
  for each row execute function public.guard_contract_transition();

create or replace function public.set_contract_status(
  p_contract_id uuid,
  p_status      text,
  p_reason      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_contract record;
  v_actor    uuid;
  v_role     text;
  v_is_owner boolean;
begin
  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'contract not found' using errcode = 'P0002';
  end if;

  v_actor := public.money_actor(null, array['admin', 'boss', 'operator', 'finance', 'sales']);
  select role into v_role from public.profiles where id = v_actor;
  -- money_actor() has already refused a NULL role against that list, so v_role
  -- is non-null here; the coalesce is what keeps every `not in` below from
  -- evaluating to NULL if that ever stops being true.
  v_role     := coalesce(v_role, '');
  v_is_owner := v_contract.sales_id = v_actor;

  -- The approval statuses are not reachable here: 'approved' and 'pending_ceo'
  -- belong to approve_contract(), and 'superseded' to revoke_contract().
  if p_status not in ('draft', 'pending_admin', 'active', 'completed', 'suspended', 'terminated') then
    raise exception '% is not a status this operation may set', p_status
      using errcode = '22023';
  end if;
  if not public.contract_transition_is_allowed(v_contract.status, p_status) then
    raise exception '% is not a permitted transition from %', p_status, v_contract.status
      using errcode = '22023';
  end if;

  if p_status in ('draft', 'pending_admin') then
    if not (v_is_owner or v_role in ('admin', 'boss', 'operator')) then
      raise exception 'only the contract owner or a manager may submit or reopen a contract'
        using errcode = '42501';
    end if;
  elsif p_status in ('active', 'completed') then
    if v_role not in ('admin', 'boss', 'operator', 'finance') then
      raise exception 'only a manager may activate or complete a contract' using errcode = '42501';
    end if;
  elsif p_status = 'suspended' then
    if v_role not in ('admin', 'boss') then
      raise exception 'only admin or boss may suspend a contract' using errcode = '42501';
    end if;
  else
    -- terminated
    if v_role not in ('admin', 'boss') then
      raise exception 'only admin or boss may terminate a contract' using errcode = '42501';
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'a reason is required to terminate a contract' using errcode = '22023';
    end if;
  end if;

  if p_status = 'terminated' then
    update public.contracts
       set status = p_status, terminated_reason = p_reason, terminated_at = now(), updated_at = now()
     where id = p_contract_id;
  else
    update public.contracts
       set status = p_status, updated_at = now()
     where id = p_contract_id;
  end if;

  return jsonb_build_object(
    'success',         true,
    'id',              p_contract_id,
    'previous_status', v_contract.status,
    'status',          p_status,
    'actor_id',        v_actor
  );
end
$$;

create or replace function public.revoke_contract(
  p_contract_id uuid,
  p_reason      text,
  p_supersede   boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_contract   record;
  v_actor      uuid;
  v_new_status text;
begin
  v_actor := public.money_actor(null, array['admin', 'boss']);

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;

  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'contract not found' using errcode = 'P0002';
  end if;

  v_new_status := case when coalesce(p_supersede, false) then 'superseded' else 'revoking' end;

  -- Was: reject only 'superseded' and 'revoking'. A completed, terminated or
  -- not-yet-approved contract was revocable, which is how 'completed' ->
  -- 'revoking' happened.
  if not public.contract_transition_is_allowed(v_contract.status, v_new_status) then
    raise exception 'a % contract cannot be moved to %', v_contract.status, v_new_status
      using errcode = '22023';
  end if;

  update public.contracts
     set status = v_new_status, updated_at = now()
   where id = p_contract_id;

  return jsonb_build_object(
    'success',         true,
    'id',              p_contract_id,
    'previous_status', v_contract.status,
    'status',          v_new_status,
    'contract_no',     v_contract.contract_no,
    'sales_id',        v_contract.sales_id,
    'actor_id',        v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 6 · Payment permissions: one rule  (P1-9)
-- ---------------------------------------------------------------------------
-- The documented rule wins. src/app/api/payments/[id]/confirm/route.ts,
-- src/app/api/payments/[id]/allocate/route.ts and src/app/actions/payments.ts
-- all say admin/boss/finance in code and in their RBAC headers; only the two
-- RPCs said operator as well, and an operator session used that to confirm and
-- allocate a payment the HTTP routes refuse.
create or replace function public.confirm_payment(
  p_payment_id   uuid,
  p_confirmer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_payment              record;
  v_contract             record;
  v_contract_found       boolean := false;
  v_actor                uuid;
  v_first_plan_id        uuid;
  v_first_plan_amount    numeric(12, 2);
  v_first_plan_allocated numeric(12, 2);
  v_fp_status            text;
  v_total_paid           numeric(12, 2);
begin
  v_actor := public.money_actor(p_confirmer_id, array['admin', 'boss', 'finance']);

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if coalesce(v_payment.confirmed, false) then
    raise exception 'payment is already confirmed' using errcode = '22023';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'a voided payment cannot be confirmed' using errcode = '22023';
  end if;

  select * into v_contract from public.contracts where id = v_payment.contract_id for update;
  v_contract_found := found;

  update public.payments
     set confirmed    = true,
         confirmed_by = v_actor,
         confirmed_at = now(),
         updated_at   = now()
   where id = p_payment_id;

  select id, amount into v_first_plan_id, v_first_plan_amount
    from public.installment_plans
   where contract_id = v_payment.contract_id and seq = 1
   order by created_at asc, id asc
   limit 1;

  if v_first_plan_id is not null then
    select coalesce(sum(pa.amount_allocated), 0)
      into v_first_plan_allocated
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
     where pa.plan_id = v_first_plan_id and p.confirmed = true and p.voided_at is null;

    v_fp_status := case
      when v_first_plan_allocated >= v_first_plan_amount then 'paid'
      when v_first_plan_allocated > 0                    then 'partial'
      else 'unpaid'
    end;

    update public.contracts
       set first_payment_status = v_fp_status, updated_at = now()
     where id = v_payment.contract_id;
  end if;

  if v_contract_found then
    select coalesce(sum(p.amount), 0)
      into v_total_paid
      from public.payments p
     where p.contract_id = v_payment.contract_id
       and p.confirmed = true
       and p.voided_at is null;

    if to_regclass('public.projects') is not null then
      update public.projects
         set paid_amount = v_total_paid, updated_at = now()
       where contract_id = v_payment.contract_id;
    end if;

    update public.kpi_targets
       set actual_amount = actual_amount + v_payment.amount, updated_at = now()
     where assigned_to = v_contract.sales_id
       and period      = to_char(v_payment.payment_date, 'YYYY-MM')
       and target_type = 'collection';
  end if;

  return jsonb_build_object(
    'success',     true,
    'payment_id',  p_payment_id,
    'amount',      v_payment.amount,
    'actor_id',    v_actor,
    'total_paid',  coalesce(v_total_paid, 0)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 7 · allocate_payment: lock every plan it is about to recompute  (P1-7)
-- ---------------------------------------------------------------------------
-- The payment was locked, so two sessions could not allocate the SAME payment
-- concurrently — but two DIFFERENT payments feeding one plan each recomputed
-- `sum(amount_allocated)` from an unlocked read. Both committed, the second
-- update won, and the plan's allocated_amount was less than the sum of its
-- allocations. Reproduced with 100 + 200 against one plan: allocated_amount
-- 200.00, sum 300.00.
--
-- The lock is taken in plan_id order, before any write, over the union of the
-- plans currently allocated to this payment and the plans in the request. Stable
-- order is what keeps two sessions holding overlapping sets from deadlocking.
create or replace function public.allocate_payment(
  p_payment_id   uuid,
  p_allocations  jsonb,
  p_allocated_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_payment         record;
  v_actor           uuid;
  v_total_allocated numeric(12, 2) := 0;
  v_count           integer := 0;
  v_plan_id         uuid;
  v_amount          numeric(12, 2);
  v_affected        uuid[];
  v_plan_allocated  numeric(12, 2);
  v_plan_amount     numeric(12, 2);
begin
  v_actor := public.money_actor(p_allocated_by, array['admin', 'boss', 'finance']);

  -- coalesce, not a bare comparison: jsonb_typeof(NULL) is NULL and
  -- `NULL <> 'array'` is NULL, so a missing key would fall straight through this
  -- test. Same three-valued-logic shape as P1-1.
  if p_allocations is null
     or coalesce(jsonb_typeof(p_allocations), 'null') <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'allocations must be a non-empty array' using errcode = '22023';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if not coalesce(v_payment.confirmed, false) then
    raise exception 'payment must be confirmed before allocation' using errcode = '22023';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'a voided payment cannot be allocated' using errcode = '22023';
  end if;

  for i in 0 .. jsonb_array_length(p_allocations) - 1 loop
    v_total_allocated := v_total_allocated + (p_allocations -> i ->> 'amount')::numeric(12, 2);
  end loop;

  if v_total_allocated > v_payment.amount then
    -- to_char, not '%.2f': plpgsql RAISE has no width or precision specifiers,
    -- so '%.2f' prints the value followed by the literal '.2f'.
    raise exception 'total allocation % exceeds the payment amount %',
      to_char(v_total_allocated, 'FM999999999990.00'),
      to_char(v_payment.amount, 'FM999999999990.00') using errcode = '22023';
  end if;

  -- Every plan this statement will recompute: the ones it is about to release
  -- and the ones it is about to fill.
  select coalesce(array_agg(distinct plan_id), '{}') into v_affected
    from (
      select plan_id from public.payment_allocations where payment_id = p_payment_id
      union
      select (value ->> 'plan_id')::uuid from jsonb_array_elements(p_allocations)
             where nullif(value ->> 'plan_id', '') is not null
    ) s(plan_id);

  -- The row locks the previous version never took. Ordered, so concurrent
  -- callers with overlapping plan sets queue instead of deadlocking.
  if array_length(v_affected, 1) is not null then
    perform 1 from public.installment_plans
      where id = any (v_affected)
      order by id
      for update;
  end if;

  delete from public.payment_allocations where payment_id = p_payment_id;

  for i in 0 .. jsonb_array_length(p_allocations) - 1 loop
    v_plan_id := (p_allocations -> i ->> 'plan_id')::uuid;
    v_amount  := (p_allocations -> i ->> 'amount')::numeric(12, 2);

    if v_plan_id is null then
      raise exception 'each allocation needs a plan_id' using errcode = '22023';
    end if;
    if v_amount is null or v_amount <= 0 then
      raise exception 'each allocation needs a positive amount' using errcode = '22023';
    end if;

    if not exists (
      select 1 from public.installment_plans ip
       where ip.id = v_plan_id and ip.contract_id = v_payment.contract_id
    ) then
      raise exception 'installment plan does not belong to the payment''s contract'
        using errcode = '42501';
    end if;

    insert into public.payment_allocations (payment_id, plan_id, amount_allocated, allocated_by)
    values (p_payment_id, v_plan_id, v_amount, v_actor);

    v_count := v_count + 1;
  end loop;

  foreach v_plan_id in array coalesce(v_affected, '{}'::uuid[]) loop
    -- Only confirmed, unvoided payments count towards a plan, so a plan cannot
    -- be marked paid by a payment that was reversed.
    select coalesce(sum(pa.amount_allocated), 0) into v_plan_allocated
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
     where pa.plan_id = v_plan_id and p.confirmed = true and p.voided_at is null;
    select amount into v_plan_amount
      from public.installment_plans where id = v_plan_id;

    update public.installment_plans
       set allocated_amount = v_plan_allocated,
           status = case
             when v_plan_allocated >= v_plan_amount then 'paid'
             when v_plan_allocated > 0              then 'partial'
             else 'pending'
           end,
           updated_at = now()
     where id = v_plan_id;
  end loop;

  return jsonb_build_object(
    'success',           true,
    'allocations_count', v_count,
    'total_allocated',   v_total_allocated,
    'plans_recomputed',  coalesce(array_length(v_affected, 1), 0),
    'actor_id',          v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 8 · create_contract: a lead belongs to someone  (P1-4)
-- ---------------------------------------------------------------------------
create or replace function public.create_contract(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor       uuid;
  v_role        text;
  v_lead        record;
  v_lead_id     uuid;
  v_amount      numeric(12, 2);
  v_date        date := current_date;
  v_contract_id uuid;
  v_contract_no text;
  v_attempt     integer := 0;
  v_inst        jsonb;
  v_inst_count  integer := 0;
  v_existing    record;
begin
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss', 'operator', 'finance', 'sales']);
  select coalesce(role, '') into v_role from public.profiles where id = v_actor;

  v_lead_id := nullif(p_payload ->> 'lead_id', '')::uuid;
  if v_lead_id is null then
    raise exception 'lead_id is required' using errcode = '22023';
  end if;
  v_amount := nullif(p_payload ->> 'amount', '')::numeric(12, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'a positive amount is required' using errcode = '22023';
  end if;

  -- The check this function never had. It accepted any lead UUID, so a sales
  -- user could create a contract against a colleague's lead — and because there
  -- is one active contract per lead, doing so also took that lead's only slot.
  -- Read with the definer's visibility on purpose: a sales user cannot see
  -- someone else's lead, and a "not found" that really means "not yours" is the
  -- shape that produced a 500 from the unique index instead of a decision.
  select id, assigned_to into v_lead from public.leads where id = v_lead_id;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_role not in ('admin', 'boss', 'operator', 'finance')
     and v_lead.assigned_to is distinct from v_actor then
    raise exception 'only the assigned salesperson or a manager may create a contract for this lead'
      using errcode = '42501';
  end if;

  select id, contract_no into v_existing
    from public.contracts
   where lead_id = v_lead_id
     and status not in ('archived', 'cancelled', 'terminated')
   order by created_at asc
   limit 1;
  if found then
    raise exception 'contract % already exists for this lead', v_existing.contract_no
      using errcode = '23505';
  end if;

  loop
    v_attempt    := v_attempt + 1;
    v_contract_no := public.next_contract_no(v_date);
    begin
      insert into public.contracts (
        lead_id, sales_id, created_by, contract_no, contract_date, contract_amount,
        currency, party_a_name, party_a_contact, party_b_name, status,
        first_payment_due_date
      ) values (
        v_lead_id, v_actor, v_actor, v_contract_no, v_date, v_amount,
        coalesce(nullif(p_payload ->> 'currency', ''), 'AED'),
        coalesce(nullif(p_payload ->> 'party_a_name', ''), 'Unknown'),
        nullif(p_payload ->> 'party_a_contact', ''),
        coalesce(nullif(p_payload ->> 'party_b_name', ''), 'NewMe Smart Home FZCO'),
        'draft',
        nullif(p_payload ->> 'first_payment_due_date', '')::date
      )
      returning id into v_contract_id;
      exit;
    exception
      when unique_violation then
        if v_attempt >= 10 then
          raise;
        end if;
    end;
  end loop;

  if coalesce(jsonb_typeof(p_payload -> 'installments'), 'null') = 'array' then
    for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
      insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
      values (
        v_contract_id,
        coalesce(nullif(v_inst ->> 'seq', '')::integer, v_inst_count + 1),
        coalesce(nullif(v_inst ->> 'amount', '')::numeric(12, 2), 0),
        coalesce(nullif(v_inst ->> 'due_date', '')::date, v_date),
        coalesce(v_inst ->> 'description', ''),
        'pending'
      );
      v_inst_count := v_inst_count + 1;
    end loop;
  end if;

  insert into public.contract_approvals (contract_id, step, status, notes)
  values (v_contract_id, 'admin_review', 'pending', jsonb_build_object('source', 'auto_created'));

  return jsonb_build_object(
    'success',           true,
    'id',                v_contract_id,
    'contract_no',       v_contract_no,
    'status',            'draft',
    'installments_count', v_inst_count,
    'actor_id',          v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 9 · convert_quotation_to_contract: a schedule, and an idempotent retry
-- ---------------------------------------------------------------------------
-- P1-5. A conversion with no schedule is not a conversion. The dialog POSTed
-- with no body, the route made that `installments: []`, and the loop over an
-- empty array produced a contract with no installment plan — which nothing
-- could then repair, because a direct insert into installment_plans is refused.
-- The invariant is checked BEFORE the first write, so a bad request mutates
-- nothing: no contract, no approval row, and the quotation is left convertible.
--
-- P1-6. The project and activity rows move inside this transaction, and an
-- already-converted quotation is no longer an error. Re-running the same request
-- finishes whatever is missing and reports what it found, so the exact retry the
-- route would make after a failure is safe and repairs the derived rows instead
-- of raising 23505 forever.
create or replace function public.convert_quotation_to_contract(
  p_quotation_id uuid,
  p_payload      jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor        uuid;
  v_actor_role   text;
  v_quote        record;
  v_lead         record;
  v_contract     record;
  v_contract_id  uuid;
  v_contract_no  text;
  v_date         date := current_date;
  v_attempt      integer := 0;
  v_inst         jsonb;
  v_inst_count   integer := 0;
  v_inst_total   numeric(12, 2) := 0;
  v_customer_id  uuid;
  v_project_id   uuid;
  v_finalized    text[] := '{}';
begin
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss', 'operator', 'finance', 'sales']);
  select coalesce(role, '') into v_actor_role from public.profiles where id = v_actor;

  select * into v_quote from public.quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;

  select * into v_lead from public.leads where id = v_quote.lead_id;

  if v_actor_role not in ('admin', 'boss', 'operator')
     and v_quote.created_by is distinct from v_actor then
    raise exception 'only the quotation owner or a manager may convert it' using errcode = '42501';
  end if;

  -- ── The idempotent branch: this quotation already has its contract ────────
  if v_quote.contract_id is not null then
    select * into v_contract from public.contracts where id = v_quote.contract_id;
    if not found then
      -- A link to a contract that does not exist is corruption, not a retry.
      raise exception 'quotation % is linked to a contract that does not exist', v_quote.quote_no
        using errcode = '22023';
    end if;
    v_contract_id := v_contract.id;
    v_contract_no := v_contract.contract_no;

    if not exists (select 1 from public.contract_approvals
                    where contract_id = v_contract_id and step = 'admin_review') then
      insert into public.contract_approvals (contract_id, step, status, notes)
      values (v_contract_id, 'admin_review', 'pending',
              jsonb_build_object('source', 'quotation_finalize', 'quotation_id', v_quote.id));
      v_finalized := array_append(v_finalized, 'approval');
    end if;

    if to_regclass('public.projects') is not null
       and not exists (select 1 from public.projects where contract_id = v_contract_id) then
      insert into public.projects (
        customer_id, lead_id, contract_id, sales_id,
        name, property_type, property_size, location,
        phase, status, contract_amount
      ) values (
        v_lead.customer_id, v_quote.lead_id, v_contract_id,
        coalesce(v_quote.created_by, v_actor),
        coalesce(nullif(v_lead.customer_name, ''), 'Client') || ' - '
          || coalesce(nullif(v_lead.property_type, ''), 'Smart Home'),
        v_lead.property_type, v_lead.property_size_sqm, v_lead.location,
        'design', 'active', v_quote.total_amount
      );
      v_finalized := array_append(v_finalized, 'project');
    end if;

    if not exists (
      select 1 from public.activities
       where lead_id = v_quote.lead_id
         and content like '%' || v_contract_no || '%'
    ) then
      insert into public.activities (lead_id, user_id, type, content, ai_generated)
      values (v_quote.lead_id, v_actor, 'note',
              'Contract ' || v_contract_no || ' created from quotation ' || v_quote.quote_no
              || ' (pending admin review)', true);
      v_finalized := array_append(v_finalized, 'activity');
    end if;

    return jsonb_build_object(
      'success',            true,
      'already_converted',  true,
      'contract_id',        v_contract_id,
      'contract_no',        v_contract_no,
      'quotation_status',   v_quote.status,
      'installments_count', (select count(*) from public.installment_plans
                              where contract_id = v_contract_id),
      'finalized',          to_jsonb(v_finalized),
      'actor_id',           v_actor
    );
  end if;

  -- ── The first conversion ─────────────────────────────────────────────────
  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quotation can be converted (status %)', v_quote.status
      using errcode = '22023';
  end if;
  if not (coalesce(v_quote.total_amount, 0) > 0) then
    raise exception 'quotation total must be greater than zero' using errcode = '22023';
  end if;

  -- The installment invariant, checked before the first write.
  -- coalesce is load-bearing. `jsonb_typeof('{}'::jsonb -> 'installments')` is
  -- NULL, and `NULL <> 'array'` is NULL rather than true, so the bare comparison
  -- let the real UI request — a POST with no body, which the route turns into an
  -- absent key — fall through to the total check and be refused with the wrong
  -- reason. Reproduced while writing this file: "the installment schedule totals
  -- 0.00 but the quotation totals 80000.00" instead of "none was supplied".
  if coalesce(jsonb_typeof(p_payload -> 'installments'), 'null') <> 'array'
     or jsonb_array_length(p_payload -> 'installments') = 0 then
    raise exception 'a conversion needs an installment schedule; none was supplied'
      using errcode = '22023';
  end if;
  for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
    if nullif(v_inst ->> 'amount', '') is null
       or (v_inst ->> 'amount')::numeric(12, 2) <= 0 then
      raise exception 'every installment needs a positive amount' using errcode = '22023';
    end if;
    v_inst_total := v_inst_total + (v_inst ->> 'amount')::numeric(12, 2);
  end loop;
  -- One cent of tolerance, because a three-way percentage split of an odd total
  -- cannot be exact and the client is the one rounding it.
  if abs(v_inst_total - v_quote.total_amount) > 0.01 then
    raise exception 'the installment schedule totals % but the quotation totals %',
      to_char(v_inst_total, 'FM999999999990.00'),
      to_char(v_quote.total_amount, 'FM999999999990.00') using errcode = '22023';
  end if;

  loop
    v_attempt     := v_attempt + 1;
    v_contract_no := public.next_contract_no(v_date);
    begin
      insert into public.contracts (
        lead_id, quotation_id, sales_id, created_by, contract_no, contract_date,
        contract_amount, currency, party_a_name, party_b_name, status,
        first_payment_due_date
      ) values (
        v_quote.lead_id, v_quote.id, coalesce(v_quote.created_by, v_actor), v_actor,
        v_contract_no, v_date, v_quote.total_amount,
        coalesce(nullif(v_quote.currency, ''), 'AED'),
        coalesce(nullif(v_lead.customer_name, ''), 'Unknown'),
        'NewMe Smart Home FZCO',
        'draft',
        nullif(p_payload ->> 'first_payment_due_date', '')::date
      )
      returning id into v_contract_id;
      exit;
    exception
      when unique_violation then
        if v_attempt >= 10 then
          raise;
        end if;
    end;
  end loop;

  for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id,
      coalesce(nullif(v_inst ->> 'seq', '')::integer, v_inst_count + 1),
      (v_inst ->> 'amount')::numeric(12, 2),
      coalesce(nullif(v_inst ->> 'due_date', '')::date, v_date),
      coalesce(v_inst ->> 'description', ''),
      'pending'
    );
    v_inst_count := v_inst_count + 1;
  end loop;

  insert into public.contract_approvals (contract_id, step, status, notes)
  values (v_contract_id, 'admin_review', 'pending',
          jsonb_build_object('source', 'quotation', 'quotation_id', v_quote.id));

  update public.quotations
     set status      = 'contract_created',
         contract_id = v_contract_id,
         updated_at  = now()
   where id = p_quotation_id;

  if v_quote.lead_id is not null then
    update public.leads
       set final_status = 'won', updated_at = now()
     where id = v_quote.lead_id;
  end if;

  -- The two rows the route used to write after the commit, and lose on failure.
  -- on_lead_won() returned early above because the contract already exists, so
  -- these are not duplicates of the automation's.
  v_customer_id := v_lead.customer_id;
  if to_regclass('public.projects') is not null
     and not exists (select 1 from public.projects where contract_id = v_contract_id) then
    insert into public.projects (
      customer_id, lead_id, contract_id, sales_id,
      name, property_type, property_size, location,
      phase, status, contract_amount
    ) values (
      v_customer_id, v_quote.lead_id, v_contract_id, coalesce(v_quote.created_by, v_actor),
      coalesce(nullif(v_lead.customer_name, ''), 'Client') || ' - '
        || coalesce(nullif(v_lead.property_type, ''), 'Smart Home'),
      v_lead.property_type, v_lead.property_size_sqm, v_lead.location,
      'design', 'active', v_quote.total_amount
    )
    returning id into v_project_id;
  end if;

  insert into public.activities (lead_id, user_id, type, content, ai_generated)
  values (v_quote.lead_id, v_actor, 'note',
          'Contract ' || v_contract_no || ' created from quotation ' || v_quote.quote_no
          || ' (pending admin review)', true);

  return jsonb_build_object(
    'success',            true,
    'already_converted',  false,
    'contract_id',        v_contract_id,
    'contract_no',        v_contract_no,
    'quotation_status',   'contract_created',
    'installments_count', v_inst_count,
    'project_id',         v_project_id,
    'actor_id',           v_actor
  );
end
$$;

-- Privileges restated for every function this file replaced or created: a
-- CREATE OR REPLACE keeps the existing ACL, but a future CREATE FUNCTION of the
-- same name would grant EXECUTE to PUBLIC by default, and this is the file that
-- says what the surface is.
revoke all on function public.money_actor(uuid, text[])                   from public, anon;
revoke all on function public.confirm_payment(uuid, uuid)                 from public, anon;
revoke all on function public.allocate_payment(uuid, jsonb, uuid)         from public, anon;
revoke all on function public.create_contract(jsonb)                      from public, anon;
revoke all on function public.convert_quotation_to_contract(uuid, jsonb)  from public, anon;
revoke all on function public.set_contract_status(uuid, text, text)       from public, anon;
revoke all on function public.revoke_contract(uuid, text, boolean)        from public, anon;
revoke all on function public.contract_transition_is_allowed(text, text)  from public, anon;

grant execute on function public.money_actor(uuid, text[])                  to authenticated, service_role;
grant execute on function public.confirm_payment(uuid, uuid)                to authenticated, service_role;
grant execute on function public.allocate_payment(uuid, jsonb, uuid)        to authenticated, service_role;
grant execute on function public.create_contract(jsonb)                     to authenticated, service_role;
grant execute on function public.convert_quotation_to_contract(uuid, jsonb) to authenticated, service_role;
grant execute on function public.set_contract_status(uuid, text, text)      to authenticated, service_role;
grant execute on function public.revoke_contract(uuid, text, boolean)       to authenticated, service_role;
grant execute on function public.contract_transition_is_allowed(text, text) to authenticated, service_role;

commit;
