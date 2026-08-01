\set ON_ERROR_STOP on

INSERT INTO auth.users(id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003'),
  ('10000000-0000-4000-8000-000000000004'),
  ('10000000-0000-4000-8000-000000000005');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('10000000-0000-4000-8000-000000000001', 'boss', true),
  ('10000000-0000-4000-8000-000000000002', 'admin', true),
  ('10000000-0000-4000-8000-000000000003', 'sales', true),
  ('10000000-0000-4000-8000-000000000004', 'finance', true),
  ('10000000-0000-4000-8000-000000000005', 'designer', false);

SET ROLE service_role;

CREATE TEMP TABLE commercial_p0_ids (
  key text PRIMARY KEY,
  value uuid NOT NULL
);

DO $$
DECLARE
  result jsonb;
  plan text;
  limit_value integer;
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.provision_organization_member(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.provision_organization_member(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.provision_organization_member(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'member provisioning RPC privilege boundary mismatch';
  END IF;

  IF (
    SELECT pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
    FROM pg_attrdef attribute_default
    JOIN pg_attribute attribute
      ON attribute.attrelid = attribute_default.adrelid
     AND attribute.attnum = attribute_default.adnum
    WHERE attribute_default.adrelid = 'public.organizations'::regclass
      AND attribute.attname = 'billable_seat_limit'
  ) <> '3' THEN
    RAISE EXCEPTION 'organization default seat limit is not 3';
  END IF;

  FOR plan, limit_value IN
    SELECT tier.plan_key, tier.seat_limit
    FROM (VALUES
      ('starter', 3), ('starter', 4),
      ('growth', 10), ('growth', 11),
      ('scale', 25), ('scale', 26)
    ) AS tier(plan_key, seat_limit)
  LOOP
    result := public.initialize_organization(
      format('commercial:p0:%s:%s', plan, limit_value),
      format('commercial-p0-%s-%s', plan, limit_value),
      format('Commercial P0 %s %s', plan, limit_value),
      'real_estate',
      plan,
      limit_value,
      '10000000-0000-4000-8000-000000000001'
    );
    INSERT INTO commercial_p0_ids(key, value) VALUES
      (format('org_%s_%s', plan, limit_value), (result ->> 'organization_id')::uuid),
      (format('membership_%s_%s', plan, limit_value), (result ->> 'owner_membership_id')::uuid);
  END LOOP;

  FOR plan, limit_value IN
    SELECT tier.plan_key, tier.seat_limit
    FROM (VALUES
      ('starter', 2), ('growth', 9), ('scale', 24)
    ) AS tier(plan_key, seat_limit)
  LOOP
    BEGIN
      PERFORM public.initialize_organization(
        format('commercial:p0:invalid:%s:%s', plan, limit_value),
        format('commercial-p0-invalid-%s-%s', plan, limit_value),
        'Commercial P0 invalid tier',
        'real_estate',
        plan,
        limit_value,
        '10000000-0000-4000-8000-000000000001'
      );
      RAISE EXCEPTION 'below-base seat tier accepted';
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM <> 'invalid_organization_plan_seat_limit' THEN
          RAISE;
        END IF;
    END;
  END LOOP;
END;
$$;

DO $$
DECLARE
  target_organization_id uuid := (
    SELECT value FROM commercial_p0_ids WHERE key = 'org_starter_3'
  );
  inviter_membership_id uuid := (
    SELECT value FROM commercial_p0_ids WHERE key = 'membership_starter_3'
  );
  admin_result jsonb;
  sales_result jsonb;
  count_value integer;
BEGIN
  admin_result := public.provision_organization_member(
    target_organization_id,
    '10000000-0000-4000-8000-000000000002',
    'admin',
    inviter_membership_id,
    'commercial-p0-admin-member'
  );
  sales_result := public.provision_organization_member(
    target_organization_id,
    '10000000-0000-4000-8000-000000000003',
    'sales',
    inviter_membership_id,
    'commercial-p0-sales-member'
  );

  IF admin_result ->> 'organization_role' <> 'org_admin'
    OR sales_result ->> 'organization_role' <> 'sales_agent'
  THEN
    RAISE EXCEPTION 'legacy profile role mapping mismatch';
  END IF;
  IF public.organization_billable_seat_count(target_organization_id) <> 3 THEN
    RAISE EXCEPTION 'starter base seat count mismatch';
  END IF;

  BEGIN
    PERFORM public.provision_organization_member(
      target_organization_id,
      '10000000-0000-4000-8000-000000000004',
      'finance',
      inviter_membership_id,
      'commercial-p0-overflow-member'
    );
    RAISE EXCEPTION 'seat overflow provisioning accepted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <> 'billable_seat_limit_reached' THEN
        RAISE;
      END IF;
  END;

  SELECT count(*) INTO count_value
  FROM public.memberships
  WHERE organization_id = target_organization_id
    AND user_id = '10000000-0000-4000-8000-000000000004';
  IF count_value <> 0 THEN
    RAISE EXCEPTION 'failed seat provisioning left membership residue';
  END IF;

  BEGIN
    PERFORM public.provision_organization_member(
      (SELECT value FROM commercial_p0_ids WHERE key = 'org_growth_10'),
      '10000000-0000-4000-8000-000000000004',
      'finance',
      inviter_membership_id,
      'commercial-p0-cross-org-grant'
    );
    RAISE EXCEPTION 'cross-organization grantor accepted';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'organization_admin_membership_required' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.provision_organization_member(
      target_organization_id,
      '10000000-0000-4000-8000-000000000005',
      'designer',
      inviter_membership_id,
      'commercial-p0-inactive-member'
    );
    RAISE EXCEPTION 'inactive profile provisioning accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'active_profile_role_mismatch' THEN
        RAISE;
      END IF;
  END;

  IF (
    SELECT count(*)
    FROM public.audit_events
    WHERE organization_id = target_organization_id
      AND action = 'organization_membership_role_created'
      AND request_id IN (
        'commercial-p0-admin-member',
        'commercial-p0-sales-member'
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'atomic membership audit count mismatch';
  END IF;
END;
$$;

DELETE FROM public.audit_events
WHERE organization_id IN (SELECT value FROM commercial_p0_ids WHERE key LIKE 'org_%');
DELETE FROM public.organization_provisioning_requests
WHERE idempotency_key LIKE 'commercial:p0:%';
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT membership.id
  FROM public.memberships membership
  WHERE membership.organization_id IN (
    SELECT value FROM commercial_p0_ids WHERE key LIKE 'org_%'
  )
);
DELETE FROM public.memberships
WHERE organization_id IN (SELECT value FROM commercial_p0_ids WHERE key LIKE 'org_%');
DELETE FROM public.organizations
WHERE id IN (SELECT value FROM commercial_p0_ids WHERE key LIKE 'org_%');

RESET ROLE;

DELETE FROM public.profiles
WHERE id::text LIKE '10000000-0000-4000-8000-00000000000%';
DELETE FROM auth.users
WHERE id::text LIKE '10000000-0000-4000-8000-00000000000%';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE slug LIKE 'commercial-p0-%'
  ) OR EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id::text LIKE '10000000-0000-4000-8000-00000000000%'
  ) OR EXISTS (
    SELECT 1 FROM public.organization_provisioning_requests
    WHERE idempotency_key LIKE 'commercial:p0:%'
  ) THEN
    RAISE EXCEPTION 'commercial P0 fixture cleanup failed';
  END IF;
END;
$$;

SELECT 'Commercial P0 seat tiers and atomic member roles passed' AS result;
