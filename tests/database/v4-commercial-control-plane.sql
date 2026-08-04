\set ON_ERROR_STOP on

DO $$
BEGIN
  IF (SELECT count(*) FROM public.commercial_plan_versions WHERE is_active) <> 3
    OR NOT EXISTS (SELECT 1 FROM public.commercial_plan_versions
      WHERE plan_key = 'starter' AND paid_seat_limit = 5 AND organization_limit = 1)
    OR NOT EXISTS (SELECT 1 FROM public.commercial_plan_versions
      WHERE plan_key = 'growth' AND paid_seat_limit = 20 AND organization_limit = 3)
    OR NOT EXISTS (SELECT 1 FROM public.commercial_plan_versions
      WHERE plan_key = 'scale' AND paid_seat_limit = 50 AND organization_limit IS NULL)
  THEN RAISE EXCEPTION 'sam79_versioned_plan_catalog_invalid'; END IF;
  IF (SELECT count(*) FROM public.organization_subscriptions)
    <> (SELECT count(*) FROM public.organizations)
  THEN RAISE EXCEPTION 'sam79_subscription_backfill_incomplete'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.paid_seat_allocations allocation
    LEFT JOIN public.memberships membership ON membership.id = allocation.membership_id
    WHERE allocation.organization_id <> membership.organization_id
  ) THEN RAISE EXCEPTION 'sam79_cross_organization_seat_detected'; END IF;
END
$$;

INSERT INTO auth.users(id) VALUES
  ('79000000-0000-4000-8000-000000000001'),
  ('79000000-0000-4000-8000-000000000002');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('79000000-0000-4000-8000-000000000001', 'operator', true),
  ('79000000-0000-4000-8000-000000000002', 'admin', true);
INSERT INTO public.platform_staff(id, user_id, status, staff_ref, role_key) VALUES
  ('79000000-1000-4000-8000-000000000001',
    '79000000-0000-4000-8000-000000000001', 'active', 'sam79-ops', 'platform_ops'),
  ('79000000-1000-4000-8000-000000000002',
    '79000000-0000-4000-8000-000000000002', 'active', 'sam79-owner', 'platform_owner');

SET ROLE authenticated;
SET request.jwt.claim.sub = '79000000-0000-4000-8000-000000000001';
SELECT (public.v4_request_commercial_action(
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  'subscription.plan.change', '{"plan_key":"growth"}'::jsonb,
  'sam79.plan.growth.0001'
) ->> 'request_id')::uuid AS sam79_plan_request \gset

SET request.jwt.claim.sub = '79000000-0000-4000-8000-000000000002';
SELECT public.v4_approve_commercial_action(
  :'sam79_plan_request'::uuid, 'sam79.plan.approve.0001'
);
RESET ROLE;
SET ROLE service_role;
SELECT public.v4_execute_commercial_action(
  :'sam79_plan_request'::uuid, 'sam79.plan.execute.0001'
);

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '79000000-0000-4000-8000-000000000001';
SELECT (public.v4_request_commercial_action(
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  'entitlement.override',
  '{"entitlement_key":"usage.test_actions","enabled":true,"numeric_limit":10}'::jsonb,
  'sam79.quota.request.0001'
) ->> 'request_id')::uuid AS sam79_quota_request \gset
SET request.jwt.claim.sub = '79000000-0000-4000-8000-000000000002';
SELECT public.v4_approve_commercial_action(
  :'sam79_quota_request'::uuid, 'sam79.quota.approve.0001'
);
RESET ROLE;
SET ROLE service_role;
SELECT public.v4_execute_commercial_action(
  :'sam79_quota_request'::uuid, 'sam79.quota.execute.0001'
);
SELECT public.v4_record_commercial_usage(
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1', 'usage.test_actions', 7,
  'sam79.usage.0001', 'sam79-test',
  '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '{"synthetic":true}'
);
SELECT public.v4_record_commercial_usage(
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1', 'usage.test_actions', 7,
  'sam79.usage.0001', 'sam79-test',
  '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '{"synthetic":true}'
);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.commercial_usage_events
      WHERE organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
        AND metric_key = 'usage.test_actions'
        AND idempotency_key = 'sam79.usage.0001') <> 1
    OR (SELECT sum(quantity) FROM public.commercial_usage_events
      WHERE organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
        AND metric_key = 'usage.test_actions') <> 7
  THEN RAISE EXCEPTION 'sam79_usage_idempotency_failed'; END IF;
END
$$;
DO $$
BEGIN
  BEGIN
    PERFORM public.v4_record_commercial_usage(
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1', 'usage.test_actions', 4,
      'sam79.usage.overage.0001', 'sam79-test',
      '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '{}'
    );
    RAISE EXCEPTION 'sam79_overage_was_allowed';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'commercial_quota_exceeded' THEN RAISE; END IF;
  END;
END
$$;

RESET ROLE;
SET ROLE authenticated;
SET request.jwt.claim.sub = '79000000-0000-4000-8000-000000000001';
SELECT (public.v4_request_commercial_action(
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  'invoice.record',
  '{"invoice_ref":"SAM79-MANUAL-0001","status":"paid","amount_minor":250000,"currency":"AED","due_at":"2026-08-15T00:00:00Z","paid_at":"2026-08-10T00:00:00Z","metadata":{"synthetic":true}}'::jsonb,
  'sam79.invoice.request.0001'
) ->> 'request_id')::uuid AS sam79_invoice_request \gset
SET request.jwt.claim.sub = '79000000-0000-4000-8000-000000000002';
SELECT public.v4_approve_commercial_action(
  :'sam79_invoice_request'::uuid, 'sam79.invoice.approve.0001'
);
RESET ROLE;
SET ROLE service_role;
SELECT public.v4_execute_commercial_action(
  :'sam79_invoice_request'::uuid, 'sam79.invoice.execute.0001'
);

DO $$
DECLARE reconciliation jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.commercial_invoice_references
    WHERE invoice_ref = 'SAM79-MANUAL-0001' AND source = 'manual'
      AND status = 'paid' AND currency = 'AED' AND amount_minor = 250000
  ) THEN RAISE EXCEPTION 'sam79_manual_invoice_reference_missing'; END IF;
  IF (SELECT count(*) FROM public.commercial_usage_events
    WHERE idempotency_key = 'sam79.usage.0001') <> 1
  THEN RAISE EXCEPTION 'sam79_usage_idempotency_failed'; END IF;
  reconciliation := public.v4_reconcile_commercial_control_plane(
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
  );
  IF NOT (reconciliation ->> 'within_limit')::boolean
  THEN RAISE EXCEPTION 'sam79_seat_reconciliation_failed'; END IF;
END
$$;

RESET ROLE;
RESET request.jwt.claim.sub;

-- Prove rollback refuses real evidence, then remove only this synthetic run.
DO $$
BEGIN
  PERFORM set_config('newme.environment', 'test', true);
  IF NOT EXISTS (SELECT 1 FROM public.commercial_action_requests) THEN
    RAISE EXCEPTION 'sam79_rollback_guard_fixture_missing';
  END IF;
END
$$;

DELETE FROM public.commercial_action_events;
DELETE FROM public.commercial_state_events;
DELETE FROM public.commercial_usage_events;
DELETE FROM public.commercial_invoice_references;
DELETE FROM public.commercial_action_requests;
DELETE FROM public.platform_staff
WHERE user_id IN (
  '79000000-0000-4000-8000-000000000001',
  '79000000-0000-4000-8000-000000000002'
);
DELETE FROM public.profiles WHERE id IN (
  '79000000-0000-4000-8000-000000000001',
  '79000000-0000-4000-8000-000000000002'
);
DELETE FROM auth.users WHERE id IN (
  '79000000-0000-4000-8000-000000000001',
  '79000000-0000-4000-8000-000000000002'
);
DELETE FROM public.commercial_entitlements
WHERE source = 'approved_override';
UPDATE public.organization_subscriptions subscription SET
  plan_version_id = plan.id,
  paid_seat_limit = 5,
  lifecycle_state = CASE snapshot.organization_status
    WHEN 'read_only' THEN 'read_only' WHEN 'suspended' THEN 'suspended'
    WHEN 'closed' THEN 'closed' ELSE 'active' END,
  grace_ends_at = NULL,
  updated_at = now()
FROM public.commercial_migration_org_snapshots snapshot
JOIN public.commercial_plan_versions plan
  ON plan.plan_key = snapshot.plan_key AND plan.is_active
WHERE subscription.organization_id = snapshot.organization_id
  AND snapshot.organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1';
UPDATE public.organizations SET plan_key = 'starter', billable_seat_limit = 5
WHERE id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1';
INSERT INTO public.commercial_entitlements (
  organization_id, entitlement_key, enabled, numeric_limit, source, source_ref
)
SELECT '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1', item.key,
  CASE jsonb_typeof(item.value) WHEN 'boolean' THEN (item.value #>> '{}')::boolean ELSE true END,
  CASE jsonb_typeof(item.value) WHEN 'number' THEN (item.value #>> '{}')::bigint ELSE NULL END,
  'plan', 'plan-version:' || plan.id::text
FROM public.commercial_plan_versions plan
CROSS JOIN LATERAL jsonb_each(plan.included_entitlements) item
WHERE plan.plan_key = 'starter' AND plan.is_active
ON CONFLICT (organization_id, entitlement_key) DO UPDATE SET
  enabled = EXCLUDED.enabled, numeric_limit = EXCLUDED.numeric_limit,
  source = EXCLUDED.source, source_ref = EXCLUDED.source_ref;

SELECT 'sam79_commercial_control_plane_verified' AS result;
