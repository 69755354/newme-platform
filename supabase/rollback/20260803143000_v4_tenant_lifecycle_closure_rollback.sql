BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'v4_tenant_lifecycle_closure_rollback_requires_staging_or_test';
  END IF;
  PERFORM public.v4_assert_tenant_closure_rollback_safe();
  IF EXISTS (
    SELECT sku FROM public.products GROUP BY sku HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'v4_tenant_lifecycle_closure_rollback_duplicate_global_sku';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS zz_v4_audit_events_immutable ON public.audit_events;
DROP TRIGGER IF EXISTS zz_v4_audit_logs_immutable ON public.audit_logs;
DROP TRIGGER IF EXISTS zz_v4_lifecycle_requests_immutable
  ON public.organization_lifecycle_requests;
DROP TRIGGER IF EXISTS zz_v4_platform_approval_events_immutable
  ON public.platform_action_approval_events;
DROP TRIGGER IF EXISTS zz_v4_platform_approvals_guard
  ON public.platform_action_approvals;

DROP FUNCTION IF EXISTS public.v4_execute_approved_platform_action(uuid, text);
DROP FUNCTION IF EXISTS public.v4_complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.v4_prepare_organization_customer_exit(
  uuid, uuid, uuid, text, text, text
);
DROP FUNCTION IF EXISTS public.v4_export_organization_customer_data(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.v4_organization_customer_snapshot(uuid);
DROP FUNCTION IF EXISTS public.v4_process_no_answer_worker(uuid, text);
DROP FUNCTION IF EXISTS public.v4_convert_quotation_for_organization(
  uuid, uuid, jsonb, text
);
DROP FUNCTION IF EXISTS public.v4_create_contract_for_organization(
  uuid, jsonb, text
);
DROP FUNCTION IF EXISTS public.v4_allocate_payment_for_organization(
  uuid, uuid, jsonb, text
);
DROP FUNCTION IF EXISTS public.v4_confirm_payment_for_organization(
  uuid, uuid, text
);
DROP FUNCTION IF EXISTS public.v4_replace_kpi_targets(uuid, text, jsonb, text);
DROP FUNCTION IF EXISTS public.v4_expire_tenant_file_uploads(uuid, integer, text);
DROP FUNCTION IF EXISTS public.v4_retry_tenant_file_deletion(
  uuid, text, text, text
);
DROP FUNCTION IF EXISTS public.v4_complete_tenant_file_deletion(
  uuid, uuid, uuid, text, text, text
);
DROP FUNCTION IF EXISTS public.v4_claim_tenant_file_deletions(
  integer, text, integer
);
DROP FUNCTION IF EXISTS public.v4_cancel_tenant_file_upload(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.v4_finalize_tenant_file(
  uuid, uuid, bigint, text, text, text, text, uuid, text
);
DROP FUNCTION IF EXISTS public.v4_register_tenant_file(
  uuid, text, uuid, text, text, text, bigint, text, text
);
DROP FUNCTION IF EXISTS public.v4_import_leads_for_organization(uuid, jsonb, uuid, text);
DROP FUNCTION IF EXISTS public.v4_expire_support_sessions(text);
DROP FUNCTION IF EXISTS public.v4_transition_organization_lifecycle(
  uuid, text, uuid, uuid, text, text
);
DROP FUNCTION IF EXISTS public.v4_accept_organization_membership(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.v4_invite_organization_member(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.v4_provision_organization(
  text, text, text, text, text, integer, uuid, uuid, uuid, text
);
DROP FUNCTION IF EXISTS public.v4_approve_platform_action(uuid, text);
DROP FUNCTION IF EXISTS public.v4_request_platform_action_approval(
  text, text, jsonb, text
);
DROP FUNCTION IF EXISTS public.v4_platform_payload_hash(jsonb);
DROP FUNCTION IF EXISTS public.v4_assert_tenant_closure_rollback_safe();

DROP TABLE public.tenant_file_deletion_outbox;
DROP TABLE public.contract_workflow_requests;
DROP TABLE public.organization_document_sequences;
DROP TABLE public.tenant_file_objects;
DROP TABLE public.organization_lifecycle_requests;
DROP TABLE public.platform_action_approval_events;
DROP TABLE public.platform_action_approvals;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily'
  ]
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS aa_v4_assign_tenant_organization ON public.%I',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS v4_tenant_read_gate ON public.%I', table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_insert_gate ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_update_gate ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_delete_gate ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_membership_read_base ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_membership_insert_base ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_membership_update_base ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS v4_tenant_membership_delete_base ON public.%I', table_name);
    EXECUTE format(
      'ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', table_name
    );
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS aa_v4_assign_tenant_organization ON public.leads;
DROP POLICY IF EXISTS v4_leads_read_gate ON public.leads;
DROP POLICY IF EXISTS v4_leads_insert_gate ON public.leads;
DROP POLICY IF EXISTS v4_leads_update_gate ON public.leads;
DROP POLICY IF EXISTS v4_leads_delete_gate ON public.leads;
DROP POLICY IF EXISTS v4_leads_membership_access ON public.leads;
DROP POLICY IF EXISTS v4_leads_membership_insert ON public.leads;
DROP POLICY IF EXISTS v4_leads_membership_update ON public.leads;
DROP POLICY IF EXISTS v4_leads_membership_delete ON public.leads;
ALTER TABLE public.leads NO FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS v4_notifications_read_self ON public.notifications;
DROP POLICY IF EXISTS v4_notifications_read_managers ON public.notifications;
DROP POLICY IF EXISTS v4_notifications_update_self ON public.notifications;
DROP POLICY IF EXISTS v4_notifications_delete_self ON public.notifications;
DROP POLICY IF EXISTS v4_kpi_targets_membership_read ON public.kpi_targets;
DROP POLICY IF EXISTS v4_kpi_targets_membership_insert ON public.kpi_targets;
DROP POLICY IF EXISTS v4_kpi_targets_membership_update ON public.kpi_targets;
DROP POLICY IF EXISTS v4_kpi_targets_membership_delete ON public.kpi_targets;
DROP POLICY IF EXISTS v4_contracts_membership_access ON public.contracts;
DROP POLICY IF EXISTS v4_contracts_membership_insert ON public.contracts;
DROP POLICY IF EXISTS v4_contracts_membership_update ON public.contracts;
DROP POLICY IF EXISTS v4_contracts_membership_delete ON public.contracts;
DROP POLICY IF EXISTS v4_payments_membership_access ON public.payments;
DROP POLICY IF EXISTS v4_payments_membership_insert ON public.payments;
DROP POLICY IF EXISTS v4_payments_membership_update ON public.payments;
DROP POLICY IF EXISTS v4_payments_membership_delete ON public.payments;
DROP POLICY IF EXISTS v4_contracts_update_capability ON public.contracts;
DROP POLICY IF EXISTS v4_contracts_insert_capability ON public.contracts;
DROP POLICY IF EXISTS v4_contracts_read_capability ON public.contracts;
DROP POLICY IF EXISTS v4_contracts_delete_capability ON public.contracts;
DROP POLICY IF EXISTS v4_payments_update_capability ON public.payments;
DROP POLICY IF EXISTS v4_payments_insert_capability ON public.payments;
DROP POLICY IF EXISTS v4_payments_read_capability ON public.payments;
DROP POLICY IF EXISTS v4_payments_delete_capability ON public.payments;
DROP POLICY IF EXISTS v4_kpi_targets_delete_capability ON public.kpi_targets;
DROP POLICY IF EXISTS v4_kpi_targets_update_capability ON public.kpi_targets;
DROP POLICY IF EXISTS v4_kpi_targets_insert_capability ON public.kpi_targets;
DROP POLICY IF EXISTS v4_kpi_targets_read_capability ON public.kpi_targets;

DO $$
DECLARE
  snapshot public.v4_legacy_policy_snapshots%ROWTYPE;
  role_list text;
  using_clause text;
  check_clause text;
BEGIN
  FOR snapshot IN
    SELECT * FROM public.v4_legacy_policy_snapshots
    ORDER BY schema_name, table_name, policy_name
  LOOP
    SELECT string_agg(quote_ident(role_name), ', ' ORDER BY ordinal_position)
    INTO role_list
    FROM unnest(snapshot.policy_roles) WITH ORDINALITY
      AS restored_role(role_name, ordinal_position);
    using_clause := CASE WHEN snapshot.using_expression IS NULL THEN ''
      ELSE ' USING (' || snapshot.using_expression || ')' END;
    check_clause := CASE WHEN snapshot.check_expression IS NULL THEN ''
      ELSE ' WITH CHECK (' || snapshot.check_expression || ')' END;
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
      snapshot.policy_name, snapshot.schema_name, snapshot.table_name,
      snapshot.permissive, snapshot.policy_command, role_list,
      using_clause, check_clause
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.v4_legacy_policy_snapshots saved_policy
    LEFT JOIN pg_policies policy
      ON policy.schemaname = saved_policy.schema_name
     AND policy.tablename = saved_policy.table_name
     AND policy.policyname = saved_policy.policy_name
    WHERE policy.policyname IS NULL
      OR policy.permissive IS DISTINCT FROM saved_policy.permissive
      OR policy.roles::text[] IS DISTINCT FROM saved_policy.policy_roles
      OR policy.cmd IS DISTINCT FROM saved_policy.policy_command
      OR policy.qual IS DISTINCT FROM saved_policy.using_expression
      OR policy.with_check IS DISTINCT FROM saved_policy.check_expression
  ) THEN RAISE EXCEPTION 'v4_legacy_policy_restore_mismatch'; END IF;
END
$$;

DO $$
DECLARE
  notification_owner text;
  acl_role record;
  restored_grant record;
  grantee_sql text;
BEGIN
  SELECT owner_role.rolname INTO notification_owner
  FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'notifications';
  IF notification_owner IS NULL THEN
    RAISE EXCEPTION 'v4_notifications_acl_restore_relation_missing';
  END IF;

  -- Remove every non-owner grant that exists now or existed at migration time,
  -- then recreate the frozen privilege set exactly.
  FOR acl_role IN
    WITH current_grantees AS (
      SELECT DISTINCT COALESCE(grantee_role.rolname, 'PUBLIC') AS grantee_name
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) privilege
      LEFT JOIN pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'notifications'
    )
    SELECT grantee_name FROM current_grantees
    UNION
    SELECT grantee_name FROM public.v4_legacy_table_acl_snapshots
  LOOP
    IF acl_role.grantee_name <> notification_owner THEN
      grantee_sql := CASE WHEN acl_role.grantee_name = 'PUBLIC'
        THEN 'PUBLIC' ELSE quote_ident(acl_role.grantee_name) END;
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.notifications FROM %s',
        grantee_sql
      );
    END IF;
  END LOOP;

  FOR restored_grant IN
    SELECT
      grantee_name,
      is_grantable,
      string_agg(
        privilege_type,
        ', ' ORDER BY CASE privilege_type
          WHEN 'SELECT' THEN 1 WHEN 'INSERT' THEN 2 WHEN 'UPDATE' THEN 3
          WHEN 'DELETE' THEN 4 WHEN 'TRUNCATE' THEN 5
          WHEN 'REFERENCES' THEN 6 WHEN 'TRIGGER' THEN 7 WHEN 'MAINTAIN' THEN 8
        END
      ) AS privileges
    FROM public.v4_legacy_table_acl_snapshots
    WHERE grantee_name <> notification_owner
    GROUP BY grantee_name, is_grantable
  LOOP
    grantee_sql := CASE WHEN restored_grant.grantee_name = 'PUBLIC'
      THEN 'PUBLIC' ELSE quote_ident(restored_grant.grantee_name) END;
    EXECUTE format(
      'GRANT %s ON TABLE public.notifications TO %s%s',
      restored_grant.privileges,
      grantee_sql,
      CASE WHEN restored_grant.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;

  IF EXISTS (
    WITH current_acl AS (
      SELECT
        namespace.nspname AS schema_name,
        relation.relname AS table_name,
        grantor_role.rolname AS grantor_name,
        COALESCE(grantee_role.rolname, 'PUBLIC') AS grantee_name,
        upper(privilege.privilege_type) AS privilege_type,
        privilege.is_grantable
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) privilege
      JOIN pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'notifications'
    ), acl_difference AS (
      (
        SELECT schema_name, table_name, grantor_name, grantee_name,
          privilege_type, is_grantable
        FROM public.v4_legacy_table_acl_snapshots
        EXCEPT
        SELECT schema_name, table_name, grantor_name, grantee_name,
          privilege_type, is_grantable
        FROM current_acl
      )
      UNION ALL
      (
        SELECT schema_name, table_name, grantor_name, grantee_name,
          privilege_type, is_grantable
        FROM current_acl
        EXCEPT
        SELECT schema_name, table_name, grantor_name, grantee_name,
          privilege_type, is_grantable
        FROM public.v4_legacy_table_acl_snapshots
      )
    )
    SELECT 1 FROM acl_difference
  ) THEN
    RAISE EXCEPTION 'v4_notifications_acl_restore_mismatch';
  END IF;
END
$$;

DROP TABLE public.v4_legacy_policy_snapshots;
DROP TABLE public.v4_legacy_table_acl_snapshots;

DO $$
BEGIN
  IF to_regprocedure('public.confirm_payment(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.confirm_payment(uuid, uuid)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, uuid)
      TO service_role;
  END IF;
  IF to_regprocedure('public.allocate_payment(uuid,jsonb,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.allocate_payment(uuid, jsonb, uuid)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.allocate_payment(uuid, jsonb, uuid)
      TO service_role;
  END IF;
END
$$;

DROP FUNCTION public.v4_assign_tenant_organization();
DROP FUNCTION public.v4_guard_platform_action_approval_update();
DROP FUNCTION public.v4_reject_mutation();
DROP FUNCTION public.v4_actor_has_organization_role(uuid, uuid, text[]);
DROP FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text);

ALTER TABLE public.products
  DROP CONSTRAINT products_organization_sku_key,
  ALTER COLUMN organization_id DROP NOT NULL,
  ALTER COLUMN tenant_id DROP NOT NULL,
  ADD CONSTRAINT products_sku_key UNIQUE (sku);

ALTER TABLE public.kpi_targets
  DROP CONSTRAINT kpi_targets_organization_period_target_assignee_key,
  ADD CONSTRAINT kpi_targets_period_target_type_assigned_to_key
  UNIQUE (period, target_type, assigned_to);

ALTER TABLE public.lead_assignment_state DROP CONSTRAINT lead_assignment_state_pkey;
ALTER TABLE public.lead_assignment_state
  ADD CONSTRAINT lead_assignment_state_pkey PRIMARY KEY (id);

ALTER TABLE public.activities
  DROP CONSTRAINT activities_organization_lead_fkey;
ALTER TABLE public.quotes
  DROP CONSTRAINT quotes_organization_lead_fkey;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_events', 'chat_messages', 'customers', 'follow_up_logs',
    'knx_designs', 'lead_files', 'lead_milestones',
    'lead_mutation_requests', 'lead_workflow_stages', 'transfer_history'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I',
      table_name,
      table_name || '_organization_lead_fkey'
    );
  END LOOP;
END
$$;

ALTER TABLE public.membership_roles
  DROP CONSTRAINT membership_roles_organization_membership_fkey;
ALTER TABLE public.memberships
  DROP CONSTRAINT memberships_organization_id_id_unique;

DROP INDEX public.notifications_organization_user_event_key_unique;
ALTER TABLE public.notifications DROP COLUMN event_key;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT %I',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'ALTER TABLE public.%I DROP COLUMN organization_id', table_name
    );
  END LOOP;
END
$$;

DELETE FROM public.role_capabilities role_capability
USING public.capabilities capability
WHERE capability.id = role_capability.capability_id
  AND capability.scope = 'organization'
  AND capability.capability_key IN (
    'organization.members.manage', 'organization.data.export',
    'organization.data.read', 'organization.data.create',
    'organization.data.update', 'organization.data.delete',
    'leads.read', 'leads.write', 'leads.import', 'leads.export',
    'storage.files.read', 'storage.files.write',
    'storage.files.write_any', 'storage.files.seal',
    'kpi.targets.read', 'kpi.targets.manage',
    'payments.read', 'payments.create', 'payments.confirm', 'payments.allocate',
    'contracts.read', 'contracts.create', 'contracts.update',
    'contracts.write_any', 'quotations.convert'
  );
DELETE FROM public.capabilities
WHERE scope = 'organization'
  AND capability_key IN (
    'organization.members.manage', 'organization.data.export',
    'organization.data.read', 'organization.data.create',
    'organization.data.update', 'organization.data.delete',
    'leads.read', 'leads.write', 'leads.import', 'leads.export',
    'storage.files.read', 'storage.files.write',
    'storage.files.write_any', 'storage.files.seal',
    'kpi.targets.read', 'kpi.targets.manage',
    'payments.read', 'payments.create', 'payments.confirm', 'payments.allocate',
    'contracts.read', 'contracts.create', 'contracts.update',
    'contracts.write_any', 'quotations.convert'
  );

ALTER TABLE public.platform_staff
  DROP CONSTRAINT platform_staff_role_key_check,
  DROP COLUMN role_key;

ALTER TABLE public.organizations
  DROP CONSTRAINT organizations_status_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_status_check
  CHECK (status IN ('provisioning', 'active', 'read_only', 'suspended', 'closed'));

NOTIFY pgrst, 'reload schema';

COMMIT;
