-- Persist the exact server-computed lead-rebalance plan before its first lead
-- moves. A retry carrying the same batch UUID must execute that plan, not
-- recompute against the partially changed load distribution.
-- NO_ROLLBACK: the table and RPC are additive and the previous application does
-- not reference them, so leaving them installed is backward-compatible. Dropping
-- them after a new application has stored a batch would discard its retry truth
-- and reopen the partial-success replanning defect; roll back the application
-- first and retain this inert integrity boundary.
begin;

create table if not exists public.lead_rebalance_batches (
  actor_id uuid not null references public.profiles(id),
  batch_key uuid not null,
  plan jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint lead_rebalance_batches_pkey primary key (actor_id, batch_key),
  constraint lead_rebalance_batches_plan_object
    check (pg_catalog.jsonb_typeof(plan) = 'object')
);

alter table public.lead_rebalance_batches enable row level security;
alter table public.lead_rebalance_batches force row level security;
revoke all on table public.lead_rebalance_batches from public, anon, authenticated, service_role;
grant select on table public.lead_rebalance_batches to service_role;

-- This table sorts after the release-wide statement-trigger sweep. Install the
-- current-session boundary here as well so a single ordered production apply has
-- the same coverage as the replay's idempotency pass.
drop trigger if exists trg_require_current_session on public.lead_rebalance_batches;
create trigger trg_require_current_session
before insert or update or delete on public.lead_rebalance_batches
for each statement execute function public.require_current_session();

create or replace function public.get_or_create_lead_rebalance_plan(
  p_batch_key uuid,
  p_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_actor_active boolean;
  v_existing jsonb;
  v_item jsonb;
  v_text text;
  v_id uuid;
  v_target uuid;
  v_mutation_key uuid;
  v_expected timestamptz;
  v_update_count integer;
  v_untokened_count integer;
begin
  perform public.assert_current_session_at_entry();
  -- The current-session assertion must remain the first executable statement,
  -- before both the replay return and the first durable plan write.
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_batch_key is null then
    raise exception 'INVALID_REBALANCE_BATCH_KEY' using errcode = '22023';
  end if;

  select p.role, p.is_active into v_actor_role, v_actor_active
    from public.profiles p
   where p.id = v_actor_id;
  if coalesce(v_actor_active, false) = false
     or coalesce(v_actor_role, '') not in ('admin', 'boss') then
    raise exception 'FORBIDDEN_REBALANCE' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'lead_rebalance_plan:' || v_actor_id::text || ':' || p_batch_key::text,
      0
    )
  );

  select b.plan into v_existing
    from public.lead_rebalance_batches b
   where b.actor_id = v_actor_id
     and b.batch_key = p_batch_key;
  if found then
    return pg_catalog.jsonb_build_object('found', true, 'plan', v_existing);
  end if;

  if p_plan is null then
    return pg_catalog.jsonb_build_object('found', false);
  end if;
  if pg_catalog.jsonb_typeof(p_plan) <> 'object'
     or not (p_plan ? 'updates')
     or not (p_plan ? 'untokened_lead_ids')
     or not (p_plan ? 'source_ids')
     or not (p_plan ? 'target_ids')
     or (select pg_catalog.array_agg(k.key order by k.key)
           from pg_catalog.jsonb_object_keys(p_plan) as k(key))
          is distinct from array['source_ids', 'target_ids', 'untokened_lead_ids', 'updates']::text[]
     or pg_catalog.jsonb_typeof(p_plan -> 'updates') <> 'array'
     or pg_catalog.jsonb_typeof(p_plan -> 'untokened_lead_ids') <> 'array'
     or pg_catalog.jsonb_typeof(p_plan -> 'source_ids') <> 'array'
     or pg_catalog.jsonb_typeof(p_plan -> 'target_ids') <> 'array' then
    raise exception 'INVALID_REBALANCE_PLAN' using errcode = '22023';
  end if;

  v_update_count := pg_catalog.jsonb_array_length(p_plan -> 'updates');
  v_untokened_count := pg_catalog.jsonb_array_length(p_plan -> 'untokened_lead_ids');
  if v_update_count > 500 or v_untokened_count > 500
     or v_update_count + v_untokened_count > 500
     or pg_catalog.jsonb_array_length(p_plan -> 'source_ids') > 50
     or pg_catalog.jsonb_array_length(p_plan -> 'target_ids') > 50 then
    raise exception 'REBALANCE_PLAN_TOO_LARGE' using errcode = '22023';
  end if;
  if v_update_count > 0 and (
       pg_catalog.jsonb_array_length(p_plan -> 'source_ids') = 0
       or pg_catalog.jsonb_array_length(p_plan -> 'target_ids') = 0
     ) then
    raise exception 'INVALID_REBALANCE_PLAN_REP_SET' using errcode = '22023';
  end if;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(p_plan -> 'updates')
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'object'
       or (select pg_catalog.array_agg(k.key order by k.key)
             from pg_catalog.jsonb_object_keys(v_item) as k(key))
            is distinct from array['assigned_to', 'expected_updated_at', 'id', 'idempotency_key']::text[]
       or pg_catalog.jsonb_typeof(v_item -> 'id') <> 'string'
       or pg_catalog.jsonb_typeof(v_item -> 'assigned_to') <> 'string'
       or pg_catalog.jsonb_typeof(v_item -> 'expected_updated_at') <> 'string'
       or pg_catalog.jsonb_typeof(v_item -> 'idempotency_key') <> 'string' then
      raise exception 'INVALID_REBALANCE_PLAN_UPDATE' using errcode = '22023';
    end if;
    begin
      v_id := (v_item ->> 'id')::uuid;
      v_target := (v_item ->> 'assigned_to')::uuid;
      v_expected := (v_item ->> 'expected_updated_at')::timestamptz;
      v_mutation_key := (v_item ->> 'idempotency_key')::uuid;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'INVALID_REBALANCE_PLAN_UPDATE' using errcode = '22023';
    end;
    if v_id is null or v_target is null or v_expected is null or v_mutation_key is null then
      raise exception 'INVALID_REBALANCE_PLAN_UPDATE' using errcode = '22023';
    end if;
  end loop;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(p_plan -> 'source_ids')
    union all
    select value from pg_catalog.jsonb_array_elements(p_plan -> 'target_ids')
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string' then
      raise exception 'INVALID_REBALANCE_PLAN_REP_ID' using errcode = '22023';
    end if;
    begin
      v_id := (v_item #>> '{}')::uuid;
    exception when invalid_text_representation then
      raise exception 'INVALID_REBALANCE_PLAN_REP_ID' using errcode = '22023';
    end;
    if v_id is null then
      raise exception 'INVALID_REBALANCE_PLAN_REP_ID' using errcode = '22023';
    end if;
  end loop;

  for v_item in
    select value from pg_catalog.jsonb_array_elements(p_plan -> 'untokened_lead_ids')
  loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string' then
      raise exception 'INVALID_REBALANCE_PLAN_UNTOKENED_ID' using errcode = '22023';
    end if;
    begin
      v_text := v_item #>> '{}';
      v_id := v_text::uuid;
    exception when invalid_text_representation then
      raise exception 'INVALID_REBALANCE_PLAN_UNTOKENED_ID' using errcode = '22023';
    end;
    if v_id is null then
      raise exception 'INVALID_REBALANCE_PLAN_UNTOKENED_ID' using errcode = '22023';
    end if;
  end loop;

  if (select pg_catalog.count(*) <> pg_catalog.count(distinct (item ->> 'id')::uuid)
        from pg_catalog.jsonb_array_elements(p_plan -> 'updates') as u(item))
     or (select pg_catalog.count(*) <> pg_catalog.count(distinct (item ->> 'idempotency_key')::uuid)
           from pg_catalog.jsonb_array_elements(p_plan -> 'updates') as u(item))
     or (select pg_catalog.count(*) <> pg_catalog.count(distinct (item #>> '{}')::uuid)
           from pg_catalog.jsonb_array_elements(p_plan -> 'untokened_lead_ids') as u(item))
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements(p_plan -> 'updates') as u(item)
         join pg_catalog.jsonb_array_elements(p_plan -> 'untokened_lead_ids') as n(item)
           on (u.item ->> 'id')::uuid = (n.item #>> '{}')::uuid
     )
     or (select pg_catalog.count(*) <> pg_catalog.count(distinct (item #>> '{}')::uuid)
           from pg_catalog.jsonb_array_elements(p_plan -> 'source_ids') as s(item))
     or (select pg_catalog.count(*) <> pg_catalog.count(distinct (item #>> '{}')::uuid)
           from pg_catalog.jsonb_array_elements(p_plan -> 'target_ids') as t(item))
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements(p_plan -> 'source_ids') as s(item)
         join pg_catalog.jsonb_array_elements(p_plan -> 'target_ids') as t(item)
           on (s.item #>> '{}')::uuid = (t.item #>> '{}')::uuid
     )
     or exists (
       select 1
         from pg_catalog.jsonb_array_elements(p_plan -> 'updates') as u(item)
        where not exists (
          select 1
            from pg_catalog.jsonb_array_elements(p_plan -> 'target_ids') as t(item)
           where (t.item #>> '{}')::uuid = (u.item ->> 'assigned_to')::uuid
        )
     ) then
    raise exception 'DUPLICATE_REBALANCE_PLAN_LEAD' using errcode = '22023';
  end if;

  insert into public.lead_rebalance_batches (actor_id, batch_key, plan)
  values (v_actor_id, p_batch_key, p_plan);

  return pg_catalog.jsonb_build_object('found', true, 'plan', p_plan);
end
$fn$;

comment on table public.lead_rebalance_batches is
  'Immutable per-actor rebalance plans. The first request stores the exact lead, target and CAS-token set; retries of its batch UUID read that set instead of planning against partially changed loads.';
comment on function public.get_or_create_lead_rebalance_plan(uuid, jsonb) is
  'Admin/boss-only idempotency boundary for sales-load rebalance. NULL plan performs a lookup; a missing non-NULL plan is validated, inserted once under an advisory lock, and returned. Existing batches always return their original plan.';

revoke all on function public.get_or_create_lead_rebalance_plan(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_or_create_lead_rebalance_plan(uuid, jsonb)
  to authenticated;

notify pgrst, 'reload schema';

commit;
