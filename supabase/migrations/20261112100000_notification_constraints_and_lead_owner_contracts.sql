-- NO_ROLLBACK: widens two CHECK constraints (every old value is kept; a guard refuses the file if production allows a value this list lacks) and redefines one routine; no row is changed and nothing it drops holds data. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S16 - next database batch (fixes/NEXT-DB-BATCH.md)
-- ============================================================================
-- 1. notifications_type_check also allows 'contract_created' (the create-contract
--    API sends it), 'reminder' (the daily task reminder writes it) and 'warning'
--    (the no-answer cron's "3 unanswered calls" alert; it was refused with 23514 and the
--    error swallowed, so the alert never arrived).
-- 2. notifications_related_type_check also allows 'task' (the daily reminder
--    points at a task) and 'digest' (the daily follow-up summary).
--    Before this file every such insert failed with SQLSTATE 23514 and the cron
--    swallowed the error, so those notifications never existed.
--    Written drop-then-add, so the file can be applied again. The guard in the
--    DO block raises (and the file is rolled back) if the constraint currently
--    allows any value that the new list does not, so a value production already
--    accepts can never be dropped silently.
-- 3. convert_quotation_to_contract(): contracts.sales_id is now the LEAD's owner
--    (leads.assigned_to). It used to be the quotation's creator, so when an admin
--    or operator built the quotation for a salesperson's lead, the salesperson
--    could not submit the contract for approval (set_contract_status checks
--    sales_id) and could not see it in the contract list. Order of preference:
--    the lead's owner, then the quotation's creator, then the acting user, so a
--    lead without an owner behaves exactly as before. Contracts that already
--    exist are not touched (the retry branch finishes a conversion, it does not
--    re-assign). The routine stays SECURITY DEFINER with a pinned search_path;
--    grants are unchanged (create or replace keeps them).
-- Session checks in policies must be written (select public.session_token_is_current());
-- this file adds no policy.

-- The phase tool and the replay harness each wrap a file in one transaction, so this file
-- carries no begin/commit of its own (set local below lasts for that transaction).
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1 + 2. notification constraints
-- ---------------------------------------------------------------------------
do $guard$
declare
  v_type_allowed constant text[] := array[
    'lead_created', 'lead_stage_change', 'lead_stage_changed', 'lead_assigned',
    'quote_created', 'followup_reminder', 'follow_up_reminder', 'follow_up_overdue',
    'contract_signed', 'contract_rejected', 'contract_superseded', 'contract_approved',
    'contract_pending_approval', 'payment_received', 'payment_overdue', 'payment_due',
    'first_payment_reminder', 'kpi_target_set', 'team_member_added',
    'contract_created', 'reminder', 'warning'];
  v_related_allowed constant text[] := array[
    'lead', 'contract', 'payment', 'kpi', 'quote', 'task', 'digest'];
  v_def     text;
  v_missing text[];
begin
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.notifications'::regclass and conname = 'notifications_type_check';
  if v_def is not null then
    select array_agg(m[1]) into v_missing
      from regexp_matches(v_def, '''([^'']+)''::character varying', 'g') as m
     where m[1] <> all (v_type_allowed);
    if v_missing is not null then
      raise exception 'notifications_type_check currently allows values this migration would drop: %', v_missing;
    end if;
  end if;

  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.notifications'::regclass and conname = 'notifications_related_type_check';
  if v_def is not null then
    select array_agg(m[1]) into v_missing
      from regexp_matches(v_def, '''([^'']+)''::character varying', 'g') as m
     where m[1] <> all (v_related_allowed);
    if v_missing is not null then
      raise exception 'notifications_related_type_check currently allows values this migration would drop: %', v_missing;
    end if;
  end if;
end
$guard$;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (
  type::text = any (array[
    'lead_created'::character varying, 'lead_stage_change'::character varying,
    'lead_stage_changed'::character varying, 'lead_assigned'::character varying,
    'quote_created'::character varying, 'followup_reminder'::character varying,
    'follow_up_reminder'::character varying, 'follow_up_overdue'::character varying,
    'contract_signed'::character varying, 'contract_rejected'::character varying,
    'contract_superseded'::character varying, 'contract_approved'::character varying,
    'contract_pending_approval'::character varying, 'payment_received'::character varying,
    'payment_overdue'::character varying, 'payment_due'::character varying,
    'first_payment_reminder'::character varying, 'kpi_target_set'::character varying,
    'team_member_added'::character varying, 'contract_created'::character varying,
    'reminder'::character varying, 'warning'::character varying]::text[]));

alter table public.notifications drop constraint if exists notifications_related_type_check;
alter table public.notifications add constraint notifications_related_type_check check (
  related_type is null or related_type::text = any (array[
    'lead'::character varying, 'contract'::character varying, 'payment'::character varying,
    'kpi'::character varying, 'quote'::character varying, 'task'::character varying,
    'digest'::character varying]::text[]));

-- ---------------------------------------------------------------------------
-- 3. convert_quotation_to_contract(): the contract belongs to the lead's owner
-- ---------------------------------------------------------------------------
create or replace function public.convert_quotation_to_contract(p_quotation_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
returns jsonb
 language plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
as $function$
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
    array['admin', 'boss', 'operator', 'sales']);
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

  -- Sam: a salesperson converts quotations on the leads assigned to them; admin,
  -- boss and operator on any lead. (Finance and designer are refused above.)
  if v_actor_role not in ('admin', 'boss', 'operator')
     and v_lead.assigned_to is distinct from v_actor then
    raise exception 'only the assigned salesperson or a manager may convert a quotation on this lead' using errcode = '42501';
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
                     round((e.value ->> 'amount')::numeric(12, 2), 2)                as amount,
                     coalesce(nullif(e.value ->> 'due_date', '')::date,
                              v_contract.contract_date)                              as due_date,
                     coalesce(e.value ->> 'description', '')                         as description
                from jsonb_array_elements(p_payload -> 'installments')
                       with ordinality e(value, ord)) want
        full join (select seq, round(amount, 2) as amount, due_date,
                          coalesce(description, '') as description
                     from public.installment_plans
                    where contract_id = v_contract.id) have on have.seq = want.seq
       where want.seq is null or have.seq is null
          or want.amount is distinct from have.amount
          or want.due_date is distinct from have.due_date
          or want.description is distinct from have.description;
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
      -- A retry finishes the conversion; it never wins the lead (that happens when
      -- the contract is activated) and it does not overrule a lost lead.
      v_lead_final := v_lead.final_status;
      if v_lead_final = 'lost' then
        raise exception 'quotation % is converted to contract %, but its lead is marked lost; a retry finishes a conversion, it does not overrule a terminal decision on the lead',
          v_quote.quote_no, v_contract_no using errcode = '22023';
      end if;
      if public.advance_lead_to_pending_decision(v_quote.lead_id, v_actor,
           'Quotation ' || coalesce(v_quote.quote_no, '') || ' converted to contract ' || v_contract_no) then
        v_finalized := array_append(v_finalized, 'lead_stage');
      end if;
      v_customer_id := v_lead.customer_id;
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
      -- Read only: the project belongs to contract activation now.
      select id into v_project_id from public.projects
       where contract_id = v_contract_id order by id asc limit 1;
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
        v_quote.lead_id, v_quote.id, coalesce(v_lead.assigned_to, v_quote.created_by, v_actor), v_actor,
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
    -- S2: converting does not win the lead. It moves to pending_decision and the
    -- win (customer, project, won event) happens when the contract is activated.
    perform public.advance_lead_to_pending_decision(v_quote.lead_id, v_actor,
      'Quotation ' || coalesce(v_quote.quote_no, '') || ' converted to contract ' || v_contract_no);
  end if;

  -- no project yet: it is created when the contract is activated

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
$function$;

-- ---------------------------------------------------------------------------
-- Manual undo (not part of the release flow; production changes go through the gate)
-- ---------------------------------------------------------------------------
-- Constraints: drop both and add them back with the previous value lists, which
-- are the lists in supabase/replay/production-schema-baseline.sql
-- (notifications_type_check without 'contract_created', 'reminder' and 'warning';
-- notifications_related_type_check without 'task' and 'digest'). Delete any
-- notification row that uses a removed value first, or the add fails.
-- Routine: re-create convert_quotation_to_contract(uuid, jsonb) from
-- 20261104110000_role_least_privilege.sql section 6 (sales_id from the
-- quotation's creator).
