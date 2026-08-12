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

-- ---------------------------------------------------------------------------
-- Money-path identities.
--
-- The F-09 findings are about WHO a routine believes it is acting for, so the
-- fixture needs more than one role and more than one owner: an impersonation
-- test needs a real target to impersonate, and an ownership test needs a real
-- colleague to steal from.
--
-- 99999999 is a privileged account that is switched off. It exists because
-- money_actor's is_active check is the database half of the revocation boundary,
-- and testing that needs an identity which is privileged and disabled at once.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, created_at)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'replay-boss@example.invalid',     now(), now()),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'replay-sales1@example.invalid',   now(), now()),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'replay-sales2@example.invalid',   now(), now()),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'replay-finance@example.invalid',  now(), now()),
  ('99999999-9999-9999-9999-999999999999', 'replay-disabled@example.invalid', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, email, role, is_active, full_name)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'replay-boss@example.invalid',     'boss',    true,  'Replay boss'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'replay-sales1@example.invalid',   'sales',   true,  'Replay sales one'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'replay-sales2@example.invalid',   'sales',   true,  'Replay sales two'),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'replay-finance@example.invalid',  'finance', true,  'Replay finance'),
  ('99999999-9999-9999-9999-999999999999', 'replay-disabled@example.invalid', 'admin',   false, 'Replay disabled admin')
on conflict (id) do update
   set role = excluded.role, is_active = excluded.is_active, full_name = excluded.full_name;

-- ---------------------------------------------------------------------------
-- Two more identities, one for each role hole round 3 found.
--
-- 0a0a is an operator. 'operator' is a real value of profiles_role_check, the
-- product rule allows it on the approval surface, and the documented rule does
-- NOT allow it on the settlement surface — so proving P1-9 needs an identity that
-- is refused by confirm/allocate/void and still accepted by approve_contract,
-- otherwise "refused" could just mean "operator can do nothing".
--
-- 0b0b has no role at all. profiles.role is nullable and a CHECK constraint is
-- satisfied by NULL, so this is a row production can already hold; and because
-- `not (NULL = any (array[...]))` is NULL rather than true, money_actor's role
-- test did not fire for it (P1-1). is_active is true on purpose: a refusal must be
-- attributable to the missing role and not to the account being switched off.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at, created_at)
values
  ('0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'replay-operator@example.invalid', now(), now()),
  ('0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b', 'replay-roleless@example.invalid', now(), now())
on conflict (id) do nothing;

insert into public.profiles (id, email, role, is_active, full_name)
values
  ('0a0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a', 'replay-operator@example.invalid', 'operator', true, 'Replay operator'),
  ('0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b', 'replay-roleless@example.invalid', null,       true, 'Replay roleless')
on conflict (id) do update
   set role = excluded.role, is_active = excluded.is_active, full_name = excluded.full_name;

-- ---------------------------------------------------------------------------
-- One lead per contract, because idx_contracts_one_active_per_lead permits only
-- one non-terminal contract per lead — the same index create_contract's
-- duplicate pre-check mirrors.
-- ---------------------------------------------------------------------------
insert into public.leads (id, assigned_to, stage, customer_name)
values
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'won', 'Replay lead C1'),
  ('22222222-2222-2222-2222-222222222222', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'new', 'Replay lead free'),
  ('33333333-3333-3333-3333-333333333333', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'new', 'Replay lead other sales'),
  ('44444444-4444-4444-4444-444444444444', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'won', 'Replay lead C2'),
  ('55555555-5555-5555-5555-555555555555', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'won', 'Replay lead C3'),
  ('66666666-6666-6666-6666-666666666666', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'new', 'Replay lead Q1'),
  ('77777777-7777-7777-7777-777777777777', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'won', 'Replay lead C4'),
  ('88888888-8888-8888-8888-888888888888', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'new', 'Replay lead Q2'),
  -- Two leads reserved for the role-hole probes, and reserved is the point: those
  -- probes have to create a contract through create_contract(), which refuses a
  -- lead that already carries a non-terminal one. Every other lead above has been
  -- used by an earlier section by then, so a probe that borrowed one would fail on
  -- 23505 and say nothing about roles.
  ('0c0c0c0c-0c0c-0c0c-0c0c-0c0c0c0c0c0c', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'won', 'Replay lead K7 setup'),
  ('0d0d0d0d-0d0d-0d0d-0d0d-0d0d0d0d0d0d', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'won', 'Replay lead K7 probe')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Contracts.
--
-- C3's contract_no is deliberately NEW-<today>-007: it is the seed for
-- next_contract_no and it is also the exact shape that broke the old
-- count(*)-based numbering. With one contract already dated today, count(*) = 1
-- produces NEW-<today>-001 — a number that can already exist — while the highest
-- number issued today is 7. The next number must be 008.
-- ---------------------------------------------------------------------------
insert into public.contracts (
  id, lead_id, sales_id, created_by, contract_no, contract_date, contract_amount,
  party_a_name, status, first_payment_status
) values
  ('c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', '11111111-1111-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'REPLAY-C1', current_date, 100000.00, 'Replay party A', 'pending_admin', 'unpaid'),
  ('c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2', '44444444-4444-4444-4444-444444444444',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'REPLAY-C2', current_date, 100000.00, 'Replay party A', 'draft', 'unpaid'),
  ('c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', '55555555-5555-5555-5555-555555555555',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'NEW-' || to_char(current_date, 'YYYYMMDD') || '-007', current_date, 100000.00,
   'Replay party A', 'active', 'unpaid'),
  ('c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4', '77777777-7777-7777-7777-777777777777',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
   'REPLAY-C4', current_date, 100000.00, 'Replay party A', 'active', 'unpaid')
on conflict (id) do nothing;

-- C1 is mid-approval: one pending admin_review row, which is what
-- approve_contract has to settle instead of leaving behind.
insert into public.contract_approvals (id, contract_id, step, status)
values ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1',
        'c1c1c1c1-c1c1-c1c1-c1c1-c1c1c1c1c1c1', 'admin_review', 'pending')
on conflict (id) do nothing;

-- C3's schedule, plus one plan on C4 so that a cross-contract allocation has a
-- real plan id from the wrong contract to aim at.
insert into public.installment_plans (id, contract_id, seq, amount, due_date, status)
values
  ('91111111-1111-1111-1111-111111111111', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 1, 50000.00, current_date,      'pending'),
  ('92222222-2222-2222-2222-222222222222', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', 2, 50000.00, current_date + 30, 'pending'),
  ('94444444-4444-4444-4444-444444444444', 'c4c4c4c4-c4c4-c4c4-c4c4-c4c4c4c4c4c4', 1, 50000.00, current_date,      'pending')
on conflict (id) do nothing;

-- One unconfirmed payment to confirm, and one already-confirmed payment whose
-- columns must be frozen against a direct write.
insert into public.payments (id, contract_id, amount, payment_date, confirmed, created_by)
values
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
   60000.00, current_date, false, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2', 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3',
   10000.00, current_date, true,  'cccccccc-cccc-cccc-cccc-cccccccccccc')
on conflict (id) do nothing;

update public.payments
   set confirmed_by = 'ffffffff-ffff-ffff-ffff-ffffffffffff', confirmed_at = now()
 where id = 'd2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2';

-- The two cascade targets that confirm_payment was silently skipping.
insert into public.projects (id, name, contract_id, lead_id, sales_id, contract_amount, paid_amount)
values ('99991111-1111-1111-1111-111111111111', 'Replay project C3',
        'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3', '55555555-5555-5555-5555-555555555555',
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 100000.00, 0)
on conflict (id) do nothing;

insert into public.kpi_targets (period, target_type, target_amount, actual_amount, assigned_to, set_by)
values (to_char(current_date, 'YYYY-MM'), 'collection', 500000.00, 0,
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict (period, target_type, assigned_to) do nothing;

-- Quotations: one accepted and owned by sales1 (the conversion happy path), one
-- accepted and owned by sales2 (the non-owner refusal), one still a draft.
insert into public.quotations (id, lead_id, quote_no, status, subtotal, total_amount, created_by)
values
  ('b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1', '66666666-6666-6666-6666-666666666666',
   'REPLAY-Q1', 'accepted', 80000.00, 80000.00, 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  ('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', '88888888-8888-8888-8888-888888888888',
   'REPLAY-Q2', 'accepted', 80000.00, 80000.00, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  ('b3b3b3b3-b3b3-b3b3-b3b3-b3b3b3b3b3b3', '22222222-2222-2222-2222-222222222222',
   'REPLAY-Q3', 'draft',    80000.00, 80000.00, 'cccccccc-cccc-cccc-cccc-cccccccccccc')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Round 4 fixtures
-- ---------------------------------------------------------------------------

-- A1. A recorded lead-note request, so record_lead_note_atomic() can be called
-- on its idempotent-replay branch — the branch that RETURNS before the first
-- INSERT and therefore never reaches the statement trigger. Without this row the
-- early-return path is not reachable and the finding is not measurable.
insert into public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
values ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'lead_note',
        'aaaa1111-2222-3333-4444-555566667777', '22222222-2222-2222-2222-222222222222',
        jsonb_build_object('lead_id', '22222222-2222-2222-2222-222222222222',
                           'note_id', '99990000-0000-0000-0000-000000000001'))
on conflict (actor_id, operation, idempotency_key) do nothing;

-- B6. A quotation on a lead with NO customer row and NO customer_id, owned by
-- sales1 and accepted, so a conversion has to create the customer, set
-- leads.customer_id and record the won business event. REPLAY-Q1 cannot be used
-- for this: the other conversion assertions consume it.
insert into public.leads (id, assigned_to, stage, customer_name, phone, email,
                          property_type, property_size_sqm, location, quotation_value)
values ('0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'new', 'Replay lead B6', '+971500000006', 'b6@example.invalid',
        'villa', 420, 'Replay District', 80000.00)
on conflict (id) do nothing;

insert into public.quotations (id, lead_id, quote_no, status, subtotal, total_amount, created_by)
values ('b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6', '0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e',
        'REPLAY-Q6', 'accepted', 80000.00, 80000.00,
        'cccccccc-cccc-cccc-cccc-cccccccccccc')
on conflict (id) do nothing;

-- B5. A second lead + contract that belongs to nobody in the conversion under
-- test, so "an already-converted quotation whose contract_id points at another
-- lead's contract" is constructible. The contract is created directly here
-- because the fixtures load before the guards care about the mode — the same way
-- every other contract fixture is seeded.
insert into public.leads (id, assigned_to, stage, customer_name)
values ('0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        'new', 'Replay lead B5 foreign')
on conflict (id) do nothing;

insert into public.contracts (id, lead_id, sales_id, created_by, contract_no,
                              contract_amount, party_a_name, status)
values ('c5c5c5c5-c5c5-c5c5-c5c5-c5c5c5c5c5c5', '0f0f0f0f-0f0f-0f0f-0f0f-0f0f0f0f0f0f',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        'REPLAY-B5-FOREIGN', 55000.00, 'Replay lead B5 foreign', 'draft')
on conflict (id) do nothing;

-- B3. A confirmed payment whose amount is positive, plus the installment plan it
-- was allocated to, on a contract of its own — so the "a negative payment cannot
-- be created and cannot be confirmed" probes have somewhere to write that does
-- not disturb the C3 chain the other money assertions measure.
insert into public.leads (id, assigned_to, stage, customer_name)
values ('0909a0a0-0909-0909-0909-090909090909', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'won', 'Replay lead B3')
on conflict (id) do nothing;

insert into public.contracts (id, lead_id, sales_id, created_by, contract_no,
                              contract_amount, party_a_name, status)
values ('c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6', '0909a0a0-0909-0909-0909-090909090909',
        'cccccccc-cccc-cccc-cccc-cccccccccccc', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        'REPLAY-B3', 100000.00, 'Replay lead B3', 'active')
on conflict (id) do nothing;

insert into public.installment_plans (id, contract_id, seq, amount, due_date, status)
values ('96666666-6666-6666-6666-666666666666', 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6',
        1, 40000.00, current_date, 'pending')
on conflict (id) do nothing;

insert into public.payments (id, contract_id, amount, payment_date, confirmed, created_by)
values ('d6d6d6d6-d6d6-d6d6-d6d6-d6d6d6d6d6d6', 'c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6',
        40000.00, current_date, false, 'cccccccc-cccc-cccc-cccc-cccccccccccc')
on conflict (id) do nothing;

-- B7. A collection KPI target for sales2 in the current period, so a void that
-- credits the wrong salesperson has a second row it could wrongly move.
insert into public.kpi_targets (period, target_type, target_amount, actual_amount, assigned_to, set_by)
values (to_char(current_date, 'YYYY-MM'), 'collection', 500000.00, 0,
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict (period, target_type, assigned_to) do nothing;
