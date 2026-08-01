\set ON_ERROR_STOP on

DELETE FROM public.tasks
WHERE id = '20000000-0000-4000-8000-000000000003';
DELETE FROM public.leads
WHERE id = '20000000-0000-4000-8000-000000000002';
DELETE FROM public.audit_events
WHERE organization_id IN (
  SELECT id FROM public.organizations WHERE slug = 'task-backup-restore'
);
DELETE FROM public.organization_provisioning_requests
WHERE idempotency_key = 'task-backup-restore:organization';
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT membership.id
  FROM public.memberships membership
  JOIN public.organizations organization
    ON organization.id = membership.organization_id
  WHERE organization.slug = 'task-backup-restore'
);
DELETE FROM public.memberships
WHERE organization_id IN (
  SELECT id FROM public.organizations WHERE slug = 'task-backup-restore'
);
DELETE FROM public.organizations
WHERE slug = 'task-backup-restore';
DELETE FROM public.profiles
WHERE id = '20000000-0000-4000-8000-000000000001';
DELETE FROM auth.users
WHERE id = '20000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tasks
    WHERE id = '20000000-0000-4000-8000-000000000003'
  ) OR EXISTS (
    SELECT 1 FROM public.leads
    WHERE id = '20000000-0000-4000-8000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.organizations
    WHERE slug = 'task-backup-restore'
  ) OR EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = '20000000-0000-4000-8000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '20000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'restorable task fixture cleanup failed';
  END IF;
END
$$;

SELECT 'Restorable task fixture cleanup passed' AS result;
