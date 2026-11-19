-- NO_ROLLBACK: additive only (three new tables, their triggers and policies, ten new routines); no existing table, column, policy or function is changed. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S24 - lead dispatch states, phone review and duplicate review (parity gaps G2 and G3)
-- ============================================================================
-- 1. lead_dispatch_state: one derived row per lead (seven dispatch states) plus the administrator's decisions.
-- 2. duplicate_reviews: one row per duplicate question, with the administrator's decision, notes and original.
-- 3. lead_dispatch_events: append-only history of status changes and decisions.
-- 4. Routines (service role only): evaluate_lead_dispatch, dispatch_decide, resolve_duplicate_review,
--    reopen_duplicate_review, sweep_lead_dispatch, dispatch_record_event; helpers for phone checks.
-- No column is added to public.leads and no trigger is added to it. Clients may read (row-level security,
-- sales only the state of their own leads) and never write; the service role has no write grant either, so
-- every write goes through the routines, which check the actor's role inside.
-- This file sends no Meta feedback, creates no notification and assigns no lead.
-- Safe to run twice.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1 - Phone helpers (mirror normalizePhone in src/lib/lead-contact.mjs; a unit test runs both on one list)
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_phone_norm(p_raw text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_text text;
  v_compact text;
  v_intl boolean := false;
  v_digits text;
  v_national text;
begin
  if p_raw is null then return null; end if;
  v_text := btrim(p_raw);
  if v_text = '' or char_length(v_text) > 40 then return null; end if;
  v_compact := regexp_replace(v_text, '[[:space:]().' || chr(160) || '/-]', '', 'g');
  if left(v_compact, 1) = '+' then
    v_intl := true; v_compact := substr(v_compact, 2);
  elsif left(v_compact, 2) = '00' then
    v_intl := true; v_compact := substr(v_compact, 3);
  end if;
  if v_compact !~ '^[0-9]+$' then return null; end if;
  if v_intl then
    v_digits := v_compact;
  elsif v_compact like '971%' and char_length(v_compact) in (11, 12, 13) then
    v_digits := v_compact;
  elsif v_compact like '0%' and v_compact not like '00%' and char_length(v_compact) in (9, 10) then
    v_digits := '971' || substr(v_compact, 2);
  elsif char_length(v_compact) = 9 and v_compact like '5%' then
    v_digits := '971' || v_compact;
  else
    return null;
  end if;
  if v_digits like '971%' then
    v_national := substr(v_digits, 4);
    if v_national like '0%' then v_national := substr(v_national, 2); end if;
    if v_national ~ '^5[0-9]{8}$' or v_national ~ '^[2-9][0-9]{7}$' then
      return '+971' || v_national;
    end if;
    return null;
  end if;
  if v_digits like '0%' or char_length(v_digits) < 8 or char_length(v_digits) > 15 then return null; end if;
  return '+' || v_digits;
end
$fn$;

-- empty / invalid (cannot be read as a phone number) / suspect (readable but looks wrong) / ok
create or replace function public.dispatch_phone_flag(p_raw text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_norm text;
begin
  if p_raw is null or btrim(p_raw) = '' then return 'empty'; end if;
  v_norm := public.dispatch_phone_norm(p_raw);
  if v_norm is null then return 'invalid'; end if;
  if substr(v_norm, 2) ~ '([0-9])\1{5,}'
     or substr(v_norm, 2) ~ '(012345678|123456789|987654321|876543210)' then
    return 'suspect';
  end if;
  return 'ok';
end
$fn$;

-- Test-record pattern: a test word at the start of the name (whole word), or a reserved test e-mail domain.
create or replace function public.dispatch_is_test_pattern(p_name text, p_email text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce(p_name ~* '^[[:space:]]*(test|testing|demo|qa)([^[:alpha:]]|$)', false)
      or coalesce(p_name ~ '^[[:space:]]*测试', false)
      or coalesce(btrim(p_email) ~* '@(example\.(com|org|net)|qa\.newme\.ae|[a-z0-9.-]+\.(test|invalid))$', false)
$fn$;

comment on function public.dispatch_phone_norm(text) is 'S24: E.164 form of a phone number by the same rules as src/lib/lead-contact.mjs, or null.';
comment on function public.dispatch_phone_flag(text) is 'S24: empty, invalid, suspect or ok.';
comment on function public.dispatch_is_test_pattern(text, text) is 'S24: automatic test-record pattern; an administrator can override it per lead.';

-- ---------------------------------------------------------------------------
-- 2 - Tables
-- ---------------------------------------------------------------------------
create table if not exists public.lead_dispatch_state (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  status text not null,
  missing_fields text[] not null default '{}',
  phone_norm text,
  phone_flag text not null default 'empty',
  phone_confirmed_norm text,
  test_mark text,
  release_reason text,
  release_by uuid references public.profiles(id) on delete set null,
  release_at timestamptz,
  routing_note text,
  admin_note text,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_dispatch_state_status_values check (status in (
    'delivered', 'unassigned', 'missing_intake_data', 'review_phone', 'duplicate_review', 'duplicate_not_dispatched', 'excluded_test')),
  constraint lead_dispatch_state_phone_flag_values check (phone_flag in ('empty', 'invalid', 'suspect', 'ok')),
  constraint lead_dispatch_state_test_mark_values check (test_mark is null or test_mark in ('manual', 'not_test')),
  constraint lead_dispatch_state_release_reason_len check (release_reason is null or char_length(btrim(release_reason)) >= 10),
  constraint lead_dispatch_state_release_stamped check ((release_reason is null) = (release_at is null)),
  constraint lead_dispatch_state_note_len check ((routing_note is null or char_length(routing_note) <= 500) and (admin_note is null or char_length(admin_note) <= 1000))
);
create index if not exists idx_lead_dispatch_state_status on public.lead_dispatch_state (status, updated_at desc);
create index if not exists idx_lead_dispatch_state_evaluated on public.lead_dispatch_state (evaluated_at);

create table if not exists public.duplicate_reviews (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  duplicate_of_lead_id uuid not null references public.leads(id) on delete cascade,
  candidate_ids uuid[] not null default '{}',
  matched_on text[] not null default '{}',
  decision text not null default 'pending',
  notes text,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint duplicate_reviews_not_self check (lead_id <> duplicate_of_lead_id),
  constraint duplicate_reviews_decision_values check (decision in ('pending', 'merged', 'kept_separate', 'invalid', 'withdrawn')),
  constraint duplicate_reviews_matched_values check (matched_on <@ array['phone', 'email', 'meta_leadgen_id']::text[]),
  constraint duplicate_reviews_notes_len check (notes is null or char_length(notes) <= 1000),
  constraint duplicate_reviews_note_required check (decision not in ('invalid', 'kept_separate') or char_length(btrim(coalesce(notes, ''))) >= 5),
  constraint duplicate_reviews_decision_stamped check ((decision = 'pending' and decided_at is null and decided_by is null) or (decision <> 'pending' and decided_at is not null))
);
create unique index if not exists ux_duplicate_reviews_one_pending on public.duplicate_reviews (lead_id) where decision = 'pending';
create index if not exists idx_duplicate_reviews_lead on public.duplicate_reviews (lead_id, created_at desc);
create index if not exists idx_duplicate_reviews_original on public.duplicate_reviews (duplicate_of_lead_id);

create table if not exists public.lead_dispatch_events (
  id bigint generated always as identity primary key,
  lead_id uuid not null references public.leads(id) on delete cascade,
  kind text not null,
  from_status text,
  to_status text,
  actor uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint lead_dispatch_events_kind_values check (kind in ('status', 'decision', 'duplicate')),
  constraint lead_dispatch_events_note_len check (note is null or char_length(note) <= 1200)
);
create index if not exists idx_lead_dispatch_events_lead on public.lead_dispatch_events (lead_id, id desc);

-- History rows are never edited.
create or replace function public.trg_lead_dispatch_events_append_only()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  raise exception using errcode = '23514', message = 'lead_dispatch_events_are_append_only';
end
$fn$;
drop trigger if exists trg_lead_dispatch_events_append_only on public.lead_dispatch_events;
create trigger trg_lead_dispatch_events_append_only before update on public.lead_dispatch_events
  for each row execute function public.trg_lead_dispatch_events_append_only();

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.lead_dispatch_state enable row level security;
alter table public.duplicate_reviews enable row level security;
alter table public.lead_dispatch_events enable row level security;

revoke all on table public.lead_dispatch_state, public.duplicate_reviews, public.lead_dispatch_events from public, anon, authenticated, service_role;
grant select on public.lead_dispatch_state, public.duplicate_reviews, public.lead_dispatch_events to authenticated, service_role;

drop policy if exists lead_dispatch_state_select_staff on public.lead_dispatch_state;
create policy lead_dispatch_state_select_staff on public.lead_dispatch_state for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'boss', 'operator')));
drop policy if exists lead_dispatch_state_select_sales_own_leads on public.lead_dispatch_state;
create policy lead_dispatch_state_select_sales_own_leads on public.lead_dispatch_state for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'sales')
    and public.is_my_lead(lead_id));
drop policy if exists duplicate_reviews_select_staff on public.duplicate_reviews;
create policy duplicate_reviews_select_staff on public.duplicate_reviews for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'boss', 'operator')));
drop policy if exists lead_dispatch_events_select_staff on public.lead_dispatch_events;
create policy lead_dispatch_events_select_staff on public.lead_dispatch_events for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'boss', 'operator')));

drop trigger if exists trg_require_current_session on public.lead_dispatch_state;
create trigger trg_require_current_session before insert or update or delete on public.lead_dispatch_state
  for each statement execute function public.require_current_session();
drop trigger if exists trg_require_current_session on public.duplicate_reviews;
create trigger trg_require_current_session before insert or update or delete on public.duplicate_reviews
  for each statement execute function public.require_current_session();
drop trigger if exists trg_require_current_session on public.lead_dispatch_events;
create trigger trg_require_current_session before insert or update or delete on public.lead_dispatch_events
  for each statement execute function public.require_current_session();

grant execute on function public.dispatch_phone_norm(text) to authenticated, service_role;
grant execute on function public.dispatch_phone_flag(text) to authenticated, service_role;
grant execute on function public.dispatch_is_test_pattern(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3 - Routines (service role only; each re-checks the actor)
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_record_event(
  p_lead_id uuid, p_kind text, p_from text, p_to text, p_actor uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
begin
  perform public.assert_current_session_at_entry();
  insert into public.lead_dispatch_events (lead_id, kind, from_status, to_status, actor, note)
  values (p_lead_id, p_kind, p_from, p_to, p_actor, left(p_note, 1200));
end
$fn$;

-- Evaluate one lead. Reads the lead, writes (or keeps) its state row, and when the lead has an older twin opens
-- a pending duplicate review. Never writes the lead. Same input gives the same state.
create or replace function public.evaluate_lead_dispatch(p_lead_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  l public.leads%rowtype;
  st public.lead_dispatch_state%rowtype;
  v_have boolean;
  v_missing text[] := '{}';
  v_norm text;
  v_flag text;
  v_status text;
  v_note text;
  v_is_test boolean;
  v_cands uuid[];
  v_matched text[];
  v_pending public.duplicate_reviews%rowtype;
  v_decided public.duplicate_reviews%rowtype;
  v_changed boolean;
begin
  perform public.assert_current_session_at_entry();
  perform pg_advisory_xact_lock(hashtextextended('lead_dispatch:' || p_lead_id::text, 0));
  select * into l from public.leads where id = p_lead_id;
  if not found then
    raise exception using errcode = '22023', message = 'unknown_lead';
  end if;
  if l.archived then
    return jsonb_build_object('lead_id', p_lead_id, 'status', 'skipped', 'changed', false);
  end if;
  select * into st from public.lead_dispatch_state where lead_id = p_lead_id;
  v_have := found;

  -- facts
  if l.customer_name is null or char_length(btrim(l.customer_name)) < 2 then v_missing := array_append(v_missing, 'customer_name'::text); end if;
  if btrim(coalesce(l.phone, '')) = '' and btrim(coalesce(l.email, '')) = '' then v_missing := array_append(v_missing, 'phone_or_email'::text); end if;
  if coalesce(l.first_touch_at, l.created_at) is null then v_missing := array_append(v_missing, 'received_at'::text); end if;
  if btrim(coalesce(l.source, '')) = '' then v_missing := array_append(v_missing, 'source'::text); end if;
  v_norm := public.dispatch_phone_norm(l.phone);
  v_flag := public.dispatch_phone_flag(l.phone);
  v_is_test := case coalesce(v_have and st.test_mark is not null, false)
    when true then st.test_mark = 'manual'
    else public.dispatch_is_test_pattern(l.customer_name, l.email) end;

  select * into v_decided from public.duplicate_reviews
   where lead_id = p_lead_id and decision in ('merged', 'invalid') order by decided_at desc, created_at desc limit 1;
  select * into v_pending from public.duplicate_reviews where lead_id = p_lead_id and decision = 'pending';

  -- older twins (only the newer lead of a pair is ever flagged)
  select array_agg(o.id order by o.created_at, o.id),
         array_remove(array[
           case when bool_or(v_norm is not null and public.wa_phone_key(o.phone) = public.wa_phone_key(l.phone) and public.dispatch_phone_norm(o.phone) = v_norm) then 'phone' end,
           case when bool_or(btrim(coalesce(l.email, '')) <> '' and lower(btrim(o.email)) = lower(btrim(l.email))) then 'email' end,
           case when bool_or(btrim(coalesce(l.meta_leadgen_id, '')) <> '' and o.meta_leadgen_id = l.meta_leadgen_id) then 'meta_leadgen_id' end
         ], null)
    into v_cands, v_matched
    from public.leads o
   where o.id <> l.id and not o.archived
     and (o.created_at, o.id) < (l.created_at, l.id)
     and not exists (select 1 from public.lead_dispatch_state os where os.lead_id = o.id and os.status = 'excluded_test')
     and ((v_norm is not null and public.wa_phone_key(o.phone) = public.wa_phone_key(l.phone) and public.dispatch_phone_norm(o.phone) = v_norm)
       or (btrim(coalesce(l.email, '')) <> '' and lower(btrim(o.email)) = lower(btrim(l.email)))
       or (btrim(coalesce(l.meta_leadgen_id, '')) <> '' and o.meta_leadgen_id = l.meta_leadgen_id));

  -- decision order
  if v_is_test then
    v_status := 'excluded_test'; v_note := 'test record';
  elsif v_decided.id is not null then
    v_status := 'duplicate_not_dispatched'; v_note := 'duplicate decision: ' || v_decided.decision;
  elsif cardinality(v_missing) > 0 and not (v_have and st.release_reason is not null) then
    v_status := 'missing_intake_data'; v_note := 'missing: ' || array_to_string(v_missing, ', ');
  elsif v_flag in ('invalid', 'suspect') and not (v_have and v_norm is not null and st.phone_confirmed_norm = v_norm) then
    v_status := 'review_phone'; v_note := 'phone looks ' || v_flag;
  else
    -- duplicates: an open review stays open while a candidate exists; without a candidate it is withdrawn
    if v_pending.id is not null then
      if v_cands is null then
        update public.duplicate_reviews set decision = 'withdrawn', decided_at = now(), notes = coalesce(notes, 'candidate no longer matches')
         where id = v_pending.id;
        perform public.dispatch_record_event(p_lead_id, 'duplicate', null, null, null, 'review withdrawn: candidate no longer matches');
      else
        if v_pending.candidate_ids is distinct from v_cands or v_pending.matched_on is distinct from v_matched
           or v_pending.duplicate_of_lead_id is distinct from v_cands[1] then
          update public.duplicate_reviews set candidate_ids = v_cands, matched_on = v_matched, duplicate_of_lead_id = v_cands[1]
           where id = v_pending.id;
        end if;
        v_status := 'duplicate_review';
      end if;
    elsif v_cands is not null
          and not exists (select 1 from public.duplicate_reviews r
                           where r.lead_id = p_lead_id and r.decision = 'kept_separate' and r.candidate_ids @> v_cands) then
      insert into public.duplicate_reviews (lead_id, duplicate_of_lead_id, candidate_ids, matched_on)
      values (p_lead_id, v_cands[1], v_cands, v_matched);
      perform public.dispatch_record_event(p_lead_id, 'duplicate', null, null, null, 'review opened: matches ' || array_to_string(v_matched, ', '));
      v_status := 'duplicate_review';
    end if;
    if v_status is not null then
      v_note := 'matches an older lead on ' || array_to_string(v_matched, ', ');
    elsif l.assigned_to is null then
      v_status := 'unassigned'; v_note := 'no owner';
    else
      v_status := 'delivered'; v_note := 'ready';
    end if;
  end if;

  if not v_have then
    insert into public.lead_dispatch_state (lead_id, status, missing_fields, phone_norm, phone_flag, routing_note)
    values (p_lead_id, v_status, v_missing, v_norm, v_flag, v_note);
    perform public.dispatch_record_event(p_lead_id, 'status', null, v_status, p_actor, v_note);
    v_changed := true;
  else
    v_changed := (st.status, st.missing_fields, st.phone_norm, st.phone_flag, st.routing_note)
      is distinct from (v_status, v_missing, v_norm, v_flag, v_note);
    if v_changed then
      update public.lead_dispatch_state
         set status = v_status, missing_fields = v_missing, phone_norm = v_norm, phone_flag = v_flag,
             routing_note = v_note, evaluated_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      if st.status is distinct from v_status then
        perform public.dispatch_record_event(p_lead_id, 'status', st.status, v_status, p_actor, v_note);
      end if;
    else
      update public.lead_dispatch_state set evaluated_at = now() where lead_id = p_lead_id;
    end if;
  end if;
  return jsonb_build_object('lead_id', p_lead_id, 'status', v_status, 'previous_status', case when v_have then st.status end,
                            'changed', v_changed, 'missing_fields', to_jsonb(v_missing));
end
$fn$;

-- Administrator decisions on one lead. Actor must be an active admin, boss or operator.
create or replace function public.dispatch_decide(p_lead_id uuid, p_actor uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_role text;
  st public.lead_dispatch_state%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_changed boolean := false;
  v_result jsonb;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss', 'operator') then
    raise exception using errcode = '42501', message = 'dispatch_decision_not_allowed';
  end if;
  if p_action is null or p_action not in ('confirm_phone', 'release_missing', 'revoke_release', 'mark_test', 'unmark_test', 'note', 'reevaluate') then
    raise exception using errcode = '22023', message = 'invalid_dispatch_action';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead_dispatch:' || p_lead_id::text, 0));
  -- bring the row up to date first, so a decision never rests on a stale reading of the lead
  perform public.evaluate_lead_dispatch(p_lead_id, p_actor);
  select * into st from public.lead_dispatch_state where lead_id = p_lead_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'lead_has_no_dispatch_state';
  end if;

  if p_action = 'confirm_phone' then
    if st.phone_flag = 'invalid' or (st.phone_flag = 'suspect' and st.phone_norm is null) then
      raise exception using errcode = '22023', message = 'phone_not_confirmable';
    end if;
    if st.phone_flag = 'suspect' and st.phone_confirmed_norm is distinct from st.phone_norm then
      update public.lead_dispatch_state set phone_confirmed_norm = phone_norm, decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action = 'release_missing' then
    if char_length(v_reason) < 10 then
      raise exception using errcode = '22023', message = 'reason_required';
    end if;
    if cardinality(st.missing_fields) = 0 then
      raise exception using errcode = '22023', message = 'nothing_to_release';
    end if;
    if st.release_reason is distinct from v_reason then
      update public.lead_dispatch_state set release_reason = v_reason, release_by = p_actor, release_at = now(),
             decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action = 'revoke_release' then
    if st.release_reason is not null then
      update public.lead_dispatch_state set release_reason = null, release_by = null, release_at = null,
             decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action in ('mark_test', 'unmark_test') then
    if char_length(v_reason) < 5 then
      raise exception using errcode = '22023', message = 'reason_required';
    end if;
    if st.test_mark is distinct from (case when p_action = 'mark_test' then 'manual' else 'not_test' end) then
      update public.lead_dispatch_state set test_mark = case when p_action = 'mark_test' then 'manual' else 'not_test' end,
             decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  elsif p_action = 'note' then
    if v_reason = '' then
      raise exception using errcode = '22023', message = 'reason_required';
    end if;
    if st.admin_note is distinct from left(v_reason, 1000) then
      update public.lead_dispatch_state set admin_note = left(v_reason, 1000), decided_by = p_actor, decided_at = now(), updated_at = now()
       where lead_id = p_lead_id;
      v_changed := true;
    end if;
  end if;

  if v_changed then
    perform public.dispatch_record_event(p_lead_id, 'decision', st.status, null, p_actor, p_action || case when v_reason <> '' then ': ' || v_reason else '' end);
  end if;
  v_result := public.evaluate_lead_dispatch(p_lead_id, p_actor);
  return jsonb_build_object('lead_id', p_lead_id, 'status', v_result->>'status', 'changed', v_changed or coalesce((v_result->>'changed')::boolean, false));
end
$fn$;

-- Resolve a pending duplicate review: merged (same customer, link only), kept_separate or invalid.
create or replace function public.resolve_duplicate_review(p_review_id uuid, p_actor uuid, p_decision text, p_notes text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_role text;
  v_lead uuid;
  v_row public.duplicate_reviews%rowtype;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_eval jsonb;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss', 'operator') then
    raise exception using errcode = '42501', message = 'duplicate_decision_not_allowed';
  end if;
  if p_decision is null or p_decision not in ('merged', 'kept_separate', 'invalid') then
    raise exception using errcode = '22023', message = 'invalid_duplicate_decision';
  end if;
  if p_decision in ('invalid', 'kept_separate') and char_length(coalesce(v_notes, '')) < 5 then
    raise exception using errcode = '22023', message = 'review_note_required';
  end if;
  select lead_id into v_lead from public.duplicate_reviews where id = p_review_id;
  if not found then
    raise exception using errcode = '22023', message = 'unknown_review';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead_dispatch:' || v_lead::text, 0));
  select * into v_row from public.duplicate_reviews where id = p_review_id for update;
  if v_row.decision = p_decision and v_row.notes is not distinct from left(v_notes, 1000) then
    return jsonb_build_object('changed', false, 'decision', v_row.decision);
  end if;
  if v_row.decision <> 'pending' then
    raise exception using errcode = '22023', message = 'review_already_decided';
  end if;
  update public.duplicate_reviews set decision = p_decision, notes = left(v_notes, 1000), decided_by = p_actor, decided_at = now()
   where id = p_review_id;
  perform public.dispatch_record_event(v_lead, 'duplicate', 'duplicate_review', null, p_actor,
    p_decision || case when v_notes is not null then ': ' || v_notes else '' end);
  v_eval := public.evaluate_lead_dispatch(v_lead, p_actor);
  return jsonb_build_object('changed', true, 'decision', p_decision, 'status', v_eval->>'status');
end
$fn$;

-- Put a decided review back to pending (the original decision stays in the history).
create or replace function public.reopen_duplicate_review(p_review_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_role text;
  v_lead uuid;
  v_row public.duplicate_reviews%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_eval jsonb;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss', 'operator') then
    raise exception using errcode = '42501', message = 'duplicate_decision_not_allowed';
  end if;
  if char_length(v_reason) < 5 then
    raise exception using errcode = '22023', message = 'reason_required';
  end if;
  select lead_id into v_lead from public.duplicate_reviews where id = p_review_id;
  if not found then
    raise exception using errcode = '22023', message = 'unknown_review';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lead_dispatch:' || v_lead::text, 0));
  select * into v_row from public.duplicate_reviews where id = p_review_id for update;
  if v_row.decision = 'pending' then
    return jsonb_build_object('changed', false, 'decision', 'pending');
  end if;
  if exists (select 1 from public.duplicate_reviews where lead_id = v_lead and decision = 'pending') then
    raise exception using errcode = '22023', message = 'pending_review_exists';
  end if;
  perform public.dispatch_record_event(v_lead, 'duplicate', null, null, p_actor,
    'reopened (was ' || v_row.decision || '): ' || v_reason);
  update public.duplicate_reviews set decision = 'pending', decided_by = null, decided_at = null where id = p_review_id;
  v_eval := public.evaluate_lead_dispatch(v_lead, p_actor);
  return jsonb_build_object('changed', true, 'decision', 'pending', 'status', v_eval->>'status');
end
$fn$;

-- Bounded sweep: leads created since p_since that have no state, and state rows whose lead changed after the
-- last evaluation (and since p_since). The application calls it with a seven-day window; the backfill script
-- calls it with an old date, in batches.
create or replace function public.sweep_lead_dispatch(p_since timestamptz, p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '60s'
as $fn$
declare
  v_id uuid;
  v_eval jsonb;
  v_evaluated integer := 0;
  v_changed integer := 0;
begin
  perform public.assert_current_session_at_entry();
  if p_since is null then
    raise exception using errcode = '22023', message = 'since_required';
  end if;
  for v_id in
    select l.id
      from public.leads l left join public.lead_dispatch_state s on s.lead_id = l.id
     where not l.archived
       and ((s.lead_id is null and l.created_at >= p_since)
         or (s.lead_id is not null and coalesce(l.updated_at, l.created_at) > s.evaluated_at and coalesce(l.updated_at, l.created_at) >= p_since))
     order by coalesce(l.updated_at, l.created_at), l.id
     limit greatest(1, least(coalesce(p_limit, 100), 1000))
  loop
    v_eval := public.evaluate_lead_dispatch(v_id, null);
    v_evaluated := v_evaluated + 1;
    if coalesce((v_eval->>'changed')::boolean, false) then v_changed := v_changed + 1; end if;
  end loop;
  return jsonb_build_object('evaluated', v_evaluated, 'changed', v_changed);
end
$fn$;

revoke all on function public.dispatch_record_event(uuid, text, text, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.evaluate_lead_dispatch(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.dispatch_decide(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.resolve_duplicate_review(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.reopen_duplicate_review(uuid, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.sweep_lead_dispatch(timestamptz, integer) from public, anon, authenticated, service_role;
grant execute on function public.dispatch_record_event(uuid, text, text, text, uuid, text) to service_role;
grant execute on function public.evaluate_lead_dispatch(uuid, uuid) to service_role;
grant execute on function public.dispatch_decide(uuid, uuid, text, text) to service_role;
grant execute on function public.resolve_duplicate_review(uuid, uuid, text, text) to service_role;
grant execute on function public.reopen_duplicate_review(uuid, uuid, text) to service_role;
grant execute on function public.sweep_lead_dispatch(timestamptz, integer) to service_role;

comment on table public.lead_dispatch_state is 'S24: one derived dispatch row per lead (seven states) plus the administrator decisions. Never writes the lead.';
comment on table public.duplicate_reviews is 'S24: duplicate questions about a lead and the administrator decision (merged = link only, kept_separate, invalid).';
comment on table public.lead_dispatch_events is 'S24: append-only history of dispatch status changes and decisions.';
comment on function public.evaluate_lead_dispatch(uuid, uuid) is 'S24: idempotent dispatch evaluation of one lead. Service role only.';
comment on function public.dispatch_decide(uuid, uuid, text, text) is 'S24: confirm phone, release missing data, mark test, note, re-evaluate; admin, boss or operator only. Service role only.';
comment on function public.resolve_duplicate_review(uuid, uuid, text, text) is 'S24: resolve a pending duplicate review; admin, boss or operator only. Service role only.';
comment on function public.reopen_duplicate_review(uuid, uuid, text) is 'S24: put a decided duplicate review back to pending. Service role only.';
comment on function public.sweep_lead_dispatch(timestamptz, integer) is 'S24: bounded sweep over new and changed leads. Service role only.';

-- ---------------------------------------------------------------------------
-- Manual undo (not executed; only for a test database with no real rows), in this order: remove the routines
-- sweep_lead_dispatch(timestamptz, integer), reopen_duplicate_review(uuid, uuid, text),
-- resolve_duplicate_review(uuid, uuid, text, text), dispatch_decide(uuid, uuid, text, text),
-- evaluate_lead_dispatch(uuid, uuid), dispatch_record_event(uuid, text, text, text, uuid, text); remove the tables
-- lead_dispatch_events, duplicate_reviews, lead_dispatch_state; remove the helpers dispatch_is_test_pattern(text, text),
-- dispatch_phone_flag(text), dispatch_phone_norm(text), trg_lead_dispatch_events_append_only().
-- Prefer simply not using the pages: the tables are inert without them.
-- ---------------------------------------------------------------------------
