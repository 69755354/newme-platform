-- ============================================================================
-- Replay harness — step 1: schema floor
-- ============================================================================
-- Not a migration. This is the starting schema for branch/control replay: the
-- objects the migrations on this branch touch, in the state production has them
-- in TODAY, before remediation.
--
-- Why a floor instead of the real history
-- ---------------------------------------
-- Replaying supabase/migrations/ from empty does not work, and the reason is a
-- finding in its own right rather than a harness problem. MODE=history no longer
-- treats that known failure as a pass: it verifies the authenticated, zero-row
-- production schema baseline and applies the exact manifest set after its
-- watermark. This smaller floor remains because MODE=control needs the known
-- vulnerable state. The immutable directory's first three defects are:
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
  -- The columns the conversion path actually reads. on_lead_won() reads
  -- new.customer_id, new.property_type, new.property_size_sqm and new.location
  -- (20260812000000:1278-1310, and the same four in 20260624000003 before it),
  -- and convert_quotation_to_contract() carries them into the project row. The
  -- floor did not have them, so the conversion probe failed with
  -- `record "v_lead" has no field "customer_id"` — a floor artefact that stood
  -- between the harness and the behaviour under test.
  --
  -- Sources: 20260601000000_init.sql:47-51 (property_type, property_size_sqm,
  -- location) and 20260605000000_newme_crm_v22_complete.sql:186 (customer_id);
  -- all four are present in the production-generated src/types/database.ts.
  customer_id       uuid,
  property_type     text,
  property_size_sqm integer,
  location          text,
  -- Production requires source (captured baseline: text NOT NULL). The compact
  -- floor keeps it nullable because older negative-control fixtures predate that
  -- requirement, but it must expose the column so the same production-valid
  -- behaviour fixtures and migration probes run in both catalog shapes.
  source        text,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.leads enable row level security;

-- The floor enabled RLS on leads and carried no policies, which is not the state
-- the release starts from: 20260630200000_rls_policy_remediation.sql:178-220 is
-- applied in production and gives every authenticated role a way in. With RLS on
-- and no policy, `authenticated` cannot read a single lead — and because
-- policy_quotations_select_sales and its floor equivalent reach leads to decide
-- visibility, a session could not see, let alone write, a quotation either. Any
-- probe that measures what an end-user session can do to a lead or a quotation was
-- therefore passing against a table nobody could touch. Reproduced while writing
-- the B5 probes: as the owning salesperson, with a current session,
-- `select count(*) from leads where id = <their own lead>` returned 0.
--
-- Copied from that migration, in the floor's style. Verbatim in meaning, including
-- the part that matters for B5: the sales UPDATE policies carry a USING clause and
-- no WITH CHECK, so the release lets a salesperson write any column of a row they
-- own — which is what makes a guard, not a policy, the right place to protect a
-- derived or structural field.
create policy policy_leads_select_admin on public.leads for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss','operator')));
create policy policy_leads_select_sales on public.leads for select to authenticated
  using (assigned_to = auth.uid());
create policy policy_leads_insert_admin on public.leads for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss','operator')));
create policy policy_leads_insert_sales on public.leads for insert to authenticated
  with check (assigned_to = auth.uid() or assigned_to is null);
create policy policy_leads_update_admin on public.leads for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss','operator')));
create policy policy_leads_update_sales on public.leads for update to authenticated
  using (assigned_to = auth.uid());
create policy policy_leads_delete_admin on public.leads for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss')));
create policy policy_leads_delete_sales on public.leads for delete to authenticated
  using (assigned_to = auth.uid());

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
  -- Byte-for-byte the domain the last migration to touch it declares
  -- (20260612000002_contract_pipeline_fix.sql:69-75), named the same way so an
  -- assertion can address it. The floor previously invented this list: it added
  -- 'cancelled' and 'archived' (which appear only in the partial-index predicate
  -- below, not in the constraint) and omitted 'revoking' and 'superseded' — the
  -- two statuses revoke_contract() writes. The result was that the P1-8 transition
  -- probe failed with 23514 from a floor-only constraint instead of exercising the
  -- transition graph, so the floor was hiding the finding rather than reproducing
  -- it.
  status                 text          not null default 'draft',
  constraint contracts_status_check check (status in (
    'draft', 'pending_admin', 'pending_ceo', 'approved',
    'active', 'revoking', 'superseded', 'suspended',
    'completed', 'terminated', 'rejected'
  )),
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
  -- 20260601000000_init.sql:108-120 plus
  -- 20260605000000_newme_crm_v22_complete.sql:226 (customer_id). These are the
  -- columns on_lead_won() and convert_quotation_to_contract() write; the floor
  -- carried only the money ones, so the project insert could not be executed at
  -- all and the conversion's atomicity was untestable.
  customer_id     uuid,
  property_type   text,
  property_size   integer,
  location        text,
  phase           text        default 'design',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- 20260601000000_init.sql:157-169 plus the 20260605000000_newme_crm_v22_complete.sql
-- :200-213 additions (contract_id, quotation_id, metadata and the widened type
-- domain). convert_quotation_to_contract() and on_lead_won() both write an
-- activity row, so without this table the conversion path is not executable at
-- all and P1-6's atomicity claim cannot be measured.
create table public.activities (
  id           uuid primary key default extensions.uuid_generate_v4(),
  lead_id      uuid references public.leads (id) on delete cascade,
  customer_id  uuid,
  project_id   uuid references public.projects (id),
  user_id      uuid references public.profiles (id),
  contract_id  uuid references public.contracts (id),
  quotation_id uuid references public.quotations (id),
  type         text not null,
  content      text,
  ai_generated boolean     default false,
  duration     integer,
  is_completed boolean     default true,
  due_at       timestamptz,
  priority     text        default 'normal',
  metadata     jsonb,
  created_at   timestamptz default now(),
  constraint activities_type_check check (type in (
    'call', 'whatsapp', 'wechat', 'email', 'meeting', 'sms', 'note', 'task',
    'quote_sent', 'follow_up', 'stage_change', 'quality_change',
    'contract_signed', 'payment_received', 'site_visit', 'cad_review'
  )),
  constraint activities_priority_check check (priority in ('low', 'normal', 'high', 'urgent'))
);

alter table public.contracts           enable row level security;
alter table public.quotations          enable row level security;
alter table public.payments            enable row level security;
alter table public.installment_plans   enable row level security;
alter table public.contract_approvals  enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.projects            enable row level security;
alter table public.activities          enable row level security;

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
grant select, insert, update, delete on public.activities          to authenticated;

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

-- 20260630200000_rls_policy_remediation.sql:670-731, reduced to the two shapes the
-- money paths exercise: managers see and write everything, a salesperson sees and
-- writes activities on their own lead.
create policy policy_activities_select_admin on public.activities for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator')));
create policy policy_activities_select_sales on public.activities for select to authenticated
  using (exists (select 1 from public.leads l where l.id = activities.lead_id and l.assigned_to = auth.uid()));
create policy policy_activities_insert_admin on public.activities for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin', 'boss', 'operator')));
create policy policy_activities_insert_sales on public.activities for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.leads l where l.id = activities.lead_id and l.assigned_to = auth.uid())
  );

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

-- ---------------------------------------------------------------------------
-- Round 4 · the objects the round-4 findings act on
-- ---------------------------------------------------------------------------
-- Three findings could not be measured at all against the floor as it stood,
-- and "the assertion did not fail" was therefore worth nothing:
--
--   A1  Every authenticated SECURITY DEFINER routine must assert the calling
--       session at entry. The floor carried only the money routines, all of
--       which reach the boundary through money_actor(). The routine the finding
--       actually names — record_lead_note_atomic(), whose idempotent-replay
--       branch RETURNS before any DML, so the statement trigger installed by
--       20260814000000 never fires — was absent, so a catalog-driven gate had
--       nothing outside the money surface to cover and the early-return hole was
--       unreachable. It is carried here verbatim from
--       20260723140000_atomic_lead_reassignment.sql:201-259, an already-applied
--       migration, together with the two tables it needs.
--
--   B6  Quotation conversion does not upsert the customer or record the won
--       business event. The floor had neither public.customers nor
--       public.business_events, so on_lead_won()'s customer branch could not run
--       and "the conversion left customer_id null" was not observable.
--
--   B7  leads.quotation_value is what on_lead_won() keys the automation off;
--       without it that path is dead code here.
--
-- Everything below is the PRE-remediation state, taken from the already-applied
-- migrations named against each object. Nothing here anticipates the fix.
-- ---------------------------------------------------------------------------

-- 20260605000000_newme_crm_v22_complete.sql, public.customers, plus the columns
-- on_lead_won() writes. Only those columns are declared; this is a floor.
create table public.customers (
  id                    uuid primary key default extensions.uuid_generate_v4(),
  lead_id               uuid references public.leads (id),
  name                  text not null,
  phone                 text,
  email                 text,
  address               text,
  total_contract_amount numeric(12, 2) default 0,
  last_activity_at      timestamptz,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- 20260601000000_init.sql, public.business_events: the append-only business
-- timeline. The 'won' row is the event B6 says conversion never writes.
create table public.business_events (
  id          uuid primary key default extensions.uuid_generate_v4(),
  lead_id     uuid references public.leads (id) on delete cascade,
  user_id     uuid references public.profiles (id),
  event_type  text not null,
  description text,
  event_data  jsonb       default '{}',
  created_at  timestamptz default now()
);

-- src/types/database.ts, follow_up_logs. record_lead_note_atomic() writes one
-- row here per note.
create table public.follow_up_logs (
  id           uuid primary key default extensions.uuid_generate_v4(),
  lead_id      uuid not null references public.leads (id) on delete cascade,
  user_id      uuid references public.profiles (id),
  created_by   uuid references public.profiles (id),
  contact_type text        not null default 'call',
  contact_time timestamptz not null default now(),
  summary      text        not null default '',
  result       text,
  no_answer    boolean     not null default false,
  created_at   timestamptz default now()
);

-- 20260723140000_atomic_lead_reassignment.sql:3-12, verbatim.
create table public.lead_mutation_requests (
  id              uuid primary key default gen_random_uuid(),
  actor_id        uuid not null references public.profiles (id),
  operation       text not null,
  idempotency_key uuid not null,
  lead_id         uuid not null references public.leads (id),
  response        jsonb not null,
  created_at      timestamptz not null default now(),
  unique (actor_id, operation, idempotency_key)
);

alter table public.customers              enable row level security;
alter table public.business_events        enable row level security;
alter table public.follow_up_logs         enable row level security;
alter table public.lead_mutation_requests enable row level security;

-- The pre-remediation grants. lead_mutation_requests is deliberately
-- unreachable (20260723140000:15) — the routine writes it as the definer.
grant select, insert, update on public.customers       to authenticated;
grant select, insert         on public.business_events to authenticated;
grant select, insert, update on public.follow_up_logs  to authenticated;
revoke all on table public.lead_mutation_requests from public, anon, authenticated;

-- The columns on_lead_won() and record_lead_note_atomic() read and write that
-- the floor's leads table did not declare. quotation_value is
-- 20260612000000_contract_pipeline_v1.sql; phone and email are
-- 20260601000000_init.sql; last_contact_date is
-- 20260605000000_newme_crm_v22_complete.sql.
alter table public.leads
  add column if not exists phone             text,
  add column if not exists email             text,
  add column if not exists quotation_value   numeric(12, 2),
  add column if not exists last_contact_date date;

-- 20260723140000_atomic_lead_reassignment.sql:201-259, verbatim, including the
-- REVOKE/GRANT pair. This is the routine A1 names: the FOUND branch returns the
-- recorded response before the first INSERT, so nothing on that path is covered
-- by the statement trigger 20260814000000 installs, and a session that has been
-- deactivated, banned, forced to change its password or is carrying a token
-- older than the last password change is served normally.
CREATE OR REPLACE FUNCTION public.record_lead_note_atomic(
  p_lead_id uuid,
  p_note text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_note text := btrim(coalesce(p_note, ''));
  v_note_id uuid;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_idempotency_key IS NULL OR v_note = '' OR char_length(v_note) > 4000 THEN
    RAISE EXCEPTION 'INVALID_NOTE_REQUEST';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTE';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'lead_note' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_response || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;
  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTE';
  END IF;

  INSERT INTO public.follow_up_logs (lead_id, user_id, contact_type, summary, contact_time, no_answer)
  VALUES (p_lead_id, v_actor_id, 'note', v_note, now(), false)
  RETURNING id INTO v_note_id;

  UPDATE public.leads SET last_contact_date = current_date, updated_at = now() WHERE id = p_lead_id;
  v_response := jsonb_build_object('lead_id', p_lead_id, 'note_id', v_note_id);
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_note', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.record_lead_note_atomic(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lead_note_atomic(uuid, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- The lead-reassignment path (R6)
-- ---------------------------------------------------------------------------
-- 20260723140000_atomic_lead_reassignment.sql is in
-- supabase/migration-history-baseline.sha256, so reassign_lead_atomic() and the
-- three tables it writes are part of the state this release starts from, not part
-- of the release. The floor carried lead_mutation_requests and
-- record_lead_note_atomic() from that migration already; it did not carry the
-- reassignment routine or its targets, so nothing measured what happens when two
-- sessions move the same lead.
--
-- transfer_history is not created by ANY file in supabase/migrations. It exists in
-- production — src/types/database.ts:3302-3331 has it, and
-- 20260701000002_final_for_all_cleanup.sql:193-226 creates six policies on it,
-- which could not have applied against a table that was not there — and it is not
-- in 20260806000000_baseline_undeclared_production_objects.sql either. It is an
-- undeclared production object that baseline missed. Column names, nullability and
-- the four foreign keys below come from the committed, production-generated
-- src/types/database.ts, the same source that file used and for the same reason:
-- this branch has no read access to production's catalog.
alter table public.leads
  add column if not exists transfer_candidate boolean default false,
  add column if not exists recovery_candidate boolean default false,
  -- date, not timestamptz: 20260602000000_crm_v2_columns.sql:28 adds it as DATE
  -- and 20260603000000_add_crm_fields.sql:40 re-adds it as TIMESTAMPTZ under
  -- IF NOT EXISTS, so the earlier type is the one production has.
  add column if not exists hold_since date;

-- 20260607000000_create_notifications.sql:4-17, with the type domain as
-- 20260610000003_add_follow_up_overdue.sql:7-21 last left it. reassign_lead_atomic
-- writes type = 'lead_assigned', which that domain accepts; the point of carrying
-- the CHECK is that the floor states the domain rather than assuming it.
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles (id),
  type         varchar(50) not null,
  title        text not null,
  body         text,
  related_id   uuid,
  related_type varchar(30),
  is_read      boolean default false,
  created_at   timestamptz default now(),
  constraint notifications_type_check check (type in (
    'lead_created', 'lead_assigned', 'lead_stage_change', 'lead_stage_changed',
    'quote_created', 'contract_created', 'contract_signed',
    'payment_due', 'payment_overdue', 'payment_received',
    'kpi_target_set', 'followup_reminder', 'follow_up_overdue',
    'team_member_added'
  )),
  constraint notifications_related_type_check
    check (related_type in ('lead', 'contract', 'payment', 'kpi'))
);

create table public.transfer_history (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid not null references public.leads (id),
  from_user_id   uuid references public.profiles (id),
  to_user_id     uuid not null references public.profiles (id),
  reason         text,
  notes          text,
  created_at     timestamptz default now(),
  transferred_by uuid not null references public.profiles (id)
);

alter table public.notifications    enable row level security;
alter table public.transfer_history enable row level security;

-- 20260701000002_final_for_all_cleanup.sql:196-226, in the floor's style. The
-- comment in that migration records two policies as already present and
-- undeclared — transfer_sales_select and transfer_sales_insert, which let a
-- salesperson read and write transfer_history rows for their own leads — so the
-- floor carries them too, spelled the way that comment describes them. They are
-- why an audit table only reassign_lead_atomic() should write is reachable from a
-- browser session at all.
create policy policy_transfer_history_select_admin on public.transfer_history for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss','operator')));
create policy policy_transfer_history_select_finance on public.transfer_history for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'finance'));
create policy policy_transfer_history_select_designer on public.transfer_history for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'designer'));
create policy policy_transfer_history_insert_admin on public.transfer_history for insert to authenticated
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss','operator')));
create policy policy_transfer_history_update_admin on public.transfer_history for update to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss')))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss')));
create policy policy_transfer_history_delete_admin on public.transfer_history for delete to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','boss')));
create policy transfer_sales_select on public.transfer_history for select to authenticated
  using (exists (select 1 from public.leads l where l.id = transfer_history.lead_id and l.assigned_to = auth.uid()));
create policy transfer_sales_insert on public.transfer_history for insert to authenticated
  with check (exists (select 1 from public.leads l where l.id = transfer_history.lead_id and l.assigned_to = auth.uid()));

-- notifications is read and marked-read by the owning session and inserted by the
-- definer routines and by supabaseAdmin; transfer_history is reachable per the
-- policies above. Both grants are the pre-remediation shape: table-level, every
-- column, with RLS deciding the rows.
grant select, insert, update on public.notifications to authenticated;
grant select, insert, update, delete on public.transfer_history to authenticated;

-- 20260723140000_atomic_lead_reassignment.sql:87-199, verbatim, including the
-- REVOKE/GRANT pair. Two things about it are the subject of this release:
--
--   * :140-142 is the only concurrency guard, and it compares against
--     leads.updated_at — a column this historical floor did not model a trigger
--     for, which several application
--     writers change assigned_to without naming, and which the two update
--     policies above leave in the client's hands: neither carries a WITH CHECK,
--     so each reuses its USING clause as the check.
--     policy_leads_update_sales therefore lets the owning salesperson write any
--     column of their own lead, updated_at included, but NOT hand the lead to
--     anyone else — the reused clause is tested against the new row.
--     policy_leads_update_admin tests the ACTOR instead, so an admin, boss or
--     operator can write any column of any lead, which is the privilege the
--     direct reassignment writers spend.
--     The authenticated production baseline already has trg_set_updated_at and is
--     server-owned. 20260817180000_leads_updated_at_is_server_owned.sql therefore
--     no-ops there and creates a fallback only on this legacy floor;
--     supabase/replay/23_lead_assignment_cas.sh measures both catalog shapes.
--
--   * :165-169 inserts an activities row with type = 'transfer', and
--     activities_type_check above — the domain 20260605000000:209-214 installed,
--     which is still the last word on that column — does not contain 'transfer'.
--     So on the floor, as in production, the branch that actually moves a lead
--     raises SQLSTATE 23514 and rolls back everything including its own audit
--     rows. 20260817190000_lead_reassignment_activity_type.sql adds the value.
--     The floor keeps the narrow domain because that is what production has.
--
--   * :177-181 inserts notifications.related_id = p_lead_id::text, and this
--     historical floor's column is uuid (public.notifications above).
--     PostgreSQL accepts text in a uuid column only on an explicit cast, so this
--     statement raises SQLSTATE 42804 — a second, independent reason the same
--     branch cannot commit, and the reason widening the activities domain alone
--     changed nothing. 20260817200000_lead_reassignment_notification_related_id.sql
--     removes the cast from the installed routine on this uuid shape. The
--     authenticated production baseline has related_id=text and its installed
--     routine already uses p_lead_id without the cast, so the migration is a
--     catalog/behavior-proven no-op there.
--
--     supabase/replay/22_lead_reassignment_writes.sh measures all three directions
--     of the two write defects; supabase/replay/23_lead_assignment_cas.sh measures
--     both directions of the compare-and-set, and needs both write repairs applied
--     before it can observe a committed reassignment at all.
CREATE OR REPLACE FUNCTION public.reassign_lead_atomic(
  p_lead_id uuid,
  p_new_assignee uuid,
  p_expected_updated_at timestamptz,
  p_idempotency_key uuid,
  p_reason text DEFAULT 'manual_reassign'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_target_active boolean;
  v_lead public.leads%ROWTYPE;
  v_response jsonb;
  v_reason text := left(btrim(coalesce(p_reason, 'manual_reassign')), 500);
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator') THEN
    RAISE EXCEPTION 'FORBIDDEN_REASSIGNMENT';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id
    AND operation = 'lead_reassignment'
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_response || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT role, is_active INTO v_target_role, v_target_active
  FROM public.profiles WHERE id = p_new_assignee;
  IF NOT FOUND OR coalesce(v_target_active, false) = false
     OR coalesce(v_target_role, '') NOT IN ('sales', 'operator', 'boss') THEN
    RAISE EXCEPTION 'INVALID_ASSIGNEE';
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;
  IF p_expected_updated_at IS NOT NULL AND v_lead.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'CONCURRENT_LEAD_UPDATE';
  END IF;

  IF v_lead.assigned_to IS NOT DISTINCT FROM p_new_assignee THEN
    v_response := jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'unchanged', true
    );
  ELSE
    UPDATE public.leads
    SET assigned_to = p_new_assignee,
        transfer_candidate = false,
        recovery_candidate = false,
        hold_since = NULL,
        updated_at = now()
    WHERE id = p_lead_id;

    INSERT INTO public.transfer_history (
      lead_id, from_user_id, to_user_id, reason, transferred_by
    ) VALUES (
      p_lead_id, v_lead.assigned_to, p_new_assignee, v_reason, v_actor_id
    );

    INSERT INTO public.activities (lead_id, user_id, type, content)
    VALUES (
      p_lead_id, v_actor_id, 'transfer',
      format('Lead reassigned from %s to %s', coalesce(v_lead.assigned_to::text, 'unassigned'), p_new_assignee::text)
    );

    INSERT INTO public.business_events (lead_id, user_id, event_type, description, event_data)
    VALUES (
      p_lead_id, v_actor_id, 'transfer', 'Lead reassigned',
      jsonb_build_object('from_user_id', v_lead.assigned_to, 'to_user_id', p_new_assignee, 'reason', v_reason)
    );

    INSERT INTO public.notifications (user_id, type, title, body, related_id, related_type)
    VALUES (
      p_new_assignee, 'lead_assigned', 'Lead assigned',
      coalesce(v_lead.customer_name, 'Lead') || ' was assigned to you.', p_lead_id::text, 'lead'
    );

    v_response := jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'updated_at', (SELECT updated_at FROM public.leads WHERE id = p_lead_id),
      'unchanged', false
    );
  END IF;

  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_reassignment', p_idempotency_key, p_lead_id, v_response);

  RETURN v_response;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text) TO authenticated;
