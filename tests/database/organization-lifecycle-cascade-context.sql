\set ON_ERROR_STOP on

BEGIN;

INSERT INTO auth.users(id)
VALUES ('36000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id, role, is_active)
VALUES ('36000000-0000-4000-8000-000000000001', 'admin', true);
INSERT INTO public.organizations(id, slug, name, industry_key, status)
VALUES (
  '36000000-0000-4000-8000-000000000101',
  'sam-lifecycle-cascade',
  'SAM Lifecycle Cascade',
  'real_estate',
  'active'
);
INSERT INTO public.memberships(organization_id, user_id, status, accepted_at)
VALUES (
  '36000000-0000-4000-8000-000000000101',
  '36000000-0000-4000-8000-000000000001',
  'active',
  now()
);

INSERT INTO public.leads(id, organization_id, source)
VALUES (
  '36000000-0000-4000-8000-000000000201',
  '36000000-0000-4000-8000-000000000101',
  'sam-lifecycle-cascade'
);
SET session_replication_role = replica;
INSERT INTO public.lead_milestones(id, lead_id, milestone_key)
VALUES (
  '36000000-0000-4000-8000-000000000301',
  '36000000-0000-4000-8000-000000000201',
  'first_contact'
);
SET session_replication_role = origin;

SELECT set_config(
  'request.headers',
  '{"x-newme-organization-id":"36000000-0000-4000-8000-000000000101"}',
  true
);
DELETE FROM public.leads
WHERE id = '36000000-0000-4000-8000-000000000201';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = '36000000-0000-4000-8000-000000000201'
  ) OR EXISTS (
    SELECT 1 FROM public.lead_milestones
    WHERE id = '36000000-0000-4000-8000-000000000301'
  ) THEN
    RAISE EXCEPTION 'organization_lifecycle_cascade_cleanup_not_exact';
  END IF;
END
$$;

INSERT INTO public.leads(id, organization_id, source)
VALUES (
  '36000000-0000-4000-8000-000000000202',
  '36000000-0000-4000-8000-000000000101',
  'sam-lifecycle-cascade-no-context'
);
SET session_replication_role = replica;
INSERT INTO public.lead_milestones(id, lead_id, milestone_key)
VALUES (
  '36000000-0000-4000-8000-000000000302',
  '36000000-0000-4000-8000-000000000202',
  'first_contact'
);
SET session_replication_role = origin;
SELECT set_config('request.headers', '{}', true);

DO $$
BEGIN
  BEGIN
    DELETE FROM public.leads
    WHERE id = '36000000-0000-4000-8000-000000000202';
    RAISE EXCEPTION 'missing_cascade_organization_context_was_accepted';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM = 'missing_cascade_organization_context_was_accepted'
        OR SQLERRM NOT LIKE '%organization_lifecycle_context_missing%'
      THEN
        RAISE;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = '36000000-0000-4000-8000-000000000202'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.lead_milestones
    WHERE id = '36000000-0000-4000-8000-000000000302'
  ) THEN
    RAISE EXCEPTION 'failed_cascade_delete_was_not_atomic';
  END IF;
END
$$;

ROLLBACK;
