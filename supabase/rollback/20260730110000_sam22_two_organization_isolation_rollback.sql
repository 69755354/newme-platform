-- SAM-22 staging/test-only rollback.
-- It restores the SAM-20 schema and refuses to proceed unless SAM-22 fixture
-- rows and cross-organization duplicate fingerprints have been cleaned.

\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  environment_name text := current_setting('newme.environment', true);
BEGIN
  IF environment_name IS NULL
    OR environment_name NOT IN ('staging', 'test')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'sam22_rollback_requires_staging_or_test';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.crm_daily_funnel_snapshot
    WHERE organization_id <>
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ) THEN
    RAISE EXCEPTION 'sam22_rollback_snapshot_fixtures_not_clean';
  END IF;

  IF EXISTS (
    SELECT import_fingerprint
    FROM public.leads
    WHERE import_fingerprint IS NOT NULL
    GROUP BY import_fingerprint
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'sam22_rollback_import_fixtures_not_clean';
  END IF;
END
$$;

DROP POLICY IF EXISTS sam22_crm_daily_funnel_snapshot_organization_boundary
  ON public.crm_daily_funnel_snapshot;
DROP INDEX IF EXISTS public.crm_daily_funnel_snapshot_org_date_idx;
DROP INDEX IF EXISTS public.crm_daily_funnel_snapshot_org_date_milestone_unique;

ALTER TABLE public.crm_daily_funnel_snapshot
  DROP CONSTRAINT IF EXISTS crm_daily_funnel_snapshot_organization_id_fkey;
ALTER TABLE public.crm_daily_funnel_snapshot
  DROP COLUMN IF EXISTS organization_id;

CREATE UNIQUE INDEX IF NOT EXISTS crm_daily_funnel_snapshot_date_milestone_unique
  ON public.crm_daily_funnel_snapshot (
    snapshot_date,
    current_milestone
  );

DROP INDEX IF EXISTS public.leads_organization_import_fingerprint_unique;
CREATE UNIQUE INDEX leads_import_fingerprint_unique
  ON public.leads (import_fingerprint);

NOTIFY pgrst, 'reload schema';

COMMIT;
