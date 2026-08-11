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
-- scripts/replay-migrations.sh` reproduces it, and it is gated against a recorded
-- expectation in supabase/replay/history-replay-expectation.txt rather than
-- narrated. What it finds, in the first three files:
--
--   * 1780601210_workflow_stages.sql carries a 10-digit unix epoch instead of the
--     14-digit timestamp the Supabase CLI requires, so the CLI never saw it, yet
--     lead_workflow_stages exists in production. An earlier revision of this
--     branch RENAMED it to a 14-digit stamp. That was a history rewrite of a file
--     production has already recorded, and it has been reverted: the file is back
--     to its exact base bytes and name, and it is pinned by name and hash in
--     supabase/migration-history-baseline.sha256 so the defect stays visible
--     instead of being edited away.
--   * 20260603000000_add_crm_fields.sql contains `ALTER TABLE TABLE`, a syntax
--     error, and the CLI runs each file in one transaction — so the file never
--     applied at all, anywhere. An earlier revision of this branch tombstoned it.
--     Also reverted, for the same reason: production records the migration as
--     applied, and rewriting the file does not change that.
--   * 20260602010000_crm_mvp_final.sql:125 recreates the lead_alerts view
--     selecting leads.rep_name, a column no migration creates. This is where the
--     from-empty replay stops today.
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
-- So the gate is scoped to what it can actually prove: the migrations this branch
-- adds, replayed onto a floor that reproduces the vulnerable production state,
-- with behaviour assertions that execute the boundaries afterwards.
--
-- Fidelity notes, stated rather than hidden:
--   * Column sets come from the committed, production-generated
--     src/types/database.ts. Only the columns the branch's migrations and the
--     assertions touch are declared; this is a floor, not a schema dump.
--   * The three money routines are the REAL pre-remediation bodies, copied from
--     20260612000001_rpc_functions.sql, not stubs. An earlier revision had stubs,
--     on the reasoning that F-09 changed only their EXECUTE privileges. That is no
--     longer true and was never a good enough reason: the finding being closed now
--     is that the bodies trust a caller-supplied approver / confirmer / allocator
--     id, and an assertion that a stub refuses to impersonate anyone proves
--     nothing. They are SECURITY INVOKER here because that is what the committed
--     history actually defines — no migration in the directory declares them
--     SECURITY DEFINER, despite the name of
--     20260723130000_lock_definer_boundaries.sql, which only pins their
--     search_path. 20260812000000 is what makes them definer, and it has to,
--     because they can no longer read the caller's identity from an argument.
--   * profiles.password_changed_at, profiles.force_password_change and
--     leads.rep_name are deliberately ABSENT here, so that
--     20260806000000_baseline_undeclared_production_objects.sql is exercised
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
  -- 20260624000003_fix_trg_lead_won.sql keys the won-lead automation off this
  -- column, and convert_quotation_to_contract writes it as the last step of a
  -- conversion, so a floor without it cannot exercise either.
  final_status  text,
  customer_name text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.leads enable row level security;

-- Column names, nullability and the status CHECK come from the committed,
-- production-generated src/types/database.ts plus the migrations that widened the
-- status domain (20260612000000_contract_pipeline_v1.sql onward). The names
-- matter: the pre-remediation routine bodies below reference contract_amount,
-- first_payment_status, allocated_amount and amount_allocated, and a floor with
-- invented names would make them fail for reasons unrelated to the findings.
create table public.contracts (
  id                     uuid primary key default extensions.uuid_generate_v4(),
  lead_id                uuid          not null references public.leads (id),
  quotation_id           uuid,
  customer_id            uuid,
  sales_id               uuid references public.profiles (id),
  created_by             uuid references public.profiles (id),
  contract_no            text          not null unique,
  contract_date          date          not null default current_date,
  contract_amount        numeric(12, 2) not null check (contract_amount > 0),
  currency               text        default 'AED',
  party_a_name           text          not null,
  party_a_contact        text,
  party_b_name           text          not null default 'NewMe Smart Home FZCO',
  party_b_contact        text,
  file_url               text,
  file_metadata          jsonb,
  sealed_file_url        text,
  sealed_file_metadata   jsonb,
  status                 text          not null default 'draft'
    check (status in ('draft', 'pending_admin', 'pending_ceo', 'approved', 'rejected',
                      'active', 'completed', 'terminated', 'suspended', 'cancelled', 'archived')),
  approval_status        text        default 'none',
  first_payment_status   text          not null default 'unpaid',
  first_payment_due_date date,
  notes                  text,
  terminated_reason      text,
  terminated_at          timestamptz,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- 20260627000000_contracts_unique_active_per_lead.sql:10. create_contract's
-- duplicate pre-check mirrors this predicate, so the floor has to carry it or the
-- two cannot be shown to agree.
create unique index idx_contracts_one_active_per_lead
  on public.contracts (lead_id)
  where status not in ('archived', 'cancelled', 'terminated');

create table public.quotations (
  id            uuid primary key default extensions.uuid_generate_v4(),
  lead_id       uuid          not null references public.leads (id),
  quote_no      text unique,
  quotation_type text       default 'standard',
  status        text          not null default 'draft',
  subtotal      numeric(12, 2) not null default 0,
  total_amount  numeric(12, 2) not null default 0,
  currency      text        default 'AED',
  valid_until   date          not null default (current_date + 30),
  created_by    uuid references public.profiles (id),
  contract_id   uuid references public.contracts (id),
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create table public.payments (
  id                  uuid primary key default extensions.uuid_generate_v4(),
  contract_id         uuid          not null references public.contracts (id),
  installment_plan_id uuid,
  amount              numeric(12, 2) not null,
  currency            text        default 'AED',
  payment_date        date          not null default current_date,
  payment_method      text,
  reference_no        text,
  received_at         timestamptz,
  confirmed           boolean     default false,
  confirmed_by        uuid references public.profiles (id),
  confirmed_at        timestamptz,
  overpayment_action  text,
  notes               text,
  created_by          uuid references public.profiles (id),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

create table public.installment_plans (
  id               uuid primary key default extensions.uuid_generate_v4(),
  contract_id      uuid          not null references public.contracts (id) on delete cascade,
  seq              integer       not null,
  amount           numeric(12, 2) not null,
  allocated_amount numeric(12, 2) not null default 0,
  paid_amount      numeric(12, 2) default 0,
  due_date         date          not null,
  description      text,
  status           text          not null default 'pending',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create table public.contract_approvals (
  id          uuid primary key default extensions.uuid_generate_v4(),
  tenant_id   uuid not null default '00000000-0000-0000-0000-000000000000',
  contract_id uuid not null references public.contracts (id) on delete cascade,
  step        text not null,
  approver_id uuid references public.profiles (id),
  status      text not null default 'pending',
  notes       jsonb,
  reviewed_at timestamptz,
  created_at  timestamptz default now()
);

create table public.payment_allocations (
  id               uuid primary key default extensions.uuid_generate_v4(),
  tenant_id        uuid not null default '00000000-0000-0000-0000-000000000000',
  payment_id       uuid not null references public.payments (id) on delete cascade,
  plan_id          uuid not null references public.installment_plans (id) on delete cascade,
  amount_allocated numeric(12, 2) not null,
  allocated_by     uuid references public.profiles (id),
  created_at       timestamptz default now()
);

-- confirm_payment writes projects.paid_amount, and the whole point of one of the
-- assertions below is that it never actually did. The table has to exist for that
-- to be a behaviour test rather than a missing-relation error.
create table public.projects (
  id              uuid primary key default extensions.uuid_generate_v4(),
  name            text not null,
  contract_id     uuid references public.contracts (id),
  lead_id         uuid references public.leads (id),
  sales_id        uuid references public.profiles (id),
  contract_amount numeric(12, 2),
  paid_amount     numeric(12, 2) default 0,
  status          text        default 'active',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.contracts           enable row level security;
alter table public.quotations          enable row level security;
alter table public.payments            enable row level security;
alter table public.installment_plans   enable row level security;
alter table public.contract_approvals  enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.projects            enable row level security;

-- Ten call sites write these tables with the CALLER'S client, so `authenticated`
-- holds table privileges on all of them. This is exactly what the reviewed
-- revision of the F-09 migration would have revoked.
grant select, insert, update, delete on public.contracts           to authenticated;
grant select, insert, update, delete on public.quotations          to authenticated;
grant select, insert, update, delete on public.payments            to authenticated;
grant select, insert, update, delete on public.installment_plans   to authenticated;
grant select, insert, update, delete on public.contract_approvals  to authenticated;
grant select, insert, update, delete on public.payment_allocations to authenticated;
grant select, insert, update, delete on public.projects            to authenticated;

-- ---------------------------------------------------------------------------
-- The pre-remediation RLS on the money tables, as the migrations define it.
--
-- The two UPDATE policies are the F-09 sub-finding: USING with no WITH CHECK, so
-- Postgres reuses the USING expression as the check and evaluates it against the
-- NEW row. `sales_id = auth.uid()` therefore permits rewriting every other
-- column — status, contract_amount, confirmed — as long as the row stays yours.
-- 20260812000000 adds the WITH CHECK and moves the column boundary to a trigger.
-- ---------------------------------------------------------------------------
create policy contracts_admin_all on public.contracts for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator')));
create policy contracts_sales_select on public.contracts for select to authenticated
  using (sales_id = auth.uid());
create policy contracts_sales_insert on public.contracts for insert to authenticated
  with check (sales_id = auth.uid());
create policy policy_contracts_update_sales on public.contracts for update to authenticated
  using (sales_id = auth.uid());

create policy payments_admin_all on public.payments for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator', 'finance')));
create policy payments_sales_select on public.payments for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = payments.contract_id and c.sales_id = auth.uid()));
create policy payments_sales_insert on public.payments for insert to authenticated
  with check (exists (select 1 from public.contracts c where c.id = payments.contract_id and c.sales_id = auth.uid()));
create policy policy_payments_update_sales on public.payments for update to authenticated
  using (exists (select 1 from public.contracts c where c.id = payments.contract_id and c.sales_id = auth.uid()));

-- The other half of the quotation-conversion finding: only a manager may insert
-- the installment and approval rows the conversion has to create, so a sales user
-- running the multi-step route got a contract with no schedule and no approval
-- row and no error that said so.
create policy installment_plans_admin_all on public.installment_plans for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator', 'finance')));
create policy installment_plans_select on public.installment_plans for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = installment_plans.contract_id and c.sales_id = auth.uid()));

create policy contract_approvals_admin_all on public.contract_approvals for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator')));
create policy contract_approvals_select on public.contract_approvals for select to authenticated
  using (exists (select 1 from public.contracts c where c.id = contract_approvals.contract_id and c.sales_id = auth.uid()));

create policy payment_allocations_admin_all on public.payment_allocations for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator', 'finance')));

create policy quotations_admin_all on public.quotations for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator')));
create policy quotations_sales_select on public.quotations for select to authenticated
  using (exists (select 1 from public.leads l where l.id = quotations.lead_id and l.assigned_to = auth.uid()));
create policy quotations_sales_update on public.quotations for update to authenticated
  using (created_by = auth.uid());

create policy projects_admin_all on public.projects for all to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator')));

-- ---------------------------------------------------------------------------
-- Money routines — the REAL pre-remediation bodies.
--
-- Copied from 20260612000001_rpc_functions.sql, with two mechanical changes and
-- no behavioural ones:
--   * `set search_path = pg_catalog, public, pg_temp`, which is the state
--     production is in after 20260723130000 and 20260805202917 ALTER it in;
--   * `public.` on the routine names, so the floor does not depend on the session
--     search_path to decide where they land.
--
-- SECURITY INVOKER, because no migration in the directory makes them definer.
-- EXECUTE is held through PUBLIC, the PostgreSQL default for a new function and
-- the state F-09 reports: `authenticated` can call them, but only because
-- everyone can, including anon.
--
-- What these bodies contain, and what the assertions in
-- 10_assert_release_contracts.sql execute against them:
--   * p_approver_id / p_confirmer_id / p_allocated_by are taken on trust. The
--     caller says who they are and the function believes it. approve_contract
--     reads the ROLE of the id it was handed, so a sales user who can call it at
--     all can approve their own contract by passing a director's uuid.
--   * confirm_payment has no authorization check of any kind.
--   * allocate_payment never checks that plan_id belongs to the payment's
--     contract, and recomputes only the plans in the NEW allocation set, so the
--     plans a reallocation removed keep their old allocated_amount and 'paid'.
--   * `IF v_contract IS NOT NULL` is false whenever any column of the composite is
--     null, which for this table is always, so neither projects.paid_amount nor
--     kpi_targets.actual_amount was ever updated by a confirmation.
--   * errors are RETURNED as jsonb, so every one of these reaches the client as
--     HTTP 200 with a body the routes do not inspect.
-- ---------------------------------------------------------------------------
create or replace function public.approve_contract(
  p_contract_id uuid,
  p_approver_id uuid,
  p_action text,
  p_notes text default null
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
DECLARE
  v_contract RECORD;
  v_step TEXT;
  v_new_status TEXT;
  v_approver_role TEXT;
  v_result JSONB;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Contract not found');
  END IF;

  SELECT role INTO v_approver_role FROM profiles WHERE id = p_approver_id;
  IF v_approver_role IS NULL THEN
    RETURN jsonb_build_object('error', 'Approver profile not found');
  END IF;

  IF v_approver_role IN ('admin', 'operator') THEN
    v_step := 'admin_review';
  ELSIF v_approver_role = 'boss' THEN
    v_step := 'ceo_review';
  ELSE
    RETURN jsonb_build_object('error', 'Role not authorized to approve');
  END IF;

  IF v_contract.status NOT IN ('pending_admin', 'pending_ceo') THEN
    RETURN jsonb_build_object('error', 'Contract not in approvable state', 'current_status', v_contract.status);
  END IF;

  IF v_step = 'admin_review' AND v_contract.status != 'pending_admin' THEN
    RETURN jsonb_build_object('error', 'Admin review not applicable', 'current_status', v_contract.status);
  END IF;
  IF v_step = 'ceo_review' AND v_contract.status != 'pending_ceo' THEN
    RETURN jsonb_build_object('error', 'CEO review not applicable', 'current_status', v_contract.status);
  END IF;

  IF p_action = 'approve' THEN
    IF v_step = 'admin_review' THEN
      v_new_status := 'pending_ceo';
    ELSIF v_step = 'ceo_review' THEN
      v_new_status := 'approved';
    END IF;

    UPDATE contracts SET status = v_new_status, updated_at = now() WHERE id = p_contract_id;

    INSERT INTO contract_approvals (contract_id, step, approver_id, status, notes, reviewed_at)
    VALUES (p_contract_id, v_step, p_approver_id, 'approved',
      COALESCE(to_jsonb(p_notes), 'null'::jsonb), now());

    v_result := jsonb_build_object('success', true, 'action', 'approved', 'new_status', v_new_status, 'step', v_step);

  ELSIF p_action = 'reject' THEN
    UPDATE contracts SET status = 'rejected', updated_at = now() WHERE id = p_contract_id;

    INSERT INTO contract_approvals (contract_id, step, approver_id, status, notes, reviewed_at)
    VALUES (p_contract_id, v_step, p_approver_id, 'rejected',
      COALESCE(to_jsonb(p_notes), 'null'::jsonb), now());

    v_result := jsonb_build_object('success', true, 'action', 'rejected', 'new_status', 'rejected', 'step', v_step);
  ELSE
    RETURN jsonb_build_object('error', 'Invalid action', 'action', p_action);
  END IF;

  RETURN v_result;
END;
$$;

create or replace function public.allocate_payment(
  p_payment_id uuid,
  p_allocations jsonb,
  p_allocated_by uuid
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
DECLARE
  v_payment RECORD;
  v_total_allocated DECIMAL(12,2) := 0;
  v_plan_id UUID;
  v_amount DECIMAL(12,2);
  v_plan_allocated DECIMAL(12,2);
  v_plan_amount DECIMAL(12,2);
  v_plan_status TEXT;
  v_count INT := 0;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;

  FOR i IN 0..jsonb_array_length(p_allocations) - 1 LOOP
    v_total_allocated := v_total_allocated + (p_allocations->i->>'amount')::DECIMAL(12,2);
  END LOOP;

  IF v_total_allocated > v_payment.amount THEN
    RETURN jsonb_build_object('error', 'Total allocation exceeds payment amount',
      'total_allocated', v_total_allocated, 'payment_amount', v_payment.amount);
  END IF;

  DELETE FROM payment_allocations WHERE payment_id = p_payment_id;

  FOR i IN 0..jsonb_array_length(p_allocations) - 1 LOOP
    v_plan_id := (p_allocations->i->>'plan_id')::UUID;
    v_amount := (p_allocations->i->>'amount')::DECIMAL(12,2);

    INSERT INTO payment_allocations (payment_id, plan_id, amount_allocated, allocated_by)
    VALUES (p_payment_id, v_plan_id, v_amount, p_allocated_by);

    v_count := v_count + 1;
  END LOOP;

  FOR v_plan_id IN
    SELECT DISTINCT plan_id FROM payment_allocations WHERE payment_id = p_payment_id
  LOOP
    SELECT COALESCE(SUM(amount_allocated), 0) INTO v_plan_allocated
    FROM payment_allocations WHERE plan_id = v_plan_id;

    SELECT amount INTO v_plan_amount FROM installment_plans WHERE id = v_plan_id;

    IF v_plan_allocated >= v_plan_amount THEN
      v_plan_status := 'paid';
    ELSIF v_plan_allocated > 0 THEN
      v_plan_status := 'partial';
    ELSE
      v_plan_status := 'pending';
    END IF;

    UPDATE installment_plans
    SET allocated_amount = v_plan_allocated, status = v_plan_status, updated_at = now()
    WHERE id = v_plan_id;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'allocations_count', v_count, 'total_allocated', v_total_allocated);
END;
$$;

create or replace function public.confirm_payment(
  p_payment_id uuid,
  p_confirmer_id uuid
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
DECLARE
  v_payment RECORD;
  v_contract RECORD;
  v_first_plan_id UUID;
  v_first_plan_allocated DECIMAL(12,2);
  v_first_plan_amount DECIMAL(12,2);
  v_fp_status TEXT;
  v_total_paid DECIMAL(12,2);
  v_kpi_assigned_to UUID;
  v_kpi_period TEXT;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Payment not found');
  END IF;
  IF v_payment.confirmed THEN
    RETURN jsonb_build_object('error', 'Payment already confirmed');
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = v_payment.contract_id FOR UPDATE;

  UPDATE payments
  SET confirmed = true, confirmed_by = p_confirmer_id, confirmed_at = now(), updated_at = now()
  WHERE id = p_payment_id;

  SELECT id, amount INTO v_first_plan_id, v_first_plan_amount
  FROM installment_plans
  WHERE contract_id = v_payment.contract_id AND seq = 1
  LIMIT 1;

  IF v_first_plan_id IS NOT NULL THEN
    SELECT COALESCE(SUM(pa.amount_allocated), 0) INTO v_first_plan_allocated
    FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    WHERE pa.plan_id = v_first_plan_id AND p.confirmed = true;

    IF v_first_plan_allocated >= v_first_plan_amount THEN
      v_fp_status := 'paid';
    ELSIF v_first_plan_allocated > 0 THEN
      v_fp_status := 'partial';
    ELSE
      v_fp_status := 'unpaid';
    END IF;

    UPDATE contracts
    SET first_payment_status = v_fp_status, updated_at = now()
    WHERE id = v_payment.contract_id;
  END IF;

  IF v_contract IS NOT NULL THEN
    SELECT COALESCE(SUM(p.amount), 0) INTO v_total_paid
    FROM payments p WHERE p.contract_id = v_payment.contract_id AND p.confirmed = true;

    UPDATE projects SET paid_amount = v_total_paid, updated_at = now()
    WHERE contract_id = v_payment.contract_id;
  END IF;

  IF v_contract IS NOT NULL THEN
    v_kpi_assigned_to := v_contract.sales_id;
    v_kpi_period := to_char(v_payment.payment_date, 'YYYY-MM');

    UPDATE kpi_targets
    SET actual_amount = actual_amount + v_payment.amount, updated_at = now()
    WHERE assigned_to = v_kpi_assigned_to
      AND period = v_kpi_period
      AND target_type = 'collection';
  END IF;

  RETURN jsonb_build_object('success', true, 'payment_id', p_payment_id, 'amount', v_payment.amount);
END;
$$;

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
  -- 20260612000000_contract_pipeline_v1.sql:108. confirm_payment increments it,
  -- which is one of the two cascades the composite-null bug silently skipped.
  actual_amount numeric(12,2) not null default 0,
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
