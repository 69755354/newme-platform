\set ON_ERROR_STOP on

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  role text,
  is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  assigned_to uuid NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  notes text NULL
);
CREATE TABLE public.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  content text NULL
);
CREATE TABLE public.business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  description text NULL
);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  content text NULL
);
CREATE TABLE public.follow_up_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  summary text NULL
);
CREATE TABLE public.lead_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  file_name text NULL
);
CREATE TABLE public.lead_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  milestone_key text NULL
);
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  title text NULL
);
CREATE VIEW public.v_lead_trace AS
SELECT id AS lead_id FROM public.leads;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_profiles_read
  ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY harness_leads_all
  ON public.leads FOR ALL TO authenticated USING (true) WITH CHECK (true);

DO $$
DECLARE
  child_table text;
BEGIN
  FOREACH child_table IN ARRAY ARRAY[
    'activities',
    'business_events',
    'chat_messages',
    'follow_up_logs',
    'lead_documents',
    'lead_milestones',
    'tasks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', child_table);
    EXECUTE format(
      'CREATE POLICY harness_%I_all ON public.%I
       FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      child_table,
      child_table
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',
      child_table
    );
  END LOOP;
END
$$;
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;

INSERT INTO auth.users(id)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.profiles(id, role, is_active)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'sales', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sales', true);
INSERT INTO public.leads(id, source, assigned_to, notes)
VALUES (
  'aaaaaaaa-0000-4000-8000-000000000001',
  'offline',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'org-a'
);

\ir ../../supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql

INSERT INTO public.organizations(id, slug, name, industry_key, status)
VALUES (
  'bbbbbbbb-0000-4000-8000-000000000002',
  'org-b',
  'Organization B',
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
INSERT INTO public.leads(id, organization_id, source, assigned_to, notes)
VALUES (
  'bbbbbbbb-0000-4000-8000-000000000002',
  'bbbbbbbb-0000-4000-8000-000000000002',
  'offline',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'org-b'
);

CREATE FUNCTION public.harness_definer_cross_org_update()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  UPDATE public.leads
  SET notes = 'forbidden'
  WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002'
$$;
GRANT EXECUTE ON FUNCTION public.harness_definer_cross_org_update()
  TO authenticated;

SET ROLE authenticated;
SET request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
SET request.headers =
  '{"x-newme-organization-id":"6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1"}';

DO $$
DECLARE
  visible_count integer;
  changed_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.leads;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'org A visible count %, expected 1', visible_count;
  END IF;

  UPDATE public.leads
  SET notes = 'forbidden'
  WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count <> 0 THEN
    RAISE EXCEPTION 'org A updated org B rows: %', changed_count;
  END IF;
END
$$;

DO $$
BEGIN
  PERFORM public.harness_definer_cross_org_update();
  RAISE EXCEPTION 'SECURITY DEFINER cross-org update unexpectedly succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN
    IF SQLERRM <> 'lead_organization_context_mismatch' THEN
      RAISE;
    END IF;
END
$$;

SET request.headers = '{}';
DO $$
BEGIN
  INSERT INTO public.leads(organization_id, source, assigned_to)
  VALUES (
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
    'offline',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  RAISE EXCEPTION 'missing-context Lead insert unexpectedly succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN
    NULL;
END
$$;

SET request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
SET request.headers =
  '{"x-newme-organization-id":"bbbbbbbb-0000-4000-8000-000000000002"}';
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.leads;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'org B visible count %, expected 1', visible_count;
  END IF;
END
$$;

RESET ROLE;

DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.platform_staff', 'SELECT')
    OR has_table_privilege('authenticated', 'public.support_sessions', 'SELECT')
    OR has_table_privilege('authenticated', 'public.audit_events', 'SELECT')
  THEN
    RAISE EXCEPTION 'authenticated role can read private support tables';
  END IF;
END
$$;

DELETE FROM public.leads
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
DELETE FROM public.memberships
WHERE organization_id = 'bbbbbbbb-0000-4000-8000-000000000002';
DELETE FROM public.organizations
WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.memberships
    WHERE organization_id = 'bbbbbbbb-0000-4000-8000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.leads
    WHERE organization_id = 'bbbbbbbb-0000-4000-8000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_staff
  ) OR EXISTS (
    SELECT 1 FROM public.support_sessions
  ) OR EXISTS (
    SELECT 1 FROM public.audit_events
  ) THEN
    RAISE EXCEPTION 'SAM-20 fixture cleanup failed before rollback';
  END IF;
END
$$;

SELECT 'SAM-20 apply, RLS, trigger, and fixture cleanup harness passed' AS result;

