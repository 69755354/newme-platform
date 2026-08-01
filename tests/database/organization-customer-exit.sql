\set ON_ERROR_STOP on

CREATE TEMP TABLE exit_fixture_ids (
  key text PRIMARY KEY,
  value text NOT NULL
);
GRANT ALL ON TABLE exit_fixture_ids TO service_role;

INSERT INTO auth.users(id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003');
INSERT INTO public.profiles(id, role, is_active, full_name, email) VALUES
  ('10000000-0000-4000-8000-000000000001', 'admin', true,
   'Synthetic Owner', 'owner@sam-exit.invalid.test'),
  ('10000000-0000-4000-8000-000000000002', 'admin', true,
   'Synthetic Operator', 'operator@sam-exit.invalid.test'),
  ('10000000-0000-4000-8000-000000000003', 'admin', true,
   'Synthetic Approver', 'approver@sam-exit.invalid.test');
INSERT INTO public.platform_staff(id, user_id, status, staff_ref) VALUES
  ('20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000002', 'active', 'SAM-EXIT-OP'),
  ('20000000-0000-4000-8000-000000000003',
   '10000000-0000-4000-8000-000000000003', 'active', 'SAM-EXIT-APP');

SET ROLE service_role;

DO $$
DECLARE
  provisioned jsonb;
  prepared jsonb;
BEGIN
  provisioned := public.initialize_organization(
    'sam-exit-org-0001', 'sam-exit-org-0001', 'SAM Exit Synthetic Org',
    'real_estate', 'starter', 3,
    '10000000-0000-4000-8000-000000000001'
  );
  INSERT INTO exit_fixture_ids(key, value) VALUES
    ('organization_id', provisioned ->> 'organization_id'),
    ('membership_id', provisioned ->> 'owner_membership_id');

  prepared := public.prepare_organization_customer_exit(
    (provisioned ->> 'organization_id')::uuid,
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'sam-exit-request-0001',
    'Synthetic customer requested a controlled account exit',
    'sam-exit-prepare-request-0001'
  );
  IF prepared ->> 'organization_status' <> 'read_only' THEN
    RAISE EXCEPTION 'exit prepare did not enter read_only';
  END IF;
  INSERT INTO exit_fixture_ids(key, value)
  VALUES ('exit_request_id', prepared ->> 'exit_request_id');
END
$$;

DO $$
BEGIN
  BEGIN
    INSERT INTO public.leads(organization_id, source)
    VALUES (
      (SELECT value::uuid FROM exit_fixture_ids
       WHERE key = 'organization_id'),
      'sam-exit-forbidden'
    );
    RAISE EXCEPTION 'read-only organization accepted a business write';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'organization_is_not_writable' THEN RAISE; END IF;
  END;
END
$$;

UPDATE public.organizations
SET status = 'active'
WHERE id = (SELECT value::uuid FROM exit_fixture_ids
            WHERE key = 'organization_id');
INSERT INTO public.leads(id, organization_id, source, notes)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  (SELECT value::uuid FROM exit_fixture_ids WHERE key = 'organization_id'),
  'sam-exit-synthetic', 'SAM Exit retained lead'
);
INSERT INTO public.activities(id, lead_id, content)
VALUES (
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000001',
  'SAM Exit retained activity'
);
UPDATE public.organizations
SET status = 'read_only'
WHERE id = (SELECT value::uuid FROM exit_fixture_ids
            WHERE key = 'organization_id');
INSERT INTO public.support_sessions(
  id, organization_id, platform_staff_id, ticket_ref, reason, scope,
  status, approved_by_platform_staff_id, approved_at, expires_at
) VALUES (
  '30000000-0000-4000-8000-000000000003',
  (SELECT value::uuid FROM exit_fixture_ids WHERE key = 'organization_id'),
  '20000000-0000-4000-8000-000000000002',
  'SAM-EXIT-TICKET', 'Synthetic exit support', '["lead:read"]'::jsonb,
  'active', '20000000-0000-4000-8000-000000000003', now(),
  now() + interval '1 hour'
);

DO $$
DECLARE
  exported jsonb;
  digest_value text;
  completed jsonb;
BEGIN
  exported := public.export_organization_customer_data(
    (SELECT value::uuid FROM exit_fixture_ids
     WHERE key = 'organization_id'),
    '10000000-0000-4000-8000-000000000001',
    'sam-exit-export-request-0001'
  );
  digest_value := exported ->> 'data_sha256';
  IF digest_value !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'customer export digest missing';
  END IF;
  IF (exported #>> '{data,counts,leads}')::integer <> 1
    OR (exported #>> '{data,counts,activities}')::integer <> 1
    OR (exported #>> '{data,counts,memberships}')::integer <> 1
  THEN
    RAISE EXCEPTION 'customer export table counts mismatch';
  END IF;
  INSERT INTO exit_fixture_ids(key, value)
  VALUES ('export_sha256', digest_value);

  BEGIN
    PERFORM public.complete_organization_customer_exit(
      (SELECT value::uuid FROM exit_fixture_ids
       WHERE key = 'organization_id'),
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      'sam-exit-request-0001', repeat('0', 64),
      'backup-proof-invalid', 'customer-confirmation-invalid',
      'seven-year-contractual-retention', 'sam-exit-complete-invalid'
    );
    RAISE EXCEPTION 'stale export digest accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'organization_changed_after_export' THEN RAISE; END IF;
  END;

  completed := public.complete_organization_customer_exit(
    (SELECT value::uuid FROM exit_fixture_ids
     WHERE key = 'organization_id'),
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'sam-exit-request-0001', digest_value,
    'backup-proof-sam-exit-0001', 'customer-confirmation-sam-exit-0001',
    'seven-year-contractual-retention', 'sam-exit-complete-request-0001'
  );
  IF completed ->> 'organization_status' <> 'closed'
    OR completed ->> 'data_deleted' <> 'false'
  THEN
    RAISE EXCEPTION 'customer exit completion result mismatch';
  END IF;

  completed := public.complete_organization_customer_exit(
    (SELECT value::uuid FROM exit_fixture_ids
     WHERE key = 'organization_id'),
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000003',
    'sam-exit-request-0001', digest_value,
    'backup-proof-sam-exit-0001', 'customer-confirmation-sam-exit-0001',
    'seven-year-contractual-retention', 'sam-exit-complete-request-retry'
  );
  IF completed ->> 'idempotent' <> 'true'
    OR completed ->> 'organization_status' <> 'closed'
  THEN
    RAISE EXCEPTION 'customer exit completion retry was not idempotent';
  END IF;
END
$$;

DO $$
DECLARE
  organization_status text;
  membership_status text;
  support_status text;
  retained_leads integer;
  retained_activities integer;
BEGIN
  SELECT status INTO organization_status FROM public.organizations
  WHERE id = (SELECT value::uuid FROM exit_fixture_ids
              WHERE key = 'organization_id');
  SELECT status INTO membership_status FROM public.memberships
  WHERE id = (SELECT value::uuid FROM exit_fixture_ids
              WHERE key = 'membership_id');
  SELECT status INTO support_status FROM public.support_sessions
  WHERE id = '30000000-0000-4000-8000-000000000003';
  SELECT count(*) INTO retained_leads FROM public.leads
  WHERE id = '30000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO retained_activities FROM public.activities
  WHERE id = '30000000-0000-4000-8000-000000000002';
  IF organization_status <> 'closed'
    OR membership_status <> 'inactive'
    OR support_status <> 'revoked'
    OR retained_leads <> 1
    OR retained_activities <> 1
  THEN
    RAISE EXCEPTION 'customer exit state or data retention mismatch';
  END IF;
END
$$;

-- Disposable-fixture cleanup: reopen only the exact synthetic organization,
-- then remove exact IDs in dependency order. Production exit never does this.
UPDATE public.organizations SET status = 'active', closed_at = NULL
WHERE id = (SELECT value::uuid FROM exit_fixture_ids
            WHERE key = 'organization_id');
UPDATE public.memberships
SET status = 'active', deactivated_at = NULL
WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                          WHERE key = 'organization_id');
DELETE FROM public.activities
WHERE id = '30000000-0000-4000-8000-000000000002';
DELETE FROM public.leads
WHERE id = '30000000-0000-4000-8000-000000000001';
DELETE FROM public.support_sessions
WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                          WHERE key = 'organization_id');
DELETE FROM public.audit_events
WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                          WHERE key = 'organization_id');
DELETE FROM public.organization_exit_requests
WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                          WHERE key = 'organization_id');
DELETE FROM public.organization_provisioning_requests
WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                          WHERE key = 'organization_id');
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT id FROM public.memberships
  WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                            WHERE key = 'organization_id')
);
DELETE FROM public.memberships
WHERE organization_id = (SELECT value::uuid FROM exit_fixture_ids
                          WHERE key = 'organization_id');
DELETE FROM public.organizations
WHERE id = (SELECT value::uuid FROM exit_fixture_ids
            WHERE key = 'organization_id');
DELETE FROM public.platform_staff
WHERE id IN (
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003'
);
RESET ROLE;
DELETE FROM public.profiles WHERE id IN (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003'
);
DELETE FROM auth.users WHERE id IN (
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003'
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations WHERE slug = 'sam-exit-org-0001')
    OR EXISTS (SELECT 1 FROM public.leads
               WHERE id = '30000000-0000-4000-8000-000000000001')
    OR EXISTS (SELECT 1 FROM public.organization_exit_requests
               WHERE idempotency_key = 'sam-exit-request-0001')
  THEN
    RAISE EXCEPTION 'organization exit fixture cleanup failed';
  END IF;
END
$$;

SELECT 'Organization customer export, exit, retention and cleanup passed' result;
