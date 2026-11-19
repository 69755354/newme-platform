-- NO_ROLLBACK: additive only (three new tables, their triggers and policies, six new routines); no existing table, column, policy or function is changed. Manual undo is described at the end of the file.
-- ============================================================================
-- OS fix S23 - opportunities and visit reports (parity gaps G5 and G6)
-- ============================================================================
-- 1. opportunity_stages: configurable stage list (which stages need a quote is data, not a column check).
-- 2. opportunities: one row per deal being worked for an existing lead (the Drive "Projects" sheet).
-- 3. visit_reports: one row per planned or held visit, with plan approval, report and review.
-- 4. Workflow routines (service role only): plan approval, report submission, review, overdue reminders.
-- Clients may read (row-level security, sales only their own leads' rows) and never write; the server writes
-- after its own role check, and the workflow columns can only be changed by the routines below.
-- This file sends no Meta feedback and creates no notification by itself; only flag_overdue_visit_reports()
-- creates warning notifications, and it is called by a route that is disabled by default.
-- Safe to run twice.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1 - Stage configuration
-- ---------------------------------------------------------------------------
create table if not exists public.opportunity_stages (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label_en text not null check (char_length(btrim(label_en)) between 1 and 80),
  label_zh text not null check (char_length(btrim(label_zh)) between 1 and 80),
  sort_order integer not null default 100,
  requires_quote boolean not null default false,
  is_closed boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.opportunity_stages (key, label_en, label_zh, sort_order, requires_quote, is_closed) values
  ('new',            'New',            '新建',   10, false, false),
  ('quotation_sent', 'Quotation sent', '已报价', 20, true,  false),
  ('negotiation',    'Negotiation',    '谈判中', 30, true,  false),
  ('won',            'Won',            '赢单',   40, true,  true),
  ('lost',           'Lost',           '输单',   50, false, true),
  ('on_hold',        'On hold',        '暂停',   60, false, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2 - Opportunities
-- ---------------------------------------------------------------------------
create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  opp_no integer generated always as identity,
  lead_id uuid not null references public.leads(id) on delete restrict,
  name text not null,
  confirmed_requirement text not null,
  stage text not null default 'new' references public.opportunity_stages(key),
  quote_amount_aed numeric(14,2),
  decision_target date,
  quotation_link text,
  closed_reason text,
  owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived boolean not null default false,
  archived_at timestamptz,
  constraint opportunities_id_lead_key unique (id, lead_id),
  constraint opportunities_name_len check (char_length(btrim(name)) between 1 and 200),
  constraint opportunities_requirement_len check (char_length(btrim(confirmed_requirement)) between 1 and 4000),
  constraint opportunities_amount_range check (quote_amount_aed is null or (quote_amount_aed >= 0 and quote_amount_aed < 10000000000)),
  constraint opportunities_decision_range check (decision_target is null or (decision_target >= date '2020-01-01' and decision_target <= date '2100-12-31')),
  constraint opportunities_link_shape check (quotation_link is null or (char_length(quotation_link) <= 2000 and quotation_link ~ '^https://[^[:space:]]+$')),
  constraint opportunities_reason_len check (closed_reason is null or char_length(closed_reason) <= 1000)
);
create unique index if not exists ux_opportunities_lead_name on public.opportunities (lead_id, lower(btrim(name))) where not archived;
create index if not exists idx_opportunities_lead on public.opportunities (lead_id);
create index if not exists idx_opportunities_owner on public.opportunities (owner_id) where owner_id is not null;
create index if not exists idx_opportunities_stage on public.opportunities (stage) where not archived;
create index if not exists idx_opportunities_decision on public.opportunities (decision_target) where not archived and decision_target is not null;

-- ---------------------------------------------------------------------------
-- 3 - Visit reports
-- ---------------------------------------------------------------------------
-- Next working day (Monday to Friday, Dubai time) after the day the visit was planned, 09:30 Dubai time.
create or replace function public.next_working_day_0930(p_planned timestamptz)
returns timestamptz
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $fn$
  select (((s.d + case extract(isodow from s.d)::integer when 5 then 3 when 6 then 2 else 1 end) + time '09:30')
          at time zone 'Asia/Dubai')
  from (select (p_planned at time zone 'Asia/Dubai')::date as d) s
$fn$;

comment on function public.next_working_day_0930(timestamptz) is
  'S23: 09:30 Dubai time on the next working day (Monday to Friday) after the Dubai day of the argument. The one place to extend with a holiday table.';

create table if not exists public.visit_reports (
  id uuid primary key default gen_random_uuid(),
  visit_no integer generated always as identity,
  lead_id uuid not null references public.leads(id) on delete restrict,
  opportunity_id uuid,
  planned_at timestamptz not null,
  location text,
  person_to_meet text,
  purpose text not null,
  plan_approval text not null default 'pending',
  plan_approved_by uuid references public.profiles(id) on delete set null,
  plan_approved_at timestamptz,
  plan_note text,
  actual_start timestamptz,
  actual_finish timestamptz,
  result text,
  next_action text,
  next_followup_date date,
  evidence_link text,
  submitted_at timestamptz,
  report_due_at timestamptz,
  review_status text not null default 'pending',
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  action_done boolean not null default false,
  owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived boolean not null default false,
  constraint visit_reports_opportunity_same_lead foreign key (opportunity_id, lead_id)
    references public.opportunities (id, lead_id),
  constraint visit_reports_planned_range check (planned_at >= timestamptz '2020-01-01' and planned_at < timestamptz '2101-01-01'),
  constraint visit_reports_purpose_len check (char_length(btrim(purpose)) between 1 and 2000),
  constraint visit_reports_location_len check (location is null or char_length(location) <= 300),
  constraint visit_reports_person_len check (person_to_meet is null or char_length(person_to_meet) <= 300),
  constraint visit_reports_result_len check (result is null or char_length(result) <= 4000),
  constraint visit_reports_next_action_len check (next_action is null or char_length(next_action) <= 2000),
  constraint visit_reports_notes_len check ((plan_note is null or char_length(plan_note) <= 1000) and (review_notes is null or char_length(review_notes) <= 2000)),
  constraint visit_reports_followup_range check (next_followup_date is null or (next_followup_date >= date '2020-01-01' and next_followup_date <= date '2100-12-31')),
  constraint visit_reports_evidence_shape check (evidence_link is null or (char_length(evidence_link) <= 2000 and evidence_link ~ '^https://[^[:space:]]+$')),
  constraint visit_reports_plan_approval_values check (plan_approval in ('pending', 'approved', 'rejected')),
  constraint visit_reports_review_status_values check (review_status in ('pending', 'accepted', 'needs_fix')),
  constraint visit_reports_actual_order check (actual_start is null or actual_finish is null or actual_finish >= actual_start),
  constraint visit_reports_approval_stamped check (plan_approval = 'pending' or (plan_approved_by is not null and plan_approved_at is not null)),
  constraint visit_reports_submit_requires check (submitted_at is null or (plan_approval = 'approved'
    and actual_start is not null and actual_finish is not null and result is not null and char_length(btrim(result)) > 0)),
  constraint visit_reports_review_requires_submit check (review_status = 'pending' or (submitted_at is not null and reviewed_by is not null and reviewed_at is not null))
);
create unique index if not exists ux_visit_reports_lead_planned on public.visit_reports (lead_id, planned_at) where not archived;
create index if not exists idx_visit_reports_lead on public.visit_reports (lead_id);
create index if not exists idx_visit_reports_owner on public.visit_reports (owner_id) where owner_id is not null;
create index if not exists idx_visit_reports_planned on public.visit_reports (planned_at desc);
create index if not exists idx_visit_reports_open_due on public.visit_reports (report_due_at) where submitted_at is null and not archived and plan_approval <> 'rejected';

-- Derived status, never stored. reviewed > completed > overdue > approved > planned.
create or replace function public.visit_report_status(
  p_plan_approval text, p_submitted_at timestamptz, p_review_status text, p_report_due_at timestamptz,
  p_now timestamptz default now())
returns text
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $fn$
  select case
    when p_submitted_at is not null and p_review_status = 'accepted' then 'reviewed'
    when p_submitted_at is not null then 'completed'
    when p_plan_approval is distinct from 'rejected' and p_report_due_at is not null and p_now > p_report_due_at then 'overdue'
    when p_plan_approval = 'approved' then 'approved'
    else 'planned'
  end
$fn$;

comment on function public.visit_report_status(text, timestamptz, text, timestamptz, timestamptz) is
  'S23: planned / approved / completed / reviewed / overdue, derived from the stored columns. Mirrored by src/lib/visit-status.mjs.';

-- ---------------------------------------------------------------------------
-- Row rules (triggers). Invoker rights: they only read the stage table and the row being written.
-- ---------------------------------------------------------------------------
create or replace function public.trg_opportunities_rules()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_stage public.opportunity_stages%rowtype;
begin
  select * into v_stage from public.opportunity_stages where key = new.stage;
  if not found then
    raise exception using errcode = '23503', message = 'opportunity_stage_unknown';
  end if;
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then
    if not v_stage.active then
      raise exception using errcode = '23514', message = 'opportunity_stage_inactive';
    end if;
  end if;
  if v_stage.requires_quote and (new.quote_amount_aed is null or new.quotation_link is null) then
    raise exception using errcode = '23514', message = 'opportunity_quote_required';
  end if;
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.archived_at := case when new.archived then now() end;
  elsif new.archived and not old.archived then
    new.archived_at := now();
  elsif not new.archived then
    new.archived_at := null;
  end if;
  return new;
end
$fn$;

drop trigger if exists trg_opportunities_rules on public.opportunities;
create trigger trg_opportunities_rules before insert or update on public.opportunities
  for each row execute function public.trg_opportunities_rules();

create or replace function public.trg_visit_reports_rules()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_plan_changed boolean;
  v_content_changed boolean;
begin
  if tg_op = 'INSERT' then
    new.report_due_at := public.next_working_day_0930(new.planned_at);
    new.updated_at := now();
    return new;
  end if;
  v_plan_changed := (new.planned_at, new.location, new.person_to_meet, new.purpose, new.opportunity_id)
    is distinct from (old.planned_at, old.location, old.person_to_meet, old.purpose, old.opportunity_id);
  v_content_changed := v_plan_changed or (new.actual_start, new.actual_finish, new.result, new.next_action, new.next_followup_date, new.evidence_link)
    is distinct from (old.actual_start, old.actual_finish, old.result, old.next_action, old.next_followup_date, old.evidence_link);
  -- A submitted report is read-only until a reviewer asks for a fix; an accepted report stays closed.
  if v_content_changed and old.submitted_at is not null and old.review_status is distinct from 'needs_fix' then
    raise exception using errcode = '23514', message = 'visit_report_locked';
  end if;
  if new.planned_at is distinct from old.planned_at then
    new.report_due_at := public.next_working_day_0930(new.planned_at);
  end if;
  -- Changing an approved or rejected plan sends it back for approval.
  if v_plan_changed and old.plan_approval <> 'pending' and new.plan_approval = old.plan_approval then
    new.plan_approval := 'pending';
    new.plan_approved_by := null;
    new.plan_approved_at := null;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;

drop trigger if exists trg_visit_reports_rules on public.visit_reports;
create trigger trg_visit_reports_rules before insert or update on public.visit_reports
  for each row execute function public.trg_visit_reports_rules();

-- ---------------------------------------------------------------------------
-- Privileges and row-level security
-- ---------------------------------------------------------------------------
alter table public.opportunity_stages enable row level security;
alter table public.opportunities enable row level security;
alter table public.visit_reports enable row level security;

revoke all on table public.opportunity_stages, public.opportunities, public.visit_reports from public, anon, authenticated, service_role;
grant select on public.opportunity_stages, public.opportunities, public.visit_reports to authenticated, service_role;
grant insert, update on public.opportunity_stages to service_role;
-- The server may write business columns only. Workflow columns (approval, submission, review, due time) have
-- no direct grant: they change through the routines below.
grant insert (lead_id, name, confirmed_requirement, stage, quote_amount_aed, decision_target, quotation_link, closed_reason, owner_id, created_by)
  on public.opportunities to service_role;
grant update (name, confirmed_requirement, stage, quote_amount_aed, decision_target, quotation_link, closed_reason, owner_id, archived)
  on public.opportunities to service_role;
grant insert (lead_id, opportunity_id, planned_at, location, person_to_meet, purpose, actual_start, actual_finish, result, next_action, next_followup_date, evidence_link, owner_id, created_by)
  on public.visit_reports to service_role;
grant update (opportunity_id, planned_at, location, person_to_meet, purpose, actual_start, actual_finish, result, next_action, next_followup_date, evidence_link, owner_id, archived)
  on public.visit_reports to service_role;

drop policy if exists opportunity_stages_select_active_session on public.opportunity_stages;
create policy opportunity_stages_select_active_session on public.opportunity_stages for select to authenticated
  using ((select public.session_token_is_current()));

drop policy if exists opportunities_select_staff on public.opportunities;
create policy opportunities_select_staff on public.opportunities for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'boss', 'operator')));
drop policy if exists opportunities_select_sales_own_leads on public.opportunities;
create policy opportunities_select_sales_own_leads on public.opportunities for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'sales')
    and public.is_my_lead(lead_id));

drop policy if exists visit_reports_select_staff on public.visit_reports;
create policy visit_reports_select_staff on public.visit_reports for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'boss', 'operator')));
drop policy if exists visit_reports_select_sales_own_leads on public.visit_reports;
create policy visit_reports_select_sales_own_leads on public.visit_reports for select to authenticated
  using ((select public.session_token_is_current())
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'sales')
    and public.is_my_lead(lead_id));

drop trigger if exists trg_require_current_session on public.opportunity_stages;
create trigger trg_require_current_session before insert or update or delete on public.opportunity_stages
  for each statement execute function public.require_current_session();
drop trigger if exists trg_require_current_session on public.opportunities;
create trigger trg_require_current_session before insert or update or delete on public.opportunities
  for each statement execute function public.require_current_session();
drop trigger if exists trg_require_current_session on public.visit_reports;
create trigger trg_require_current_session before insert or update or delete on public.visit_reports
  for each statement execute function public.require_current_session();

grant execute on function public.next_working_day_0930(timestamptz) to authenticated, service_role;
grant execute on function public.visit_report_status(text, timestamptz, text, timestamptz, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4 - Workflow routines (service role only; each re-checks the actor)
-- ---------------------------------------------------------------------------
-- Plan approval: admin, boss or operator (active). Returns {changed}. Same decision again changes nothing.
create or replace function public.visit_report_set_plan_approval(
  p_visit_id uuid, p_actor uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_role text;
  v_row public.visit_reports%rowtype;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss', 'operator') then
    raise exception using errcode = '42501', message = 'visit_plan_approval_not_allowed';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_plan_decision';
  end if;
  select * into v_row from public.visit_reports where id = p_visit_id for update;
  if not found or v_row.archived then
    raise exception using errcode = '22023', message = 'unknown_visit';
  end if;
  if v_row.submitted_at is not null then
    raise exception using errcode = '22023', message = 'visit_already_submitted';
  end if;
  if v_row.plan_approval = p_decision and v_row.plan_note is not distinct from left(p_note, 1000) then
    return jsonb_build_object('changed', false, 'plan_approval', v_row.plan_approval);
  end if;
  update public.visit_reports
     set plan_approval = p_decision, plan_approved_by = p_actor, plan_approved_at = now(), plan_note = left(p_note, 1000)
   where id = p_visit_id;
  return jsonb_build_object('changed', true, 'plan_approval', p_decision);
end
$fn$;

-- Submission: the owner of the visit, the owner of the lead, or admin, boss or operator.
create or replace function public.visit_report_submit(p_visit_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_role text;
  v_row public.visit_reports%rowtype;
  v_lead_owner uuid;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null then
    raise exception using errcode = '42501', message = 'visit_submit_not_allowed';
  end if;
  select * into v_row from public.visit_reports where id = p_visit_id for update;
  if not found or v_row.archived then
    raise exception using errcode = '22023', message = 'unknown_visit';
  end if;
  select assigned_to into v_lead_owner from public.leads where id = v_row.lead_id;
  if not (v_role in ('admin', 'boss', 'operator') or (v_role = 'sales' and (v_row.owner_id = p_actor or v_lead_owner = p_actor))) then
    raise exception using errcode = '42501', message = 'visit_submit_not_allowed';
  end if;
  if v_row.submitted_at is not null and v_row.review_status is distinct from 'needs_fix' then
    return jsonb_build_object('changed', false);
  end if;
  if v_row.plan_approval <> 'approved' then
    raise exception using errcode = '22023', message = 'visit_plan_not_approved';
  end if;
  if v_row.actual_start is null or v_row.actual_finish is null or v_row.result is null or btrim(v_row.result) = '' then
    raise exception using errcode = '22023', message = 'visit_report_incomplete';
  end if;
  update public.visit_reports set submitted_at = now(), review_status = 'pending' where id = p_visit_id;
  return jsonb_build_object('changed', true);
end
$fn$;

-- Review: admin, boss or operator (active). A fix request needs a note.
create or replace function public.visit_report_review(
  p_visit_id uuid, p_actor uuid, p_decision text, p_notes text default null, p_action_done boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '20s'
as $fn$
declare
  v_role text;
  v_row public.visit_reports%rowtype;
begin
  perform public.assert_current_session_at_entry();
  select role into v_role from public.profiles where id = p_actor and is_active;
  if v_role is null or v_role not in ('admin', 'boss', 'operator') then
    raise exception using errcode = '42501', message = 'visit_review_not_allowed';
  end if;
  if p_decision is null or p_decision not in ('accepted', 'needs_fix') then
    raise exception using errcode = '22023', message = 'invalid_review_decision';
  end if;
  if p_decision = 'needs_fix' and (p_notes is null or btrim(p_notes) = '') then
    raise exception using errcode = '22023', message = 'review_note_required';
  end if;
  select * into v_row from public.visit_reports where id = p_visit_id for update;
  if not found or v_row.archived then
    raise exception using errcode = '22023', message = 'unknown_visit';
  end if;
  if v_row.submitted_at is null then
    raise exception using errcode = '22023', message = 'visit_not_submitted';
  end if;
  if v_row.review_status = p_decision and v_row.review_notes is not distinct from left(p_notes, 2000)
     and v_row.action_done is not distinct from coalesce(p_action_done, v_row.action_done) then
    return jsonb_build_object('changed', false, 'review_status', v_row.review_status);
  end if;
  update public.visit_reports
     set review_status = p_decision, reviewed_by = p_actor, reviewed_at = now(), review_notes = left(p_notes, 2000),
         action_done = coalesce(p_action_done, action_done)
   where id = p_visit_id;
  return jsonb_build_object('changed', true, 'review_status', p_decision);
end
$fn$;

-- Overdue reminders: one warning notification per recipient per visit, ever (event key), for open visits
-- whose report was due within the last 14 days. Recipients: the visit owner (or the lead owner) and every
-- active admin, boss and operator. Creates nothing for submitted visits or rejected plans.
create or replace function public.flag_overdue_visit_reports(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set lock_timeout = '5s'
set statement_timeout = '30s'
as $fn$
declare
  v record;
  v_uid uuid;
  v_visits integer := 0;
  v_notified integer := 0;
  v_rows integer;
begin
  perform public.assert_current_session_at_entry();
  for v in
    select r.id, r.lead_id, coalesce(r.owner_id, l.assigned_to) as owner_id
      from public.visit_reports r join public.leads l on l.id = r.lead_id
     where not r.archived and r.submitted_at is null and r.plan_approval <> 'rejected'
       and r.report_due_at < p_now and r.report_due_at >= p_now - interval '14 days'
     order by r.report_due_at, r.id
     limit 500
  loop
    v_visits := v_visits + 1;
    for v_uid in
      select pr.id from public.profiles pr
       where pr.is_active and (pr.id = v.owner_id or pr.role in ('admin', 'boss', 'operator'))
    loop
      insert into public.notifications (user_id, type, title, body, related_id, related_type, is_read, event_key)
      values (v_uid, 'warning', 'Visit report overdue', 'A visit report is past its due time and has not been submitted.',
              v.lead_id::text, 'lead', false, 'visit-overdue:' || v.id::text)
      on conflict (user_id, event_key) do nothing;
      get diagnostics v_rows = row_count;
      v_notified := v_notified + v_rows;
    end loop;
  end loop;
  return jsonb_build_object('visits', v_visits, 'notified', v_notified);
end
$fn$;

revoke all on function public.visit_report_set_plan_approval(uuid, uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.visit_report_submit(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.visit_report_review(uuid, uuid, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.flag_overdue_visit_reports(timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.visit_report_set_plan_approval(uuid, uuid, text, text) to service_role;
grant execute on function public.visit_report_submit(uuid, uuid) to service_role;
grant execute on function public.visit_report_review(uuid, uuid, text, text, boolean) to service_role;
grant execute on function public.flag_overdue_visit_reports(timestamptz) to service_role;

comment on table public.opportunities is 'S23: deals being worked for an existing lead (Drive Projects sheet). Not the post-contract delivery table public.projects.';
comment on table public.visit_reports is 'S23: planned and held customer visits with plan approval, report and review. Status is derived by visit_report_status().';
comment on function public.visit_report_set_plan_approval(uuid, uuid, text, text) is 'S23: approve or reject a visit plan; admin, boss or operator only. Service role only.';
comment on function public.visit_report_submit(uuid, uuid) is 'S23: hand in a visit report (approved plan, actual times and result required). Service role only.';
comment on function public.visit_report_review(uuid, uuid, text, text, boolean) is 'S23: accept a report or ask for a fix; admin, boss or operator only. Service role only.';
comment on function public.flag_overdue_visit_reports(timestamptz) is 'S23: one warning notification per recipient per overdue visit. Idempotent. Service role only.';

-- ---------------------------------------------------------------------------
-- Manual undo (not executed; only for a test database with no real rows), in this order: remove the routines
-- flag_overdue_visit_reports(timestamptz), visit_report_review(uuid, uuid, text, text, boolean),
-- visit_report_submit(uuid, uuid), visit_report_set_plan_approval(uuid, uuid, text, text); remove the tables
-- visit_reports, opportunities, opportunity_stages; remove the routines visit_report_status(text, timestamptz, text, timestamptz, timestamptz),
-- trg_visit_reports_rules(), trg_opportunities_rules(), next_working_day_0930(timestamptz).
-- Prefer simply not using the pages: the tables are inert without them.
-- ---------------------------------------------------------------------------
