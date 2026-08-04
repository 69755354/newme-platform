-- Keep the V4 customer-export digest valid across the export audit write while
-- still rejecting every other organization snapshot change before closure.

BEGIN;

CREATE OR REPLACE FUNCTION public.v4_complete_organization_customer_exit(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_approver_user_id uuid,
  p_idempotency_key text,
  p_expected_export_sha256 text,
  p_backup_evidence_ref text,
  p_customer_confirmation_ref text,
  p_retention_basis text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_staff_id uuid;
  approver_staff_id uuid;
  exit_request public.organization_exit_requests%ROWTYPE;
  snapshot jsonb;
  audit_rows jsonb;
  export_audit_event_id uuid;
  export_audit_event_count integer;
  current_digest text;
  membership_count integer;
  role_count integer;
  support_count integer;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_actor_user_id = p_approver_user_id THEN
    RAISE EXCEPTION 'independent_exit_approver_required';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'exit_idempotency_key_required';
  END IF;
  IF p_expected_export_sha256 IS NULL
    OR p_expected_export_sha256 !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'valid_export_sha256_required'; END IF;
  IF LEAST(
    length(btrim(COALESCE(p_backup_evidence_ref, ''))),
    length(btrim(COALESCE(p_customer_confirmation_ref, ''))),
    length(btrim(COALESCE(p_retention_basis, ''))),
    length(btrim(COALESCE(p_request_id, '')))
  ) < 8 THEN RAISE EXCEPTION 'exit_completion_evidence_required'; END IF;

  SELECT id INTO actor_staff_id FROM public.platform_staff
  WHERE user_id = p_actor_user_id AND status = 'active';
  SELECT id INTO approver_staff_id FROM public.platform_staff
  WHERE user_id = p_approver_user_id AND status = 'active';
  IF actor_staff_id IS NULL THEN RAISE EXCEPTION 'platform_staff_required'; END IF;
  IF approver_staff_id IS NULL THEN
    RAISE EXCEPTION 'independent_exit_approver_required';
  END IF;

  SELECT * INTO exit_request
  FROM public.organization_exit_requests
  WHERE organization_id = p_organization_id
    AND idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND AND exit_request.status = 'completed' THEN
    IF exit_request.requested_by_platform_staff_id <> actor_staff_id
      OR exit_request.approved_by_platform_staff_id <> approver_staff_id
      OR exit_request.export_sha256 IS DISTINCT FROM p_expected_export_sha256
      OR exit_request.backup_evidence_ref IS DISTINCT FROM btrim(p_backup_evidence_ref)
      OR exit_request.customer_confirmation_ref IS DISTINCT FROM btrim(p_customer_confirmation_ref)
      OR exit_request.retention_basis IS DISTINCT FROM btrim(p_retention_basis)
    THEN RAISE EXCEPTION 'exit_idempotency_payload_mismatch'; END IF;
    RETURN jsonb_build_object(
      'organization_id', p_organization_id,
      'exit_request_id', exit_request.id,
      'status', 'completed',
      'organization_status', 'closed',
      'export_sha256', exit_request.export_sha256,
      'data_deleted', false,
      'idempotent', true
    );
  END IF;

  PERFORM 1 FROM public.organizations
  WHERE id = p_organization_id AND status = 'read_only'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization_exit_not_completable'; END IF;
  IF exit_request.id IS NULL OR exit_request.status <> 'prepared' THEN
    RAISE EXCEPTION 'prepared_exit_request_required';
  END IF;
  IF exit_request.requested_by_platform_staff_id <> actor_staff_id
    OR exit_request.approved_by_platform_staff_id <> approver_staff_id
  THEN RAISE EXCEPTION 'exit_approval_identity_mismatch'; END IF;

  SELECT count(*), (array_agg(event.id ORDER BY event.occurred_at DESC, event.id DESC))[1]
  INTO export_audit_event_count, export_audit_event_id
  FROM public.audit_events event
  WHERE event.organization_id = p_organization_id
    AND event.action = 'organization.customer_export.v4'
    AND event.outcome = 'success'
    AND event.metadata ->> 'contract_version' = '2'
    AND event.metadata ->> 'data_sha256' = p_expected_export_sha256;
  IF export_audit_event_count <> 1 OR export_audit_event_id IS NULL THEN
    RAISE EXCEPTION 'v4_export_evidence_not_unique';
  END IF;

  snapshot := public.v4_organization_customer_snapshot(p_organization_id);
  SELECT COALESCE(jsonb_agg(row_value ORDER BY row_number), '[]'::jsonb)
  INTO audit_rows
  FROM jsonb_array_elements(snapshot #> '{tables,audit_events}')
    WITH ORDINALITY AS rows(row_value, row_number)
  WHERE row_value ->> 'id' <> export_audit_event_id::text;
  snapshot := jsonb_set(snapshot, '{tables,audit_events}', audit_rows, false);
  snapshot := jsonb_set(
    snapshot,
    '{counts,audit_events}',
    to_jsonb(jsonb_array_length(audit_rows)),
    false
  );
  current_digest := encode(
    extensions.digest(convert_to(snapshot::text, 'UTF8'), 'sha256'),
    'hex'
  );
  IF current_digest <> p_expected_export_sha256 THEN
    RAISE EXCEPTION 'organization_changed_after_export';
  END IF;

  UPDATE public.membership_roles role_link
  SET revoked_at = COALESCE(role_link.revoked_at, now())
  FROM public.memberships membership
  WHERE membership.id = role_link.membership_id
    AND membership.organization_id = p_organization_id
    AND role_link.revoked_at IS NULL;
  GET DIAGNOSTICS role_count = ROW_COUNT;

  UPDATE public.memberships
  SET status = 'inactive', deactivated_at = now(), updated_at = now(),
      version = version + 1
  WHERE organization_id = p_organization_id AND status <> 'inactive';
  GET DIAGNOSTICS membership_count = ROW_COUNT;

  UPDATE public.support_sessions
  SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
  WHERE organization_id = p_organization_id
    AND status IN ('requested', 'approved', 'active');
  GET DIAGNOSTICS support_count = ROW_COUNT;

  UPDATE public.organizations
  SET status = 'closed', closed_at = now(), updated_at = now()
  WHERE id = p_organization_id;

  UPDATE public.organization_exit_requests
  SET status = 'completed', export_sha256 = p_expected_export_sha256,
      backup_evidence_ref = btrim(p_backup_evidence_ref),
      customer_confirmation_ref = btrim(p_customer_confirmation_ref),
      retention_basis = btrim(p_retention_basis), completed_at = now()
  WHERE id = exit_request.id;

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, actor_platform_staff_id, action,
    target_type, target_id, outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, actor_staff_id,
    'organization.exit_completed', 'organization', p_organization_id::text,
    'success', exit_request.reason, p_request_id,
    jsonb_build_object(
      'exit_request_id', exit_request.id,
      'approver_platform_staff_id', approver_staff_id,
      'export_sha256', p_expected_export_sha256,
      'backup_evidence_ref', btrim(p_backup_evidence_ref),
      'customer_confirmation_ref', btrim(p_customer_confirmation_ref),
      'retention_basis', btrim(p_retention_basis),
      'memberships_deactivated', membership_count,
      'membership_roles_revoked', role_count,
      'support_sessions_revoked', support_count
    )
  );

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'exit_request_id', exit_request.id,
    'status', 'completed',
    'organization_status', 'closed',
    'export_sha256', p_expected_export_sha256,
    'memberships_deactivated', membership_count,
    'membership_roles_revoked', role_count,
    'support_sessions_revoked', support_count,
    'data_deleted', false,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
