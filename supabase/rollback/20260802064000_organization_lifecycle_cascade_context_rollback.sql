BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION 'organization_lifecycle_cascade_rollback_requires_staging_or_test';
  END IF;
END
$$;

-- Restore the lifecycle guard from 20260802055200.
CREATE OR REPLACE FUNCTION public.organization_lifecycle_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  row_data jsonb := CASE WHEN TG_OP = 'DELETE'
    THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  target_organization_id uuid;
  organization_status text;
BEGIN
  IF row_data ? 'organization_id' THEN
    target_organization_id := NULLIF(row_data ->> 'organization_id', '')::uuid;
  ELSIF row_data ? 'tenant_id' THEN
    target_organization_id := NULLIF(row_data ->> 'tenant_id', '')::uuid;
  ELSIF row_data ? 'lead_id' THEN
    SELECT lead_row.organization_id INTO target_organization_id
    FROM public.leads lead_row
    WHERE lead_row.id = NULLIF(row_data ->> 'lead_id', '')::uuid;
  END IF;

  IF target_organization_id IS NULL AND TG_TABLE_NAME = 'activities' THEN
    SELECT parent.organization_id INTO target_organization_id
    FROM (
      SELECT organization_id FROM public.contracts
      WHERE id = NULLIF(row_data ->> 'contract_id', '')::uuid
      UNION ALL
      SELECT organization_id FROM public.quotations
      WHERE id = NULLIF(row_data ->> 'quotation_id', '')::uuid
      UNION ALL
      SELECT organization_id FROM public.projects
      WHERE id = NULLIF(row_data ->> 'project_id', '')::uuid
    ) parent
    LIMIT 1;
  END IF;
  IF target_organization_id IS NULL AND TG_TABLE_NAME = 'quotes' THEN
    SELECT project.organization_id INTO target_organization_id
    FROM public.projects project
    WHERE project.id = NULLIF(row_data ->> 'project_id', '')::uuid;
  END IF;
  IF target_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_lifecycle_context_missing';
  END IF;

  SELECT status INTO organization_status
  FROM public.organizations
  WHERE id = target_organization_id;

  IF TG_TABLE_NAME IN ('activity_logs', 'user_session_daily') THEN
    IF organization_status NOT IN ('active', 'read_only', 'suspended') THEN
      RAISE EXCEPTION 'organization_is_not_observable';
    END IF;
  ELSIF organization_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'organization_is_not_writable';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.organization_lifecycle_write_guard() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

COMMIT;
