-- Quote allocation and lead-unassignment integrity.
--
-- 1. Quote numbers are allocated by a sequence inside the INSERT transaction.
--    The previous max()+1 RPC ran in a transaction separate from INSERT, so two
--    callers could receive the same number and a malformed stored suffix could
--    make every later call fail while casting text to integer.
-- 2. Reassignment now requires the compare-and-set token at the database entry
--    point. The application already supplied it, but an authenticated direct RPC
--    call could pass NULL and bypass the comparison.
-- 3. Unassignment is a dedicated atomic, idempotent and audited operation rather
--    than a direct PostgREST update with no durable request/audit record.
--
-- NO_ROLLBACK: These are forward-only integrity boundaries. Removing the quote
-- allocator would re-open duplicate allocation, and removing either lead RPC
-- would re-open unaudited/lost assignment writes. Application rollback remains
-- compatible with the functions and trigger being present.

begin;

-- ---------------------------------------------------------------------------
-- Quote numbers: sequence-backed and assigned by the row INSERT itself.
-- ---------------------------------------------------------------------------
-- Block INSERT/UPDATE/DELETE while the sequence floor is derived. Without this,
-- an insert that commits after max() is read can put a number above the floor and
-- the first generated number can collide with it. The lock is held until the
-- trigger is installed and the migration commits.
lock table public.quotations in share row exclusive mode;

create sequence if not exists public.quotation_number_seq
  as bigint increment by 1 minvalue 1 no maxvalue cache 1 no cycle;
revoke all on sequence public.quotation_number_seq from public, anon, authenticated, service_role;

do $do$
declare
  v_last bigint;
  v_called boolean;
  v_max_suffix bigint;
  v_floor bigint;
  v_next bigint;
begin
  select last_value, is_called into v_last, v_called
    from public.quotation_number_seq;

  -- A 19-digit suffix may still fit bigint. Compare it as text before casting so
  -- valid values through bigint's maximum participate in the floor, while a
  -- longer or out-of-range historical poison value cannot abort initialization.
  select max(s.suffix::bigint)
    into v_max_suffix
    from (
      select (pg_catalog.regexp_match(q.quote_no, '^NM-[0-9]{4}-([0-9]{1,19})$'))[1] as suffix
        from public.quotations q
       where q.quote_no ~ '^NM-[0-9]{4}-[0-9]{1,19}$'
    ) s
   where pg_catalog.length(s.suffix) < 19
      or s.suffix <= '9223372036854775807';

  if v_max_suffix = 9223372036854775807 then
    raise exception 'QUOTE_NUMBER_SEQUENCE_EXHAUSTED';
  end if;
  v_floor := coalesce(v_max_suffix, 0) + 1;

  v_next := greatest(case when v_called then v_last + 1 else v_last end, v_floor, 1);
  perform pg_catalog.setval('public.quotation_number_seq'::regclass, v_next, false);
end
$do$;

create or replace function public.allocate_quote_no()
returns text
language sql
volatile
security invoker
set search_path = ''
as $fn$
  select 'NM-' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || '-' ||
         case
           when s.n < 10000 then pg_catalog.lpad(s.n::text, 4, '0')
           else s.n::text
         end
    from (select pg_catalog.nextval('public.quotation_number_seq'::regclass) as n) s
$fn$;

revoke all on function public.allocate_quote_no() from public, anon, authenticated, service_role;

create or replace function public.next_quote_no()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  perform public.assert_current_session_at_entry();
  return public.allocate_quote_no();
end
$fn$;

revoke all on function public.next_quote_no() from public, anon, authenticated, service_role;
grant execute on function public.next_quote_no() to authenticated, service_role;

create or replace function public.quotations_assign_quote_no()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    new.quote_no := public.allocate_quote_no();
  elsif new.quote_no is distinct from old.quote_no then
    raise exception 'QUOTE_NUMBER_IS_DATABASE_OWNED';
  end if;
  return new;
end
$fn$;

revoke all on function public.quotations_assign_quote_no() from public, anon, authenticated, service_role;

drop trigger if exists aa_quotations_assign_quote_no on public.quotations;
create trigger aa_quotations_assign_quote_no
  before insert or update on public.quotations
  for each row execute function public.quotations_assign_quote_no();

-- ---------------------------------------------------------------------------
-- The existing reassignment routine: make its CAS token mandatory and bind an
-- idempotency replay to the same lead and requested assignee.
-- ---------------------------------------------------------------------------
create or replace function public.reassign_lead_atomic(
  p_lead_id uuid,
  p_new_assignee uuid,
  p_expected_updated_at timestamptz,
  p_idempotency_key uuid,
  p_reason text default 'manual_reassign'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_target_role text;
  v_target_active boolean;
  v_request_lead_id uuid;
  v_lead public.leads%rowtype;
  v_response jsonb;
  v_reason text := pg_catalog.left(
    coalesce(
      nullif(pg_catalog.btrim(p_reason), ''),
      'manual_reassign'
    ),
    500
  );
begin
  perform public.assert_current_session_at_entry();
  -- The assertion above must remain the first executable statement. It guards
  -- early idempotent returns as well as writes.
  v_actor_id := auth.uid();

  if v_actor_id is null then raise exception 'UNAUTHORIZED'; end if;
  if p_expected_updated_at is null then raise exception 'MISSING_EXPECTED_UPDATED_AT'; end if;
  if p_idempotency_key is null then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;

  select p.role into v_actor_role
    from public.profiles p
   where p.id = v_actor_id;
  if coalesce(v_actor_role, '') not in ('admin', 'boss', 'operator') then
    raise exception 'FORBIDDEN_REASSIGNMENT';
  end if;

  -- Same actor/operation/key requests serialize before the lookup. The second
  -- concurrent caller therefore observes the first committed response instead
  -- of racing into a unique violation or a stale-token error.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'lead_reassignment:' || v_actor_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select r.lead_id, r.response into v_request_lead_id, v_response
    from public.lead_mutation_requests r
   where r.actor_id = v_actor_id
     and r.operation = 'lead_reassignment'
     and r.idempotency_key = p_idempotency_key;
  if found then
    if v_request_lead_id is distinct from p_lead_id
       or v_response ->> 'lead_id' is distinct from p_lead_id::text
       or v_response ->> 'assigned_to' is distinct from p_new_assignee::text
       or (v_response ? 'request_reason'
           and v_response ->> 'request_reason' is distinct from v_reason) then
      raise exception 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_REQUEST';
    end if;
    return v_response || pg_catalog.jsonb_build_object('idempotent_replay', true);
  end if;

  select p.role, p.is_active into v_target_role, v_target_active
    from public.profiles p
   where p.id = p_new_assignee;
  if not found
     or coalesce(v_target_active, false) = false
     or coalesce(v_target_role, '') not in ('sales', 'operator', 'boss') then
    raise exception 'INVALID_ASSIGNEE';
  end if;

  select * into v_lead
    from public.leads l
   where l.id = p_lead_id
   for update;
  if not found then raise exception 'LEAD_NOT_FOUND'; end if;
  if v_lead.updated_at is distinct from p_expected_updated_at then
    raise exception 'CONCURRENT_LEAD_UPDATE';
  end if;

  if v_lead.assigned_to is not distinct from p_new_assignee then
    v_response := pg_catalog.jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'updated_at', v_lead.updated_at,
      'unchanged', true,
      'request_reason', v_reason
    );
  else
    update public.leads
       set assigned_to = p_new_assignee,
           transfer_candidate = false,
           recovery_candidate = false,
           hold_since = null,
           updated_at = pg_catalog.now()
     where id = p_lead_id;

    insert into public.transfer_history (
      lead_id, from_user_id, to_user_id, reason, transferred_by
    ) values (
      p_lead_id, v_lead.assigned_to, p_new_assignee, v_reason, v_actor_id
    );

    insert into public.activities (lead_id, user_id, type, content)
    values (
      p_lead_id, v_actor_id, 'transfer',
      pg_catalog.format(
        'Lead reassigned from %s to %s',
        coalesce(v_lead.assigned_to::text, 'unassigned'),
        p_new_assignee::text
      )
    );

    insert into public.business_events (
      lead_id, user_id, event_type, description, event_data
    ) values (
      p_lead_id, v_actor_id, 'transfer', 'Lead reassigned',
      pg_catalog.jsonb_build_object(
        'from_user_id', v_lead.assigned_to,
        'to_user_id', p_new_assignee,
        'reason', v_reason
      )
    );

    insert into public.notifications (
      user_id, type, title, body, related_id, related_type
    ) values (
      p_new_assignee, 'lead_assigned', 'Lead assigned',
      coalesce(v_lead.customer_name, 'Lead') || ' was assigned to you.',
      p_lead_id, 'lead'
    );

    v_response := pg_catalog.jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'updated_at', (select l.updated_at from public.leads l where l.id = p_lead_id),
      'unchanged', false,
      'request_reason', v_reason
    );
  end if;

  insert into public.lead_mutation_requests (
    actor_id, operation, idempotency_key, lead_id, response
  ) values (
    v_actor_id, 'lead_reassignment', p_idempotency_key, p_lead_id, v_response
  );

  return v_response;
end
$fn$;

revoke all on function public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Atomic audited unassignment. transfer_history.to_user_id is NOT NULL, so an
-- unassignment is recorded in the general audit/event ledgers instead of forging
-- a transfer row with an impossible target.
-- ---------------------------------------------------------------------------
create or replace function public.unassign_lead_atomic(
  p_lead_id uuid,
  p_expected_updated_at timestamptz,
  p_idempotency_key uuid,
  p_reason text default 'manual_unassign'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_request_lead_id uuid;
  v_lead public.leads%rowtype;
  v_response jsonb;
  v_reason text := pg_catalog.left(
    coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'manual_unassign'),
    500
  );
begin
  perform public.assert_current_session_at_entry();
  -- The assertion above is deliberately first, including for replay returns.
  v_actor_id := auth.uid();
  if v_actor_id is null then raise exception 'UNAUTHORIZED'; end if;
  if p_expected_updated_at is null then raise exception 'MISSING_EXPECTED_UPDATED_AT'; end if;
  if p_idempotency_key is null then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;

  select p.role into v_actor_role from public.profiles p where p.id = v_actor_id;
  if coalesce(v_actor_role, '') not in ('admin', 'boss', 'operator') then
    raise exception 'FORBIDDEN_UNASSIGNMENT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'lead_unassignment:' || v_actor_id::text || ':' || p_idempotency_key::text,
      0
    )
  );

  select r.lead_id, r.response into v_request_lead_id, v_response
    from public.lead_mutation_requests r
   where r.actor_id = v_actor_id
     and r.operation = 'lead_unassignment'
     and r.idempotency_key = p_idempotency_key;
  if found then
    if v_request_lead_id is distinct from p_lead_id
       or v_response ->> 'lead_id' is distinct from p_lead_id::text
       or not (v_response ? 'assigned_to')
       or v_response -> 'assigned_to' is distinct from 'null'::jsonb
       or v_response ->> 'request_reason' is distinct from v_reason then
      raise exception 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_REQUEST';
    end if;
    return v_response || pg_catalog.jsonb_build_object('idempotent_replay', true);
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then raise exception 'LEAD_NOT_FOUND'; end if;
  if v_lead.updated_at is distinct from p_expected_updated_at then
    raise exception 'CONCURRENT_LEAD_UPDATE';
  end if;

  if v_lead.assigned_to is null then
    v_response := pg_catalog.jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', null,
      'updated_at', v_lead.updated_at,
      'unchanged', true,
      'request_reason', v_reason
    );
  else
    update public.leads
       set assigned_to = null,
           transfer_candidate = false,
           recovery_candidate = false,
           hold_since = null,
           updated_at = pg_catalog.now()
     where id = p_lead_id;

    insert into public.activities (lead_id, user_id, type, content)
    values (
      p_lead_id, v_actor_id, 'transfer',
      pg_catalog.format('Lead unassigned from %s', v_lead.assigned_to::text)
    );

    insert into public.business_events (lead_id, user_id, event_type, description, event_data)
    values (
      p_lead_id, v_actor_id, 'transfer', 'Lead unassigned',
      pg_catalog.jsonb_build_object(
        'from_user_id', v_lead.assigned_to,
        'to_user_id', null,
        'reason', v_reason
      )
    );

    insert into public.audit_logs (actor_id, action, target_type, target_id, details)
    values (
      v_actor_id, 'lead_unassigned', 'lead', p_lead_id,
      pg_catalog.jsonb_build_object('from_user_id', v_lead.assigned_to, 'reason', v_reason)
    );

    v_response := pg_catalog.jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', null,
      'updated_at', (select l.updated_at from public.leads l where l.id = p_lead_id),
      'unchanged', false,
      'request_reason', v_reason
    );
  end if;

  insert into public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  values (v_actor_id, 'lead_unassignment', p_idempotency_key, p_lead_id, v_response);

  return v_response;
end
$fn$;

revoke all on function public.unassign_lead_atomic(uuid, timestamptz, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.unassign_lead_atomic(uuid, timestamptz, uuid, text)
  to authenticated;

-- Catalog assertions: the trigger owns allocation, helper functions are not RPC
-- surfaces, and the two user RPCs preserve their intended ACL.
do $do$
declare
  v_role name;
  v_kind "char";
  v_definer boolean;
  v_reassign text;
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.quotations'::regclass
       and t.tgname = 'aa_quotations_assign_quote_no'
       and not t.tgisinternal
       and t.tgenabled = 'O'
       and (t.tgtype & 3) = 3
       and (t.tgtype & 4) = 4
       and (t.tgtype & 16) = 16
  ) then
    raise exception 'aa_quotations_assign_quote_no is not an enabled BEFORE INSERT OR UPDATE ROW trigger';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = 'public.quotations'::regclass
       and c.contype = 'u'
       and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (quote_no)'
  ) then
    raise exception 'public.quotations.quote_no is not protected by a UNIQUE constraint';
  end if;

  select c.relkind into v_kind
    from pg_catalog.pg_class c
   where c.oid = to_regclass('public.quotation_number_seq');
  if v_kind is distinct from 'S' then
    raise exception 'public.quotation_number_seq is missing or is not a sequence';
  end if;
  if not exists (
    select 1
      from pg_catalog.pg_sequence s
     where s.seqrelid = 'public.quotation_number_seq'::regclass
       and s.seqtypid = 'bigint'::regtype
       and s.seqincrement = 1
       and s.seqmin = 1
       and not s.seqcycle
  ) then
    raise exception 'quotation_number_seq does not have the required bigint/increment/min/no-cycle posture';
  end if;

  for v_role in
    select r.role_name
      from (values ('public'::name), ('anon'::name),
                   ('authenticated'::name), ('service_role'::name)) r(role_name)
  loop
    if has_function_privilege(v_role, 'public.allocate_quote_no()'::regprocedure, 'execute')
       or has_function_privilege(v_role, 'public.quotations_assign_quote_no()'::regprocedure, 'execute') then
      raise exception 'internal quote allocator functions are executable by %', v_role;
    end if;
    if has_sequence_privilege(v_role, 'public.quotation_number_seq'::regclass, 'usage')
       or has_sequence_privilege(v_role, 'public.quotation_number_seq'::regclass, 'select')
       or has_sequence_privilege(v_role, 'public.quotation_number_seq'::regclass, 'update') then
      raise exception 'internal quotation sequence is directly accessible by %', v_role;
    end if;
  end loop;

  if has_function_privilege('public', 'public.next_quote_no()'::regprocedure, 'execute')
     or has_function_privilege('anon', 'public.next_quote_no()'::regprocedure, 'execute')
     or not has_function_privilege('authenticated', 'public.next_quote_no()'::regprocedure, 'execute')
     or not has_function_privilege('service_role', 'public.next_quote_no()'::regprocedure, 'execute') then
    raise exception 'next_quote_no ACL is not authenticated-and-service-only';
  end if;

  if has_function_privilege('public', 'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)'::regprocedure, 'execute')
     or has_function_privilege('anon', 'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)'::regprocedure, 'execute')
     or has_function_privilege('service_role', 'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)'::regprocedure, 'execute')
     or not has_function_privilege('authenticated', 'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)'::regprocedure, 'execute') then
    raise exception 'reassign_lead_atomic ACL is not authenticated-only';
  end if;

  if has_function_privilege('public', 'public.unassign_lead_atomic(uuid,timestamptz,uuid,text)'::regprocedure, 'execute')
     or has_function_privilege('anon', 'public.unassign_lead_atomic(uuid,timestamptz,uuid,text)'::regprocedure, 'execute')
     or has_function_privilege('service_role', 'public.unassign_lead_atomic(uuid,timestamptz,uuid,text)'::regprocedure, 'execute')
     or not has_function_privilege('authenticated', 'public.unassign_lead_atomic(uuid,timestamptz,uuid,text)'::regprocedure, 'execute') then
    raise exception 'unassign_lead_atomic ACL is not authenticated-only';
  end if;

  select p.prosrc into v_reassign
    from pg_catalog.pg_proc p
   where p.oid = 'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)'::regprocedure;
  if v_reassign !~ 'MISSING_EXPECTED_UPDATED_AT'
     or v_reassign !~ 'IDEMPOTENCY_KEY_REUSED_FOR_DIFFERENT_REQUEST'
     or v_reassign !~ 'pg_advisory_xact_lock' then
    raise exception 'reassign_lead_atomic did not retain the CAS/idempotency hardening';
  end if;

  select p.prosecdef into v_definer
    from pg_catalog.pg_proc p
   where p.oid = 'public.allocate_quote_no()'::regprocedure;
  if v_definer is distinct from false then
    raise exception 'allocate_quote_no must remain SECURITY INVOKER';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.next_quote_no()'::regprocedure,
       'public.reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)'::regprocedure,
       'public.unassign_lead_atomic(uuid,timestamptz,uuid,text)'::regprocedure
     )
       and p.prosecdef
     having count(*) = 3
        and bool_and(p.prosrc ~* '(^|\n)[ \t]*begin[ \t]*\r?\n[ \t]*perform[ \t]+public[.]assert_current_session_at_entry[(][)]')
  ) then
    raise exception 'one or more callable definer RPCs lacks the entry-time session assertion';
  end if;
end
$do$;

notify pgrst, 'reload schema';

commit;
