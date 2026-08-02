BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'v4_tenant_capability_expand_rollback_requires_staging_or_test';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.products
    WHERE organization_id IS DISTINCT FROM
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ) THEN
    RAISE EXCEPTION
      'v4_tenant_capability_expand_rollback_nonlegacy_products_present';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'products'
      AND policyname NOT IN (
        'v4_products_capability_read',
        'v4_products_capability_insert',
        'v4_products_capability_update',
        'v4_products_capability_delete'
      )
  ) THEN
    RAISE EXCEPTION
      'v4_tenant_capability_expand_rollback_product_policy_drift';
  END IF;

  IF (
    SELECT count(*) FROM public.capabilities
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM public.capabilities
    WHERE scope <> 'organization'
      OR capability_key NOT IN (
        'organization.context.select',
        'catalog.products.read',
        'catalog.products.create',
        'catalog.products.update',
        'catalog.products.delete',
        'catalog.products.import'
      )
  ) THEN
    RAISE EXCEPTION 'v4_tenant_capability_expand_rollback_catalog_drift';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.role_capabilities role_capability
    JOIN public.roles role ON role.id = role_capability.role_id
    JOIN public.capabilities capability
      ON capability.id = role_capability.capability_id
    WHERE role.scope <> 'organization'
      OR capability.scope <> 'organization'
      OR NOT (
        capability.capability_key = 'organization.context.select'
        OR (
          capability.capability_key = 'catalog.products.read'
          AND role.role_key IN (
            'org_owner', 'org_admin', 'operations', 'finance',
            'specialist', 'sales_agent'
          )
        )
        OR (
          capability.capability_key IN (
            'catalog.products.create', 'catalog.products.update'
          )
          AND role.role_key IN ('org_owner', 'org_admin', 'operations')
        )
        OR (
          capability.capability_key = 'catalog.products.delete'
          AND role.role_key IN ('org_owner', 'org_admin')
        )
        OR (
          capability.capability_key = 'catalog.products.import'
          AND role.role_key = 'org_admin'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.roles role
    CROSS JOIN public.capabilities capability
    WHERE role.scope = 'organization'
      AND capability.scope = 'organization'
      AND (
        capability.capability_key = 'organization.context.select'
        OR (
          capability.capability_key = 'catalog.products.read'
          AND role.role_key IN (
            'org_owner', 'org_admin', 'operations', 'finance',
            'specialist', 'sales_agent'
          )
        )
        OR (
          capability.capability_key IN (
            'catalog.products.create', 'catalog.products.update'
          )
          AND role.role_key IN ('org_owner', 'org_admin', 'operations')
        )
        OR (
          capability.capability_key = 'catalog.products.delete'
          AND role.role_key IN ('org_owner', 'org_admin')
        )
        OR (
          capability.capability_key = 'catalog.products.import'
          AND role.role_key = 'org_admin'
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.role_capabilities role_capability
        WHERE role_capability.role_id = role.id
          AND role_capability.capability_id = capability.id
      )
  ) THEN
    RAISE EXCEPTION 'v4_tenant_capability_expand_rollback_mapping_drift';
  END IF;
END
$$;

DROP POLICY IF EXISTS v4_products_capability_read ON public.products;
DROP POLICY IF EXISTS v4_products_capability_insert ON public.products;
DROP POLICY IF EXISTS v4_products_capability_update ON public.products;
DROP POLICY IF EXISTS v4_products_capability_delete ON public.products;
DROP FUNCTION IF EXISTS public.import_products_for_organization(uuid, jsonb);
DROP FUNCTION IF EXISTS public.create_product_for_organization(uuid, jsonb);
DROP FUNCTION IF EXISTS public.product_payload_is_valid(jsonb);
DROP FUNCTION IF EXISTS public.product_capability_allowed(uuid, text);
DROP FUNCTION IF EXISTS public.product_organization_context();

CREATE OR REPLACE FUNCTION public.security_definer_rpc_allowlist_gate()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(regprocedure) AS (
    VALUES
      ('delete_lead_atomic(uuid,uuid)'),
      ('get_my_role()'),
      ('next_quote_no()'),
      ('organization_billable_seat_count(uuid)'),
      ('reassign_lead_atomic(uuid,uuid,timestamp with time zone,uuid,text)'),
      ('recomplete_lead_milestone(uuid,text,text)'),
      ('record_lead_contact_atomic(uuid,text,timestamp with time zone,text,text,text,uuid)'),
      ('record_lead_note_atomic(uuid,text,uuid)'),
      ('reopen_lead_milestone(uuid,text,text)'),
      ('transition_lead_stage(uuid,text,text,text,uuid)')
  ),
  actual AS (
    SELECT
      p.oid,
      p.oid::regprocedure::text AS regprocedure,
      p.proconfig,
      pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
      pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
  ),
  violations AS (
    SELECT 'unexpected_authenticated'::text AS violation, a.regprocedure
    FROM actual AS a
    LEFT JOIN expected AS e USING (regprocedure)
    WHERE a.authenticated_execute
      AND e.regprocedure IS NULL

    UNION ALL

    SELECT 'missing_expected'::text, e.regprocedure
    FROM expected AS e
    LEFT JOIN actual AS a USING (regprocedure)
    WHERE a.oid IS NULL
      OR NOT a.authenticated_execute

    UNION ALL

    SELECT 'anon_execute'::text, a.regprocedure
    FROM actual AS a
    WHERE a.anon_execute

    UNION ALL

    SELECT 'unsafe_search_path'::text, a.regprocedure
    FROM actual AS a
    WHERE NOT (
      COALESCE(a.proconfig, ARRAY[]::text[])
      @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
    )
  )
  SELECT jsonb_build_object(
    'gate_version', 'sam61-allowlist-v3',
    'violations', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'violation', violation,
          'regprocedure', regprocedure
        )
        ORDER BY violation, regprocedure
      ) FILTER (WHERE violation IS NOT NULL),
      '[]'::jsonb
    )
  )
  FROM violations;
$function$;

REVOKE ALL ON FUNCTION public.security_definer_rpc_allowlist_gate()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.security_definer_rpc_allowlist_gate()
TO service_role;

ALTER TABLE public.products NO FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.products
  TO authenticated;

CREATE POLICY policy_products_select_admin
  ON public.products FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
    )
  );
CREATE POLICY policy_products_select_finance
  ON public.products FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'finance'
    )
  );
CREATE POLICY policy_products_select_designer
  ON public.products FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'designer'
    )
  );
CREATE POLICY policy_products_select_sales
  ON public.products FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'sales'
    )
  );
CREATE POLICY policy_products_insert_admin
  ON public.products FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
    )
  );
CREATE POLICY policy_products_update_admin
  ON public.products FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
    )
  );
CREATE POLICY policy_products_delete_admin
  ON public.products FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'boss')
    )
  );

DROP TRIGGER IF EXISTS v4_enforce_product_organization_context
  ON public.products;
DROP FUNCTION IF EXISTS public.enforce_product_organization_context();
DROP INDEX IF EXISTS public.products_organization_catalog_lookup_idx;
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_organization_id_id_unique,
  DROP CONSTRAINT IF EXISTS products_tenant_matches_organization_check,
  DROP CONSTRAINT IF EXISTS products_organization_id_fkey,
  DROP COLUMN IF EXISTS organization_id;

DROP TRIGGER IF EXISTS v4_enforce_role_capability_scope
  ON public.role_capabilities;
DROP FUNCTION IF EXISTS public.enforce_role_capability_scope();
DROP TABLE IF EXISTS public.role_capabilities;
DROP TABLE IF EXISTS public.capabilities;

NOTIFY pgrst, 'reload schema';

COMMIT;
