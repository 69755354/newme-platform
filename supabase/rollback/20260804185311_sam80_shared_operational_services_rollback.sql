BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN RAISE EXCEPTION 'sam80_shared_services_rollback_requires_staging_or_test'; END IF;

  IF EXISTS (SELECT 1 FROM public.shared_work_items)
    OR EXISTS (SELECT 1 FROM public.shared_approval_requests)
    OR EXISTS (SELECT 1 FROM public.shared_timeline_events)
    OR EXISTS (SELECT 1 FROM public.shared_notifications)
    OR EXISTS (SELECT 1 FROM public.shared_outbox)
    OR EXISTS (SELECT 1 FROM public.shared_jobs)
    OR EXISTS (SELECT 1 FROM public.shared_report_snapshots)
  THEN RAISE EXCEPTION 'sam80_shared_services_rollback_data_present'; END IF;
END
$$;

DROP VIEW IF EXISTS public.v4_shared_operations_summary;
DROP FUNCTION IF EXISTS public.v4_requeue_shared_dead_letter(uuid,text,uuid,uuid,text);
DROP FUNCTION IF EXISTS public.v4_complete_shared_job(uuid,text,boolean,jsonb,text,text);
DROP FUNCTION IF EXISTS public.v4_claim_shared_jobs(integer,text,integer);
DROP FUNCTION IF EXISTS public.v4_complete_shared_outbox(uuid,text,boolean,text);
DROP FUNCTION IF EXISTS public.v4_claim_shared_outbox(integer,text,integer);
DROP FUNCTION IF EXISTS public.v4_mark_shared_notification_read(uuid,uuid);
DROP FUNCTION IF EXISTS public.v4_create_shared_job(uuid,text,jsonb,uuid,text);
DROP FUNCTION IF EXISTS public.v4_decide_shared_approval(uuid,uuid,text,text);
DROP FUNCTION IF EXISTS public.v4_request_shared_approval(uuid,text,text,uuid,jsonb,timestamptz,text);
DROP FUNCTION IF EXISTS public.v4_transition_shared_work_item(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.v4_create_shared_work_item(uuid,text,text,text,uuid,timestamptz,text,uuid,text);

DROP TABLE public.shared_report_snapshots;
DROP TABLE public.shared_jobs;
DROP TABLE public.shared_outbox;
DROP TABLE public.shared_notifications;
DROP TABLE public.shared_timeline_events;
DROP TABLE public.shared_approval_requests;
DROP TABLE public.shared_work_items;

DROP FUNCTION IF EXISTS public.v4_shared_emit_event();
DROP FUNCTION IF EXISTS public.v4_shared_notification_guard();
DROP FUNCTION IF EXISTS public.v4_shared_approval_guard();
DROP FUNCTION IF EXISTS public.v4_shared_work_item_guard();
DROP FUNCTION IF EXISTS public.v4_shared_touch_updated_at();
DROP FUNCTION IF EXISTS public.v4_shared_payload_is_safe(jsonb, integer);

DELETE FROM public.role_capabilities
WHERE capability_id IN (
  SELECT id FROM public.capabilities
  WHERE scope = 'organization' AND capability_key IN (
    'shared.operations.read', 'shared.work.write',
    'shared.approvals.request', 'shared.approvals.decide',
    'shared.notifications.manage', 'shared.jobs.import',
    'shared.jobs.export', 'shared.jobs.report'
  )
);
DELETE FROM public.capabilities
WHERE scope = 'organization' AND capability_key IN (
  'shared.operations.read', 'shared.work.write',
  'shared.approvals.request', 'shared.approvals.decide',
  'shared.notifications.manage', 'shared.jobs.import',
  'shared.jobs.export', 'shared.jobs.report'
);

NOTIFY pgrst, 'reload schema';
COMMIT;
