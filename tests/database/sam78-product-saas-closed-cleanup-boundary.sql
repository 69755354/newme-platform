\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id) VALUES
  ('78000000-1600-4000-8000-000000000001'),
  ('78000000-1600-4000-8000-000000000002');
INSERT INTO public.profiles(id, email, role, is_active) VALUES
  ('78000000-1600-4000-8000-000000000001',
    'product-saas-22222222-2222-4222-8222-222222222222-admin@invalid.test', 'admin', true),
  ('78000000-1600-4000-8000-000000000002',
    'product-saas-22222222-2222-4222-8222-222222222222-boss@invalid.test', 'boss', true);
INSERT INTO public.organizations(
  id, slug, name, industry_key, plan_key, billable_seat_limit,
  status, data_region, timezone, closed_at
) VALUES (
  '78000000-1600-4000-8000-000000000010',
  'product-saas-22222222-2222-4222-8222-222222222222',
  '[PRODUCT-UAT 22222222-2222-4222-8222-222222222222] organization',
  'real_estate', 'growth', 20, 'closed', 'uae', 'Asia/Dubai', now()
);
INSERT INTO public.memberships(id, organization_id, user_id, status, accepted_at)
VALUES ('78000000-1600-4000-8000-000000000011',
  '78000000-1600-4000-8000-000000000010',
  '78000000-1600-4000-8000-000000000001', 'active', now());

DO $$
BEGIN
  IF NOT public.product_saas_is_synthetic_organization(
    '78000000-1600-4000-8000-000000000010'
  ) THEN RAISE EXCEPTION 'closed exact Product/SaaS marker was not recognized'; END IF;
END
$$;

INSERT INTO public.audit_events(
  id, organization_id, actor_user_id, action, target_type, target_id,
  outcome, request_id, metadata
) VALUES (
  '78000000-1600-4000-8000-000000000040',
  '78000000-1600-4000-8000-000000000010',
  '78000000-1600-4000-8000-000000000001',
  'lead.import', 'import_batch', '78000000-1600-4000-8000-000000000041',
  'success', 'sam78-product-closed-cleanup',
  '{"imported":3,"notes_created":3,"skipped_duplicates":0}'::jsonb
);
SET ROLE service_role;
DELETE FROM public.audit_events
WHERE id = '78000000-1600-4000-8000-000000000040';
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.audit_events
    WHERE id = '78000000-1600-4000-8000-000000000040') THEN
    RAISE EXCEPTION 'closed exact Product/SaaS audit event was not deleted';
  END IF;
END
$$;

UPDATE public.organizations
SET name = 'near-miss closed synthetic organization'
WHERE id = '78000000-1600-4000-8000-000000000010';
INSERT INTO public.audit_events(
  id, organization_id, actor_user_id, action, target_type, target_id,
  outcome, request_id, metadata
) VALUES (
  '78000000-1600-4000-8000-000000000050',
  '78000000-1600-4000-8000-000000000010',
  '78000000-1600-4000-8000-000000000001',
  'lead.import', 'import_batch', '78000000-1600-4000-8000-000000000051',
  'success', 'sam78-product-closed-near-miss',
  '{"imported":3,"notes_created":3,"skipped_duplicates":0}'::jsonb
);
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    DELETE FROM public.audit_events
    WHERE id = '78000000-1600-4000-8000-000000000050';
    RAISE EXCEPTION 'near-miss closed Product/SaaS audit event was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'immutable_record' THEN RAISE; END IF;
  END;
END
$$;
RESET ROLE;

ROLLBACK;

SELECT 'SAM-78 closed Product/SaaS synthetic cleanup boundary passed' AS result;
