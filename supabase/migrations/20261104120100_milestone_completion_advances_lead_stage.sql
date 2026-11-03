-- ============================================================================
-- S3 #1 · completing a milestone advances the lead stage
-- ============================================================================
-- Before this migration a salesperson could complete all seven lead-detail
-- milestones and the lead still sat in stage `new`: nothing connected
-- lead_milestones to leads.stage, so the kanban, the lists and every stage-based
-- number stayed at "New lead" until somebody dragged the card or closed the lead.
--
-- The milestone -> stage mapping is the one the application already reports to
-- Meta (src/lib/meta-crm-events.ts, META_CRM_STAGE_EVENTS): a milestone and a
-- stage that report the same funnel event are the same business step.
--
--   first_contact -> contacted              ("Contacted")
--   requirements  -> requirement_confirmed  ("Qualified")
--   solution      -> solution_submitted     ("Solution Submitted")
--   quotation     -> quotation_submitted    ("Quoted")
--
-- basic_info, drawings and meeting have no stage of their own. Negotiation,
-- pending decision, won and lost stay explicit human decisions.
--
-- Rules kept intact (the existing leads triggers still run on every step):
--   * forward only, one step at a time (trg_check_stage_sequence) — a lead that
--     must move two stages is moved twice, each step audited;
--   * leaving `new` needs a complete contact record and an assessed quality
--     (trg_check_first_contact_gate). When that is not met the stage simply
--     stays where it is; the milestone itself still completes;
--   * a won/lost lead, or a lead in a stage outside the funnel order
--     (negotiation, pending_decision, no_answered, fake), is never touched.
--
-- Atomic: the stage change happens inside the same transaction as the milestone
-- insert/update that caused it. Idempotent: the target is derived from all the
-- lead's completed milestones, and a lead already at or past it is left alone,
-- so re-running (or completing a milestone twice) changes nothing.
--
-- Only milestones a person completed count (completed_at set and a note
-- present: the milestone route and recomplete_lead_milestone() both require
-- one). An unconfirmed system-created first_contact row does not move the lead.
--
-- OPTIONAL one-off backfill for leads already stuck behind their milestones.
-- Not run by this migration because it changes the stage (and therefore the
-- dashboards) of existing leads; run it only when Sam approves:
--
--   select public.advance_lead_stage_from_milestones(l.id, null)
--     from public.leads l
--    where l.final_status is null
--      and l.stage in ('new', 'contacted', 'requirement_confirmed', 'solution_submitted');
--
-- ROLLBACK (manual, safe at any time; stages already advanced stay advanced
-- because stages never move backwards):
--   drop trigger if exists trg_milestone_advances_lead_stage on public.lead_milestones;
--   drop function if exists public.trg_milestone_advances_lead_stage();
--   drop function if exists public.advance_lead_stage_from_milestones(uuid, uuid);
-- ============================================================================

begin;

create or replace function public.advance_lead_stage_from_milestones(
  p_lead_id uuid,
  p_actor uuid default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  stage_order constant text[] := array[
    'new', 'contacted', 'requirement_confirmed', 'solution_submitted', 'quotation_submitted'
  ];
  v_lead record;
  v_current text;
  v_cur_idx integer;
  v_target_idx integer;
  v_next text;
begin
  select l.id, l.stage, l.final_status, l.quality
    into v_lead
    from public.leads l
   where l.id = p_lead_id
     for update;
  if not found then
    return null;
  end if;

  v_current := v_lead.stage;
  if v_current is null
     or v_current in ('won', 'lost')
     or v_lead.final_status in ('won', 'lost') then
    return v_current;
  end if;

  v_cur_idx := pg_catalog.array_position(stage_order, v_current);
  if v_cur_idx is null then
    -- negotiation / pending_decision are already past every mapped stage;
    -- no_answered / fake are outside the sequential funnel.
    return v_current;
  end if;

  select max(pg_catalog.array_position(stage_order, case m.milestone_key
           when 'first_contact' then 'contacted'
           when 'requirements' then 'requirement_confirmed'
           when 'solution' then 'solution_submitted'
           when 'quotation' then 'quotation_submitted'
         end))
    into v_target_idx
    from public.lead_milestones m
   where m.lead_id = p_lead_id
     and m.completed_at is not null
     and pg_catalog.btrim(coalesce(m.notes, '')) <> '';

  if v_target_idx is null or v_target_idx <= v_cur_idx then
    return v_current;
  end if;

  while v_cur_idx < v_target_idx loop
    v_next := stage_order[v_cur_idx + 1];

    if v_current = 'new' and (
      v_lead.quality is null
      or v_lead.quality not in ('good', 'normal', 'poor')
      or not exists (
        select 1
          from public.follow_up_logs f
         where f.lead_id = p_lead_id
           and f.contact_time is not null
           and f.contact_result is not null
           and pg_catalog.btrim(f.contact_result) <> ''
      )
    ) then
      exit;
    end if;

    update public.leads
       set stage = v_next,
           stage_changed_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = p_lead_id;

    insert into public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
    values (
      p_lead_id,
      p_actor,
      'stage_change',
      pg_catalog.format('Stage changed from %s to %s (milestone completed)', v_current, v_next),
      pg_catalog.jsonb_build_object('from', v_current, 'to', v_next, 'source', 'milestone'),
      pg_catalog.now()
    );

    v_current := v_next;
    v_cur_idx := v_cur_idx + 1;
  end loop;

  return v_current;
end
$fn$;

revoke all on function public.advance_lead_stage_from_milestones(uuid, uuid) from public, anon, authenticated;

create or replace function public.trg_milestone_advances_lead_stage()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  if new.completed_at is null or pg_catalog.btrim(coalesce(new.notes, '')) = '' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.completed_at is not distinct from new.completed_at
     and old.notes is not distinct from new.notes then
    return new;
  end if;
  perform public.advance_lead_stage_from_milestones(new.lead_id, new.completed_by);
  return new;
end
$fn$;

revoke all on function public.trg_milestone_advances_lead_stage() from public, anon, authenticated;

drop trigger if exists trg_milestone_advances_lead_stage on public.lead_milestones;
create trigger trg_milestone_advances_lead_stage
  after insert or update of completed_at, notes on public.lead_milestones
  for each row
  execute function public.trg_milestone_advances_lead_stage();

commit;

