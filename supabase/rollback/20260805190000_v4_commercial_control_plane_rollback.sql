-- SAM-79 rollback. This removes only the migration bootstrap state. Any real
-- commercial event makes the rollback fail closed.

BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN RAISE EXCEPTION 'v4_commercial_rollback_requires_staging_or_test'; END IF;
  IF EXISTS (SELECT 1 FROM public.commercial_action_requests)
    OR EXISTS (SELECT 1 FROM public.commercial_action_events)
    OR EXISTS (SELECT 1 FROM public.commercial_usage_events)
    OR EXISTS (SELECT 1 FROM public.commercial_invoice_references)
    OR EXISTS (SELECT 1 FROM public.commercial_state_events)
    OR EXISTS (
      SELECT 1 FROM public.commercial_entitlements WHERE source <> 'plan'
    )
    OR EXISTS (
      SELECT 1 FROM public.paid_seat_allocations
      WHERE allocation_key NOT LIKE 'migration:%'
    )
    OR EXISTS (
      SELECT 1 FROM public.commercial_seat_events
      WHERE event_key NOT LIKE 'migration:%'
    )
  THEN RAISE EXCEPTION 'v4_commercial_rollback_live_records_present'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.organization_subscriptions subscription
    JOIN public.commercial_migration_org_snapshots snapshot
      ON snapshot.organization_id = subscription.organization_id
    JOIN public.commercial_plan_versions plan ON plan.id = subscription.plan_version_id
    WHERE subscription.lifecycle_state <> CASE snapshot.organization_status
        WHEN 'read_only' THEN 'read_only' WHEN 'suspended' THEN 'suspended'
        WHEN 'closed' THEN 'closed' ELSE 'active' END
      OR plan.plan_key <> snapshot.plan_key
  ) THEN RAISE EXCEPTION 'v4_commercial_rollback_subscription_drift'; END IF;
END;
$$;

DROP TRIGGER IF EXISTS v4_sync_membership_paid_seat_role ON public.membership_roles;
DROP TRIGGER IF EXISTS v4_sync_membership_paid_seat_membership ON public.memberships;
DROP TRIGGER IF EXISTS v4_sync_subscription_from_organization ON public.organizations;
DROP TRIGGER IF EXISTS v4_bootstrap_organization_subscription ON public.organizations;

DROP FUNCTION IF EXISTS public.v4_reconcile_commercial_control_plane(uuid);
DROP FUNCTION IF EXISTS public.v4_get_commercial_summary(uuid);
DROP FUNCTION IF EXISTS public.v4_record_commercial_usage(
  uuid, text, bigint, text, text, timestamptz, timestamptz, jsonb
);
DROP FUNCTION IF EXISTS public.v4_execute_commercial_action(uuid, text);
DROP FUNCTION IF EXISTS public.v4_approve_commercial_action(uuid, text);
DROP FUNCTION IF EXISTS public.v4_request_commercial_action(uuid, text, jsonb, text);
DROP FUNCTION IF EXISTS public.v4_sync_membership_paid_seat();
DROP FUNCTION IF EXISTS public.v4_sync_subscription_from_organization();
DROP FUNCTION IF EXISTS public.v4_bootstrap_organization_subscription();
DROP FUNCTION IF EXISTS public.v4_commercial_payload_hash(jsonb);

DELETE FROM public.role_capabilities role_capability
USING public.capabilities capability
WHERE capability.id = role_capability.capability_id
  AND capability.scope = 'organization'
  AND capability.capability_key = 'commercial.read';
DELETE FROM public.capabilities
WHERE scope = 'organization' AND capability_key = 'commercial.read';

ALTER TABLE public.organizations
  DROP CONSTRAINT organizations_billable_seat_limit_check;

UPDATE public.organizations organization SET
  plan_key = snapshot.plan_key,
  billable_seat_limit = snapshot.billable_seat_limit,
  status = snapshot.organization_status,
  updated_at = now()
FROM public.commercial_migration_org_snapshots snapshot
WHERE snapshot.organization_id = organization.id;

DROP TABLE public.commercial_state_events;
DROP TABLE public.commercial_action_events;
DROP TABLE public.commercial_action_requests;
DROP TABLE public.commercial_invoice_references;
DROP TABLE public.commercial_usage_events;
DROP TABLE public.commercial_seat_events;
DROP TABLE public.paid_seat_allocations;
DROP TABLE public.commercial_entitlements;
DROP TABLE public.organization_subscriptions;
DROP TABLE public.commercial_plan_versions;
DROP TABLE public.commercial_migration_org_snapshots;

CREATE OR REPLACE FUNCTION public.security_definer_rpc_allowlist_gate()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp AS $function$
  WITH expected(regprocedure) AS (VALUES
    ('create_product_for_organization(uuid,jsonb)'), ('delete_lead_atomic(uuid,uuid)'),
    ('get_my_role()'), ('import_products_for_organization(uuid,jsonb)'), ('next_quote_no()'),
    ('organization_billable_seat_count(uuid)'),
    ('reassign_lead_atomic(uuid,uuid,timestamp with time zone,uuid,text)'),
    ('recomplete_lead_milestone(uuid,text,text)'),
    ('record_lead_contact_atomic(uuid,text,timestamp with time zone,text,text,text,uuid)'),
    ('record_lead_note_atomic(uuid,text,uuid)'), ('reopen_lead_milestone(uuid,text,text)'),
    ('transition_lead_stage(uuid,text,text,text,uuid)'),
    ('v4_accept_organization_membership(uuid,uuid,text)'),
    ('v4_actor_has_capability(uuid,uuid,text,text)'),
    ('v4_actor_has_organization_role(uuid,uuid,text[])'),
    ('v4_allocate_payment_for_organization(uuid,uuid,jsonb,text)'),
    ('v4_approve_platform_action(uuid,text)'),
    ('v4_cancel_tenant_file_upload(uuid,uuid,text,text)'),
    ('v4_confirm_payment_for_organization(uuid,uuid,text)'),
    ('v4_convert_quotation_for_organization(uuid,uuid,jsonb,text)'),
    ('v4_create_contract_for_organization(uuid,jsonb,text)'),
    ('v4_import_leads_for_organization(uuid,jsonb,uuid,text)'),
    ('v4_invite_organization_member(uuid,uuid,text,text)'),
    ('v4_register_tenant_file(uuid,text,uuid,text,text,text,bigint,text,text)'),
    ('v4_replace_kpi_targets(uuid,text,jsonb,text)'),
    ('v4_request_platform_action_approval(text,text,jsonb,text)')
  ), actual AS (
    SELECT p.oid, p.oid::regprocedure::text AS regprocedure, p.proconfig,
      pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
      pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  ), violations AS (
    SELECT 'unexpected_authenticated'::text AS violation, actual.regprocedure
    FROM actual LEFT JOIN expected USING (regprocedure)
    WHERE actual.authenticated_execute AND expected.regprocedure IS NULL
    UNION ALL SELECT 'missing_expected', expected.regprocedure
      FROM expected LEFT JOIN actual USING (regprocedure)
      WHERE actual.oid IS NULL OR NOT actual.authenticated_execute
    UNION ALL SELECT 'anon_execute', actual.regprocedure FROM actual WHERE actual.anon_execute
    UNION ALL SELECT 'unsafe_search_path', actual.regprocedure FROM actual
      WHERE NOT (COALESCE(actual.proconfig, ARRAY[]::text[])
        @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[])
  )
  SELECT jsonb_build_object('gate_version', 'sam78-product-rpc-allowlist-v5',
    'violations', COALESCE(jsonb_agg(jsonb_build_object(
      'violation', violation, 'regprocedure', regprocedure
    ) ORDER BY violation, regprocedure) FILTER (WHERE violation IS NOT NULL), '[]'::jsonb))
  FROM violations
$function$;

ALTER TABLE public.organizations
  ALTER COLUMN billable_seat_limit SET DEFAULT 3,
  DROP CONSTRAINT IF EXISTS organizations_billable_seat_limit_check;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_billable_seat_limit_check CHECK (
    (plan_key = 'starter' AND billable_seat_limit >= 3)
    OR (plan_key = 'growth' AND billable_seat_limit >= 10)
    OR (plan_key = 'scale' AND billable_seat_limit >= 25)
  );

COMMIT;
