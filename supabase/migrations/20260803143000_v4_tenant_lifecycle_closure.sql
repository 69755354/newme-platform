-- SAM-78 / V4-PF-001..004 / G1 / G2: contract the remaining tenant boundary.
-- This migration is staging-first. It does not contain production deployment
-- commands and is paired with a fail-closed rollback and disposable DB gate.

BEGIN;

-- Freeze the notification relation while its policy and complete table ACL
-- baselines are captured. The lock remains transaction-scoped.
LOCK TABLE public.notifications IN ACCESS EXCLUSIVE MODE;

-- Preserve the exact browser policy definitions and notification privileges
-- removed by this migration so rollback never reconstructs them by guessing.
CREATE TABLE public.v4_legacy_policy_snapshots (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  policy_name text NOT NULL,
  permissive text NOT NULL CHECK (permissive IN ('PERMISSIVE', 'RESTRICTIVE')),
  policy_roles text[] NOT NULL,
  policy_command text NOT NULL CHECK (
    policy_command IN ('ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ),
  using_expression text,
  check_expression text,
  PRIMARY KEY (schema_name, table_name, policy_name)
);
INSERT INTO public.v4_legacy_policy_snapshots (
  schema_name, table_name, policy_name, permissive, policy_roles,
  policy_command, using_expression, check_expression
)
SELECT
  policy.schemaname, policy.tablename, policy.policyname,
  policy.permissive, policy.roles::text[], policy.cmd,
  policy.qual, policy.with_check
FROM pg_policies policy
WHERE policy.schemaname = 'public'
  AND policy.permissive = 'PERMISSIVE'
  AND (
    policy.roles @> ARRAY['public']::name[]
    OR policy.roles @> ARRAY['authenticated']::name[]
  )
  AND policy.tablename IN (
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily',
    'leads', 'contracts', 'payments'
  )
  AND (
    policy.tablename IN (
      'notifications', 'kpi_targets', 'leads', 'contracts', 'payments',
      'activity_logs', 'audit_logs', 'user_session_daily'
    )
    OR COALESCE(policy.qual, '') ILIKE '%profiles%'
    OR COALESCE(policy.with_check, '') ILIKE '%profiles%'
    OR COALESCE(policy.qual, '') ILIKE '%get_my_role%'
    OR COALESCE(policy.with_check, '') ILIKE '%get_my_role%'
  );
ALTER TABLE public.v4_legacy_policy_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v4_legacy_policy_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.v4_legacy_policy_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.v4_legacy_policy_snapshots TO service_role;

CREATE TABLE public.v4_legacy_table_acl_snapshots (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  grantor_name text NOT NULL,
  grantee_name text NOT NULL,
  privilege_type text NOT NULL CHECK (
    privilege_type IN (
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    )
  ),
  is_grantable boolean NOT NULL,
  PRIMARY KEY (
    schema_name, table_name, grantor_name, grantee_name,
    privilege_type, is_grantable
  )
);
INSERT INTO public.v4_legacy_table_acl_snapshots (
  schema_name, table_name, grantor_name, grantee_name,
  privilege_type, is_grantable
)
SELECT
  namespace.nspname,
  relation.relname,
  grantor_role.rolname,
  COALESCE(grantee_role.rolname, 'PUBLIC'),
  upper(privilege.privilege_type),
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
  AND relation.relkind IN ('r', 'p');
ALTER TABLE public.v4_legacy_table_acl_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v4_legacy_table_acl_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.v4_legacy_table_acl_snapshots
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.v4_legacy_table_acl_snapshots TO service_role;

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_status_check
  CHECK (status IN (
    'provisioning', 'active', 'read_only', 'suspended', 'export_only', 'closed'
  ));

DO $$
DECLARE
  target_table_name text;
BEGIN
  FOREACH target_table_name IN ARRAY ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id uuid',
      target_table_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.notifications
  ADD COLUMN event_key text;
CREATE UNIQUE INDEX notifications_organization_user_event_key_unique
  ON public.notifications (organization_id, user_id, event_key);

UPDATE public.membership_roles role_link
SET organization_id = membership.organization_id
FROM public.memberships membership
WHERE membership.id = role_link.membership_id
  AND role_link.organization_id IS NULL;

UPDATE public.activity_logs
SET organization_id = CASE
  WHEN tenant_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ELSE tenant_id
END
WHERE organization_id IS NULL;
UPDATE public.user_session_daily
SET organization_id = CASE
  WHEN tenant_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ELSE tenant_id
END
WHERE organization_id IS NULL;

DO $$
DECLARE
  target_table_name text;
BEGIN
  FOREACH target_table_name IN ARRAY ARRAY[
    'business_events', 'chat_messages', 'customers', 'follow_up_logs',
    'knx_designs', 'lead_files', 'lead_milestones',
    'lead_mutation_requests', 'lead_workflow_stages', 'transfer_history'
  ]
  LOOP
    EXECUTE format(
      'UPDATE public.%I child SET organization_id = lead_row.organization_id '
        || 'FROM public.leads lead_row WHERE child.lead_id = lead_row.id '
        || 'AND child.organization_id IS NULL',
      target_table_name
    );
  END LOOP;
END
$$;

UPDATE public.activities activity
SET organization_id = COALESCE(
  (SELECT lead_row.organization_id FROM public.leads lead_row
    WHERE lead_row.id = activity.lead_id),
  (SELECT contract.organization_id FROM public.contracts contract
    WHERE contract.id = activity.contract_id),
  (SELECT quotation.organization_id FROM public.quotations quotation
    WHERE quotation.id = activity.quotation_id),
  (SELECT project.organization_id FROM public.projects project
    WHERE project.id = activity.project_id)
)
WHERE activity.organization_id IS NULL;

UPDATE public.quotes quote_row
SET organization_id = COALESCE(
  (SELECT lead_row.organization_id FROM public.leads lead_row
    WHERE lead_row.id = quote_row.lead_id),
  (SELECT project.organization_id FROM public.projects project
    WHERE project.id = quote_row.project_id)
)
WHERE quote_row.organization_id IS NULL;

UPDATE public.notifications notification
SET organization_id = COALESCE(
  (SELECT lead_row.organization_id FROM public.leads lead_row
    WHERE lead_row.id::text = notification.related_id::text LIMIT 1),
  (SELECT quotation.organization_id FROM public.quotations quotation
    WHERE quotation.id::text = notification.related_id::text LIMIT 1),
  (SELECT contract.organization_id FROM public.contracts contract
    WHERE contract.id::text = notification.related_id::text LIMIT 1),
  (SELECT membership.organization_id FROM public.memberships membership
    WHERE membership.user_id = notification.user_id
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
    ORDER BY membership.created_at LIMIT 1)
)
WHERE notification.organization_id IS NULL;

-- The pre-V4 deployment is a single, explicitly identified legacy tenant.
-- Parentless historical rows are assigned only during this versioned backfill;
-- all post-migration writes require explicit or request-derived organization.
DO $$
DECLARE
  table_name text;
  legacy_organization_id constant uuid :=
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'legacy_organization_required';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'activities', 'ad_spend', 'audit_logs', 'business_events',
    'chat_messages', 'customers', 'kpi_targets', 'lead_assignment_state',
    'lead_deletion_requests', 'notifications', 'quotes'
  ]
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET organization_id = $1 '
        || 'WHERE organization_id IS NULL',
      table_name
    ) USING legacy_organization_id;
  END LOOP;
END
$$;

DO $$
DECLARE
  target_table_name text;
BEGIN
  FOREACH target_table_name IN ARRAY ARRAY[
    'membership_roles', 'activities', 'activity_logs', 'ad_spend',
    'audit_logs', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'kpi_targets',
    'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'notifications', 'quotes', 'transfer_history', 'user_session_daily'
  ]
  LOOP
    EXECUTE format(
      'DO $inner$ BEGIN IF EXISTS (SELECT 1 FROM public.%I '
        || 'WHERE organization_id IS NULL) THEN '
        || 'RAISE EXCEPTION ''tenant_organization_backfill_incomplete:%s''; '
        || 'END IF; END $inner$',
      target_table_name,
      target_table_name
    );
  END LOOP;
END
$$;

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
      'ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL, '
        || 'ALTER COLUMN organization_id SET DEFAULT public.requested_organization_id()',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
        || 'FOREIGN KEY (organization_id) REFERENCES public.organizations(id) '
        || 'ON DELETE RESTRICT NOT VALID',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'CREATE INDEX %I ON public.%I (organization_id, id)',
      table_name || '_organization_lookup_idx',
      table_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_organization_id_id_unique
  UNIQUE (organization_id, id);
ALTER TABLE public.membership_roles
  ADD CONSTRAINT membership_roles_organization_membership_fkey
  FOREIGN KEY (organization_id, membership_id)
  REFERENCES public.memberships(organization_id, id)
  ON DELETE CASCADE;

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
      'ALTER TABLE public.%I ADD CONSTRAINT %I '
        || 'FOREIGN KEY (organization_id, lead_id) '
        || 'REFERENCES public.leads(organization_id, id) '
        || 'ON DELETE CASCADE NOT VALID',
      table_name,
      table_name || '_organization_lead_fkey'
    );
    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      table_name,
      table_name || '_organization_lead_fkey'
    );
  END LOOP;
END
$$;

ALTER TABLE public.activities
  ADD CONSTRAINT activities_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads(organization_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE public.activities
  VALIDATE CONSTRAINT activities_organization_lead_fkey;
ALTER TABLE public.quotes
  ADD CONSTRAINT quotes_organization_lead_fkey
  FOREIGN KEY (organization_id, lead_id)
  REFERENCES public.leads(organization_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE public.quotes
  VALIDATE CONSTRAINT quotes_organization_lead_fkey;

ALTER TABLE public.lead_assignment_state DROP CONSTRAINT lead_assignment_state_pkey;
ALTER TABLE public.lead_assignment_state
  ADD CONSTRAINT lead_assignment_state_pkey PRIMARY KEY (organization_id, id);

ALTER TABLE public.products
  VALIDATE CONSTRAINT products_organization_id_fkey;
ALTER TABLE public.products
  VALIDATE CONSTRAINT products_tenant_matches_organization_check;
ALTER TABLE public.products
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN tenant_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS products_sku_key;
ALTER TABLE public.products
  ADD CONSTRAINT products_organization_sku_key UNIQUE (organization_id, sku);

ALTER TABLE public.kpi_targets
  DROP CONSTRAINT IF EXISTS kpi_targets_period_target_type_assigned_to_key;
ALTER TABLE public.kpi_targets
  ADD CONSTRAINT kpi_targets_organization_period_target_assignee_key
  UNIQUE NULLS NOT DISTINCT (
    organization_id, period, target_type, assigned_to
  );

ALTER TABLE public.platform_staff ADD COLUMN role_key text;

-- Existing platform staff are security principals, so a tenant-level profile
-- role is not an acceptable source of platform authority. Operators applying
-- this migration must provide an explicitly approved JSON object keyed by the
-- immutable platform_staff.id, for example:
--   SET newme.platform_staff_role_mapping =
--     '{"staff-uuid":"platform_ops"}';
-- An empty table needs no mapping. Any unresolved or invalid row aborts the
-- migration before platform RPCs become reachable.
DO $$
DECLARE
  approved_mapping jsonb := COALESCE(
    NULLIF(current_setting('newme.platform_staff_role_mapping', true), ''),
    '{}'
  )::jsonb;
  unresolved_staff_ids text;
BEGIN
  IF jsonb_typeof(approved_mapping) <> 'object' THEN
    RAISE EXCEPTION 'platform_staff_role_mapping_must_be_object';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_each_text(approved_mapping) entry
    WHERE entry.value NOT IN (
      'platform_owner', 'platform_ops', 'platform_support', 'platform_auditor'
    )
  ) THEN
    RAISE EXCEPTION 'platform_staff_role_mapping_invalid_role';
  END IF;

  UPDATE public.platform_staff staff
  SET role_key = approved_mapping ->> staff.id::text
  WHERE staff.role_key IS NULL
    AND approved_mapping ? staff.id::text;

  SELECT string_agg(staff.id::text, ',' ORDER BY staff.id::text)
  INTO unresolved_staff_ids
  FROM public.platform_staff staff
  WHERE staff.role_key IS NULL;
  IF unresolved_staff_ids IS NOT NULL THEN
    RAISE EXCEPTION 'platform_staff_role_mapping_required:%',
      unresolved_staff_ids;
  END IF;
END
$$;
ALTER TABLE public.platform_staff
  ALTER COLUMN role_key SET NOT NULL,
  ADD CONSTRAINT platform_staff_role_key_check CHECK (
    role_key IN (
      'platform_owner', 'platform_ops', 'platform_support', 'platform_auditor'
    )
  );

INSERT INTO public.capabilities (capability_key, scope, description)
VALUES
  ('organization.members.manage', 'organization',
    'Invite organization members and assign organization roles.'),
  ('organization.data.export', 'organization',
    'Export the complete customer-owned organization package.'),
  ('organization.data.read', 'organization',
    'Read organization-owned operational data.'),
  ('organization.data.create', 'organization',
    'Create organization-owned operational data.'),
  ('organization.data.update', 'organization',
    'Update organization-owned operational data.'),
  ('organization.data.delete', 'organization',
    'Delete organization-owned operational data.'),
  ('leads.read', 'organization', 'Read organization-owned leads.'),
  ('leads.write', 'organization', 'Write organization-owned leads.'),
  ('leads.import', 'organization', 'Import leads atomically for an organization.'),
  ('leads.export', 'organization', 'Export organization-owned lead data.'),
  ('storage.files.read', 'organization', 'Download registered tenant files.'),
  ('storage.files.write', 'organization', 'Register owned draft tenant files.'),
  ('storage.files.write_any', 'organization',
    'Register draft tenant files for any organization record.'),
  ('storage.files.seal', 'organization', 'Register and confirm sealed contract files.'),
  ('kpi.targets.read', 'organization', 'Read KPI targets for the selected organization.'),
  ('kpi.targets.manage', 'organization', 'Replace or delete KPI targets atomically.'),
  ('payments.read', 'organization', 'Read payments in the selected organization.'),
  ('payments.create', 'organization', 'Record payments for an owned organization contract.'),
  ('payments.confirm', 'organization', 'Confirm payments for the selected organization.'),
  ('payments.allocate', 'organization', 'Allocate payments for the selected organization.'),
  ('contracts.read', 'organization', 'Read contracts in the selected organization.'),
  ('contracts.create', 'organization', 'Create contracts in the selected organization.'),
  ('contracts.update', 'organization', 'Update owned contracts in the selected organization.'),
  ('contracts.write_any', 'organization', 'Update any contract in the selected organization.'),
  ('quotations.convert', 'organization', 'Convert an owned quotation in the selected organization.')
ON CONFLICT (scope, capability_key) DO UPDATE
SET description = EXCLUDED.description;

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
FROM public.roles role
CROSS JOIN public.capabilities capability
WHERE role.scope = 'organization'
  AND capability.scope = 'organization'
  AND (
    (capability.capability_key = 'organization.members.manage'
      AND role.role_key IN ('org_owner', 'org_admin'))
    OR (capability.capability_key = 'organization.data.export'
      AND role.role_key IN ('org_owner', 'org_admin', 'finance'))
    OR (capability.capability_key = 'organization.data.read'
      AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'finance',
        'specialist', 'sales_agent'
      ))
    OR (capability.capability_key IN (
        'organization.data.create', 'organization.data.update',
        'organization.data.delete'
      ) AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'sales_agent'
      ))
    OR (capability.capability_key IN (
        'leads.read', 'storage.files.read'
      ) AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'finance',
        'specialist', 'sales_agent'
      ))
    OR (capability.capability_key IN (
        'leads.write', 'storage.files.write'
      ) AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'sales_agent'
      ))
    OR (capability.capability_key = 'storage.files.write_any'
      AND role.role_key IN ('org_owner', 'org_admin', 'operations'))
    OR (capability.capability_key = 'storage.files.seal'
      AND role.role_key IN ('org_owner', 'org_admin'))
    OR (capability.capability_key = 'kpi.targets.read'
      AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'finance',
        'specialist', 'sales_agent'
      ))
    OR (capability.capability_key IN ('payments.read', 'contracts.read')
      AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'finance', 'sales_agent'
      ))
    OR (capability.capability_key = 'kpi.targets.manage'
      AND role.role_key IN ('org_owner', 'org_admin', 'operations'))
    OR (capability.capability_key = 'payments.create'
      AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'finance', 'sales_agent'
      ))
    OR (capability.capability_key IN ('payments.confirm', 'payments.allocate')
      AND role.role_key IN ('org_owner', 'org_admin', 'finance'))
    OR (capability.capability_key IN ('contracts.create', 'contracts.update')
      AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'sales_agent'
      ))
    OR (capability.capability_key = 'contracts.write_any'
      AND role.role_key IN ('org_owner', 'org_admin', 'operations'))
    OR (capability.capability_key = 'quotations.convert'
      AND role.role_key IN (
        'org_owner', 'org_admin', 'operations', 'sales_agent'
      ))
    OR (capability.capability_key IN ('leads.import', 'leads.export')
      AND role.role_key IN ('org_owner', 'org_admin', 'operations'))
  )
ON CONFLICT (role_id, capability_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.v4_actor_has_capability(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_capability_key text,
  p_access_mode text DEFAULT 'read'
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organizations organization
    JOIN public.memberships membership
      ON membership.organization_id = organization.id
    JOIN public.profiles profile ON profile.id = membership.user_id
    JOIN public.membership_roles membership_role
      ON membership_role.membership_id = membership.id
     AND membership_role.organization_id = organization.id
     AND membership_role.revoked_at IS NULL
    JOIN public.roles role ON role.id = membership_role.role_id
    JOIN public.role_capabilities role_capability
      ON role_capability.role_id = role.id
    JOIN public.capabilities capability
      ON capability.id = role_capability.capability_id
    WHERE organization.id = p_organization_id
      AND (
        COALESCE(NULLIF(current_setting('role', true), ''), session_user)
          = 'service_role'
        OR (
          p_actor_user_id = auth.uid()
          AND p_organization_id = public.requested_organization_id()
        )
      )
      AND profile.id = p_actor_user_id
      AND profile.is_active IS TRUE
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND role.scope = 'organization'
      AND capability.scope = 'organization'
      AND capability.capability_key = p_capability_key
      AND CASE p_access_mode
        WHEN 'write' THEN organization.status = 'active'
        WHEN 'export' THEN organization.status IN (
          'active', 'read_only', 'suspended', 'export_only'
        )
        ELSE organization.status IN ('active', 'read_only')
      END
  )
$$;

REVOKE ALL ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_actor_has_capability(uuid, uuid, text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.v4_actor_has_organization_role(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_role_keys text[]
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships membership
    JOIN public.profiles profile ON profile.id = membership.user_id
    JOIN public.membership_roles membership_role
      ON membership_role.membership_id = membership.id
     AND membership_role.organization_id = membership.organization_id
     AND membership_role.revoked_at IS NULL
    JOIN public.roles role ON role.id = membership_role.role_id
    WHERE membership.organization_id = p_organization_id
      AND membership.user_id = p_actor_user_id
      AND (
        COALESCE(NULLIF(current_setting('role', true), ''), session_user)
          = 'service_role'
        OR (
          p_actor_user_id = auth.uid()
          AND p_organization_id = public.requested_organization_id()
        )
      )
      AND profile.is_active IS TRUE
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND role.scope = 'organization'
      AND role.role_key = ANY(p_role_keys)
  )
$$;

REVOKE ALL ON FUNCTION public.v4_actor_has_organization_role(uuid, uuid, text[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_actor_has_organization_role(uuid, uuid, text[])
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.v4_assign_tenant_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  row_data jsonb := CASE WHEN TG_OP = 'DELETE'
    THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  derived_organization_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'tenant_organization_id_immutable';
  END IF;

  IF TG_TABLE_NAME = 'membership_roles' THEN
    SELECT membership.organization_id INTO derived_organization_id
    FROM public.memberships membership
    WHERE membership.id = NULLIF(row_data ->> 'membership_id', '')::uuid;
  ELSIF row_data ? 'tenant_id'
    AND NULLIF(row_data ->> 'tenant_id', '') IS NOT NULL
  THEN
    derived_organization_id := (row_data ->> 'tenant_id')::uuid;
  ELSIF row_data ? 'lead_id'
    AND NULLIF(row_data ->> 'lead_id', '') IS NOT NULL
  THEN
    SELECT lead_row.organization_id INTO derived_organization_id
    FROM public.leads lead_row
    WHERE lead_row.id = (row_data ->> 'lead_id')::uuid;
  END IF;

  IF derived_organization_id IS NULL AND TG_TABLE_NAME = 'activities' THEN
    SELECT parent.organization_id INTO derived_organization_id
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
  IF derived_organization_id IS NULL AND TG_TABLE_NAME = 'quotes' THEN
    SELECT project.organization_id INTO derived_organization_id
    FROM public.projects project
    WHERE project.id = NULLIF(row_data ->> 'project_id', '')::uuid;
  END IF;
  IF derived_organization_id IS NULL THEN
    derived_organization_id := public.requested_organization_id();
  END IF;
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := derived_organization_id;
  ELSIF derived_organization_id IS NOT NULL
    AND NEW.organization_id <> derived_organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'tenant_organization_parent_mismatch';
  END IF;
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502', MESSAGE = 'organization_context_required';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_assign_tenant_organization()
  FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  expected_policy record;
BEGIN
  FOR expected_policy IN
    SELECT * FROM (VALUES
      ('notifications', 'policy_notifications_select_self', 'user_id'),
      ('notifications', 'policy_notifications_select_admin', 'profiles'),
      ('kpi_targets', 'policy_kpi_targets_select_admin', 'profiles'),
      ('kpi_targets', 'policy_kpi_targets_select_sales', 'assigned_to')
    ) expected(table_name, policy_name, required_qual_token)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected_policy.table_name
        AND policy.policyname = expected_policy.policy_name
        AND policy.permissive = 'PERMISSIVE'
        AND policy.roles @> ARRAY['authenticated']::name[]
        AND policy.qual ILIKE '%' || expected_policy.required_qual_token || '%'
    ) THEN
      RAISE EXCEPTION 'v4_legacy_policy_contract_mismatch:%.%',
        expected_policy.table_name, expected_policy.policy_name;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  table_name text;
  membership_manage_condition text;
  legacy_policy record;
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
    -- Keep owner/self policies, but remove every browser policy whose decision
    -- is still coupled to the legacy global profile role.
    FOR legacy_policy IN
      SELECT policy.policyname
      FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = table_name
        AND policy.permissive = 'PERMISSIVE'
        AND (
          policy.roles @> ARRAY['public']::name[]
          OR policy.roles @> ARRAY['authenticated']::name[]
        )
        AND (
          table_name IN ('activity_logs', 'audit_logs', 'user_session_daily')
          OR
          COALESCE(policy.qual, '') ILIKE '%profiles%'
          OR COALESCE(policy.with_check, '') ILIKE '%profiles%'
          OR COALESCE(policy.qual, '') ILIKE '%get_my_role%'
          OR COALESCE(policy.with_check, '') ILIKE '%get_my_role%'
        )
    LOOP
      EXECUTE format(
        'DROP POLICY %I ON public.%I', legacy_policy.policyname, table_name
      );
    END LOOP;

    membership_manage_condition := CASE WHEN table_name = 'membership_roles'
      THEN ' AND public.v4_actor_has_capability('
        || 'organization_id, auth.uid(), ''organization.members.manage'', ''write'')'
      ELSE '' END;
    EXECUTE format(
      'CREATE TRIGGER aa_v4_assign_tenant_organization '
        || 'BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW '
        || 'EXECUTE FUNCTION public.v4_assign_tenant_organization()',
      table_name
    );
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY v4_tenant_membership_read_base ON public.%I AS PERMISSIVE '
        || 'FOR SELECT TO authenticated USING ('
        || 'public.v4_actor_has_organization_role(organization_id, auth.uid(), '
        || 'ARRAY[''org_owner'', ''org_admin'', ''operations'', ''finance'']))',
      table_name
    );
    IF table_name NOT IN ('activity_logs', 'audit_logs', 'user_session_daily') THEN
      EXECUTE format(
        'CREATE POLICY v4_tenant_membership_insert_base ON public.%I AS PERMISSIVE '
        || 'FOR INSERT TO authenticated WITH CHECK ('
        || 'public.v4_actor_has_organization_role(organization_id, auth.uid(), '
        || 'ARRAY[''org_owner'', ''org_admin'', ''operations'']))',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY v4_tenant_membership_update_base ON public.%I AS PERMISSIVE '
        || 'FOR UPDATE TO authenticated USING ('
        || 'public.v4_actor_has_organization_role(organization_id, auth.uid(), '
        || 'ARRAY[''org_owner'', ''org_admin'', ''operations''])) '
        || 'WITH CHECK (public.v4_actor_has_organization_role('
        || 'organization_id, auth.uid(), '
        || 'ARRAY[''org_owner'', ''org_admin'', ''operations'']))',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY v4_tenant_membership_delete_base ON public.%I AS PERMISSIVE '
        || 'FOR DELETE TO authenticated USING ('
        || 'public.v4_actor_has_organization_role(organization_id, auth.uid(), '
        || 'ARRAY[''org_owner'', ''org_admin'']))',
        table_name
      );
    ELSE
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM authenticated',
        table_name
      );
    END IF;
    EXECUTE format(
      'CREATE POLICY v4_tenant_read_gate ON public.%I AS RESTRICTIVE '
        || 'FOR SELECT TO authenticated USING ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability('
        || 'organization_id, auth.uid(), ''organization.data.read'', ''read''))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY v4_tenant_insert_gate ON public.%I AS RESTRICTIVE '
        || 'FOR INSERT TO authenticated WITH CHECK ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability('
        || 'organization_id, auth.uid(), ''organization.data.create'', ''write'')'
        || '%s)',
      table_name,
      membership_manage_condition
    );
    EXECUTE format(
      'CREATE POLICY v4_tenant_update_gate ON public.%I AS RESTRICTIVE '
        || 'FOR UPDATE TO authenticated USING ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability('
        || 'organization_id, auth.uid(), ''organization.data.update'', ''write'')'
        || '%s) '
        || 'WITH CHECK (organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability('
        || 'organization_id, auth.uid(), ''organization.data.update'', ''write'')'
        || '%s)',
      table_name,
      membership_manage_condition,
      membership_manage_condition
    );
    EXECUTE format(
      'CREATE POLICY v4_tenant_delete_gate ON public.%I AS RESTRICTIVE '
        || 'FOR DELETE TO authenticated USING ('
        || 'organization_id = public.requested_organization_id() AND '
        || 'public.v4_actor_has_capability('
        || 'organization_id, auth.uid(), ''organization.data.delete'', ''write'')'
        || '%s)',
      table_name,
      membership_manage_condition
    );
  END LOOP;
END
$$;

-- Notifications remain owner-scoped for browser reads and read-state updates;
-- browser inserts are revoked so system events can only be written by trusted
-- organization-bound business handlers.
DO $$
DECLARE legacy_policy record;
BEGIN
  FOR legacy_policy IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notifications'
      AND permissive = 'PERMISSIVE'
      AND (roles @> ARRAY['public']::name[]
        OR roles @> ARRAY['authenticated']::name[])
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.notifications', legacy_policy.policyname
    );
  END LOOP;
END
$$;
CREATE POLICY v4_notifications_read_self
  ON public.notifications AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY v4_notifications_read_managers
  ON public.notifications AS PERMISSIVE FOR SELECT TO authenticated
  USING (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
  ));
CREATE POLICY v4_notifications_update_self
  ON public.notifications AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY v4_notifications_delete_self
  ON public.notifications AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_id = auth.uid());
REVOKE INSERT ON TABLE public.notifications FROM authenticated;

-- KPI targets preserve the team-wide/self read pool while management is
-- derived from the selected organization role, never profiles.role.
DO $$
DECLARE legacy_policy record;
BEGIN
  FOR legacy_policy IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'kpi_targets'
      AND permissive = 'PERMISSIVE'
      AND (roles @> ARRAY['public']::name[]
        OR roles @> ARRAY['authenticated']::name[])
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.kpi_targets', legacy_policy.policyname
    );
  END LOOP;
END
$$;
CREATE POLICY v4_kpi_targets_membership_read
  ON public.kpi_targets AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(),
      ARRAY['org_owner', 'org_admin', 'operations', 'finance']
    )
    OR assigned_to = auth.uid()
    OR assigned_to IS NULL
  );
CREATE POLICY v4_kpi_targets_membership_insert
  ON public.kpi_targets AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
  ));
CREATE POLICY v4_kpi_targets_membership_update
  ON public.kpi_targets AS PERMISSIVE FOR UPDATE TO authenticated
  USING (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
  ))
  WITH CHECK (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
  ));
CREATE POLICY v4_kpi_targets_membership_delete
  ON public.kpi_targets AS PERMISSIVE FOR DELETE TO authenticated
  USING (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
  ));

CREATE TRIGGER aa_v4_assign_tenant_organization
  BEFORE INSERT OR UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.v4_assign_tenant_organization();

-- Leads predate this migration. FORCE is intentional here so table-owner
-- application paths cannot bypass the selected-organization capability gates.
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads FORCE ROW LEVEL SECURITY;

-- A restrictive capability policy cannot neutralize a permissive legacy
-- profiles.role policy: PostgreSQL ORs permissive policies before applying the
-- restrictive gates. Remove every browser-facing permissive policy on the
-- three sensitive commercial roots, then replace them with selected-
-- organization membership and ownership rules.
DO $$
DECLARE
  expected_policy record;
BEGIN
  FOR expected_policy IN
    SELECT * FROM (VALUES
      ('leads', 'policy_leads_select_admin', 'profiles'),
      ('leads', 'policy_leads_select_sales', 'assigned_to'),
      ('contracts', 'policy_contracts_select_admin', 'profiles'),
      ('contracts', 'policy_contracts_select_sales', 'sales_id'),
      ('payments', 'policy_payments_select_admin', 'profiles'),
      ('payments', 'policy_payments_select_sales', 'contracts')
    ) expected(table_name, policy_name, required_qual_token)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies policy
      WHERE policy.schemaname = 'public'
        AND policy.tablename = expected_policy.table_name
        AND policy.policyname = expected_policy.policy_name
        AND policy.permissive = 'PERMISSIVE'
        AND policy.cmd = 'SELECT'
        AND policy.roles @> ARRAY['authenticated']::name[]
        AND policy.qual ILIKE '%' || expected_policy.required_qual_token || '%'
    ) THEN
      RAISE EXCEPTION 'v4_legacy_policy_contract_mismatch:%.%',
        expected_policy.table_name, expected_policy.policy_name;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  legacy_policy record;
BEGIN
  FOR legacy_policy IN
    SELECT policy.tablename, policy.policyname
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename IN ('leads', 'contracts', 'payments')
      AND policy.permissive = 'PERMISSIVE'
      AND (
        policy.roles @> ARRAY['public']::name[]
        OR policy.roles @> ARRAY['authenticated']::name[]
      )
  LOOP
    EXECUTE format(
      'DROP POLICY %I ON public.%I',
      legacy_policy.policyname,
      legacy_policy.tablename
    );
  END LOOP;
END
$$;

CREATE POLICY v4_leads_membership_access
  ON public.leads AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(),
      ARRAY['org_owner', 'org_admin', 'operations', 'finance', 'specialist']
    )
    OR assigned_to = auth.uid()
  );
CREATE POLICY v4_leads_membership_insert
  ON public.leads AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
    )
    OR assigned_to = auth.uid()
  );
CREATE POLICY v4_leads_membership_update
  ON public.leads AS PERMISSIVE FOR UPDATE TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
    )
    OR assigned_to = auth.uid()
  )
  WITH CHECK (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
    )
    OR assigned_to = auth.uid()
  );
CREATE POLICY v4_leads_membership_delete
  ON public.leads AS PERMISSIVE FOR DELETE TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin']
    )
    OR assigned_to = auth.uid()
  );

CREATE POLICY v4_leads_read_gate
  ON public.leads AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'leads.read', 'read'
    )
  );
CREATE POLICY v4_leads_insert_gate
  ON public.leads AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'leads.write', 'write'
    )
  );
CREATE POLICY v4_leads_update_gate
  ON public.leads AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'leads.write', 'write'
    )
  )
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'leads.write', 'write'
    )
  );
CREATE POLICY v4_leads_delete_gate
  ON public.leads AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'leads.write', 'write'
    )
  );

CREATE POLICY v4_contracts_membership_access
  ON public.contracts AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(),
      ARRAY['org_owner', 'org_admin', 'operations', 'finance']
    )
    OR sales_id = auth.uid()
  );
CREATE POLICY v4_contracts_membership_insert
  ON public.contracts AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
    )
    OR sales_id = auth.uid()
  );
CREATE POLICY v4_contracts_membership_update
  ON public.contracts AS PERMISSIVE FOR UPDATE TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
    )
    OR sales_id = auth.uid()
  )
  WITH CHECK (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'operations']
    )
    OR sales_id = auth.uid()
  );
CREATE POLICY v4_contracts_membership_delete
  ON public.contracts AS PERMISSIVE FOR DELETE TO authenticated
  USING (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin']
  ));

CREATE POLICY v4_payments_membership_access
  ON public.payments AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(),
      ARRAY['org_owner', 'org_admin', 'operations', 'finance']
    )
    OR EXISTS (
      SELECT 1 FROM public.contracts contract
      WHERE contract.id = payments.contract_id
        AND contract.organization_id = payments.organization_id
        AND contract.sales_id = auth.uid()
    )
  );
CREATE POLICY v4_payments_membership_insert
  ON public.payments AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    public.v4_actor_has_organization_role(
      organization_id, auth.uid(),
      ARRAY['org_owner', 'org_admin', 'operations', 'finance']
    )
    OR EXISTS (
      SELECT 1 FROM public.contracts contract
      WHERE contract.id = payments.contract_id
        AND contract.organization_id = payments.organization_id
        AND contract.sales_id = auth.uid()
    )
  );
CREATE POLICY v4_payments_membership_update
  ON public.payments AS PERMISSIVE FOR UPDATE TO authenticated
  USING (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'finance']
  ))
  WITH CHECK (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin', 'finance']
  ));
CREATE POLICY v4_payments_membership_delete
  ON public.payments AS PERMISSIVE FOR DELETE TO authenticated
  USING (public.v4_actor_has_organization_role(
    organization_id, auth.uid(), ARRAY['org_owner', 'org_admin']
  ));

-- These commercial tables already have the SAM-23 restrictive organization
-- boundary. The additional restrictive policies bind sensitive actions to the
-- role/capability held in the currently selected organization, rather than the
-- legacy global profiles.role value.
CREATE POLICY v4_kpi_targets_read_capability
  ON public.kpi_targets AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'kpi.targets.read', 'read'
    )
  );
CREATE POLICY v4_kpi_targets_insert_capability
  ON public.kpi_targets AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'kpi.targets.manage', 'write'
    )
  );
CREATE POLICY v4_kpi_targets_update_capability
  ON public.kpi_targets AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'kpi.targets.manage', 'write'
    )
  )
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'kpi.targets.manage', 'write'
    )
  );
CREATE POLICY v4_kpi_targets_delete_capability
  ON public.kpi_targets AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'kpi.targets.manage', 'write'
    )
  );

CREATE POLICY v4_payments_read_capability
  ON public.payments AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'payments.read', 'read'
    )
  );
CREATE POLICY v4_payments_insert_capability
  ON public.payments AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'payments.create', 'write'
    )
    AND EXISTS (
      SELECT 1 FROM public.contracts contract
      WHERE contract.id = payments.contract_id
        AND contract.organization_id = payments.organization_id
        AND (
          contract.sales_id = auth.uid()
          OR public.v4_actor_has_capability(
            payments.organization_id, auth.uid(), 'contracts.write_any', 'write'
          )
          OR public.v4_actor_has_capability(
            payments.organization_id, auth.uid(), 'payments.confirm', 'write'
          )
        )
    )
  );
CREATE POLICY v4_payments_update_capability
  ON public.payments AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'payments.confirm', 'write'
    )
  )
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'payments.confirm', 'write'
    )
  );

CREATE POLICY v4_contracts_read_capability
  ON public.contracts AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'contracts.read', 'read'
    )
  );
CREATE POLICY v4_contracts_insert_capability
  ON public.contracts AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'contracts.create', 'write'
    )
    AND (
      sales_id = auth.uid()
      OR public.v4_actor_has_capability(
        organization_id, auth.uid(), 'contracts.write_any', 'write'
      )
    )
  );
CREATE POLICY v4_contracts_update_capability
  ON public.contracts AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'contracts.update', 'write'
    )
    AND (
      sales_id = auth.uid()
      OR public.v4_actor_has_capability(
        organization_id, auth.uid(), 'contracts.write_any', 'write'
      )
    )
  )
  WITH CHECK (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'contracts.update', 'write'
    )
    AND (
      sales_id = auth.uid()
      OR public.v4_actor_has_capability(
        organization_id, auth.uid(), 'contracts.write_any', 'write'
      )
    )
  );

CREATE POLICY v4_contracts_delete_capability
  ON public.contracts AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'organization.data.delete', 'write'
    )
    AND public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin']
    )
  );
CREATE POLICY v4_payments_delete_capability
  ON public.payments AS RESTRICTIVE FOR DELETE TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'organization.data.delete', 'write'
    )
    AND public.v4_actor_has_organization_role(
      organization_id, auth.uid(), ARRAY['org_owner', 'org_admin']
    )
  );

DO $$
DECLARE residual_policy record;
BEGIN
  SELECT policy.tablename, policy.policyname INTO residual_policy
  FROM pg_policies policy
  WHERE policy.schemaname = 'public'
    AND policy.tablename = ANY(ARRAY[
      'membership_roles', 'activities', 'activity_logs', 'ad_spend',
      'audit_logs', 'business_events', 'chat_messages', 'customers',
      'follow_up_logs', 'knx_designs', 'kpi_targets',
      'lead_assignment_state', 'lead_deletion_requests', 'lead_files',
      'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
      'notifications', 'quotes', 'transfer_history', 'user_session_daily',
      'leads', 'contracts', 'payments'
    ]::text[])
    AND (
      policy.roles @> ARRAY['public']::name[]
      OR policy.roles @> ARRAY['authenticated']::name[]
    )
    AND (
      COALESCE(policy.qual, '') ILIKE '%profiles%role%'
      OR COALESCE(policy.with_check, '') ILIKE '%profiles%role%'
      OR COALESCE(policy.qual, '') ILIKE '%get_my_role%'
      OR COALESCE(policy.with_check, '') ILIKE '%get_my_role%'
    )
  ORDER BY policy.tablename, policy.policyname
  LIMIT 1;
  IF residual_policy.policyname IS NOT NULL THEN
    RAISE EXCEPTION 'v4_global_profile_role_policy_remaining:%.%',
      residual_policy.tablename, residual_policy.policyname;
  END IF;
END
$$;

CREATE TABLE public.organization_lifecycle_requests (
  request_id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('suspend', 'recover')),
  previous_status text NOT NULL,
  target_status text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 12),
  actor_platform_staff_id uuid NOT NULL REFERENCES public.platform_staff(id),
  approver_platform_staff_id uuid NOT NULL REFERENCES public.platform_staff(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_platform_staff_id <> approver_platform_staff_id)
);

-- Lifecycle requests are immutable service-written audit evidence. FORCE is
-- explicit so ownership never becomes an accidental read or mutation bypass.
ALTER TABLE public.organization_lifecycle_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_lifecycle_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE public.tenant_file_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  record_type text NOT NULL CHECK (record_type IN ('contract', 'lead', 'quotation')),
  record_id uuid NOT NULL,
  object_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  version text NOT NULL DEFAULT 'draft' CHECK (version IN ('draft', 'sealed', 'attachment')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'available', 'deletion_pending',
    'failed', 'deleted', 'cancelled', 'expired'
  )),
  content_type text NOT NULL,
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes >= 0),
  expected_content_md5 text NOT NULL
    CHECK (expected_content_md5 ~ '^[A-Za-z0-9+/]{22}==$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  provider_etag text,
  provider_checksum_crc64ecma text,
  provider_verified_at timestamptz,
  created_by uuid NOT NULL REFERENCES public.profiles(id),
  confirmed_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  upload_url_expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  pending_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  confirmed_at timestamptz,
  terminal_at timestamptz,
  terminal_reason text,
  request_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id, request_id),
  CHECK (object_key LIKE 'organizations/' || organization_id::text || '/%'),
  CHECK (upload_url_expires_at > created_at),
  CHECK (pending_expires_at > created_at),
  CHECK ((status IN ('cancelled', 'expired', 'failed', 'deleted'))
    = (terminal_at IS NOT NULL))
);

CREATE TABLE public.tenant_file_deletion_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL
    CONSTRAINT tenant_file_deletion_outbox_file_id_key UNIQUE
    REFERENCES public.tenant_file_objects(id) ON DELETE RESTRICT,
  object_key text NOT NULL UNIQUE,
  terminal_status text NOT NULL CHECK (
    terminal_status IN ('cancelled', 'expired', 'failed', 'deleted')
  ),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'completed')),
  provider_delete_not_before timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  requested_by uuid REFERENCES public.profiles(id),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (organization_id, request_id),
  CHECK (object_key LIKE 'organizations/' || organization_id::text || '/%'),
  CHECK ((status = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

CREATE INDEX tenant_file_deletion_outbox_claim_idx
  ON public.tenant_file_deletion_outbox (
    status, provider_delete_not_before, next_attempt_at, created_at
  );

CREATE TABLE public.organization_document_sequences (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  document_kind text NOT NULL CHECK (document_kind IN ('contract')),
  document_date date NOT NULL,
  next_value integer NOT NULL CHECK (next_value BETWEEN 2 AND 1000),
  PRIMARY KEY (organization_id, document_kind, document_date)
);

DO $$
DECLARE invalid_contract record;
BEGIN
  SELECT contract.id, contract.contract_no INTO invalid_contract
  FROM public.contracts contract
  WHERE contract.contract_date IS NULL
    OR contract.contract_no !~ '^NEW-[0-9]{8}-[0-9]{3}$'
    OR CASE
      WHEN contract.contract_no ~ '^NEW-[0-9]{8}-[0-9]{3}$' THEN
        substring(contract.contract_no FROM 5 FOR 8)
          <> to_char(contract.contract_date, 'YYYYMMDD')
        OR right(contract.contract_no, 3)::integer NOT BETWEEN 1 AND 999
      ELSE false
    END
  ORDER BY contract.id LIMIT 1;
  IF invalid_contract.id IS NOT NULL THEN
    RAISE EXCEPTION 'legacy_contract_number_invalid:%:%',
      invalid_contract.id, invalid_contract.contract_no;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.contracts contract
    GROUP BY contract.organization_id, contract.contract_date,
      right(contract.contract_no, 3)::integer
    HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'legacy_contract_number_conflict'; END IF;

  INSERT INTO public.organization_document_sequences (
    organization_id, document_kind, document_date, next_value
  )
  SELECT contract.organization_id, 'contract', contract.contract_date,
    max(right(contract.contract_no, 3)::integer) + 1
  FROM public.contracts contract
  GROUP BY contract.organization_id, contract.contract_date;
END
$$;

CREATE TABLE public.contract_workflow_requests (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('contract.create', 'quotation.convert')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  actor_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (organization_id, request_id),
  CHECK ((result IS NOT NULL) = (completed_at IS NOT NULL))
);

CREATE TABLE public.platform_action_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_key text NOT NULL CHECK (action_key IN (
    'organization.provision', 'organization.suspend', 'organization.recover',
    'organization.exit.prepare', 'organization.exit.complete',
    'support.session.start'
  )),
  target_key text NOT NULL CHECK (length(btrim(target_key)) BETWEEN 3 AND 180),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed')),
  requested_by_platform_staff_id uuid NOT NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  approved_by_platform_staff_id uuid
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  request_id text NOT NULL UNIQUE,
  consumption_key text,
  execution_result jsonb,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  CHECK (
    approved_by_platform_staff_id IS NULL
    OR approved_by_platform_staff_id <> requested_by_platform_staff_id
  ),
  CHECK ((status = 'pending') = (approved_at IS NULL)),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (execution_result IS NOT NULL)),
  CHECK (expires_at > requested_at)
);

CREATE TABLE public.platform_action_approval_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL
    REFERENCES public.platform_action_approvals(id) ON DELETE RESTRICT,
  actor_platform_staff_id uuid NOT NULL
    REFERENCES public.platform_staff(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('requested', 'approved', 'consumed')),
  request_id text NOT NULL UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_action_approvals_pending_idx
  ON public.platform_action_approvals (status, expires_at, action_key);
CREATE INDEX platform_action_approval_events_request_idx
  ON public.platform_action_approval_events (approval_request_id, created_at);
ALTER TABLE public.platform_action_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_action_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.platform_action_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_action_approval_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_action_approvals,
  public.platform_action_approval_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.platform_action_approvals,
  public.platform_action_approval_events TO service_role;

ALTER TABLE public.tenant_file_deletion_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_file_deletion_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_document_sequences FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contract_workflow_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_workflow_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_file_deletion_outbox,
  public.organization_document_sequences,
  public.contract_workflow_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tenant_file_deletion_outbox,
  public.organization_document_sequences,
  public.contract_workflow_requests TO service_role;

CREATE INDEX tenant_file_objects_record_idx
  ON public.tenant_file_objects (organization_id, record_type, record_id, status);
ALTER TABLE public.tenant_file_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_file_objects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.organization_lifecycle_requests,
  public.tenant_file_objects FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.organization_lifecycle_requests,
  public.tenant_file_objects TO service_role;
GRANT SELECT (
  id, organization_id, record_type, record_id, object_key,
  original_filename, version, status, content_type, expected_size_bytes,
  expected_content_md5, size_bytes, provider_etag,
  provider_checksum_crc64ecma, created_by, confirmed_by, created_at,
  upload_url_expires_at, pending_expires_at, confirmed_at,
  terminal_at, terminal_reason
) ON TABLE public.tenant_file_objects TO authenticated;

CREATE POLICY v4_tenant_files_read
  ON public.tenant_file_objects FOR SELECT TO authenticated
  USING (
    organization_id = public.requested_organization_id()
    AND public.v4_actor_has_capability(
      organization_id, auth.uid(), 'storage.files.read', 'read'
    )
  );

CREATE OR REPLACE FUNCTION public.v4_assert_tenant_closure_rollback_safe()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  table_name text;
  has_nonlegacy_rows boolean;
  legacy_organization_id constant uuid :=
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid;
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'v4_tenant_lifecycle_closure_rollback_requires_staging_or_test';
  END IF;
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
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE organization_id <> $1)',
      table_name
    ) INTO has_nonlegacy_rows USING legacy_organization_id;
    IF has_nonlegacy_rows THEN
      RAISE EXCEPTION 'v4_tenant_lifecycle_closure_rollback_unscoped_data:%',
        table_name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.tenant_file_objects)
    OR EXISTS (SELECT 1 FROM public.tenant_file_deletion_outbox)
    OR EXISTS (SELECT 1 FROM public.contract_workflow_requests)
    OR EXISTS (SELECT 1 FROM public.organization_lifecycle_requests)
    OR EXISTS (SELECT 1 FROM public.platform_action_approvals)
    OR EXISTS (SELECT 1 FROM public.platform_action_approval_events)
  THEN
    RAISE EXCEPTION 'v4_tenant_lifecycle_closure_rollback_new_records_present';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_assert_tenant_closure_rollback_safe()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_assert_tenant_closure_rollback_safe()
  TO service_role;

CREATE OR REPLACE FUNCTION public.v4_platform_payload_hash(p_payload jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT encode(
    extensions.digest(convert_to(COALESCE(p_payload, 'null'::jsonb)::text, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

REVOKE ALL ON FUNCTION public.v4_platform_payload_hash(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_platform_payload_hash(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.v4_request_platform_action_approval(
  p_action_key text,
  p_target_key text,
  p_payload jsonb,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  actor_staff_id uuid;
  actor_staff_role text;
  canonical_payload jsonb;
  payload_hash_value text;
  approval public.platform_action_approvals%ROWTYPE;
  inserted_id uuid;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF p_action_key NOT IN (
    'organization.provision', 'organization.suspend', 'organization.recover',
    'organization.exit.prepare', 'organization.exit.complete',
    'support.session.start'
  ) THEN RAISE EXCEPTION 'invalid_platform_action'; END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'platform_approval_payload_required';
  END IF;
  IF length(btrim(COALESCE(p_target_key, ''))) NOT BETWEEN 3 AND 180 THEN
    RAISE EXCEPTION 'platform_approval_target_required';
  END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'platform_approval_request_id_required';
  END IF;
  SELECT staff.id, staff.role_key INTO actor_staff_id, actor_staff_role
  FROM public.platform_staff staff
  JOIN public.profiles profile
    ON profile.id = staff.user_id AND profile.is_active IS TRUE
  WHERE staff.user_id = actor_user_id AND staff.status = 'active';
  IF actor_staff_id IS NULL THEN RAISE EXCEPTION 'platform_staff_required'; END IF;
  IF actor_staff_role NOT IN ('platform_owner', 'platform_ops') THEN
    RAISE EXCEPTION 'platform_action_request_permission_required';
  END IF;
  canonical_payload := CASE p_action_key
    WHEN 'organization.provision' THEN jsonb_build_object(
      'slug', lower(btrim(p_payload ->> 'slug')),
      'name', btrim(p_payload ->> 'name'),
      'industry_key', btrim(p_payload ->> 'industry_key'),
      'plan_key', btrim(p_payload ->> 'plan_key'),
      'billable_seat_limit', (p_payload ->> 'billable_seat_limit')::integer,
      'owner_user_id', (p_payload ->> 'owner_user_id')::uuid
    )
    WHEN 'organization.suspend' THEN jsonb_build_object(
      'organization_id', (p_payload ->> 'organization_id')::uuid,
      'action', 'suspend',
      'reason', btrim(p_payload ->> 'reason')
    )
    WHEN 'organization.recover' THEN jsonb_build_object(
      'organization_id', (p_payload ->> 'organization_id')::uuid,
      'action', 'recover',
      'reason', btrim(p_payload ->> 'reason')
    )
    WHEN 'organization.exit.prepare' THEN jsonb_build_object(
      'organization_id', (p_payload ->> 'organization_id')::uuid,
      'idempotency_key', btrim(p_payload ->> 'idempotency_key'),
      'reason', btrim(p_payload ->> 'reason')
    )
    WHEN 'organization.exit.complete' THEN jsonb_build_object(
      'organization_id', (p_payload ->> 'organization_id')::uuid,
      'idempotency_key', btrim(p_payload ->> 'idempotency_key'),
      'expected_export_sha256', lower(btrim(p_payload ->> 'expected_export_sha256')),
      'backup_evidence_ref', btrim(p_payload ->> 'backup_evidence_ref'),
      'customer_confirmation_ref', btrim(p_payload ->> 'customer_confirmation_ref'),
      'retention_basis', btrim(p_payload ->> 'retention_basis')
    )
    WHEN 'support.session.start' THEN jsonb_build_object(
      'support_user_id', (p_payload ->> 'support_user_id')::uuid,
      'organization_id', (p_payload ->> 'organization_id')::uuid,
      'ticket_ref', btrim(p_payload ->> 'ticket_ref'),
      'reason', btrim(p_payload ->> 'reason'),
      'scope', p_payload -> 'scope',
      'expires_at', btrim(p_payload ->> 'expires_at')
    )
  END;
  IF canonical_payload IS NULL OR canonical_payload IS DISTINCT FROM p_payload THEN
    RAISE EXCEPTION 'noncanonical_platform_approval_payload';
  END IF;
  IF (
      p_action_key = 'organization.provision'
      AND btrim(p_target_key) <> (canonical_payload ->> 'slug')
    ) OR (
      p_action_key <> 'organization.provision'
      AND btrim(p_target_key) <> (canonical_payload ->> 'organization_id')
  )
  THEN RAISE EXCEPTION 'platform_approval_target_mismatch'; END IF;
  IF p_action_key = 'support.session.start' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.platform_staff support_staff
      JOIN public.profiles support_profile
        ON support_profile.id = support_staff.user_id
       AND support_profile.is_active IS TRUE
      WHERE support_staff.user_id = (canonical_payload ->> 'support_user_id')::uuid
        AND support_staff.status = 'active'
        AND support_staff.role_key IN ('platform_support', 'platform_ops')
    ) THEN RAISE EXCEPTION 'active_support_actor_required'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.organizations
      WHERE id = (canonical_payload ->> 'organization_id')::uuid
        AND status = 'active'
    ) THEN RAISE EXCEPTION 'active_support_organization_required'; END IF;
    IF length(canonical_payload ->> 'ticket_ref') NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'support_ticket_ref_required';
    END IF;
    IF length(canonical_payload ->> 'reason') NOT BETWEEN 1 AND 1000 THEN
      RAISE EXCEPTION 'support_reason_required';
    END IF;
    IF jsonb_typeof(canonical_payload -> 'scope') <> 'array'
      OR jsonb_array_length(canonical_payload -> 'scope') = 0
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(canonical_payload -> 'scope') item(value)
        WHERE jsonb_typeof(item.value) <> 'string'
          OR item.value #>> '{}' NOT IN ('lead:read', 'lead:write')
      )
    THEN RAISE EXCEPTION 'support_scope_invalid'; END IF;
    IF (canonical_payload ->> 'expires_at')::timestamptz <= statement_timestamp()
      OR (canonical_payload ->> 'expires_at')::timestamptz
        > statement_timestamp() + interval '4 hours'
    THEN RAISE EXCEPTION 'support_expiry_invalid'; END IF;
  END IF;
  payload_hash_value := public.v4_platform_payload_hash(canonical_payload);

  INSERT INTO public.platform_action_approvals (
    action_key, target_key, payload, payload_hash,
    requested_by_platform_staff_id, request_id
  ) VALUES (
    p_action_key, btrim(p_target_key), canonical_payload, payload_hash_value,
    actor_staff_id, btrim(p_request_id)
  )
  ON CONFLICT (request_id) DO NOTHING
  RETURNING id INTO inserted_id;

  SELECT * INTO approval FROM public.platform_action_approvals
  WHERE request_id = btrim(p_request_id) FOR UPDATE;
  IF approval.action_key <> p_action_key
    OR approval.target_key <> btrim(p_target_key)
    OR approval.payload_hash <> payload_hash_value
    OR approval.requested_by_platform_staff_id <> actor_staff_id
  THEN RAISE EXCEPTION 'platform_approval_idempotency_payload_mismatch'; END IF;

  IF inserted_id IS NOT NULL THEN
    INSERT INTO public.platform_action_approval_events (
      approval_request_id, actor_platform_staff_id, action, request_id, metadata
    ) VALUES (
      approval.id, actor_staff_id, 'requested',
      'approval-request:' || btrim(p_request_id),
      jsonb_build_object(
        'action_key', approval.action_key,
        'target_key', approval.target_key,
        'payload_hash', approval.payload_hash,
        'expires_at', approval.expires_at
      )
    );
  END IF;
  RETURN jsonb_build_object(
    'approval_request_id', approval.id,
    'status', approval.status,
    'action_key', approval.action_key,
    'target_key', approval.target_key,
    'payload_hash', approval.payload_hash,
    'expires_at', approval.expires_at,
    'idempotent', inserted_id IS NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_request_platform_action_approval(
  text, text, jsonb, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_request_platform_action_approval(
  text, text, jsonb, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_approve_platform_action(
  p_approval_request_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  approver_user_id uuid := auth.uid();
  approver_staff_id uuid;
  approver_staff_role text;
  approval public.platform_action_approvals%ROWTYPE;
BEGIN
  IF approver_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'platform_approval_request_id_required';
  END IF;
  SELECT staff.id, staff.role_key INTO approver_staff_id, approver_staff_role
  FROM public.platform_staff staff
  JOIN public.profiles profile
    ON profile.id = staff.user_id AND profile.is_active IS TRUE
  WHERE staff.user_id = approver_user_id AND staff.status = 'active';
  IF approver_staff_id IS NULL THEN RAISE EXCEPTION 'platform_staff_required'; END IF;
  IF approver_staff_role NOT IN ('platform_owner', 'platform_ops') THEN
    RAISE EXCEPTION 'platform_action_approve_permission_required';
  END IF;

  SELECT * INTO approval FROM public.platform_action_approvals
  WHERE id = p_approval_request_id FOR UPDATE;
  IF approval.id IS NULL THEN RAISE EXCEPTION 'platform_approval_not_found'; END IF;
  IF approval.expires_at <= now() THEN RAISE EXCEPTION 'platform_approval_expired'; END IF;
  IF approval.requested_by_platform_staff_id = approver_staff_id THEN
    RAISE EXCEPTION 'independent_platform_approver_required';
  END IF;
  IF approval.status IN ('approved', 'consumed') THEN
    IF approval.approved_by_platform_staff_id <> approver_staff_id THEN
      RAISE EXCEPTION 'platform_approval_already_decided';
    END IF;
    RETURN jsonb_build_object(
      'approval_request_id', approval.id,
      'status', approval.status,
      'payload_hash', approval.payload_hash,
      'idempotent', true
    );
  END IF;

  UPDATE public.platform_action_approvals
  SET status = 'approved', approved_by_platform_staff_id = approver_staff_id,
    approved_at = now()
  WHERE id = approval.id
  RETURNING * INTO approval;
  INSERT INTO public.platform_action_approval_events (
    approval_request_id, actor_platform_staff_id, action, request_id, metadata
  ) VALUES (
    approval.id, approver_staff_id, 'approved',
    'approval-approve:' || btrim(p_request_id),
    jsonb_build_object('payload_hash', approval.payload_hash)
  );
  RETURN jsonb_build_object(
    'approval_request_id', approval.id,
    'status', approval.status,
    'payload_hash', approval.payload_hash,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_approve_platform_action(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_approve_platform_action(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'immutable_record';
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_guard_platform_action_approval_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable_record'; END IF;
  IF ROW(
    NEW.id, NEW.action_key, NEW.target_key, NEW.payload, NEW.payload_hash,
    NEW.requested_by_platform_staff_id, NEW.request_id,
    NEW.requested_at, NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.action_key, OLD.target_key, OLD.payload, OLD.payload_hash,
    OLD.requested_by_platform_staff_id, OLD.request_id,
    OLD.requested_at, OLD.expires_at
  ) THEN RAISE EXCEPTION 'platform_approval_payload_immutable'; END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status = 'approved'
      AND NEW.approved_by_platform_staff_id IS NOT NULL
      AND NEW.approved_at IS NOT NULL
      AND NEW.consumption_key IS NULL AND NEW.consumed_at IS NULL
      AND NEW.execution_result IS NULL)
    OR (OLD.status = 'approved' AND NEW.status = 'consumed'
      AND NEW.approved_by_platform_staff_id = OLD.approved_by_platform_staff_id
      AND NEW.approved_at = OLD.approved_at
      AND NEW.consumption_key IS NOT NULL AND NEW.consumed_at IS NOT NULL
      AND NEW.execution_result IS NOT NULL)
  ) THEN RAISE EXCEPTION 'invalid_platform_approval_transition'; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_guard_platform_action_approval_update()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v4_reject_mutation()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER zz_v4_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.v4_reject_mutation();
CREATE TRIGGER zz_v4_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.v4_reject_mutation();
CREATE TRIGGER zz_v4_lifecycle_requests_immutable
  BEFORE UPDATE OR DELETE ON public.organization_lifecycle_requests
  FOR EACH ROW EXECUTE FUNCTION public.v4_reject_mutation();
CREATE TRIGGER zz_v4_platform_approval_events_immutable
  BEFORE UPDATE OR DELETE ON public.platform_action_approval_events
  FOR EACH ROW EXECUTE FUNCTION public.v4_reject_mutation();
CREATE TRIGGER zz_v4_platform_approvals_guard
  BEFORE UPDATE OR DELETE ON public.platform_action_approvals
  FOR EACH ROW EXECUTE FUNCTION public.v4_guard_platform_action_approval_update();

CREATE OR REPLACE FUNCTION public.v4_provision_organization(
  p_idempotency_key text,
  p_slug text,
  p_name text,
  p_industry_key text,
  p_plan_key text,
  p_billable_seat_limit integer,
  p_owner_user_id uuid,
  p_actor_user_id uuid,
  p_approver_user_id uuid,
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
  response jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'provisioning_request_id_required';
  END IF;
  SELECT id INTO actor_staff_id FROM public.platform_staff
  WHERE user_id = p_actor_user_id AND status = 'active'
    AND role_key IN ('platform_owner', 'platform_ops');
  IF actor_staff_id IS NULL THEN RAISE EXCEPTION 'platform_staff_required'; END IF;
  SELECT id INTO approver_staff_id FROM public.platform_staff
  WHERE user_id = p_approver_user_id AND status = 'active'
    AND role_key IN ('platform_owner', 'platform_ops');
  IF approver_staff_id IS NULL OR approver_staff_id = actor_staff_id THEN
    RAISE EXCEPTION 'independent_platform_approver_required';
  END IF;

  response := public.initialize_organization(
    p_idempotency_key, p_slug, p_name, p_industry_key, p_plan_key,
    p_billable_seat_limit, p_owner_user_id
  );
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, actor_platform_staff_id,
    action, target_type, target_id, outcome, reason, request_id, metadata
  ) SELECT
    (response ->> 'organization_id')::uuid,
    p_actor_user_id,
    actor_staff_id,
    'organization.provisioned',
    'organization',
    response ->> 'organization_id',
    'success',
    'independently_approved_platform_provisioning',
    p_request_id,
    jsonb_build_object(
      'approver_platform_staff_id', approver_staff_id,
      'owner_user_id', p_owner_user_id
    )
  WHERE NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE action = 'organization.provisioned' AND request_id = p_request_id
  );
  RETURN response || jsonb_build_object(
    'actor_platform_staff_id', actor_staff_id,
    'approver_platform_staff_id', approver_staff_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_provision_organization(
  text, text, text, text, text, integer, uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.v4_invite_organization_member(
  p_organization_id uuid,
  p_user_id uuid,
  p_role_key text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_actor_user_id uuid := auth.uid();
  actor_membership_id uuid;
  invited_membership_id uuid;
  selected_role_id uuid;
  existing_membership_id uuid;
  existing_user_id uuid;
  existing_role_key text;
BEGIN
  IF current_actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'membership_request_id_required';
  END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, current_actor_user_id, 'organization.members.manage', 'write'
  ) THEN RAISE EXCEPTION 'organization_members_manage_required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = p_user_id AND is_active IS TRUE
  ) THEN RAISE EXCEPTION 'active_profile_required'; END IF;
  SELECT id INTO selected_role_id FROM public.roles
  WHERE scope = 'organization'
    AND role_key = p_role_key
    AND role_key <> 'org_owner';
  IF selected_role_id IS NULL THEN RAISE EXCEPTION 'invalid_organization_role'; END IF;
  SELECT membership.id, membership.user_id, role.role_key
  INTO existing_membership_id, existing_user_id, existing_role_key
  FROM public.audit_events audit_event
  JOIN public.memberships membership
    ON membership.id::text = audit_event.target_id
  JOIN public.membership_roles role_link
    ON role_link.membership_id = membership.id
   AND role_link.organization_id = membership.organization_id
   AND role_link.revoked_at IS NULL
  JOIN public.roles role ON role.id = role_link.role_id
  WHERE audit_event.organization_id = p_organization_id
    AND audit_event.action = 'organization.member_invited'
    AND audit_event.request_id = p_request_id
  LIMIT 1;
  IF existing_membership_id IS NOT NULL THEN
    IF existing_user_id <> p_user_id OR existing_role_key <> p_role_key THEN
      RAISE EXCEPTION 'membership_idempotency_payload_mismatch';
    END IF;
    RETURN jsonb_build_object(
      'organization_id', p_organization_id,
      'membership_id', existing_membership_id,
      'status', 'invited', 'role_key', p_role_key, 'idempotent', true
    );
  END IF;
  SELECT id INTO actor_membership_id FROM public.memberships
  WHERE organization_id = p_organization_id
    AND user_id = current_actor_user_id
    AND status = 'active'
    AND accepted_at IS NOT NULL;

  INSERT INTO public.memberships (
    organization_id, user_id, status, invited_by_membership_id,
    invited_at, accepted_at
  ) VALUES (
    p_organization_id, p_user_id, 'invited', actor_membership_id,
    now(), NULL
  )
  RETURNING id INTO invited_membership_id;
  INSERT INTO public.membership_roles (
    organization_id, membership_id, role_id, granted_by_membership_id
  ) VALUES (
    p_organization_id, invited_membership_id, selected_role_id,
    actor_membership_id
  );
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, current_actor_user_id, 'organization.member_invited',
    'membership', invited_membership_id::text, 'success',
    'capability_authorized_invitation', p_request_id,
    jsonb_build_object('user_id', p_user_id, 'role_key', p_role_key)
  );
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'membership_id', invited_membership_id,
    'status', 'invited',
    'role_key', p_role_key
  );
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'organization_membership_already_exists';
END;
$$;

REVOKE ALL ON FUNCTION public.v4_invite_organization_member(uuid, uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_invite_organization_member(uuid, uuid, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_accept_organization_membership(
  p_organization_id uuid,
  p_membership_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_actor_user_id uuid := auth.uid();
  accepted_membership public.memberships%ROWTYPE;
BEGIN
  IF current_actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'membership_request_id_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = current_actor_user_id AND is_active IS TRUE
  ) THEN RAISE EXCEPTION 'active_profile_required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_organization_id AND status = 'active'
  ) THEN RAISE EXCEPTION 'active_organization_required'; END IF;

  SELECT * INTO accepted_membership FROM public.memberships
  WHERE id = p_membership_id
    AND organization_id = p_organization_id
    AND user_id = current_actor_user_id;
  IF accepted_membership.status = 'active'
    AND accepted_membership.accepted_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.audit_events audit_event
      WHERE audit_event.organization_id = p_organization_id
        AND audit_event.actor_user_id = current_actor_user_id
        AND action = 'organization.membership_accepted'
        AND target_id = p_membership_id::text
        AND request_id = p_request_id
    )
  THEN
    RETURN jsonb_build_object(
      'organization_id', p_organization_id,
      'membership_id', p_membership_id,
      'status', 'active', 'idempotent', true
    );
  END IF;
  UPDATE public.memberships
  SET status = 'active', accepted_at = now(), updated_at = now(), version = version + 1
  WHERE id = p_membership_id
    AND organization_id = p_organization_id
    AND user_id = current_actor_user_id
    AND status = 'invited'
    AND accepted_at IS NULL
  RETURNING * INTO accepted_membership;
  IF accepted_membership.id IS NULL THEN
    RAISE EXCEPTION 'pending_membership_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.membership_roles role_link
    JOIN public.roles role ON role.id = role_link.role_id
    WHERE role_link.membership_id = accepted_membership.id
      AND role_link.organization_id = p_organization_id
      AND role_link.revoked_at IS NULL
      AND role.scope = 'organization'
  ) THEN RAISE EXCEPTION 'organization_role_required'; END IF;

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, current_actor_user_id, 'organization.membership_accepted',
    'membership', p_membership_id::text, 'success',
    'invited_user_acceptance', p_request_id, '{}'::jsonb
  );
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'membership_id', p_membership_id,
    'status', 'active'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_accept_organization_membership(uuid, uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_accept_organization_membership(uuid, uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_transition_organization_lifecycle(
  p_organization_id uuid,
  p_action text,
  p_actor_user_id uuid,
  p_approver_user_id uuid,
  p_reason text,
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
  previous_status text;
  target_status text;
  existing_request public.organization_lifecycle_requests%ROWTYPE;
  revoked_support_sessions integer := 0;
  response jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_action NOT IN ('suspend', 'recover') THEN
    RAISE EXCEPTION 'invalid_lifecycle_action';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 12 THEN
    RAISE EXCEPTION 'lifecycle_reason_required';
  END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'lifecycle_request_id_required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id, 0));
  SELECT id INTO actor_staff_id FROM public.platform_staff
    WHERE user_id = p_actor_user_id AND status = 'active'
      AND role_key IN ('platform_owner', 'platform_ops');
  IF actor_staff_id IS NULL THEN RAISE EXCEPTION 'platform_staff_required'; END IF;
  SELECT id INTO approver_staff_id FROM public.platform_staff
    WHERE user_id = p_approver_user_id AND status = 'active'
      AND role_key IN ('platform_owner', 'platform_ops');
  IF approver_staff_id IS NULL OR approver_staff_id = actor_staff_id THEN
    RAISE EXCEPTION 'independent_platform_approver_required';
  END IF;

  SELECT * INTO existing_request
  FROM public.organization_lifecycle_requests
  WHERE request_id = p_request_id;
  IF FOUND THEN
    IF existing_request.organization_id <> p_organization_id
      OR existing_request.action <> p_action
      OR existing_request.actor_platform_staff_id <> actor_staff_id
      OR existing_request.approver_platform_staff_id <> approver_staff_id
      OR existing_request.reason <> btrim(p_reason)
    THEN RAISE EXCEPTION 'lifecycle_idempotency_payload_mismatch'; END IF;
    RETURN existing_request.result || jsonb_build_object('idempotent', true);
  END IF;

  SELECT status INTO previous_status FROM public.organizations
  WHERE id = p_organization_id FOR UPDATE;
  IF previous_status IS NULL THEN RAISE EXCEPTION 'organization_not_found'; END IF;
  target_status := CASE p_action WHEN 'suspend' THEN 'suspended' ELSE 'active' END;
  IF (p_action = 'suspend' AND previous_status <> 'active')
    OR (p_action = 'recover' AND previous_status <> 'suspended')
  THEN RAISE EXCEPTION 'invalid_organization_lifecycle_transition'; END IF;

  UPDATE public.organizations
  SET status = target_status, updated_at = now()
  WHERE id = p_organization_id;
  IF p_action = 'suspend' THEN
    UPDATE public.support_sessions
    SET status = 'revoked', revoked_at = now()
    WHERE organization_id = p_organization_id
      AND status = 'active' AND revoked_at IS NULL;
    GET DIAGNOSTICS revoked_support_sessions = ROW_COUNT;
  END IF;
  response := jsonb_build_object(
    'organization_id', p_organization_id,
    'previous_status', previous_status,
    'status', target_status,
    'revoked_support_sessions', revoked_support_sessions,
    'idempotent', false
  );
  INSERT INTO public.organization_lifecycle_requests (
    request_id, organization_id, action, previous_status, target_status,
    reason, actor_platform_staff_id, approver_platform_staff_id, result
  ) VALUES (
    p_request_id, p_organization_id, p_action, previous_status, target_status,
    btrim(p_reason), actor_staff_id, approver_staff_id, response
  );
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, actor_platform_staff_id,
    action, target_type, target_id, outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, actor_staff_id,
    'organization.' || p_action, 'organization', p_organization_id::text,
    'success', btrim(p_reason), p_request_id,
    jsonb_build_object(
      'approver_platform_staff_id', approver_staff_id,
      'previous_status', previous_status,
      'target_status', target_status,
      'revoked_support_sessions', revoked_support_sessions
    )
  );
  RETURN response;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_transition_organization_lifecycle(
  uuid, text, uuid, uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.v4_prepare_organization_customer_exit(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_approver_user_id uuid,
  p_idempotency_key text,
  p_reason text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  RETURN public.prepare_organization_customer_exit(
    p_organization_id,
    p_actor_user_id,
    p_approver_user_id,
    p_idempotency_key,
    p_reason,
    p_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_prepare_organization_customer_exit(
  uuid, uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

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
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  RETURN public.complete_organization_customer_exit(
    p_organization_id,
    p_actor_user_id,
    p_approver_user_id,
    p_idempotency_key,
    p_expected_export_sha256,
    p_backup_evidence_ref,
    p_customer_confirmation_ref,
    p_retention_basis,
    p_request_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.v4_execute_approved_platform_action(
  p_approval_request_id uuid,
  p_consumption_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  approval public.platform_action_approvals%ROWTYPE;
  requester_user_id uuid;
  requester_role_key text;
  approver_user_id uuid;
  approver_role_key text;
  organization_id_value uuid;
  support_user_id_value uuid;
  support_session_id_value uuid;
  action_result jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF length(btrim(COALESCE(p_consumption_key, ''))) < 8 THEN
    RAISE EXCEPTION 'platform_approval_consumption_key_required';
  END IF;

  SELECT * INTO approval
  FROM public.platform_action_approvals
  WHERE id = p_approval_request_id
  FOR UPDATE;
  IF approval.id IS NULL THEN RAISE EXCEPTION 'platform_approval_not_found'; END IF;
  IF approval.payload_hash <> public.v4_platform_payload_hash(approval.payload) THEN
    RAISE EXCEPTION 'platform_approval_payload_hash_mismatch';
  END IF;
  IF approval.status NOT IN ('approved', 'consumed') THEN
    RAISE EXCEPTION 'approved_platform_action_required';
  END IF;

  SELECT staff.user_id, staff.role_key INTO requester_user_id, requester_role_key
  FROM public.platform_staff staff
  JOIN public.profiles profile
    ON profile.id = staff.user_id AND profile.is_active IS TRUE
  WHERE staff.id = approval.requested_by_platform_staff_id
    AND staff.status = 'active';
  SELECT staff.user_id, staff.role_key INTO approver_user_id, approver_role_key
  FROM public.platform_staff staff
  JOIN public.profiles profile
    ON profile.id = staff.user_id AND profile.is_active IS TRUE
  WHERE staff.id = approval.approved_by_platform_staff_id
    AND staff.status = 'active';
  IF requester_user_id IS NULL
    OR requester_role_key NOT IN ('platform_owner', 'platform_ops')
  THEN RAISE EXCEPTION 'platform_action_request_permission_required'; END IF;
  IF approver_user_id IS NULL
    OR approver_role_key NOT IN ('platform_owner', 'platform_ops')
  THEN RAISE EXCEPTION 'platform_action_approve_permission_required'; END IF;
  IF requester_user_id = approver_user_id THEN
    RAISE EXCEPTION 'independent_platform_approver_required';
  END IF;
  IF approval.status = 'consumed' THEN
    IF approval.consumption_key <> btrim(p_consumption_key)
      OR approval.execution_result IS NULL
    THEN RAISE EXCEPTION 'platform_approval_already_consumed'; END IF;
    RETURN approval.execution_result || jsonb_build_object(
      'approval_request_id', approval.id,
      'approval_status', 'consumed',
      'idempotent', true
    );
  END IF;
  IF approval.expires_at <= now() THEN RAISE EXCEPTION 'platform_approval_expired'; END IF;

  CASE approval.action_key
    WHEN 'organization.provision' THEN
      IF approval.target_key <> (approval.payload ->> 'slug') THEN
        RAISE EXCEPTION 'platform_approval_target_mismatch';
      END IF;
      action_result := public.v4_provision_organization(
        btrim(p_consumption_key),
        approval.payload ->> 'slug',
        approval.payload ->> 'name',
        approval.payload ->> 'industry_key',
        approval.payload ->> 'plan_key',
        (approval.payload ->> 'billable_seat_limit')::integer,
        (approval.payload ->> 'owner_user_id')::uuid,
        requester_user_id,
        approver_user_id,
        'approval-execute:' || approval.id::text
      );
    WHEN 'organization.suspend', 'organization.recover' THEN
      organization_id_value := (approval.payload ->> 'organization_id')::uuid;
      IF approval.target_key <> organization_id_value::text
        OR (approval.payload ->> 'action') <> split_part(approval.action_key, '.', 2)
      THEN RAISE EXCEPTION 'platform_approval_target_mismatch'; END IF;
      action_result := public.v4_transition_organization_lifecycle(
        organization_id_value,
        approval.payload ->> 'action',
        requester_user_id,
        approver_user_id,
        approval.payload ->> 'reason',
        btrim(p_consumption_key)
      );
    WHEN 'organization.exit.prepare' THEN
      organization_id_value := (approval.payload ->> 'organization_id')::uuid;
      IF approval.target_key <> organization_id_value::text THEN
        RAISE EXCEPTION 'platform_approval_target_mismatch';
      END IF;
      action_result := public.v4_prepare_organization_customer_exit(
        organization_id_value,
        requester_user_id,
        approver_user_id,
        approval.payload ->> 'idempotency_key',
        approval.payload ->> 'reason',
        'approval-execute:' || approval.id::text
      );
    WHEN 'organization.exit.complete' THEN
      organization_id_value := (approval.payload ->> 'organization_id')::uuid;
      IF approval.target_key <> organization_id_value::text THEN
        RAISE EXCEPTION 'platform_approval_target_mismatch';
      END IF;
      action_result := public.v4_complete_organization_customer_exit(
        organization_id_value,
        requester_user_id,
        approver_user_id,
        approval.payload ->> 'idempotency_key',
        approval.payload ->> 'expected_export_sha256',
        approval.payload ->> 'backup_evidence_ref',
        approval.payload ->> 'customer_confirmation_ref',
        approval.payload ->> 'retention_basis',
        'approval-execute:' || approval.id::text
      );
    WHEN 'support.session.start' THEN
      organization_id_value := (approval.payload ->> 'organization_id')::uuid;
      support_user_id_value := (approval.payload ->> 'support_user_id')::uuid;
      IF approval.target_key <> organization_id_value::text THEN
        RAISE EXCEPTION 'platform_approval_target_mismatch';
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM public.platform_staff support_staff
        JOIN public.profiles support_profile
          ON support_profile.id = support_staff.user_id
         AND support_profile.is_active IS TRUE
        WHERE support_staff.user_id = support_user_id_value
          AND support_staff.status = 'active'
          AND support_staff.role_key IN ('platform_support', 'platform_ops')
      ) THEN RAISE EXCEPTION 'active_support_actor_required'; END IF;
      support_session_id_value := public.start_support_session_atomic(
        support_user_id_value,
        approver_user_id,
        organization_id_value,
        approval.payload ->> 'ticket_ref',
        approval.payload ->> 'reason',
        approval.payload -> 'scope',
        (approval.payload ->> 'expires_at')::timestamptz,
        'approval-execute:' || approval.id::text
      );
      action_result := jsonb_build_object(
        'support_session_id', support_session_id_value,
        'support_user_id', support_user_id_value,
        'organization_id', organization_id_value,
        'expires_at', approval.payload ->> 'expires_at',
        'status', 'active'
      );
    ELSE
      RAISE EXCEPTION 'invalid_platform_action';
  END CASE;

  UPDATE public.platform_action_approvals
  SET status = 'consumed',
    consumption_key = btrim(p_consumption_key),
    consumed_at = now(),
    execution_result = action_result
  WHERE id = approval.id;
  INSERT INTO public.platform_action_approval_events (
    approval_request_id, actor_platform_staff_id, action, request_id, metadata
  ) VALUES (
    approval.id,
    approval.requested_by_platform_staff_id,
    'consumed',
    'approval-consume:' || approval.id::text || ':' || btrim(p_consumption_key),
    jsonb_build_object(
      'payload_hash', approval.payload_hash,
      'approver_platform_staff_id', approval.approved_by_platform_staff_id
    )
  );
  RETURN action_result || jsonb_build_object(
    'approval_request_id', approval.id,
    'approval_status', 'consumed'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_execute_approved_platform_action(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_execute_approved_platform_action(uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.v4_expire_support_sessions(p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  expired_count integer := 0;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  WITH expired AS (
    UPDATE public.support_sessions
    SET status = 'expired'
    WHERE status = 'active' AND revoked_at IS NULL AND expires_at <= now()
    RETURNING *
  ), audited AS (
    INSERT INTO public.audit_events (
      organization_id, actor_platform_staff_id, support_session_id,
      action, target_type, target_id, outcome, reason, request_id, metadata
    )
    SELECT organization_id, platform_staff_id, id,
      'support.session_expired', 'support_session', id::text,
      'success', 'time_bound_session_expired', p_request_id, '{}'::jsonb
    FROM expired
    RETURNING 1
  )
  SELECT count(*) INTO expired_count FROM audited;
  RETURN jsonb_build_object('expired', expired_count);
END;
$$;

REVOKE ALL ON FUNCTION public.v4_expire_support_sessions(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_expire_support_sessions(text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.v4_import_leads_for_organization(
  p_organization_id uuid,
  p_rows jsonb,
  p_import_batch_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  row_data jsonb;
  inserted_lead_id uuid;
  imported_ids jsonb := '[]'::jsonb;
  imported_count integer := 0;
  skipped_count integer := 0;
  notes_count integer := 0;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'leads.import', 'write'
  ) THEN RAISE EXCEPTION 'lead_import_capability_required'; END IF;
  IF jsonb_typeof(p_rows) <> 'array'
    OR jsonb_array_length(p_rows) < 1
    OR jsonb_array_length(p_rows) > 500
  THEN RAISE EXCEPTION 'invalid_import_rows'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'import_request_id_required';
  END IF;

  FOR row_data IN SELECT value FROM jsonb_array_elements(p_rows)
  LOOP
    IF jsonb_typeof(row_data) <> 'object'
      OR length(btrim(COALESCE(row_data ->> 'customer_name', ''))) < 1
      OR COALESCE(row_data ->> 'import_fingerprint', '') !~ '^[0-9a-f]{64}$'
    THEN RAISE EXCEPTION 'invalid_import_row'; END IF;
    inserted_lead_id := NULL;
    INSERT INTO public.leads (
      organization_id, customer_name, phone, source, quality, lead_status,
      stage, emirate, property_type, quotation_value, raw_import_data,
      import_batch_id, import_fingerprint, imported_by, imported_at,
      assigned_to, next_action, next_followup_date, created_at, updated_at
    ) VALUES (
      p_organization_id,
      btrim(row_data ->> 'customer_name'),
      NULLIF(row_data ->> 'phone', ''),
      COALESCE(NULLIF(row_data ->> 'source', ''), 'unknown'),
      COALESCE(NULLIF(row_data ->> 'quality', ''), 'pending'),
      COALESCE(NULLIF(row_data ->> 'lead_status', ''), 'pending'),
      'new',
      NULLIF(row_data ->> 'emirate', ''),
      NULLIF(row_data ->> 'property_type', ''),
      NULLIF(row_data ->> 'quotation_value', '')::numeric,
      COALESCE(row_data -> 'raw_import_data', '{}'::jsonb),
      p_import_batch_id,
      row_data ->> 'import_fingerprint',
      actor_user_id,
      now(),
      NULL,
      'call',
      now() + interval '1 day',
      COALESCE(NULLIF(row_data ->> 'created_at', '')::timestamptz, now()),
      now()
    )
    ON CONFLICT (organization_id, import_fingerprint) DO NOTHING
    RETURNING id INTO inserted_lead_id;

    IF inserted_lead_id IS NULL THEN
      skipped_count := skipped_count + 1;
    ELSE
      imported_count := imported_count + 1;
      imported_ids := imported_ids || jsonb_build_array(inserted_lead_id);
      IF length(btrim(COALESCE(row_data ->> 'notes', ''))) > 0 THEN
        INSERT INTO public.follow_up_logs (
          organization_id, lead_id, contact_type, contact_time,
          summary, user_id, no_answer, created_at
        ) VALUES (
          p_organization_id, inserted_lead_id, 'note', now(),
          btrim(row_data ->> 'notes'), actor_user_id, false, now()
        );
        notes_count := notes_count + 1;
      END IF;
    END IF;
  END LOOP;

  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, actor_user_id, 'lead.import', 'import_batch',
    p_import_batch_id::text, 'success', 'capability_authorized_atomic_import',
    p_request_id, jsonb_build_object(
      'imported', imported_count,
      'skipped_duplicates', skipped_count,
      'notes_created', notes_count
    )
  );
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'batch_id', p_import_batch_id,
    'imported', imported_count,
    'skipped_duplicates', skipped_count,
    'failed', 0,
    'imported_ids', imported_ids,
    'errors', '[]'::jsonb,
    'notes_created', notes_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_import_leads_for_organization(
  uuid, jsonb, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_import_leads_for_organization(
  uuid, jsonb, uuid, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_register_tenant_file(
  p_organization_id uuid,
  p_record_type text,
  p_record_id uuid,
  p_filename text,
  p_version text,
  p_content_type text,
  p_expected_size_bytes bigint,
  p_expected_content_md5 text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  file_id uuid := gen_random_uuid();
  safe_filename text;
  object_key text;
  contract_sales_id uuid;
  can_write_any boolean := false;
  can_seal boolean := false;
  is_contract_sales boolean := false;
  existing_file public.tenant_file_objects%ROWTYPE;
  organization_pending_count bigint;
  organization_pending_bytes bigint;
  actor_pending_count bigint;
  actor_pending_bytes bigint;
  expired_pending_count integer := 0;
  upload_url_expiry timestamptz := now() + interval '15 minutes';
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'storage.files.write', 'write'
  ) THEN RAISE EXCEPTION 'storage_write_capability_required'; END IF;
  IF p_record_type NOT IN ('contract', 'lead', 'quotation') THEN
    RAISE EXCEPTION 'invalid_storage_record_type';
  END IF;
  IF p_version NOT IN ('draft', 'sealed', 'attachment') THEN
    RAISE EXCEPTION 'invalid_storage_version';
  END IF;
  IF p_version = 'sealed' AND p_record_type <> 'contract' THEN
    RAISE EXCEPTION 'sealed_version_requires_contract';
  END IF;
  IF p_expected_size_bytes IS NULL
    OR p_expected_size_bytes < 0
    OR p_expected_size_bytes > 1073741824
  THEN RAISE EXCEPTION 'invalid_storage_expected_size'; END IF;
  IF COALESCE(p_expected_content_md5, '') !~ '^[A-Za-z0-9+/]{22}==$' THEN
    RAISE EXCEPTION 'invalid_storage_content_md5';
  END IF;
  IF length(btrim(COALESCE(p_content_type, ''))) < 3
    OR length(btrim(p_content_type)) > 160
  THEN RAISE EXCEPTION 'invalid_storage_content_type'; END IF;
  IF COALESCE(p_request_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' THEN
    RAISE EXCEPTION 'storage_request_id_required';
  END IF;
  safe_filename := regexp_replace(btrim(COALESCE(p_filename, '')),
    '[^A-Za-z0-9_. -]', '_', 'g');
  IF safe_filename = '' OR length(safe_filename) > 180 THEN
    RAISE EXCEPTION 'invalid_storage_filename';
  END IF;
  IF p_record_type = 'contract' THEN
    SELECT sales_id INTO contract_sales_id
    FROM public.contracts
    WHERE id = p_record_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'storage_record_not_found'; END IF;

    can_write_any := public.v4_actor_has_capability(
      p_organization_id, actor_user_id, 'storage.files.write_any', 'write'
    );
    can_seal := public.v4_actor_has_capability(
      p_organization_id, actor_user_id, 'storage.files.seal', 'write'
    );
    is_contract_sales := public.v4_actor_has_organization_role(
      p_organization_id, actor_user_id, ARRAY['sales_agent']
    );
    IF p_version = 'sealed' AND NOT can_seal THEN
      RAISE EXCEPTION 'sealed_contract_admin_required';
    END IF;
    IF NOT can_write_any
      AND (
        NOT is_contract_sales
        OR p_version <> 'draft'
        OR contract_sales_id IS DISTINCT FROM actor_user_id
      )
    THEN RAISE EXCEPTION 'sales_contract_file_ownership_required'; END IF;
  ELSIF p_record_type = 'lead' AND NOT EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = p_record_id AND organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'storage_record_not_found';
  ELSIF p_record_type = 'quotation' AND NOT EXISTS (
    SELECT 1 FROM public.quotations
    WHERE id = p_record_id AND organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'storage_record_not_found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('v4-storage-pending-org:' || p_organization_id::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('v4-storage-pending-actor:' || actor_user_id::text, 0)
  );

  SELECT * INTO existing_file FROM public.tenant_file_objects
  WHERE organization_id = p_organization_id AND request_id = p_request_id;
  IF FOUND THEN
    IF existing_file.record_type <> p_record_type
      OR existing_file.record_id <> p_record_id
      OR existing_file.original_filename <> safe_filename
      OR existing_file.version <> p_version
      OR existing_file.content_type <> btrim(p_content_type)
      OR existing_file.expected_size_bytes <> p_expected_size_bytes
      OR existing_file.expected_content_md5 <> p_expected_content_md5
    THEN RAISE EXCEPTION 'storage_idempotency_payload_mismatch'; END IF;
    RETURN jsonb_build_object(
      'id', existing_file.id, 'organization_id', p_organization_id,
      'key', existing_file.object_key, 'status', existing_file.status,
      'content_type', existing_file.content_type,
      'expected_size_bytes', existing_file.expected_size_bytes,
      'expected_content_md5', existing_file.expected_content_md5,
      'upload_url_expires_at', existing_file.upload_url_expires_at,
      'pending_expires_at', existing_file.pending_expires_at,
      'idempotent', true
    );
  END IF;

  -- Opportunistically release at most one worker batch before calculating
  -- quota. The explicit worker below drains larger backlogs without allowing
  -- one request to perform unbounded maintenance.
  WITH expired AS (
    SELECT candidate.id
    FROM public.tenant_file_objects candidate
    WHERE candidate.organization_id = p_organization_id
      AND candidate.status = 'pending'
      AND candidate.pending_expires_at <= now()
    ORDER BY candidate.pending_expires_at, candidate.id
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE public.tenant_file_objects target
    SET status = 'deletion_pending'
    FROM expired
    WHERE target.id = expired.id
    RETURNING target.*
  )
  INSERT INTO public.tenant_file_deletion_outbox (
    organization_id, file_id, object_key, terminal_status, reason,
    provider_delete_not_before, requested_by, request_id
  )
  SELECT
    marked.organization_id, marked.id, marked.object_key, 'expired',
    'pending_upload_ttl_elapsed',
    GREATEST(now(), marked.upload_url_expires_at + interval '2 minutes'),
    actor_user_id, p_request_id || ':expire:' || marked.id::text
  FROM marked
  ON CONFLICT ON CONSTRAINT tenant_file_deletion_outbox_file_id_key DO NOTHING;
  GET DIAGNOSTICS expired_pending_count = ROW_COUNT;
  IF expired_pending_count > 0 THEN
    INSERT INTO public.audit_events (
      organization_id, actor_user_id, action, target_type, target_id,
      outcome, reason, request_id, metadata
    ) VALUES (
      p_organization_id, actor_user_id, 'storage.pending_expired',
      'tenant_file_object_batch', p_organization_id::text, 'success',
      'bounded_registration_deletion_enqueue', p_request_id || ':expire',
      jsonb_build_object('expired_count', expired_pending_count, 'limit', 100)
    );
  END IF;

  SELECT count(*), COALESCE(sum(expected_size_bytes), 0)
  INTO organization_pending_count, organization_pending_bytes
  FROM public.tenant_file_objects
  WHERE organization_id = p_organization_id
    AND status IN ('pending', 'deletion_pending');
  IF organization_pending_count >= 100
    OR organization_pending_bytes + p_expected_size_bytes > 5368709120
  THEN RAISE EXCEPTION 'storage_pending_organization_quota_exceeded'; END IF;

  SELECT count(*), COALESCE(sum(expected_size_bytes), 0)
  INTO actor_pending_count, actor_pending_bytes
  FROM public.tenant_file_objects
  WHERE organization_id = p_organization_id
    AND created_by = actor_user_id
    AND status IN ('pending', 'deletion_pending');
  IF actor_pending_count >= 20
    OR actor_pending_bytes + p_expected_size_bytes > 1073741824
  THEN RAISE EXCEPTION 'storage_pending_actor_quota_exceeded'; END IF;

  object_key := format(
    'organizations/%s/%ss/%s/%s_%s',
    p_organization_id, p_record_type, p_record_id, file_id, safe_filename
  );
  INSERT INTO public.tenant_file_objects (
    id, organization_id, record_type, record_id, object_key,
    original_filename, version, content_type, expected_size_bytes,
    expected_content_md5, created_by, request_id, upload_url_expires_at
  ) VALUES (
    file_id, p_organization_id, p_record_type, p_record_id, object_key,
    safe_filename, p_version, btrim(p_content_type), p_expected_size_bytes,
    p_expected_content_md5, actor_user_id, p_request_id, upload_url_expiry
  );
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, actor_user_id, 'storage.file_registered',
    'tenant_file_object', file_id::text, 'success',
    'capability_authorized_storage_registration', p_request_id,
    jsonb_build_object('record_type', p_record_type, 'record_id', p_record_id)
  );
  RETURN jsonb_build_object(
    'id', file_id, 'organization_id', p_organization_id,
    'key', object_key, 'status', 'pending',
    'content_type', btrim(p_content_type),
    'expected_size_bytes', p_expected_size_bytes,
    'expected_content_md5', p_expected_content_md5,
    'upload_url_expires_at', upload_url_expiry,
    'pending_expires_at', now() + interval '30 minutes',
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_register_tenant_file(
  uuid, text, uuid, text, text, text, bigint, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_register_tenant_file(
  uuid, text, uuid, text, text, text, bigint, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_finalize_tenant_file(
  p_organization_id uuid,
  p_file_id uuid,
  p_verified_size_bytes bigint,
  p_verified_content_type text,
  p_verified_content_md5 text,
  p_provider_etag text,
  p_provider_checksum_crc64ecma text,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  target_file public.tenant_file_objects%ROWTYPE;
  contract_sales_id uuid;
  expected_etag text;
  can_write_any boolean := false;
  can_seal boolean := false;
  is_contract_sales boolean := false;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, p_actor_user_id, 'storage.files.write', 'write'
  ) THEN RAISE EXCEPTION 'storage_write_capability_required'; END IF;
  IF p_verified_size_bytes IS NULL
    OR p_verified_size_bytes < 0
    OR p_verified_size_bytes > 1073741824
  THEN
    RAISE EXCEPTION 'invalid_storage_size';
  END IF;
  IF length(btrim(COALESCE(p_provider_etag, ''))) < 3
    OR length(btrim(p_provider_etag)) > 160
  THEN RAISE EXCEPTION 'invalid_storage_provider_etag'; END IF;
  IF NULLIF(btrim(COALESCE(p_provider_checksum_crc64ecma, '')), '') IS NOT NULL
    AND p_provider_checksum_crc64ecma !~ '^[0-9]{1,20}$'
  THEN
    RAISE EXCEPTION 'invalid_storage_provider_checksum';
  END IF;
  SELECT * INTO target_file FROM public.tenant_file_objects
    WHERE id = p_file_id AND organization_id = p_organization_id
    FOR UPDATE;
  IF target_file.id IS NULL THEN
    RAISE EXCEPTION 'storage_object_not_found';
  END IF;
  IF target_file.status = 'pending'
    AND target_file.pending_expires_at <= now()
  THEN
    UPDATE public.tenant_file_objects
    SET status = 'deletion_pending'
    WHERE id = target_file.id;
    INSERT INTO public.tenant_file_deletion_outbox (
      organization_id, file_id, object_key, terminal_status, reason,
      provider_delete_not_before, requested_by, request_id
    ) VALUES (
      p_organization_id, target_file.id, target_file.object_key, 'expired',
      'pending_upload_ttl_elapsed',
      GREATEST(now(), target_file.upload_url_expires_at + interval '2 minutes'),
      p_actor_user_id, p_request_id || ':delete'
    ) ON CONFLICT ON CONSTRAINT tenant_file_deletion_outbox_file_id_key DO NOTHING;
    INSERT INTO public.audit_events (
      organization_id, actor_user_id, action, target_type, target_id,
      outcome, reason, request_id, metadata
    ) VALUES (
      p_organization_id, p_actor_user_id, 'storage.pending_expired',
      'tenant_file_object', target_file.id::text, 'success',
      'finalize_rejected_expired_pending_upload', p_request_id,
      jsonb_build_object('pending_expires_at', target_file.pending_expires_at)
    );
    RETURN jsonb_build_object(
      'id', target_file.id, 'organization_id', p_organization_id,
      'key', target_file.object_key, 'status', 'deletion_pending',
      'idempotent', false
    );
  END IF;
  IF target_file.expected_size_bytes <> p_verified_size_bytes THEN
    RAISE EXCEPTION 'storage_size_mismatch';
  END IF;
  IF target_file.content_type <> btrim(COALESCE(p_verified_content_type, '')) THEN
    RAISE EXCEPTION 'storage_content_type_mismatch';
  END IF;
  IF target_file.expected_content_md5
    <> btrim(COALESCE(p_verified_content_md5, ''))
  THEN RAISE EXCEPTION 'storage_content_md5_mismatch'; END IF;
  expected_etag := encode(decode(target_file.expected_content_md5, 'base64'), 'hex');
  IF lower(btrim(p_provider_etag, '"')) <> expected_etag THEN
    RAISE EXCEPTION 'storage_etag_mismatch';
  END IF;
  IF target_file.record_type = 'contract' THEN
    SELECT sales_id INTO contract_sales_id
    FROM public.contracts
    WHERE id = target_file.record_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'storage_record_not_found'; END IF;
    can_write_any := public.v4_actor_has_capability(
      p_organization_id, p_actor_user_id, 'storage.files.write_any', 'write'
    );
    can_seal := public.v4_actor_has_capability(
      p_organization_id, p_actor_user_id, 'storage.files.seal', 'write'
    );
    is_contract_sales := public.v4_actor_has_organization_role(
      p_organization_id, p_actor_user_id, ARRAY['sales_agent']
    );
    IF target_file.version = 'sealed' AND NOT can_seal THEN
      RAISE EXCEPTION 'sealed_contract_admin_required';
    END IF;
    IF NOT can_write_any
      AND (
        NOT is_contract_sales
        OR target_file.version <> 'draft'
        OR contract_sales_id IS DISTINCT FROM p_actor_user_id
      )
    THEN RAISE EXCEPTION 'sales_contract_file_ownership_required'; END IF;
  END IF;
  IF target_file.status = 'available' THEN
    IF target_file.size_bytes IS DISTINCT FROM p_verified_size_bytes
      OR target_file.provider_etag IS DISTINCT FROM btrim(p_provider_etag)
      OR target_file.provider_checksum_crc64ecma
        IS DISTINCT FROM NULLIF(btrim(COALESCE(p_provider_checksum_crc64ecma, '')), '')
    THEN RAISE EXCEPTION 'storage_idempotency_payload_mismatch'; END IF;
    RETURN jsonb_build_object(
      'id', target_file.id, 'organization_id', p_organization_id,
      'key', target_file.object_key, 'status', target_file.status,
      'idempotent', true
    );
  END IF;
  IF target_file.status <> 'pending' THEN
    RAISE EXCEPTION 'storage_object_not_confirmable';
  END IF;
  UPDATE public.tenant_file_objects
  SET status = 'available', size_bytes = p_verified_size_bytes,
    provider_etag = btrim(p_provider_etag),
    provider_checksum_crc64ecma = NULLIF(
      btrim(COALESCE(p_provider_checksum_crc64ecma, '')), ''
    ),
    provider_verified_at = now(),
    confirmed_by = p_actor_user_id, confirmed_at = now()
  WHERE id = target_file.id;
  IF target_file.record_type = 'contract' THEN
    UPDATE public.contracts
    SET file_url = CASE WHEN target_file.version = 'draft'
        THEN target_file.object_key ELSE file_url END,
      sealed_file_url = CASE WHEN target_file.version = 'sealed'
        THEN target_file.object_key ELSE sealed_file_url END,
      file_metadata = COALESCE(file_metadata, '{}'::jsonb) || jsonb_build_object(
        'tenant_file_object_id', target_file.id,
        'key', target_file.object_key,
        'filename', target_file.original_filename,
        'size', p_verified_size_bytes,
        'provider_etag', btrim(p_provider_etag),
        'provider_checksum_crc64ecma', NULLIF(
          btrim(COALESCE(p_provider_checksum_crc64ecma, '')), ''
        ),
        'confirmed_at', now(),
        'confirmed_by', p_actor_user_id
      ),
      updated_at = now()
    WHERE id = target_file.record_id AND organization_id = p_organization_id;
  END IF;
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, 'storage.file_confirmed',
    'tenant_file_object', target_file.id::text, 'success',
    'capability_authorized_storage_confirmation', p_request_id,
    jsonb_build_object(
      'size_bytes', p_verified_size_bytes,
      'provider_etag', btrim(p_provider_etag),
      'provider_checksum_crc64ecma', NULLIF(
        btrim(COALESCE(p_provider_checksum_crc64ecma, '')), ''
      )
    )
  );
  RETURN jsonb_build_object(
    'id', target_file.id, 'organization_id', p_organization_id,
    'key', target_file.object_key, 'status', 'available',
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_finalize_tenant_file(
  uuid, uuid, bigint, text, text, text, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_finalize_tenant_file(
  uuid, uuid, bigint, text, text, text, text, uuid, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.v4_cancel_tenant_file_upload(
  p_organization_id uuid,
  p_file_id uuid,
  p_reason text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  target_file public.tenant_file_objects%ROWTYPE;
  can_write_any boolean := false;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'storage.files.write', 'write'
  ) THEN RAISE EXCEPTION 'storage_write_capability_required'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 8
    OR length(btrim(p_reason)) > 500
  THEN RAISE EXCEPTION 'storage_cancellation_reason_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'storage_request_id_required';
  END IF;

  SELECT * INTO target_file
  FROM public.tenant_file_objects
  WHERE id = p_file_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF target_file.id IS NULL THEN RAISE EXCEPTION 'storage_object_not_found'; END IF;
  IF target_file.status IN ('deletion_pending', 'cancelled', 'expired') THEN
    RETURN jsonb_build_object(
      'id', target_file.id, 'organization_id', p_organization_id,
      'status', target_file.status, 'idempotent', true
    );
  END IF;
  IF target_file.status <> 'pending' THEN
    RAISE EXCEPTION 'storage_object_not_cancellable';
  END IF;
  can_write_any := public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'storage.files.write_any', 'write'
  );
  IF target_file.created_by <> actor_user_id AND NOT can_write_any THEN
    RAISE EXCEPTION 'storage_upload_owner_required';
  END IF;

  UPDATE public.tenant_file_objects
  SET status = 'deletion_pending'
  WHERE id = target_file.id;
  INSERT INTO public.tenant_file_deletion_outbox (
    organization_id, file_id, object_key, terminal_status, reason,
    provider_delete_not_before, requested_by, request_id
  ) VALUES (
    p_organization_id, target_file.id, target_file.object_key, 'cancelled',
    btrim(p_reason),
    GREATEST(now(), target_file.upload_url_expires_at + interval '2 minutes'),
    actor_user_id, p_request_id
  ) ON CONFLICT ON CONSTRAINT tenant_file_deletion_outbox_file_id_key DO NOTHING;
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, actor_user_id, 'storage.upload_cancelled',
    'tenant_file_object', target_file.id::text, 'success',
    btrim(p_reason), p_request_id,
    jsonb_build_object('object_key', target_file.object_key)
  );
  RETURN jsonb_build_object(
    'id', target_file.id, 'organization_id', p_organization_id,
    'status', 'deletion_pending', 'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_cancel_tenant_file_upload(
  uuid, uuid, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_cancel_tenant_file_upload(
  uuid, uuid, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_expire_tenant_file_uploads(
  p_organization_id uuid,
  p_limit integer,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  expired_count integer := 0;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION 'storage_expiry_limit_invalid';
  END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'storage_request_id_required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = p_organization_id
  ) THEN RAISE EXCEPTION 'organization_not_found'; END IF;

  WITH expired AS (
    SELECT candidate.id
    FROM public.tenant_file_objects candidate
    WHERE candidate.organization_id = p_organization_id
      AND candidate.status = 'pending'
      AND candidate.pending_expires_at <= now()
    ORDER BY candidate.pending_expires_at, candidate.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), marked AS (
    UPDATE public.tenant_file_objects target
    SET status = 'deletion_pending'
    FROM expired
    WHERE target.id = expired.id
    RETURNING target.*
  )
  INSERT INTO public.tenant_file_deletion_outbox (
    organization_id, file_id, object_key, terminal_status, reason,
    provider_delete_not_before, requested_by, request_id
  )
  SELECT
    marked.organization_id, marked.id, marked.object_key, 'expired',
    'pending_upload_ttl_elapsed',
    GREATEST(now(), marked.upload_url_expires_at + interval '2 minutes'),
    NULL, p_request_id || ':' || marked.id::text
  FROM marked
  ON CONFLICT ON CONSTRAINT tenant_file_deletion_outbox_file_id_key DO NOTHING;
  GET DIAGNOSTICS expired_count = ROW_COUNT;

  IF expired_count > 0 THEN
    INSERT INTO public.audit_events (
      organization_id, actor_user_id, action, target_type, target_id,
      outcome, reason, request_id, metadata
    ) VALUES (
      p_organization_id, NULL, 'storage.pending_expired',
      'tenant_file_object_batch', p_organization_id::text, 'success',
      'bounded_worker_expiry', p_request_id,
      jsonb_build_object('expired_count', expired_count, 'limit', p_limit)
    );
  END IF;
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'expired', expired_count,
    'limit', p_limit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_expire_tenant_file_uploads(
  uuid, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_expire_tenant_file_uploads(
  uuid, integer, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.v4_claim_tenant_file_deletions(
  p_limit integer,
  p_worker_id text,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE claimed jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'storage_deletion_claim_limit_invalid';
  END IF;
  IF length(btrim(COALESCE(p_worker_id, ''))) < 8
    OR p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 300
  THEN RAISE EXCEPTION 'storage_deletion_lease_invalid'; END IF;

  WITH candidates AS (
    SELECT deletion.id
    FROM public.tenant_file_deletion_outbox deletion
    WHERE (
        deletion.status = 'pending'
        OR (deletion.status = 'leased' AND deletion.lease_expires_at <= now())
      )
      AND deletion.provider_delete_not_before <= now()
      AND deletion.next_attempt_at <= now()
    ORDER BY deletion.next_attempt_at, deletion.created_at, deletion.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE public.tenant_file_deletion_outbox deletion
    SET status = 'leased', lease_owner = btrim(p_worker_id),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = deletion.attempt_count + 1
    FROM candidates
    WHERE deletion.id = candidates.id
    RETURNING deletion.*
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'queue_id', leased.id,
    'organization_id', leased.organization_id,
    'file_id', leased.file_id,
    'object_key', leased.object_key,
    'terminal_status', leased.terminal_status,
    'attempt_count', leased.attempt_count,
    'lease_owner', leased.lease_owner
  ) ORDER BY leased.created_at, leased.id), '[]'::jsonb)
  INTO claimed
  FROM leased;
  RETURN claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_complete_tenant_file_deletion(
  p_organization_id uuid,
  p_queue_id uuid,
  p_file_id uuid,
  p_worker_id text,
  p_provider_evidence text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deletion public.tenant_file_deletion_outbox%ROWTYPE;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_provider_evidence NOT IN (
    'cos_delete_204_head_404', 'cos_delete_404_head_404'
  ) THEN RAISE EXCEPTION 'storage_provider_absence_evidence_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'storage_request_id_required';
  END IF;

  SELECT * INTO deletion
  FROM public.tenant_file_deletion_outbox
  WHERE id = p_queue_id
    AND organization_id = p_organization_id
    AND file_id = p_file_id
  FOR UPDATE;
  IF deletion.id IS NULL THEN RAISE EXCEPTION 'storage_deletion_not_found'; END IF;
  IF deletion.status = 'completed' THEN
    RETURN jsonb_build_object(
      'queue_id', deletion.id, 'file_id', deletion.file_id,
      'status', 'completed', 'idempotent', true
    );
  END IF;
  IF deletion.status <> 'leased'
    OR deletion.lease_owner IS DISTINCT FROM btrim(p_worker_id)
  THEN RAISE EXCEPTION 'storage_deletion_lease_owner_required'; END IF;

  UPDATE public.tenant_file_objects file_object
  SET status = deletion.terminal_status,
    terminal_at = now(), terminal_reason = deletion.reason
  WHERE file_object.id = deletion.file_id
    AND file_object.organization_id = deletion.organization_id
    AND file_object.status = 'deletion_pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'storage_deletion_file_state_mismatch'; END IF;

  UPDATE public.tenant_file_deletion_outbox
  SET status = 'completed', completed_at = now(),
    lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
  WHERE id = deletion.id;
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    deletion.organization_id, NULL, 'storage.object_deleted',
    'tenant_file_object', deletion.file_id::text, 'success',
    deletion.reason, p_request_id,
    jsonb_build_object(
      'queue_id', deletion.id, 'provider_evidence', p_provider_evidence,
      'attempt_count', deletion.attempt_count
    )
  );
  RETURN jsonb_build_object(
    'queue_id', deletion.id, 'file_id', deletion.file_id,
    'status', 'completed', 'idempotent', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_retry_tenant_file_deletion(
  p_queue_id uuid,
  p_worker_id text,
  p_error text,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE deletion public.tenant_file_deletion_outbox%ROWTYPE;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF p_error NOT IN (
      'cos_delete_failed', 'provider_absence_missing',
      'database_complete_failed', 'worker_interrupted'
    )
    OR length(btrim(COALESCE(p_request_id, ''))) < 8
  THEN RAISE EXCEPTION 'storage_deletion_retry_invalid'; END IF;
  SELECT * INTO deletion FROM public.tenant_file_deletion_outbox
  WHERE id = p_queue_id FOR UPDATE;
  IF deletion.id IS NULL THEN RAISE EXCEPTION 'storage_deletion_not_found'; END IF;
  IF deletion.status = 'completed' THEN
    RETURN jsonb_build_object('queue_id', deletion.id, 'status', 'completed');
  END IF;
  IF deletion.status <> 'leased'
    OR deletion.lease_owner IS DISTINCT FROM btrim(p_worker_id)
  THEN RAISE EXCEPTION 'storage_deletion_lease_owner_required'; END IF;
  UPDATE public.tenant_file_deletion_outbox
  SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
    last_error = p_error,
    next_attempt_at = now() + interval '1 second' * LEAST(
      3600, 15 * power(2, LEAST(deletion.attempt_count, 8))::integer
    )
  WHERE id = deletion.id;
  RETURN jsonb_build_object(
    'queue_id', deletion.id, 'status', 'pending',
    'attempt_count', deletion.attempt_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_claim_tenant_file_deletions(integer, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v4_complete_tenant_file_deletion(
  uuid, uuid, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.v4_retry_tenant_file_deletion(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_claim_tenant_file_deletions(integer, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.v4_complete_tenant_file_deletion(
  uuid, uuid, uuid, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.v4_retry_tenant_file_deletion(uuid, text, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.v4_replace_kpi_targets(
  p_organization_id uuid,
  p_period text,
  p_targets jsonb,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  target_entry jsonb;
  assigned_user_id uuid;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'kpi.targets.manage', 'write'
  ) THEN RAISE EXCEPTION 'kpi_targets_manage_capability_required'; END IF;
  IF COALESCE(p_period, '') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'invalid_kpi_period';
  END IF;
  IF jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) > 100
    OR octet_length(convert_to(p_targets::text, 'UTF8')) > 262144
  THEN RAISE EXCEPTION 'invalid_kpi_targets_payload'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'kpi_request_id_required';
  END IF;

  FOR target_entry IN SELECT value FROM jsonb_array_elements(p_targets)
  LOOP
    IF jsonb_typeof(target_entry) <> 'object'
      OR target_entry - ARRAY[
        'target_type', 'target_amount', 'assigned_to', 'notes'
      ]::text[] <> '{}'::jsonb
      OR target_entry ->> 'target_type' NOT IN ('signing', 'collection')
      OR jsonb_typeof(target_entry -> 'target_amount') <> 'number'
      OR (target_entry ->> 'target_amount')::numeric <= 0
      OR length(COALESCE(target_entry ->> 'notes', '')) > 2000
    THEN RAISE EXCEPTION 'invalid_kpi_target'; END IF;
    assigned_user_id := NULLIF(target_entry ->> 'assigned_to', '')::uuid;
    IF assigned_user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.memberships membership
      JOIN public.profiles profile ON profile.id = membership.user_id
      WHERE membership.organization_id = p_organization_id
        AND membership.user_id = assigned_user_id
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
        AND profile.is_active IS TRUE
    ) THEN RAISE EXCEPTION 'kpi_assignee_not_active_member'; END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'v4-kpi-targets:' || p_organization_id::text || ':' || p_period, 0
    )
  );
  DELETE FROM public.kpi_targets
  WHERE organization_id = p_organization_id AND period = p_period;
  INSERT INTO public.kpi_targets (
    organization_id, period, target_type, target_amount,
    assigned_to, notes, set_by
  )
  SELECT
    p_organization_id, p_period, entry ->> 'target_type',
    (entry ->> 'target_amount')::numeric,
    NULLIF(entry ->> 'assigned_to', '')::uuid,
    NULLIF(btrim(COALESCE(entry ->> 'notes', '')), ''), actor_user_id
  FROM jsonb_array_elements(p_targets) entry;
  INSERT INTO public.notifications (
    organization_id, user_id, type, title, body,
    related_id, related_type, event_key
  )
  SELECT
    target.organization_id, target.assigned_to, 'kpi_target_set',
    'KPI target set for ' || target.period,
    target.target_type || ': AED ' || target.target_amount::text,
    target.id, 'kpi_target',
    'kpi:' || target.period || ':' || target.target_type || ':'
      || target.assigned_to::text || ':' || target.target_amount::text
  FROM public.kpi_targets target
  WHERE target.organization_id = p_organization_id
    AND target.period = p_period
    AND target.assigned_to IS NOT NULL
  ON CONFLICT (organization_id, user_id, event_key) DO NOTHING;
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, actor_user_id, 'kpi.targets_replaced',
    'kpi_period', p_period, 'success', 'organization_capability_authorized',
    p_request_id, jsonb_build_object('target_count', jsonb_array_length(p_targets))
  );
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(target) ORDER BY target.assigned_to NULLS FIRST, target.id)
    FROM public.kpi_targets target
    WHERE target.organization_id = p_organization_id
      AND target.period = p_period
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.v4_replace_kpi_targets(
  uuid, text, jsonb, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_replace_kpi_targets(
  uuid, text, jsonb, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_create_contract_for_organization(
  p_organization_id uuid,
  p_payload jsonb,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  requested_lead_id uuid;
  lead_row public.leads%ROWTYPE;
  installment jsonb;
  installments jsonb;
  first_payment_due_date date;
  new_contract_id uuid := gen_random_uuid();
  contract_sequence integer;
  contract_number text;
  payload_hash text;
  inserted_request_count integer;
  workflow_request public.contract_workflow_requests%ROWTYPE;
  workflow_result jsonb;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'contracts.create', 'write'
  ) THEN RAISE EXCEPTION 'contract_create_capability_required'; END IF;
  IF COALESCE(p_request_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' THEN
    RAISE EXCEPTION 'contract_request_id_required';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object'
    OR octet_length(convert_to(p_payload::text, 'UTF8')) > 262144
    OR p_payload - ARRAY[
      'lead_id', 'amount', 'currency', 'party_a_name', 'party_a_contact',
      'party_b_name', 'first_payment_due_date', 'installments'
    ]::text[] <> '{}'::jsonb
  THEN RAISE EXCEPTION 'invalid_contract_payload'; END IF;
  IF jsonb_typeof(p_payload -> 'lead_id') <> 'string'
    OR jsonb_typeof(p_payload -> 'amount') <> 'number'
    OR (p_payload ->> 'amount')::numeric <= 0
    OR (p_payload ->> 'amount')::numeric > 9999999999.99
    OR round((p_payload ->> 'amount')::numeric, 2)
      <> (p_payload ->> 'amount')::numeric
  THEN RAISE EXCEPTION 'invalid_contract_payload'; END IF;
  requested_lead_id := (p_payload ->> 'lead_id')::uuid;
  IF length(btrim(COALESCE(p_payload ->> 'party_a_name', ''))) > 200
    OR length(btrim(COALESCE(p_payload ->> 'party_a_contact', ''))) > 200
    OR length(btrim(COALESCE(p_payload ->> 'party_b_name', ''))) > 200
    OR length(btrim(COALESCE(p_payload ->> 'currency', 'AED'))) NOT BETWEEN 3 AND 8
  THEN RAISE EXCEPTION 'invalid_contract_payload'; END IF;
  IF NULLIF(p_payload ->> 'first_payment_due_date', '') IS NOT NULL THEN
    IF (p_payload ->> 'first_payment_due_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'invalid_contract_due_date';
    END IF;
    first_payment_due_date := (p_payload ->> 'first_payment_due_date')::date;
  END IF;
  installments := COALESCE(p_payload -> 'installments', '[]'::jsonb);
  IF jsonb_typeof(installments) <> 'array'
    OR jsonb_array_length(installments) > 120
  THEN RAISE EXCEPTION 'invalid_contract_installments'; END IF;
  FOR installment IN SELECT value FROM jsonb_array_elements(installments)
  LOOP
    IF jsonb_typeof(installment) <> 'object'
      OR installment - ARRAY['seq', 'amount', 'due_date', 'description']::text[]
        <> '{}'::jsonb
      OR jsonb_typeof(installment -> 'seq') <> 'number'
      OR (installment ->> 'seq') !~ '^[1-9][0-9]*$'
      OR (installment ->> 'seq')::integer > 120
      OR jsonb_typeof(installment -> 'amount') <> 'number'
      OR (installment ->> 'amount')::numeric <= 0
      OR (installment ->> 'amount')::numeric > 9999999999.99
      OR round((installment ->> 'amount')::numeric, 2)
        <> (installment ->> 'amount')::numeric
      OR jsonb_typeof(installment -> 'due_date') <> 'string'
      OR (installment ->> 'due_date') !~ '^\d{4}-\d{2}-\d{2}$'
      OR length(COALESCE(installment ->> 'description', '')) > 500
    THEN RAISE EXCEPTION 'invalid_contract_installment'; END IF;
    PERFORM (installment ->> 'due_date')::date;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(installments) entry
    GROUP BY (entry ->> 'seq')::integer HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'duplicate_contract_installment_sequence'; END IF;
  IF jsonb_array_length(installments) = 0 OR (
    SELECT sum((entry ->> 'amount')::numeric)
    FROM jsonb_array_elements(installments) entry
  ) <> (p_payload ->> 'amount')::numeric
  THEN RAISE EXCEPTION 'contract_installments_total_mismatch'; END IF;

  payload_hash := encode(
    extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex'
  );
  INSERT INTO public.contract_workflow_requests (
    organization_id, request_id, operation, payload_hash, actor_user_id
  ) VALUES (
    p_organization_id, btrim(p_request_id), 'contract.create',
    payload_hash, actor_user_id
  ) ON CONFLICT (organization_id, request_id) DO NOTHING;
  GET DIAGNOSTICS inserted_request_count = ROW_COUNT;
  SELECT * INTO workflow_request FROM public.contract_workflow_requests
  WHERE organization_id = p_organization_id AND request_id = btrim(p_request_id)
  FOR UPDATE;
  IF workflow_request.operation <> 'contract.create'
    OR workflow_request.payload_hash <> payload_hash
    OR workflow_request.actor_user_id <> actor_user_id
  THEN RAISE EXCEPTION 'contract_request_idempotency_mismatch'; END IF;
  IF inserted_request_count = 0 THEN
    IF workflow_request.result IS NULL THEN
      RAISE EXCEPTION 'contract_request_in_progress';
    END IF;
    RETURN workflow_request.result || jsonb_build_object('idempotent', true);
  END IF;

  SELECT * INTO lead_row FROM public.leads
  WHERE id = requested_lead_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF lead_row.id IS NULL THEN RAISE EXCEPTION 'contract_lead_not_found'; END IF;
  IF lead_row.assigned_to IS DISTINCT FROM actor_user_id
    AND NOT public.v4_actor_has_capability(
      p_organization_id, actor_user_id, 'contracts.write_any', 'write'
    )
  THEN RAISE EXCEPTION 'lead_ownership_required'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.contracts contract
    WHERE contract.organization_id = p_organization_id
      AND contract.lead_id = requested_lead_id
      AND contract.status NOT IN ('archived', 'cancelled', 'terminated')
  ) THEN RAISE EXCEPTION 'active_contract_already_exists'; END IF;

  INSERT INTO public.organization_document_sequences (
    organization_id, document_kind, document_date, next_value
  ) VALUES (p_organization_id, 'contract', current_date, 2)
  ON CONFLICT (organization_id, document_kind, document_date)
  DO UPDATE SET next_value = public.organization_document_sequences.next_value + 1
  RETURNING next_value - 1 INTO contract_sequence;
  IF contract_sequence NOT BETWEEN 1 AND 999 THEN
    RAISE EXCEPTION 'contract_document_sequence_exhausted';
  END IF;
  contract_number := format(
    'NEW-%s-%s', to_char(current_date, 'YYYYMMDD'), lpad(contract_sequence::text, 3, '0')
  );

  INSERT INTO public.contracts (
    id, organization_id, lead_id, sales_id, created_by, contract_no,
    contract_date, contract_amount, currency, party_a_name, party_a_contact,
    party_b_name, status, approval_status, first_payment_due_date
  ) VALUES (
    new_contract_id, p_organization_id, requested_lead_id, actor_user_id, actor_user_id,
    contract_number, current_date, (p_payload ->> 'amount')::numeric,
    upper(btrim(COALESCE(p_payload ->> 'currency', 'AED'))),
    COALESCE(NULLIF(btrim(p_payload ->> 'party_a_name'), ''), 'Unknown'),
    NULLIF(btrim(COALESCE(p_payload ->> 'party_a_contact', '')), ''),
    COALESCE(NULLIF(btrim(p_payload ->> 'party_b_name'), ''), 'NewMe Smart Home FZCO'),
    'draft', 'pending', first_payment_due_date
  );
  INSERT INTO public.installment_plans (
    organization_id, contract_id, seq, amount, due_date, description, status
  )
  SELECT p_organization_id, new_contract_id, (entry ->> 'seq')::integer,
    (entry ->> 'amount')::numeric, (entry ->> 'due_date')::date,
    NULLIF(btrim(COALESCE(entry ->> 'description', '')), ''), 'pending'
  FROM jsonb_array_elements(installments) entry;
  INSERT INTO public.contract_approvals (
    organization_id, contract_id, step, status, notes
  ) VALUES (
    p_organization_id, new_contract_id, 'admin_review', 'pending',
    jsonb_build_object('source', 'contract_create', 'request_id', p_request_id)
  );
  INSERT INTO public.activities (
    organization_id, lead_id, contract_id, type, content, ai_generated, user_id
  ) VALUES (
    p_organization_id, requested_lead_id, new_contract_id, 'note',
    format('Contract %s created and pending approval', contract_number),
    false, actor_user_id
  );
  workflow_result := jsonb_build_object(
    'contract_id', new_contract_id, 'contract_no', contract_number,
    'status', 'draft', 'installment_count', jsonb_array_length(installments),
    'idempotent', false
  );
  UPDATE public.contract_workflow_requests
  SET result = workflow_result, completed_at = now()
  WHERE organization_id = p_organization_id AND request_id = btrim(p_request_id);
  RETURN workflow_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_convert_quotation_for_organization(
  p_organization_id uuid,
  p_quotation_id uuid,
  p_payload jsonb,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  quotation_row public.quotations%ROWTYPE;
  lead_row public.leads%ROWTYPE;
  installment jsonb;
  installments jsonb;
  first_payment_due_date date;
  new_contract_id uuid := gen_random_uuid();
  contract_sequence integer;
  contract_number text;
  payload_hash text;
  inserted_request_count integer;
  workflow_request public.contract_workflow_requests%ROWTYPE;
  workflow_result jsonb;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'quotations.convert', 'write'
  ) THEN RAISE EXCEPTION 'quotation_convert_capability_required'; END IF;
  IF COALESCE(p_request_id, '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$' THEN
    RAISE EXCEPTION 'quotation_convert_request_id_required';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object'
    OR octet_length(convert_to(p_payload::text, 'UTF8')) > 262144
    OR p_payload - ARRAY['first_payment_due_date', 'installments']::text[]
      <> '{}'::jsonb
  THEN RAISE EXCEPTION 'invalid_quotation_convert_payload'; END IF;
  IF NULLIF(p_payload ->> 'first_payment_due_date', '') IS NOT NULL THEN
    IF (p_payload ->> 'first_payment_due_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'invalid_contract_due_date';
    END IF;
    first_payment_due_date := (p_payload ->> 'first_payment_due_date')::date;
  END IF;
  installments := COALESCE(p_payload -> 'installments', '[]'::jsonb);
  IF jsonb_typeof(installments) <> 'array'
    OR jsonb_array_length(installments) > 120
  THEN RAISE EXCEPTION 'invalid_contract_installments'; END IF;
  FOR installment IN SELECT value FROM jsonb_array_elements(installments)
  LOOP
    IF jsonb_typeof(installment) <> 'object'
      OR installment - ARRAY['seq', 'amount', 'due_date', 'description']::text[]
        <> '{}'::jsonb
      OR jsonb_typeof(installment -> 'seq') <> 'number'
      OR (installment ->> 'seq') !~ '^[1-9][0-9]*$'
      OR (installment ->> 'seq')::integer > 120
      OR jsonb_typeof(installment -> 'amount') <> 'number'
      OR (installment ->> 'amount')::numeric <= 0
      OR (installment ->> 'amount')::numeric > 9999999999.99
      OR round((installment ->> 'amount')::numeric, 2)
        <> (installment ->> 'amount')::numeric
      OR jsonb_typeof(installment -> 'due_date') <> 'string'
      OR (installment ->> 'due_date') !~ '^\d{4}-\d{2}-\d{2}$'
      OR length(COALESCE(installment ->> 'description', '')) > 500
    THEN RAISE EXCEPTION 'invalid_contract_installment'; END IF;
    PERFORM (installment ->> 'due_date')::date;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(installments) entry
    GROUP BY (entry ->> 'seq')::integer HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'duplicate_contract_installment_sequence'; END IF;

  payload_hash := encode(extensions.digest(convert_to(
    p_quotation_id::text || ':' || p_payload::text, 'UTF8'
  ), 'sha256'), 'hex');
  INSERT INTO public.contract_workflow_requests (
    organization_id, request_id, operation, payload_hash, actor_user_id
  ) VALUES (
    p_organization_id, btrim(p_request_id), 'quotation.convert',
    payload_hash, actor_user_id
  ) ON CONFLICT (organization_id, request_id) DO NOTHING;
  GET DIAGNOSTICS inserted_request_count = ROW_COUNT;
  SELECT * INTO workflow_request FROM public.contract_workflow_requests
  WHERE organization_id = p_organization_id AND request_id = btrim(p_request_id)
  FOR UPDATE;
  IF workflow_request.operation <> 'quotation.convert'
    OR workflow_request.payload_hash <> payload_hash
    OR workflow_request.actor_user_id <> actor_user_id
  THEN RAISE EXCEPTION 'contract_request_idempotency_mismatch'; END IF;
  IF inserted_request_count = 0 THEN
    IF workflow_request.result IS NULL THEN
      RAISE EXCEPTION 'contract_request_in_progress';
    END IF;
    RETURN workflow_request.result || jsonb_build_object('idempotent', true);
  END IF;

  SELECT * INTO quotation_row FROM public.quotations
  WHERE id = p_quotation_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF quotation_row.id IS NULL THEN RAISE EXCEPTION 'quotation_not_found'; END IF;
  IF quotation_row.contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'quotation_already_converted';
  END IF;
  SELECT * INTO lead_row FROM public.leads
  WHERE id = quotation_row.lead_id AND organization_id = p_organization_id
  FOR UPDATE;
  IF lead_row.id IS NULL THEN RAISE EXCEPTION 'quotation_lead_not_found'; END IF;
  IF quotation_row.status <> 'accepted' THEN
    RAISE EXCEPTION 'quotation_not_accepted';
  END IF;
  IF quotation_row.total_amount <= 0 THEN
    RAISE EXCEPTION 'quotation_total_must_be_positive';
  END IF;
  IF round(quotation_row.total_amount, 2) <> quotation_row.total_amount
    OR jsonb_array_length(installments) = 0
    OR (
      SELECT sum((entry ->> 'amount')::numeric)
      FROM jsonb_array_elements(installments) entry
    ) <> quotation_row.total_amount
  THEN RAISE EXCEPTION 'contract_installments_total_mismatch'; END IF;
  IF quotation_row.created_by IS DISTINCT FROM actor_user_id
    AND NOT public.v4_actor_has_capability(
      p_organization_id, actor_user_id, 'contracts.write_any', 'write'
    )
  THEN RAISE EXCEPTION 'quotation_ownership_required'; END IF;

  INSERT INTO public.organization_document_sequences (
    organization_id, document_kind, document_date, next_value
  ) VALUES (p_organization_id, 'contract', current_date, 2)
  ON CONFLICT (organization_id, document_kind, document_date)
  DO UPDATE SET next_value = public.organization_document_sequences.next_value + 1
  RETURNING next_value - 1 INTO contract_sequence;
  IF contract_sequence NOT BETWEEN 1 AND 999 THEN
    RAISE EXCEPTION 'contract_document_sequence_exhausted';
  END IF;
  contract_number := format(
    'NEW-%s-%s', to_char(current_date, 'YYYYMMDD'), lpad(contract_sequence::text, 3, '0')
  );

  INSERT INTO public.contracts (
    id, organization_id, lead_id, quotation_id, customer_id, sales_id,
    created_by, contract_no, contract_date, contract_amount, currency,
    party_a_name, party_b_name, status, approval_status, first_payment_due_date
  ) VALUES (
    new_contract_id, p_organization_id, lead_row.id, quotation_row.id,
    COALESCE(quotation_row.customer_id, lead_row.customer_id),
    COALESCE(quotation_row.created_by, actor_user_id), actor_user_id,
    contract_number, current_date, quotation_row.total_amount,
    COALESCE(quotation_row.currency, 'AED'),
    COALESCE(NULLIF(btrim(lead_row.customer_name), ''), 'Unknown'),
    'NewMe Smart Home FZCO', 'draft', 'pending', first_payment_due_date
  );
  INSERT INTO public.installment_plans (
    organization_id, contract_id, seq, amount, due_date, description, status
  )
  SELECT p_organization_id, new_contract_id, (entry ->> 'seq')::integer,
    (entry ->> 'amount')::numeric, (entry ->> 'due_date')::date,
    NULLIF(btrim(COALESCE(entry ->> 'description', '')), ''), 'pending'
  FROM jsonb_array_elements(installments) entry;
  INSERT INTO public.contract_approvals (
    organization_id, contract_id, step, status, notes
  ) VALUES (
    p_organization_id, new_contract_id, 'admin_review', 'pending',
    jsonb_build_object(
      'source', 'quotation', 'quotation_id', quotation_row.id,
      'quote_no', quotation_row.quote_no, 'request_id', p_request_id
    )
  );
  UPDATE public.quotations
  SET contract_id = new_contract_id, status = 'contract_created', updated_at = now()
  WHERE id = quotation_row.id AND organization_id = p_organization_id;
  UPDATE public.leads
  SET final_status = 'won', updated_at = now()
  WHERE id = lead_row.id AND organization_id = p_organization_id;
  INSERT INTO public.projects (
    organization_id, lead_id, contract_id, sales_id, customer_id, name,
    property_type, property_size, location, phase, status, contract_amount
  ) VALUES (
    p_organization_id, lead_row.id, new_contract_id,
    COALESCE(quotation_row.created_by, actor_user_id),
    COALESCE(quotation_row.customer_id, lead_row.customer_id),
    format('%s - %s',
      COALESCE(NULLIF(btrim(lead_row.customer_name), ''), 'Client'),
      COALESCE(NULLIF(btrim(lead_row.property_type), ''), 'Smart Home')
    ),
    lead_row.property_type, lead_row.property_size_sqm, lead_row.location,
    'design', 'active', quotation_row.total_amount
  );
  INSERT INTO public.activities (
    organization_id, lead_id, quotation_id, contract_id,
    type, content, ai_generated, user_id
  ) VALUES (
    p_organization_id, lead_row.id, quotation_row.id, new_contract_id,
    'note', format('Contract %s created from quotation %s and pending approval',
      contract_number, quotation_row.quote_no), false, actor_user_id
  );
  workflow_result := jsonb_build_object(
    'contract_id', new_contract_id, 'contract_no', contract_number,
    'quotation_id', quotation_row.id, 'quotation_status', 'contract_created',
    'installment_count', jsonb_array_length(installments), 'idempotent', false
  );
  UPDATE public.contract_workflow_requests
  SET result = workflow_result, completed_at = now()
  WHERE organization_id = p_organization_id AND request_id = btrim(p_request_id);
  RETURN workflow_result;
END;
$$;

REVOKE ALL ON FUNCTION public.v4_create_contract_for_organization(uuid, jsonb, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.v4_convert_quotation_for_organization(
  uuid, uuid, jsonb, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_create_contract_for_organization(uuid, jsonb, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.v4_convert_quotation_for_organization(
  uuid, uuid, jsonb, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.v4_confirm_payment_for_organization(
  p_organization_id uuid,
  p_payment_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'payments.confirm', 'write'
  ) THEN RAISE EXCEPTION 'payment_confirm_capability_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'payment_request_id_required';
  END IF;
  PERFORM 1 FROM public.payments payment
  WHERE payment.id = p_payment_id
    AND payment.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_not_found'; END IF;
  RETURN public.confirm_payment(p_payment_id, actor_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.v4_allocate_payment_for_organization(
  p_organization_id uuid,
  p_payment_id uuid,
  p_allocations jsonb,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  actor_user_id uuid := auth.uid();
  payment_contract_id uuid;
BEGIN
  IF actor_user_id IS NULL THEN RAISE EXCEPTION 'authenticated_user_required'; END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, actor_user_id, 'payments.allocate', 'write'
  ) THEN RAISE EXCEPTION 'payment_allocate_capability_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'payment_request_id_required';
  END IF;
  IF jsonb_typeof(p_allocations) <> 'array'
    OR jsonb_array_length(p_allocations) = 0
    OR jsonb_array_length(p_allocations) > 100
  THEN RAISE EXCEPTION 'invalid_payment_allocations'; END IF;
  SELECT payment.contract_id INTO payment_contract_id
  FROM public.payments payment
  WHERE payment.id = p_payment_id
    AND payment.organization_id = p_organization_id
  FOR UPDATE;
  IF payment_contract_id IS NULL THEN RAISE EXCEPTION 'payment_not_found'; END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_allocations) entry
    LEFT JOIN public.installment_plans plan
      ON plan.id = NULLIF(entry ->> 'plan_id', '')::uuid
    WHERE jsonb_typeof(entry) <> 'object'
      OR jsonb_typeof(entry -> 'amount') <> 'number'
      OR (entry ->> 'amount')::numeric <= 0
      OR plan.id IS NULL
      OR plan.organization_id <> p_organization_id
      OR plan.contract_id <> payment_contract_id
  ) THEN RAISE EXCEPTION 'payment_allocation_plan_mismatch'; END IF;
  RETURN public.allocate_payment(p_payment_id, p_allocations, actor_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.v4_confirm_payment_for_organization(
  uuid, uuid, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_confirm_payment_for_organization(
  uuid, uuid, text
) TO authenticated;
REVOKE ALL ON FUNCTION public.v4_allocate_payment_for_organization(
  uuid, uuid, jsonb, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.v4_allocate_payment_for_organization(
  uuid, uuid, jsonb, text
) TO authenticated;

-- The legacy helpers are implementation details once the organization-bound
-- wrappers exist. Browser roles must not call them with caller-supplied actors.
DO $$
BEGIN
  IF to_regprocedure('public.confirm_payment(uuid,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.confirm_payment(uuid, uuid)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.confirm_payment(uuid, uuid) TO service_role;
  END IF;
  IF to_regprocedure('public.allocate_payment(uuid,jsonb,uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.allocate_payment(uuid, jsonb, uuid)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.allocate_payment(uuid, jsonb, uuid)
      TO service_role;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.v4_process_no_answer_worker(
  p_organization_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  marked_count integer := 0;
  notification_count integer := 0;
  checked_count integer := 0;
  lead_row record;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = p_organization_id AND status = 'active'
  ) THEN RAISE EXCEPTION 'active_organization_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'worker_request_id_required';
  END IF;

  FOR lead_row IN
    SELECT lead_record.id, lead_record.assigned_to, lead_record.customer_name
    FROM public.leads lead_record
    WHERE lead_record.organization_id = p_organization_id
  LOOP
    checked_count := checked_count + 1;
    IF (
      SELECT count(*) = 3 AND bool_and(recent.no_answer)
      FROM (
        SELECT follow_up.no_answer
        FROM public.follow_up_logs follow_up
        WHERE follow_up.organization_id = p_organization_id
          AND follow_up.lead_id = lead_row.id
        ORDER BY follow_up.contact_time DESC,
          follow_up.created_at DESC,
          follow_up.id DESC
        LIMIT 3
      ) recent
    ) THEN
      UPDATE public.leads
      SET no_answer_flag = true, updated_at = now()
      WHERE id = lead_row.id
        AND organization_id = p_organization_id
        AND no_answer_flag IS DISTINCT FROM true;
      IF FOUND THEN
        marked_count := marked_count + 1;
        IF lead_row.assigned_to IS NOT NULL THEN
          INSERT INTO public.notifications (
            organization_id, user_id, type, title, body,
            related_id, related_type
          ) VALUES (
            p_organization_id, lead_row.assigned_to, 'warning',
            'Lead has three unanswered follow-ups',
            'Review the lead and adjust the follow-up plan.',
            lead_row.id, 'lead'
          );
          notification_count := notification_count + 1;
        END IF;
      END IF;
    END IF;
  END LOOP;
  INSERT INTO public.audit_events (
    organization_id, action, target_type, target_id, outcome,
    reason, request_id, metadata
  ) VALUES (
    p_organization_id, 'worker.no_answer.processed', 'organization',
    p_organization_id::text, 'success', 'active_tenant_worker_partition',
    p_request_id, jsonb_build_object(
      'checked', checked_count,
      'marked_no_answer', marked_count,
      'notifications', notification_count
    )
  );
  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'checked', checked_count,
    'marked_no_answer', marked_count,
    'notifications', notification_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_process_no_answer_worker(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_process_no_answer_worker(uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.v4_organization_customer_snapshot(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  snapshot jsonb;
  tables jsonb;
  files jsonb;
  counts jsonb;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  snapshot := public.organization_customer_snapshot(p_organization_id);
  tables := (snapshot -> 'tables') || jsonb_build_object(
    'ad_spend', public.organization_export_rows(
      'SELECT * FROM public.ad_spend WHERE organization_id = $1', p_organization_id
    ),
    'audit_logs', public.organization_export_rows(
      'SELECT * FROM public.audit_logs WHERE organization_id = $1', p_organization_id
    ),
    'kpi_targets', public.organization_export_rows(
      'SELECT * FROM public.kpi_targets WHERE organization_id = $1', p_organization_id
    ),
    'lead_assignment_state', public.organization_export_rows(
      'SELECT * FROM public.lead_assignment_state WHERE organization_id = $1',
      p_organization_id
    ),
    'organization_lifecycle_requests', public.organization_export_rows(
      'SELECT * FROM public.organization_lifecycle_requests '
        || 'WHERE organization_id = $1', p_organization_id
    ),
    'tenant_file_objects', public.organization_export_rows(
      'SELECT * FROM public.tenant_file_objects WHERE organization_id = $1',
      p_organization_id
    )
  );
  SELECT COALESCE(jsonb_object_agg(entry.key, jsonb_array_length(entry.value)),
    '{}'::jsonb)
  INTO counts FROM jsonb_each(tables) entry;
  files := (snapshot -> 'files') || jsonb_build_object(
    'tenant_file_objects', public.organization_export_rows(
      'SELECT id, record_type, record_id, object_key, original_filename, '
        || 'version, status, content_type, size_bytes FROM public.tenant_file_objects '
        || 'WHERE organization_id = $1 AND status = ''available''',
      p_organization_id
    )
  );
  RETURN jsonb_build_object(
    'contract_version', 2,
    'organization_id', p_organization_id,
    'tables', tables,
    'counts', counts,
    'files', files,
    'shared_reference_tables', snapshot -> 'shared_reference_tables',
    'legacy_unscoped_tables', '[]'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_organization_customer_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_organization_customer_snapshot(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.v4_export_organization_customer_data(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  snapshot jsonb;
  digest_value text;
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), ''), session_user)
    <> 'service_role'
  THEN RAISE EXCEPTION 'service_role_required'; END IF;
  IF length(btrim(COALESCE(p_request_id, ''))) < 8 THEN
    RAISE EXCEPTION 'export_request_id_required';
  END IF;
  IF NOT public.v4_actor_has_capability(
    p_organization_id, p_actor_user_id, 'organization.data.export', 'export'
  ) THEN RAISE EXCEPTION 'organization_export_capability_required'; END IF;
  snapshot := public.v4_organization_customer_snapshot(p_organization_id);
  digest_value := encode(
    extensions.digest(convert_to(snapshot::text, 'UTF8'), 'sha256'), 'hex'
  );
  INSERT INTO public.audit_events (
    organization_id, actor_user_id, action, target_type, target_id,
    outcome, reason, request_id, metadata
  ) VALUES (
    p_organization_id, p_actor_user_id, 'organization.customer_export.v4',
    'organization', p_organization_id::text, 'success',
    'capability_authorized_complete_export', p_request_id,
    jsonb_build_object('contract_version', 2, 'data_sha256', digest_value)
  );
  RETURN jsonb_build_object(
    'contract_version', 2,
    'generated_at', clock_timestamp(),
    'digest_algorithm', 'sha256',
    'data_sha256', digest_value,
    'data', snapshot
  );
END;
$$;

REVOKE ALL ON FUNCTION public.v4_export_organization_customer_data(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.v4_export_organization_customer_data(uuid, uuid, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
