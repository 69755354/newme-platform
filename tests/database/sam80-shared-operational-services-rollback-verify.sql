\set ON_ERROR_STOP on

DO $$
DECLARE relation_name text;
DECLARE signature text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'shared_work_items', 'shared_approval_requests', 'shared_timeline_events',
    'shared_notifications', 'shared_outbox', 'shared_jobs',
    'shared_report_snapshots', 'v4_shared_operations_summary'
  ] LOOP
    IF to_regclass('public.' || relation_name) IS NOT NULL THEN
      RAISE EXCEPTION 'SAM-80 rollback retained relation %', relation_name;
    END IF;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'public.v4_create_shared_work_item(uuid,text,text,text,uuid,timestamptz,text,uuid,text)',
    'public.v4_transition_shared_work_item(uuid,uuid,text)',
    'public.v4_request_shared_approval(uuid,text,text,uuid,jsonb,timestamptz,text)',
    'public.v4_decide_shared_approval(uuid,uuid,text,text)',
    'public.v4_create_shared_job(uuid,text,jsonb,uuid,text)',
    'public.v4_mark_shared_notification_read(uuid,uuid)',
    'public.v4_claim_shared_outbox(integer,text,integer)',
    'public.v4_complete_shared_outbox(uuid,text,boolean,text)',
    'public.v4_claim_shared_jobs(integer,text,integer)',
    'public.v4_complete_shared_job(uuid,text,boolean,jsonb,text,text)',
    'public.v4_requeue_shared_dead_letter(uuid,text,uuid,uuid,text)'
  ] LOOP
    IF to_regprocedure(signature) IS NOT NULL THEN
      RAISE EXCEPTION 'SAM-80 rollback retained function %', signature;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.capabilities
    WHERE capability_key LIKE 'shared.%'
  ) THEN RAISE EXCEPTION 'SAM-80 rollback retained capabilities'; END IF;
END
$$;

SELECT 'SAM-80 rollback verified' AS result;
