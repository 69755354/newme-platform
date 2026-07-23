-- SAM-62: lead reassignment is one authorized, idempotent transaction.

CREATE TABLE IF NOT EXISTS public.lead_mutation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  operation text NOT NULL,
  idempotency_key uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_id, operation, idempotency_key)
);

ALTER TABLE public.lead_mutation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lead_mutation_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reassign_lead_atomic(
  p_lead_id uuid,
  p_new_assignee uuid,
  p_expected_updated_at timestamptz,
  p_idempotency_key uuid,
  p_reason text DEFAULT 'manual_reassign'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_target_active boolean;
  v_lead public.leads%ROWTYPE;
  v_response jsonb;
  v_reason text := left(btrim(coalesce(p_reason, 'manual_reassign')), 500);
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'INVALID_IDEMPOTENCY_KEY';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator') THEN
    RAISE EXCEPTION 'FORBIDDEN_REASSIGNMENT';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id
    AND operation = 'lead_reassignment'
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_response || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT role, is_active INTO v_target_role, v_target_active
  FROM public.profiles WHERE id = p_new_assignee;
  IF NOT FOUND OR coalesce(v_target_active, false) = false
     OR coalesce(v_target_role, '') NOT IN ('sales', 'operator', 'boss') THEN
    RAISE EXCEPTION 'INVALID_ASSIGNEE';
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;
  IF p_expected_updated_at IS NOT NULL AND v_lead.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'CONCURRENT_LEAD_UPDATE';
  END IF;

  IF v_lead.assigned_to IS NOT DISTINCT FROM p_new_assignee THEN
    v_response := jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'unchanged', true
    );
  ELSE
    UPDATE public.leads
    SET assigned_to = p_new_assignee,
        transfer_candidate = false,
        recovery_candidate = false,
        hold_since = NULL,
        updated_at = now()
    WHERE id = p_lead_id;

    INSERT INTO public.transfer_history (
      lead_id, from_user_id, to_user_id, reason, transferred_by
    ) VALUES (
      p_lead_id, v_lead.assigned_to, p_new_assignee, v_reason, v_actor_id
    );

    INSERT INTO public.activities (lead_id, user_id, type, content)
    VALUES (
      p_lead_id, v_actor_id, 'transfer',
      format('Lead reassigned from %s to %s', coalesce(v_lead.assigned_to::text, 'unassigned'), p_new_assignee::text)
    );

    INSERT INTO public.business_events (lead_id, user_id, event_type, description, event_data)
    VALUES (
      p_lead_id, v_actor_id, 'transfer', 'Lead reassigned',
      jsonb_build_object('from_user_id', v_lead.assigned_to, 'to_user_id', p_new_assignee, 'reason', v_reason)
    );

    INSERT INTO public.notifications (user_id, type, title, body, related_id, related_type)
    VALUES (
      p_new_assignee, 'lead_assigned', 'Lead assigned',
      coalesce(v_lead.customer_name, 'Lead') || ' was assigned to you.', p_lead_id::text, 'lead'
    );

    v_response := jsonb_build_object(
      'lead_id', p_lead_id,
      'assigned_to', p_new_assignee,
      'updated_at', (SELECT updated_at FROM public.leads WHERE id = p_lead_id),
      'unchanged', false
    );
  END IF;

  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_reassignment', p_idempotency_key, p_lead_id, v_response);

  RETURN v_response;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_lead_atomic(uuid, uuid, timestamptz, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_lead_note_atomic(
  p_lead_id uuid,
  p_note text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_note text := btrim(coalesce(p_note, ''));
  v_note_id uuid;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_idempotency_key IS NULL OR v_note = '' OR char_length(v_note) > 4000 THEN
    RAISE EXCEPTION 'INVALID_NOTE_REQUEST';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTE';
  END IF;

  SELECT response INTO v_response
  FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'lead_note' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_response || jsonb_build_object('idempotent_replay', true);
  END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND';
  END IF;
  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN_NOTE';
  END IF;

  INSERT INTO public.follow_up_logs (lead_id, user_id, contact_type, summary, contact_time, no_answer)
  VALUES (p_lead_id, v_actor_id, 'note', v_note, now(), false)
  RETURNING id INTO v_note_id;

  UPDATE public.leads SET last_contact_date = current_date, updated_at = now() WHERE id = p_lead_id;
  v_response := jsonb_build_object('lead_id', p_lead_id, 'note_id', v_note_id);
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_note', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_lead_note_atomic(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lead_note_atomic(uuid, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_lead_contact_atomic(
  p_lead_id uuid,
  p_contact_method text,
  p_contact_time timestamptz,
  p_contact_result text,
  p_summary text,
  p_contact_fingerprint text,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_id uuid := auth.uid();
  v_actor_role text;
  v_lead public.leads%ROWTYPE;
  v_contact_id uuid;
  v_response jsonb;
BEGIN
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_idempotency_key IS NULL
     OR p_contact_method NOT IN ('phone', 'whatsapp', 'other')
     OR btrim(coalesce(p_contact_result, '')) = ''
     OR p_contact_time IS NULL OR p_contact_time > now()
     OR btrim(coalesce(p_contact_fingerprint, '')) = '' THEN
    RAISE EXCEPTION 'INVALID_CONTACT_REQUEST';
  END IF;

  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor_id;
  IF coalesce(v_actor_role, '') NOT IN ('admin', 'boss', 'operator', 'sales', 'user', 'salesperson') THEN
    RAISE EXCEPTION 'FORBIDDEN_CONTACT';
  END IF;
  SELECT response INTO v_response FROM public.lead_mutation_requests
  WHERE actor_id = v_actor_id AND operation = 'lead_contact' AND idempotency_key = p_idempotency_key;
  IF FOUND THEN RETURN v_response || jsonb_build_object('idempotent_replay', true); END IF;

  SELECT * INTO v_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND'; END IF;
  IF v_actor_role NOT IN ('admin', 'boss', 'operator') AND v_lead.assigned_to IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION 'FORBIDDEN_CONTACT';
  END IF;

  INSERT INTO public.follow_up_logs (
    lead_id, user_id, contact_type, contact_time, contact_result, summary, no_answer, contact_fingerprint
  ) VALUES (
    p_lead_id, v_actor_id, p_contact_method, p_contact_time, btrim(p_contact_result),
    coalesce(nullif(btrim(coalesce(p_summary, '')), ''), btrim(p_contact_result)), false, p_contact_fingerprint
  ) ON CONFLICT (contact_fingerprint) DO UPDATE
    SET contact_fingerprint = EXCLUDED.contact_fingerprint
  RETURNING id INTO v_contact_id;

  UPDATE public.leads
  SET last_contact_date = greatest(coalesce(last_contact_date, p_contact_time::date), p_contact_time::date),
      updated_at = now()
  WHERE id = p_lead_id;
  v_response := jsonb_build_object('lead_id', p_lead_id, 'contact_id', v_contact_id);
  INSERT INTO public.lead_mutation_requests (actor_id, operation, idempotency_key, lead_id, response)
  VALUES (v_actor_id, 'lead_contact', p_idempotency_key, p_lead_id, v_response);
  RETURN v_response;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_lead_contact_atomic(uuid, text, timestamptz, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lead_contact_atomic(uuid, text, timestamptz, text, text, text, uuid) TO authenticated;
