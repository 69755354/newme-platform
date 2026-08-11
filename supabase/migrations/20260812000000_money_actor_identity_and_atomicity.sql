-- ============================================================================
-- Money path: actor identity, atomicity, and the write guard
-- ============================================================================
-- Forward-only. Nothing in this file modifies, renames or re-runs an already
-- applied migration; it lands after 20260805202917 and after the 20260811100*
-- L0 set, and every statement is additive or a policy/function replacement.
--
-- What was actually wrong (reproduced from the committed source, not inferred):
--
-- 1. Caller-supplied actor identity.
--    20260612000001_rpc_functions.sql:31 —
--        SELECT role INTO v_approver_role FROM profiles WHERE id = p_approver_id;
--    The approver, the confirmer and the allocator are all PARAMETERS. Nothing
--    compares them to auth.uid(). 20260811100400_f09_money_authorization_phase1
--    .sql granted EXECUTE on all three to `authenticated`, so any logged-in
--    session could POST to /rest/v1/rpc/approve_contract with
--    p_approver_id = <the boss's uuid> and approve its own contract. The Next.js
--    routes do check the caller's role first, but PostgREST is reachable
--    directly with the same access token — the route is not on the path.
--    confirm_payment had NO authorization check of any kind: not the caller's,
--    not the parameter's. Marking money received was open to every session.
--
-- 2. Sales UPDATE policies with no column constraint.
--    20260630200000_rls_policy_remediation.sql:316 —
--        CREATE POLICY policy_contracts_update_sales ON contracts FOR UPDATE
--          TO authenticated USING (sales_id = auth.uid());
--    No WITH CHECK, so USING is reused as the check and every column is
--    writable: a sales user could set their own contract to status='approved'
--    and contract_amount to anything, with no approval record at all. The same
--    shape on payments (:484) let them set confirmed=true. A policy cannot
--    compare OLD to NEW, so the column boundary has to be a trigger; the
--    policies are narrowed here as well, so the trigger is a backstop rather
--    than the only control.
--
-- 3. Contract creation was three transactions plus a caller-visible count.
--    src/app/api/contracts/route.ts:75 counts contracts through the CALLER's
--    RLS client to build the sequence number, so a sales user counts only their
--    own rows and deterministically generates a contract_no that already
--    exists. Then :83 inserts the contract, :144 the installments and :169 the
--    approval row as three separate PostgREST calls. Two of those three cannot
--    succeed for a sales user at all: policy_installment_plans_insert_admin and
--    policy_contract_approvals_insert_admin restrict INSERT to admin/boss/
--    operator (20260701000000_non_core_tables_rls_fix.sql:177, :98). The
--    installment failure returned 200 with a `warning`, and the approval
--    failure was only logged — so the normal outcome of a sales user creating a
--    contract was a signed-value contract with no payment schedule and no
--    approval row, reported as success.
--
-- 4. The approval chain could not reach the CEO.
--    approve_contract INSERTs a new contract_approvals row and never updates
--    the pending one. src/app/api/contracts/[id]/approve/route.ts:71 reads the
--    EARLIEST pending row to decide the step, so after admin approval the
--    still-pending 'admin_review' row is what the route keeps finding: the boss
--    is told only admin/operator may approve this step (403) and the contract
--    sits at pending_ceo forever. Creation also set status='draft' while
--    approve_contract requires 'pending_admin', so nothing was approvable
--    without a manual status edit.
--
-- 5. allocate_payment did not bind plans to the payment's contract, and left
--    de-allocated plans stale. :151 inserts any p_allocations[].plan_id, so a
--    payment on contract A could be allocated to an installment of contract B;
--    :159 then recomputes only the plans still referenced AFTER the delete, so
--    a plan dropped in a reallocation kept its old allocated_amount and 'paid'
--    status forever.
--
-- 6. confirm_payment's cascade never ran. :253 and :261 are guarded by
--    `IF v_contract IS NOT NULL`, and for a composite value that is true only
--    when EVERY field is non-null. contracts has a dozen nullable columns, so
--    the test is effectively always false: projects.paid_amount and
--    kpi_targets.actual_amount were never updated by a confirmation. The
--    correct test is whether the SELECT found a row.
--
-- 7. The RPCs reported failure as jsonb with HTTP 200. Every error path is
--    `RETURN jsonb_build_object('error', ...)`, the routes hand that straight
--    back, and the client checks res.ok — so "Contract not in approvable state"
--    and "Total allocation exceeds payment amount" both rendered as success.
--    The rewrites RAISE with SQLSTATEs PostgREST maps to 4xx.
--
-- Executable proof: supabase/replay/10_assert_release_contracts.sql runs each
-- boundary as the `authenticated` role with a JWT subject set — a forged
-- approver, an unauthorized confirmer, a cross-contract allocation, a direct
-- status write, a direct confirmed=true write — and the positive path for each.
-- MODE=control replays the same file without these migrations and requires the
-- negative assertions to fail, so none of them can pass vacuously.
--
-- NO_ROLLBACK: there is no way to revert this file that does not reopen one of
-- the holes above, so it ships without a companion rather than with a companion
-- that undoes the fix.
--
--   * Restoring the previous function bodies restores caller-supplied approver,
--     confirmer and allocator identity — the P0 itself.
--   * Dropping the guard triggers restores direct writes to contracts.status and
--     payments.confirmed.
--   * Dropping next_contract_no() would break on_lead_won(), which now calls it,
--     so a partial revert is not available either.
--
-- What an app-only rollback costs, precisely: the previous release created
-- contracts and converted quotations with direct PostgREST inserts, and the
-- contracts guard refuses those, so those two flows return 42501 until the
-- application is rolled forward again. Everything else in the previous release
-- keeps working — approve/confirm/allocate take the same arguments as before and
-- the routes already pass the caller's own id, which is what money_actor()
-- expects; recording an unconfirmed payment is still a direct insert; the file
-- upload confirmation is unaffected. Note that the two flows that break were
-- already broken for the sales role before this file (see 3 above), so the
-- rollback exposure is the admin/operator path only.
--
-- Recovery from a bad deploy is therefore forward, not backward: fix and
-- redeploy. That is a deliberate trade and it is stated here so nobody discovers
-- it during an incident.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · Actor resolution
-- ---------------------------------------------------------------------------
-- The one place that decides who is acting. Three contexts, all of them
-- explicit, and no fourth: an end-user request (JWT with a subject), a trusted
-- server request (service_role JWT, no subject), and a maintenance session with
-- no request context at all (psql, pg_cron).
--
-- current_user is deliberately NOT consulted: inside a SECURITY DEFINER
-- function it is the function owner, so it says nothing about the caller. The
-- role claim comes from a signed JWT the caller cannot alter.
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
    -- End-user request. The subject of the token is the actor, always. A
    -- parameter is accepted only when it agrees with the token.
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
  -- An inactive account cannot move money even with a valid, unexpired token.
  -- This is the database half of the revocation boundary; the proxy half alone
  -- was bypassable by talking to PostgREST directly.
  if not v_active then
    raise exception 'actor account is not active' using errcode = '42501';
  end if;
  if p_allowed_roles is not null
     and array_length(p_allowed_roles, 1) is not null
     and not (v_role = any (p_allowed_roles)) then
    raise exception 'role % may not perform this operation', coalesce(v_role, 'unknown')
      using errcode = '42501';
  end if;

  return v_actor;
end
$$;

revoke all on function public.money_actor(uuid, text[]) from public, anon;
grant execute on function public.money_actor(uuid, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 · Contract numbers without a count
-- ---------------------------------------------------------------------------
-- One row per contract date, incremented in the same statement that reads it,
-- so two concurrent creations cannot be handed the same sequence and no caller
-- ever counts rows it is allowed to see. Seeded from the highest number already
-- issued for that date, so it cannot re-issue an existing contract_no on a
-- database where contracts predate this table.
create table if not exists public.contract_no_counters (
  contract_date date        primary key,
  last_seq      integer     not null default 0,
  updated_at    timestamptz not null default now()
);

alter table public.contract_no_counters enable row level security;
-- No policies: the table is definer-only. The revoke matters because Supabase's
-- default privileges grant new tables to anon/authenticated.
revoke all on public.contract_no_counters from public, anon, authenticated;
grant select, insert, update on public.contract_no_counters to service_role;

create or replace function public.next_contract_no(p_date date)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_seed integer;
  v_seq  integer;
begin
  select coalesce(max(substring(c.contract_no from '^NEW-[0-9]{8}-0*([0-9]+)$')::integer), 0)
    into v_seed
    from public.contracts c
   where c.contract_date = p_date;

  insert into public.contract_no_counters as t (contract_date, last_seq)
  values (p_date, v_seed + 1)
  on conflict (contract_date) do update
     set last_seq   = greatest(t.last_seq, v_seed) + 1,
         updated_at = now()
  returning t.last_seq into v_seq;

  return 'NEW-' || to_char(p_date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end
$$;

revoke all on function public.next_contract_no(date) from public, anon, authenticated;
grant execute on function public.next_contract_no(date) to service_role;

-- ---------------------------------------------------------------------------
-- 3 · The write guard
-- ---------------------------------------------------------------------------
-- What a policy cannot do. RLS decides which ROWS a statement may touch; it
-- cannot say "this column may not change", because a WITH CHECK expression sees
-- only NEW. These triggers are the column boundary.
--
-- The discriminator is current_user, which in a trigger is the role actually
-- running the statement: `authenticated` for a PostgREST call with a user
-- token, `service_role` for the server key, and the function owner for anything
-- reached through a SECURITY DEFINER routine. So the same write that is refused
-- when it arrives from a browser is allowed when it arrives from
-- approve_contract() — and the trigger functions are SECURITY INVOKER for
-- exactly that reason. Making one of them DEFINER would make current_user the
-- owner and the guard would pass for everyone.
create or replace function public.money_write_is_direct()
returns boolean
language sql
stable
as $$ select current_user in ('authenticated', 'anon') $$;

comment on function public.money_write_is_direct() is
  'True when the current statement is running as a PostgREST end-user role rather than through a definer routine or the server key.';

create or replace function public.guard_contracts_write()
returns trigger
language plpgsql
as $$
begin
  if not public.money_write_is_direct() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Contracts are created by create_contract() and
    -- convert_quotation_to_contract() only. A direct insert is how the
    -- caller-visible count produced duplicate contract_no values and how a
    -- contract could be born without a schedule or an approval row.
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
  if not public.money_write_is_direct() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Recording an unconfirmed payment stays a direct write
    -- (src/app/api/payments/route.ts:70). Recording a CONFIRMED one does not.
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

  -- A confirmed payment is a record of money received. Notes stay editable
  -- because that is a genuine need (a corrected cheque reference, a reconciliation
  -- comment); everything else is frozen, including payment_date, which decides
  -- which KPI period the amount was credited to.
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

create or replace function public.guard_installment_plans_write()
returns trigger
language plpgsql
as $$
begin
  if not public.money_write_is_direct() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    raise exception 'installment plans are created with their contract; direct insert is not permitted'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'installment plans are not deleted directly' using errcode = '42501';
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
  if not public.money_write_is_direct() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  raise exception '% is written only through the money routines', tg_table_name
    using errcode = '42501';
end
$$;

drop trigger if exists trg_guard_contracts_write          on public.contracts;
drop trigger if exists trg_guard_payments_write           on public.payments;
drop trigger if exists trg_guard_installment_plans_write  on public.installment_plans;
drop trigger if exists trg_guard_contract_approvals_write on public.contract_approvals;
drop trigger if exists trg_guard_payment_allocations_write on public.payment_allocations;

create trigger trg_guard_contracts_write
  before insert or update on public.contracts
  for each row execute function public.guard_contracts_write();

create trigger trg_guard_payments_write
  before insert or update on public.payments
  for each row execute function public.guard_payments_write();

create trigger trg_guard_installment_plans_write
  before insert or update or delete on public.installment_plans
  for each row execute function public.guard_installment_plans_write();

create trigger trg_guard_contract_approvals_write
  before insert or update or delete on public.contract_approvals
  for each row execute function public.guard_definer_only_write();

create trigger trg_guard_payment_allocations_write
  before insert or update or delete on public.payment_allocations
  for each row execute function public.guard_definer_only_write();

-- ---------------------------------------------------------------------------
-- 4 · Give the sales UPDATE policies a WITH CHECK
-- ---------------------------------------------------------------------------
-- The defect is narrow and specific: with no WITH CHECK, Postgres reuses the
-- USING expression as the check, so `sales_id = auth.uid()` was evaluated
-- against the NEW row as well. That is what let a sales user rewrite any column
-- — status, contract_amount, confirmed — as long as the row stayed theirs, and
-- what let them keep a row they had just reassigned. Stating WITH CHECK
-- explicitly closes the reassignment half.
--
-- The column half is NOT closed here, because a policy cannot see OLD: there is
-- no expression that says "status may not change". That is the guard triggers'
-- job, and the division is deliberate — RLS decides which rows a statement may
-- touch, the trigger decides which columns may change.
--
-- An earlier revision of this migration also narrowed the row set by status
-- (draft/pending_admin/pending_ceo/rejected only). That was withdrawn: the file
-- upload confirmation at src/app/api/contracts/[id]/confirm-upload/route.ts:98
-- writes file_url through the CALLER's client and is permitted for the sales
-- owner on a contract in ANY status, and a PostgREST update whose rows are all
-- filtered out by RLS returns no error — so uploading the signed PDF for an
-- approved contract would have silently done nothing while the route reported
-- success. A status predicate there buys nothing the trigger does not already
-- enforce and costs a working flow.
drop policy if exists policy_contracts_update_sales on public.contracts;
create policy policy_contracts_update_sales
  on public.contracts for update to authenticated
  using (sales_id = auth.uid())
  with check (sales_id = auth.uid());

drop policy if exists policy_payments_update_sales on public.payments;
create policy policy_payments_update_sales
  on public.payments for update to authenticated
  using (
    exists (
      select 1 from public.contracts c
       where c.id = payments.contract_id and c.sales_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.contracts c
       where c.id = payments.contract_id and c.sales_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 5 · approve_contract — actor from the token, one row per step
-- ---------------------------------------------------------------------------
create or replace function public.approve_contract(
  p_contract_id uuid,
  p_approver_id uuid,
  p_action      text,
  p_notes       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_contract   record;
  v_actor      uuid;
  v_step       text;
  v_new_status text;
  v_approval   record;
begin
  if p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'action must be approve or reject' using errcode = '22023';
  end if;

  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found then
    raise exception 'contract not found' using errcode = 'P0002';
  end if;

  -- The step comes from the contract's own status, not from the earliest
  -- pending approval row and not from the caller's role. Then the role is
  -- checked against the step.
  if v_contract.status = 'pending_admin' then
    v_step := 'admin_review';
    v_actor := public.money_actor(p_approver_id, array['admin', 'operator']);
  elsif v_contract.status = 'pending_ceo' then
    v_step := 'ceo_review';
    v_actor := public.money_actor(p_approver_id, array['boss']);
  else
    raise exception 'contract is not awaiting approval (status %)', v_contract.status
      using errcode = '22023';
  end if;

  -- Settle the pending row for THIS step rather than appending a new one. The
  -- append-only version left 'admin_review' pending forever, which is what made
  -- the ceo_review step unreachable.
  select * into v_approval
    from public.contract_approvals
   where contract_id = p_contract_id and step = v_step and status = 'pending'
   order by created_at asc, id asc
   for update
   limit 1;

  if found then
    update public.contract_approvals
       set status      = case when p_action = 'approve' then 'approved' else 'rejected' end,
           approver_id = v_actor,
           reviewed_at = now(),
           notes       = coalesce(notes, '{}'::jsonb)
                         || jsonb_build_object('decision_notes', p_notes)
     where id = v_approval.id;
  else
    -- No pending row: a contract that reached this status before this migration
    -- existed. Record the decision so the trail is complete instead of failing.
    insert into public.contract_approvals (contract_id, step, approver_id, status, notes, reviewed_at)
    values (p_contract_id, v_step, v_actor,
            case when p_action = 'approve' then 'approved' else 'rejected' end,
            jsonb_build_object('decision_notes', p_notes, 'backfilled', true), now());
  end if;

  if p_action = 'approve' then
    if v_step = 'admin_review' then
      v_new_status := 'pending_ceo';
      -- Open the next step explicitly, so the boss has a row to settle.
      if not exists (
        select 1 from public.contract_approvals
         where contract_id = p_contract_id and step = 'ceo_review' and status = 'pending'
      ) then
        insert into public.contract_approvals (contract_id, step, status, notes)
        values (p_contract_id, 'ceo_review', 'pending',
                jsonb_build_object('source', 'admin_review_approved'));
      end if;
    else
      v_new_status := 'approved';
    end if;
  else
    v_new_status := 'rejected';
  end if;

  update public.contracts
     set status = v_new_status, updated_at = now()
   where id = p_contract_id;

  return jsonb_build_object(
    'success',    true,
    'action',     case when p_action = 'approve' then 'approved' else 'rejected' end,
    'new_status', v_new_status,
    'step',       v_step,
    'actor_id',   v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 6 · confirm_payment — authorized, deterministic, and its cascade runs
-- ---------------------------------------------------------------------------
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
  -- The check the original had none of.
  v_actor := public.money_actor(p_confirmer_id, array['admin', 'boss', 'finance', 'operator']);

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if coalesce(v_payment.confirmed, false) then
    raise exception 'payment is already confirmed' using errcode = '22023';
  end if;

  select * into v_contract from public.contracts where id = v_payment.contract_id for update;
  v_contract_found := found;

  update public.payments
     set confirmed    = true,
         confirmed_by = v_actor,
         confirmed_at = now(),
         updated_at   = now()
   where id = p_payment_id;

  -- seq is UNIQUE per contract (20260605000000_newme_crm_v22_complete.sql:126),
  -- so `seq = 1` identifies one row — but the original had no ORDER BY with its
  -- LIMIT 1, which is a non-deterministic read wherever that assumption breaks.
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
     where pa.plan_id = v_first_plan_id and p.confirmed = true;

    v_fp_status := case
      when v_first_plan_allocated >= v_first_plan_amount then 'paid'
      when v_first_plan_allocated > 0                    then 'partial'
      else 'unpaid'
    end;

    update public.contracts
       set first_payment_status = v_fp_status, updated_at = now()
     where id = v_payment.contract_id;
  end if;

  -- `IF v_contract IS NOT NULL` was false whenever ANY contracts column was
  -- null, which is always: a composite IS NOT NULL requires every field to be
  -- non-null. Neither of the two updates below had ever run.
  if v_contract_found then
    select coalesce(sum(p.amount), 0)
      into v_total_paid
      from public.payments p
     where p.contract_id = v_payment.contract_id and p.confirmed = true;

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
-- 7 · allocate_payment — plans bound to the payment's contract, no stale rows
-- ---------------------------------------------------------------------------
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
  v_actor := public.money_actor(p_allocated_by, array['admin', 'boss', 'finance', 'operator']);

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
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

  for i in 0 .. jsonb_array_length(p_allocations) - 1 loop
    v_total_allocated := v_total_allocated + (p_allocations -> i ->> 'amount')::numeric(12, 2);
  end loop;

  if v_total_allocated > v_payment.amount then
    raise exception 'total allocation %.2f exceeds the payment amount %.2f',
      v_total_allocated, v_payment.amount using errcode = '22023';
  end if;

  -- Every plan touched, before AND after. Recomputing only the post-delete set
  -- is what left a de-allocated plan sitting at its old allocated_amount and
  -- 'paid' status.
  select coalesce(array_agg(distinct plan_id), '{}')
    into v_affected
    from public.payment_allocations
   where payment_id = p_payment_id;

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

    -- The binding the original never made: an installment of ANOTHER contract
    -- could be marked paid by a payment on this one.
    if not exists (
      select 1 from public.installment_plans ip
       where ip.id = v_plan_id and ip.contract_id = v_payment.contract_id
    ) then
      raise exception 'installment plan does not belong to the payment''s contract'
        using errcode = '42501';
    end if;

    insert into public.payment_allocations (payment_id, plan_id, amount_allocated, allocated_by)
    values (p_payment_id, v_plan_id, v_amount, v_actor);

    if not (v_plan_id = any (v_affected)) then
      v_affected := v_affected || v_plan_id;
    end if;
    v_count := v_count + 1;
  end loop;

  foreach v_plan_id in array v_affected loop
    select coalesce(sum(amount_allocated), 0) into v_plan_allocated
      from public.payment_allocations where plan_id = v_plan_id;
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
-- 8 · create_contract — one transaction, no count, no partial contract
-- ---------------------------------------------------------------------------
-- Replaces the three-call sequence in src/app/api/contracts/route.ts. The
-- installment rows and the first approval row are created by the same
-- transaction as the contract, which is also what lets a sales user create one
-- at all: policy_installment_plans_insert_admin and
-- policy_contract_approvals_insert_admin never permitted their inserts, and
-- widening those policies to sales would have been the wrong fix.
create or replace function public.create_contract(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor       uuid;
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

  v_lead_id := nullif(p_payload ->> 'lead_id', '')::uuid;
  if v_lead_id is null then
    raise exception 'lead_id is required' using errcode = '22023';
  end if;
  v_amount := nullif(p_payload ->> 'amount', '')::numeric(12, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'a positive amount is required' using errcode = '22023';
  end if;

  -- Same-lead duplicate check, run with the definer's full visibility. The
  -- route ran it through the caller's client, so a sales user could not see a
  -- colleague's contract on the same lead and got a 500 from the unique index
  -- instead of the intended 409. The predicate mirrors
  -- idx_contracts_one_active_per_lead exactly
  -- (20260627000000_contracts_unique_active_per_lead.sql:10) so the pre-check
  -- and the index can never disagree.
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
        -- contract_no is the only number this can collide on; the one-active-
        -- contract-per-lead index is checked above and re-raised as-is.
        if v_attempt >= 10 then
          raise;
        end if;
    end;
  end loop;

  if jsonb_typeof(p_payload -> 'installments') = 'array' then
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
-- 9 · convert_quotation_to_contract — the whole conversion, or none of it
-- ---------------------------------------------------------------------------
-- src/app/api/quotations/[id]/convert/route.ts did this in seven transactions
-- with hand-written compensation: a claim update, a service_role count, the
-- contract insert, the installments, the approval row, the quotation link, then
-- the lead and project bookkeeping. The compensating deletes are themselves
-- separate transactions and can fail, which is how orphan contracts appear.
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
  v_actor       uuid;
  v_actor_role  text;
  v_quote       record;
  v_lead        record;
  v_contract_id uuid;
  v_contract_no text;
  v_date        date := current_date;
  v_attempt     integer := 0;
  v_inst        jsonb;
  v_inst_count  integer := 0;
begin
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss', 'operator', 'finance', 'sales']);
  select role into v_actor_role from public.profiles where id = v_actor;

  -- FOR UPDATE is the interlock the route emulated with a conditional update:
  -- two concurrent conversions cannot both pass the status test.
  select * into v_quote from public.quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;
  if v_quote.contract_id is not null then
    raise exception 'quotation is already converted' using errcode = '23505';
  end if;
  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quotation can be converted (status %)', v_quote.status
      using errcode = '22023';
  end if;
  if not (coalesce(v_quote.total_amount, 0) > 0) then
    raise exception 'quotation total must be greater than zero' using errcode = '22023';
  end if;
  if v_actor_role not in ('admin', 'boss', 'operator') and v_quote.created_by is distinct from v_actor then
    raise exception 'only the quotation owner or a manager may convert it' using errcode = '42501';
  end if;

  select * into v_lead from public.leads where id = v_quote.lead_id;

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

  if jsonb_typeof(p_payload -> 'installments') = 'array' then
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

  return jsonb_build_object(
    'success',            true,
    'contract_id',        v_contract_id,
    'contract_no',        v_contract_no,
    'quotation_status',   'contract_created',
    'installments_count', v_inst_count,
    'actor_id',           v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 10 · set_contract_status / revoke_contract — the only status writes
-- ---------------------------------------------------------------------------
-- src/app/(dashboard)/contracts/[id]/page.tsx:273 PATCHes /api/contracts/[id]
-- with an arbitrary status out of a nine-button grid, and that route exports
-- only GET — every status change from the contract page has been a 405. Adding
-- a handler that writes whatever it is sent would have been worse than the 405:
-- 'approved' and 'pending_ceo' are in that grid, so it would have been a
-- one-click approval-chain bypass. Only these transitions are permitted, and
-- the approval statuses are not among them — they belong to approve_contract().
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
  v_is_owner := v_contract.sales_id = v_actor;

  if p_status = 'pending_admin' and v_contract.status in ('draft', 'rejected') then
    if not (v_is_owner or v_role in ('admin', 'boss', 'operator')) then
      raise exception 'only the contract owner or a manager may submit for approval'
        using errcode = '42501';
    end if;
  elsif p_status = 'draft' and v_contract.status = 'rejected' then
    if not (v_is_owner or v_role in ('admin', 'boss', 'operator')) then
      raise exception 'only the contract owner or a manager may reopen a rejected contract'
        using errcode = '42501';
    end if;
  elsif p_status = 'active' and v_contract.status = 'approved' then
    if v_role not in ('admin', 'boss', 'operator', 'finance') then
      raise exception 'only a manager may activate a contract' using errcode = '42501';
    end if;
  elsif p_status = 'completed' and v_contract.status = 'active' then
    if v_role not in ('admin', 'boss', 'operator', 'finance') then
      raise exception 'only a manager may complete a contract' using errcode = '42501';
    end if;
  elsif p_status = 'terminated' and v_contract.status in ('active', 'approved', 'suspended', 'revoking') then
    if v_role not in ('admin', 'boss') then
      raise exception 'only admin or boss may terminate a contract' using errcode = '42501';
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'a reason is required to terminate a contract' using errcode = '22023';
    end if;
  elsif p_status = 'suspended' and v_contract.status = 'active' then
    if v_role not in ('admin', 'boss') then
      raise exception 'only admin or boss may suspend a contract' using errcode = '42501';
    end if;
  else
    raise exception '% is not a permitted transition from %', p_status, v_contract.status
      using errcode = '22023';
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
  if v_contract.status in ('superseded', 'revoking') then
    raise exception 'contract is already %', v_contract.status using errcode = '22023';
  end if;

  v_new_status := case when coalesce(p_supersede, false) then 'superseded' else 'revoking' end;

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
-- 11 · Privileges
-- ---------------------------------------------------------------------------
-- Reachable by a logged-in session (the routes call them with the caller's
-- token so that money_actor() sees the real subject) and by the server key.
-- Never by anon, and never through PUBLIC — a function created with CREATE
-- FUNCTION grants EXECUTE to PUBLIC by default, which is how anon held it.
revoke all on function public.approve_contract(uuid, uuid, text, text)          from public, anon;
revoke all on function public.confirm_payment(uuid, uuid)                       from public, anon;
revoke all on function public.allocate_payment(uuid, jsonb, uuid)               from public, anon;
revoke all on function public.create_contract(jsonb)                            from public, anon;
revoke all on function public.convert_quotation_to_contract(uuid, jsonb)        from public, anon;
revoke all on function public.set_contract_status(uuid, text, text)             from public, anon;
revoke all on function public.revoke_contract(uuid, text, boolean)              from public, anon;

grant execute on function public.approve_contract(uuid, uuid, text, text)       to authenticated, service_role;
grant execute on function public.confirm_payment(uuid, uuid)                    to authenticated, service_role;
grant execute on function public.allocate_payment(uuid, jsonb, uuid)            to authenticated, service_role;
grant execute on function public.create_contract(jsonb)                         to authenticated, service_role;
grant execute on function public.convert_quotation_to_contract(uuid, jsonb)     to authenticated, service_role;
grant execute on function public.set_contract_status(uuid, text, text)          to authenticated, service_role;
grant execute on function public.revoke_contract(uuid, text, boolean)           to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12 · on_lead_won() — the fourth way a contract was created
-- ---------------------------------------------------------------------------
-- trg_lead_won fires AFTER UPDATE OF final_status WHEN NEW.final_status = 'won'
-- (20260624000003_fix_trg_lead_won.sql:146) and creates a contract, three
-- installments, a project and an activity. Two defects, both live:
--
--   a) It inserted the contract with status='active'. Marking a lead won
--      therefore produced a fully active contract that had never been through
--      admin_review or ceo_review — the approval chain enforced everywhere else
--      in this file was bypassed by a lead field update. It now creates a
--      'draft' contract with a pending admin_review row, exactly like
--      create_contract(). THIS IS A DELIBERATE BEHAVIOUR CHANGE and needs UAT
--      sign-off: contracts born from the won-lead automation now require the
--      two approvals rather than arriving active.
--
--   b) contract_no came from
--        lpad(COALESCE((SELECT count(*)::text FROM contracts
--                        WHERE contract_date = CURRENT_DATE), '0'), 3, '0')
--      With N contracts already dated today, count(*) = N produces
--      'NEW-<today>-00N', which is the number the Nth contract already holds
--      (the sequence is 1-based). contract_no is UNIQUE, so the insert raised,
--      the trigger raised, and the whole `final_status='won'` UPDATE failed —
--      the automation broke for every lead after the first contract of the day,
--      and in the conversion route that failure was swallowed by noteFailure().
--      It now draws from next_contract_no(), the same counter as every other
--      creation path, so the three paths cannot collide with each other.
--
-- Everything else — the guard clauses, the customer upsert, the 50/30/20 split,
-- the project, the business event and the activity — is carried over unchanged.
--
-- SECURITY DEFINER and the search_path pin are restated explicitly: they are
-- part of the function definition, so a CREATE OR REPLACE that omitted them
-- would silently drop the properties set by 20260624095205 and 20260805202917
-- and the function would start running as the caller with an unpinned path.
create or replace function public.on_lead_won()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_customer_id       uuid;
  v_contract_id       uuid;
  v_project_id        uuid;
  v_contract_no       text;
  v_contract_amount   numeric;
  v_customer_name     text;
  v_location          text;
  v_property_type     text;
  v_property_size     integer;
  v_installment_count integer := 3;
  v_seq               integer;
  v_pct               numeric[];
  v_amount            numeric;
  v_due_days          integer[];
begin
  if new.final_status <> 'won' or old.final_status = 'won' then
    return new;
  end if;

  -- Idempotency: a lead that already has a contract (for instance one just
  -- created by convert_quotation_to_contract) gets nothing further.
  if exists (select 1 from public.contracts where lead_id = new.id) then
    return new;
  end if;

  if coalesce(new.quotation_value, 0) <= 0 then
    insert into public.activities (lead_id, user_id, type, content)
    values (new.id, new.assigned_to, 'note',
      'Lead Won auto-creation skipped: contract_amount is 0 (quotation_value was NULL or zero).');
    return new;
  end if;

  v_contract_amount := coalesce(new.quotation_value, 0);
  v_customer_name   := coalesce(new.customer_name, new.phone, 'Unknown Client');
  v_location        := new.location;
  v_property_type   := new.property_type;
  v_property_size   := new.property_size_sqm;

  if new.customer_id is not null then
    v_customer_id := new.customer_id;
    update public.customers set
      total_contract_amount = coalesce(total_contract_amount, 0) + v_contract_amount,
      last_activity_at      = now(),
      name  = case when customers.name = 'Unknown' or customers.name is null
                   then v_customer_name else customers.name end,
      phone = coalesce(customers.phone, new.phone),
      updated_at = now()
    where id = v_customer_id;
  else
    insert into public.customers (lead_id, name, phone, email, address, total_contract_amount, last_activity_at)
    values (new.id, v_customer_name, new.phone, new.email, v_location, v_contract_amount, now())
    on conflict do nothing
    returning id into v_customer_id;

    if v_customer_id is not null then
      update public.leads set customer_id = v_customer_id where id = new.id;
    end if;
  end if;

  v_contract_no := public.next_contract_no(current_date);

  insert into public.contracts (
    lead_id, customer_id, sales_id, created_by,
    contract_no, contract_date, contract_amount, currency,
    party_a_name, party_a_contact,
    party_b_name, status, approval_status
  ) values (
    new.id, v_customer_id, new.assigned_to, new.assigned_to,
    v_contract_no, current_date, v_contract_amount, 'AED',
    v_customer_name, new.phone,
    'NewMe Smart Home FZCO', 'draft', 'none'
  )
  returning id into v_contract_id;

  insert into public.contract_approvals (contract_id, step, status, notes)
  values (v_contract_id, 'admin_review', 'pending',
          jsonb_build_object('source', 'lead_won_automation', 'lead_id', new.id));

  v_pct      := array[0.50, 0.30, 0.20];
  v_due_days := array[0, 30, 60];

  for v_seq in 1 .. v_installment_count loop
    v_amount := round(v_contract_amount * v_pct[v_seq], 2);
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id, v_seq, v_amount,
      current_date + v_due_days[v_seq],
      case v_seq
        when 1 then '首期款 (签约)'
        when 2 then '二期款 (设备到货)'
        when 3 then '尾款 (验收)'
      end,
      'pending'
    );
  end loop;

  insert into public.projects (
    customer_id, lead_id, contract_id, sales_id,
    name, property_type, property_size, location,
    phase, status, contract_amount
  ) values (
    v_customer_id, new.id, v_contract_id, new.assigned_to,
    v_customer_name || ' - ' || coalesce(v_property_type, 'Project'),
    v_property_type, v_property_size, v_location,
    'design', 'active', v_contract_amount
  )
  returning id into v_project_id;

  insert into public.business_events (lead_id, user_id, event_type, description, event_data)
  values (
    new.id, new.assigned_to, 'won',
    'Automation: Lead Won → Contract#' || v_contract_no || ' + 3 installments + project',
    jsonb_build_object(
      'contract_id',       v_contract_id,
      'contract_no',       v_contract_no,
      'project_id',        v_project_id,
      'installment_count', v_installment_count,
      'customer_id',       v_customer_id
    )
  );

  insert into public.activities (lead_id, user_id, type, content)
  values (new.id, new.assigned_to, 'note',
    'System auto-created: Contract#' || v_contract_no || ', 3 installment plans, project (pending admin review)');

  return new;
end
$$;

-- The trigger definition itself is unchanged, so the existing trg_lead_won
-- keeps pointing at the replaced body.

commit;
