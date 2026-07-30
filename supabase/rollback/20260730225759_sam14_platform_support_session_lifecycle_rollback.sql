\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
  environment_name text := current_setting('newme.environment', true);
BEGIN
  IF environment_name IS NULL OR environment_name NOT IN ('staging', 'test') THEN
    RAISE EXCEPTION 'sam14_rollback_requires_staging_or_test';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.support_sessions
    WHERE status = 'active'
      AND revoked_at IS NULL
      AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'sam14_rollback_active_support_sessions';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS public.end_support_session_atomic(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.start_support_session_atomic(
  uuid,
  uuid,
  uuid,
  text,
  text,
  jsonb,
  timestamptz,
  text
);

COMMIT;
