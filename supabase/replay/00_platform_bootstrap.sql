-- ============================================================================
-- Replay harness — step 0: Supabase platform objects
-- ============================================================================
-- This file is NOT a migration and is never applied to any real database. It
-- exists so that `supabase/migrations/` can be replayed from empty on a stock
-- PostgreSQL image, which is the only way to prove that a migration we are
-- about to ship actually applies.
--
-- Everything here is provided by the Supabase platform (GoTrue, PostgREST,
-- the managed role set), not by this repository. It is deliberately minimal:
-- only the objects that `supabase/migrations/*.sql` actually references —
-- auth.uid(), auth.role(), auth.jwt(), auth.users, the anon/authenticated/
-- service_role roles, the extensions schema and uuid-ossp.
--
-- Anything the migrations need that is NOT platform-provided belongs in
-- supabase/migrations/, not here. See
-- supabase/migrations/20260806000000_baseline_undeclared_production_objects.sql
-- for objects that exist in production but were never declared in a migration.
-- (That file is numbered AFTER the applied history, not before it: the applied
-- history is immutable, so a baseline cannot be back-dated into it.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Managed roles. NOLOGIN/NOINHERIT mirrors the platform; the harness never
-- authenticates as them, it only impersonates with SET LOCAL ROLE.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit createrole;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- The platform sets these so that PostgREST roles can see tables created later
-- by migrations. Reproducing them is what makes table-level GRANT/REVOKE
-- assertions meaningful: without them every table would start with no
-- privileges and a REVOKE regression would be invisible.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Extensions live in their own schema on the platform.
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- auth schema (GoTrue). Column set is the subset the migrations read plus the
-- NOT NULL columns GoTrue itself requires, so that inserts in replay
-- assertions behave the way they do in production.
-- ---------------------------------------------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id                          uuid primary key default extensions.uuid_generate_v4(),
  aud                         varchar(255),
  role                        varchar(255),
  email                       varchar(255) unique,
  encrypted_password          varchar(255),
  email_confirmed_at          timestamptz,
  invited_at                  timestamptz,
  confirmation_token          varchar(255),
  confirmation_sent_at        timestamptz,
  recovery_token              varchar(255),
  recovery_sent_at            timestamptz,
  last_sign_in_at             timestamptz,
  raw_app_meta_data           jsonb,
  raw_user_meta_data          jsonb,
  is_super_admin              boolean,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now(),
  phone                       text unique default null,
  banned_until                timestamptz,
  deleted_at                  timestamptz
);

create table if not exists auth.identities (
  provider_id     text                     not null,
  user_id         uuid                     not null references auth.users (id) on delete cascade,
  identity_data   jsonb                    not null,
  provider        text                     not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  email           text,
  primary key (provider_id, provider)
);

-- GoTrue's session store. Column set, types and the two foreign keys are taken
-- from a live GoTrue v2.195.0 (public.ecr.aws/supabase/gotrue:v2.195.0) that ran
-- its own migrations against public.ecr.aws/supabase/postgres:17.6.1.158, read
-- back out of pg_attribute and pg_constraint. Three details matter to
-- 20260817120000 and are therefore faithful rather than convenient:
--
--   * refresh_tokens.user_id is varchar(255) holding the user's UUID as text,
--     not a uuid column, so a predicate over it has to cast;
--   * refresh_tokens.session_id -> sessions.id is ON DELETE CASCADE, so
--     deleting a session removes its refresh tokens (confdeltype = 'c');
--   * sessions.user_id -> users.id is ON DELETE CASCADE.
--
-- `aal` is auth.aal_level on the platform, an enum this release never reads;
-- modelling it as text keeps the bootstrap from inventing a type the migrations
-- do not depend on.
create table if not exists auth.sessions (
  id            uuid primary key,
  user_id       uuid        not null references auth.users (id) on delete cascade,
  created_at    timestamptz,
  updated_at    timestamptz,
  factor_id     uuid,
  aal           text,
  not_after     timestamptz,
  refreshed_at  timestamp,
  user_agent    text,
  ip            inet,
  tag           text
);
create index if not exists sessions_user_id_idx on auth.sessions using btree (user_id);

create table if not exists auth.refresh_tokens (
  instance_id uuid,
  id          bigserial primary key,
  token       varchar(255) unique,
  user_id     varchar(255),
  revoked     boolean,
  created_at  timestamptz,
  updated_at  timestamptz,
  parent      varchar(255),
  session_id  uuid references auth.sessions (id) on delete cascade
);
create index if not exists refresh_tokens_session_id_revoked_idx
  on auth.refresh_tokens using btree (session_id, revoked);

-- GoTrue's request-scoped claim accessors. On the platform these read the JWT
-- that PostgREST puts into the request settings; the harness sets the same
-- settings with SET LOCAL, so caller-scoped RLS behaves identically.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;
