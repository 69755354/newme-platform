BEGIN;

DO $$
BEGIN
  IF COALESCE(current_setting('newme.environment', true), '')
    NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam78_organizations_selected_context_read_rollback_requires_staging_or_test';
  END IF;
END
$$;

DROP POLICY IF EXISTS sam78_organizations_selected_context_read
  ON public.organizations;

COMMIT;
