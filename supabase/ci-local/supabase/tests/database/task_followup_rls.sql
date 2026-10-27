BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SELECT plan(14);

SELECT has_function('public', 'sync_lead_next_followup', ARRAY[]::text[],
  'production task-to-lead sync function exists');
SELECT has_trigger('public', 'tasks', 'trg_sync_lead_from_tasks',
  'production task-to-lead sync trigger exists');
SELECT has_function('public', 'enforce_followup_required', ARRAY[]::text[],
  'production follow-up guard exists');
SELECT has_trigger('public', 'leads', 'trg_enforce_followup',
  'production follow-up guard trigger exists');

INSERT INTO public.profiles (id, role, full_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'sales', 'CI owner'),
  ('22222222-2222-2222-2222-222222222222', 'sales', 'CI non-owner');

INSERT INTO public.leads (
  id, source, stage, customer_name, assigned_to, next_action,
  next_followup_date
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'other', 'new', 'CI lead',
  '11111111-1111-1111-1111-111111111111', 'Call lead',
  '2030-01-02T00:00:00Z'
);

INSERT INTO public.tasks (
  id, lead_id, title, assignee_id, due_at, status, source
) VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Initial follow-up',
  '11111111-1111-1111-1111-111111111111',
  '2030-01-02T00:00:00Z', 'pending', 'manual'
);

SELECT throws_ok(
  $$DELETE FROM public.tasks
      WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$,
  'P0001',
  'Next follow-up date is required',
  'deleting the last pending task fails closed'
);

SELECT is(
  (SELECT count(*)::integer FROM public.tasks
   WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1,
  'failed deletion preserves the last pending task'
);

SELECT throws_ok(
  $$UPDATE public.tasks
      SET status = 'completed', completed_at = '2030-01-01T00:00:00Z'
      WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'$$,
  'P0001',
  'Next follow-up date is required',
  'completing the last pending task fails closed'
);

SELECT is(
  (SELECT status || ':' || COALESCE(completed_at::text, 'null')
   FROM public.tasks
   WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'pending:null',
  'failed completion leaves the original task pending with no completed_at'
);

SELECT is(
  (SELECT next_followup_date FROM public.leads
   WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '2030-01-02T00:00:00Z'::timestamptz,
  'failed completion preserves the lead next follow-up'
);

INSERT INTO public.tasks (
  id, lead_id, title, assignee_id, due_at, status, source
) VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Successor follow-up',
  '11111111-1111-1111-1111-111111111111',
  '2030-01-03T00:00:00Z', 'pending', 'manual'
);

UPDATE public.tasks
SET status = 'completed', completed_at = '2030-01-01T00:00:00Z'
WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

SELECT is(
  (SELECT next_followup_date FROM public.leads
   WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  '2030-01-03T00:00:00Z'::timestamptz,
  'a successor permits completion and becomes the lead next follow-up'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111', true);

SELECT is((SELECT count(*)::integer FROM public.tasks), 2,
  'the assigned sales owner can read tasks for the lead');

UPDATE public.tasks
SET title = 'Owner updated successor'
WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

RESET ROLE;
SELECT is(
  (SELECT title FROM public.tasks
   WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  'Owner updated successor',
  'the assigned sales owner can update the task'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',
  '22222222-2222-2222-2222-222222222222', true);

SELECT is((SELECT count(*)::integer FROM public.tasks), 0,
  'a non-owner sales user cannot read another owner task');

UPDATE public.tasks
SET title = 'Forbidden update'
WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

RESET ROLE;
SELECT is(
  (SELECT title FROM public.tasks
   WHERE id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'),
  'Owner updated successor',
  'a non-owner sales update is filtered by RLS'
);

SELECT * FROM finish();
ROLLBACK;
