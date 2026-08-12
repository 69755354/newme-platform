-- ============================================================================
-- Administrator password reset is bound to a VERIFIED global session revocation
-- ============================================================================
-- NO_ROLLBACK: this file adds one service-role-only function and grants nothing
-- to any end-user role. Dropping it makes the reset route's revocation check
-- unavailable, and the route fails closed when the check is unavailable — so a
-- rollback that removed this function would take administrator password reset
-- offline rather than restore the previous behaviour. Reverting the application
-- alone is safe and needs nothing from here: a release that does not call
-- revoke_user_sessions() is unaffected by its existence.
--
-- Forward-only. Lands after 20260817000000 and before the contract phase
-- 20260818000000; modifies no applied file and no object any earlier file owns.
--
-- ----------------------------------------------------------------------------
-- What round 4 reported, and what the behaviour actually is
-- ----------------------------------------------------------------------------
-- A3 (P1) said: "administrator password reset does not revoke the target's
-- refresh sessions — src/app/api/users/[id]/password/route.ts updates the user
-- and password_changed_at but does not globally revoke sessions. A pre-reset
-- refresh token can mint a fresh access token whose iat is later than the reset
-- timestamp."
--
-- The premise about the ROUTE is correct: it calls
-- supabaseAdmin.auth.admin.updateUserById(id, { password }) and nothing else,
-- and @supabase/auth-js 2.106.2 exposes no admin "revoke sessions by user id"
-- (GoTrueAdminApi has createUser / listUsers / getUserById / updateUserById /
-- deleteUser / factors / passkeys; signOut(jwt, scope) needs the TARGET's own
-- JWT, which an administrator does not have).
--
-- The premise about the OUTCOME does not reproduce. Measured against a real
-- GoTrue v2.195.0 (public.ecr.aws/supabase/gotrue:v2.195.0) running its own
-- migrations against public.ecr.aws/supabase/postgres:17.6.1.158 — see
-- scripts/gotrue-revocation-drill.sh, which reproduces all three probes:
--
--   Probe A — sign in, then PUT /admin/users/{id} {"password": ...}:
--     auth.sessions for that user: 1 -> 0
--     the pre-reset refresh token: HTTP 400, error_code refresh_token_not_found
--     a fresh access token was NOT minted (iat: null)
--   Probe B — this release's own mechanism, isolated. The delete runs while the
--     rows are still live, i.e. BEFORE the admin update rather than after it,
--     because probe A is what shows the update has already removed them and
--     measuring afterwards would measure nothing: deleting the target's
--     auth.sessions row as the migration owner takes its refresh token with it
--     (1 present -> 1 session deleted -> 0 tokens), the old refresh token is then
--     refused (400 refresh_token_not_found), and after the password update a login
--     with the NEW password succeeds (200) while the old password fails (400).
--   Probe C — three concurrent sessions, delete all rows: all three refresh
--     tokens are refused (400, 400, 400) and an ALREADY-MINTED access token is
--     refused by GoTrue too (403), because its session row is gone.
--
-- So GoTrue itself performs the global revocation on an admin password update.
-- The route inherited a guarantee it never asked for and never checked.
--
-- ----------------------------------------------------------------------------
-- Why this migration exists anyway
-- ----------------------------------------------------------------------------
-- An inherited guarantee is not a boundary. Three things are true at once:
--
--   1. The version above is what the drill ran. The Supabase-managed GoTrue this
--      project talks to is upgraded by the platform, not by this repository, and
--      its exact version is not something this release reads. A behaviour that
--      is nobody's stated contract can change under a managed upgrade.
--   2. Even at v2.195.0, the revocation is a SIDE EFFECT of a 200 response. The
--      route cannot distinguish "sessions were revoked" from "the password was
--      updated and the sessions were left alone": both are 200.
--   3. auth is not in PostgREST's exposed schemas, so no amount of service-role
--      HTTP can look at auth.sessions to check. Only a definer function can.
--
-- revoke_user_sessions() therefore turns the side effect into a checked
-- postcondition: it deletes whatever session and refresh-token rows remain for
-- the target, verifies that none are left, and raises if it cannot get to that
-- state. The reset route calls it after the password update and fails closed on
-- any error, so the release's claim is "revocation was verified", not
-- "revocation is believed to happen upstream".
--
-- It is idempotent by construction. Against a GoTrue that already revoked, it
-- deletes 0 rows and returns verified = true; against one that did not, it does
-- the work. Both paths end in the same asserted state.
--
-- Deleting the target's rows in auth.sessions is what GoTrue's own global
-- sign-out does; refresh_tokens.session_id is ON DELETE CASCADE, so a session
-- delete takes its tokens with it. The legacy shape — a refresh token row with a
-- null session_id, which GoTrue wrote before sessions existed — is removed by
-- user_id as well, because a cascade cannot reach it.
--
-- ----------------------------------------------------------------------------
-- What this does NOT close, stated plainly
-- ----------------------------------------------------------------------------
-- An access token that GoTrue already signed stays cryptographically valid until
-- it expires, and PostgREST will accept it: probe C shows GoTrue refusing such a
-- token (it checks the session row) while PostgREST has no session to check.
-- That window is closed by a different mechanism in this same release —
-- 20260813000000's session_token_is_current() restrictive policy, which compares
-- the token's iat with profiles.password_changed_at — and the reset route writes
-- password_changed_at before calling this function, in that order, on purpose.
--
-- ----------------------------------------------------------------------------
-- Privilege, and why this file refuses to install without it
-- ----------------------------------------------------------------------------
-- The auth schema is owned by supabase_auth_admin. On the platform its default
-- privileges grant `arwdDxtm` on every table it creates to `postgres`, read out
-- of pg_default_acl on public.ecr.aws/supabase/postgres:17.6.1.158:
--
--   supabase_auth_admin objtype=r acl=postgres=arwdDxtm/supabase_auth_admin , ...
--
-- and has_table_privilege('postgres','auth.sessions','delete') is true there for
-- the auth.sessions that GoTrue created as supabase_auth_admin. `postgres` is
-- not a superuser in that image, so this is a grant, not an accident of
-- ownership. The replay harness runs as its own superuser and therefore CANNOT
-- prove this for production; section 3 below asserts it at apply time instead,
-- so a database where the migration owner cannot revoke sessions fails the
-- release rather than shipping a reset route that can only fail closed.
--
-- Proven, not asserted, in supabase/replay/10_assert_release_contracts.sql
-- section A3: the identity boundary (an end-user session cannot execute it, and
-- it refuses even a service-role call that carries an end-user identity), the
-- deletion and its read-after-write, idempotence on a second call, the blast
-- radius (another user's sessions survive), the legacy null-session token, the
-- unknown-target refusal, and the audit row it writes.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · The function
-- ---------------------------------------------------------------------------
create or replace function public.revoke_user_sessions(
  p_user_id uuid,
  p_reason  text default 'admin_password_reset'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_sessions_before int;
  v_tokens_before   int;
  v_sessions_gone   int;
  v_tokens_gone     int;
  v_left            int;
begin
  perform public.assert_current_session_at_entry();

  -- Server-only. EXECUTE is granted to service_role alone, and this is the
  -- second lock: a call that carries an end-user identity is refused even if a
  -- future grant, a definer wrapper or a psql session with claims set were to
  -- reach it. Revoking another identity's sessions is not an end-user action.
  if auth.uid() is not null or coalesce(auth.role(), '') in ('authenticated', 'anon') then
    raise exception 'revoke_user_sessions is a server-only boundary and refuses a call carrying an end-user identity'
      using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'revoke_user_sessions requires a target user id'
      using errcode = '22004';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'revoke_user_sessions was asked to revoke sessions for an identity that does not exist'
      using errcode = '22023';
  end if;

  select count(*) into v_sessions_before from auth.sessions s where s.user_id = p_user_id;
  select count(*) into v_tokens_before
    from auth.refresh_tokens rt
   where rt.session_id in (select s.id from auth.sessions s where s.user_id = p_user_id)
      or rt.user_id::text = p_user_id::text;

  -- Tokens first, then sessions. The FK cascades, so the second delete would
  -- reach the session-bound rows anyway; doing it explicitly means this function
  -- does not depend on a constraint definition it does not own, and it also
  -- reaches the legacy rows whose session_id is null.
  delete from auth.refresh_tokens rt
   where rt.session_id in (select s.id from auth.sessions s where s.user_id = p_user_id)
      or rt.user_id::text = p_user_id::text;
  get diagnostics v_tokens_gone = row_count;

  delete from auth.sessions s where s.user_id = p_user_id;
  get diagnostics v_sessions_gone = row_count;

  -- The postcondition. Without this the function is a hopeful DELETE.
  select count(*) into v_left
    from (
      select 1 from auth.sessions s where s.user_id = p_user_id
      union all
      select 1 from auth.refresh_tokens rt
       where rt.session_id in (select s.id from auth.sessions s where s.user_id = p_user_id)
          or rt.user_id::text = p_user_id::text
    ) remaining;
  if v_left <> 0 then
    raise exception 'revoke_user_sessions could not clear % session or refresh-token row(s) for the target; refusing to report a revocation', v_left
      using errcode = '25000';
  end if;

  -- Server-owned evidence. actor_id stays null: the actor is a service-role
  -- server path, not an end-user identity, and audit_logs is write-only to
  -- callers since 20260811100000. target_id is passed as uuid — it is a uuid
  -- column in production truth (supabase/replay/01_floor_schema.sql:758) and an
  -- assignment from uuid is accepted either way.
  insert into public.audit_logs (action, target_type, target_id, details)
  values (
    'SESSION_REVOCATION',
    'auth.sessions',
    p_user_id,
    jsonb_build_object(
      'reason', coalesce(p_reason, 'unspecified'),
      'sessions_found', v_sessions_before,
      'sessions_deleted', v_sessions_gone,
      'refresh_tokens_found', v_tokens_before,
      'refresh_tokens_deleted', v_tokens_gone
    )
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'sessions_found', v_sessions_before,
    'sessions_deleted', v_sessions_gone,
    'refresh_tokens_found', v_tokens_before,
    'refresh_tokens_deleted', v_tokens_gone,
    'verified', true
  );
end
$fn$;

comment on function public.revoke_user_sessions(uuid, text) is
  'Deletes every auth.sessions and auth.refresh_tokens row belonging to one identity, verifies none remain, and audits the result. Called by the administrator password-reset paths so that "the target''s sessions were revoked" is a checked postcondition rather than an inherited GoTrue side effect. service_role only; refuses any call carrying an end-user identity.';

revoke all on function public.revoke_user_sessions(uuid, text) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2 · The exemption table stays out of this
-- ---------------------------------------------------------------------------
-- Nothing to add: this function carries the anchored
-- assert_current_session_at_entry() call that 20260816000000 requires of every
-- SECURITY DEFINER routine in public, as its first statement. It is written by
-- hand here because that migration's sweep has already run by the time this file
-- is applied, and the release contract checks the catalog, not the sweep.

-- ---------------------------------------------------------------------------
-- 3 · Apply-time proof that the owner can actually do this
-- ---------------------------------------------------------------------------
do $do$
declare
  v_missing text[] := '{}';
  v_owner   text := current_user;
begin
  if to_regclass('auth.sessions') is null then
    raise exception 'auth.sessions does not exist; global session revocation cannot be installed'
      using errcode = '42P01';
  end if;
  if to_regclass('auth.refresh_tokens') is null then
    raise exception 'auth.refresh_tokens does not exist; global session revocation cannot be installed'
      using errcode = '42P01';
  end if;

  if not has_table_privilege('auth.sessions', 'delete') then
    v_missing := v_missing || 'delete on auth.sessions';
  end if;
  if not has_table_privilege('auth.refresh_tokens', 'delete') then
    v_missing := v_missing || 'delete on auth.refresh_tokens';
  end if;
  if not has_table_privilege('auth.users', 'select') then
    v_missing := v_missing || 'select on auth.users';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'the migration owner (%) is missing %; a password reset could not revoke the target''s sessions, so this release refuses to install a boundary it cannot enforce',
      v_owner, array_to_string(v_missing, ', ')
      using errcode = '42501';
  end if;

  raise notice 'session revocation privileges verified for owner %', v_owner;
end
$do$;

-- ---------------------------------------------------------------------------
-- 4 · Self-check on the grant surface
-- ---------------------------------------------------------------------------
do $do$
begin
  if has_function_privilege('authenticated', 'public.revoke_user_sessions(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.revoke_user_sessions(uuid, text)', 'execute') then
    raise exception 'revoke_user_sessions is executable by an end-user role; refusing to ship it'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', 'public.revoke_user_sessions(uuid, text)', 'execute') then
    raise exception 'revoke_user_sessions is not executable by service_role, so the reset route could never call it'
      using errcode = '42501';
  end if;
end
$do$;

commit;
