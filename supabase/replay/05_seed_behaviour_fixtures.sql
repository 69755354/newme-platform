-- ============================================================================
-- Replay harness — step 1: fixtures for the behaviour assertions
-- ============================================================================
-- Runs after the forward replay and BEFORE this branch's L0 migrations are
-- re-applied, so that the migrations act on real rows rather than on an empty
-- schema. Without this, "the F-02 migration applies cleanly" would be a
-- statement about a table with nothing in it.
--
-- Everything here is synthetic. The only real-looking value is the dev@newme.ae
-- address, which is the literal the F-02 migration matches on and is already
-- hardcoded in src/app/api/dev/setup/route.ts; there is no password, no token
-- and no production row anywhere in this file.
--
-- Fixed UUIDs, no random(): the assertions reference them by value.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Two privileged identities. The second one exists because the F-02 migration
-- has an interlock that aborts if disabling dev@newme.ae would leave no usable
-- privileged account — the fixture has to satisfy the interlock for the
-- migration to do anything at all, which is itself worth exercising.
--
-- The profiles rows are inserted explicitly rather than left to the
-- on_auth_user_created trigger from 20260601000000_init.sql:30. That trigger is
-- real in production, but the branch-mode floor does not carry it, and a fixture
-- whose rows appear only as a side effect of a trigger the harness happens to
-- have is a fixture that fails for reasons unrelated to what is being tested.
-- ON CONFLICT DO NOTHING keeps it correct either way.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, last_sign_in_at, created_at)
values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'dev@newme.ae',
   now() - interval '30 days', now() - interval '1 day', now() - interval '30 days'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'replay-admin@example.invalid',
   now() - interval '30 days', now() - interval '1 hour', now() - interval '30 days')
on conflict (id) do nothing;

insert into public.profiles (id, email, role, is_active, full_name)
values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'dev@newme.ae',
   'admin', true, 'Replay dev account'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'replay-admin@example.invalid',
   'admin', true, 'Replay surviving admin')
on conflict (id) do update
   set role = 'admin', is_active = true, full_name = excluded.full_name;

-- ---------------------------------------------------------------------------
-- Audit attributions owned by the dev account. The revision of the F-02
-- migration that DELETED the account would have nulled these (actor_id is
-- ON DELETE SET NULL) and cascade-deleted the profile; the assertions require
-- both the rows and the attribution to survive.
-- ---------------------------------------------------------------------------
insert into public.audit_logs (actor_id, action, target_type, details)
values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'REPLAY_FIXTURE_ACTION', 'replay', '{}'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'REPLAY_FIXTURE_ACTION', 'replay', '{}');

-- ---------------------------------------------------------------------------
-- A KPI period to destroy. Two rows, one assigned and one unassigned, because
-- the nullable assigned_to is the reason the route cannot use an upsert.
-- ---------------------------------------------------------------------------
insert into public.kpi_targets (period, target_type, target_amount, assigned_to, set_by)
values
  ('2026-99', 'signing',    100000.00, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('2026-99', 'collection',  50000.00, null,
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
