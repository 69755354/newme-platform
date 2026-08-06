\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id) VALUES
  ('78000000-7000-4000-8000-000000000001'),
  ('78000000-7000-4000-8000-000000000002');
INSERT INTO public.profiles(id, email, role, is_active) VALUES
  ('78000000-7000-4000-8000-000000000001',
    'product-saas-77777777-7777-4777-8777-777777777777-admin@invalid.test', 'admin', true),
  ('78000000-7000-4000-8000-000000000002',
    'product-saas-77777777-7777-4777-8777-777777777777-operator@invalid.test', 'operator', false);
INSERT INTO public.organizations(
  id, slug, name, industry_key, plan_key, billable_seat_limit, status, data_region, timezone
) VALUES (
  '78000000-7000-4000-8000-000000000010',
  'product-saas-77777777-7777-4777-8777-777777777777',
  '[PRODUCT-UAT 77777777-7777-4777-8777-777777777777] organization',
  'real_estate', 'growth', 10, 'active', 'uae', 'Asia/Dubai'
);
INSERT INTO public.memberships(id, organization_id, user_id, status, accepted_at) VALUES
  ('78000000-7000-4000-8000-000000000011',
    '78000000-7000-4000-8000-000000000010',
    '78000000-7000-4000-8000-000000000001', 'active', now()),
  ('78000000-7000-4000-8000-000000000012',
    '78000000-7000-4000-8000-000000000010',
    '78000000-7000-4000-8000-000000000002', 'inactive', now());
INSERT INTO public.audit_events(
  id, organization_id, actor_user_id, action, target_type, target_id, outcome, request_id, metadata
) VALUES (
  '78000000-7000-4000-8000-000000000020',
  '78000000-7000-4000-8000-000000000010',
  '78000000-7000-4000-8000-000000000002',
  'organization.member.deactivate', 'membership',
  '78000000-7000-4000-8000-000000000012', 'success',
  'sam78-inactive-actor-cleanup',
  '{"target_user_id":"78000000-7000-4000-8000-000000000002"}'::jsonb
);

SET ROLE service_role;
DELETE FROM public.audit_events
WHERE id = '78000000-7000-4000-8000-000000000020';
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_events
    WHERE id = '78000000-7000-4000-8000-000000000020') THEN
    RAISE EXCEPTION 'inactive synthetic audit actor cleanup was rejected';
  END IF;
END
$$;

ROLLBACK;

SELECT 'SAM-78 inactive Product/SaaS audit cleanup boundary passed' AS result;
