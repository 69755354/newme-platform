\set ON_ERROR_STOP on

INSERT INTO auth.users(id)
VALUES ('20000000-0000-4000-8000-000000000001');
INSERT INTO public.profiles(id, role, is_active)
VALUES ('20000000-0000-4000-8000-000000000001', 'boss', true);

SET ROLE service_role;

DO $$
DECLARE
  fixture_user_id uuid := '20000000-0000-4000-8000-000000000001';
  fixture_lead_id uuid := '20000000-0000-4000-8000-000000000002';
  fixture_task_id uuid := '20000000-0000-4000-8000-000000000003';
  organization_result jsonb;
  fixture_organization_id uuid;
BEGIN
  organization_result := public.initialize_organization(
    'task-backup-restore:organization',
    'task-backup-restore',
    'Task backup restore fixture',
    'real_estate',
    'starter',
    5,
    fixture_user_id
  );
  fixture_organization_id :=
    (organization_result ->> 'organization_id')::uuid;

  INSERT INTO public.leads(
    id, organization_id, source, assigned_to, notes
  ) VALUES (
    fixture_lead_id,
    fixture_organization_id,
    'offline',
    fixture_user_id,
    'task-backup-restore'
  );
  INSERT INTO public.tasks(
    id, lead_id, title, assignee_id, created_at, due_at
  ) VALUES (
    fixture_task_id,
    fixture_lead_id,
    'Restorable overdue task',
    fixture_user_id,
    timestamptz '2020-01-01 09:00:00+00',
    timestamptz '2020-01-02 09:00:00+00'
  );

  BEGIN
    UPDATE public.tasks
    SET created_at = timestamptz '2020-01-03 09:00:00+00',
        due_at = timestamptz '2020-01-01 09:00:00+00'
    WHERE id = fixture_task_id;
    RAISE EXCEPTION 'creation-time due-date violation accepted';
  EXCEPTION
    WHEN check_violation THEN
      NULL;
  END;

  IF (
    SELECT pg_get_constraintdef(oid, true)
    FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname = 'tasks_future_only'
  ) <> 'CHECK (due_at > (created_at - ''1 day''::interval))' THEN
    RAISE EXCEPTION 'tasks due-date constraint is not stable';
  END IF;
END
$$;

RESET ROLE;

SELECT 'Restorable task due-date constraint passed' AS result;
