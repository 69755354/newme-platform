\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'organization_exit_rollback_requires_staging_or_test';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_exit_requests
    WHERE status = 'completed'
  ) THEN
    RAISE EXCEPTION 'completed_organization_exit_blocks_schema_rollback';
  END IF;
END
$$;

UPDATE public.organizations organization
SET status = exit_request.previous_organization_status,
    closed_at = NULL,
    updated_at = now()
FROM public.organization_exit_requests exit_request
WHERE exit_request.organization_id = organization.id
  AND exit_request.status = 'prepared'
  AND organization.status = 'read_only';

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'leads', 'activities', 'business_events', 'chat_messages', 'customers',
    'follow_up_logs', 'knx_designs', 'lead_documents', 'lead_files',
    'lead_milestones', 'lead_mutation_requests', 'lead_workflow_stages',
    'quotes', 'transfer_history', 'quotations', 'contracts',
    'contract_approvals', 'installment_plans', 'payments',
    'payment_allocations', 'projects', 'tasks',
    'crm_daily_funnel_snapshot', 'products', 'activity_logs',
    'user_session_daily'
  ]
  LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS zz_organization_lifecycle_write_guard '
          || 'ON public.%I',
        table_name
      );
    END IF;
  END LOOP;
END
$$;

DROP FUNCTION IF EXISTS public.organization_lifecycle_write_guard();
DROP FUNCTION IF EXISTS public.complete_organization_customer_exit(
  uuid, uuid, uuid, text, text, text, text, text, text
);
DROP FUNCTION IF EXISTS public.prepare_organization_customer_exit(
  uuid, uuid, uuid, text, text, text
);
DROP FUNCTION IF EXISTS public.export_organization_customer_data(
  uuid, uuid, text
);
DROP FUNCTION IF EXISTS public.organization_customer_snapshot(uuid);
DROP FUNCTION IF EXISTS public.organization_export_rows(text, uuid);
DROP TABLE public.organization_exit_requests;

NOTIFY pgrst, 'reload schema';

COMMIT;
