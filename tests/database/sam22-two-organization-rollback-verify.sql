\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'crm_daily_funnel_snapshot'
      AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'SAM-22 snapshot organization_id survived rollback';
  END IF;

  IF to_regclass('public.leads_organization_import_fingerprint_unique')
    IS NOT NULL
  THEN
    RAISE EXCEPTION 'SAM-22 import index survived rollback';
  END IF;

  IF to_regclass('public.leads_import_fingerprint_unique') IS NULL THEN
    RAISE EXCEPTION 'SAM-20 global import index was not restored';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'crm_daily_funnel_snapshot'
      AND policyname =
        'sam22_crm_daily_funnel_snapshot_organization_boundary'
  ) THEN
    RAISE EXCEPTION 'SAM-22 snapshot policy survived rollback';
  END IF;
END
$$;

SELECT 'SAM-22 rollback restored pre-SAM-22 schema' AS result;
