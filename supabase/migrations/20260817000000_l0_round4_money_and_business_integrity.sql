-- ============================================================================
-- L0 round 4 · money and business integrity (B2, B3, B4, B5, B6, B7, B10)
-- ============================================================================
-- NO_ROLLBACK: every change here either forbids a write that corrupts the ledger
-- or adds a fact the ledger needs to be reversible. Reverting it restores, in
-- order: a forgeable and stale first_payment_status (B2); a ledger that accepts
-- negative and duplicate payments (B3); contracts whose installment schedule does
-- not add up to the contract (B4, B10); a conversion retry that will attach a
-- quotation to another lead's contract (B5); a won lead with no customer and no
-- business event (B6); and KPI actuals that a target edit deletes and a void
-- takes off the wrong salesperson (B7). There is no way back from this file that
-- does not reopen one of those, so it ships without a companion rather than with
-- one that undoes the fix — the position 20260812000000, 20260813000000,
-- 20260814000000 and 20260816000000 already take.
--
-- The additive parts are inert on rollback rather than harmful: payments.credited_to
-- and payments.request_key are columns the previous release never reads or writes,
-- and the request_key requirement is gated on money_direct_write_mode() = 'strict',
-- so the compatibility window the rollback boundary depends on is unaffected. See
-- §0 of 20260814000000 for why that gate exists.
--
-- Forward-only: this file modifies no applied migration. It redefines functions
-- introduced by 20260811100500, 20260812000000 and 20260814000000, none of which
-- is in production history, and adds two nullable columns and four constraints.
--
-- Every item was reproduced against a local Postgres 17.10 replay of the floor
-- plus this branch before it was written, and each reproduction and its closing
-- assertion are in supabase/replay/10_assert_release_contracts.sql.
--
-- Fail-closed, not repair-in-place: the three CHECK constraints below count the
-- rows that would violate them and abort the migration with the count if any
-- exist, rather than deleting or rewriting money rows. supabase/preflight/ carries
-- the same scan so the count is known before a deploy window rather than during
-- one.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · B3 — a payment amount must be positive, and a request must be idempotent
-- ---------------------------------------------------------------------------
-- Reproduced: a payment of -100 was inserted and confirmed, and confirmation
-- subtracted it from projects.paid_amount and kpi_targets.actual_amount, so a
-- salesperson could reduce their own recorded collections. Nothing in the
-- database refused it — there was no CHECK, and confirm_payment() never looked at
-- the sign. Two identical creation requests produced two rows.
do $do$
declare
  v_bad_payments    bigint;
  v_bad_allocations bigint;
  v_bad_plans       bigint;
begin
  select count(*) into v_bad_payments    from public.payments           where amount is null or amount <= 0;
  select count(*) into v_bad_allocations from public.payment_allocations where amount_allocated is null or amount_allocated <= 0;
  select count(*) into v_bad_plans       from public.installment_plans   where amount is null or amount <= 0;

  -- Counts, never rows: this migration is applied to a database holding real
  -- customer money and the log it writes is read by people who are not entitled
  -- to the rows.
  raise notice 'B3 preflight: non-positive payments=%, allocations=%, installment plans=%',
    v_bad_payments, v_bad_allocations, v_bad_plans;

  if v_bad_payments + v_bad_allocations + v_bad_plans > 0 then
    raise exception 'refusing to add the positive-amount constraints while % payment(s), % allocation(s) and % installment plan(s) violate them; resolve them as money corrections first (supabase/preflight/scan-money-invariants.sql lists them for an operator who is entitled to see them)',
      v_bad_payments, v_bad_allocations, v_bad_plans
      using errcode = '22000';
  end if;
end
$do$;

alter table public.payments
  drop constraint if exists payments_amount_positive;
alter table public.payments
  add constraint payments_amount_positive check (amount > 0);

alter table public.payment_allocations
  drop constraint if exists payment_allocations_amount_positive;
alter table public.payment_allocations
  add constraint payment_allocations_amount_positive check (amount_allocated > 0);

alter table public.installment_plans
  drop constraint if exists installment_plans_amount_positive;
alter table public.installment_plans
  add constraint installment_plans_amount_positive check (amount > 0);

-- The durable request boundary. Nullable, because the previous release's
-- application does not send it and the rollback window must keep working; the
-- guard trigger below requires it once the release is in strict mode, which is
-- the same switch every other write boundary in this release is gated on.
alter table public.payments
  add column if not exists request_key uuid;

comment on column public.payments.request_key is
  'Client-supplied idempotency key for the creating request. Unique per creator, so a retried or double-submitted payment collapses onto one row instead of two. Required on INSERT once money_direct_write_mode() is strict.';

-- Partial and scoped to the creator: two different people may legitimately hold
-- the same key, and the historic rows have none.
drop index if exists public.idx_payments_request_key;
create unique index idx_payments_request_key
  on public.payments (created_by, request_key)
  where request_key is not null;

-- ---------------------------------------------------------------------------
-- 2 · B7 — the payment remembers whose collection it was
-- ---------------------------------------------------------------------------
-- Reproduced: a confirmed payment credited kpi_targets for contracts.sales_id at
-- confirmation time. Reassigning the contract and then voiding the payment
-- subtracted the amount from the NEW salesperson, leaving 100 stranded on the old
-- one. The credit and the reversal have to name the same person, so the person is
-- recorded on the payment when the credit is made.
alter table public.payments
  add column if not exists credited_to uuid references public.profiles (id);

comment on column public.payments.credited_to is
  'The salesperson whose kpi_targets.actual_amount this payment was credited to at confirmation. void_payment() reverses the credit here, not against the contract''s current sales_id, so reassigning a contract cannot move an existing credit.';

-- Backfill from the only fact available for history: the contract's current
-- salesperson. For a contract never reassigned this is exact; for one that was,
-- it is the same value the previous code would have used at void time, so no
-- existing behaviour changes and every future credit is recorded correctly.
update public.payments p
   set credited_to = c.sales_id
  from public.contracts c
 where c.id = p.contract_id
   and p.credited_to is null
   and coalesce(p.confirmed, false)
   and p.voided_at is null;

-- ---------------------------------------------------------------------------
-- 3 · B2 — one derivation of first_payment_status, and nobody may write it
-- ---------------------------------------------------------------------------
-- Reproduced twice. A sales owner could set contracts.first_payment_status to
-- 'paid' with a direct UPDATE, because the guard's protected-column list did not
-- include it. And allocate_payment() could allocate the full first installment
-- while the contract still read 'unpaid', because confirm_payment() and
-- void_payment() recomputed the field and allocate_payment() did not — which is
-- precisely the operation that changes the answer.
--
-- SECURITY INVOKER, not definer: it is a derivation over rows the caller has
-- already been authorised to touch by whichever routine calls it, and making it
-- definer would add a fourth reader of money rows that RLS does not see for no
-- benefit. That also keeps it off the entry-boundary surface 20260816000000
-- governs, which is for routines that ACT.
create or replace function public.contract_first_payment_status(p_contract_id uuid)
returns text
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_plan_id   uuid;
  v_amount    numeric(12, 2);
  v_allocated numeric(12, 2);
begin
  -- The same "first installment" every previous version picked: lowest seq, and
  -- among duplicates the oldest, so the answer does not depend on scan order.
  select id, amount into v_plan_id, v_amount
    from public.installment_plans
   where contract_id = p_contract_id and seq = 1
   order by created_at asc, id asc
   limit 1;

  if v_plan_id is null then
    return 'unpaid';
  end if;

  -- Only confirmed, unvoided payments count, so a reversed payment cannot leave a
  -- contract reading 'paid'.
  select coalesce(sum(pa.amount_allocated), 0)
    into v_allocated
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
   where pa.plan_id = v_plan_id
     and p.confirmed = true
     and p.voided_at is null;

  return case
    when v_allocated >= v_amount then 'paid'
    when v_allocated > 0         then 'partial'
    else 'unpaid'
  end;
end
$$;

comment on function public.contract_first_payment_status(uuid) is
  'The single derivation of contracts.first_payment_status from confirmed, unvoided allocations against the first installment. confirm_payment(), allocate_payment() and void_payment() all write what this returns; nothing else may write the column.';

revoke all on function public.contract_first_payment_status(uuid) from public, anon;
grant execute on function public.contract_first_payment_status(uuid) to authenticated, service_role;

-- Reconcile the history the three routines never agreed on.
update public.contracts c
   set first_payment_status = public.contract_first_payment_status(c.id),
       updated_at           = now()
 where coalesce(c.first_payment_status, '') is distinct from public.contract_first_payment_status(c.id);

-- ---------------------------------------------------------------------------
-- 4 · B2 — the column joins the protected set
-- ---------------------------------------------------------------------------
-- money_write_is_direct() is `current_user in ('authenticated','anon')`, so this
-- refuses a session's direct UPDATE and stands aside for the SECURITY DEFINER
-- routines, which run as the owner. Carried over from 20260814000000 with
-- first_payment_status added to the list and nothing else changed.
create or replace function public.guard_contracts_write()
returns trigger
language plpgsql
as $$
begin
  if public.money_write_is_direct() and tg_op = 'DELETE' then
    raise exception 'contracts are not deleted; terminate the contract through set_contract_status() instead'
      using errcode = '42501';
  end if;

  if not public.money_direct_write_is_blocked() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
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

  -- B3/B2: the payment state of a contract is derived from the ledger, never
  -- asserted by the client. Reproduced: a sales owner set this to 'paid' on a
  -- contract with no confirmed payment at all.
  if new.first_payment_status is distinct from old.first_payment_status then
    raise exception 'first_payment_status is derived from confirmed allocations by confirm_payment(), allocate_payment() and void_payment()'
      using errcode = '42501';
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 5 · B3 — the request key is required once the release is strict
-- ---------------------------------------------------------------------------
-- Carried over from 20260814000000 with one INSERT check added inside the
-- existing strict-mode branch, so the compatibility window is untouched.
create or replace function public.guard_payments_write()
returns trigger
language plpgsql
as $$
begin
  if public.money_write_is_direct() and tg_op = 'DELETE' then
    raise exception 'payments are not deleted; reverse the payment through void_payment() instead'
      using errcode = '42501';
  end if;

  if public.money_write_is_direct() then
    if tg_op = 'INSERT' and (new.voided_at is not null or new.voided_by is not null
                             or new.void_reason is not null) then
      raise exception 'void fields are set by void_payment()' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.voided_at is distinct from old.voided_at
                             or new.voided_by is distinct from old.voided_by
                             or new.void_reason is distinct from old.void_reason) then
      raise exception 'a payment is voided through void_payment()' using errcode = '42501';
    end if;
    -- B7: the credited salesperson is written by confirm_payment(), so a session
    -- cannot pre-assign someone else's collection or move an existing credit.
    if tg_op = 'INSERT' and new.credited_to is not null then
      raise exception 'credited_to is set by confirm_payment()' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and new.credited_to is distinct from old.credited_to then
      raise exception 'credited_to is set by confirm_payment() and reversed by void_payment()'
        using errcode = '42501';
    end if;
  end if;

  if not public.money_direct_write_is_blocked() then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
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
    -- B3: the idempotency boundary. Reproduced: two identical creation requests
    -- produced two payment rows, and the second was indistinguishable from a
    -- genuine second payment, so no reconciliation could tell them apart.
    if new.request_key is null then
      raise exception 'a payment must carry request_key, the idempotency key of the creating request'
        using errcode = '22023';
    end if;
    return new;
  end if;

  if new.request_key is distinct from old.request_key then
    raise exception 'request_key identifies the creating request and cannot be changed'
      using errcode = '42501';
  end if;

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

-- ---------------------------------------------------------------------------
-- 6 · B5 — the conversion link is not a client-writable field
-- ---------------------------------------------------------------------------
-- The already-converted branch of convert_quotation_to_contract() trusts
-- quotations.contract_id. Validating it there (§10) closes the reproduction, but
-- the field itself was writable by the quotation's owner, so the validation would
-- be arguing with a value the attacker still controls. Both halves are needed.
--
-- Gated on money_direct_write_is_blocked() — direct AND strict — and not on
-- money_write_is_direct() alone, which is the same switch every other direct-write
-- boundary in this release stands behind. The reason is the compatibility window:
-- the previous release converts a quotation with a direct
-- `update quotations set contract_id = …` as `authenticated`
-- (`src/app/api/quotations/[id]/convert/route.ts:173` at PR base 81956f2), so a
-- role-only gate would refuse conversion on the deployed application the moment
-- the expand phase applied — before any application deploy, and again after any
-- application-only rollback. See supabase/preflight/expand-contract-rollback.md §3.
create or replace function public.guard_quotations_write()
returns trigger
language plpgsql
as $$
begin
  if not public.money_direct_write_is_blocked() then
    return new;
  end if;

  if new.contract_id is distinct from old.contract_id then
    raise exception 'quotations.contract_id is set by convert_quotation_to_contract()'
      using errcode = '42501';
  end if;

  return new;
end
$$;

comment on function public.guard_quotations_write() is
  'Refuses a direct write to quotations.contract_id from a session once money_direct_write_mode() is strict. The conversion link is written only by convert_quotation_to_contract(), which runs as the definer and is therefore not current_user authenticated. Gated on the release mode so the expand phase does not break the previous release''s conversion path during the compatibility window.';

-- Trigger functions are off the end-user surface (20260816000000 §2), and this
-- one is new, so it takes itself off.
revoke all on function public.guard_quotations_write() from public, anon, authenticated;

drop trigger if exists trg_guard_quotations_write on public.quotations;
create trigger trg_guard_quotations_write
  before update on public.quotations
  for each row execute function public.guard_quotations_write();

-- ---------------------------------------------------------------------------
-- 7 · B4 / B10 — one schedule validator, exact to the cent
-- ---------------------------------------------------------------------------
-- B4 reproduced: create_contract() made a contract of 100 with zero installments,
-- and another of 100 with installments totalling 40. It wrote whatever array it
-- was given, defaulting a missing amount to 0, and checked nothing.
--
-- B10 reproduced: convert_quotation_to_contract() accepted `abs(sum - total) >
-- 0.01`, which admits a difference of exactly 0.01 — a cent per conversion, on
-- every contract, silently. The tolerance was there because a three-way
-- percentage split of an odd total does not divide evenly, but the fix for that
-- is for the caller to put the remainder on one installment, not for the database
-- to accept a schedule that does not add up. Both columns are numeric(12,2), so
-- after round(...,2) the comparison is exact currency units and there is nothing
-- left for a tolerance to absorb.
--
-- SECURITY INVOKER: pure validation over its arguments, touching no table.
-- p_subject exists only so the message reads the way each caller's message already
-- read. The conversion said "but the quotation totals", and a release assertion
-- matches that text; changing it here would have quietly moved the goalposts of a
-- test rather than kept them.
create or replace function public.assert_installment_schedule(
  p_schedule jsonb,
  p_total    numeric,
  p_subject  text default 'contract'
)
returns integer
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_item  jsonb;
  v_count integer := 0;
  v_total numeric(12, 2) := 0;
  v_seqs  integer[] := '{}';
  v_seq   integer;
  v_due   text;
begin
  if coalesce(jsonb_typeof(p_schedule), 'null') <> 'array'
     or jsonb_array_length(p_schedule) = 0 then
    raise exception 'a % needs an installment schedule; none was supplied', p_subject
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_schedule) loop
    v_count := v_count + 1;

    if nullif(v_item ->> 'amount', '') is null
       or (v_item ->> 'amount')::numeric(12, 2) <= 0 then
      raise exception 'installment % needs a positive amount', v_count using errcode = '22023';
    end if;
    v_total := v_total + (v_item ->> 'amount')::numeric(12, 2);

    -- seq defaults to position, the same default create_contract() and the
    -- conversion already applied, so a caller that omits it is not newly refused.
    v_seq := coalesce(nullif(v_item ->> 'seq', '')::integer, v_count);
    if v_seq <= 0 then
      raise exception 'installment % has a non-positive seq', v_count using errcode = '22023';
    end if;
    if v_seq = any (v_seqs) then
      raise exception 'installment seq % appears more than once', v_seq using errcode = '22023';
    end if;
    v_seqs := array_append(v_seqs, v_seq);

    -- A due date is optional (both callers default it), but a supplied one has to
    -- be a date. Left as text and cast so a malformed value is refused here with
    -- the installment's number rather than as a bare 22007 from the INSERT.
    v_due := nullif(v_item ->> 'due_date', '');
    if v_due is not null then
      begin
        perform v_due::date;
      exception when others then
        raise exception 'installment % has an invalid due_date', v_count using errcode = '22023';
      end;
    end if;
  end loop;

  -- Exact, because both sides are numeric(12,2): after rounding to two decimals
  -- there is no representational slack left for a tolerance to absorb, only real
  -- money. A cent per contract is a reconciliation break, not a rounding artefact.
  if round(v_total, 2) <> round(p_total, 2) then
    raise exception 'the installment schedule totals % but the % totals %',
      to_char(v_total, 'FM999999999990.00'),
      p_subject,
      to_char(p_total, 'FM999999999990.00')
      using errcode = '22023';
  end if;

  return v_count;
end
$$;

comment on function public.assert_installment_schedule(jsonb, numeric, text) is
  'Validates an installment schedule payload: non-empty, every amount positive, seq unique and positive, any supplied due_date a real date, and the total exactly equal to the subject total after rounding to two decimals. Raises 22023 naming the offending installment. Used by create_contract() and convert_quotation_to_contract().';

revoke all on function public.assert_installment_schedule(jsonb, numeric, text) from public, anon;
grant execute on function public.assert_installment_schedule(jsonb, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8 · B6 — one transactional lead-won finalizer
-- ---------------------------------------------------------------------------
-- Reproduced: converting a quotation left leads.customer_id and the project's
-- customer_id null and wrote no 'won' business event. The cause is an ordering
-- one — convert_quotation_to_contract() inserts the contract BEFORE it marks the
-- lead won, and on_lead_won() begins with "if this lead already has a contract,
-- do nothing", so the automation that owns the customer upsert and the won event
-- returns early every single time the conversion path is used. Neither side was
-- wrong on its own; there were two owners of the same side effects and only one
-- of them ever ran.
--
-- This is the one owner. Both callers now perform the same customer upsert, the
-- same leads.customer_id write and the same 'won' business event, in the caller's
-- transaction, and both are idempotent so a retry is not a second customer.
create or replace function public.finalize_lead_won(
  p_lead_id uuid,
  p_amount  numeric,
  p_actor   uuid,
  p_source  text,
  p_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lead        record;
  v_customer_id uuid;
  v_name        text;
begin
  perform public.assert_current_session_at_entry();

  -- FOR UPDATE: two conversions racing on the same lead must not both decide the
  -- customer does not exist yet. The lock is the same one the callers already hold
  -- on their own rows, taken in the same order.
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;

  v_name        := coalesce(nullif(v_lead.customer_name, ''), nullif(v_lead.phone, ''), 'Unknown Client');
  v_customer_id := v_lead.customer_id;

  if v_customer_id is not null then
    update public.customers
       set total_contract_amount = coalesce(total_contract_amount, 0) + coalesce(p_amount, 0),
           last_activity_at      = now(),
           name  = case when customers.name is null or customers.name in ('', 'Unknown')
                        then v_name else customers.name end,
           phone = coalesce(customers.phone, v_lead.phone),
           email = coalesce(customers.email, v_lead.email),
           updated_at = now()
     where id = v_customer_id;
  else
    -- One customer per lead. The lookup is by lead_id rather than by name so a
    -- second finalize for the same lead finds the row the first one made, whatever
    -- the customer was called at the time.
    select id into v_customer_id from public.customers where lead_id = p_lead_id
     order by created_at asc, id asc limit 1;

    if v_customer_id is null then
      insert into public.customers (lead_id, name, phone, email, address,
                                    total_contract_amount, last_activity_at)
      values (p_lead_id, v_name, v_lead.phone, v_lead.email, v_lead.location,
              coalesce(p_amount, 0), now())
      returning id into v_customer_id;
    end if;

    update public.leads set customer_id = v_customer_id, updated_at = now()
     where id = p_lead_id and customer_id is null;
  end if;

  -- The won event, once per lead. This is the row the reproduction found missing:
  -- every conversion produced a contract with no 'won' event, so the business
  -- timeline showed leads that became contracts without ever being won.
  if not exists (
    select 1 from public.business_events
     where lead_id = p_lead_id and event_type = 'won'
  ) then
    insert into public.business_events (lead_id, user_id, event_type, description, event_data)
    values (p_lead_id, coalesce(p_actor, v_lead.assigned_to), 'won',
            'Lead won via ' || coalesce(nullif(p_source, ''), 'unknown'),
            coalesce(p_context, '{}'::jsonb)
              || jsonb_build_object('customer_id', v_customer_id,
                                    'amount',      coalesce(p_amount, 0),
                                    'source',      coalesce(nullif(p_source, ''), 'unknown')));
  end if;

  return v_customer_id;
end
$$;

comment on function public.finalize_lead_won(uuid, numeric, uuid, text, jsonb) is
  'The single owner of the lead-won side effects: customer upsert, leads.customer_id and the once-per-lead ''won'' business event, in the caller''s transaction and idempotent. Called by convert_quotation_to_contract() on both branches and by on_lead_won(); before this existed the conversion path silently skipped all three because on_lead_won() returns early once a contract exists.';

-- Not an RPC. It is SECURITY DEFINER, it takes a lead id, and it decides nothing
-- about who may finalise that lead — its two callers do, each after locking the
-- lead and checking ownership. Granted to `authenticated` it would be a way for
-- any session to declare an arbitrary lead won, create a customer for it and
-- write the 'won' business event, all under the definer's rights. The entry
-- assertion added by 20260816000000 would not stop that: a current session is
-- still a session. Its callers reach it through the definer's own privileges, so
-- taking EXECUTE back from end-user roles costs them nothing.
revoke all on function public.finalize_lead_won(uuid, numeric, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_lead_won(uuid, numeric, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 9 · B4 — create_contract() validates the schedule before it writes anything
-- ---------------------------------------------------------------------------
-- Carried forward from 20260814000000 with one line added before the contract
-- insert and the installment loop tightened. Everything else — the lead
-- authorisation check, the duplicate pre-check, the contract-number retry loop —
-- is unchanged.
--
-- Reproduced twice against the release state: create_contract() with
-- installments: [] produced contract REPLAY-B4-EMPTY of 100.00 with zero
-- installments and first_payment_status 'unpaid' forever, because
-- contract_first_payment_status() has no first installment to measure; and
-- create_contract() with a single installment of 40.00 produced a contract of
-- 100.00 whose schedule totalled 40.00. The route sends `installments: schedule`
-- with schedule = [] whenever the client omits them (src/app/api/contracts/route.ts),
-- so the first case is the one the real UI reaches.
create or replace function public.create_contract(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor       uuid;
  v_role        text;
  v_lead        record;
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
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss', 'operator', 'finance', 'sales']);
  select coalesce(role, '') into v_role from public.profiles where id = v_actor;

  v_lead_id := nullif(p_payload ->> 'lead_id', '')::uuid;
  if v_lead_id is null then
    raise exception 'lead_id is required' using errcode = '22023';
  end if;
  v_amount := nullif(p_payload ->> 'amount', '')::numeric(12, 2);
  if v_amount is null or v_amount <= 0 then
    raise exception 'a positive amount is required' using errcode = '22023';
  end if;

  -- The check this function never had. It accepted any lead UUID, so a sales
  -- user could create a contract against a colleague's lead — and because there
  -- is one active contract per lead, doing so also took that lead's only slot.
  -- Read with the definer's visibility on purpose: a sales user cannot see
  -- someone else's lead, and a "not found" that really means "not yours" is the
  -- shape that produced a 500 from the unique index instead of a decision.
  select id, assigned_to into v_lead from public.leads where id = v_lead_id;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_role not in ('admin', 'boss', 'operator', 'finance')
     and v_lead.assigned_to is distinct from v_actor then
    raise exception 'only the assigned salesperson or a manager may create a contract for this lead'
      using errcode = '42501';
  end if;

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

  -- B4. Before the first write, so a rejected schedule consumes no contract
  -- number and leaves no contract behind. A contract with no schedule is not a
  -- contract with an empty schedule: nothing can ever collect against it, and
  -- first_payment_status is pinned at 'unpaid' for the rest of its life.
  perform public.assert_installment_schedule(p_payload -> 'installments', v_amount, 'contract');

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
        if v_attempt >= 10 then
          raise;
        end if;
    end;
  end loop;

  -- No coalesce-to-zero on the amount any more: the validator has established
  -- that every element carries a positive one, so defaulting a missing amount to
  -- 0 here would only be able to hide a validator that stopped working.
  for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id,
      coalesce(nullif(v_inst ->> 'seq', '')::integer, v_inst_count + 1),
      (v_inst ->> 'amount')::numeric(12, 2),
      coalesce(nullif(v_inst ->> 'due_date', '')::date, v_date),
      coalesce(v_inst ->> 'description', ''),
      'pending'
    );
    v_inst_count := v_inst_count + 1;
  end loop;

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
-- 10 · B5, B6, B10 — the conversion
-- ---------------------------------------------------------------------------
-- Three findings meet in this routine.
--
-- B5 reproduced: quotations.contract_id was directly writable by the quotation's
-- owner (no guard covered the column), and the already-converted branch validated
-- only that the contract row exists. Pointing quotation REPLAY-Q6 (80000.00) at
-- contract REPLAY-B5-FOREIGN — a different lead, a different amount — and calling
-- the conversion returned success: true, already_converted: true and then wrote an
-- approval, a project and an activity against the OTHER lead's contract, naming
-- this quotation as the source. §6 above closes the write; this closes the read.
--
-- B6 reproduced: after a first conversion, leads.customer_id was still null, no
-- public.customers row existed for the lead, the project row carried
-- customer_id = null, and public.business_events held no 'won' row. The cause is
-- ordering: the contract is inserted before final_status is set to 'won', and
-- on_lead_won() begins "if this lead already has a contract, return", so the owner
-- of the customer upsert and the won event never ran on this path. §8 is the
-- single owner both paths now call.
--
-- B10 reproduced: `abs(v_inst_total - v_quote.total_amount) > 0.01` accepted a
-- schedule totalling 79999.99 against a quotation of 80000.00, and the contract
-- was created for 80000.00 — a cent unaccounted for, on every conversion, with no
-- error and nothing in any log. Now delegated to assert_installment_schedule().
create or replace function public.convert_quotation_to_contract(
  p_quotation_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor        uuid;
  v_actor_role   text;
  v_quote        record;
  v_lead         record;
  v_contract     record;
  v_contract_id  uuid;
  v_contract_no  text;
  v_date         date := current_date;
  v_attempt      integer := 0;
  v_inst         jsonb;
  v_inst_count   integer := 0;
  v_customer_id  uuid;
  v_project_id   uuid;
  v_finalized    text[] := '{}';
  v_sched_count  bigint;
  v_sched_total  numeric(12, 2);
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(
    nullif(p_payload ->> 'actor_id', '')::uuid,
    array['admin', 'boss', 'operator', 'finance', 'sales']);
  select coalesce(role, '') into v_actor_role from public.profiles where id = v_actor;

  select * into v_quote from public.quotations where id = p_quotation_id for update;
  if not found then
    raise exception 'quotation not found' using errcode = 'P0002';
  end if;

  select * into v_lead from public.leads where id = v_quote.lead_id;

  if v_actor_role not in ('admin', 'boss', 'operator')
     and v_quote.created_by is distinct from v_actor then
    raise exception 'only the quotation owner or a manager may convert it' using errcode = '42501';
  end if;

  -- ── The idempotent branch: this quotation already has its contract ────────
  if v_quote.contract_id is not null then
    select * into v_contract from public.contracts where id = v_quote.contract_id for update;
    if not found then
      -- A link to a contract that does not exist is corruption, not a retry.
      raise exception 'quotation % is linked to a contract that does not exist', v_quote.quote_no
        using errcode = '22023';
    end if;

    -- B5. Every invariant the first conversion establishes, re-checked before this
    -- branch acts on the link. A retry may only finish the conversion it started;
    -- it may not adopt somebody else's contract. Each condition is reported
    -- separately because "this retry is not a retry" is an operator's problem and
    -- a single generic message would not tell them which fact disagrees.
    if v_contract.quotation_id is distinct from v_quote.id then
      raise exception 'quotation % is linked to contract %, which names quotation % as its source; refusing to act on a crossed link',
        v_quote.quote_no, v_contract.contract_no, coalesce(v_contract.quotation_id::text, 'no quotation')
        using errcode = '22023';
    end if;
    if v_contract.lead_id is distinct from v_quote.lead_id then
      raise exception 'quotation % is linked to contract %, which belongs to a different lead; refusing to act on a crossed link',
        v_quote.quote_no, v_contract.contract_no using errcode = '22023';
    end if;
    if round(coalesce(v_contract.contract_amount, 0), 2) <> round(coalesce(v_quote.total_amount, 0), 2) then
      raise exception 'quotation % totals % but its contract % totals %; reconcile them before finishing the conversion',
        v_quote.quote_no, to_char(coalesce(v_quote.total_amount, 0), 'FM999999999990.00'),
        v_contract.contract_no, to_char(coalesce(v_contract.contract_amount, 0), 'FM999999999990.00')
        using errcode = '22023';
    end if;
    if v_contract.status in ('terminated', 'rejected', 'superseded') then
      raise exception 'contract % is % ; a terminated or superseded contract is not finished by retrying the conversion that made it',
        v_contract.contract_no, v_contract.status using errcode = '22023';
    end if;

    -- And the schedule, which the first conversion wrote in the same transaction as
    -- the contract. Missing or unequal here means the row was not written by this
    -- routine at all.
    select count(*), coalesce(sum(amount), 0)
      into v_sched_count, v_sched_total
      from public.installment_plans where contract_id = v_contract.id;
    if v_sched_count = 0 then
      raise exception 'contract % has no installment schedule; it was not created by a conversion of quotation %',
        v_contract.contract_no, v_quote.quote_no using errcode = '22023';
    end if;
    if round(v_sched_total, 2) <> round(coalesce(v_contract.contract_amount, 0), 2) then
      raise exception 'contract % has a schedule totalling % against a contract of %; reconcile it before finishing the conversion',
        v_contract.contract_no, to_char(v_sched_total, 'FM999999999990.00'),
        to_char(coalesce(v_contract.contract_amount, 0), 'FM999999999990.00')
        using errcode = '22023';
    end if;

    v_contract_id := v_contract.id;
    v_contract_no := v_contract.contract_no;

    -- B6, on the retry path too: a first attempt that failed after the contract
    -- and before the customer left exactly the state the reproduction found, and
    -- the retry is the only thing that will ever come back for it.
    if v_quote.lead_id is not null then
      v_customer_id := public.finalize_lead_won(
        v_quote.lead_id, coalesce(v_quote.total_amount, 0), v_actor, 'quotation_finalize',
        jsonb_build_object('quotation_id', v_quote.id, 'contract_id', v_contract_id,
                           'contract_no', v_contract_no));
      if v_customer_id is distinct from v_lead.customer_id then
        v_finalized := array_append(v_finalized, 'customer');
      end if;
    end if;

    if not exists (select 1 from public.contract_approvals
                    where contract_id = v_contract_id and step = 'admin_review') then
      insert into public.contract_approvals (contract_id, step, status, notes)
      values (v_contract_id, 'admin_review', 'pending',
              jsonb_build_object('source', 'quotation_finalize', 'quotation_id', v_quote.id));
      v_finalized := array_append(v_finalized, 'approval');
    end if;

    if to_regclass('public.projects') is not null
       and not exists (select 1 from public.projects where contract_id = v_contract_id) then
      insert into public.projects (
        customer_id, lead_id, contract_id, sales_id,
        name, property_type, property_size, location,
        phase, status, contract_amount
      ) values (
        -- v_customer_id, not v_lead.customer_id: the lead row was read before
        -- finalize_lead_won() ran, so the local copy still holds the null the
        -- reproduction found in projects.customer_id.
        coalesce(v_customer_id, v_lead.customer_id), v_quote.lead_id, v_contract_id,
        coalesce(v_quote.created_by, v_actor),
        coalesce(nullif(v_lead.customer_name, ''), 'Client') || ' - '
          || coalesce(nullif(v_lead.property_type, ''), 'Smart Home'),
        v_lead.property_type, v_lead.property_size_sqm, v_lead.location,
        'design', 'active', v_quote.total_amount
      );
      v_finalized := array_append(v_finalized, 'project');
    end if;

    if not exists (
      select 1 from public.activities
       where lead_id = v_quote.lead_id
         and content like '%' || v_contract_no || '%'
    ) then
      insert into public.activities (lead_id, user_id, type, content, ai_generated)
      values (v_quote.lead_id, v_actor, 'note',
              'Contract ' || v_contract_no || ' created from quotation ' || v_quote.quote_no
              || ' (pending admin review)', true);
      v_finalized := array_append(v_finalized, 'activity');
    end if;

    return jsonb_build_object(
      'success',            true,
      'already_converted',  true,
      'contract_id',        v_contract_id,
      'contract_no',        v_contract_no,
      'quotation_status',   v_quote.status,
      'customer_id',        v_customer_id,
      'installments_count', (select count(*) from public.installment_plans
                              where contract_id = v_contract_id),
      'finalized',          to_jsonb(v_finalized),
      'actor_id',           v_actor
    );
  end if;

  -- ── The first conversion ─────────────────────────────────────────────────
  if v_quote.status <> 'accepted' then
    raise exception 'only an accepted quotation can be converted (status %)', v_quote.status
      using errcode = '22023';
  end if;
  if not (coalesce(v_quote.total_amount, 0) > 0) then
    raise exception 'quotation total must be greater than zero' using errcode = '22023';
  end if;

  -- The installment invariant, checked before the first write. B10: the one cent
  -- of tolerance this used to allow is gone; see assert_installment_schedule().
  -- The coalesce inside it is still load-bearing for the same reason it was here —
  -- `jsonb_typeof('{}'::jsonb -> 'installments')` is NULL and `NULL <> 'array'` is
  -- NULL, so a bare comparison lets a POST with no body fall through and be
  -- refused with the wrong reason.
  v_inst_count := public.assert_installment_schedule(
    p_payload -> 'installments', v_quote.total_amount, 'quotation');
  v_inst_count := 0;

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

  for v_inst in select value from jsonb_array_elements(p_payload -> 'installments') loop
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id,
      coalesce(nullif(v_inst ->> 'seq', '')::integer, v_inst_count + 1),
      (v_inst ->> 'amount')::numeric(12, 2),
      coalesce(nullif(v_inst ->> 'due_date', '')::date, v_date),
      coalesce(v_inst ->> 'description', ''),
      'pending'
    );
    v_inst_count := v_inst_count + 1;
  end loop;

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

    -- B6. on_lead_won() has just fired and returned early, because the contract
    -- above already exists; this is the call that does what it declined to do.
    -- Same transaction as the contract, so there is no window in which a contract
    -- exists without its customer and its won event.
    v_customer_id := public.finalize_lead_won(
      v_quote.lead_id, coalesce(v_quote.total_amount, 0), v_actor, 'quotation',
      jsonb_build_object('quotation_id', v_quote.id, 'contract_id', v_contract_id,
                         'contract_no', v_contract_no));

    update public.contracts set customer_id = v_customer_id, updated_at = now()
     where id = v_contract_id and customer_id is null;
  end if;

  if to_regclass('public.projects') is not null
     and not exists (select 1 from public.projects where contract_id = v_contract_id) then
    insert into public.projects (
      customer_id, lead_id, contract_id, sales_id,
      name, property_type, property_size, location,
      phase, status, contract_amount
    ) values (
      v_customer_id, v_quote.lead_id, v_contract_id, coalesce(v_quote.created_by, v_actor),
      coalesce(nullif(v_lead.customer_name, ''), 'Client') || ' - '
        || coalesce(nullif(v_lead.property_type, ''), 'Smart Home'),
      v_lead.property_type, v_lead.property_size_sqm, v_lead.location,
      'design', 'active', v_quote.total_amount
    )
    returning id into v_project_id;
  end if;

  insert into public.activities (lead_id, user_id, type, content, ai_generated)
  values (v_quote.lead_id, v_actor, 'note',
          'Contract ' || v_contract_no || ' created from quotation ' || v_quote.quote_no
          || ' (pending admin review)', true);

  return jsonb_build_object(
    'success',            true,
    'already_converted',  false,
    'contract_id',        v_contract_id,
    'contract_no',        v_contract_no,
    'quotation_status',   'contract_created',
    'installments_count', v_inst_count,
    'project_id',         v_project_id,
    'customer_id',        v_customer_id,
    'actor_id',           v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 11 · B2, B3, B7 — confirmation
-- ---------------------------------------------------------------------------
-- Reproduced: a payment of -100.00 was created and confirmed. Confirmation set
-- projects.paid_amount to 100.00 - 100.00 = 0.00 and subtracted 100.00 from the
-- salesperson's collection KPI. §1 now refuses the row at insert; this is the
-- second gate, for a row that predates the constraint or arrives through a path
-- the constraint cannot see.
create or replace function public.confirm_payment(p_payment_id uuid, p_confirmer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_payment        record;
  v_contract       record;
  v_contract_found boolean := false;
  v_actor          uuid;
  v_fp_status      text;
  v_total_paid     numeric(12, 2);
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(p_confirmer_id, array['admin', 'boss', 'finance']);

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if coalesce(v_payment.confirmed, false) then
    raise exception 'payment is already confirmed' using errcode = '22023';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'a voided payment cannot be confirmed' using errcode = '22023';
  end if;
  -- B3.
  if v_payment.amount is null or v_payment.amount <= 0 then
    raise exception 'a payment of % cannot be confirmed; an amount must be positive',
      coalesce(to_char(v_payment.amount, 'FM999999999990.00'), 'no amount')
      using errcode = '22023';
  end if;

  select * into v_contract from public.contracts where id = v_payment.contract_id for update;
  v_contract_found := found;

  update public.payments
     set confirmed    = true,
         confirmed_by = v_actor,
         confirmed_at = now(),
         -- B7: the credit is recorded on the payment, so the reversal cannot be
         -- taken off a different person after a reassignment.
         credited_to  = v_contract.sales_id,
         updated_at   = now()
   where id = p_payment_id;

  -- B2: one derivation, shared with allocate_payment() and void_payment(). Written
  -- unconditionally, because "there is no first installment" is also an answer
  -- ('unpaid') and skipping the write is how a stale value survived.
  v_fp_status := public.contract_first_payment_status(v_payment.contract_id);
  update public.contracts
     set first_payment_status = v_fp_status, updated_at = now()
   where id = v_payment.contract_id
     and first_payment_status is distinct from v_fp_status;

  if v_contract_found then
    select coalesce(sum(p.amount), 0)
      into v_total_paid
      from public.payments p
     where p.contract_id = v_payment.contract_id
       and p.confirmed = true
       and p.voided_at is null;

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
    'credited_to', v_contract.sales_id,
    'first_payment_status', v_fp_status,
    'total_paid',  coalesce(v_total_paid, 0)
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 12 · B2 — allocation is the operation that changes the answer
-- ---------------------------------------------------------------------------
-- Reproduced: contract REPLAY-B3 (100000.00) with a first installment of 40000.00
-- and a confirmed payment of 40000.00. After confirm_payment() the contract read
-- 'unpaid', correctly — nothing was allocated yet. allocate_payment() then
-- allocated the whole 40000.00 to installment 1, which moved the plan to 'paid'
-- and left contracts.first_payment_status reading 'unpaid'. Every consumer of that
-- column — the contracts list, the approval gate, the dashboard — was reading a
-- value that the ledger had already contradicted, and nothing would correct it
-- until an unrelated confirmation or void happened to run.
--
-- Only the tail of the routine changes: the same recomputation the other two
-- already did.
create or replace function public.allocate_payment(p_payment_id uuid, p_allocations jsonb, p_allocated_by uuid)
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
  v_fp_status       text;
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(p_allocated_by, array['admin', 'boss', 'finance']);

  -- coalesce, not a bare comparison: jsonb_typeof(NULL) is NULL and
  -- `NULL <> 'array'` is NULL, so a missing key would fall straight through this
  -- test. Same three-valued-logic shape as P1-1.
  if p_allocations is null
     or coalesce(jsonb_typeof(p_allocations), 'null') <> 'array'
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
  if v_payment.voided_at is not null then
    raise exception 'a voided payment cannot be allocated' using errcode = '22023';
  end if;

  for i in 0 .. jsonb_array_length(p_allocations) - 1 loop
    v_total_allocated := v_total_allocated + (p_allocations -> i ->> 'amount')::numeric(12, 2);
  end loop;

  if v_total_allocated > v_payment.amount then
    -- to_char, not '%.2f': plpgsql RAISE has no width or precision specifiers,
    -- so '%.2f' prints the value followed by the literal '.2f'.
    raise exception 'total allocation % exceeds the payment amount %',
      to_char(v_total_allocated, 'FM999999999990.00'),
      to_char(v_payment.amount, 'FM999999999990.00') using errcode = '22023';
  end if;

  -- Every plan this statement will recompute: the ones it is about to release
  -- and the ones it is about to fill.
  select coalesce(array_agg(distinct plan_id), '{}') into v_affected
    from (
      select plan_id from public.payment_allocations where payment_id = p_payment_id
      union
      select (value ->> 'plan_id')::uuid from jsonb_array_elements(p_allocations)
             where nullif(value ->> 'plan_id', '') is not null
    ) s(plan_id);

  -- The row locks the previous version never took. Ordered, so concurrent
  -- callers with overlapping plan sets queue instead of deadlocking.
  if array_length(v_affected, 1) is not null then
    perform 1 from public.installment_plans
      where id = any (v_affected)
      order by id
      for update;
  end if;

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

    if not exists (
      select 1 from public.installment_plans ip
       where ip.id = v_plan_id and ip.contract_id = v_payment.contract_id
    ) then
      raise exception 'installment plan does not belong to the payment''s contract'
        using errcode = '42501';
    end if;

    insert into public.payment_allocations (payment_id, plan_id, amount_allocated, allocated_by)
    values (p_payment_id, v_plan_id, v_amount, v_actor);

    v_count := v_count + 1;
  end loop;

  foreach v_plan_id in array coalesce(v_affected, '{}'::uuid[]) loop
    -- Only confirmed, unvoided payments count towards a plan, so a plan cannot
    -- be marked paid by a payment that was reversed.
    select coalesce(sum(pa.amount_allocated), 0) into v_plan_allocated
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
     where pa.plan_id = v_plan_id and p.confirmed = true and p.voided_at is null;
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

  -- B2. The missing third writer.
  v_fp_status := public.contract_first_payment_status(v_payment.contract_id);
  update public.contracts
     set first_payment_status = v_fp_status, updated_at = now()
   where id = v_payment.contract_id
     and first_payment_status is distinct from v_fp_status;

  return jsonb_build_object(
    'success',           true,
    'allocations_count', v_count,
    'total_allocated',   v_total_allocated,
    'plans_recomputed',  coalesce(array_length(v_affected, 1), 0),
    'first_payment_status', v_fp_status,
    'actor_id',          v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 13 · B2, B7 — the reversal
-- ---------------------------------------------------------------------------
-- Reproduced: a confirmed payment of 40000.00 credited sales1's collection target.
-- The contract was reassigned to sales2. Voiding the payment then subtracted
-- 40000.00 from sales2 — who never collected it — and left the 40000.00 standing
-- on sales1. Two salespeople wrong from one void, and no record of which one had
-- been credited. payments.credited_to is that record.
create or replace function public.void_payment(p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_actor       uuid;
  v_payment     record;
  v_contract    record;
  v_plan_id     uuid;
  v_affected    uuid[];
  v_allocated   numeric(12, 2);
  v_plan_amount numeric(12, 2);
  v_total_paid  numeric(12, 2);
  v_released    integer := 0;
  v_credited_to uuid;
  v_fp_status   text;
begin
  perform public.assert_current_session_at_entry();
  v_actor := public.money_actor(null, array['admin', 'boss', 'finance']);

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to void a payment' using errcode = '22023';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'payment is already voided' using errcode = '23505';
  end if;

  select * into v_contract from public.contracts where id = v_payment.contract_id for update;

  -- B7. credited_to when the credit was recorded by this release; the contract's
  -- current salesperson only for a payment confirmed before it existed, which is
  -- exactly what the previous code did and therefore changes nothing for history.
  v_credited_to := coalesce(v_payment.credited_to, v_contract.sales_id);

  -- Same stable order as allocate_payment(), for the same reason.
  select coalesce(array_agg(distinct plan_id order by plan_id), '{}')
    into v_affected
    from public.payment_allocations
   where payment_id = p_payment_id;

  if array_length(v_affected, 1) is not null then
    perform 1 from public.installment_plans
      where id = any (v_affected)
      order by id
      for update;
  end if;

  delete from public.payment_allocations where payment_id = p_payment_id;

  update public.payments
     set confirmed    = false,
         voided_at    = now(),
         voided_by    = v_actor,
         void_reason  = btrim(p_reason),
         updated_at   = now()
   where id = p_payment_id;

  foreach v_plan_id in array coalesce(v_affected, '{}'::uuid[]) loop
    select coalesce(sum(pa.amount_allocated), 0)
      into v_allocated
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id
     where pa.plan_id = v_plan_id and p.confirmed = true and p.voided_at is null;
    select amount into v_plan_amount from public.installment_plans where id = v_plan_id;

    update public.installment_plans
       set allocated_amount = v_allocated,
           status = case
             when v_allocated >= v_plan_amount then 'paid'
             when v_allocated > 0              then 'partial'
             else 'pending'
           end,
           updated_at = now()
     where id = v_plan_id;
    v_released := v_released + 1;
  end loop;

  select coalesce(sum(p.amount), 0)
    into v_total_paid
    from public.payments p
   where p.contract_id = v_payment.contract_id
     and p.confirmed = true
     and p.voided_at is null;

  if to_regclass('public.projects') is not null then
    update public.projects
       set paid_amount = v_total_paid, updated_at = now()
     where contract_id = v_payment.contract_id;
  end if;

  if coalesce(v_payment.confirmed, false) and v_credited_to is not null then
    update public.kpi_targets
       set actual_amount = greatest(coalesce(actual_amount, 0) - v_payment.amount, 0),
           updated_at    = now()
     where assigned_to = v_credited_to
       and period      = to_char(v_payment.payment_date, 'YYYY-MM')
       and target_type = 'collection';
  end if;

  -- B2: the same derivation the other two writers use, replacing this routine's
  -- own copy of the rule.
  v_fp_status := public.contract_first_payment_status(v_payment.contract_id);
  update public.contracts
     set first_payment_status = v_fp_status, updated_at = now()
   where id = v_payment.contract_id
     and first_payment_status is distinct from v_fp_status;

  return jsonb_build_object(
    'success',           true,
    'payment_id',        p_payment_id,
    'amount',            v_payment.amount,
    'plans_recomputed',  v_released,
    'contract_total_paid', v_total_paid,
    'debited_from',      v_credited_to,
    'first_payment_status', v_fp_status,
    'actor_id',          v_actor
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 14 · B7 — editing a target must not delete the money collected against it
-- ---------------------------------------------------------------------------
-- Reproduced: sales2 held a current-period collection target with
-- actual_amount 40000.00, put there by a confirmation. An admin saved the period's
-- targets — the ordinary "set this month's targets" action, with the amount
-- unchanged — and actual_amount came back 0.00. replace_kpi_targets() deletes the
-- period and re-inserts from the payload, and the payload has no actual_amount
-- because actuals are not something a UI sends. Every confirmation and void
-- recorded before that save was erased from the period, silently, by an action
-- that looks like editing a number.
--
-- Two changes. Actuals for a (target_type, assigned_to) pair that survives the
-- replacement are carried forward. A pair that holds a non-zero actual and is NOT
-- in the replacement set aborts the save, because there is no correct place to put
-- collected money whose target has been removed and choosing one silently is what
-- this finding is about.
create or replace function public.replace_kpi_targets(p_period text, p_rows jsonb, p_set_by uuid)
returns setof public.kpi_targets
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lock_key bigint;
  v_actuals  jsonb;
  v_orphans  bigint;
begin
  perform public.assert_current_session_at_entry();
  if p_period is null or btrim(p_period) = '' then
    raise exception 'period is required' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'at least one target row is required' using errcode = '22023';
  end if;

  -- Serialize on the period, before the delete. Held to commit or rollback, so a
  -- concurrent save of the SAME period waits and then deletes what this one
  -- actually wrote; a save of a different period is unaffected. The key is
  -- derived from the period text, so it needs no table and no cleanup.
  v_lock_key := hashtextextended('public.kpi_targets:' || p_period, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Rejected here because no index can reject it: two rows with the same
  -- target_type and no assignee are not a unique-index violation.
  if exists (
    select 1
      from jsonb_array_elements(p_rows) as row_in
     group by row_in ->> 'target_type', nullif(row_in ->> 'assigned_to', '')
    having count(*) > 1
  ) then
    raise exception 'the replacement set contains more than one row for the same (target_type, assigned_to)'
      using errcode = '23505';
  end if;

  -- B7, read under the advisory lock and therefore stable for the rest of this
  -- transaction. jsonb rather than a temp table so the routine stays reentrant.
  select coalesce(jsonb_agg(jsonb_build_object(
           'target_type',   target_type,
           'assigned_to',   assigned_to,
           'actual_amount', actual_amount)), '[]'::jsonb)
    into v_actuals
    from public.kpi_targets
   where period = p_period;

  -- `is not distinct from`, not `=`: the unassigned (company-wide) target has a
  -- NULL assignee, and `NULL = NULL` would drop its actuals on every save.
  select count(*) into v_orphans
    from jsonb_array_elements(v_actuals) as a
   where coalesce((a ->> 'actual_amount')::numeric(12, 2), 0) <> 0
     and not exists (
       select 1 from jsonb_array_elements(p_rows) as row_in
        where row_in ->> 'target_type' = a ->> 'target_type'
          and nullif(row_in ->> 'assigned_to', '')::uuid
              is not distinct from nullif(a ->> 'assigned_to', '')::uuid);
  if v_orphans > 0 then
    raise exception 'the replacement set drops % target(s) for % that already hold collected amounts; keep the row (with target_amount 0 if it is no longer a target) so the recorded actuals have somewhere to live',
      v_orphans, p_period using errcode = '22023';
  end if;

  -- One transaction: the delete is only durable if every row inserts.
  delete from public.kpi_targets where period = p_period;

  return query
  insert into public.kpi_targets (period, target_type, target_amount, assigned_to, notes, set_by,
                                  actual_amount)
  select
    p_period,
    row_in->>'target_type',
    (row_in->>'target_amount')::numeric(12,2),
    nullif(row_in->>'assigned_to', '')::uuid,
    nullif(row_in->>'notes', ''),
    p_set_by,
    coalesce(prev.actual_amount, 0)
  from jsonb_array_elements(p_rows) as row_in
  left join lateral (
    select (a ->> 'actual_amount')::numeric(12, 2) as actual_amount
      from jsonb_array_elements(v_actuals) as a
     where a ->> 'target_type' = row_in ->> 'target_type'
       and nullif(a ->> 'assigned_to', '')::uuid
           is not distinct from nullif(row_in ->> 'assigned_to', '')::uuid
     limit 1
  ) prev on true
  returning *;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15 · B6, B10 — the automation delegates the side effects it owns
-- ---------------------------------------------------------------------------
-- Carried forward from 20260812000000 §12 with three changes:
--   * the customer upsert, the leads.customer_id write and the 'won' business
--     event are delegated to finalize_lead_won(), so there is one implementation
--     of them instead of two and the conversion path can reach it;
--   * the three-way percentage split puts the remainder on the last installment,
--     so the schedule equals the contract exactly (B10, on this path);
--   * the 'won' event's event_data is completed with the contract, project and
--     installment facts after they exist, rather than a second 'won' row being
--     written.
-- The trigger definition is untouched: trg_lead_won still fires
-- AFTER UPDATE OF final_status ... WHEN (NEW.final_status = 'won').
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
  v_contract_amount   numeric(12, 2);
  v_customer_name     text;
  v_location          text;
  v_property_type     text;
  v_property_size     integer;
  v_installment_count integer := 3;
  v_seq               integer;
  v_pct               numeric[];
  v_due_days          integer[];
  v_amounts           numeric(12, 2)[] := '{}';
  v_amount            numeric(12, 2);
  v_remaining         numeric(12, 2);
  v_sched_total       numeric(12, 2);
begin
  if new.final_status <> 'won' or old.final_status = 'won' then
    return new;
  end if;

  -- Idempotency: a lead that already has a contract (for instance one just
  -- created by convert_quotation_to_contract) gets nothing further. That routine
  -- calls finalize_lead_won() itself, which is the half of this function's work
  -- that the early return used to skip for good.
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

  -- B6: the shared finalizer, which also writes the 'won' event once per lead.
  v_customer_id := public.finalize_lead_won(
    new.id, v_contract_amount, new.assigned_to, 'lead_won_automation', '{}'::jsonb);

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

  -- B10 on this path. round() of each percentage does not have to add up to the
  -- contract: 0.50/0.30/0.20 of 100.01 does, 0.03 does not (0.02 + 0.01 + 0.01).
  -- The last installment takes the remainder, and a total too small to split into
  -- three positive installments becomes one installment for the whole amount
  -- rather than a schedule containing a zero — which installment_plans now
  -- refuses outright (§1).
  v_pct       := array[0.50, 0.30, 0.20];
  v_due_days  := array[0, 30, 60];
  v_remaining := v_contract_amount;

  for v_seq in 1 .. v_installment_count loop
    if v_seq < v_installment_count then
      v_amount := round(v_contract_amount * v_pct[v_seq], 2);
    else
      v_amount := v_remaining;
    end if;
    if v_amount <= 0 then
      v_amounts := array[v_contract_amount];
      exit;
    end if;
    v_amounts   := array_append(v_amounts, v_amount);
    v_remaining := v_remaining - v_amount;
  end loop;

  for v_seq in 1 .. array_length(v_amounts, 1) loop
    insert into public.installment_plans (contract_id, seq, amount, due_date, description, status)
    values (
      v_contract_id, v_seq, v_amounts[v_seq],
      current_date + v_due_days[least(v_seq, array_length(v_due_days, 1))],
      case
        when array_length(v_amounts, 1) = 1 then '全款 (签约)'
        when v_seq = 1 then '首期款 (签约)'
        when v_seq = 2 then '二期款 (设备到货)'
        else '尾款 (验收)'
      end,
      'pending'
    );
  end loop;

  -- Self-check rather than a comment claiming it adds up.
  select coalesce(sum(amount), 0) into v_sched_total
    from public.installment_plans where contract_id = v_contract_id;
  if round(v_sched_total, 2) <> round(v_contract_amount, 2) then
    raise exception 'the automation built a schedule totalling % for a contract of %',
      to_char(v_sched_total, 'FM999999999990.00'),
      to_char(v_contract_amount, 'FM999999999990.00') using errcode = '22000';
  end if;

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

  -- The facts the automation's own 'won' event used to carry, merged into the one
  -- finalize_lead_won() wrote. One event per lead, and none of the detail lost.
  update public.business_events
     set description = 'Automation: Lead Won → Contract#' || v_contract_no
                       || ' + ' || array_length(v_amounts, 1)::text
                       || ' installments + project',
         event_data  = coalesce(event_data, '{}'::jsonb) || jsonb_build_object(
                         'contract_id',       v_contract_id,
                         'contract_no',       v_contract_no,
                         'project_id',        v_project_id,
                         'installment_count', array_length(v_amounts, 1),
                         'customer_id',       v_customer_id)
   where lead_id = new.id and event_type = 'won';

  insert into public.activities (lead_id, user_id, type, content)
  values (new.id, new.assigned_to, 'note',
    'System auto-created: Contract#' || v_contract_no || ', '
    || array_length(v_amounts, 1)::text
    || ' installment plans, project (pending admin review)');

  return new;
end
$$;

-- on_lead_won() is a trigger function, so 20260816000000 §2 takes it off the
-- end-user surface. CREATE OR REPLACE preserves the existing ACL, but this file
-- may be the first to install it in a rebuilt database, where CREATE grants
-- EXECUTE to PUBLIC.
revoke all on function public.on_lead_won() from public, anon, authenticated;
revoke all on function public.guard_contracts_write() from public, anon, authenticated;
revoke all on function public.guard_payments_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 16 · The A1 gate, re-checked
-- ---------------------------------------------------------------------------
-- Six SECURITY DEFINER routines are redefined above and one is new. CREATE OR
-- REPLACE replaces the whole body, so a forgotten
-- `perform public.assert_current_session_at_entry();` would silently reopen A1 in
-- the middle of a release that closed it. Same query as 20260816000000 §5.
do $do$
declare
  v_uncovered text[];
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
    raise exception 'this file left these SECURITY DEFINER routines without an entry-time session assertion: %',
      array_to_string(v_uncovered, ', ') using errcode = '22000';
  end if;
end
$do$;

commit;
