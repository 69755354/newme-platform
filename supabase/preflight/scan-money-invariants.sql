-- ============================================================================
-- Preflight scan for 20260817000000_l0_round4_money_and_business_integrity.sql
-- ============================================================================
-- That migration is fail-closed: rather than deleting or rewriting money rows to
-- make its constraints applicable, it counts the rows that would violate them and
-- aborts with the count. An abort in a deploy window is the correct outcome, but
-- it is a bad way to *learn* the count — the window is the wrong place to start
-- reconciling somebody's collections. This file is the same arithmetic, read-only,
-- so the answer is known beforehand.
--
--   psql "$DATABASE_URL" -f supabase/preflight/scan-money-invariants.sql
--
-- Every count of 0 means the migration will apply. A non-zero count in section 1
-- means it will abort, by design, and the rows behind it are money corrections
-- that a person has to make a decision about. The other sections do not block the
-- migration; they describe the history it is about to start enforcing, which is
-- worth reading before it does.
--
-- Read-only by construction, not by convention: the whole file runs inside a
-- READ ONLY transaction, so a mistake in it cannot write to the database it is
-- pointed at. It creates nothing, not even a temp table.
--
-- By default it prints counts only. `-v detail=on` adds the identifying rows for
-- each non-zero count, which is the operator's list of things to fix:
--
--   psql "$DATABASE_URL" -v detail=on -f supabase/preflight/scan-money-invariants.sql
--
-- Those rows are contract numbers, ids and amounts — real customer money. Run the
-- detailed form only where you are entitled to see it and where its output is
-- handled accordingly; the default form is the one that is safe to paste into a
-- deploy log or a review thread.
-- ============================================================================

\set ON_ERROR_STOP on
\pset pager off
\timing off

begin;
set transaction read only;

\if :{?detail}
\echo '== money invariant preflight (counts and operator detail) =='
\else
\echo '== money invariant preflight (counts only; add -v detail=on for the rows) =='
\endif

-- Which halves of the release are already present. The scan has to run against a
-- database that has NOT had the migration yet — that is its whole purpose — so
-- every section that names a column the migration adds is gated on the column
-- actually being there. Run after the fact and it is a verification instead.
select
  exists (select 1 from pg_attribute
           where attrelid = 'public.payments'::regclass
             and attname = 'request_key' and not attisdropped) as has_request_key,
  exists (select 1 from pg_attribute
           where attrelid = 'public.payments'::regclass
             and attname = 'credited_to' and not attisdropped) as has_credited_to,
  -- payments.voided_at is not part of every schema this may be pointed at, and the
  -- derivation in section 4 has to exclude voided payments wherever it does exist.
  -- Substituted as a SQL fragment rather than branching the query twice, so there
  -- is exactly one copy of the arithmetic to keep in step with the migration.
  case when exists (select 1 from pg_attribute
                     where attrelid = 'public.payments'::regclass
                       and attname = 'voided_at' and not attisdropped)
       then 'and p.voided_at is null' else '' end as voided_filter
\gset

-- ---------------------------------------------------------------------------
-- 1 · B3 — the three counts that decide whether the migration applies
-- ---------------------------------------------------------------------------
-- These are the same three queries as §1 of the migration, in the same order. If
-- the total is not 0 the migration aborts with errcode 22000 and applies nothing.
\echo ''
\echo '-- 1. non-positive money rows (BLOCKS the migration if the total is not 0)'
select
  (select count(*) from public.payments
    where amount is null or amount <= 0)                     as bad_payments,
  (select count(*) from public.payment_allocations
    where amount_allocated is null or amount_allocated <= 0) as bad_allocations,
  (select count(*) from public.installment_plans
    where amount is null or amount <= 0)                     as bad_installment_plans,
  (select count(*) from public.payments
    where amount is null or amount <= 0)
  + (select count(*) from public.payment_allocations
      where amount_allocated is null or amount_allocated <= 0)
  + (select count(*) from public.installment_plans
      where amount is null or amount <= 0)                   as total_blocking;

\if :{?detail}
\echo '   payments with a non-positive amount'
select id, contract_id, amount, payment_date, confirmed, created_by
  from public.payments
 where amount is null or amount <= 0
 order by payment_date, id;

\echo '   allocations with a non-positive amount'
select id, payment_id, plan_id, amount_allocated
  from public.payment_allocations
 where amount_allocated is null or amount_allocated <= 0
 order by id;

\echo '   installment plans with a non-positive amount'
select id, contract_id, seq, amount, due_date, status
  from public.installment_plans
 where amount is null or amount <= 0
 order by contract_id, seq, id;
\endif

-- ---------------------------------------------------------------------------
-- 2 · B3 — request keys that would collide under the new unique index
-- ---------------------------------------------------------------------------
-- idx_payments_request_key is unique on (created_by, request_key) where the key is
-- not null. On a database that does not have the column yet there is nothing to
-- collide, and that is the expected answer; the section exists for a re-run after
-- a partial deploy, where a duplicate would make the CREATE UNIQUE INDEX fail.
\echo ''
\echo '-- 2. request keys already duplicated per creator (0 unless the column exists)'
\if :has_request_key
select count(*) as duplicated_request_keys
  from (select created_by, request_key
          from public.payments
         where request_key is not null
         group by created_by, request_key
        having count(*) > 1) d;
\if :{?detail}
select created_by, request_key, count(*) as payments,
       sum(amount) as total_amount, min(payment_date) as first_seen
  from public.payments
 where request_key is not null
 group by created_by, request_key
having count(*) > 1
 order by count(*) desc, created_by;
\endif
\else
\echo '   payments.request_key does not exist yet: nothing can collide (expected before the migration)'
\endif

-- ---------------------------------------------------------------------------
-- 3 · B4 / B10 — contracts whose installment schedule does not describe them
-- ---------------------------------------------------------------------------
-- From here on, nothing blocks the migration: it adds no constraint over these
-- and repairs no history. What it does is refuse to CREATE any more of them, so
-- this count is the backlog the new validation will not accept if any of these
-- contracts is ever rewritten through create_contract() or a re-conversion.
--
-- Three separate defects, deliberately counted separately, because they are
-- resolved differently: a contract with no schedule at all is a data-entry gap; a
-- schedule that does not total is an arithmetic error in whichever client wrote
-- it; a duplicated seq is the ordering bug that made "the first installment"
-- depend on scan order.
\echo ''
\echo '-- 3. contracts whose schedule is missing, mis-totalled or mis-numbered'
with sched as (
  select c.id,
         c.contract_no,
         coalesce(c.contract_amount, 0)                as contract_amount,
         count(ip.id)                                  as installments,
         coalesce(sum(ip.amount), 0)                   as scheduled,
         count(*) filter (where ip.seq is not null)
           - count(distinct ip.seq)                    as duplicate_positions,
         -- `ip.id is not null` matters: the join is a LEFT JOIN, so a contract with
         -- no schedule at all produces one row with a null seq. Without the guard
         -- it would be counted here as well as under no_schedule, and the two
         -- numbers would overlap without saying so.
         count(*) filter (where ip.id is not null
                            and (ip.seq is null or ip.seq <= 0)) as bad_positions
    from public.contracts c
    left join public.installment_plans ip on ip.contract_id = c.id
   group by c.id, c.contract_no, c.contract_amount
)
select
  count(*) filter (where installments = 0)                                as no_schedule,
  count(*) filter (where installments > 0
                     and round(scheduled, 2) <> round(contract_amount, 2)) as does_not_total,
  count(*) filter (where duplicate_positions > 0)                          as duplicate_seq,
  count(*) filter (where bad_positions > 0)                                as non_positive_seq
  from sched;

\if :{?detail}
with sched as (
  select c.id,
         c.contract_no,
         c.status,
         coalesce(c.contract_amount, 0)              as contract_amount,
         count(ip.id)                                as installments,
         coalesce(sum(ip.amount), 0)                 as scheduled,
         count(*) filter (where ip.seq is not null)
           - count(distinct ip.seq)                  as duplicate_positions
    from public.contracts c
    left join public.installment_plans ip on ip.contract_id = c.id
   group by c.id, c.contract_no, c.status, c.contract_amount
)
select contract_no, status, contract_amount, installments, scheduled,
       round(scheduled - contract_amount, 2) as difference, duplicate_positions
  from sched
 where installments = 0
    or round(scheduled, 2) <> round(contract_amount, 2)
    or duplicate_positions > 0
 order by abs(scheduled - contract_amount) desc, contract_no;
\endif

-- ---------------------------------------------------------------------------
-- 4 · B2 — contracts whose stored first_payment_status is not the derived one
-- ---------------------------------------------------------------------------
-- The migration ends §3 with an UPDATE that reconciles exactly this set, so the
-- count here is the number of rows it will rewrite. Worth knowing in advance for
-- two reasons: it is the size of the correction being made to a column the UI
-- shows, and a surprisingly large number means the three routines had been
-- disagreeing for longer than the review assumed.
--
-- The derivation is repeated inline rather than calling
-- contract_first_payment_status(), which does not exist before the migration:
-- lowest seq, oldest among duplicates, and only confirmed unvoided allocations.
\echo ''
\echo '-- 4. contracts whose first_payment_status will be rewritten by the migration'
with first_plan as (
  select distinct on (ip.contract_id)
         ip.contract_id, ip.id as plan_id, ip.amount
    from public.installment_plans ip
   where ip.seq = 1
   order by ip.contract_id, ip.created_at asc, ip.id asc
),
derived as (
  select c.id,
         c.contract_no,
         coalesce(c.first_payment_status, '') as stored,
         case
           when fp.plan_id is null then 'unpaid'
           when coalesce((select sum(pa.amount_allocated)
                            from public.payment_allocations pa
                            join public.payments p on p.id = pa.payment_id
                           where pa.plan_id = fp.plan_id
                             and p.confirmed = true
                             :voided_filter), 0) >= fp.amount then 'paid'
           when coalesce((select sum(pa.amount_allocated)
                            from public.payment_allocations pa
                            join public.payments p on p.id = pa.payment_id
                           where pa.plan_id = fp.plan_id
                             and p.confirmed = true
                             :voided_filter), 0) > 0 then 'partial'
           else 'unpaid'
         end as derived
    from public.contracts c
    left join first_plan fp on fp.contract_id = c.id
)
select count(*)                                                      as disagreeing,
       count(*) filter (where stored = 'paid'   and derived <> 'paid')   as overstated_as_paid,
       count(*) filter (where stored = 'unpaid' and derived <> 'unpaid') as understated_as_unpaid
  from derived
 where stored is distinct from derived;

\if :{?detail}
with first_plan as (
  select distinct on (ip.contract_id)
         ip.contract_id, ip.id as plan_id, ip.amount
    from public.installment_plans ip
   where ip.seq = 1
   order by ip.contract_id, ip.created_at asc, ip.id asc
),
derived as (
  select c.contract_no,
         coalesce(c.first_payment_status, '') as stored,
         case
           when fp.plan_id is null then 'unpaid'
           when coalesce((select sum(pa.amount_allocated)
                            from public.payment_allocations pa
                            join public.payments p on p.id = pa.payment_id
                           where pa.plan_id = fp.plan_id
                             and p.confirmed = true
                             :voided_filter), 0) >= fp.amount then 'paid'
           when coalesce((select sum(pa.amount_allocated)
                            from public.payment_allocations pa
                            join public.payments p on p.id = pa.payment_id
                           where pa.plan_id = fp.plan_id
                             and p.confirmed = true
                             :voided_filter), 0) > 0 then 'partial'
           else 'unpaid'
         end as derived
    from public.contracts c
    left join first_plan fp on fp.contract_id = c.id
)
select contract_no, stored, derived
  from derived
 where stored is distinct from derived
 order by stored, derived, contract_no;
\endif

-- ---------------------------------------------------------------------------
-- 5 · B6 — leads that were won without the side effects, or won twice
-- ---------------------------------------------------------------------------
-- The finding: the conversion path wrote no 'won' business event and left
-- leads.customer_id null, while the trigger path wrote one. So there are two
-- populations to count, and the migration repairs neither — it makes both paths
-- go through one finalizer from now on. `won_twice` should be 0 both before and
-- after; if it is not, the once-per-lead rule was already violated by hand and the
-- finalizer's `if not exists` will simply leave both rows in place.
\echo ''
\echo '-- 5. won leads missing their side effects, and leads carrying two won events'
select
  (select count(*) from public.leads l
    where l.final_status = 'won'
      and not exists (select 1 from public.business_events be
                       where be.lead_id = l.id and be.event_type = 'won'))  as won_without_event,
  (select count(*) from public.leads l
    where l.final_status = 'won' and l.customer_id is null)                 as won_without_customer,
  (select count(*) from (select lead_id from public.business_events
                          where event_type = 'won'
                          group by lead_id having count(*) > 1) d)          as won_twice;

\if :{?detail}
select l.id as lead_id,
       l.final_status,
       l.customer_id is not null as has_customer,
       (select count(*) from public.business_events be
         where be.lead_id = l.id and be.event_type = 'won') as won_events,
       (select count(*) from public.contracts c where c.lead_id = l.id) as contracts
  from public.leads l
 where l.final_status = 'won'
   and (l.customer_id is null
        or not exists (select 1 from public.business_events be
                        where be.lead_id = l.id and be.event_type = 'won'))
 order by l.id;
\endif

-- ---------------------------------------------------------------------------
-- 6 · B7 — confirmed payments the credit backfill cannot attribute
-- ---------------------------------------------------------------------------
-- The migration backfills payments.credited_to from the contract's current
-- sales_id, which is right for every payment whose contract has not been
-- reassigned since — and is the best available answer for the rest, because the
-- reassignment destroyed the information. What it cannot do is invent a
-- salesperson for a contract that has none, so those payments keep a null
-- credit identity and every KPI figure derived from them stays unattributable.
-- Nothing breaks; the count is how much of the ledger will still not say who
-- collected it, and it is the one number here that a reviewer should see fall to
-- zero over time.
\echo ''
\echo '-- 6. confirmed unvoided payments whose contract carries no salesperson'
select count(*)                    as unattributable_payments,
       coalesce(sum(p.amount), 0)  as unattributable_amount,
       count(distinct p.contract_id) as contracts_affected
  from public.payments p
  join public.contracts c on c.id = p.contract_id
 where p.confirmed = true
   :voided_filter
   and c.sales_id is null;

\if :has_credited_to
\echo '   (payments.credited_to already exists: this database has had the migration)'
select count(*) as confirmed_without_credit_identity
  from public.payments p
 where p.confirmed = true :voided_filter and p.credited_to is null;
\endif

\if :{?detail}
select c.contract_no, count(*) as payments, sum(p.amount) as amount
  from public.payments p
  join public.contracts c on c.id = p.contract_id
 where p.confirmed = true
   :voided_filter
   and c.sales_id is null
 group by c.contract_no
 order by sum(p.amount) desc;
\endif

commit;

\echo ''
\echo '== preflight complete: section 1 total_blocking = 0 means the migration will apply =='
