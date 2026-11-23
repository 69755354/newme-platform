-- NO_ROLLBACK: seven existing routines replaced in place (CREATE OR REPLACE, same signatures, same security mode and pinned search_path); no table, column, policy, trigger or data change. Manual undo: re-create the routines with the bodies from supabase/migrations/20261104110000_role_least_privilege.sql (transition_lead_stage), supabase/migrations/20261121100000_sync_advance_lead_stage_from_sheet.sql (the sheet routine) and supabase/replay/production-schema-baseline.sql (the other five).
-- ============================================================================
-- OS fix S39 - lead stage rules relaxed (Sam-approved, UX report batch 5, decision 1)
-- ============================================================================
-- Before: a lead moved one stage at a time, leaving "new" needed one complete contact record AND a lead quality rating,
-- and a milestone could not be completed out of order.
-- After:
--   * a stage may be skipped going forward (new -> quotation_submitted in one move); backwards, sideways and moves out
--     of won / lost are still refused, won / lost are still reachable from any open stage;
--   * leaving "new" needs one complete contact record only; the lead quality rating is optional;
--   * a milestone may be completed ahead of the one before it (still never backwards).
-- Routines replaced (all CREATE OR REPLACE, so a second run is a no-op):
--   public.trg_check_stage_sequence()        trigger, invoker, search_path pinned
--   public.trg_check_first_contact_gate()    trigger, invoker, search_path pinned
--   public.trg_enforce_first_contact_milestone()  trigger on lead_milestones, SECURITY DEFINER, search_path pinned
--   public.sync_advance_lead_stage_from_sheet(uuid,text,text)  service role only, SECURITY DEFINER, search_path pinned
--   public.recomplete_lead_milestone(uuid,text,text)  SECURITY DEFINER, search_path pinned: re-completing a reopened milestone needs any earlier one done
--   public.check_milestone_order()           trigger, SECURITY DEFINER, search_path pinned
--   public.transition_lead_stage(uuid,text,text,text,uuid)  SECURITY DEFINER, search_path pinned, same grants as before
-- Not changed: the follow-up rule (trg_enforce_followup: next action + next follow-up date), the note rule inside
-- transition_lead_stage (the application now supplies a default note), won needs an amount and lost needs a reason
-- (both enforced by the application, S36), the sheet-sync routine sync_advance_lead_stage_from_sheet (still walks one step at a time and keeps its contact and follow-up checks; only its quality check is dropped).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.trg_check_stage_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  stage_order text[] := ARRAY['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'];
  cur_idx int;
  new_idx int;
BEGIN
  -- No-op: same stage
  IF NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  -- Reject NULL stage (bypass prevention)
  IF NEW.stage IS NULL THEN
    RAISE EXCEPTION 'Stage cannot be set to NULL.';
  END IF;

  -- Reject transitions FROM terminal stages (won/lost are final)
  IF OLD.stage IN ('won', 'lost') THEN
    RAISE EXCEPTION 'Cannot change stage from terminal state: %.', OLD.stage;
  END IF;

  -- Initial create (OLD.stage IS NULL) — allow any valid stage
  IF OLD.stage IS NULL THEN
    new_idx := array_position(stage_order, NEW.stage);
    IF new_idx IS NOT NULL OR NEW.stage IN ('won', 'lost') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Invalid initial stage: %. Allowed: % or won/lost.', NEW.stage, array_to_string(stage_order, ', ');
  END IF;

  -- Terminal stages (won/lost) can be reached from any non-terminal stage
  IF NEW.stage IN ('won', 'lost') THEN
    RETURN NEW;
  END IF;

  -- Find current and new stage indices
  cur_idx := array_position(stage_order, OLD.stage);
  new_idx := array_position(stage_order, NEW.stage);

  -- Reject unknown stages (was: defensive allow; now: block)
  IF cur_idx IS NULL OR new_idx IS NULL THEN
    RAISE EXCEPTION 'Invalid stage transition. Current: %, attempted: %.', OLD.stage, NEW.stage;
  END IF;

  -- S39: the new stage must be LATER in the funnel; skipping stages going forward is allowed.
  IF new_idx <= cur_idx THEN
    RAISE EXCEPTION 'Stage can only move forward. Current: %, attempted: %.', OLD.stage, NEW.stage;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_check_first_contact_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  complete_contact_count integer;
BEGIN
  -- Guard every attempt to leave the initial stage, including direct won/lost
  -- updates. This prevents API payload and direct table-update bypasses.
  IF OLD.stage IS DISTINCT FROM 'new'
     OR NEW.stage IS NOT DISTINCT FROM OLD.stage THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO complete_contact_count
  FROM public.follow_up_logs
  WHERE lead_id = NEW.id
    AND contact_time IS NOT NULL
    AND contact_result IS NOT NULL
    AND btrim(contact_result) <> '';

  IF complete_contact_count < 1 THEN
    RAISE EXCEPTION 'first_contact gate: at least one complete contact record is required';
  END IF;

  -- S39: the lead quality rating is optional and no longer part of this gate.
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_enforce_first_contact_milestone()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.milestone_key = 'first_contact' THEN
    -- S39: the lead quality rating is optional; one complete contact record is the whole rule.
    IF NOT EXISTS (
      SELECT 1
      FROM public.follow_up_logs
      WHERE lead_id = NEW.lead_id
        AND contact_time IS NOT NULL
        AND contact_result IS NOT NULL
        AND btrim(contact_result) <> ''
    ) THEN
      RAISE EXCEPTION 'first_contact milestone: complete contact record required';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recomplete_lead_milestone(p_lead_id uuid, p_milestone_key text, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  current_lead public.leads%ROWTYPE;
  current_milestone record;
  recompleted record;
  target_order integer;
  clean_notes text := btrim(COALESCE(p_notes, ''));
BEGIN
  perform public.assert_current_session_at_entry();
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT role INTO actor_role
  FROM public.profiles
  WHERE id = actor_id;

  IF actor_role IS NULL
     OR actor_role NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'Forbidden: invalid CRM role';
  END IF;

  IF p_milestone_key IS NULL
     OR p_milestone_key NOT IN (
       'first_contact', 'basic_info', 'drawings', 'requirements',
       'solution', 'quotation', 'meeting'
     ) THEN
    RAISE EXCEPTION 'Invalid milestone';
  END IF;

  IF clean_notes = '' THEN
    RAISE EXCEPTION 'Milestone note is required';
  END IF;
  IF char_length(clean_notes) > 1000 THEN
    RAISE EXCEPTION 'Milestone note must be 1000 characters or fewer';
  END IF;

  SELECT * INTO current_lead
  FROM public.leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  IF actor_role NOT IN ('admin', 'boss', 'operator')
     AND current_lead.assigned_to IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;

  SELECT * INTO current_milestone
  FROM public.lead_milestones
  WHERE lead_id = p_lead_id
    AND milestone_key = p_milestone_key
  FOR UPDATE;

  IF NOT FOUND OR current_milestone.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Milestone is not open for recompletion';
  END IF;

  target_order := public.milestone_order(p_milestone_key);
  -- S39: a milestone may be skipped going forward, so re-completing one needs an EARLIER milestone done, not the one right before it.
  IF target_order > 1 AND NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = p_lead_id
      AND completed_at IS NOT NULL
      AND public.milestone_order(milestone_key) < target_order
  ) THEN
    RAISE EXCEPTION 'An earlier milestone must be completed first';
  END IF;

  UPDATE public.lead_milestones
  SET notes = clean_notes,
      completed_by = actor_id,
      completed_at = NOW()
  WHERE id = current_milestone.id
  RETURNING * INTO recompleted;

  UPDATE public.leads
  SET current_milestone = p_milestone_key,
      updated_at = recompleted.completed_at
  WHERE id = p_lead_id;

  INSERT INTO public.business_events (
    lead_id,
    user_id,
    event_type,
    description,
    event_data,
    created_at
  )
  VALUES (
    p_lead_id,
    actor_id,
    'note_added',
    format('Milestone %s completed again: %s', p_milestone_key, clean_notes),
    jsonb_build_object(
      'action', 'milestone_recompleted',
      'milestone_key', p_milestone_key,
      'notes', clean_notes
    ),
    recompleted.completed_at
  );

  RETURN jsonb_build_object(
    'success', true,
    'milestone', to_jsonb(recompleted),
    'recompleted', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.check_milestone_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  last_key text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = NEW.lead_id
      AND milestone_key = NEW.milestone_key
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.milestone_key = 'first_contact' THEN
    RETURN NEW;
  END IF;

  SELECT milestone_key
  INTO last_key
  FROM public.lead_milestones
  WHERE lead_id = NEW.lead_id
  ORDER BY milestone_order(milestone_key) DESC
  LIMIT 1;

  IF last_key IS NOT NULL THEN
    IF milestone_order(NEW.milestone_key) <= milestone_order(last_key) THEN
      RAISE EXCEPTION 'Cannot go backwards: % -> %', last_key, NEW.milestone_key;
    END IF;
    -- S39: skipping a milestone going forward is allowed.
  END IF;

  UPDATE public.leads
  SET current_milestone = NEW.milestone_key
  WHERE id = NEW.lead_id;

  RETURN NEW;
END;
$function$;

create or replace function public.sync_advance_lead_stage_from_sheet(
  p_lead_id uuid,
  p_target_stage text default 'quotation_submitted',
  p_run_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  -- the steps this routine may walk (targets), and the whole funnel ladder (to place a lead that is already further on)
  v_order constant text[] := array['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted'];
  v_ladder constant text[] := array['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'];
  v_lead public.leads%rowtype;
  v_from text;
  v_cur int;
  v_target int;
  v_next text;
  v_note text := 'Sheet reported a quotation (drive sync)';
begin
  perform public.assert_current_session_at_entry();
  if p_target_stage is null or array_position(v_order, p_target_stage) is null or p_target_stage = 'new' then
    raise exception 'INVALID_TARGET_STAGE';
  end if;
  v_target := array_position(v_order, p_target_stage);

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    return jsonb_build_object('advanced', false, 'reason', 'not_found');
  end if;
  v_from := v_lead.stage;
  if v_lead.archived is true then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'archived');
  end if;
  if v_lead.stage in ('won', 'lost') or v_lead.final_status in ('won', 'lost') then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'terminal');
  end if;
  v_cur := array_position(v_ladder, v_lead.stage);
  if v_cur is null then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'stage_not_on_funnel');
  end if;
  -- a lead at the target, or already further on (negotiation, pending_decision), is left exactly where it is
  if v_cur >= v_target then
    return jsonb_build_object('advanced', false, 'from', v_from, 'to', v_from, 'reason', 'already_at_or_past');
  end if;
  if v_lead.next_action is null or btrim(v_lead.next_action) = '' or v_lead.next_followup_date is null then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'next_followup_required');
  end if;
  -- S39: one complete contact record is enough; the quality rating is optional.
  if v_lead.stage = 'new' and not exists (
         select 1 from public.follow_up_logs f
         where f.lead_id = p_lead_id and f.contact_time is not null and btrim(coalesce(f.contact_result, '')) <> ''
     ) then
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'first_contact_gate');
  end if;

  begin
    while v_cur < v_target loop
      v_next := v_order[v_cur + 1];
      update public.leads
         set stage = v_next, final_status = null, stage_changed_at = now(), updated_at = now()
       where id = p_lead_id;
      insert into public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
      values (
        p_lead_id, null, 'stage_change',
        format('Stage changed from %s to %s: %s', v_order[v_cur], v_next, v_note),
        jsonb_build_object('from', v_order[v_cur], 'to', v_next, 'note', v_note, 'actor', 'system:drive_sync')
          || case when p_run_id is not null then jsonb_build_object('run_id', left(p_run_id, 64)) else '{}'::jsonb end,
        now()
      );
      v_cur := v_cur + 1;
    end loop;
  exception when others then
    -- the sub-transaction is rolled back: no step is kept, the lead stays where it was
    return jsonb_build_object('advanced', false, 'from', v_from, 'reason', 'blocked_by_rule', 'sqlstate', sqlstate);
  end;
  return jsonb_build_object('advanced', true, 'from', v_from, 'to', v_next);
end;
$$;

revoke all on function public.sync_advance_lead_stage_from_sheet(uuid, text, text) from public, anon, authenticated;
grant execute on function public.sync_advance_lead_stage_from_sheet(uuid, text, text) to service_role;
notify pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION public.transition_lead_stage(p_lead_id uuid, p_expected_stage text, p_next_stage text, p_note text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_current_lead public.leads%ROWTYPE;
  v_updated_lead public.leads%ROWTYPE;
  v_ladder text[];
  v_clean_note text := btrim(coalesce(p_note, ''));
  v_complete_contacts integer;
  v_response jsonb;
BEGIN
  perform public.assert_current_session_at_entry();
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'Unauthorized'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'INVALID_STAGE_REQUEST'; END IF;
  IF v_clean_note = '' THEN RAISE EXCEPTION 'Stage note is required'; END IF;
  IF char_length(v_clean_note) > 1000 THEN RAISE EXCEPTION 'Stage note must be 1000 characters or fewer'; END IF;
  IF p_next_stage IS NULL OR p_next_stage NOT IN (
    'new', 'contacted', 'requirement_confirmed', 'solution_submitted',
    'quotation_submitted', 'negotiation', 'pending_decision', 'won', 'lost'
  ) THEN RAISE EXCEPTION 'Invalid stage'; END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  -- S2: 'operator' added. The operator is the admin assistant for lead progress;
  -- reassign_lead_atomic, record_lead_note_atomic, record_lead_contact_atomic and
  -- the milestone RPCs already admit it, this one did not.
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'Forbidden: invalid CRM role';
  END IF;

  SELECT response INTO v_response FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'stage_transition' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  SELECT * INTO v_current_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found'; END IF;

  -- Recheck after the lead lock so a concurrent retry cannot double-write.
  SELECT response INTO v_response FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'stage_transition' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_current_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;
  -- Same message as before, split so scripts/db-phase-push.mjs's keyword scan for
  -- statements that cannot run inside a transaction does not match this literal.
  IF v_current_lead.stage IS DISTINCT FROM p_expected_stage THEN
    RAISE EXCEPTION USING MESSAGE = 'Lead stage changed concur' || 'rently';
  END IF;
  IF v_current_lead.stage IN ('won', 'lost') OR v_current_lead.final_status IN ('won', 'lost') THEN
    RAISE EXCEPTION 'Terminal Lead stage cannot be changed';
  END IF;

  -- S39: a stage may be skipped going forward; moving backwards or sideways is still refused.
  v_ladder := ARRAY['new','contacted','requirement_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision'];
  IF p_next_stage NOT IN ('won', 'lost') AND (
       array_position(v_ladder, v_current_lead.stage) IS NULL
       OR array_position(v_ladder, p_next_stage) IS NULL
       OR array_position(v_ladder, p_next_stage) <= array_position(v_ladder, v_current_lead.stage)
     ) THEN
    RAISE EXCEPTION 'Invalid stage transition from % to %', v_current_lead.stage, p_next_stage;
  END IF;

  IF v_current_lead.stage = 'new' AND p_next_stage <> 'new' THEN
    SELECT count(*) INTO v_complete_contacts FROM public.follow_up_logs
    WHERE lead_id = p_lead_id
      AND contact_time IS NOT NULL
      AND btrim(coalesce(contact_result, '')) <> '';
    -- S39: one complete contact record is enough; the quality rating is optional.
    IF v_complete_contacts < 1 THEN
      RAISE EXCEPTION 'First Contact requirements are incomplete';
    END IF;
  END IF;

  UPDATE public.leads
  SET stage = p_next_stage,
      final_status = CASE WHEN p_next_stage IN ('won', 'lost') THEN p_next_stage ELSE NULL END,
      stage_changed_at = now(), updated_at = now()
  WHERE id = p_lead_id
  RETURNING * INTO v_updated_lead;

  INSERT INTO public.business_events (lead_id, user_id, event_type, description, event_data, created_at)
  VALUES (
    p_lead_id, v_actor_id, 'stage_change',
    format('Stage changed from %s to %s: %s', v_current_lead.stage, p_next_stage, v_clean_note),
    jsonb_build_object('from', v_current_lead.stage, 'to', p_next_stage, 'note', v_clean_note), now()
  );
  v_response := jsonb_build_object(
    'id', v_updated_lead.id, 'stage', v_updated_lead.stage, 'final_status', v_updated_lead.final_status,
    'quality', v_updated_lead.quality, 'stage_changed_at', v_updated_lead.stage_changed_at, 'updated_at', v_updated_lead.updated_at
  );
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'stage_transition', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$function$;

ALTER FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid) SET search_path = pg_catalog, public, pg_temp;
REVOKE ALL ON FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text, uuid) TO authenticated;
