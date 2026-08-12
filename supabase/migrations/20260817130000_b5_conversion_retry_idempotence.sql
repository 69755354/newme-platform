-- ============================================================================
-- L0 round 4 · B5 — a conversion retry is a retry, not a second conversion
-- ============================================================================
-- NO_ROLLBACK: reverting this file restores a conversion retry that adds the
-- whole contract to customers.total_contract_amount again, and an
-- already-converted branch that answers a request for a different installment
-- schedule with success: true. Both are silent, both are money, and there is
-- nothing here to undo apart from them — the position 20260812000000,
-- 20260814000000, 20260816000000 and 20260817000000 already take.
--
-- Two defects, one routine pair, both reproduced on PostgreSQL 17.10 against a
-- database carrying every migration of this release, under BOTH release modes
-- (money_direct_write_mode() = 'compat' and 'strict' — identical results):
--
--   1. The idempotent branch of convert_quotation_to_contract() calls
--      finalize_lead_won() with the quotation total on every retry, and
--      finalize_lead_won() added that total to customers.total_contract_amount
--      unconditionally. One conversion of an 80000.00 quotation followed by two
--      identical retries left customers.total_contract_amount = 240000.00
--      (80000 → 160000 → 240000) while the routine returned
--      already_converted: true, finalized: [] and every other field unchanged.
--      This does not need an operator: two concurrent POSTs to
--      /api/quotations/[id]/convert reproduce it on their own. The second session
--      blocks on the quotation's FOR UPDATE, then takes the already-converted
--      branch, and one contract of 80000.00 ends with a customer carrying
--      160000.00 (measured in both modes).
--
--      The fix makes that amount once per lead-won rather than once per call, and
--      therefore also once per lead rather than once per contract: see the
--      comment in §1 and the measured 80000.00-vs-110000.00 difference for a lead
--      that is terminated and then won again.
--
--   2. The same branch validates the stored state thoroughly (crossed link,
--      foreign lead, amount, terminal status, missing schedule — all added by
--      20260817000000 §10) and does not look at p_payload at all. A retry
--      carrying installments of 1.00 + 2.00 + 3.00 against an 80000.00 quotation
--      returned success: true, already_converted: true, installments_count: 1 and
--      wrote nothing — the caller is told a schedule it never got was accepted.
--
-- Idempotent: both statements are CREATE OR REPLACE FUNCTION of a routine this
-- release already installs, and each reproduces the whole body from
-- 20260817000000 (§8 and §10) so nothing that file established is dropped. The
-- only differences from that text are the ones the two comments below mark.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1 · finalize_lead_won — the amount moves once per lead-won
-- ---------------------------------------------------------------------------
-- Body reproduced verbatim from 20260817000000 §8 with one declaration, one
-- pre-read of the 'won' marker, and the accumulation made conditional on it.
-- The customer upsert, the leads.customer_id write, the FOR UPDATE lock, the
-- entry-time session assertion, the once-per-lead event and the return value are
-- unchanged. Verified by diffing pg_get_functiondef() before and after.
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
  v_first_won   boolean;
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

  -- B5, the retry that charged twice. The amount is a lead-won fact, not a
  -- per-call one: the conversion's idempotent branch calls this function again on
  -- every retry, and the "customer already exists" arm below used to add
  -- p_amount unconditionally, so customers.total_contract_amount grew by the
  -- whole contract on each retry while the routine reported finalized = [].
  -- The marker is the once-per-lead 'won' event this function already owns, read
  -- here before it is written: the call that records the win is the call that
  -- moves the money, and there is exactly one of those per lead.
  --
  -- The consequence, measured rather than assumed: the amount is now once per
  -- lead-won, not once per contract. A lead whose first contract is taken to
  -- 'terminated' and which is then won again through a second accepted quotation
  -- ends with 80000.00 here where the unconditional version left 110000.00 —
  -- probed end to end through set_contract_status(), approve_contract() twice and
  -- a second convert_quotation_to_contract(). That is the same once-per-lead
  -- accounting as the 'won' event and as leads.final_status, and 110000.00 was
  -- not right either: it counts a terminated contract. Neither number is derived
  -- from public.contracts, which is the only thing that would make this column
  -- trustworthy, and that belongs with the derivation work on
  -- contracts.first_payment_status rather than in a retry fix.
  v_first_won := not exists (
    select 1 from public.business_events
     where lead_id = p_lead_id and event_type = 'won');

  if v_customer_id is not null then
    update public.customers
       set total_contract_amount = coalesce(total_contract_amount, 0)
                                   + case when v_first_won then coalesce(p_amount, 0) else 0 end,
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
  'The single owner of the lead-won side effects: customer upsert, leads.customer_id and the once-per-lead ''won'' business event, in the caller''s transaction and idempotent. The contract amount is added to customers.total_contract_amount only by the call that records the ''won'' event, so a conversion retry — including the loser of two concurrent conversions — does not add it a second time; the accounting is therefore once per lead-won, like the event itself, and not once per contract.';

-- CREATE OR REPLACE keeps the existing ACL, but this file must not be the way an
-- end-user role acquires it if it is ever applied to a database where the
-- function is new.
revoke all on function public.finalize_lead_won(uuid, numeric, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_lead_won(uuid, numeric, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2 · convert_quotation_to_contract — the retry must match the first call
-- ---------------------------------------------------------------------------
-- Body reproduced verbatim from 20260817000000 §10 with one declaration and one
-- block added to the already-converted branch. Every guard that file added — the
-- entry-time session assertion, money_actor(), the ownership check, the crossed
-- link / foreign lead / amount / terminal status / missing schedule refusals, the
-- accepted-status and positive-total checks, assert_installment_schedule() on the
-- first conversion, the contract-number retry loop, finalize_lead_won() on both
-- branches — is present unchanged. Verified by diffing pg_get_functiondef()
-- before and after.
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

revoke all on function public.convert_quotation_to_contract(uuid, jsonb) from public, anon;
grant execute on function public.convert_quotation_to_contract(uuid, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3 · the A1 gate, re-checked
-- ---------------------------------------------------------------------------
-- Two SECURITY DEFINER routines are redefined above. CREATE OR REPLACE replaces
-- the whole body, so a forgotten
-- `perform public.assert_current_session_at_entry();` would silently reopen A1.
-- Same query as 20260816000000 §5 and 20260817000000 §16.
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
-- 4 · the two facts this file exists for, asserted at apply time
-- ---------------------------------------------------------------------------
-- Neither is a source assertion: both run the routines. Rolled back, so applying
-- this migration writes no fixture rows.
do $do$
declare
  v_lead     uuid := '00000000-b5b5-0000-0000-000000000001';
  v_quote    uuid := '00000000-b5b5-0000-0000-00000000000a';
  v_actor    uuid;
  v_total    numeric(12, 2);
  v_state    text := '00000';
  v_msg      text := '';
begin
  -- Any identity the session boundary already accepts. The check is about the two
  -- routines, so it fails on them and never on the identity it had to borrow:
  -- if this database has nobody the boundary accepts, it says so and returns.
  select p.id into v_actor from public.profiles p
   where p.is_active is true
     and coalesce(p.role, '') in ('admin', 'boss')
     and exists (select 1 from auth.users u where u.id = p.id)
   order by p.created_at asc nulls last, p.id asc limit 1;
  if v_actor is null then
    raise notice 'B5 apply-time check skipped: no active admin/boss identity to borrow';
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor, 'role', 'authenticated',
                      'iat', floor(extract(epoch from now()))::bigint)::text, true);
  if public.session_boundary_state() <> 'ok' then
    raise notice 'B5 apply-time check skipped: the borrowed identity is % at the session boundary',
      public.session_boundary_state();
    perform set_config('request.jwt.claims', '', true);
    return;
  end if;
  perform set_config('request.jwt.claims', '', true);

  begin
    insert into public.leads (id, assigned_to, stage, customer_name, quotation_value)
    values (v_lead, v_actor, 'new', 'B5 apply-time check', 80000.00);
    insert into public.quotations (id, lead_id, quote_no, status, subtotal, total_amount, created_by)
    values (v_quote, v_lead, 'B5-APPLY-CHECK', 'accepted', 80000.00, 80000.00, v_actor);

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_actor, 'role', 'authenticated',
                        'iat', floor(extract(epoch from now()))::bigint)::text, true);

    perform public.convert_quotation_to_contract(v_quote,
      jsonb_build_object('actor_id', v_actor, 'installments',
        jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 80000.00))));
    -- the exact retry: same arguments, twice more
    perform public.convert_quotation_to_contract(v_quote,
      jsonb_build_object('actor_id', v_actor, 'installments',
        jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 80000.00))));
    perform public.convert_quotation_to_contract(v_quote,
      jsonb_build_object('actor_id', v_actor, 'installments',
        jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 80000.00))));

    select coalesce(sum(total_contract_amount), -1) into v_total
      from public.customers where lead_id = v_lead;
    if v_total <> 80000.00 then
      raise exception 'a conversion of 80000.00 plus two identical retries left customers.total_contract_amount at %',
        to_char(v_total, 'FM999999999990.00') using errcode = '22000';
    end if;

    begin
      perform public.convert_quotation_to_contract(v_quote,
        jsonb_build_object('actor_id', v_actor, 'installments',
          jsonb_build_array(jsonb_build_object('seq', 1, 'amount', 40000.00),
                            jsonb_build_object('seq', 2, 'amount', 40000.00))));
      v_state := '00000';
    exception when others then
      v_state := sqlstate; v_msg := sqlerrm;
    end;
    if v_state <> '22023' or v_msg not like '%disagree%' then
      raise exception 'a retry asking for a different schedule was answered with sqlstate % (%)',
        v_state, left(v_msg, 120) using errcode = '22000';
    end if;

    perform set_config('request.jwt.claims', '', true);
    raise exception 'B5_APPLY_CHECK_ROLLBACK';
  exception
    when others then
      perform set_config('request.jwt.claims', '', true);
      if sqlerrm <> 'B5_APPLY_CHECK_ROLLBACK' then raise; end if;
  end;
  raise notice 'B5: one conversion plus two identical retries move the amount once, and a mismatched retry is refused';
end
$do$;

commit;
