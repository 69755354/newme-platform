\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id) VALUES
  ('78000000-1000-4000-8000-000000000001'),
  ('78000000-1000-4000-8000-000000000002');
INSERT INTO public.profiles(id, email, role, is_active) VALUES
  ('78000000-1000-4000-8000-000000000001', 'product-saas-11111111-1111-4111-8111-111111111111-admin@invalid.test', 'admin', false),
  ('78000000-1000-4000-8000-000000000002', 'product-saas-11111111-1111-4111-8111-111111111111-boss@invalid.test', 'boss', false);
INSERT INTO public.organizations(
  id, slug, name, industry_key, plan_key, billable_seat_limit,
  status, data_region, timezone
) VALUES (
  '78000000-1000-4000-8000-000000000010',
  'product-saas-11111111-1111-4111-8111-111111111111',
  '[PRODUCT-UAT 11111111-1111-4111-8111-111111111111] organization',
  'real_estate', 'growth', 20, 'active', 'uae', 'Asia/Dubai'
);
INSERT INTO public.memberships(
  id, organization_id, user_id, status, accepted_at
) VALUES
  ('78000000-1000-4000-8000-000000000011',
    '78000000-1000-4000-8000-000000000010',
    '78000000-1000-4000-8000-000000000001', 'active', now()),
  ('78000000-1000-4000-8000-000000000012',
    '78000000-1000-4000-8000-000000000010',
    '78000000-1000-4000-8000-000000000002', 'active', now());
INSERT INTO public.platform_staff(
  id, user_id, status, staff_ref, role_key
) VALUES
  ('78000000-1000-4000-8000-000000000021',
    '78000000-1000-4000-8000-000000000001', 'active',
    'EXIT-11111111-OP', 'platform_ops'),
  ('78000000-1000-4000-8000-000000000022',
    '78000000-1000-4000-8000-000000000002', 'active',
    'EXIT-11111111-APP', 'platform_owner');
INSERT INTO public.platform_action_approvals(
  id, action_key, target_key, payload, payload_hash, status,
  requested_by_platform_staff_id, approved_by_platform_staff_id,
  request_id, consumption_key, execution_result,
  approved_at, consumed_at
) VALUES (
  '78000000-1000-4000-8000-000000000030',
  'organization.exit.prepare',
  '78000000-1000-4000-8000-000000000010',
  jsonb_build_object(
    'organization_id', '78000000-1000-4000-8000-000000000010'::uuid,
    'idempotency_key', 'exit-11111111-1111-4111-8111-111111111111',
    'reason', 'Synthetic customer-approved staging exit verification'
  ),
  repeat('a', 64), 'consumed',
  '78000000-1000-4000-8000-000000000021',
  '78000000-1000-4000-8000-000000000022',
  'exit:prepare:exit-11111111-1111-4111-8111-111111111111',
  'exit-prepare-11111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'status', 'prepared',
    'organization_id', '78000000-1000-4000-8000-000000000010'::uuid,
    'organization_status', 'read_only',
    'exit_request_id', '78000000-1000-4000-8000-000000000031'::uuid
  ),
  now(), now()
);
INSERT INTO public.platform_action_approval_events(
  approval_request_id, actor_platform_staff_id, action, request_id
) VALUES
  ('78000000-1000-4000-8000-000000000030',
    '78000000-1000-4000-8000-000000000021',
    'requested', 'sam78-product-cleanup-requested'),
  ('78000000-1000-4000-8000-000000000030',
    '78000000-1000-4000-8000-000000000022',
    'approved', 'sam78-product-cleanup-approved'),
  ('78000000-1000-4000-8000-000000000030',
    '78000000-1000-4000-8000-000000000021',
    'consumed', 'sam78-product-cleanup-consumed');
INSERT INTO public.audit_events(
  id, organization_id, actor_user_id, actor_platform_staff_id,
  action, target_type, target_id, outcome, request_id, metadata
) VALUES
  ('78000000-1000-4000-8000-000000000040',
    '78000000-1000-4000-8000-000000000010',
    '78000000-1000-4000-8000-000000000001', NULL,
    'lead.import', 'import_batch',
    '78000000-1000-4000-8000-000000000041',
    'success', 'sam78-product-cleanup-import',
    '{"imported":3,"notes_created":3,"skipped_duplicates":0}'::jsonb),
  ('78000000-1000-4000-8000-000000000042',
    '78000000-1000-4000-8000-000000000010',
    '78000000-1000-4000-8000-000000000001',
    '78000000-1000-4000-8000-000000000021',
    'organization.exit_prepared', 'organization',
    '78000000-1000-4000-8000-000000000010',
    'success',
    'approval-execute:78000000-1000-4000-8000-000000000030',
    '{"new_status":"read_only"}'::jsonb);

INSERT INTO public.audit_logs(
  id, actor_id, organization_id, action, details
) VALUES (
  '78000000-1000-4000-8000-000000000060',
  '78000000-1000-4000-8000-000000000001',
  '78000000-1000-4000-8000-000000000010',
  'PAGE_VISIT', '{"page":"/team"}'::jsonb
);

SET ROLE service_role;
DELETE FROM public.audit_logs
WHERE id = '78000000-1000-4000-8000-000000000060';
DELETE FROM public.audit_events
WHERE organization_id = '78000000-1000-4000-8000-000000000010';
DELETE FROM public.platform_action_approval_events
WHERE approval_request_id IN (
  '78000000-1000-4000-8000-000000000030'
);
DELETE FROM public.platform_action_approvals
WHERE target_key = '78000000-1000-4000-8000-000000000010';
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.audit_logs
    WHERE id = '78000000-1000-4000-8000-000000000060'
  ) OR EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE organization_id = '78000000-1000-4000-8000-000000000010'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_action_approval_events
    WHERE approval_request_id IN (
      '78000000-1000-4000-8000-000000000030'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.platform_action_approvals
    WHERE target_key = '78000000-1000-4000-8000-000000000010'
  ) THEN
    RAISE EXCEPTION 'SAM-78 exact Product/SaaS cleanup left immutable evidence';
  END IF;
END
$$;

-- Prove cleanup remains possible at every exact failure boundary.
INSERT INTO public.platform_action_approvals(
  id, action_key, target_key, payload, payload_hash, status,
  requested_by_platform_staff_id, request_id
) VALUES (
  '78000000-1000-4000-8000-000000000032',
  'organization.exit.prepare',
  '78000000-1000-4000-8000-000000000010',
  jsonb_build_object(
    'organization_id', '78000000-1000-4000-8000-000000000010'::uuid,
    'idempotency_key', 'exit-11111111-1111-4111-8111-111111111111',
    'reason', 'Synthetic customer-approved staging exit verification'
  ), repeat('b', 64), 'pending',
  '78000000-1000-4000-8000-000000000021',
  'exit:prepare:exit-11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.platform_action_approval_events(
  approval_request_id, actor_platform_staff_id, action, request_id
) VALUES (
  '78000000-1000-4000-8000-000000000032',
  '78000000-1000-4000-8000-000000000021',
  'requested', 'sam78-product-cleanup-pending-requested'
);
SET ROLE service_role;
DELETE FROM public.platform_action_approval_events
WHERE approval_request_id = '78000000-1000-4000-8000-000000000032';
DELETE FROM public.platform_action_approvals
WHERE id = '78000000-1000-4000-8000-000000000032';
RESET ROLE;

INSERT INTO public.platform_action_approvals(
  id, action_key, target_key, payload, payload_hash, status,
  requested_by_platform_staff_id, approved_by_platform_staff_id,
  request_id, approved_at
) VALUES (
  '78000000-1000-4000-8000-000000000033',
  'organization.exit.complete',
  '78000000-1000-4000-8000-000000000010',
  jsonb_build_object(
    'organization_id', '78000000-1000-4000-8000-000000000010'::uuid,
    'idempotency_key', 'exit-11111111-1111-4111-8111-111111111111',
    'expected_export_sha256', repeat('c', 64),
    'backup_evidence_ref', 'staging-backup-' || repeat('d', 40),
    'customer_confirmation_ref',
      'synthetic-confirmation-11111111-1111-4111-8111-111111111111',
    'retention_basis', 'synthetic-staging-seven-year-contractual-retention'
  ), repeat('e', 64), 'approved',
  '78000000-1000-4000-8000-000000000021',
  '78000000-1000-4000-8000-000000000022',
  'exit:complete:exit-11111111-1111-4111-8111-111111111111', now()
);
INSERT INTO public.platform_action_approval_events(
  approval_request_id, actor_platform_staff_id, action, request_id
) VALUES
  ('78000000-1000-4000-8000-000000000033',
    '78000000-1000-4000-8000-000000000021',
    'requested', 'sam78-product-cleanup-approved-requested'),
  ('78000000-1000-4000-8000-000000000033',
    '78000000-1000-4000-8000-000000000022',
    'approved', 'sam78-product-cleanup-approved-approved');
SET ROLE service_role;
DELETE FROM public.platform_action_approval_events
WHERE approval_request_id = '78000000-1000-4000-8000-000000000033';
DELETE FROM public.platform_action_approvals
WHERE id = '78000000-1000-4000-8000-000000000033';
RESET ROLE;

INSERT INTO public.platform_action_approvals(
  id, action_key, target_key, payload, payload_hash, status,
  requested_by_platform_staff_id, approved_by_platform_staff_id,
  request_id, consumption_key, execution_result, approved_at, consumed_at
) VALUES (
  '78000000-1000-4000-8000-000000000034',
  'organization.exit.complete',
  '78000000-1000-4000-8000-000000000010',
  jsonb_build_object(
    'organization_id', '78000000-1000-4000-8000-000000000010'::uuid,
    'idempotency_key', 'exit-11111111-1111-4111-8111-111111111111',
    'expected_export_sha256', repeat('f', 64),
    'backup_evidence_ref', 'staging-backup-' || repeat('a', 40),
    'customer_confirmation_ref',
      'synthetic-confirmation-11111111-1111-4111-8111-111111111111',
    'retention_basis', 'synthetic-staging-seven-year-contractual-retention'
  ), repeat('f', 64), 'consumed',
  '78000000-1000-4000-8000-000000000021',
  '78000000-1000-4000-8000-000000000022',
  'exit:complete:exit-11111111-1111-4111-8111-111111111111',
  'exit-complete-11111111-1111-4111-8111-111111111111',
  jsonb_build_object(
    'status', 'completed',
    'organization_id', '78000000-1000-4000-8000-000000000010'::uuid,
    'organization_status', 'closed'
  ), now(), now()
);
SET ROLE service_role;
DELETE FROM public.platform_action_approvals
WHERE id = '78000000-1000-4000-8000-000000000034';
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_action_approvals
    WHERE id IN (
      '78000000-1000-4000-8000-000000000032',
      '78000000-1000-4000-8000-000000000033',
      '78000000-1000-4000-8000-000000000034'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.platform_action_approval_events
    WHERE approval_request_id IN (
      '78000000-1000-4000-8000-000000000032',
      '78000000-1000-4000-8000-000000000033'
    )
  ) THEN
    RAISE EXCEPTION 'SAM-78 partial approval cleanup left immutable evidence';
  END IF;
END
$$;

INSERT INTO public.audit_events(
  id, organization_id, actor_user_id, action, target_type,
  target_id, outcome, request_id, metadata
) VALUES (
  '78000000-1000-4000-8000-000000000050',
  '78000000-1000-4000-8000-000000000010',
  '78000000-1000-4000-8000-000000000001',
  'organization.customer_export.v4', 'organization',
  '78000000-1000-4000-8000-000000000010',
  'success', 'sam78-product-cleanup-near-miss',
  '{"data_sha256":"not-a-digest"}'::jsonb
);
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    DELETE FROM public.audit_events
    WHERE id = '78000000-1000-4000-8000-000000000050';
    RAISE EXCEPTION 'near-miss Product/SaaS audit event was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'immutable_record' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;

DO $$
BEGIN
  IF pg_catalog.has_function_privilege(
      'anon', 'public.product_saas_is_synthetic_organization(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', 'public.product_saas_is_synthetic_organization(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', 'public.product_saas_is_synthetic_exit_approval(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', 'public.product_saas_is_synthetic_exit_approval(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', 'public.product_saas_is_synthetic_audit_log(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', 'public.product_saas_is_synthetic_audit_log(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', 'public.product_saas_is_synthetic_audit_event(uuid)', 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', 'public.product_saas_is_synthetic_audit_event(uuid)', 'EXECUTE'
    )
  THEN RAISE EXCEPTION 'Product/SaaS cleanup helper leaked execute privilege'; END IF;
END
$$;

ROLLBACK;

SELECT 'SAM-78 Product/SaaS synthetic cleanup boundary passed' AS result;
