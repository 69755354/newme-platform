\set ON_ERROR_STOP on

INSERT INTO auth.users(id) VALUES
  ('78000000-0000-4000-8000-000000000001'),
  ('78000000-0000-4000-8000-000000000002');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('78000000-0000-4000-8000-000000000001', 'admin', true),
  ('78000000-0000-4000-8000-000000000002', 'sales', true);

SET ROLE service_role;

CREATE TEMP TABLE v4_capability_ids (
  key text PRIMARY KEY,
  value uuid NOT NULL
);

DO $$
DECLARE
  org_a jsonb;
  org_b jsonb;
  viewer_role_id uuid;
  platform_role_id uuid;
  platform_capability_id uuid;
BEGIN
  org_a := public.initialize_organization(
    'v4:capability:org-a',
    'v4-capability-org-a',
    'V4 Capability Organization A',
    'real_estate',
    'starter',
    3,
    '78000000-0000-4000-8000-000000000001'
  );
  org_b := public.initialize_organization(
    'v4:capability:org-b',
    'v4-capability-org-b',
    'V4 Capability Organization B',
    'retail',
    'starter',
    3,
    '78000000-0000-4000-8000-000000000002'
  );

  INSERT INTO v4_capability_ids(key, value) VALUES
    ('org_a', (org_a ->> 'organization_id')::uuid),
    ('org_a_admin', (org_a ->> 'owner_membership_id')::uuid),
    ('org_b', (org_b ->> 'organization_id')::uuid);

  PERFORM public.provision_organization_member(
    (org_b ->> 'organization_id')::uuid,
    '78000000-0000-4000-8000-000000000001',
    'admin',
    (org_b ->> 'owner_membership_id')::uuid,
    'v4-capability-cross-org-member'
  );

  SELECT role.id INTO viewer_role_id
  FROM public.roles role
  WHERE role.scope = 'organization' AND role.role_key = 'viewer';

  UPDATE public.membership_roles membership_role
  SET revoked_at = now()
  FROM public.memberships membership
  WHERE membership_role.membership_id = membership.id
    AND membership.organization_id = (org_b ->> 'organization_id')::uuid
    AND membership.user_id = '78000000-0000-4000-8000-000000000001';
  INSERT INTO public.membership_roles(membership_id, role_id)
  SELECT membership.id, viewer_role_id
  FROM public.memberships membership
  WHERE membership.organization_id = (org_b ->> 'organization_id')::uuid
    AND membership.user_id = '78000000-0000-4000-8000-000000000001';

  INSERT INTO public.roles(
    role_key, scope, display_name, is_billable, can_write_business_data
  ) VALUES ('v4_test_platform', 'platform', 'V4 test platform', false, false)
  RETURNING id INTO platform_role_id;

  INSERT INTO public.capabilities(
    capability_key, scope, description
  ) VALUES (
    'catalog.products.manage',
    'platform',
    'V4 scope mismatch fixture'
  ) RETURNING id INTO platform_capability_id;

  BEGIN
    INSERT INTO public.role_capabilities(role_id, capability_id)
    VALUES (viewer_role_id, platform_capability_id);
    RAISE EXCEPTION 'platform capability was assigned to organization role';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <> 'role_capability_scope_mismatch' THEN
        RAISE;
      END IF;
  END;
END
$$;

RESET ROLE;
SELECT value::text AS v4_org_a
FROM v4_capability_ids WHERE key = 'org_a'
\gset
SELECT value::text AS v4_org_b
FROM v4_capability_ids WHERE key = 'org_b'
\gset
SELECT set_config('v4.org_a', :'v4_org_a', false);
SELECT set_config('v4.org_b', :'v4_org_b', false);

-- Headerless reads remain safe for a caller with exactly one membership.
-- Authenticated writes use bounded RPCs and never rely on direct table INSERT.
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000002';
SELECT set_config('request.headers', '{}'::jsonb::text, false);

SELECT public.create_product_for_organization(
  :'v4_org_b'::uuid,
  jsonb_build_object(
    'sku', 'V4-CAPABILITY-PRODUCT-B',
    'name', 'V4 Capability Product B',
    'unit_price', 200
  )
);

DO $$
BEGIN
  IF (SELECT count(*) FROM public.products
      WHERE sku = 'V4-CAPABILITY-PRODUCT-B') <> 1 THEN
    RAISE EXCEPTION 'single-membership headerless compatibility failed';
  END IF;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000001';
SELECT set_config('request.headers', '{}'::jsonb::text, false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.products
    WHERE sku = 'V4-CAPABILITY-PRODUCT-B'
  ) THEN
    RAISE EXCEPTION 'multi-membership headerless request was not denied';
  END IF;
END
$$;

SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', :'v4_org_a')::text,
  false
);

SELECT public.create_product_for_organization(
  :'v4_org_a'::uuid,
  jsonb_build_object(
    'sku', 'V4-CAPABILITY-PRODUCT-A',
    'name', 'V4 Capability Product A',
    'unit_price', 100
  )
);

RESET ROLE;
SET ROLE service_role;
UPDATE public.organizations SET status = 'read_only'
WHERE id = :'v4_org_a'::uuid;
RESET ROLE;
SET ROLE authenticated;

DO $$
DECLARE
  visible_count integer;
  org_a uuid := current_setting('v4.org_a')::uuid;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.products
  WHERE sku = 'V4-CAPABILITY-PRODUCT-A';
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'read_only organization catalog was not readable';
  END IF;

  BEGIN
    PERFORM public.create_product_for_organization(
      org_a,
      jsonb_build_object(
        'sku', 'V4-READ-ONLY-WRITE',
        'name', 'V4 read-only write denial',
        'unit_price', 1
      )
    );
    RAISE EXCEPTION 'read_only organization product write was accepted';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END
$$;

RESET ROLE;
SET ROLE service_role;
UPDATE public.organizations SET status = 'suspended'
WHERE id = :'v4_org_a'::uuid;
RESET ROLE;
SET ROLE authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.products
    WHERE sku = 'V4-CAPABILITY-PRODUCT-A'
  ) THEN
    RAISE EXCEPTION 'suspended organization catalog remained readable';
  END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
UPDATE public.organizations SET status = 'closed', closed_at = now()
WHERE id = :'v4_org_a'::uuid;
RESET ROLE;
SET ROLE authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.products
    WHERE sku = 'V4-CAPABILITY-PRODUCT-A'
  ) THEN
    RAISE EXCEPTION 'closed organization catalog remained readable';
  END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
UPDATE public.organizations SET status = 'active', closed_at = NULL
WHERE id = :'v4_org_a'::uuid;
RESET ROLE;
SET ROLE authenticated;

SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', :'v4_org_b')::text,
  false
);

DO $$
DECLARE
  visible_count integer;
  org_b uuid := current_setting('v4.org_b')::uuid;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.products
  WHERE sku = 'V4-CAPABILITY-PRODUCT-A';
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'cross-organization product was visible';
  END IF;

  BEGIN
    PERFORM public.create_product_for_organization(
      org_b,
      jsonb_build_object(
        'sku', 'V4-VIEWER-WRITE',
        'name', 'V4 viewer write denial',
        'unit_price', 1
      )
    );
    RAISE EXCEPTION 'viewer product write was accepted';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END
$$;

RESET ROLE;
SET ROLE service_role;

UPDATE public.membership_roles membership_role
SET revoked_at = now()
FROM public.memberships membership
WHERE membership_role.membership_id = membership.id
  AND membership.organization_id = :'v4_org_b'::uuid
  AND membership.user_id = '78000000-0000-4000-8000-000000000001'
  AND membership_role.revoked_at IS NULL;
INSERT INTO public.membership_roles(membership_id, role_id)
SELECT membership.id, role.id
FROM public.memberships membership
JOIN public.roles role
  ON role.scope = 'organization' AND role.role_key = 'operations'
WHERE membership.organization_id = :'v4_org_b'::uuid
  AND membership.user_id = '78000000-0000-4000-8000-000000000001';

RESET ROLE;
SET ROLE authenticated;

SELECT public.create_product_for_organization(
  :'v4_org_b'::uuid,
  jsonb_build_object(
    'sku', 'V4-OPERATIONS-PRODUCT',
    'name', 'V4 operations product',
    'unit_price', 10
  )
);

DO $$
BEGIN
  BEGIN
    PERFORM public.create_product_for_organization(
      current_setting('v4.org_b')::uuid,
      jsonb_build_object(
        'sku', '   ',
        'name', '',
        'unit_price', -1,
        'is_active', 'yes'
      )
    );
    RAISE EXCEPTION 'invalid product create payload was accepted';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      IF SQLERRM <> 'invalid_product_create_payload' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO public.products(
      organization_id, tenant_id, sku, name, unit_price
    ) VALUES (
      current_setting('v4.org_b')::uuid,
      current_setting('v4.org_b')::uuid,
      'V4-DIRECT-DATA-API-BYPASS',
      'V4 direct Data API bypass',
      1
    );
    RAISE EXCEPTION 'authenticated direct product insert was accepted';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  BEGIN
    PERFORM public.import_products_for_organization(
      current_setting('v4.org_b')::uuid,
      jsonb_build_array(
        jsonb_build_object(
          'sku', 'V4-OPERATIONS-IMPORT-BYPASS',
          'name', 'V4 operations import bypass',
          'unit_price', 1
        )
      )
    );
    RAISE EXCEPTION 'create-only role invoked product import';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'product_import_forbidden' THEN
        RAISE;
      END IF;
  END;
END
$$;

UPDATE public.products
SET name = 'V4 operations product updated'
WHERE sku = 'V4-OPERATIONS-PRODUCT';

DO $$
DECLARE
  affected integer;
BEGIN
  WITH deleted AS (
    DELETE FROM public.products
    WHERE sku = 'V4-OPERATIONS-PRODUCT'
    RETURNING id
  ) SELECT count(*) INTO affected FROM deleted;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'operations role deleted a product';
  END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;

UPDATE public.membership_roles membership_role
SET revoked_at = now()
FROM public.memberships membership
WHERE membership_role.membership_id = membership.id
  AND membership.organization_id = :'v4_org_b'::uuid
  AND membership.user_id = '78000000-0000-4000-8000-000000000001'
  AND membership_role.revoked_at IS NULL;
INSERT INTO public.membership_roles(membership_id, role_id)
SELECT membership.id, role.id
FROM public.memberships membership
JOIN public.roles role
  ON role.scope = 'organization' AND role.role_key = 'specialist'
WHERE membership.organization_id = :'v4_org_b'::uuid
  AND membership.user_id = '78000000-0000-4000-8000-000000000001';

RESET ROLE;
SET ROLE authenticated;

DO $$
DECLARE
  affected integer;
BEGIN
  BEGIN
    PERFORM public.create_product_for_organization(
      current_setting('v4.org_b')::uuid,
      jsonb_build_object(
        'sku', 'V4-SPECIALIST-WRITE',
        'name', 'V4 specialist write denial',
        'unit_price', 1
      )
    );
    RAISE EXCEPTION 'specialist product insert was accepted';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;

  WITH changed AS (
    UPDATE public.products SET name = 'specialist changed'
    WHERE sku = 'V4-OPERATIONS-PRODUCT'
    RETURNING id
  ) SELECT count(*) INTO affected FROM changed;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'specialist product update was accepted';
  END IF;

  WITH deleted AS (
    DELETE FROM public.products
    WHERE sku = 'V4-OPERATIONS-PRODUCT'
    RETURNING id
  ) SELECT count(*) INTO affected FROM deleted;
  IF affected <> 0 THEN
    RAISE EXCEPTION 'specialist product delete was accepted';
  END IF;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000002';

DO $$
DECLARE
  affected integer;
BEGIN
  WITH deleted AS (
    DELETE FROM public.products
    WHERE sku = 'V4-OPERATIONS-PRODUCT'
    RETURNING id
  ) SELECT count(*) INTO affected FROM deleted;
  IF affected <> 1 THEN
    RAISE EXCEPTION 'organization owner product delete failed';
  END IF;
END
$$;

RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.headers;
SET ROLE service_role;

-- Add the exact org-admin capability needed by the import RPC, then prove the
-- database boundary enforces the same row-count/payload authorization surface.
INSERT INTO public.membership_roles(membership_id, role_id)
SELECT membership.id, role.id
FROM public.memberships membership
JOIN public.roles role
  ON role.scope = 'organization' AND role.role_key = 'org_admin'
WHERE membership.organization_id = :'v4_org_a'::uuid
  AND membership.user_id = '78000000-0000-4000-8000-000000000001'
ON CONFLICT (membership_id, role_id) WHERE revoked_at IS NULL DO UPDATE
SET revoked_at = NULL;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '78000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.import_products_for_organization(
    current_setting('v4.org_a')::uuid,
    jsonb_build_array(
      jsonb_build_object(
        'sku', 'V4-ORG-ADMIN-IMPORT',
        'name', 'V4 org admin import',
        'unit_price', 25
      ),
      jsonb_build_object(
        'sku', 'V4-INVALID-NEGATIVE-PRICE',
        'name', 'V4 invalid negative price',
        'unit_price', -1
      ),
      jsonb_build_object(
        'sku', 'V4-INVALID-BOOLEAN',
        'name', 'V4 invalid boolean',
        'unit_price', 1,
        'is_active', 'yes'
      ),
      jsonb_build_object(
        'sku', 'V4-INVALID-CATEGORY',
        'name', 'V4 invalid category',
        'unit_price', 1,
        'category', 'unreviewed-category'
      )
    )
  );
  IF result <> '{"created": 1, "failed_indexes": [1, 2, 3]}'::jsonb THEN
    RAISE EXCEPTION 'org-admin product import result mismatch: %', result;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.products
    WHERE sku IN (
      'V4-INVALID-NEGATIVE-PRICE',
      'V4-INVALID-BOOLEAN',
      'V4-INVALID-CATEGORY'
    )
  ) THEN
    RAISE EXCEPTION 'invalid product import row was persisted';
  END IF;
END
$$;

RESET ROLE;
RESET request.jwt.claim.sub;
SET ROLE service_role;

DO $$
DECLARE
  org_a uuid := (SELECT value FROM v4_capability_ids WHERE key = 'org_a');
  org_b uuid := (SELECT value FROM v4_capability_ids WHERE key = 'org_b');
  org_a_import integer;
  org_b_write integer;
  org_b_read integer;
BEGIN
  SELECT count(*) INTO org_a_import
  FROM public.memberships membership
  JOIN public.membership_roles membership_role
    ON membership_role.membership_id = membership.id
   AND membership_role.revoked_at IS NULL
  JOIN public.role_capabilities role_capability
    ON role_capability.role_id = membership_role.role_id
  JOIN public.capabilities capability
    ON capability.id = role_capability.capability_id
  WHERE membership.organization_id = org_a
    AND membership.user_id = '78000000-0000-4000-8000-000000000001'
    AND membership.status = 'active'
    AND membership.accepted_at IS NOT NULL
    AND capability.capability_key = 'catalog.products.import';

  SELECT
    count(*) FILTER (
      WHERE capability.capability_key IN (
        'catalog.products.create',
        'catalog.products.update',
        'catalog.products.delete',
        'catalog.products.import'
      )
    ),
    count(*) FILTER (
      WHERE capability.capability_key = 'catalog.products.read'
    )
  INTO org_b_write, org_b_read
  FROM public.memberships membership
  JOIN public.membership_roles membership_role
    ON membership_role.membership_id = membership.id
   AND membership_role.revoked_at IS NULL
  JOIN public.role_capabilities role_capability
    ON role_capability.role_id = membership_role.role_id
  JOIN public.capabilities capability
    ON capability.id = role_capability.capability_id
  WHERE membership.organization_id = org_b
    AND membership.user_id = '78000000-0000-4000-8000-000000000001'
    AND membership.status = 'active'
    AND membership.accepted_at IS NOT NULL;

  IF org_a_import <> 1 OR org_b_write <> 0 OR org_b_read <> 1 THEN
    RAISE EXCEPTION
      'multi-organization capability intersection mismatch: %, %, %',
      org_a_import, org_b_write, org_b_read;
  END IF;

  UPDATE public.memberships
  SET status = 'inactive', deactivated_at = now()
  WHERE organization_id = org_a
    AND user_id = '78000000-0000-4000-8000-000000000001';

  IF EXISTS (
    SELECT 1
    FROM public.memberships membership
    JOIN public.membership_roles membership_role
      ON membership_role.membership_id = membership.id
     AND membership_role.revoked_at IS NULL
    JOIN public.role_capabilities role_capability
      ON role_capability.role_id = membership_role.role_id
    JOIN public.capabilities capability
      ON capability.id = role_capability.capability_id
    WHERE membership.organization_id = org_a
      AND membership.user_id = '78000000-0000-4000-8000-000000000001'
      AND membership.status = 'active'
      AND membership.accepted_at IS NOT NULL
      AND capability.capability_key = 'catalog.products.import'
  ) THEN
    RAISE EXCEPTION 'inactive membership retained management capability';
  END IF;
END
$$;

DELETE FROM public.audit_events
WHERE organization_id IN (SELECT value FROM v4_capability_ids WHERE key LIKE 'org_%');
DELETE FROM public.products
WHERE sku IN (
  'V4-CAPABILITY-PRODUCT-A',
  'V4-CAPABILITY-PRODUCT-B',
  'V4-ORG-ADMIN-IMPORT'
);
DELETE FROM public.organization_provisioning_requests
WHERE idempotency_key LIKE 'v4:capability:%';
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT membership.id
  FROM public.memberships membership
  WHERE membership.organization_id IN (
    SELECT value FROM v4_capability_ids WHERE key IN ('org_a', 'org_b')
  )
);
DELETE FROM public.memberships
WHERE organization_id IN (
  SELECT value FROM v4_capability_ids WHERE key IN ('org_a', 'org_b')
);
DELETE FROM public.organizations
WHERE id IN (
  SELECT value FROM v4_capability_ids WHERE key IN ('org_a', 'org_b')
);
DELETE FROM public.roles
WHERE scope = 'platform' AND role_key = 'v4_test_platform';
DELETE FROM public.capabilities
WHERE scope = 'platform' AND capability_key = 'catalog.products.manage';

RESET ROLE;

DELETE FROM public.profiles
WHERE id IN (
  '78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000002'
);
DELETE FROM auth.users
WHERE id IN (
  '78000000-0000-4000-8000-000000000001',
  '78000000-0000-4000-8000-000000000002'
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations WHERE slug LIKE 'v4-capability-%'
  ) OR EXISTS (
    SELECT 1 FROM public.roles WHERE role_key = 'v4_test_platform'
  ) THEN
    RAISE EXCEPTION 'V4 capability fixture cleanup failed';
  END IF;
END
$$;

SELECT 'V4 tenant capability boundary passed' AS result;
