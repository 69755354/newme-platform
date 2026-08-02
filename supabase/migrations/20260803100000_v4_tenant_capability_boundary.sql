-- V4 / SAM-78 deployable foundation: add the capability catalog, nullable
-- product organization ownership, and transitional tenant-safe product RLS.
-- The compatibility trigger accepts tenant-only writes and explicit new
-- organization writes, but rejects context-free service-role writes to prevent
-- silent legacy-tenant assignment. A request without an organization header is
-- accepted only when the caller has exactly one active membership.
-- NOT NULL and tenant-local SKU contraction intentionally remain a later,
-- separately deployed migration after this compatible application is live.

BEGIN;

CREATE TABLE public.capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_key text NOT NULL,
  scope text NOT NULL DEFAULT 'organization'
    CHECK (scope IN ('organization', 'platform')),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capabilities_scope_key_unique UNIQUE (scope, capability_key),
  CONSTRAINT capabilities_key_format_check
    CHECK (capability_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

CREATE TABLE public.role_capabilities (
  role_id uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL
    REFERENCES public.capabilities(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, capability_id)
);

CREATE INDEX role_capabilities_capability_lookup_idx
  ON public.role_capabilities (capability_id, role_id);

ALTER TABLE public.capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.role_capabilities FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.capabilities, public.role_capabilities
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.capabilities, public.role_capabilities
  TO authenticated;
GRANT ALL ON TABLE public.capabilities, public.role_capabilities
  TO service_role;

CREATE POLICY v4_capabilities_authenticated_catalog_read
  ON public.capabilities
  FOR SELECT
  TO authenticated
  USING (scope = 'organization');

CREATE POLICY v4_role_capabilities_authenticated_catalog_read
  ON public.role_capabilities
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.roles role
      JOIN public.capabilities capability
        ON capability.id = role_capabilities.capability_id
      WHERE role.id = role_capabilities.role_id
        AND role.scope = 'organization'
        AND capability.scope = 'organization'
    )
  );

INSERT INTO public.capabilities (capability_key, scope, description)
VALUES
  (
    'organization.context.select',
    'organization',
    'Select an active organization membership as request context.'
  ),
  (
    'catalog.products.read',
    'organization',
    'Read the product catalog owned by the selected organization.'
  ),
  (
    'catalog.products.create',
    'organization',
    'Create products in the selected organization catalog.'
  ),
  (
    'catalog.products.update',
    'organization',
    'Update products in the selected organization catalog.'
  ),
  (
    'catalog.products.delete',
    'organization',
    'Delete products in the selected organization catalog.'
  ),
  (
    'catalog.products.import',
    'organization',
    'Bulk import products into the selected organization catalog.'
  )
ON CONFLICT (scope, capability_key) DO UPDATE
SET description = EXCLUDED.description;

CREATE OR REPLACE FUNCTION public.enforce_role_capability_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  selected_role_scope text;
  selected_capability_scope text;
BEGIN
  SELECT role.scope INTO selected_role_scope
  FROM public.roles role
  WHERE role.id = NEW.role_id;

  SELECT capability.scope INTO selected_capability_scope
  FROM public.capabilities capability
  WHERE capability.id = NEW.capability_id;

  IF selected_role_scope IS NULL
    OR selected_capability_scope IS NULL
    OR selected_role_scope <> selected_capability_scope
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'role_capability_scope_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_role_capability_scope()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER v4_enforce_role_capability_scope
  BEFORE INSERT OR UPDATE OF role_id, capability_id
  ON public.role_capabilities
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_role_capability_scope();

INSERT INTO public.role_capabilities (role_id, capability_id)
SELECT role.id, capability.id
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
ON CONFLICT (role_id, capability_id) DO NOTHING;

ALTER TABLE public.products
  ADD COLUMN organization_id uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.products product
    LEFT JOIN public.organizations organization
      ON organization.id = product.tenant_id
    WHERE product.tenant_id IS NOT NULL
      AND organization.id IS NULL
  ) THEN
    RAISE EXCEPTION 'product_tenant_reference_unresolved';
  END IF;
END
$$;

UPDATE public.products product
SET organization_id = product.tenant_id
WHERE product.tenant_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.organizations organization
    WHERE organization.id = product.tenant_id
  );

UPDATE public.products
SET organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
WHERE organization_id IS NULL
  AND tenant_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.products product
    LEFT JOIN public.organizations organization
      ON organization.id = product.organization_id
    WHERE organization.id IS NULL
  ) THEN
    RAISE EXCEPTION 'product_organization_backfill_unresolved';
  END IF;
END
$$;

UPDATE public.products
SET tenant_id = organization_id;

ALTER TABLE public.products
  ADD CONSTRAINT products_organization_id_fkey
    FOREIGN KEY (organization_id)
    REFERENCES public.organizations(id)
    ON DELETE RESTRICT
    NOT VALID,
  ADD CONSTRAINT products_tenant_matches_organization_check
    CHECK (tenant_id = organization_id)
    NOT VALID,
  ADD CONSTRAINT products_organization_id_id_unique
    UNIQUE (organization_id, id);

ALTER TABLE public.products
  VALIDATE CONSTRAINT products_organization_id_fkey;
ALTER TABLE public.products
  VALIDATE CONSTRAINT products_tenant_matches_organization_check;

CREATE INDEX products_organization_catalog_lookup_idx
  ON public.products (organization_id, is_active, category, name);

CREATE OR REPLACE FUNCTION public.enforce_product_organization_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.organization_id IS DISTINCT FROM OLD.organization_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_organization_is_immutable';
  END IF;

  IF NEW.organization_id IS NULL AND NEW.tenant_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_organization_context_required';
  ELSIF NEW.organization_id IS NULL THEN
    NEW.organization_id := NEW.tenant_id;
  ELSIF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := NEW.organization_id;
  ELSIF NEW.tenant_id IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'product_tenant_organization_mismatch';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_product_organization_context()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS v4_enforce_product_organization_context
  ON public.products;
CREATE TRIGGER v4_enforce_product_organization_context
  BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_product_organization_context();

CREATE OR REPLACE FUNCTION public.product_organization_context()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    public.requested_organization_id(),
    (
      SELECT CASE
        WHEN count(DISTINCT membership.organization_id) = 1
          THEN max(membership.organization_id::text)::uuid
        ELSE NULL
      END
      FROM public.memberships membership
      WHERE membership.user_id = auth.uid()
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
    )
  )
$$;

REVOKE ALL ON FUNCTION public.product_organization_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.product_organization_context()
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.product_capability_allowed(
  p_organization_id uuid,
  p_capability_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
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
     AND membership_role.revoked_at IS NULL
    JOIN public.role_capabilities role_capability
      ON role_capability.role_id = membership_role.role_id
    JOIN public.roles role ON role.id = membership_role.role_id
    JOIN public.capabilities capability
      ON capability.id = role_capability.capability_id
    WHERE organization.id = p_organization_id
      AND organization.status = 'active'
      AND profile.id = auth.uid()
      AND profile.is_active IS TRUE
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND role.scope = 'organization'
      AND capability.scope = 'organization'
      AND capability.capability_key = p_capability_key
  )
$$;

REVOKE ALL ON FUNCTION public.product_capability_allowed(uuid, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.product_payload_is_valid(p_product jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    jsonb_typeof(p_product) = 'object'
    AND jsonb_typeof(p_product -> 'name') = 'string'
    AND btrim(p_product ->> 'name') <> ''
    AND jsonb_typeof(p_product -> 'sku') = 'string'
    AND btrim(p_product ->> 'sku') <> ''
    AND CASE
      WHEN NOT (p_product ? 'unit_price')
        OR p_product -> 'unit_price' = 'null'::jsonb
      THEN true
      WHEN jsonb_typeof(p_product -> 'unit_price') = 'number'
      THEN (p_product ->> 'unit_price')::numeric >= 0
      ELSE false
    END
    AND CASE
      WHEN NOT (p_product ? 'is_active')
        OR p_product -> 'is_active' = 'null'::jsonb
      THEN true
      ELSE jsonb_typeof(p_product -> 'is_active') = 'boolean'
    END
    AND CASE
      WHEN NOT (p_product ? 'category')
        OR p_product -> 'category' = 'null'::jsonb
      THEN true
      WHEN jsonb_typeof(p_product -> 'category') = 'string'
      THEN lower(btrim(p_product ->> 'category')) IN (
        'knx', 'hvac', 'audio', 'network', 'security',
        'intercom', 'cable', 'service', 'lighting'
      )
      ELSE false
    END
    AND CASE
      WHEN NOT (p_product ? 'brand')
        OR p_product -> 'brand' = 'null'::jsonb
      THEN true
      ELSE jsonb_typeof(p_product -> 'brand') = 'string'
    END
    AND CASE
      WHEN NOT (p_product ? 'unit')
        OR p_product -> 'unit' = 'null'::jsonb
      THEN true
      ELSE jsonb_typeof(p_product -> 'unit') = 'string'
    END
    AND CASE
      WHEN NOT (p_product ? 'description')
        OR p_product -> 'description' = 'null'::jsonb
      THEN true
      ELSE jsonb_typeof(p_product -> 'description') = 'string'
    END
  ), false)
$$;

REVOKE ALL ON FUNCTION public.product_payload_is_valid(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_product_for_organization(
  p_organization_id uuid,
  p_product jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  inserted_product public.products;
BEGIN
  IF NOT public.product_capability_allowed(
    p_organization_id,
    'catalog.products.create'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'product_create_forbidden';
  END IF;

  IF p_product IS NULL OR jsonb_typeof(p_product) <> 'object' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_product_create_payload';
  END IF;

  IF octet_length(convert_to(p_product::text, 'UTF8')) > 65536
    OR NOT public.product_payload_is_valid(p_product)
    OR EXISTS (
      SELECT 1
      FROM jsonb_object_keys(p_product) AS item(key)
      WHERE item.key NOT IN (
        'name', 'sku', 'category', 'brand', 'unit', 'unit_price',
        'description', 'is_active'
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_product_create_payload';
  END IF;

  INSERT INTO public.products(
    organization_id, tenant_id, name, sku, category, brand, unit,
    unit_price, description, is_active
  ) VALUES (
    p_organization_id,
    p_organization_id,
    p_product ->> 'name',
    p_product ->> 'sku',
    p_product ->> 'category',
    p_product ->> 'brand',
    p_product ->> 'unit',
    COALESCE((p_product ->> 'unit_price')::numeric, 0),
    p_product ->> 'description',
    COALESCE((p_product ->> 'is_active')::boolean, true)
  )
  RETURNING * INTO inserted_product;

  RETURN to_jsonb(inserted_product);
END;
$$;

REVOKE ALL ON FUNCTION public.create_product_for_organization(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_product_for_organization(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.import_products_for_organization(
  p_organization_id uuid,
  p_products jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  product_payload jsonb;
  product_index bigint;
  created_count integer := 0;
  failed_indexes jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.product_capability_allowed(
    p_organization_id,
    'catalog.products.import'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'product_import_forbidden';
  END IF;

  IF p_products IS NULL OR jsonb_typeof(p_products) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_product_import_payload';
  END IF;

  IF jsonb_array_length(p_products) < 1
    OR jsonb_array_length(p_products) > 2000
    OR octet_length(convert_to(p_products::text, 'UTF8')) > 5242880
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid_product_import_payload';
  END IF;

  FOR product_payload, product_index IN
    SELECT item.value, item.ordinality
    FROM jsonb_array_elements(p_products) WITH ORDINALITY AS item(value, ordinality)
  LOOP
    IF jsonb_typeof(product_payload) <> 'object'
      OR EXISTS (
        SELECT 1
        FROM jsonb_object_keys(product_payload) AS item(key)
        WHERE item.key NOT IN (
          'name', 'sku', 'category', 'brand', 'unit', 'unit_price',
          'description', 'is_active'
        )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid_product_import_row';
    END IF;
  END LOOP;

  FOR product_payload, product_index IN
    SELECT item.value, item.ordinality
    FROM jsonb_array_elements(p_products) WITH ORDINALITY AS item(value, ordinality)
  LOOP
    IF NOT public.product_payload_is_valid(product_payload) THEN
      failed_indexes := failed_indexes || jsonb_build_array(product_index - 1);
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.products(
        organization_id, tenant_id, name, sku, category, brand, unit,
        unit_price, description, is_active
      ) VALUES (
        p_organization_id,
        p_organization_id,
        product_payload ->> 'name',
        product_payload ->> 'sku',
        product_payload ->> 'category',
        product_payload ->> 'brand',
        product_payload ->> 'unit',
        COALESCE((product_payload ->> 'unit_price')::numeric, 0),
        product_payload ->> 'description',
        COALESCE((product_payload ->> 'is_active')::boolean, true)
      );
      created_count := created_count + 1;
    EXCEPTION
      WHEN check_violation
        OR unique_violation
        OR not_null_violation
        OR invalid_text_representation
        OR numeric_value_out_of_range
      THEN
        failed_indexes := failed_indexes || jsonb_build_array(product_index - 1);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'created', created_count,
    'failed_indexes', failed_indexes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.import_products_for_organization(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_products_for_organization(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.security_definer_rpc_allowlist_gate()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
  WITH expected(regprocedure) AS (
    VALUES
      ('create_product_for_organization(uuid,jsonb)'),
      ('delete_lead_atomic(uuid,uuid)'),
      ('get_my_role()'),
      ('import_products_for_organization(uuid,jsonb)'),
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
    'gate_version', 'sam78-product-rpc-allowlist-v4',
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

DROP POLICY IF EXISTS products_admin_all ON public.products;
DROP POLICY IF EXISTS products_sales_select ON public.products;
DROP POLICY IF EXISTS products_select_all ON public.products;
DROP POLICY IF EXISTS products_insert_admin_boss ON public.products;
DROP POLICY IF EXISTS products_update_admin_boss ON public.products;
DROP POLICY IF EXISTS products_delete_admin_boss ON public.products;
DROP POLICY IF EXISTS products_auth_all ON public.products;
DROP POLICY IF EXISTS products_all_select ON public.products;
DROP POLICY IF EXISTS products_all_insert ON public.products;
DROP POLICY IF EXISTS products_all_update ON public.products;
DROP POLICY IF EXISTS products_all_delete ON public.products;
DROP POLICY IF EXISTS products_for_all ON public.products;
DROP POLICY IF EXISTS "Default deny all" ON public.products;
DROP POLICY IF EXISTS policy_products_select_all ON public.products;
DROP POLICY IF EXISTS policy_products_select_admin ON public.products;
DROP POLICY IF EXISTS policy_products_select_finance ON public.products;
DROP POLICY IF EXISTS policy_products_select_designer ON public.products;
DROP POLICY IF EXISTS policy_products_select_sales ON public.products;
DROP POLICY IF EXISTS policy_products_insert_admin ON public.products;
DROP POLICY IF EXISTS policy_products_update_admin ON public.products;
DROP POLICY IF EXISTS policy_products_delete_admin ON public.products;
DROP POLICY IF EXISTS products_insert_designer ON public.products;
DROP POLICY IF EXISTS products_update_designer ON public.products;
DROP POLICY IF EXISTS products_delete_designer ON public.products;

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.products FROM PUBLIC, anon, authenticated;
GRANT SELECT, UPDATE, DELETE ON TABLE public.products
  TO authenticated;
GRANT ALL ON TABLE public.products TO service_role;

CREATE POLICY v4_products_capability_read
  ON public.products
  FOR SELECT
  TO authenticated
  USING (
    organization_id = (SELECT public.product_organization_context())
    AND EXISTS (
      SELECT 1
      FROM public.organizations organization
      JOIN public.memberships membership
        ON membership.organization_id = organization.id
      JOIN public.profiles profile ON membership.user_id = profile.id
      JOIN public.membership_roles membership_role
        ON membership_role.membership_id = membership.id
       AND membership_role.revoked_at IS NULL
      JOIN public.role_capabilities role_capability
        ON role_capability.role_id = membership_role.role_id
      JOIN public.roles role ON role.id = membership_role.role_id
      JOIN public.capabilities capability
        ON capability.id = role_capability.capability_id
      WHERE organization.id = products.organization_id
        AND organization.status IN ('active', 'read_only')
        AND profile.id = (SELECT auth.uid())
        AND profile.is_active IS TRUE
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
        AND role.scope = 'organization'
        AND capability.scope = 'organization'
        AND capability.capability_key = 'catalog.products.read'
    )
  );

CREATE POLICY v4_products_capability_insert
  ON public.products
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (SELECT public.product_organization_context())
    AND EXISTS (
      SELECT 1
      FROM public.organizations organization
      JOIN public.memberships membership
        ON membership.organization_id = organization.id
      JOIN public.profiles profile ON profile.id = membership.user_id
      JOIN public.membership_roles membership_role
        ON membership_role.membership_id = membership.id
       AND membership_role.revoked_at IS NULL
      JOIN public.role_capabilities role_capability
        ON role_capability.role_id = membership_role.role_id
      JOIN public.roles role ON role.id = membership_role.role_id
      JOIN public.capabilities capability
        ON capability.id = role_capability.capability_id
      WHERE organization.id = products.organization_id
        AND organization.status = 'active'
        AND profile.id = (SELECT auth.uid())
        AND profile.is_active IS TRUE
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
        AND role.scope = 'organization'
        AND capability.scope = 'organization'
        AND capability.capability_key = 'catalog.products.create'
    )
  );

CREATE POLICY v4_products_capability_update
  ON public.products
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = (SELECT public.product_organization_context())
    AND EXISTS (
      SELECT 1
      FROM public.organizations organization
      JOIN public.memberships membership
        ON membership.organization_id = organization.id
      JOIN public.profiles profile ON profile.id = membership.user_id
      JOIN public.membership_roles membership_role
        ON membership_role.membership_id = membership.id
       AND membership_role.revoked_at IS NULL
      JOIN public.role_capabilities role_capability
        ON role_capability.role_id = membership_role.role_id
      JOIN public.roles role ON role.id = membership_role.role_id
      JOIN public.capabilities capability
        ON capability.id = role_capability.capability_id
      WHERE organization.id = products.organization_id
        AND organization.status = 'active'
        AND profile.id = (SELECT auth.uid())
        AND profile.is_active IS TRUE
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
        AND role.scope = 'organization'
        AND capability.scope = 'organization'
        AND capability.capability_key = 'catalog.products.update'
    )
  )
  WITH CHECK (
    organization_id = (SELECT public.product_organization_context())
    AND EXISTS (
      SELECT 1
      FROM public.organizations organization
      JOIN public.memberships membership
        ON membership.organization_id = organization.id
      JOIN public.profiles profile ON profile.id = membership.user_id
      JOIN public.membership_roles membership_role
        ON membership_role.membership_id = membership.id
       AND membership_role.revoked_at IS NULL
      JOIN public.role_capabilities role_capability
        ON role_capability.role_id = membership_role.role_id
      JOIN public.roles role ON role.id = membership_role.role_id
      JOIN public.capabilities capability
        ON capability.id = role_capability.capability_id
      WHERE organization.id = products.organization_id
        AND organization.status = 'active'
        AND profile.id = (SELECT auth.uid())
        AND profile.is_active IS TRUE
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
        AND role.scope = 'organization'
        AND capability.scope = 'organization'
        AND capability.capability_key = 'catalog.products.update'
    )
  );

CREATE POLICY v4_products_capability_delete
  ON public.products
  FOR DELETE
  TO authenticated
  USING (
    organization_id = (SELECT public.product_organization_context())
    AND EXISTS (
      SELECT 1
      FROM public.organizations organization
      JOIN public.memberships membership
        ON membership.organization_id = organization.id
      JOIN public.profiles profile ON profile.id = membership.user_id
      JOIN public.membership_roles membership_role
        ON membership_role.membership_id = membership.id
       AND membership_role.revoked_at IS NULL
      JOIN public.role_capabilities role_capability
        ON role_capability.role_id = membership_role.role_id
      JOIN public.roles role ON role.id = membership_role.role_id
      JOIN public.capabilities capability
        ON capability.id = role_capability.capability_id
      WHERE organization.id = products.organization_id
        AND organization.status = 'active'
        AND profile.id = (SELECT auth.uid())
        AND profile.is_active IS TRUE
        AND membership.status = 'active'
        AND membership.accepted_at IS NOT NULL
        AND role.scope = 'organization'
        AND capability.scope = 'organization'
        AND capability.capability_key = 'catalog.products.delete'
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
