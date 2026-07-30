BEGIN;

CREATE OR REPLACE FUNCTION public.start_support_session_atomic(
  p_actor_user_id uuid,
  p_approver_user_id uuid,
  p_organization_id uuid,
  p_ticket_ref text,
  p_reason text,
  p_scope jsonb,
  p_expires_at timestamptz,
  p_request_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_staff_id uuid;
  v_approver_staff_id uuid;
  v_session_id uuid;
  v_now timestamptz := statement_timestamp();
BEGIN
  SELECT staff.id
  INTO v_actor_staff_id
  FROM public.platform_staff AS staff
  JOIN public.profiles AS profile
    ON profile.id = staff.user_id
   AND profile.is_active IS TRUE
  WHERE staff.user_id = p_actor_user_id
    AND staff.status = 'active';

  IF v_actor_staff_id IS NULL THEN
    RAISE EXCEPTION 'platform_staff_required';
  END IF;

  SELECT staff.id
  INTO v_approver_staff_id
  FROM public.platform_staff AS staff
  JOIN public.profiles AS profile
    ON profile.id = staff.user_id
   AND profile.is_active IS TRUE
  WHERE staff.user_id = p_approver_user_id
    AND staff.status = 'active'
    AND staff.id <> v_actor_staff_id;

  IF v_approver_staff_id IS NULL THEN
    RAISE EXCEPTION 'independent_support_approver_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE id = p_organization_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'active_support_organization_required';
  END IF;

  IF p_ticket_ref IS NULL
    OR btrim(p_ticket_ref) = ''
    OR char_length(btrim(p_ticket_ref)) > 200
  THEN
    RAISE EXCEPTION 'support_ticket_ref_required';
  END IF;

  IF p_reason IS NULL
    OR btrim(p_reason) = ''
    OR char_length(btrim(p_reason)) > 1000
  THEN
    RAISE EXCEPTION 'support_reason_required';
  END IF;

  IF p_request_id IS NULL
    OR btrim(p_request_id) = ''
    OR char_length(btrim(p_request_id)) > 200
  THEN
    RAISE EXCEPTION 'support_request_id_required';
  END IF;

  IF jsonb_typeof(p_scope) <> 'array'
    OR jsonb_array_length(p_scope) = 0
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_scope) AS item(value)
      WHERE jsonb_typeof(item.value) <> 'string'
        OR item.value #>> '{}' NOT IN ('lead:read', 'lead:write')
    )
  THEN
    RAISE EXCEPTION 'support_scope_invalid';
  END IF;

  IF p_expires_at IS NULL
    OR p_expires_at <= v_now
    OR p_expires_at > v_now + interval '4 hours'
  THEN
    RAISE EXCEPTION 'support_expiry_invalid';
  END IF;

  INSERT INTO public.support_sessions (
    organization_id,
    platform_staff_id,
    ticket_ref,
    reason,
    scope,
    status,
    requested_at,
    approved_by_platform_staff_id,
    approved_at,
    expires_at
  )
  VALUES (
    p_organization_id,
    v_actor_staff_id,
    btrim(p_ticket_ref),
    btrim(p_reason),
    p_scope,
    'active',
    v_now,
    v_approver_staff_id,
    v_now,
    p_expires_at
  )
  RETURNING id INTO v_session_id;

  INSERT INTO public.audit_events (
    organization_id,
    actor_user_id,
    actor_platform_staff_id,
    support_session_id,
    action,
    target_type,
    target_id,
    outcome,
    reason,
    request_id,
    metadata
  )
  VALUES (
    p_organization_id,
    p_actor_user_id,
    v_actor_staff_id,
    v_session_id,
    'support.session.start',
    'support_session',
    v_session_id::text,
    'success',
    btrim(p_reason),
    btrim(p_request_id),
    jsonb_build_object(
      'ticket_ref', btrim(p_ticket_ref),
      'scope', p_scope,
      'expires_at', p_expires_at
    )
  );

  RETURN v_session_id;
END
$$;

CREATE OR REPLACE FUNCTION public.end_support_session_atomic(
  p_actor_user_id uuid,
  p_support_session_id uuid,
  p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_actor_staff_id uuid;
  v_session public.support_sessions%ROWTYPE;
  v_now timestamptz := statement_timestamp();
BEGIN
  IF p_request_id IS NULL
    OR btrim(p_request_id) = ''
    OR char_length(btrim(p_request_id)) > 200
  THEN
    RAISE EXCEPTION 'support_request_id_required';
  END IF;

  SELECT staff.id
  INTO v_actor_staff_id
  FROM public.platform_staff AS staff
  JOIN public.profiles AS profile
    ON profile.id = staff.user_id
   AND profile.is_active IS TRUE
  WHERE staff.user_id = p_actor_user_id
    AND staff.status = 'active';

  IF v_actor_staff_id IS NULL THEN
    RAISE EXCEPTION 'platform_staff_required';
  END IF;

  SELECT session.*
  INTO v_session
  FROM public.support_sessions AS session
  WHERE session.id = p_support_session_id
    AND session.platform_staff_id = v_actor_staff_id
  FOR UPDATE;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'support_session_not_authorized';
  END IF;

  IF v_session.status <> 'active'
    OR v_session.revoked_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'support_session_not_active';
  END IF;

  INSERT INTO public.audit_events (
    organization_id,
    actor_user_id,
    actor_platform_staff_id,
    support_session_id,
    action,
    target_type,
    target_id,
    outcome,
    reason,
    request_id,
    metadata
  )
  VALUES (
    v_session.organization_id,
    p_actor_user_id,
    v_actor_staff_id,
    v_session.id,
    'support.session.end',
    'support_session',
    v_session.id::text,
    'success',
    'support_session_closed',
    btrim(p_request_id),
    jsonb_build_object('started_at', v_session.requested_at)
  );

  UPDATE public.support_sessions
  SET
    status = 'revoked',
    revoked_at = v_now
  WHERE id = v_session.id;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.start_support_session_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  jsonb,
  timestamptz,
  text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.end_support_session_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_support_session_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  jsonb,
  timestamptz,
  text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.end_support_session_atomic(uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.start_support_session_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  jsonb,
  timestamptz,
  text
) IS 'SAM-14: activates approved cross-organization support only in the same transaction as its start audit.';
COMMENT ON FUNCTION public.end_support_session_atomic(uuid, uuid, text)
  IS 'SAM-14: revokes a support session only in the same transaction as its end audit.';

COMMIT;
