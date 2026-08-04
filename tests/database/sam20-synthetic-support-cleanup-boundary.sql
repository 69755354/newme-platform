\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id) VALUES
  ('20000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002');
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('20000000-0000-4000-8000-000000000001', 'operator', true),
  ('20000000-0000-4000-8000-000000000002', 'admin', true);
INSERT INTO public.organizations(
  id, slug, name, industry_key, status, data_region, timezone
) VALUES (
  '20000000-0000-4000-8000-000000000010',
  'sam20-11111111-1111-4111-8111-111111111111-org-a',
  'Synthetic org-a', 'real_estate', 'active', 'uae', 'Asia/Dubai'
);
INSERT INTO public.platform_staff(id, user_id, status, staff_ref, role_key) VALUES
  ('20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000001', 'active',
    'sam20-11111111-1111-4111-8111-111111111111-support', 'platform_ops'),
  ('20000000-0000-4000-8000-000000000022',
    '20000000-0000-4000-8000-000000000002', 'active',
    'sam20-11111111-1111-4111-8111-111111111111-approver', 'platform_owner');
INSERT INTO public.support_sessions(
  id, organization_id, platform_staff_id, ticket_ref, reason, scope,
  status, approved_by_platform_staff_id, approved_at, expires_at, revoked_at
) VALUES (
  '20000000-0000-4000-8000-000000000030',
  '20000000-0000-4000-8000-000000000010',
  '20000000-0000-4000-8000-000000000021',
  'sam20-11111111-1111-4111-8111-111111111111-ticket',
  'Synthetic SAM-20 cleanup fixture', '["lead:read"]'::jsonb,
  'revoked', '20000000-0000-4000-8000-000000000022', now(),
  now() + interval '30 minutes', now()
);
INSERT INTO public.platform_action_approvals(
  id, action_key, target_key, payload, payload_hash, status,
  requested_by_platform_staff_id, approved_by_platform_staff_id,
  request_id, consumption_key, execution_result,
  approved_at, consumed_at
) VALUES (
  '20000000-0000-4000-8000-000000000040',
  'support.session.start', '20000000-0000-4000-8000-000000000010',
  jsonb_build_object(
    'support_user_id', '20000000-0000-4000-8000-000000000001'::uuid,
    'organization_id', '20000000-0000-4000-8000-000000000010'::uuid,
    'ticket_ref', 'sam20-11111111-1111-4111-8111-111111111111-ticket',
    'reason', 'Synthetic SAM-20 cleanup fixture',
    'scope', '["lead:read"]'::jsonb,
    'expires_at', (now() + interval '30 minutes')::text
  ),
  repeat('a', 64), 'consumed',
  '20000000-0000-4000-8000-000000000021',
  '20000000-0000-4000-8000-000000000022',
  'sam20-11111111-1111-4111-8111-111111111111-support-request',
  'sam20-11111111-1111-4111-8111-111111111111-support-consume',
  jsonb_build_object(
    'support_session_id', '20000000-0000-4000-8000-000000000030'::uuid,
    'organization_id', '20000000-0000-4000-8000-000000000010'::uuid,
    'support_user_id', '20000000-0000-4000-8000-000000000001'::uuid,
    'status', 'active'
  ), now(), now()
);
INSERT INTO public.platform_action_approval_events(
  approval_request_id, actor_platform_staff_id, action, request_id
) VALUES
  ('20000000-0000-4000-8000-000000000040',
    '20000000-0000-4000-8000-000000000021', 'requested', 'sam20-cleanup-requested'),
  ('20000000-0000-4000-8000-000000000040',
    '20000000-0000-4000-8000-000000000022', 'approved', 'sam20-cleanup-approved'),
  ('20000000-0000-4000-8000-000000000040',
    '20000000-0000-4000-8000-000000000021', 'consumed', 'sam20-cleanup-consumed');
INSERT INTO public.audit_events(
  organization_id, actor_user_id, actor_platform_staff_id,
  support_session_id, action, target_type, target_id, outcome,
  reason, request_id
) VALUES
  ('20000000-0000-4000-8000-000000000010',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000030',
    'support.session.start', 'support_session',
    '20000000-0000-4000-8000-000000000030', 'success',
    'synthetic', 'sam20-cleanup-audit-start'),
  ('20000000-0000-4000-8000-000000000010',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000030',
    'support.lead:read', 'lead', 'synthetic', 'denied',
    'synthetic', 'sam20-cleanup-audit-read');

SET ROLE service_role;
DELETE FROM public.audit_events
WHERE support_session_id = '20000000-0000-4000-8000-000000000030';
DELETE FROM public.platform_action_approval_events
WHERE approval_request_id = '20000000-0000-4000-8000-000000000040';
DELETE FROM public.platform_action_approvals
WHERE id = '20000000-0000-4000-8000-000000000040';
DELETE FROM public.support_sessions
WHERE id = '20000000-0000-4000-8000-000000000030';
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_events WHERE request_id LIKE 'sam20-cleanup-audit-%')
    OR EXISTS (SELECT 1 FROM public.platform_action_approval_events WHERE request_id LIKE 'sam20-cleanup-%')
    OR EXISTS (SELECT 1 FROM public.platform_action_approvals WHERE id = '20000000-0000-4000-8000-000000000040')
    OR EXISTS (SELECT 1 FROM public.support_sessions WHERE id = '20000000-0000-4000-8000-000000000030')
  THEN RAISE EXCEPTION 'SAM-20 exact synthetic cleanup did not remove every record'; END IF;
END
$$;

INSERT INTO public.platform_action_approvals(
  id, action_key, target_key, payload, payload_hash, status,
  requested_by_platform_staff_id, request_id
) VALUES (
  '20000000-0000-4000-8000-000000000041',
  'support.session.start', '20000000-0000-4000-8000-000000000010',
  jsonb_build_object(
    'support_user_id', '20000000-0000-4000-8000-000000000001'::uuid,
    'organization_id', '20000000-0000-4000-8000-000000000010'::uuid,
    'ticket_ref', 'not-a-sam20-marker', 'reason', 'must stay immutable',
    'scope', '["lead:read"]'::jsonb,
    'expires_at', (now() + interval '30 minutes')::text
  ), repeat('b', 64), 'pending',
  '20000000-0000-4000-8000-000000000021', 'not-a-sam20-request'
);
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    DELETE FROM public.platform_action_approvals
    WHERE id = '20000000-0000-4000-8000-000000000041';
    RAISE EXCEPTION 'non-marker platform approval was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'immutable_record' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;

ROLLBACK;

SELECT 'SAM-20 synthetic support cleanup boundary passed' AS result;
