-- ============================================================================
-- L0 round 4 · A1 — the session boundary at SECURITY DEFINER entry
-- ============================================================================
-- NO_ROLLBACK: reverting this file restores the state reproduced below, in which
-- a deactivated, banned, forced-to-change-password or stale-token session is
-- served normally by any SECURITY DEFINER routine that answers before its first
-- statement. There is no way back from it that does not reopen A1, so it ships
-- without a companion rather than with one that undoes the fix — the same
-- position 20260813000000 and 20260814000000 take for the rest of the boundary.
-- Nothing here is destructive: it adds one function and one unreachable table,
-- redefines function bodies by injecting a single guarded assertion, and revokes
-- EXECUTE on trigger functions from end-user roles. No data is touched, and no
-- RPC the previous release's application calls is a trigger function (verified
-- against the sixteen names in src/**/*.ts{,x}).
--
-- Round-4 finding A1. 20260814000000 put the session boundary on table
-- statements: a BEFORE ... FOR EACH STATEMENT trigger on every public table that
-- calls assert_current_session() whenever the statement carries an end-user
-- identity. That covers RLS-invisible writes made inside SECURITY DEFINER
-- routines, which was the hole it was written for. It does not cover a routine
-- that decides the request WITHOUT issuing a statement.
--
-- Reproduced against the exact release state (floor + the eleven branch
-- migrations + fixtures) before this file existed, calling
-- record_lead_note_atomic() on its idempotent-replay branch — the branch that
-- returns the recorded response before the first INSERT:
--
--     inactive: served=t idempotent_replay=true
--     banned:   served=t idempotent_replay=true
--     stale:    served=t idempotent_replay=true
--     forced:   served=t idempotent_replay=true
--     forced + LEAD_NOT_FOUND branch: sqlstate=P0001 message=LEAD_NOT_FOUND
--
-- Four revoked session states served normally, and the error branch reached too:
-- the routine answered the request before the boundary was ever consulted. A
-- deactivated, banned, forced-to-change-password or stale-token session could
-- therefore still read back any note it had ever written, and could still learn
-- whether an arbitrary lead id exists.
--
-- What this file does
-- -------------------
-- 1. assert_current_session_at_entry(): the guarded form of the assertion,
--    identical in meaning to the one the statement trigger applies — a statement
--    with no end-user identity is a trusted server path (service_role, psql,
--    pg_cron) and is authorised by holding the key, not by a session.
--
-- 2. A catalog-driven transform. For every plpgsql SECURITY DEFINER function in
--    `public` that is not a trigger function and is not on the allowlist below,
--    the assertion is injected as the FIRST statement of the outermost block, by
--    rewriting pg_get_functiondef() and re-executing it. Catalog-driven, not a
--    list, for the reason this project keeps rediscovering: a large part of this
--    database was built by hand in the dashboard, so a list written from
--    supabase/migrations/ is a list of the routines someone remembered to commit.
--    Whatever is installed gets the boundary.
--
-- 3. A verification block that fails the migration if any target is left
--    uncovered, if the assertion is not anchored to the entry of the block, or
--    if the transform covered nothing at all.
--
-- Idempotent: a function that already carries the anchored assertion is skipped,
-- so re-applying the file is a no-op. Proven by the replay harness, which applies
-- every branch migration twice.
--
-- Rollback: supabase/migrations/rollback_l0_round4.sql
--
-- Proven, not asserted, in supabase/replay/10_assert_release_contracts.sql:
-- the catalog query above has to return zero rows and a non-zero covered count,
-- and record_lead_note_atomic() is called on its idempotent-replay branch, its
-- error branch and its normal branch for each of the four revoked session states
-- plus a current session.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · The guarded assertion
-- ---------------------------------------------------------------------------
-- Why this and not assert_current_session() directly: session_boundary_state()
-- returns 'no_session' when auth.uid() is null, and assert_current_session()
-- turns that into 28001. Injecting it bare would make every service_role call,
-- every psql call and every pg_cron call raise. require_current_session() — the
-- statement trigger installed by 20260814000000 — already draws the line in
-- exactly this place; this is the same line, callable from a function body.
create or replace function public.assert_current_session_at_entry()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is not null then
    perform public.assert_current_session();
  end if;
end
$$;

comment on function public.assert_current_session_at_entry() is
  'Entry guard for SECURITY DEFINER routines: a request carrying an end-user identity must come from a current session (class-28 SQLSTATE naming the boundary if not); a request with no identity is a trusted server path and passes. Same rule as require_current_session(), callable from a function body.';

revoke all on function public.assert_current_session_at_entry() from public, anon;
grant execute on function public.assert_current_session_at_entry() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 · Trigger functions are taken off the end-user surface
-- ---------------------------------------------------------------------------
-- A trigger function is executed by the trigger machinery regardless of who
-- holds EXECUTE, and the statement that fires it is already covered by
-- trg_require_current_session. What EXECUTE buys an end-user session is the
-- ability to CALL it directly over PostgREST, which is never useful and, for the
-- money guards, would let a session evaluate a guard outside its trigger
-- context. They hold it only because CREATE FUNCTION grants EXECUTE to PUBLIC by
-- default and nothing ever took it back.
do $do$
declare
  r       record;
  revoked int := 0;
begin
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'trigger'::regtype
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute'))
     order by 1
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    revoked := revoked + 1;
  end loop;
  raise notice 'trigger functions taken off the end-user surface: %', revoked;
end
$do$;

-- ---------------------------------------------------------------------------
-- 3 · The allowlist, and why each entry is on it
-- ---------------------------------------------------------------------------
-- Held in a table rather than inline so the replay assertion and this migration
-- read the same list, and so adding an exemption is a visible, reviewable schema
-- change rather than an edit to a regex. Unreachable by end-user roles.
create table if not exists public.definer_entry_boundary_exemptions (
  routine   text primary key,
  reason    text not null,
  declared_at timestamptz not null default now()
);

alter table public.definer_entry_boundary_exemptions enable row level security;
revoke all on table public.definer_entry_boundary_exemptions from public, anon, authenticated;

comment on table public.definer_entry_boundary_exemptions is
  'The only SECURITY DEFINER routines in public that may lack an entry-time session assertion, each with the reason. Enforced by 20260816000000 and by supabase/replay/10_assert_release_contracts.sql.';

-- The statement boundary 20260814000000 installs is applied by a DO block that
-- iterates the tables existing WHEN IT RUNS. This file runs after it and creates
-- a table, so that table would carry no trg_require_current_session — and the
-- assertion that says every public table is covered would still pass in the
-- replay harness, because the harness applies each branch migration twice and the
-- second application of 20260814000000 sweeps up whatever 20260816000000 added.
-- Production applies each migration once, in order, so the replay would have been
-- green about a table the release actually left uncovered. Reproduced by building
-- the release state with a single ordered application: 22 public tables, 21
-- covered, definer_entry_boundary_exemptions the one missing.
--
-- Re-running the install here is idempotent (it drops and recreates), makes the
-- ordering irrelevant, and means any table a later file in this release adds is
-- covered as long as it re-runs this sweep too.
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
  raise notice 'session write boundary re-applied to % table(s)', applied;
end
$do$;

insert into public.definer_entry_boundary_exemptions (routine, reason) values
  ('assert_current_session()',
   'It is the assertion. Injecting it into itself is unbounded recursion.'),
  ('assert_current_session_at_entry()',
   'It is the guarded form of the assertion, for the same reason.'),
  ('session_boundary_state()',
   'The single verdict every other check reads. It must return a verdict, not raise.'),
  ('session_identity_enabled()',
   'Evaluated inside RLS policies. A policy predicate that raises turns a row-level refusal into a request-level error and takes /api/auth/me offline for the very sessions that need to be told why.'),
  ('session_token_is_current()',
   'Same: an RLS predicate must answer false, not raise.'),
  ('get_my_role()',
   'Evaluated inside permissive RLS policies, including profiles self-read. It must return NULL for a refused session so the table-level restrictive session policy can produce an empty result instead of a request-level 28003 error.'),
  ('money_direct_write_mode()',
   'Read by the write guards and by RLS on every money statement, including statements made by trusted server paths during the compatibility window. It reports the release phase; it does not authorise anything.')
on conflict (routine) do update set reason = excluded.reason;

-- get_my_role() is both a small authenticated RPC and an RLS helper. A generic
-- entry assertion is wrong for the latter use: a stale, banned, inactive or
-- forced-password session evaluating an unrelated table policy would raise
-- 28003 instead of being filtered out. It still fails closed for direct calls by
-- returning NULL unless the same canonical session verdict is `ok`.
create or replace function public.get_my_role()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if public.session_boundary_state() <> 'ok' then
    return null;
  end if;
  return (select role from public.profiles where id = auth.uid());
end
$$;

revoke execute on function public.get_my_role() from public, anon;
grant execute on function public.get_my_role() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4 · The transform
-- ---------------------------------------------------------------------------
-- The regex targets the first line-anchored `begin` in the definition returned by
-- pg_get_functiondef(), which for a plpgsql function is the outermost block:
-- everything before it is the CREATE header and the optional DECLARE section.
-- No 'g' flag, so exactly one substitution is made.
--
-- Two things make this safe to do textually rather than by hand. It is verified
-- afterwards against the catalog rather than assumed (section 5), and the
-- anchored pattern it must produce is checked, so a substitution that landed
-- somewhere else fails the migration instead of shipping.
do $do$
declare
  r         record;
  v_def     text;
  v_new     text;
  covered   int := 0;
  skipped   int := 0;
begin
  for r in
    select p.oid, p.oid::regprocedure::text as sig, p.prosrc
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_language l on l.oid = p.prolang
     where n.nspname = 'public'
       and p.prosecdef
       and l.lanname = 'plpgsql'
       and p.prorettype <> 'trigger'::regtype
       and p.oid::regprocedure::text not in (
             select routine from public.definer_entry_boundary_exemptions)
     order by 1
  loop
    -- Already anchored: this is the re-apply path.
    if r.prosrc ~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);' then
      skipped := skipped + 1;
      continue;
    end if;

    v_def := pg_get_functiondef(r.oid);

    -- The common shape: the body opens with a newline, an optional DECLARE
    -- section, then a line whose only token is `begin`.
    v_new := regexp_replace(
      v_def,
      '(\n[ \t]*begin[ \t]*\r?\n)',
      E'\\1  perform public.assert_current_session_at_entry();\n',
      'i');

    -- The one-liner shape: `AS $fn$BEGIN ... END$fn$`, where the opening `begin`
    -- has no newline in front of it and the pattern above cannot see it. Five of
    -- the sixteen routines this app calls over RPC live in migrations that are
    -- already applied and are not carried by the replay floor, so their exact
    -- formatting is not something this file gets to assume.
    if v_new = v_def then
      v_new := regexp_replace(
        v_def,
        '(as \$[a-z0-9_]*\$[ \t]*\r?\n?[ \t]*begin\M)',
        E'\\1\n  perform public.assert_current_session_at_entry();',
        'i');
    end if;

    -- Still nothing: the body is shaped in a way neither pattern understands.
    -- Fail the migration. An uncovered definer routine is the finding; shipping
    -- one while reporting success is the finding plus a false green.
    if v_new = v_def then
      raise exception 'could not find the outermost BEGIN of %; refusing to leave it uncovered', r.sig
        using errcode = '22000';
    end if;

    execute v_new;
    covered := covered + 1;
  end loop;

  raise notice 'definer entry boundary: % routine(s) covered, % already covered', covered, skipped;

  if covered + skipped = 0 then
    raise exception 'the definer entry boundary matched no routines, which cannot be right; refusing to report success'
      using errcode = '22000';
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- 5 · Verification, against the catalog
-- ---------------------------------------------------------------------------
-- Deliberately NOT restricted to plpgsql. The transform can only rewrite plpgsql
-- bodies — a `sql`-language function has no block to inject a PERFORM into — so if
-- the check carried the same language filter as the transform, adding a
-- SECURITY DEFINER `sql` function would silently create an uncovered routine and
-- the gate would still report success. Language-agnostic here means the only two
-- permitted outcomes are "plpgsql and anchored" or "named in the exemption table
-- with a reason". As of this migration the non-plpgsql definer routines in public
-- are exactly the four verdict functions already exempted above, which is why
-- this passes rather than because nothing was checked.
do $do$
declare
  v_uncovered text[];
  v_exempt_missing text[];
begin
  select coalesce(array_agg(sig order by sig), '{}') into v_uncovered
    from (
      select p.oid::regprocedure::text as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
       where n.nspname = 'public'
         and p.prosecdef
         and p.prorettype <> 'trigger'::regtype
         and p.oid::regprocedure::text not in (
               select routine from public.definer_entry_boundary_exemptions)
         and (l.lanname <> 'plpgsql'
              or p.prosrc !~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public\.assert_current_session_at_entry\(\);')
    ) s;

  if array_length(v_uncovered, 1) is not null then
    raise exception 'these SECURITY DEFINER routines have no entry-time session assertion: %',
      array_to_string(v_uncovered, ', ') using errcode = '22000';
  end if;

  -- An exemption for a routine that does not exist is stale bookkeeping, and a
  -- stale exemption is how a real routine gets quietly excused later under a name
  -- someone reused. Reported, not fatal: dropping a routine is legitimate.
  select coalesce(array_agg(e.routine order by e.routine), '{}') into v_exempt_missing
    from public.definer_entry_boundary_exemptions e
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.oid::regprocedure::text = e.routine);
  if array_length(v_exempt_missing, 1) is not null then
    raise notice 'exemptions naming a routine that is not installed here: %',
      array_to_string(v_exempt_missing, ', ');
  end if;
end
$do$;

commit;
