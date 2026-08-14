-- ============================================================================
-- R4 · a conversion retry has to reach the state a conversion reaches
-- ============================================================================
-- NO_ROLLBACK: this file creates no object and writes no row. It redefines one
-- function in place; reverting it restores an already-converted branch that
-- reaches six of the nine writes the first conversion makes and silently leaves
-- the other three, while answering `success: true, already_converted: true`. There
-- is nothing to undo except that, and the manual revert — if it is ever needed —
-- is to re-apply 20260817130000_b5_conversion_retry_idempotence.sql §2, which is
-- the definition this file replaces.
--
-- 20260817130000 §2 (B5) made the already-converted branch refuse a retry that is
-- not a retry: a crossed link, a foreign lead, a different total, a terminated
-- contract, a missing or unequal schedule, a different schedule in the payload, a
-- different first payment date. All of that is about REFUSING. The other half —
-- what the branch does when the retry IS a retry — was never made equal to the
-- first conversion, and the route's own docstring is the claim that it is:
-- "Re-posting the same request now reaches the routine's idempotent branch, which
-- creates whatever is missing and reports it as `finalized`"
-- (src/app/api/quotations/[id]/convert/route.ts).
--
-- What the first conversion writes, in order:
--
--   1 contracts                      (only the first conversion; the retry has it)
--   2 installment_plans              (the retry compares instead — deliberate)
--   3 contract_approvals             (the retry creates if missing)
--   4 quotations.status + contract_id  ← the retry never wrote this
--   5 leads.final_status = 'won'       ← the retry never wrote this
--   6 finalize_lead_won()            (the retry calls it)
--   7 contracts.customer_id            ← the retry never wrote this
--   8 projects                       (the retry creates if missing)
--   9 activities                     (the retry creates if missing)
--
-- and the first conversion returns `project_id`, which the retry's return value
-- does not carry at all.
--
-- Each of 4, 5 and 7 is a reachable state, not a hypothetical:
--
--   4 · quotations.status. trg_guard_quotations_write refuses a direct write to
--       quotations.contract_id once the release is strict, and refuses nothing
--       else, so the quotation's own status stays client-writable —
--       src/app/(dashboard)/quotes/quotes-client.tsx:271 is one
--       `update quotations set status = <anything>` away from any quotation, and
--       the quotes list decides what a quotation offers from that column. Set a
--       converted quotation back to 'accepted', re-POST the conversion, and the
--       routine reports success: true, already_converted: true, and
--       quotation_status: 'accepted' — the route hands that string straight back to
--       the caller. The link says converted, the status says convertible, and the
--       retry that is supposed to finish the conversion walks past the
--       disagreement.
--
--   5 · leads.final_status. The first conversion sets it; the retry does not, so a
--       conversion repaired by a re-POST leaves a lead that has a contract, a
--       customer and a 'won' business event — finalize_lead_won() writes that
--       event on the retry path — and a final_status that never became 'won'.
--       Every won-count on the dashboard reads the column, not the event.
--
--   7 · contracts.customer_id. This is the exact state the retry exists for. The
--       reproduction recorded in 20260817000000 §10 is "a first attempt that failed
--       after the contract and before the customer", and the retry's own comment
--       says so; it then calls finalize_lead_won(), gets the customer, puts it on
--       the project row (`coalesce(v_customer_id, v_lead.customer_id)`) — and never
--       puts it on the contract. So the one column the failure left null is the one
--       column the repair does not fix, and contracts→customers stays unjoinable
--       for that contract for good.
--
-- Reproduced and repaired at apply time in §3 below, and in the replay's release
-- assertions as r4-*, both against a database carrying every migration of this
-- release. The measurements are in §3's comment.
--
-- The fix, and only this. The retry branch now, after every refusal B5 added has
-- passed:
--
--   * converges quotations.status to 'contract_created' when it is anything else,
--     reports 'quotation_status' in `finalized`, and returns the converged value
--     rather than the stale one;
--   * repairs leads.final_status when it is NULL — an unfinished conversion — and
--     REFUSES when it is some other terminal value. 'lost' with a live contract is
--     a disagreement between two decisions, not a conversion waiting to be
--     finished, and overruling it silently is the same class of defect as the one
--     this file closes. Same 22023 shape as B5's other refusals;
--   * back-fills contracts.customer_id with exactly the first conversion's
--     statement — `where id = … and customer_id is null` — so it repairs the null
--     and never overwrites a customer somebody else put there;
--   * returns project_id, from the row it created or the row that was already
--     there.
--
-- Nothing else in the body changes. The whole function is re-emitted because
-- PostgreSQL replaces a function body whole; this file is deliberately the last
-- definition of it, so `create or replace` here wins over 20260817130000.
--
-- Lock ORDER. The retry branch acquires a row lock on leads, which it did not
-- before, so the order is stated rather than assumed. Both branches now take
-- quotations → leads → contracts: the `select * into v_lead` at the top of the
-- routine is now `for update`, which is where the first conversion already took
-- that lock implicitly (its `update public.leads set final_status = 'won'` runs
-- before it touches its own contract row) and is before the retry branch's
-- `select * into v_contract … for update`. So the two branches cannot deadlock
-- against each other, two retries take the same three locks in the same order,
-- and finalize_lead_won()'s own `for update` on the same lead row is a no-op
-- re-acquisition. The first conversion never waits on a contracts row lock — the
-- row it locks is the one it just inserted, which no other session can see — so
-- there is no cycle in the other direction either.
--
-- Privileges: `create or replace function` preserves the ACL; the grants below are
-- the ones 20260817130000 already declares, restated for the case where this file
-- is ever applied to a database where the function is new.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · convert_quotation_to_contract — the retry finishes the conversion
-- ---------------------------------------------------------------------------
-- Body reproduced from 20260817130000 §2 with: `for update` on the lead read, two
-- declarations, and four blocks in the already-converted branch. Every guard that
-- file and 20260817000000 §10 added — the entry-time session assertion,
-- money_actor(), the ownership check, the crossed link / foreign lead / amount /
-- terminal status / missing schedule / unequal schedule / payload schedule /
-- payload first-payment-date refusals, the accepted-status and positive-total
-- checks, assert_installment_schedule() on the first conversion, the
-- contract-number retry loop, finalize_lead_won() on both branches — is present
-- unchanged.
--
-- Measured, not asserted: pg_get_functiondef() was captured on a database carrying
-- the release with this file withheld, this file was applied, and it was captured
-- again. The whole difference between the two installed bodies is: the two
-- declarations; `v_status := v_quote.status` after the quotation read; `for update`
-- on the lead read; the four blocks in the already-converted branch; and
-- `quotation_status` reading v_status plus the new `project_id` in that branch's
-- return. Every refusal, every guard and the entire first-conversion path are
-- byte-identical.
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
  v_disagree     bigint;
  v_status       text;
  v_lead_final   text;
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
  v_status := v_quote.status;

  -- R4: `for update`. Both branches write this row — the first conversion sets
  -- final_status, the retry repairs it — and taking the lock here is what makes
  -- the lock order quotations → leads → contracts on both paths. See the header.
  select * into v_lead from public.leads where id = v_quote.lead_id for update;

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

    -- B5, the other half of "this retry is not a retry". Everything above
    -- establishes that the stored state is self-consistent; none of it looks at
    -- the payload this call carries. A retry asking for a different schedule, or
    -- a different first payment date, is a different request wearing an
    -- already-converted quotation's id, and answering it with success: true is
    -- how a caller comes to believe a schedule it never got was written.
    --
    -- Only checked when the payload actually carries a schedule. A repair call
    -- and the release assertions reach this branch with '{}' deliberately, and
    -- "finish what the first attempt left" must stay callable without restating
    -- a schedule that is already in the table.
    if jsonb_typeof(p_payload -> 'installments') = 'array'
       and jsonb_array_length(p_payload -> 'installments') > 0 then
      -- Shape and total first, by the same validator the first conversion used,
      -- so a malformed retry is refused with 22023 naming the installment rather
      -- than with a bare cast error from the comparison below.
      perform public.assert_installment_schedule(
        p_payload -> 'installments', v_contract.contract_amount, 'quotation');

      select count(*) into v_disagree
        from (select coalesce(nullif(e.value ->> 'seq', '')::integer, e.ord::integer) as seq,
                     round((e.value ->> 'amount')::numeric(12, 2), 2)                as amount
                from jsonb_array_elements(p_payload -> 'installments')
                       with ordinality e(value, ord)) want
        full join (select seq, round(amount, 2) as amount
                     from public.installment_plans
                    where contract_id = v_contract.id) have on have.seq = want.seq
       where want.seq is null or have.seq is null
          or want.amount is distinct from have.amount;
      if v_disagree > 0 then
        raise exception 'quotation % is already converted to contract %, whose schedule is not the one this call asks for (% installment(s) disagree); a retry may only repeat the conversion it retries',
          v_quote.quote_no, v_contract.contract_no, v_disagree using errcode = '22023';
      end if;
    end if;

    if nullif(p_payload ->> 'first_payment_due_date', '') is not null
       and nullif(p_payload ->> 'first_payment_due_date', '')::date
           is distinct from v_contract.first_payment_due_date then
      raise exception 'quotation % is already converted to contract %, whose first payment is due % and not %; a retry may only repeat the conversion it retries',
        v_quote.quote_no, v_contract.contract_no,
        coalesce(v_contract.first_payment_due_date::text, 'unset'),
        nullif(p_payload ->> 'first_payment_due_date', '') using errcode = '22023';
    end if;

    v_contract_id := v_contract.id;
    v_contract_no := v_contract.contract_no;

    -- R4. Past every refusal, this call is a retry of this conversion, so the rest
    -- of this branch is the conversion's remaining work rather than a subset of it.
    -- The quotation's own status first, in the same order the first conversion
    -- writes it. The link is definer-only (trg_guard_quotations_write); the status
    -- beside it is not, so it can disagree with the link, and the caller was being
    -- handed that stale value as `quotation_status`.
    if v_status is distinct from 'contract_created' then
      update public.quotations
         set status = 'contract_created', updated_at = now()
       where id = p_quotation_id;
      v_status := 'contract_created';
      v_finalized := array_append(v_finalized, 'quotation_status');
    end if;

    if v_quote.lead_id is not null then
      -- The lead. NULL means the first attempt never got here, which is the state
      -- this branch exists to finish. Any other terminal value is a decision
      -- somebody made about this lead after it had a contract, and a retry does not
      -- get to overrule it silently: same 22023 as the refusals above.
      v_lead_final := v_lead.final_status;
      if v_lead_final is not null and v_lead_final <> 'won' then
        raise exception 'quotation % is converted to contract %, but its lead is marked % rather than won; a retry finishes a conversion, it does not overrule a terminal decision on the lead',
          v_quote.quote_no, v_contract_no, v_lead_final using errcode = '22023';
      end if;
      if v_lead_final is null then
        -- on_lead_won() fires and returns early, because the contract this branch
        -- is finishing already exists. finalize_lead_won() below is the call that
        -- does what the trigger declines to do, exactly as on the first path.
        update public.leads set final_status = 'won', updated_at = now()
         where id = v_quote.lead_id;
        v_finalized := array_append(v_finalized, 'lead_won');
      end if;

      -- B6, on the retry path too: a first attempt that failed after the contract
      -- and before the customer left exactly the state the reproduction found, and
      -- the retry is the only thing that will ever come back for it.
      v_customer_id := public.finalize_lead_won(
        v_quote.lead_id, coalesce(v_quote.total_amount, 0), v_actor, 'quotation_finalize',
        jsonb_build_object('quotation_id', v_quote.id, 'contract_id', v_contract_id,
                           'contract_no', v_contract_no));
      if v_customer_id is distinct from v_lead.customer_id then
        v_finalized := array_append(v_finalized, 'customer');
      end if;

      -- R4. The column the failure this branch repairs actually leaves null. Same
      -- statement as the first conversion's, `customer_id is null` included, so a
      -- customer somebody else put on the contract is never overwritten.
      if v_contract.customer_id is null and v_customer_id is not null then
        update public.contracts set customer_id = v_customer_id, updated_at = now()
         where id = v_contract_id and customer_id is null;
        v_finalized := array_append(v_finalized, 'contract_customer');
      end if;
    end if;

    if not exists (select 1 from public.contract_approvals
                    where contract_id = v_contract_id and step = 'admin_review') then
      -- 'quotation_finalize', not 'quotation': the provenance of an approval row
      -- created by a repair is not the provenance of one created by the conversion,
      -- and this row is the only place that difference is recorded.
      insert into public.contract_approvals (contract_id, step, status, notes)
      values (v_contract_id, 'admin_review', 'pending',
              jsonb_build_object('source', 'quotation_finalize', 'quotation_id', v_quote.id));
      v_finalized := array_append(v_finalized, 'approval');
    end if;

    if to_regclass('public.projects') is not null then
      -- R4: read it whether or not this call creates it, so the return value
      -- carries project_id on the retry path as it does on the first.
      select id into v_project_id from public.projects
       where contract_id = v_contract_id order by id asc limit 1;
      if v_project_id is null then
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
        )
        returning id into v_project_id;
        v_finalized := array_append(v_finalized, 'project');
      end if;
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
      'quotation_status',   v_status,
      'project_id',         v_project_id,
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

comment on function public.convert_quotation_to_contract(uuid, jsonb) is
  'Converts an accepted quotation into a draft contract, or finishes a conversion that already has one. The already-converted branch refuses anything that is not a retry of THIS conversion (crossed link, foreign lead, unequal total, terminated contract, missing or unequal schedule, a different schedule or first payment date in the payload) and otherwise reaches the same state a conversion reaches: quotations.status, leads.final_status, the customer, contracts.customer_id, the approval row, the project and the activity, with everything it had to write reported in ''finalized''. A lead carrying a terminal status other than ''won'' is refused rather than overruled.';

revoke all on function public.convert_quotation_to_contract(uuid, jsonb) from public, anon;
grant execute on function public.convert_quotation_to_contract(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2 · the A1 gate, re-checked
-- ---------------------------------------------------------------------------
-- One SECURITY DEFINER routine is redefined above. CREATE OR REPLACE replaces the
-- whole body, so a forgotten
-- `perform public.assert_current_session_at_entry();` would silently reopen A1.
-- Same query as 20260816000000 §5, 20260817000000 §16 and 20260817130000 §3.
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

-- ---------------------------------------------------------------------------
-- 3 · the three writes and the refusal, asserted at apply time
-- ---------------------------------------------------------------------------
-- Not a source assertion: it runs the routine, breaks the state the way a real
-- deployment breaks it, runs the retry, and reads the rows back. Rolled back, so
-- applying this migration writes no fixture rows.
--
-- Measured on PostgreSQL 17.10 (Debian 17.10-1.pgdg13+1) against the release with
-- only this file withheld — the schema floor, the other nineteen migrations of
-- this branch, supabase/replay/05_seed_behaviour_fixtures.sql, then the same
-- nineteen re-applied, which is the branch pipeline minus one file. A converted
-- 80000.00 quotation whose status was set back to 'accepted', whose lead's
-- final_status was cleared and whose contract's customer_id was nulled — the state
-- a status change plus a first attempt that died after the contract leaves:
--
--   the retry returned success: true, already_converted: true,
--   quotation_status: 'accepted', project_id: null, finalized: [] — and after it,
--   quotations.status was still 'accepted', leads.final_status was still null and
--   contracts.customer_id was still null. Nothing it repaired, and nothing it said
--   it had not. The block below, run verbatim against that database, stops on its
--   own first check: "the retry reported already_converted true, quotation_status
--   accepted and project_id null".
--
--   Then, with the lead set to 'lost', the same retry answered sqlstate 00000 —
--   success — and left the lead 'lost'. So the previous definition neither
--   finished the conversion nor declined to overrule the lead; it reported a
--   conversion that had not happened.
--
--   supabase/replay/10_assert_release_contracts.sql against that same database, in
--   collect mode, ends ASSERT_LEDGER total=341 passed=336 failed=5, with 0
--   ASSERT_UNMEASURABLE: the five failures are exactly the five r4-a-* assertions
--   and nothing else moves.
--
-- With this file applied, the same retry returns quotation_status:
-- 'contract_created', a non-null project_id and finalized containing
-- quotation_status, lead_won and contract_customer, and the three rows read back
-- converged. A lead set to 'lost' is then refused with 22023.
do $do$
declare
  v_lead      uuid := '00000000-4b4b-0000-0000-000000000001';
  v_quote     uuid := '00000000-4b4b-0000-0000-00000000000a';
  v_actor     uuid;
  v_first     jsonb;
  v_retry     jsonb;
  v_contract  uuid;
  v_qstatus   text;
  v_final     text;
  v_customer  uuid;
  v_state     text := '00000';
  v_msg       text := '';
begin
  -- Any identity the session boundary already accepts, exactly as 20260817130000
  -- §4 borrows one: the check is about the routine, so it must fail on the routine
  -- and never on the identity it had to borrow.
  select p.id into v_actor from public.profiles p
   where p.is_active is true
     and coalesce(p.role, '') in ('admin', 'boss')
     and exists (select 1 from auth.users u where u.id = p.id)
   order by p.created_at asc nulls last, p.id asc limit 1;
  if v_actor is null then
    raise notice 'R4 apply-time check skipped: no active admin/boss identity to borrow';
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated',
                      'iat', floor(extract(epoch from now()))::bigint)::text, true);
  if public.session_boundary_state() <> 'ok' then
    raise notice 'R4 apply-time check skipped: the borrowed identity is % at the session boundary',
      public.session_boundary_state();
    perform set_config('request.jwt.claims', '', true);
    return;
  end if;
  perform set_config('request.jwt.claims', '', true);

  begin
    insert into public.leads (id, assigned_to, stage, customer_name, source, quotation_value)
    values (v_lead, v_actor, 'new', 'R4 apply-time check', 'other', 80000.00);
    insert into public.quotations (id, lead_id, quote_no, status, subtotal, total_amount, created_by)
    values (v_quote, v_lead, 'R4-APPLY-CHECK', 'accepted', 80000.00, 80000.00, v_actor);

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor, 'role', 'authenticated',
                        'iat', floor(extract(epoch from now()))::bigint)::text, true);

    v_first := public.convert_quotation_to_contract(v_quote,
      jsonb_build_object('actor_id', v_actor, 'installments',
        jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 80000.00))));
    v_contract := (v_first ->> 'contract_id')::uuid;
    if v_contract is null or (v_first ->> 'project_id') is null then
      raise exception 'the first conversion returned contract_id % and project_id %',
        coalesce(v_first ->> 'contract_id', 'null'), coalesce(v_first ->> 'project_id', 'null')
        using errcode = '22000';
    end if;

    -- The state a real deployment reaches: the quotation's status is client
    -- writable beside a definer-only link, and a first attempt that died after the
    -- contract leaves the lead and the contract's customer untouched.
    perform set_config('request.jwt.claims', '', true);
    update public.quotations set status = 'accepted' where id = v_quote;
    update public.leads set final_status = null where id = v_lead;
    update public.contracts set customer_id = null where id = v_contract;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor, 'role', 'authenticated',
                        'iat', floor(extract(epoch from now()))::bigint)::text, true);

    -- The repair call: no schedule restated, which is the form the release
    -- assertions and an operator's re-POST both use.
    v_retry := public.convert_quotation_to_contract(v_quote,
      jsonb_build_object('actor_id', v_actor));
    perform set_config('request.jwt.claims', '', true);

    if (v_retry ->> 'already_converted') <> 'true'
       or (v_retry ->> 'quotation_status') <> 'contract_created'
       or (v_retry ->> 'project_id') is null then
      raise exception 'the retry reported already_converted %, quotation_status % and project_id %',
        coalesce(v_retry ->> 'already_converted', 'null'),
        coalesce(v_retry ->> 'quotation_status', 'null'),
        coalesce(v_retry ->> 'project_id', 'null') using errcode = '22000';
    end if;
    if not (v_retry -> 'finalized' @> '["quotation_status"]'::jsonb
            and v_retry -> 'finalized' @> '["lead_won"]'::jsonb
            and v_retry -> 'finalized' @> '["contract_customer"]'::jsonb) then
      raise exception 'the retry repaired three facts and reported finalized %',
        coalesce(v_retry ->> 'finalized', 'null') using errcode = '22000';
    end if;

    -- Read back, from the rows rather than from the return value.
    select status into v_qstatus from public.quotations where id = v_quote;
    select final_status into v_final from public.leads where id = v_lead;
    select customer_id into v_customer from public.contracts where id = v_contract;
    if v_qstatus <> 'contract_created' or v_final <> 'won' or v_customer is null
       or v_customer <> (v_retry ->> 'customer_id')::uuid then
      raise exception 'after the retry the rows read back status %, final_status % and customer_id %',
        coalesce(v_qstatus, 'null'), coalesce(v_final, 'null'), coalesce(v_customer::text, 'null')
        using errcode = '22000';
    end if;

    -- And the refusal: a lead given a different terminal decision is not a
    -- conversion waiting to be finished.
    update public.leads set final_status = 'lost' where id = v_lead;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor, 'role', 'authenticated',
                        'iat', floor(extract(epoch from now()))::bigint)::text, true);
    begin
      perform public.convert_quotation_to_contract(v_quote,
        jsonb_build_object('actor_id', v_actor));
      v_state := '00000';
    exception when others then
      v_state := sqlstate; v_msg := sqlerrm;
    end;
    perform set_config('request.jwt.claims', '', true);
    if v_state <> '22023' or v_msg not like '%rather than won%' then
      raise exception 'a retry against a lead marked lost was answered with sqlstate % (%)',
        v_state, left(v_msg, 140) using errcode = '22000';
    end if;

    raise exception 'R4_APPLY_CHECK_ROLLBACK';
  exception
    when others then
      perform set_config('request.jwt.claims', '', true);
      if sqlerrm <> 'R4_APPLY_CHECK_ROLLBACK' then raise; end if;
  end;
  raise notice 'R4: a retry converges the quotation status, the lead and the contract customer, reports them, returns project_id, and refuses a lead marked lost';
end
$do$;

commit;
