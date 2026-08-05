-- Correct SAM-10 RPC validation to use canonical Lead milestone keys.\n-- PostgreSQL functions must be replaced as a whole, so both definitions are repeated.
BEGIN;

CREATE OR REPLACE FUNCTION public.reopen_lead_milestone(
  p_lead_id uuid,
  p_milestone_key text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  current_lead public.leads%ROWTYPE;
  target_order integer;
  previous_key text;
  clean_reason text := btrim(COALESCE(p_reason, ''));
  affected jsonb;
BEGIN
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

  IF clean_reason = '' THEN
    RAISE EXCEPTION 'Reopen reason is required';
  END IF;
  IF char_length(clean_reason) > 1000 THEN
    RAISE EXCEPTION 'Reopen reason must be 1000 characters or fewer';
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

  target_order := public.milestone_order(p_milestone_key);

  IF NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = p_lead_id
      AND milestone_key = p_milestone_key
      AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Milestone is not completed';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'milestone_key', milestone_key,
      'notes', notes,
      'completed_at', completed_at,
      'completed_by', completed_by
    )
    ORDER BY public.milestone_order(milestone_key)
  )
  INTO affected
  FROM public.lead_milestones
  WHERE lead_id = p_lead_id
    AND completed_at IS NOT NULL
    AND public.milestone_order(milestone_key) >= target_order;

  UPDATE public.lead_milestones
  SET completed_at = NULL,
      completed_by = NULL
  WHERE lead_id = p_lead_id
    AND completed_at IS NOT NULL
    AND public.milestone_order(milestone_key) >= target_order;

  SELECT milestone_key
  INTO previous_key
  FROM public.lead_milestones
  WHERE lead_id = p_lead_id
    AND completed_at IS NOT NULL
  ORDER BY public.milestone_order(milestone_key) DESC
  LIMIT 1;

  UPDATE public.leads
  SET current_milestone = previous_key,
      updated_at = NOW()
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
    'status_changed',
    format('Milestone %s reopened: %s', p_milestone_key, clean_reason),
    jsonb_build_object(
      'action', 'milestone_reopened',
      'milestone_key', p_milestone_key,
      'reason', clean_reason,
      'affected', COALESCE(affected, '[]'::jsonb),
      'current_milestone', previous_key
    ),
    NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'milestone_key', p_milestone_key,
    'current_milestone', previous_key,
    'affected', COALESCE(affected, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reopen_lead_milestone(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reopen_lead_milestone(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reopen_lead_milestone(uuid, text, text) TO authenticated;


CREATE OR REPLACE FUNCTION public.recomplete_lead_milestone(
  p_lead_id uuid,
  p_milestone_key text,
  p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  current_lead public.leads%ROWTYPE;
  current_milestone public.lead_milestones%ROWTYPE;
  recompleted public.lead_milestones%ROWTYPE;
  target_order integer;
  clean_notes text := btrim(COALESCE(p_notes, ''));
BEGIN
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
  IF target_order > 1 AND NOT EXISTS (
    SELECT 1
    FROM public.lead_milestones
    WHERE lead_id = p_lead_id
      AND completed_at IS NOT NULL
      AND public.milestone_order(milestone_key) = target_order - 1
  ) THEN
    RAISE EXCEPTION 'Previous milestone must be completed first';
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

REVOKE ALL ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.recomplete_lead_milestone(uuid, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
