-- ===========================================================================
-- L0 round 4 · B4 residual — an installment schedule has to be numbered 1..N
-- ===========================================================================
-- NO_ROLLBACK: this file adds one assertion to one validator and does nothing
-- else. Reverting it restores a create_contract() and a
-- convert_quotation_to_contract() that accept a schedule numbered 1,3 — a
-- contract whose second installment does not exist and which nothing downstream
-- can tell apart from a two-installment contract. It writes no data, adds no
-- constraint and takes no privilege away, so there is nothing for a rollback to
-- undo except the refusal itself.
--
-- Version note: stamped 20260817140000, below the contract phase
-- 20260818000000_money_direct_write_contract_phase.sql. The expand/contract
-- procedure applies the expand phase as a contiguous prefix of the pending set
-- and the contract phase alone afterwards, so every expand-phase file has to
-- sort before the contract phase; tests/release/expand-contract-rollback-contract.test.mjs
-- enforces that. It lands after 20260817130000_b5_conversion_retry_idempotence.sql
-- and redefines assert_installment_schedule() from 20260817000000 §7.
--
-- 20260817000000_l0_round4_money_and_business_integrity.sql §7 introduced
-- public.assert_installment_schedule() and closed most of B4: the schedule must
-- be a non-empty array, every amount must be positive, every seq must be
-- positive and appear at most once, a supplied due_date must be a real date, and
-- the amounts must total the subject exactly to the cent. create_contract() and
-- convert_quotation_to_contract() both call it before their first write.
--
-- What it does NOT establish is that the positions describe installment 1 to
-- installment N. Unique and positive is a weaker property than contiguous from
-- one, and the difference is a whole missing installment. Reproduced against the
-- release state on an isolated PG17 (floor schema + the 14 branch migrations +
-- 05_seed_behaviour_fixtures.sql), acting as `authenticated` with the claim shape
-- GoTrue issues, in BOTH release modes — create_contract() is SECURITY DEFINER,
-- so money_release_mode makes no difference to any of it:
--
--   installments [{seq:1,60},{seq:3,40}]     compat 00000 / strict 00000
--                                            → contract 100.00, 2 plans, seqs {1,3}
--   installments [{seq:2,100}]               compat 00000 / strict 00000
--                                            → contract 100.00, 1 plan,  seqs {2}
--   installments [{seq:1,50},{seq:9999,50}]  compat 00000 / strict 00000
--                                            → contract 100.00, 2 plans, seqs {1,9999}
--
-- Each of those totals correctly and each was accepted. A schedule numbered
-- {1,3} is not a two-installment contract with an odd label; it is a contract
-- whose second installment is missing, and every reader downstream has to guess
-- which reading was meant. src/app/api/contracts/route.ts takes `seq` straight
-- from the request body (`Number.isFinite(inst?.seq) ? Number(inst.seq) : index+1`)
-- and checks the same four things the validator did, so any authenticated session
-- could post one; the browser form never can, because it always emits `seq: i+1`.
--
-- N distinct integers, each >= 1, are exactly {1..N} if and only if their maximum
-- is N. That is the whole check, and it needs nothing the validator was not
-- already collecting.
--
-- Forward-only and idempotent: one CREATE OR REPLACE of a single function whose
-- body is reproduced in full from 20260817000000 §7 with the new assertion added,
-- plus a read-only scan. It deliberately redefines nothing else — a partial
-- redefinition of create_contract() or of the conversion would silently revert
-- the round-4 guards those bodies carry, and neither needs to change: both call
-- this validator by name.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1 · Existing rows — what the tightened rule would have refused
-- ---------------------------------------------------------------------------
-- Report-only, on purpose. No CHECK constraint and no NOT VALID constraint is
-- added here: the invariant spans the rows of one contract rather than a single
-- row, so it is not expressible as a column CHECK, and refusing to migrate over
-- historical gaps would block the fix that stops new ones. Counts only — this
-- runs in CI logs and must not print contract numbers or party names.
do $$
declare
  v_contracts bigint;
  v_worst     integer;
begin
  select count(*), coalesce(max(gap), 0)
    into v_contracts, v_worst
    from (
      select contract_id, max(seq) - count(*)::integer as gap
        from public.installment_plans
       group by contract_id
      having max(seq) <> count(*)::integer
    ) s;

  raise notice 'B4 residual scan: % contract(s) already hold a schedule that is not numbered 1..N (largest gap between max(seq) and the installment count: %)',
    v_contracts, v_worst;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · The validator, with the contiguity assertion
-- ---------------------------------------------------------------------------
-- Same signature, so create_contract() and convert_quotation_to_contract() pick
-- it up without being touched. SECURITY INVOKER and IMMUTABLE as before: pure
-- validation over its arguments, touching no table.
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

  -- The positions must be 1..v_count with no gaps. Every seq above is distinct
  -- and >= 1, so v_count of them are exactly {1..v_count} precisely when the
  -- largest is v_count; anything else is a schedule that skips an installment or
  -- does not begin at the first one. Checked before the total, because a schedule
  -- numbered {1,3} that happens to add up is still the wrong schedule and the
  -- number it is missing is the more useful thing to say.
  if (select max(s) from unnest(v_seqs) as s) <> v_count then
    raise exception 'the installment schedule must be numbered 1..% with no gaps, but it is numbered %',
      v_count,
      (select string_agg(s::text, ',' order by s) from unnest(v_seqs) as s)
      using errcode = '22023';
  end if;

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
  'Validates an installment schedule payload: non-empty, every amount positive, seq numbered exactly 1..N with no gaps or duplicates, any supplied due_date a real date, and the total exactly equal to the subject total after rounding to two decimals. Raises 22023 naming the offending installment. Used by create_contract() and convert_quotation_to_contract().';

-- Privileges restated rather than assumed: this file is applied on its own in
-- the phase tooling, and a CREATE OR REPLACE keeps the existing ACL, so these are
-- here to make the intended grant readable at the point of definition.
revoke all on function public.assert_installment_schedule(jsonb, numeric, text) from public, anon;
grant execute on function public.assert_installment_schedule(jsonb, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3 · Self-check
-- ---------------------------------------------------------------------------
-- The migration proves its own effect before it commits, so an apply that
-- silently landed the old body cannot pass. Both cases are pure argument
-- validation; nothing is written.
do $$
declare
  v_state text;
begin
  begin
    perform public.assert_installment_schedule(
      '[{"seq":1,"amount":60},{"seq":3,"amount":40}]'::jsonb, 100, 'contract');
    v_state := '00000';
  exception when others then
    v_state := sqlstate;
  end;
  if v_state <> '22023' then
    raise exception 'assert_installment_schedule() still accepts a schedule numbered 1,3 (sqlstate %)', v_state;
  end if;

  if public.assert_installment_schedule(
       '[{"seq":1,"amount":40},{"seq":2,"amount":30},{"seq":3,"amount":30}]'::jsonb, 100, 'contract') <> 3 then
    raise exception 'assert_installment_schedule() no longer accepts a valid 1..3 schedule';
  end if;

  raise notice 'B4 residual: installment schedules must now be numbered 1..N';
end $$;
