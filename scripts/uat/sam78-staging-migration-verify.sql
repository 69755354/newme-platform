DO $sam78_live_verify$
DECLARE
  action text := current_setting('newme.sam78_action', true);
  phase text := current_setting('newme.sam78_verify_phase', true);
  legacy_organization_id constant uuid :=
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid;
  tenant_tables constant text[] := ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily'
  ]::text[];
  managed_relations constant text[] := ARRAY[
    'capabilities', 'role_capabilities', 'v4_legacy_policy_snapshots',
    'v4_legacy_table_acl_snapshots', 'organization_lifecycle_requests',
    'tenant_file_objects', 'tenant_file_deletion_outbox',
    'organization_document_sequences', 'contract_workflow_requests',
    'platform_action_approvals', 'platform_action_approval_events'
  ]::text[];
  service_only_functions constant text[] := ARRAY[
    'public.v4_execute_approved_platform_action(uuid,text)',
    'public.v4_expire_support_sessions(text)',
    'public.v4_finalize_tenant_file(uuid,uuid,bigint,text,text,text,text,uuid,text)',
    'public.v4_expire_tenant_file_uploads(uuid,integer,text)',
    'public.v4_claim_tenant_file_deletions(integer,text,integer)',
    'public.v4_complete_tenant_file_deletion(uuid,uuid,uuid,text,text,text)',
    'public.v4_retry_tenant_file_deletion(uuid,text,text,text)',
    'public.v4_process_no_answer_worker(uuid,text)',
    'public.v4_organization_customer_snapshot(uuid)',
    'public.v4_export_organization_customer_data(uuid,uuid,text)'
  ]::text[];
  required_functions constant text[] := ARRAY[
    'public.v4_import_leads_for_organization(uuid,jsonb,uuid,text)',
    'public.v4_request_platform_action_approval(text,text,jsonb,text)',
    'public.v4_approve_platform_action(uuid,text)',
    'public.v4_execute_approved_platform_action(uuid,text)',
    'public.v4_transition_organization_lifecycle(uuid,text,uuid,uuid,text,text)',
    'public.v4_finalize_tenant_file(uuid,uuid,bigint,text,text,text,text,uuid,text)',
    'public.v4_cancel_tenant_file_upload(uuid,uuid,text,text)',
    'public.v4_claim_tenant_file_deletions(integer,text,integer)',
    'public.v4_complete_tenant_file_deletion(uuid,uuid,uuid,text,text,text)',
    'public.v4_retry_tenant_file_deletion(uuid,text,text,text)',
    'public.v4_create_contract_for_organization(uuid,jsonb,text)',
    'public.v4_convert_quotation_for_organization(uuid,uuid,jsonb,text)',
    'public.v4_replace_kpi_targets(uuid,text,jsonb,text)',
    'public.v4_confirm_payment_for_organization(uuid,uuid,text)',
    'public.v4_allocate_payment_for_organization(uuid,uuid,jsonb,text)'
  ]::text[];
  relation_name text;
  target_table_name text;
  function_signature text;
  function_oid oid;
  public_can_execute boolean;
  row_count bigint;
  expected_policy record;
  expected_activity_zero_count text;
  expected_session_zero_count text;
BEGIN
  IF action NOT IN ('apply', 'rollback') OR phase NOT IN ('pre', 'post') THEN
    RAISE EXCEPTION 'SAM78 live verification context is invalid';
  END IF;

  IF (action = 'apply' AND phase = 'pre')
    OR (action = 'rollback' AND phase = 'post') THEN
    FOREACH relation_name IN ARRAY managed_relations LOOP
      IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
        RAISE EXCEPTION 'SAM78 baseline verification found managed relation: %',
          relation_name;
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = ANY (tenant_tables) AND column_name = 'organization_id')
          OR (table_name = 'products' AND column_name = 'organization_id')
          OR (table_name = 'notifications' AND column_name = 'event_key')
          OR (table_name = 'platform_staff' AND column_name = 'role_key')
        )
    ) THEN
      RAISE EXCEPTION 'SAM78 baseline verification found additive columns';
    END IF;

    IF action = 'rollback' THEN
      FOREACH target_table_name IN ARRAY tenant_tables || ARRAY['leads']::text[] LOOP
        IF EXISTS (
          SELECT 1
          FROM pg_class relation
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = target_table_name
            AND relation.relforcerowsecurity
        ) THEN
          RAISE EXCEPTION 'SAM78 rollback retained FORCE RLS on %', target_table_name;
        END IF;
      END LOOP;

      IF NOT pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'SELECT')
        OR NOT pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'INSERT')
        OR NOT pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'UPDATE')
        OR NOT pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'DELETE')
        OR pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'TRUNCATE')
        OR pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'REFERENCES')
        OR pg_catalog.has_table_privilege('authenticated', 'public.notifications', 'TRIGGER') THEN
        RAISE EXCEPTION 'SAM78 rollback notifications ACL differs from baseline';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'notifications'
          AND policyname = 'policy_notifications_insert_system'
          AND cmd = 'INSERT' AND roles @> ARRAY['authenticated']::name[]
          AND with_check ILIKE '%user_id%auth.uid%'
      ) THEN
        RAISE EXCEPTION 'SAM78 rollback notification policy was not restored';
      END IF;
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
        ) THEN
          RAISE EXCEPTION 'SAM78 rollback legacy policy is missing: %.%',
            expected_policy.table_name, expected_policy.policy_name;
        END IF;
      END LOOP;
      IF EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND policyname LIKE 'v4\_%' ESCAPE '\'
      ) THEN
        RAISE EXCEPTION 'SAM78 rollback retained a V4 policy';
      END IF;
      FOREACH function_signature IN ARRAY ARRAY[
        'public.confirm_payment(uuid,uuid)',
        'public.allocate_payment(uuid,jsonb,uuid)'
      ]::text[] LOOP
        function_oid := to_regprocedure(function_signature);
        IF function_oid IS NULL THEN
          RAISE EXCEPTION 'SAM78 rollback lost legacy payment RPC: %',
            function_signature;
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
          OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
          RAISE EXCEPTION 'SAM78 rollback legacy payment RPC ACL failed: %',
            function_signature;
        END IF;
      END LOOP;
      expected_activity_zero_count := current_setting(
        'newme.sam78_activity_zero_count', true
      );
      expected_session_zero_count := current_setting(
        'newme.sam78_session_zero_count', true
      );
      IF expected_activity_zero_count IS NOT NULL AND (
        SELECT count(*)::text FROM public.activity_logs
        WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
      ) <> expected_activity_zero_count THEN
        RAISE EXCEPTION 'SAM78 rollback changed zero UUID activity evidence';
      END IF;
      IF expected_session_zero_count IS NOT NULL AND (
        SELECT count(*)::text FROM public.user_session_daily
        WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
      ) <> expected_session_zero_count THEN
        RAISE EXCEPTION 'SAM78 rollback changed zero UUID session evidence';
      END IF;
    END IF;
    RETURN;
  END IF;

  -- Apply post-state and rollback pre-state are intentionally the same exact
  -- contract. A rollback cannot begin from a partial or unsafe deployment.
  FOREACH relation_name IN ARRAY managed_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'SAM78 applied contract is missing relation: %', relation_name;
    END IF;
  END LOOP;

  IF to_regprocedure('public.v4_reject_mutation()') IS NULL
    OR pg_get_functiondef('public.v4_reject_mutation()'::regprocedure)
      NOT ILIKE '%sam26-staging-uat%'
    OR pg_get_functiondef('public.v4_reject_mutation()'::regprocedure)
      NOT ILIKE '%current_user = ''service_role''%'
  THEN
    RAISE EXCEPTION 'SAM26 synthetic audit cleanup boundary is missing';
  END IF;

  IF to_regprocedure('public.sam20_is_synthetic_support_approval(uuid)') IS NULL
    OR pg_get_functiondef('public.v4_reject_mutation()'::regprocedure)
      NOT ILIKE '%platform_action_approval_events%'
    OR pg_get_functiondef(
      'public.v4_guard_platform_action_approval_update()'::regprocedure
    ) NOT ILIKE '%sam20_is_synthetic_support_approval%'
  THEN
    RAISE EXCEPTION 'SAM20 synthetic support cleanup boundary is missing';
  END IF;

  FOREACH target_table_name IN ARRAY tenant_tables LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target_table_name
        AND column_name = 'organization_id' AND is_nullable = 'NO'
        AND column_default ILIKE '%requested_organization_id%'
    ) THEN
      RAISE EXCEPTION 'SAM78 tenant column contract failed on %', target_table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = target_table_name
        AND constraint_row.conname = target_table_name || '_organization_id_fkey'
        AND constraint_row.contype = 'f' AND constraint_row.convalidated
        AND constraint_row.confrelid = 'public.organizations'::regclass
    ) THEN
      RAISE EXCEPTION 'SAM78 tenant FK contract failed on %', target_table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = target_table_name
        AND relation.relrowsecurity AND relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'SAM78 tenant FORCE RLS contract failed on %', target_table_name;
    END IF;
    IF (
      SELECT count(*)
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = target_table_name
        AND permissive = 'RESTRICTIVE'
        AND policyname = ANY (ARRAY[
          'v4_tenant_read_gate', 'v4_tenant_insert_gate',
          'v4_tenant_update_gate', 'v4_tenant_delete_gate'
        ]::text[])
    ) <> 4 THEN
      RAISE EXCEPTION 'SAM78 restrictive policy contract failed on %', target_table_name;
    END IF;
    EXECUTE format(
      'SELECT count(*) FROM public.%I row_value '
        || 'LEFT JOIN public.organizations organization_row '
        || 'ON organization_row.id = row_value.organization_id '
        || 'WHERE row_value.organization_id IS NULL OR organization_row.id IS NULL',
      target_table_name
    ) INTO row_count;
    IF row_count <> 0 THEN
      RAISE EXCEPTION 'SAM78 tenant backfill/orphan verification failed on %',
        target_table_name;
    END IF;
  END LOOP;

  FOREACH target_table_name IN ARRAY ARRAY['leads', 'organization_lifecycle_requests']::text[] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = target_table_name
        AND relation.relrowsecurity AND relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'SAM78 required FORCE RLS missing on %', target_table_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products'
      AND column_name = 'organization_id' AND is_nullable = 'NO'
  ) OR EXISTS (
    SELECT 1 FROM public.products product
    LEFT JOIN public.organizations organization_row
      ON organization_row.id = product.organization_id
    WHERE product.organization_id IS NULL OR organization_row.id IS NULL
  ) THEN
    RAISE EXCEPTION 'SAM78 product organization contract failed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.activity_logs
    WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
      AND organization_id IS DISTINCT FROM legacy_organization_id
  ) OR EXISTS (
    SELECT 1 FROM public.user_session_daily
    WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
      AND organization_id IS DISTINCT FROM legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'SAM78 zero UUID tenant backfill is incorrect';
  END IF;

  IF NOT pg_catalog.has_any_column_privilege(
      'authenticated', 'public.tenant_file_objects', 'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated', 'public.tenant_file_objects', 'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated', 'public.tenant_file_objects', 'INSERT,UPDATE,DELETE'
    ) THEN
    RAISE EXCEPTION 'SAM78 tenant file ACL is not minimal read-only for authenticated';
  END IF;

  FOREACH function_signature IN ARRAY required_functions LOOP
    IF to_regprocedure(function_signature) IS NULL THEN
      RAISE EXCEPTION 'SAM78 required function is missing: %', function_signature;
    END IF;
  END LOOP;

  FOREACH function_signature IN ARRAY service_only_functions LOOP
    function_oid := to_regprocedure(function_signature);
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'SAM78 service function is missing: %', function_signature;
    END IF;
    SELECT EXISTS (
      SELECT 1
      FROM pg_proc function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) privilege
      WHERE function_row.oid = function_oid
        AND privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
    ) INTO public_can_execute;
    IF public_can_execute
      OR pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
      OR NOT pg_catalog.has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'SAM78 service function ACL failed: %', function_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_proc function_row
    JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
      AND function_row.proname LIKE 'v4\_%' ESCAPE '\'
      AND function_row.prosecdef
      AND NOT COALESCE(function_row.proconfig, ARRAY[]::text[])
        @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'SAM78 SECURITY DEFINER search_path contract failed';
  END IF;

  IF action = 'rollback' AND phase = 'pre' THEN
    PERFORM set_config(
      'newme.sam78_activity_zero_count',
      (SELECT count(*)::text FROM public.activity_logs
        WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid),
      true
    );
    PERFORM set_config(
      'newme.sam78_session_zero_count',
      (SELECT count(*)::text FROM public.user_session_daily
        WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid),
      true
    );
    PERFORM public.v4_assert_tenant_closure_rollback_safe();
  END IF;
END
$sam78_live_verify$;
