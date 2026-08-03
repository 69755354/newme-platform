\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('public.tenant_file_objects') IS NOT NULL
    OR to_regclass('public.tenant_file_deletion_outbox') IS NOT NULL
    OR to_regclass('public.organization_document_sequences') IS NOT NULL
    OR to_regclass('public.contract_workflow_requests') IS NOT NULL
    OR to_regclass('public.v4_legacy_policy_snapshots') IS NOT NULL
    OR to_regclass('public.v4_legacy_table_acl_snapshots') IS NOT NULL
    OR to_regclass('public.organization_lifecycle_requests') IS NOT NULL
    OR to_regclass('public.platform_action_approvals') IS NOT NULL
    OR to_regclass('public.platform_action_approval_events') IS NOT NULL
    OR to_regprocedure('public.v4_import_leads_for_organization(uuid,jsonb,uuid,text)') IS NOT NULL
    OR to_regprocedure('public.v4_execute_approved_platform_action(uuid,text)') IS NOT NULL
    OR to_regprocedure('public.v4_finalize_tenant_file(uuid,uuid,bigint,text,text,text,text,uuid,text)') IS NOT NULL
    OR to_regprocedure('public.v4_cancel_tenant_file_upload(uuid,uuid,text,text)') IS NOT NULL
    OR to_regprocedure('public.v4_expire_tenant_file_uploads(uuid,integer,text)') IS NOT NULL
    OR to_regprocedure('public.v4_claim_tenant_file_deletions(integer,text,integer)') IS NOT NULL
    OR to_regprocedure('public.v4_complete_tenant_file_deletion(uuid,uuid,uuid,text,text,text)') IS NOT NULL
    OR to_regprocedure('public.v4_retry_tenant_file_deletion(uuid,text,text,text)') IS NOT NULL
    OR to_regprocedure('public.v4_create_contract_for_organization(uuid,jsonb,text)') IS NOT NULL
    OR to_regprocedure('public.v4_convert_quotation_for_organization(uuid,uuid,jsonb,text)') IS NOT NULL
    OR to_regprocedure('public.v4_replace_kpi_targets(uuid,text,jsonb,text)') IS NOT NULL
    OR to_regprocedure('public.v4_confirm_payment_for_organization(uuid,uuid,text)') IS NOT NULL
    OR to_regprocedure('public.v4_allocate_payment_for_organization(uuid,uuid,jsonb,text)') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notifications'
        AND column_name = 'organization_id'
    )
    OR EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notifications'
        AND column_name = 'event_key'
    )
    OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'products'
        AND column_name = 'organization_id'
        AND is_nullable = 'YES'
    )
    OR EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'platform_staff'
        AND column_name = 'role_key'
    )
    OR EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'leads'
        AND policyname LIKE 'v4_leads_%_gate'
    )
  THEN RAISE EXCEPTION 'SAM-78 closure rollback incomplete'; END IF;
END
$$;

DO $$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'SELECT'
    )
    OR NOT pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'INSERT'
    )
    OR NOT pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'UPDATE'
    )
    OR NOT pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'DELETE'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'TRUNCATE'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'REFERENCES'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated', 'public.notifications', 'TRIGGER'
    )
  THEN
    RAISE EXCEPTION 'SAM-78 rollback notifications ACL differs from baseline';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'notifications'
      AND policyname = 'policy_notifications_insert_system'
      AND cmd = 'INSERT'
      AND roles @> ARRAY['authenticated']::name[]
      AND with_check ILIKE '%user_id%auth.uid%'
  ) THEN
    RAISE EXCEPTION 'SAM-78 rollback notifications insert policy not restored';
  END IF;
END
$$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0088-4000-8000-000000000088';
INSERT INTO public.notifications (id, user_id, type, title)
VALUES (
  '78000000-7099-4000-8000-000000000099',
  '78000000-0088-4000-8000-000000000088',
  'lead_created',
  'SAM-78 rollback authenticated insert ACL probe'
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.notifications
    WHERE id = '78000000-7099-4000-8000-000000000099'
      AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'SAM-78 rollback authenticated notification insert failed';
  END IF;
END
$$;
DELETE FROM public.notifications
WHERE id = '78000000-7099-4000-8000-000000000099';
RESET ROLE;

DO $$
DECLARE expected_policy record;
BEGIN
  FOR expected_policy IN
    SELECT * FROM (VALUES
      ('leads', 'policy_leads_select_admin', 'profiles'),
      ('leads', 'policy_leads_select_sales', 'assigned_to'),
      ('contracts', 'policy_contracts_select_admin', 'profiles'),
      ('contracts', 'policy_contracts_select_sales', 'sales_id'),
      ('payments', 'policy_payments_select_admin', 'profiles'),
      ('payments', 'policy_payments_select_sales', 'contracts'),
      ('notifications', 'policy_notifications_select_self', 'user_id'),
      ('notifications', 'policy_notifications_select_admin', 'profiles'),
      ('kpi_targets', 'policy_kpi_targets_select_admin', 'profiles'),
      ('kpi_targets', 'policy_kpi_targets_select_sales', 'assigned_to')
    ) restored(table_name, policy_name, required_qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected_policy.table_name
        AND policy.policyname = expected_policy.policy_name
        AND policy.permissive = 'PERMISSIVE'
        AND policy.roles @> ARRAY['authenticated']::name[]
        AND policy.qual ILIKE '%' || expected_policy.required_qual || '%'
    ) THEN RAISE EXCEPTION 'SAM-78 rollback did not restore legacy policy %.%',
      expected_policy.table_name, expected_policy.policy_name;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = ANY (ARRAY[
        'v4_tenant_read_gate', 'v4_tenant_insert_gate',
        'v4_tenant_update_gate', 'v4_tenant_delete_gate',
        'v4_tenant_membership_read_base', 'v4_tenant_membership_insert_base',
        'v4_tenant_membership_update_base', 'v4_tenant_membership_delete_base',
        'v4_leads_read_gate', 'v4_leads_insert_gate',
        'v4_leads_update_gate', 'v4_leads_delete_gate',
        'v4_leads_membership_access', 'v4_leads_membership_insert',
        'v4_leads_membership_update', 'v4_leads_membership_delete',
        'v4_notifications_read_self', 'v4_notifications_read_managers',
        'v4_notifications_update_self', 'v4_notifications_delete_self',
        'v4_kpi_targets_membership_read', 'v4_kpi_targets_membership_insert',
        'v4_kpi_targets_membership_update', 'v4_kpi_targets_membership_delete',
        'v4_kpi_targets_read_capability', 'v4_kpi_targets_insert_capability',
        'v4_kpi_targets_update_capability', 'v4_kpi_targets_delete_capability',
        'v4_contracts_membership_access', 'v4_contracts_membership_insert',
        'v4_contracts_membership_update', 'v4_contracts_membership_delete',
        'v4_contracts_read_capability', 'v4_contracts_insert_capability',
        'v4_contracts_update_capability', 'v4_contracts_delete_capability',
        'v4_payments_membership_access', 'v4_payments_membership_insert',
        'v4_payments_membership_update', 'v4_payments_membership_delete',
        'v4_payments_read_capability', 'v4_payments_insert_capability',
        'v4_payments_update_capability', 'v4_payments_delete_capability'
      ]::text[])
  ) THEN RAISE EXCEPTION 'SAM-78 rollback retained a closure policy'; END IF;
END
$$;

DO $$
DECLARE
  table_name text;
  is_force_enabled boolean;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily',
    'leads'
  ]
  LOOP
    SELECT relation.relforcerowsecurity INTO is_force_enabled
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relname = table_name;
    IF is_force_enabled IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'SAM-78 rollback retained FORCE RLS on %', table_name;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  function_oid oid;
  function_signature text;
  public_can_execute boolean;
BEGIN
  FOREACH function_signature IN ARRAY ARRAY[
    'public.confirm_payment(uuid,uuid)',
    'public.allocate_payment(uuid,jsonb,uuid)'
  ]
  LOOP
    function_oid := to_regprocedure(function_signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'SAM-78 rollback lost legacy payment RPC %', function_signature;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_proc function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) privilege
      WHERE function_row.oid = function_oid
        AND privilege.grantee = 0
        AND privilege.privilege_type = 'EXECUTE'
    ) INTO public_can_execute;

    IF public_can_execute
      OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
      OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'SAM-78 rollback payment RPC ACL is not service-only: %', function_signature;
    END IF;
  END LOOP;
END
$$;

SET ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.confirm_payment(
      '79000000-0000-4000-8000-000000000001'::uuid,
      '79000000-0000-4000-8000-000000000002'::uuid
    );
    RAISE EXCEPTION 'SAM-78 rollback anon invoked confirm_payment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.allocate_payment(
      '79000000-0000-4000-8000-000000000001'::uuid,
      '[]'::jsonb,
      '79000000-0000-4000-8000-000000000002'::uuid
    );
    RAISE EXCEPTION 'SAM-78 rollback anon invoked allocate_payment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;
RESET ROLE;

SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.confirm_payment(
      '79000000-0000-4000-8000-000000000001'::uuid,
      '79000000-0000-4000-8000-000000000002'::uuid
    );
    RAISE EXCEPTION 'SAM-78 rollback authenticated invoked confirm_payment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    PERFORM public.allocate_payment(
      '79000000-0000-4000-8000-000000000001'::uuid,
      '[]'::jsonb,
      '79000000-0000-4000-8000-000000000002'::uuid
    );
    RAISE EXCEPTION 'SAM-78 rollback authenticated invoked allocate_payment';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;
RESET ROLE;

SET ROLE service_role;
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.confirm_payment(
    '79000000-0000-4000-8000-000000000001'::uuid,
    '79000000-0000-4000-8000-000000000002'::uuid
  );
  IF result->>'error' IS DISTINCT FROM 'Payment not found' THEN
    RAISE EXCEPTION 'SAM-78 rollback service_role did not execute confirm_payment: %', result;
  END IF;

  result := public.allocate_payment(
    '79000000-0000-4000-8000-000000000001'::uuid,
    '[]'::jsonb,
    '79000000-0000-4000-8000-000000000002'::uuid
  );
  IF result->>'error' IS DISTINCT FROM 'Payment not found' THEN
    RAISE EXCEPTION 'SAM-78 rollback service_role did not execute allocate_payment: %', result;
  END IF;
END
$$;
RESET ROLE;

SELECT 'SAM-78 tenant lifecycle rollback verified' AS result;
