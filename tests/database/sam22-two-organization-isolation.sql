\set ON_ERROR_STOP on

\ir sam20-lead-organization-isolation.sql

RESET request.jwt.claim.sub;
RESET request.headers;

-- SAM-20 intentionally backfills every active legacy profile. Remove the
-- harness-only org-B identity from that legacy membership so it is a genuine
-- single-organization actor for SAM-22's negative matrix.
DELETE FROM public.memberships
WHERE organization_id = '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'
  AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

ALTER TABLE public.leads
  ADD COLUMN import_fingerprint text;
CREATE UNIQUE INDEX leads_import_fingerprint_unique
  ON public.leads(import_fingerprint);

CREATE TABLE public.crm_daily_funnel_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  current_milestone text NOT NULL,
  lead_count integer NOT NULL DEFAULT 0,
  total_value numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crm_daily_funnel_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_snapshot_all
  ON public.crm_daily_funnel_snapshot
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.crm_daily_funnel_snapshot TO authenticated;

\ir ../../supabase/migrations/20260730110000_sam22_two_organization_isolation.sql

UPDATE public.leads
SET import_fingerprint = 'sam22-shared-fingerprint'
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';

INSERT INTO public.organizations(id, slug, name, industry_key, status)
VALUES (
  'bbbbbbbb-0000-4000-8000-000000000002',
  'sam22-org-b',
  'SAM-22 Organization B',
  'retail',
  'active'
);
INSERT INTO public.memberships(organization_id, user_id, status, accepted_at)
VALUES (
  'bbbbbbbb-0000-4000-8000-000000000002',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'active',
  now()
);
INSERT INTO public.leads(
  id,
  organization_id,
  source,
  assigned_to,
  notes,
  import_fingerprint
)
VALUES (
  'bbbbbbbb-0000-4000-8000-000000000002',
  'bbbbbbbb-0000-4000-8000-000000000002',
  'offline',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'org-b',
  'sam22-shared-fingerprint'
);

DO $$
BEGIN
  INSERT INTO public.leads(
    organization_id,
    source,
    assigned_to,
    import_fingerprint
  )
  VALUES (
    'bbbbbbbb-0000-4000-8000-000000000002',
    'offline',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'sam22-shared-fingerprint'
  );
  RAISE EXCEPTION 'same-organization import fingerprint unexpectedly accepted';
EXCEPTION
  WHEN unique_violation THEN
    NULL;
END
$$;

INSERT INTO public.crm_daily_funnel_snapshot(
  organization_id,
  snapshot_date,
  current_milestone,
  lead_count
)
VALUES
  (
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
    CURRENT_DATE,
    'new',
    1
  ),
  (
    'bbbbbbbb-0000-4000-8000-000000000002',
    CURRENT_DATE,
    'new',
    1
  );

SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SET request.headers =
  '{"x-newme-organization-id":"6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1"}';
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.crm_daily_funnel_snapshot;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'org A snapshot count %, expected 1', visible_count;
  END IF;
END
$$;

SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
SET request.headers =
  '{"x-newme-organization-id":"bbbbbbbb-0000-4000-8000-000000000002"}';
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.crm_daily_funnel_snapshot;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'org B snapshot count %, expected 1', visible_count;
  END IF;
END
$$;

SET request.headers =
  '{"x-newme-organization-id":"6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1"}';
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count
  FROM public.crm_daily_funnel_snapshot;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'org B user read org A snapshots: %', visible_count;
  END IF;
END
$$;
RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.headers;

DELETE FROM public.crm_daily_funnel_snapshot;
DELETE FROM public.leads
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
UPDATE public.leads SET import_fingerprint = NULL
WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';
DELETE FROM public.memberships
WHERE organization_id = 'bbbbbbbb-0000-4000-8000-000000000002';
DELETE FROM public.organizations
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';

SELECT 'SAM-22 apply, org A/B RLS, uniqueness, and cleanup passed' AS result;
