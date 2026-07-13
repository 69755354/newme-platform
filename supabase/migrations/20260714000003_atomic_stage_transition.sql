-- Change a Lead stage and its audit note in one database transaction.
BEGIN;

CREATE OR REPLACE FUNCTION public.transition_lead_stage(
  p_lead_id uuid,
  p_expected_stage text,
  p_next_stage text,
  p_note text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_role text;
  current_lead public.leads%ROWTYPE;
  updated_lead public.leads%ROWTYPE;
  allowed_next_stage text;
  clean_note text := btrim(COALESCE(p_note, ''));
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT role INTO actor_role
  FROM public.profiles
  WHERE id = actor_id;

  IF actor_role IS NULL
     OR actor_role NOT IN ('admin', 'boss', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'Forbidden: invalid CRM role';
  END IF;

  IF p_next_stage IS NULL
     OR p_next_stage NOT IN (
    'new', 'contacted', 'requirement_confirmed', 'solution_submitted',
    'quotation_submitted', 'negotiation', 'pending_decision', 'won', 'lost'
  ) THEN
    RAISE EXCEPTION 'Invalid stage';
  END IF;

  IF char_length(clean_note) > 1000 THEN
    RAISE EXCEPTION 'Stage note must be 1000 characters or fewer';
  END IF;

  SELECT * INTO current_lead
  FROM public.leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lead not found';
  END IF;

  IF actor_role NOT IN ('admin', 'boss')
     AND current_lead.assigned_to IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION 'Forbidden: lead not assigned to you';
  END IF;

  IF current_lead.stage IS DISTINCT FROM p_expected_stage THEN
    RAISE EXCEPTION 'Lead stage changed concurrently';
  END IF;

  IF current_lead.stage IN ('won', 'lost')
     OR current_lead.final_status IN ('won', 'lost') THEN
    RAISE EXCEPTION 'Terminal Lead stage cannot be changed';
  END IF;

  allowed_next_stage := CASE current_lead.stage
    WHEN 'new' THEN 'contacted'
    WHEN 'contacted' THEN 'requirement_confirmed'
    WHEN 'requirement_confirmed' THEN 'solution_submitted'
    WHEN 'solution_submitted' THEN 'quotation_submitted'
    WHEN 'quotation_submitted' THEN 'negotiation'
    WHEN 'negotiation' THEN 'pending_decision'
    ELSE NULL
  END;

  IF p_next_stage NOT IN ('won', 'lost')
     AND p_next_stage IS DISTINCT FROM allowed_next_stage THEN
    RAISE EXCEPTION 'Invalid stage transition from % to %', current_lead.stage, p_next_stage;
  END IF;

  UPDATE public.leads
  SET stage = p_next_stage,
      final_status = CASE
        WHEN p_next_stage IN ('won', 'lost') THEN p_next_stage
        ELSE NULL
      END,
      stage_changed_at = NOW(),
      updated_at = NOW()
  WHERE id = p_lead_id
  RETURNING * INTO updated_lead;

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
    'stage_change',
    CASE
      WHEN clean_note <> '' THEN
        format('Stage changed from %s to %s: %s', current_lead.stage, p_next_stage, clean_note)
      ELSE
        format('Stage changed from %s to %s', current_lead.stage, p_next_stage)
    END,
    jsonb_build_object('from', current_lead.stage, 'to', p_next_stage)
      || CASE WHEN clean_note <> '' THEN jsonb_build_object('note', clean_note) ELSE '{}'::jsonb END,
    NOW()
  );

  RETURN jsonb_build_object(
    'id', updated_lead.id,
    'stage', updated_lead.stage,
    'final_status', updated_lead.final_status,
    'quality', updated_lead.quality,
    'stage_changed_at', updated_lead.stage_changed_at,
    'updated_at', updated_lead.updated_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.transition_lead_stage(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_lead_stage(uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.transition_lead_stage(uuid, text, text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
