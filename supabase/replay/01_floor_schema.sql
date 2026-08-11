-- ============================================================================
-- Replay harness — step 1: schema floor
-- ============================================================================
-- Not a migration. This is the starting schema for the branch-mode replay: the
-- objects the migrations on this branch touch, in the state production has them
-- in TODAY, before remediation.
--
-- Why a floor instead of the real history
-- ---------------------------------------
-- Replaying supabase/migrations/ from empty does not work, and the reason is a
-- finding in its own right rather than a harness problem. `MODE=history bash
-- scripts/replay-migrations.sh` reproduces it. What it found, in the first eight
-- files alone:
--
--   * 1780601210_workflow_stages.sql carried a 10-digit unix epoch instead of the
--     14-digit timestamp the Supabase CLI requires, so the CLI never saw it, yet
--     lead_workflow_stages exists in production. Renamed on this branch.
--   * 20260603000000_add_crm_fields.sql contained `ALTER TABLE TABLE`, a syntax
--     error, and the CLI runs each file in one transaction — so the file never
--     applied at all, anywhere. Tombstoned on this branch.
--   * 20260604000002_auto_lead_status.sql backfills using leads.metadata, a
--     column that exists in no migration and not in production. It cannot ever
--     have applied either.
--   * public.meta_tokens, public.profiles.password_changed_at,
--     public.profiles.force_password_change and public.leads.rep_name are read
--     and written by migrations and routes but created by none. Declared in
--     20260601010000_baseline_undeclared_production_objects.sql on this branch.
--
-- The pattern is that a large part of production was built by hand in the
-- dashboard, and the migration directory is a partial, partly-dead record of it.
-- Repairing the rest is not possible from this branch: deciding what each
-- never-applied file should now say requires reading the live schema, and several
-- of those files contain backfill UPDATEs that would mutate production data the
-- first time they were allowed to run. Guessing would be worse than reporting.
-- The remedy is an operator-run `supabase db dump` squashed into a baseline; that
-- needs credentials this session does not have and must not have.
--
-- So the gate is scoped to what it can actually prove: the six migrations this
-- branch ships, replayed onto a floor that reproduces the vulnerable production
-- state, with behaviour assertions that execute the boundaries afterwards.
--
-- Fidelity notes, stated rather than hidden:
--   * Column sets come from the committed, production-generated
--     src/types/database.ts. Only the columns the branch's migrations and the
--     assertions touch are declared; this is a floor, not a schema dump.
--   * The three money routines are signature-faithful stubs. The F-09 migration
--     changes only their EXECUTE privileges, and the assertions check only
--     privileges, so the bodies are irrelevant to what is being proven — and a
--     hand-copied body would be a fidelity claim this file cannot back up.
--   * profiles.password_changed_at, profiles.force_password_change and
--     leads.rep_name are deliberately ABSENT here, so that
--     20260601010000_baseline_undeclared_production_objects.sql is exercised
--     rather than assumed.
--   * meta_tokens IS declared here, with its live permissive policy and grants,
--     even though the same baseline migration declares the table. Leaving it out
--     made the three F-10 assertions pass vacuously — there was no permissive
--     policy to drop and no grant to revoke, so a migration that did nothing
--     would have passed. MODE=control is what caught that. The baseline's
--     `create table if not exists` is then a no-op here, which is exactly how it
--     behaves against production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Core identity
-- ---------------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  role           text        default 'sales',
  full_name      text,
  email          text,
  phone          text,
  is_active      boolean     default true,
  last_active_at timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table public.profiles enable row level security;

create policy policy_profiles_select_authenticated
  on public.profiles for select to authenticated using (true);

-- Mirrors 20260701000004_fix_profiles_rls_recursion.sql: a user may update their
-- own row, and only an admin may change `role`. This is the policy the F-06
-- finding is about — it constrains `role` and nothing else, which is why the
-- column-level GRANT is what has to carry the rest.
create policy policy_profiles_update_self
  on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and (
      role = (select p.role from public.profiles p where p.id = auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'boss'))
    )
  );

-- The pre-remediation grant: table-level UPDATE on every column.
grant select on public.profiles to authenticated;
grant update on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Leads, and the money chain that hangs off them
-- ---------------------------------------------------------------------------
create table public.leads (
  id            uuid primary key default extensions.uuid_generate_v4(),
  assigned_to   uuid references public.profiles (id),
  stage         text        default 'new',
  customer_name text,
  created_at    timestamptz default now()
);

alter table public.leads enable row level security;

create table public.contracts (
  id            uuid primary key default extensions.uuid_generate_v4(),
  lead_id       uuid references public.leads (id),
  contract_no   text not null unique,
  sales_id      uuid references public.profiles (id),
  contract_date date        default current_date,
  total_amount  numeric(12, 2),
  status        text        default 'draft',
  created_at    timestamptz default now()
);

create table public.quotations (
  id          uuid primary key default extensions.uuid_generate_v4(),
  lead_id     uuid references public.leads (id),
  quote_no    text unique,
  status      text        default 'draft',
  contract_id uuid references public.contracts (id),
  created_at  timestamptz default now()
);

create table public.payments (
  id          uuid primary key default extensions.uuid_generate_v4(),
  contract_id uuid references public.contracts (id),
  amount      numeric(12, 2),
  status      text        default 'pending',
  created_at  timestamptz default now()
);

create table public.installment_plans (
  id          uuid primary key default extensions.uuid_generate_v4(),
  contract_id uuid references public.contracts (id),
  seq         integer,
  amount      numeric(12, 2),
  due_date    date,
  status      text        default 'pending',
  created_at  timestamptz default now()
);

create table public.contract_approvals (
  id          uuid primary key default extensions.uuid_generate_v4(),
  contract_id uuid references public.contracts (id),
  approver_id uuid references public.profiles (id),
  action      text,
  created_at  timestamptz default now()
);

alter table public.contracts          enable row level security;
alter table public.quotations         enable row level security;
alter table public.payments           enable row level security;
alter table public.installment_plans  enable row level security;
alter table public.contract_approvals enable row level security;

-- Ten call sites write these tables with the CALLER'S client, so `authenticated`
-- holds table privileges on all of them. This is exactly what the reviewed
-- revision of the F-09 migration would have revoked.
grant select, insert, update, delete on public.contracts          to authenticated;
grant select, insert, update, delete on public.quotations         to authenticated;
grant select, insert, update, delete on public.payments           to authenticated;
grant select, insert, update, delete on public.installment_plans  to authenticated;
grant select, insert, update, delete on public.contract_approvals to authenticated;

-- ---------------------------------------------------------------------------
-- Money routines. Signature-faithful stubs; see the fidelity note in the header.
-- EXECUTE is held through PUBLIC, which is the PostgreSQL default for a new
-- function and the state F-09 reports: `authenticated` can call them, but only
-- because everyone can, including anon.
-- ---------------------------------------------------------------------------
create function public.approve_contract(
  p_contract_id uuid, p_approver_id uuid, p_action text, p_comment text
) returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$ begin raise exception 'replay floor stub'; end $$;

create function public.allocate_payment(
  p_payment_id uuid, p_allocations jsonb, p_actor_id uuid
) returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$ begin raise exception 'replay floor stub'; end $$;

create function public.confirm_payment(
  p_payment_id uuid, p_actor_id uuid
) returns void language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$ begin raise exception 'replay floor stub'; end $$;

grant execute on function public.approve_contract(uuid, uuid, text, text) to anon;
grant execute on function public.allocate_payment(uuid, jsonb, uuid)      to anon;
grant execute on function public.confirm_payment(uuid, uuid)              to anon;

-- No explicit `authenticated` grant: PUBLIC is what carries it today. Revoking
-- the one without adding the other is the F-09 outage.
revoke execute on function public.approve_contract(uuid, uuid, text, text) from authenticated;
revoke execute on function public.allocate_payment(uuid, jsonb, uuid)      from authenticated;
revoke execute on function public.confirm_payment(uuid, uuid)              from authenticated;

-- ---------------------------------------------------------------------------
-- KPI targets — verbatim from 20260604000001_create_kpi_targets.sql, because the
-- nullable assigned_to in the UNIQUE constraint is the whole reason the route
-- cannot upsert and needs an atomic replace.
-- ---------------------------------------------------------------------------
create table public.kpi_targets (
  id            uuid primary key default gen_random_uuid(),
  period        text          not null,
  target_type   text          not null check (target_type in ('signing', 'collection')),
  target_amount numeric(12,2) not null,
  assigned_to   uuid references public.profiles (id),
  notes         text,
  set_by        uuid references public.profiles (id),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (period, target_type, assigned_to)
);

alter table public.kpi_targets enable row level security;

-- ---------------------------------------------------------------------------
-- Audit / activity / session tables, in their pre-remediation state.
-- audit_logs is verbatim from 20260613000000_audit_logs.sql; the permissive
-- INSERT policy below is the live one from docs/rls-explorer.md:42 — WITH CHECK
-- (true), i.e. any authenticated user can write any actor_id (F-08).
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  actor_email text,
  action      text not null,
  target_type text,
  target_id   uuid,
  details     jsonb       default '{}',
  ip_address  text,
  user_agent  text,
  created_at  timestamptz default now()
);

create table public.activity_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles (id),
  action     text,
  details    jsonb       default '{}',
  created_at timestamptz default now()
);

create table public.user_session_daily (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles (id),
  session_date date        default current_date,
  login_count  integer     default 0,
  created_at   timestamptz default now(),
  unique (user_id, session_date)
);

alter table public.audit_logs         enable row level security;
alter table public.activity_logs      enable row level security;
alter table public.user_session_daily enable row level security;

create policy policy_audit_logs_select_admin
  on public.audit_logs for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss')));

create policy policy_audit_logs_insert_authenticated
  on public.audit_logs for insert to authenticated
  with check (true);

grant select, insert on public.audit_logs         to authenticated;
grant select, insert on public.activity_logs      to authenticated;
grant select, insert on public.user_session_daily to authenticated;

-- ---------------------------------------------------------------------------
-- public.meta_tokens, in its live posture: the singleton row holding the Meta
-- access token in plaintext, readable by every logged-in session and by anon.
-- Policy name and `using (true)` come from docs/rls-explorer.md:188-192, which is
-- generated from production. F-10 is what closes this.
--
-- Column definitions match 20260601010000_baseline_undeclared_production_objects
-- .sql, whose `create table if not exists` therefore no-ops against this floor,
-- the same way it no-ops against production.
-- ---------------------------------------------------------------------------
create table public.meta_tokens (
  id           bigint generated by default as identity primary key,
  access_token text        not null,
  created_at   timestamptz default now(),
  expires_at   timestamptz
);

alter table public.meta_tokens enable row level security;

create policy policy_meta_tokens_select_authenticated
  on public.meta_tokens for select to authenticated using (true);

grant select on public.meta_tokens to anon, authenticated;

-- One row, so a SELECT that should be blocked has something to leak. The value
-- is a literal placeholder, not a token.
insert into public.meta_tokens (access_token, expires_at)
values ('NOT-A-REAL-TOKEN-replay-fixture', now() + interval '60 days');
