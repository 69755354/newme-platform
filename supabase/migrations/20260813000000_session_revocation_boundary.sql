-- ============================================================================
-- Session revocation boundary: deactivation, ban and password change take
-- effect at the data boundary, not only in the Next.js request path
-- ============================================================================
-- NO_ROLLBACK: this file only ADDS restrictive policies and two read-only
-- predicates. Dropping them re-grants every deactivated, banned and
-- stale-token identity full PostgREST access to business data, which is the
-- vulnerability, not the previous release. Reverting the application without
-- reverting this file changes nothing for a valid session: the predicates are
-- true for exactly the sessions the previous release also accepted.
--
-- Forward-only. Lands after 20260812000000; modifies no applied file.
--
-- ----------------------------------------------------------------------------
-- What was wrong
-- ----------------------------------------------------------------------------
-- Every revocation control in this system was implemented in front of the
-- database and nowhere in it:
--
--   * src/proxy.ts:214 rejects a request whose profile is not is_active.
--   * src/proxy.ts:~230 decodes the access token's `iat` and rejects it when
--     profiles.password_changed_at is newer.
--   * src/app/api/auth/me/route.ts:97 repeats the is_active check.
--   * src/app/api/auth/login/route.ts:198 refuses to establish a session for an
--     inactive profile and revokes the token the password grant just minted.
--
-- All four are checks in a Next.js process. NEXT_PUBLIC_SUPABASE_URL and the
-- publishable anon key are shipped to every browser by design, so any holder of
-- a credential can skip that process entirely:
--
--     POST https://<ref>.supabase.co/auth/v1/token?grant_type=password
--     GET  https://<ref>.supabase.co/rest/v1/contracts?select=*
--
-- PostgREST authenticates the JWT, sets role `authenticated`, and evaluates the
-- table policies. Those policies checked `role in ('admin','boss','operator')`
-- — read out of public.profiles — and never checked is_active, never looked at
-- auth.users.banned_until, and had no way to know when the password changed. So:
--
--   1. F-02. 20260811100300 set is_active = false on dev@newme.ae, whose
--      password is published in git history. That closed the four app checks
--      above and NOTHING else: the identity still authenticates, still receives
--      a valid access token, and still satisfies `role = 'admin'` in every
--      policy. The header of that migration claimed "the credential is dead at
--      both authentication boundaries" and enumerated only Next.js code paths.
--      That claim was wrong and has been corrected in that file.
--   2. Password change / global sign-out. GoTrue revokes refresh tokens; it
--      cannot invalidate an access JWT that has already been signed. Until it
--      expires, that JWT is accepted by PostgREST — so "sign out everywhere"
--      left a usable window of up to the project's JWT lifetime, and the
--      `iat` comparison that was supposed to close it lived only in proxy.ts.
--   3. Admin password reset (src/app/api/users/[id]/password/route.ts,
--      src/app/actions/team.ts resetUserPassword). Both write
--      password_changed_at and neither revokes the target's sessions, because
--      supabaseAdmin.auth.admin.signOut() requires the target's own JWT. The
--      timestamp was therefore enforced by exactly one caller — the proxy.
--
-- ----------------------------------------------------------------------------
-- What this migration does
-- ----------------------------------------------------------------------------
-- It moves those three checks into the database as RESTRICTIVE policies, so
-- they are AND-ed with every existing permissive policy on every table a
-- logged-in session can reach. Restrictive is the right instrument precisely
-- because it cannot be OR-ed around: a future permissive policy, however broad,
-- still cannot grant access to a deactivated, banned or stale-token session.
--
--   session_identity_enabled()  — profiles.is_active is true AND
--                                 auth.users.banned_until is null or elapsed.
--   session_token_is_current()  — the above, AND the access token's `iat` is
--                                 present and not older than
--                                 profiles.password_changed_at.
--
-- Both fail closed: a null auth.uid(), a missing profile row, a missing
-- auth.users row and an absent `iat` claim all evaluate to false. A JWT minted
-- by GoTrue always carries `iat`, so requiring it costs a real session nothing;
-- accepting a claim set without one would make the whole gate optional for any
-- caller who could arrange that, which is the fail-open shape this release
-- exists to remove.
--
-- The overlay is applied by enumerating pg_policy rather than by listing tables,
-- so a table that becomes reachable by `authenticated` in a later migration is
-- not silently left out — and supabase/replay/10_assert_release_contracts.sql
-- asserts that enumeration is complete, table for table.
--
-- ----------------------------------------------------------------------------
-- What it deliberately does NOT do
-- ----------------------------------------------------------------------------
--   * It does not ban an Auth identity or delete a session. That is a
--     production Auth mutation, it is not idempotent, and it is not something a
--     migration in a pull request may perform. See
--     supabase/preflight/f02-credential-cutover.md for the authorised
--     procedure and its postconditions.
--   * It does not close refresh-token replay. A refresh token issued before a
--     password change can still mint an access token with a FRESH `iat`, which
--     this gate accepts by construction. Only GoTrue can revoke a refresh
--     token; the ban action in the preflight document is what makes that
--     impossible, and it is why F-02 is not claimed closed by this file.
--   * It does not protect a table that has RLS disabled, or a policy granted to
--     `anon`. Those are separate findings with their own migrations.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- The two predicates
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because they read public.profiles and auth.users, and the
-- caller must not need — and must not be given — direct read access to either
-- in order to be gated by them. They return a boolean about the caller's own
-- session and nothing else, so they leak nothing the caller does not already
-- know. search_path is pinned, as a definer function must be.
--
-- STABLE, not VOLATILE: they are evaluated once per row per statement by the
-- policy machinery, and a volatile marker would both defeat that and prevent
-- inlining.

create or replace function public.session_identity_enabled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.id = auth.uid()
       and p.is_active
       and (u.banned_until is null or u.banned_until <= now())
  )
$$;

comment on function public.session_identity_enabled() is
  'True when the calling session belongs to an active, unbanned identity. Fails closed on a null auth.uid(), a missing profile and a missing auth.users row.';

create or replace function public.session_token_is_current()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  with claim as (
    select nullif(auth.jwt() ->> 'iat', '')::bigint as iat
  )
  select public.session_identity_enabled()
     and exists (
       select 1
         from public.profiles p, claim
        where p.id = auth.uid()
          and claim.iat is not null
          and to_timestamp(claim.iat)
              >= coalesce(p.password_changed_at, '-infinity'::timestamptz)
     )
$$;

comment on function public.session_token_is_current() is
  'session_identity_enabled() plus: the access token was issued no earlier than profiles.password_changed_at. Fails closed when the iat claim is absent.';

revoke all on function public.session_identity_enabled() from public, anon;
revoke all on function public.session_token_is_current() from public, anon;
grant execute on function public.session_identity_enabled() to authenticated, service_role;
grant execute on function public.session_token_is_current() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The overlay
-- ---------------------------------------------------------------------------
-- Enumerated from pg_policy: every table in `public` that has RLS enabled and
-- at least one PERMISSIVE policy reachable by `authenticated` — either granted
-- to that role explicitly, or to PUBLIC (polroles = {0}), which includes it.
--
-- public.profiles is excluded here and handled separately below: it is the one
-- table the request path must still be able to read with a stale token, in
-- order to tell the user WHY they were logged out.
do $do$
declare
  r         record;
  applied   int := 0;
  policy_id text;
begin
  for r in
    select distinct c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_policy p on p.polrelid = c.oid
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity
       and p.polpermissive
       and (p.polroles = '{0}'::oid[] or 'authenticated'::regrole::oid = any(p.polroles))
       and c.relname <> 'profiles'
     order by 1
  loop
    policy_id := 'restrict_' || r.relname || '_active_session';
    execute format('drop policy if exists %I on public.%I', policy_id, r.relname);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated '
      || 'using (public.session_token_is_current()) '
      || 'with check (public.session_token_is_current())',
      policy_id, r.relname);
    applied := applied + 1;
  end loop;

  if applied = 0 then
    raise exception 'the session boundary matched no tables, which cannot be right; refusing to report success'
      using errcode = '22000';
  end if;
  raise notice 'session revocation boundary applied to % table(s)', applied;
end
$do$;

-- ---------------------------------------------------------------------------
-- public.profiles
-- ---------------------------------------------------------------------------
-- Writes are gated exactly like every other table. Reads are gated one notch
-- looser, and only in one direction: a session whose token predates a password
-- change may still read ITS OWN row, because src/proxy.ts fetches
-- profiles?select=id,is_active,role,password_changed_at&id=eq.<self> with the
-- caller's own token and needs that row in order to answer
-- /login?reason=password_changed instead of a generic failure.
--
-- The relaxation is scoped to `id = auth.uid()`, so a stale token still cannot
-- enumerate other profiles, and it is scoped to session_identity_enabled(), so
-- a deactivated or banned identity — the F-02 case — reads nothing at all, not
-- even its own row. Without the row the proxy sees an empty result, treats it
-- as an inactive account and returns 401. Fail-closed in the case that matters,
-- diagnosable in the case that does not.
drop policy if exists restrict_profiles_active_session_select on public.profiles;
create policy restrict_profiles_active_session_select on public.profiles
  as restrictive for select to authenticated
  using (
    public.session_token_is_current()
    or (id = auth.uid() and public.session_identity_enabled())
  );

drop policy if exists restrict_profiles_active_session_insert on public.profiles;
create policy restrict_profiles_active_session_insert on public.profiles
  as restrictive for insert to authenticated
  with check (public.session_token_is_current());

drop policy if exists restrict_profiles_active_session_update on public.profiles;
create policy restrict_profiles_active_session_update on public.profiles
  as restrictive for update to authenticated
  using (public.session_token_is_current())
  with check (public.session_token_is_current());

drop policy if exists restrict_profiles_active_session_delete on public.profiles;
create policy restrict_profiles_active_session_delete on public.profiles
  as restrictive for delete to authenticated
  using (public.session_token_is_current());

commit;
