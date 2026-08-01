-- Organization customer-exit lifecycle.
--
-- Exit is intentionally non-destructive: the customer first enters a
-- read-only state, receives a deterministic export, and is only then closed.
-- Physical deletion remains a separately approved retention operation.

BEGIN;

CREATE TABLE public.organization_exit_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES public.organizations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'completed', 'cancelled')),
  requested_by_platform_staff_id uuid NOT NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  approved_by_platform_staff_id uuid NOT NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  previous_organization_status text NOT NULL
    CHECK (previous_organization_status IN ('active', 'suspended')),
  export_sha256 text NULL
    CHECK (export_sha256 IS NULL OR export_sha256 ~ '^[0-9a-f]{64}$'),
  backup_evidence_ref text NULL,
  customer_confirmation_ref text NULL,
  retention_basis text NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_exit_independent_approval_check CHECK (
    requested_by_platform_staff_id <> approved_by_platform_staff_id
  ),
  CONSTRAINT organization_exit_completion_check CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  )
);

CREATE INDEX organization_exit_requests_org_status_idx
  ON public.organization_exit_requests (organization_id, status, created_at);

ALTER TABLE public.organization_exit_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organization_exit_requests
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.organization_exit_requests TO service_role;

-- This helper is deliberately not callable by any API role. Its SQL argument
-- is supplied only by the fixed export function below.
CREATE OR REPLACE FUNCTION public.organization_export_rows(
  p_query text,
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  result jsonb;
BEGIN
  EXECUTE format(
    'SELECT COALESCE('
      || 'jsonb_agg(to_jsonb(export_row) ORDER BY to_jsonb(export_row)::text), '
      || '''[]''::jsonb) FROM (%s) export_row',
    p_query
  )
  USING p_organization_id
  INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.organization_export_rows(text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.organization_customer_snapshot(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  tables jsonb;
  files jsonb;
  counts jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'organization_not_found';
  END IF;

  tables := jsonb_build_object(
    'organizations', public.organization_export_rows(
      'SELECT * FROM public.organizations WHERE id = $1',
      p_organization_id
    ),
    'memberships', public.organization_export_rows(
      'SELECT * FROM public.memberships WHERE organization_id = $1',
      p_organization_id
    ),
    'membership_roles', public.organization_export_rows(
      'SELECT role_link.* FROM public.membership_roles role_link '
        || 'JOIN public.memberships membership '
        || 'ON membership.id = role_link.membership_id '
        || 'WHERE membership.organization_id = $1',
      p_organization_id
    ),
    'roles', public.organization_export_rows(
      'SELECT role.* FROM public.roles role WHERE EXISTS ('
        || 'SELECT 1 FROM public.membership_roles role_link '
        || 'JOIN public.memberships membership '
        || 'ON membership.id = role_link.membership_id '
        || 'WHERE membership.organization_id = $1 '
        || 'AND role_link.role_id = role.id)',
      p_organization_id
    ),
    'profiles', public.organization_export_rows(
      'SELECT profile.id, profile.role, profile.full_name, profile.phone, '
        || 'profile.avatar_url, profile.created_at, profile.updated_at, '
        || 'profile.manager_id, profile.is_active, profile.last_active_at, '
        || 'profile.joined_at, profile.email, profile.password_changed_at, '
        || 'profile.force_password_change FROM public.profiles profile '
        || 'WHERE EXISTS (SELECT 1 FROM public.memberships membership '
        || 'WHERE membership.organization_id = $1 '
        || 'AND membership.user_id = profile.id)',
      p_organization_id
    ),
    'organization_provisioning_requests', public.organization_export_rows(
      'SELECT * FROM public.organization_provisioning_requests '
        || 'WHERE organization_id = $1',
      p_organization_id
    ),
    'organization_exit_requests', public.organization_export_rows(
      'SELECT * FROM public.organization_exit_requests '
        || 'WHERE organization_id = $1',
      p_organization_id
    ),
    'support_sessions', public.organization_export_rows(
      'SELECT * FROM public.support_sessions WHERE organization_id = $1',
      p_organization_id
    ),
    'audit_events', public.organization_export_rows(
      'SELECT * FROM public.audit_events WHERE organization_id = $1',
      p_organization_id
    ),
    'leads', public.organization_export_rows(
      'SELECT * FROM public.leads WHERE organization_id = $1',
      p_organization_id
    ),
    'activities', public.organization_export_rows(
      'SELECT activity.* FROM public.activities activity WHERE '
        || 'EXISTS (SELECT 1 FROM public.leads lead_row '
        || 'WHERE lead_row.id = activity.lead_id '
        || 'AND lead_row.organization_id = $1) OR '
        || 'EXISTS (SELECT 1 FROM public.contracts contract '
        || 'WHERE contract.id = activity.contract_id '
        || 'AND contract.organization_id = $1) OR '
        || 'EXISTS (SELECT 1 FROM public.quotations quotation '
        || 'WHERE quotation.id = activity.quotation_id '
        || 'AND quotation.organization_id = $1) OR '
        || 'EXISTS (SELECT 1 FROM public.projects project '
        || 'WHERE project.id = activity.project_id '
        || 'AND project.organization_id = $1)',
      p_organization_id
    ),
    'business_events', public.organization_export_rows(
      'SELECT child.* FROM public.business_events child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'chat_messages', public.organization_export_rows(
      'SELECT child.* FROM public.chat_messages child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'customers', public.organization_export_rows(
      'SELECT child.* FROM public.customers child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'follow_up_logs', public.organization_export_rows(
      'SELECT child.* FROM public.follow_up_logs child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'knx_designs', public.organization_export_rows(
      'SELECT child.* FROM public.knx_designs child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'lead_documents', public.organization_export_rows(
      'SELECT * FROM public.lead_documents WHERE organization_id = $1',
      p_organization_id
    ),
    'lead_files', public.organization_export_rows(
      'SELECT child.* FROM public.lead_files child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'lead_milestones', public.organization_export_rows(
      'SELECT child.* FROM public.lead_milestones child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'lead_mutation_requests', public.organization_export_rows(
      'SELECT child.* FROM public.lead_mutation_requests child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'lead_workflow_stages', public.organization_export_rows(
      'SELECT child.* FROM public.lead_workflow_stages child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'quotes', public.organization_export_rows(
      'SELECT quote.* FROM public.quotes quote WHERE '
        || 'EXISTS (SELECT 1 FROM public.leads lead_row '
        || 'WHERE lead_row.id = quote.lead_id '
        || 'AND lead_row.organization_id = $1) OR '
        || 'EXISTS (SELECT 1 FROM public.projects project '
        || 'WHERE project.id = quote.project_id '
        || 'AND project.organization_id = $1)',
      p_organization_id
    ),
    'transfer_history', public.organization_export_rows(
      'SELECT child.* FROM public.transfer_history child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'quotations', public.organization_export_rows(
      'SELECT * FROM public.quotations WHERE organization_id = $1',
      p_organization_id
    ),
    'contracts', public.organization_export_rows(
      'SELECT * FROM public.contracts WHERE organization_id = $1',
      p_organization_id
    ),
    'contract_approvals', public.organization_export_rows(
      'SELECT * FROM public.contract_approvals WHERE organization_id = $1',
      p_organization_id
    ),
    'installment_plans', public.organization_export_rows(
      'SELECT * FROM public.installment_plans WHERE organization_id = $1',
      p_organization_id
    ),
    'payments', public.organization_export_rows(
      'SELECT * FROM public.payments WHERE organization_id = $1',
      p_organization_id
    ),
    'payment_allocations', public.organization_export_rows(
      'SELECT * FROM public.payment_allocations WHERE organization_id = $1',
      p_organization_id
    ),
    'projects', public.organization_export_rows(
      'SELECT * FROM public.projects WHERE organization_id = $1',
      p_organization_id
    ),
    'tasks', public.organization_export_rows(
      'SELECT * FROM public.tasks WHERE organization_id = $1',
      p_organization_id
    ),
    'crm_daily_funnel_snapshot', public.organization_export_rows(
      'SELECT * FROM public.crm_daily_funnel_snapshot '
        || 'WHERE organization_id = $1',
      p_organization_id
    ),
    'products', public.organization_export_rows(
      'SELECT * FROM public.products WHERE tenant_id = $1',
      p_organization_id
    ),
    'activity_logs', public.organization_export_rows(
      'SELECT * FROM public.activity_logs WHERE tenant_id = $1',
      p_organization_id
    ),
    'user_session_daily', public.organization_export_rows(
      'SELECT * FROM public.user_session_daily WHERE tenant_id = $1',
      p_organization_id
    ),
    'notifications', public.organization_export_rows(
      'SELECT notification.* FROM public.notifications notification '
        || 'WHERE EXISTS (SELECT 1 FROM public.leads lead_row '
        || 'WHERE lead_row.organization_id = $1 '
        || 'AND lead_row.id::text = notification.related_id) OR '
        || 'EXISTS (SELECT 1 FROM public.quotations quotation '
        || 'WHERE quotation.organization_id = $1 '
        || 'AND quotation.id::text = notification.related_id) OR '
        || 'EXISTS (SELECT 1 FROM public.contracts contract '
        || 'WHERE contract.organization_id = $1 '
        || 'AND contract.id::text = notification.related_id) OR '
        || 'EXISTS (SELECT 1 FROM public.payments payment '
        || 'WHERE payment.organization_id = $1 '
        || 'AND payment.id::text = notification.related_id) OR '
        || 'EXISTS (SELECT 1 FROM public.projects project '
        || 'WHERE project.organization_id = $1 '
        || 'AND project.id::text = notification.related_id) OR '
        || 'EXISTS (SELECT 1 FROM public.tasks task '
        || 'WHERE task.organization_id = $1 '
        || 'AND task.id::text = notification.related_id)',
      p_organization_id
    ),
    'user_features', public.organization_export_rows(
      'SELECT feature.* FROM public.user_features feature WHERE EXISTS ('
        || 'SELECT 1 FROM public.memberships membership '
        || 'WHERE membership.organization_id = $1 '
        || 'AND membership.user_id = feature.user_id)',
      p_organization_id
    )
  );

  SELECT COALESCE(jsonb_object_agg(entry.key, jsonb_array_length(entry.value)),
                  '{}'::jsonb)
  INTO counts
  FROM jsonb_each(tables) entry;

  files := jsonb_build_object(
    'lead_documents', public.organization_export_rows(
      'SELECT id, lead_id, file_name, file_url, file_size '
        || 'FROM public.lead_documents WHERE organization_id = $1 '
        || 'AND file_url IS NOT NULL',
      p_organization_id
    ),
    'lead_files', public.organization_export_rows(
      'SELECT child.id, child.lead_id, child.file_name, child.file_path, '
        || 'child.file_size, child.mime_type FROM public.lead_files child '
        || 'JOIN public.leads lead_row ON lead_row.id = child.lead_id '
        || 'WHERE lead_row.organization_id = $1',
      p_organization_id
    ),
    'quotations', public.organization_export_rows(
      'SELECT id, pdf_url, ppt_url FROM public.quotations '
        || 'WHERE organization_id = $1 '
        || 'AND (pdf_url IS NOT NULL OR ppt_url IS NOT NULL)',
      p_organization_id
    ),
    'contracts', public.organization_export_rows(
      'SELECT id, file_url, sealed_file_url FROM public.contracts '
        || 'WHERE organization_id = $1 '
        || 'AND (file_url IS NOT NULL OR sealed_file_url IS NOT NULL)',
      p_organization_id
    ),
    'projects', public.organization_export_rows(
      'SELECT id, cad_url, quote_url, ppt_url, contract_url '
        || 'FROM public.projects WHERE organization_id = $1 '
        || 'AND (cad_url IS NOT NULL OR quote_url IS NOT NULL '
        || 'OR ppt_url IS NOT NULL OR contract_url IS NOT NULL)',
      p_organization_id
    )
  );

  RETURN jsonb_build_object(
    'contract_version', 1,
    'organization_id', p_organization_id,
    'tables', tables,
    'counts', counts,
    'files', files,
    'shared_reference_tables', jsonb_build_array(
      'pipeline_stages', 'roles', 'profiles', 'user_features'
    ),
    'legacy_unscoped_tables', jsonb_build_array(
      'ad_spend', 'audit_logs', 'kpi_targets', 'lead_assignment_state'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.organization_customer_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.organization_customer_snapshot(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.export_organization_customer_data(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  snapshot jsonb;
  digest_value text;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_request_id IS NULL OR length(btrim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'export_request_id_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships membership
    JOIN public.profiles profile ON profile.id = membership.user_id
    WHERE membership.organization_id = p_organization_id
      AND membership.user_id = p_actor_user_id
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND profile.is_active IS TRUE
      AND profile.role IN ('admin', 'boss')
  ) THEN
    RAISE EXCEPTION 'organization_export_owner_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_organization_id
      AND status IN ('active', 'read_only', 'suspended')
  ) THEN
    RAISE EXCEPTION 'organization_export_unavailable';
  END IF;

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, 'organization.customer_export',
    'organization', p_organization_id::text, 'success',
    'authorized_customer_export', p_request_id,
    jsonb_build_object('contract_version', 1)
  );

  snapshot := public.organization_customer_snapshot(p_organization_id);
  digest_value := encode(
    extensions.digest(convert_to(snapshot::text, 'UTF8'), 'sha256'),
    'hex'
  );
  RETURN jsonb_build_object(
    'contract_version', 1,
    'generated_at', clock_timestamp(),
    'digest_algorithm', 'sha256',
    'data_sha256', digest_value,
    'data', snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION public.export_organization_customer_data(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.export_organization_customer_data(uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_organization_customer_exit(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_approver_user_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_staff_id uuid;
  approver_staff_id uuid;
  exit_request public.organization_exit_requests%ROWTYPE;
  previous_status text;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_actor_user_id = p_approver_user_id THEN
    RAISE EXCEPTION 'independent_exit_approver_required';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'exit_idempotency_key_required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 12 THEN
    RAISE EXCEPTION 'exit_reason_required';
  END IF;
  IF p_request_id IS NULL OR length(btrim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'exit_request_id_required';
  END IF;

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
  WHERE idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF exit_request.organization_id <> p_organization_id
      OR exit_request.requested_by_platform_staff_id <> actor_staff_id
      OR exit_request.approved_by_platform_staff_id <> approver_staff_id
      OR exit_request.reason <> btrim(p_reason)
    THEN
      RAISE EXCEPTION 'exit_idempotency_payload_mismatch';
    END IF;
    RETURN jsonb_build_object(
      'exit_request_id', exit_request.id,
      'organization_id', exit_request.organization_id,
      'status', exit_request.status,
      'idempotent', true
    );
  END IF;

  SELECT status INTO previous_status FROM public.organizations
  WHERE id = p_organization_id AND status IN ('active', 'suspended')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization_exit_not_preparable'; END IF;

  UPDATE public.organizations
  SET status = 'read_only', updated_at = now()
  WHERE id = p_organization_id;

  INSERT INTO public.organization_exit_requests (
    organization_id, idempotency_key, requested_by_platform_staff_id,
    approved_by_platform_staff_id, reason, previous_organization_status
  ) VALUES (
    p_organization_id, btrim(p_idempotency_key), actor_staff_id,
    approver_staff_id, btrim(p_reason), previous_status
  ) RETURNING * INTO exit_request;

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, actor_platform_staff_id, action,
    target_type, target_id, outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, actor_staff_id,
    'organization.exit_prepared', 'organization', p_organization_id::text,
    'success', btrim(p_reason), p_request_id,
    jsonb_build_object(
      'exit_request_id', exit_request.id,
      'approver_platform_staff_id', approver_staff_id,
      'previous_status', previous_status,
      'new_status', 'read_only'
    )
  );

  RETURN jsonb_build_object(
    'exit_request_id', exit_request.id,
    'organization_id', p_organization_id,
    'status', 'prepared',
    'organization_status', 'read_only',
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_organization_customer_exit(
  uuid, uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_organization_customer_exit(
  uuid, uuid, uuid, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_organization_customer_exit(
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
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_staff_id uuid;
  approver_staff_id uuid;
  exit_request public.organization_exit_requests%ROWTYPE;
  snapshot jsonb;
  current_digest text;
  membership_count integer;
  role_count integer;
  support_count integer;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN
    RAISE EXCEPTION 'service_role_required';
  END IF;
  IF p_actor_user_id = p_approver_user_id THEN
    RAISE EXCEPTION 'independent_exit_approver_required';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'exit_idempotency_key_required';
  END IF;
  IF p_expected_export_sha256 IS NULL
    OR p_expected_export_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'valid_export_sha256_required';
  END IF;
  IF LEAST(
    length(btrim(COALESCE(p_backup_evidence_ref, ''))),
    length(btrim(COALESCE(p_customer_confirmation_ref, ''))),
    length(btrim(COALESCE(p_retention_basis, ''))),
    length(btrim(COALESCE(p_request_id, '')))
  ) < 8 THEN
    RAISE EXCEPTION 'exit_completion_evidence_required';
  END IF;

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
    THEN
      RAISE EXCEPTION 'exit_idempotency_payload_mismatch';
    END IF;
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
  THEN
    RAISE EXCEPTION 'exit_approval_identity_mismatch';
  END IF;

  snapshot := public.organization_customer_snapshot(p_organization_id);
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
  WHERE organization_id = p_organization_id
    AND status <> 'inactive';
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
    'data_deleted', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.organization_lifecycle_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  row_data jsonb := CASE WHEN TG_OP = 'DELETE'
    THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  target_organization_id uuid;
BEGIN
  IF row_data ? 'organization_id' THEN
    target_organization_id := NULLIF(row_data ->> 'organization_id', '')::uuid;
  ELSIF row_data ? 'tenant_id' THEN
    target_organization_id := NULLIF(row_data ->> 'tenant_id', '')::uuid;
  ELSIF row_data ? 'lead_id' THEN
    SELECT lead_row.organization_id INTO target_organization_id
    FROM public.leads lead_row
    WHERE lead_row.id = NULLIF(row_data ->> 'lead_id', '')::uuid;
  END IF;

  IF target_organization_id IS NULL AND TG_TABLE_NAME = 'activities' THEN
    SELECT parent.organization_id INTO target_organization_id
    FROM (
      SELECT organization_id FROM public.contracts
      WHERE id = NULLIF(row_data ->> 'contract_id', '')::uuid
      UNION ALL
      SELECT organization_id FROM public.quotations
      WHERE id = NULLIF(row_data ->> 'quotation_id', '')::uuid
      UNION ALL
      SELECT organization_id FROM public.projects
      WHERE id = NULLIF(row_data ->> 'project_id', '')::uuid
    ) parent
    LIMIT 1;
  END IF;
  IF target_organization_id IS NULL AND TG_TABLE_NAME = 'quotes' THEN
    SELECT project.organization_id INTO target_organization_id
    FROM public.projects project
    WHERE project.id = NULLIF(row_data ->> 'project_id', '')::uuid;
  END IF;
  IF target_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_lifecycle_context_missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = target_organization_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'organization_is_not_writable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.organization_lifecycle_write_guard()
  FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'leads', 'activities', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'lead_documents', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'quotes', 'transfer_history', 'quotations', 'contracts',
    'contract_approvals', 'installment_plans', 'payments',
    'payment_allocations', 'projects', 'tasks',
    'crm_daily_funnel_snapshot', 'products', 'activity_logs',
    'user_session_daily'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS zz_organization_lifecycle_write_guard ON public.%I',
        table_name
      );
      EXECUTE format(
        'CREATE TRIGGER zz_organization_lifecycle_write_guard '
          || 'BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
          || 'FOR EACH ROW EXECUTE FUNCTION '
          || 'public.organization_lifecycle_write_guard()',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
