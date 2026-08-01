\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id) VALUES
  ('35000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('35000000-0000-4000-8000-000000000001', 'sales', true);
INSERT INTO public.organizations(
  id, slug, name, industry_key, plan_key, billable_seat_limit, status
) VALUES
  ('35000000-0000-4000-8000-000000000101', 'auth-context-one',
   'Auth Context One', 'real_estate', 'growth', 10, 'active'),
  ('35000000-0000-4000-8000-000000000102', 'auth-context-two',
   'Auth Context Two', 'retail', 'growth', 10, 'active');
INSERT INTO public.memberships(
  id, organization_id, user_id, status, accepted_at
) VALUES (
  '35000000-0000-4000-8000-000000000201',
  '35000000-0000-4000-8000-000000000101',
  '35000000-0000-4000-8000-000000000001',
  'active', now()
);

UPDATE auth.users
SET last_sign_in_at = clock_timestamp()
WHERE id = '35000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_session_daily
    WHERE tenant_id = '35000000-0000-4000-8000-000000000101'
      AND user_id = '35000000-0000-4000-8000-000000000001'
      AND login_count = 1
  ) THEN
    RAISE EXCEPTION 'single_organization_auth_login_not_recorded';
  END IF;
END
$$;

UPDATE public.organizations SET status = 'read_only'
WHERE id = '35000000-0000-4000-8000-000000000101';
UPDATE auth.users
SET last_sign_in_at = clock_timestamp() + interval '1 second'
WHERE id = '35000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF (
    SELECT login_count FROM public.user_session_daily
    WHERE tenant_id = '35000000-0000-4000-8000-000000000101'
      AND user_id = '35000000-0000-4000-8000-000000000001'
      AND session_date = CURRENT_DATE
  ) <> 2 THEN
    RAISE EXCEPTION 'read_only_auth_login_was_not_observable';
  END IF;
END
$$;

INSERT INTO public.memberships(
  id, organization_id, user_id, status, accepted_at
) VALUES (
  '35000000-0000-4000-8000-000000000202',
  '35000000-0000-4000-8000-000000000102',
  '35000000-0000-4000-8000-000000000001',
  'active', now()
);
UPDATE auth.users
SET last_sign_in_at = clock_timestamp() + interval '2 seconds'
WHERE id = '35000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF (
    SELECT login_count FROM public.user_session_daily
    WHERE tenant_id = '35000000-0000-4000-8000-000000000101'
      AND user_id = '35000000-0000-4000-8000-000000000001'
      AND session_date = CURRENT_DATE
  ) <> 2 OR EXISTS (
    SELECT 1 FROM public.user_session_daily
    WHERE tenant_id = '35000000-0000-4000-8000-000000000102'
      AND user_id = '35000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'ambiguous_auth_login_forged_organization_context';
  END IF;
END
$$;

SELECT set_config(
  'request.jwt.claim.sub',
  '35000000-0000-4000-8000-000000000001',
  true
);
SELECT set_config(
  'request.headers',
  '{"x-newme-organization-id":"35000000-0000-4000-8000-000000000102"}',
  true
);
SELECT public.log_activity('page_view', 'organization', NULL, NULL, '/team', 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.activity_logs
    WHERE tenant_id = '35000000-0000-4000-8000-000000000102'
      AND user_id = '35000000-0000-4000-8000-000000000001'
      AND action = 'page_view'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.user_session_daily
    WHERE tenant_id = '35000000-0000-4000-8000-000000000102'
      AND user_id = '35000000-0000-4000-8000-000000000001'
      AND actions_count = 1
      AND pages_viewed = 1
  ) THEN
    RAISE EXCEPTION 'request_scoped_activity_context_not_recorded';
  END IF;
END
$$;

SELECT set_config('request.headers', '{}', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.log_activity('page_view', 'organization', NULL, NULL, '/team', 1);
    RAISE EXCEPTION 'missing_organization_context_was_accepted';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'missing_organization_context_was_accepted'
        OR SQLERRM NOT LIKE '%organization_context_required%'
      THEN
        RAISE;
      END IF;
  END;
END
$$;

DELETE FROM public.activity_logs
WHERE user_id = '35000000-0000-4000-8000-000000000001';
DELETE FROM public.user_session_daily
WHERE user_id = '35000000-0000-4000-8000-000000000001';
DELETE FROM public.memberships
WHERE user_id = '35000000-0000-4000-8000-000000000001';
DELETE FROM public.organizations
WHERE id IN (
  '35000000-0000-4000-8000-000000000101',
  '35000000-0000-4000-8000-000000000102'
);
DELETE FROM public.profiles
WHERE id = '35000000-0000-4000-8000-000000000001';
DELETE FROM auth.users
WHERE id = '35000000-0000-4000-8000-000000000001';

ROLLBACK;
