\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id) VALUES
  ('80000000-0000-4000-8000-000000000001'),
  ('80000000-0000-4000-8000-000000000002'),
  ('80000000-0000-4000-8000-000000000003');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('80000000-0000-4000-8000-000000000001', 'admin', true),
  ('80000000-0000-4000-8000-000000000002', 'operator', true),
  ('80000000-0000-4000-8000-000000000003', 'admin', true);
INSERT INTO public.organizations(
  id, slug, name, industry_key, status, plan_key, billable_seat_limit
) VALUES
  ('80000000-1000-4000-8000-000000000001', 'sam80-org-a', 'SAM-80 A', 'real_estate', 'active', 'growth', 10),
  ('80000000-1000-4000-8000-000000000002', 'sam80-org-b', 'SAM-80 B', 'retail', 'active', 'growth', 10);
INSERT INTO public.memberships(
  id, organization_id, user_id, status, accepted_at
) VALUES
  ('80000000-2000-4000-8000-000000000001', '80000000-1000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'active', clock_timestamp()),
  ('80000000-2000-4000-8000-000000000002', '80000000-1000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', 'active', clock_timestamp()),
  ('80000000-2000-4000-8000-000000000003', '80000000-1000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000003', 'active', clock_timestamp());
INSERT INTO public.membership_roles(organization_id, membership_id, role_id)
SELECT fixture.organization_id, fixture.membership_id, role.id
FROM (VALUES
  ('80000000-1000-4000-8000-000000000001'::uuid, '80000000-2000-4000-8000-000000000001'::uuid, 'org_admin'),
  ('80000000-1000-4000-8000-000000000001'::uuid, '80000000-2000-4000-8000-000000000002'::uuid, 'operations'),
  ('80000000-1000-4000-8000-000000000002'::uuid, '80000000-2000-4000-8000-000000000003'::uuid, 'org_admin')
) fixture(organization_id, membership_id, role_key)
JOIN public.roles role ON role.scope = 'organization' AND role.role_key = fixture.role_key;

DO $$
BEGIN
  IF public.v4_shared_payload_is_safe('{"authorization":"Bearer abc"}'::jsonb)
    OR public.v4_shared_payload_is_safe('{"nested":{"password":"x"}}'::jsonb)
    OR NOT public.v4_shared_payload_is_safe('{"work_item_id":"80000000-3000-4000-8000-000000000001","count":2}'::jsonb)
  THEN RAISE EXCEPTION 'shared payload redaction boundary failed'; END IF;
END
$$;

SET ROLE authenticated;
SET request.jwt.claim.sub = '80000000-0000-4000-8000-000000000001';
SET request.headers = '{"x-newme-organization-id":"80000000-1000-4000-8000-000000000001"}';

SELECT set_config('sam80.work_item_id', (
  SELECT id::text FROM public.v4_create_shared_work_item(
    '80000000-1000-4000-8000-000000000001', 'Review shared operations',
    'Bounded operational work', 'high',
    '80000000-0000-4000-8000-000000000002', clock_timestamp() + interval '1 day',
    'organization', '80000000-1000-4000-8000-000000000001', 'sam80-work-item-0001'
  )
), false);

DO $$
DECLARE replay_id uuid;
BEGIN
  SELECT id INTO replay_id FROM public.v4_create_shared_work_item(
    '80000000-1000-4000-8000-000000000001', 'Review shared operations',
    'Bounded operational work', 'high',
    '80000000-0000-4000-8000-000000000002', clock_timestamp() + interval '1 day',
    'organization', '80000000-1000-4000-8000-000000000001', 'sam80-work-item-0001'
  );
  IF replay_id <> current_setting('sam80.work_item_id')::uuid
    OR (SELECT count(*) FROM public.shared_work_items) <> 1
    OR (SELECT count(*) FROM public.shared_timeline_events WHERE resource_id = replay_id) <> 1
    OR (SELECT count(*) FROM public.shared_notifications WHERE payload ->> 'work_item_id' = replay_id::text) <> 1
  THEN RAISE EXCEPTION 'shared work item idempotency or fanout failed'; END IF;

  BEGIN
    PERFORM public.v4_create_shared_work_item(
      '80000000-1000-4000-8000-000000000002', 'Cross tenant', NULL, 'normal',
      NULL, NULL, NULL, NULL, 'sam80-cross-org-denied'
    );
    RAISE EXCEPTION 'cross-organization work item accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT set_config('sam80.approval_id', (
  SELECT id::text FROM public.v4_request_shared_approval(
    '80000000-1000-4000-8000-000000000001', 'work_item.cancel', 'work_item',
    current_setting('sam80.work_item_id')::uuid,
    jsonb_build_object('work_item_id', current_setting('sam80.work_item_id')::uuid),
    clock_timestamp() + interval '1 hour', 'sam80-approval-0001'
  )
), false);

DO $$
BEGIN
  BEGIN
    PERFORM public.v4_decide_shared_approval(
      '80000000-1000-4000-8000-000000000001',
      current_setting('sam80.approval_id')::uuid, 'approved', 'self'
    );
    RAISE EXCEPTION 'approval requester self-approved';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT IN ('shared_approval_not_found_or_forbidden', 'approval requester self-approved') THEN RAISE; END IF;
  END;
END
$$;

SET request.jwt.claim.sub = '80000000-0000-4000-8000-000000000002';
SELECT public.v4_decide_shared_approval(
  '80000000-1000-4000-8000-000000000001',
  current_setting('sam80.approval_id')::uuid, 'approved', 'independent_review'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.shared_approval_requests
    WHERE id = current_setting('sam80.approval_id')::uuid
      AND status = 'approved'
      AND requested_by = '80000000-0000-4000-8000-000000000001'
      AND decided_by = '80000000-0000-4000-8000-000000000002'
      AND payload_sha256 ~ '^[0-9a-f]{64}$'
  ) THEN RAISE EXCEPTION 'independent approval evidence missing'; END IF;
END
$$;

SET request.jwt.claim.sub = '80000000-0000-4000-8000-000000000001';
SELECT set_config('sam80.report_job_id', (
  SELECT id::text FROM public.v4_create_shared_job(
    '80000000-1000-4000-8000-000000000001', 'operations_report',
    '{"period_start":"2026-08-01","period_end":"2026-08-04"}'::jsonb,
    NULL, 'sam80-report-job-0001'
  )
), false);
SELECT set_config('sam80.import_job_id', (
  SELECT id::text FROM public.v4_create_shared_job(
    '80000000-1000-4000-8000-000000000001', 'work_items_import',
    '{"items":[{"title_code":"follow_up","priority":"normal"}]}'::jsonb,
    NULL, 'sam80-import-job-0001'
  )
), false);

DO $$
BEGIN
  BEGIN
    UPDATE public.shared_timeline_events SET event_type = 'forged';
    RAISE EXCEPTION 'immutable timeline accepted update';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.shared_work_items
    WHERE organization_id = '80000000-1000-4000-8000-000000000002'
  ) THEN RAISE EXCEPTION 'cross-organization read leaked'; END IF;
END
$$;

RESET ROLE;
SET ROLE service_role;
RESET request.jwt.claim.sub;
RESET request.headers;

SELECT set_config('sam80.outbox_id', (
  SELECT id::text FROM public.v4_claim_shared_outbox(1, 'sam80-worker-a', 60) LIMIT 1
), false);
DO $$
BEGIN
  IF current_setting('sam80.outbox_id', true) IS NULL THEN
    RAISE EXCEPTION 'shared outbox claim returned no row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.v4_claim_shared_outbox(100, 'sam80-worker-b', 60)
    WHERE id = current_setting('sam80.outbox_id')::uuid)
  THEN RAISE EXCEPTION 'shared outbox lease double claimed'; END IF;
END
$$;
SELECT public.v4_complete_shared_outbox(
  current_setting('sam80.outbox_id')::uuid, 'sam80-worker-a', true, NULL
);

SELECT set_config('sam80.claimed_report_job_id', (
  SELECT id::text FROM public.v4_claim_shared_jobs(20, 'sam80-job-worker', 60)
  WHERE id = current_setting('sam80.report_job_id')::uuid
), false);
SELECT public.v4_complete_shared_job(
  current_setting('sam80.report_job_id')::uuid, 'sam80-job-worker', true,
  '{"open_work_items":1,"pending_approvals":0,"dead_letters":0}'::jsonb,
  repeat('a', 64), NULL
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.shared_report_snapshots
    WHERE generated_by_job_id = current_setting('sam80.report_job_id')::uuid
      AND source_sha256 = repeat('a', 64)
  ) THEN RAISE EXCEPTION 'shared report snapshot missing'; END IF;
END
$$;

-- Drive an import job into dead-letter, then prove bounded operator recovery.
UPDATE public.shared_jobs SET state = 'running', attempts = max_attempts,
  leased_by = 'sam80-failing-worker', lease_expires_at = clock_timestamp() + interval '1 minute'
WHERE id = current_setting('sam80.import_job_id')::uuid;
SELECT public.v4_complete_shared_job(
  current_setting('sam80.import_job_id')::uuid, 'sam80-failing-worker', false,
  '{}'::jsonb, NULL, 'synthetic_failure'
);
SELECT public.v4_requeue_shared_dead_letter(
  '80000000-1000-4000-8000-000000000001', 'job',
  current_setting('sam80.import_job_id')::uuid,
  '80000000-0000-4000-8000-000000000002', 'sam80-requeue-request-0001'
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.shared_jobs
    WHERE id = current_setting('sam80.import_job_id')::uuid
      AND state = 'queued' AND attempts = 0 AND error_code IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.audit_events
    WHERE request_id = 'sam80-requeue-request-0001'
      AND action = 'shared.dead_letter.requeued'
  ) THEN RAISE EXCEPTION 'dead-letter recovery evidence missing'; END IF;
END
$$;

ROLLBACK;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.shared_work_items)
    OR EXISTS (SELECT 1 FROM public.shared_approval_requests)
    OR EXISTS (SELECT 1 FROM public.shared_timeline_events)
    OR EXISTS (SELECT 1 FROM public.shared_notifications)
    OR EXISTS (SELECT 1 FROM public.shared_outbox)
    OR EXISTS (SELECT 1 FROM public.shared_jobs)
    OR EXISTS (SELECT 1 FROM public.shared_report_snapshots)
  THEN RAISE EXCEPTION 'SAM-80 fixture cleanup failed'; END IF;
END
$$;

SELECT 'SAM-80 shared operational services passed' AS result;
