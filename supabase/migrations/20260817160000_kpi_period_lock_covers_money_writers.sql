-- ============================================================================
-- R3 · the KPI period lock has to cover every writer of kpi_targets.actual_amount
-- ============================================================================
-- 20260817000000 §14 gave replace_kpi_targets() a period lock, and
-- 20260817150000 gave clear_kpi_targets() the same one:
--
--     v_lock_key := hashtextextended('public.kpi_targets:' || p_period, 0);
--     perform pg_advisory_xact_lock(v_lock_key);
--
-- Both files describe the lock as serializing "a save and a clear of one period".
-- That is accurate and it is also the whole gap: the two routines that actually
-- MOVE money into and out of actual_amount — confirm_payment() and void_payment()
-- — write the same period's rows and take no lock at all. So the lock serializes
-- the two routines that edit targets against each other, and neither of them
-- against the two routines that edit the amounts collected against those targets.
--
-- Three failure modes, all on the same key, all with the target editor holding the
-- lock and the payment routine walking straight past it:
--
--   1 · Lost collection. replace_kpi_targets() reads the period's actuals into
--       v_actuals (B7 carry-forward), then deletes the period and re-inserts with
--       the snapshot. A confirm_payment() that commits between the snapshot and
--       the delete has its amount deleted and overwritten by the pre-confirm
--       value. Both transactions report success. Nothing recomputes actual_amount
--       from payments, so the money is gone from the KPI for good.
--
--   2 · The B7 orphan guard defeated. The guard is "refuse a payload that drops a
--       pair still holding collected money", evaluated against v_actuals — read
--       under the lock, and therefore stale with respect to any confirm that
--       commits after it. The save is accepted, the target row disappears, and the
--       collected amount it held goes with it. The guard's own comment says there
--       is no correct place to put that money; this is the path that puts it
--       nowhere without asking.
--
--   3 · A clear that is allowed to say the period was empty. clear_kpi_targets()
--       counts non-zero actuals under the lock and refuses if any exist, then
--       deletes and writes a KPI_PERIOD_CLEARED audit row. A confirm that commits
--       between the count and the delete is deleted by it, and the audit row —
--       the server-owned evidence for the operation — records a clean removal of a
--       period that in fact held collected money.
--
-- Reproduced, PG 17.10 (Debian 17.10-1.pgdg13+1), isolated replay database, mode 1
-- above in both money directions, staged with the database's own lock state as the
-- barrier (no sleeps) in supabase/replay/19_concurrency_kpi_period.sh. Period
-- 2019-11, one collection target for cccccccc-…-cccccccccccc staged at 0.00, one
-- unconfirmed payment of 4321.00, target save held uncommitted at the barrier:
--
--   EXPECT=lost  (the two bodies replaced with their live definitions minus the
--                two lock lines, so the control is derived from what is installed
--                rather than written by hand)
--                  credit  the money session waits on `transactionid` — a row
--                          lock, not this key — then confirm_payment reports
--                          success: actual_amount 0.00, ledger 4321.00.
--                  debit   the save carries 4321.00 forward, void_payment reports
--                          success: actual_amount 4321.00, ledger 0.00.
--                Both operations succeeded and the KPI row disagrees with the
--                ledger by the whole payment in both directions.
--   EXPECT=serialized (this migration applied)
--                  credit  the money session waits on `advisory`, then commits:
--                          actual_amount 4321.00 = ledger 4321.00.
--                  debit   waits on `advisory`, then commits: actual_amount 0.00 =
--                          ledger 0.00.
--                The gate FAILS if the money session was not observed waiting, and
--                fails if it waited on the wrong locktype, so a green run cannot be
--                a run where the two never overlapped or where the control's
--                mutation silently did not take.
--
-- The fix, and only this: both routines take the same lock, on the same key, with
-- the same key expression, immediately before their kpi_targets write. Nothing
-- else in either body changes — the two functions are re-emitted in full because
-- PostgreSQL replaces a function body whole, and this file is deliberately the
-- last definition of both, so `create or replace` here wins over 20260817000000.
--
-- Lock ORDER, argued rather than assumed, because a second lock is how a
-- deadlock gets introduced. All four routines that touch this key end up with one
-- order: row locks first, the advisory lock last, and no row lock acquired after
-- it.
--
--   confirm_payment  `for update` on payments and contracts, then the advisory
--                    lock, then the kpi_targets write. Nothing after it.
--   void_payment     `for update` on payments, contracts and installment_plans,
--                    then the advisory lock, then kpi_targets, then a contracts
--                    UPDATE — on the row it already locked at the top of the
--                    routine, so it acquires nothing new while holding the
--                    advisory lock.
--   replace_kpi_targets / clear_kpi_targets  the advisory lock, then kpi_targets
--                    only. Neither touches payments, contracts or
--                    installment_plans at all.
--
-- So no transaction can hold this advisory lock and then wait for a row lock that
-- another holder of the same key is waiting behind. Two concurrent confirms or
-- voids on one period serialize on the advisory lock after both already hold
-- their own disjoint payment rows.
--
-- No lock_timeout, deliberately. Adding `set local lock_timeout` inside these
-- routines would also apply to the `for update` waits they already do, turning
-- waits that currently succeed into errors under load. That is a behaviour change
-- with its own review, not part of closing this hole. The advisory wait is bounded
-- by the target-edit transaction, which does one delete and one insert.
--
-- Privileges: `create or replace function` preserves a function's ACL, so this
-- file re-grants nothing, and asserts at the end that it widened nothing either.
--
-- NO_ROLLBACK: this file creates no object, writes no row and takes no privilege
-- away. It redefines two existing functions in place, and the only difference in
-- either body is the pair of lines that takes the lock, so there is nothing for a
-- rollback to undo except the serialization itself — and undoing that is
-- reinstating the lost collection described above. No rollback companion in
-- supabase/migrations/ redefines confirm_payment() or void_payment(), so rolling
-- back the money phase leaves these two bodies installed, which is correct: the
-- lock is a no-op when nothing else holds the key, and the phase rollback drops
-- the direct-write guards, not the routines. The manual revert, if it is ever
-- needed, is to re-apply 20260817000000_l0_round4_money_and_business_integrity.sql
-- §11 and §13 (the confirm_payment and void_payment bodies) to drop back to the
-- unlocked versions — after which the twelfth posture predicate in
-- supabase/preflight/expand-contract-rollback.md refuses the release switch, by
-- design, because it counts writers of kpi_targets that hold this key.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · confirm_payment — identical to 20260817000000 §11 except for v_kpi_period
--     and the two lines that take the lock.
-- ---------------------------------------------------------------------------
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
  v_kpi_period     text;
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

    -- R3. The period comes from the payment row this transaction already holds
    -- `for update`, so the key locked below is exactly the key written under it —
    -- there is no window in which the period could be something else.
    v_kpi_period := to_char(v_payment.payment_date, 'YYYY-MM');
    perform pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || v_kpi_period, 0));

    update public.kpi_targets
       set actual_amount = actual_amount + v_payment.amount, updated_at = now()
     where assigned_to = v_contract.sales_id
       and period      = v_kpi_period
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
-- 2 · void_payment — identical to 20260817000000 §13 except for v_kpi_period and
--     the two lines that take the lock.
-- ---------------------------------------------------------------------------
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
  v_kpi_period  text;
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
    -- R3, and for the same reason as in confirm_payment(): the period is derived
    -- from the payment row already held `for update`. The debit is the mirror of
    -- the credit, so it has to serialize against a target edit of the same period
    -- for exactly the same three reasons.
    v_kpi_period := to_char(v_payment.payment_date, 'YYYY-MM');
    perform pg_advisory_xact_lock(hashtextextended('public.kpi_targets:' || v_kpi_period, 0));

    update public.kpi_targets
       set actual_amount = greatest(coalesce(actual_amount, 0) - v_payment.amount, 0),
           updated_at    = now()
     where assigned_to = v_credited_to
       and period      = v_kpi_period
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
-- 3 · Self-check, inside the same transaction as the replacements.
--
-- (a) Every function in `public` whose body writes public.kpi_targets takes this
--     period lock. Derived from the bodies rather than from a list of four names,
--     because the failure this file closes is precisely "a writer nobody added to
--     the list". A fifth writer created later without the lock makes this file's
--     own claim false, and the same predicate runs in the release posture
--     (infra/release/release-manifest.json, kpi-actuals-writers-take-the-period-lock)
--     so it is re-checked on every phase verification, not only at apply time.
--
-- (b) Neither replacement widened its ACL. `create or replace` preserves
--     privileges, and this asserts that rather than trusting it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_unlocked text;
  v_writers  integer;
begin
  select count(*),
         string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
           filter (where pg_catalog.pg_get_functiondef(p.oid)
                         not like '%hashtextextended(''public.kpi_targets:''%')
    into v_writers, v_unlocked
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     -- Byte-identical to the manifest predicate's pattern, bracket expressions
     -- rather than \s so the two copies do not differ by JSON escaping.
     and pg_catalog.pg_get_functiondef(p.oid) ~*
           '(update|delete[[:space:]]+from|insert[[:space:]]+into)[[:space:]]+public[.]kpi_targets';

  if v_writers < 4 then
    raise exception 'expected at least 4 functions writing public.kpi_targets (confirm_payment, void_payment, replace_kpi_targets, clear_kpi_targets), found %',
      v_writers using errcode = '42883';
  end if;
  if v_unlocked is not null then
    raise exception 'these functions write public.kpi_targets without taking the period lock: %',
      v_unlocked using errcode = '55000';
  end if;

  if has_function_privilege('anon', 'public.confirm_payment(uuid, uuid)', 'execute')
     or has_function_privilege('anon', 'public.void_payment(uuid, text)', 'execute') then
    raise exception 'replacing the money routines widened their ACL to anon'
      using errcode = '42501';
  end if;
  if not has_function_privilege('service_role', 'public.confirm_payment(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.void_payment(uuid, text)', 'execute') then
    raise exception 'replacing the money routines dropped service_role EXECUTE'
      using errcode = '42501';
  end if;
end
$$;

commit;
