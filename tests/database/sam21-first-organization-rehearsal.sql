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
  created_by uuid NULL,
  quotation_value numeric NULL,
  current_milestone text NULL,
  import_fingerprint text NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  notes text NULL
);
CREATE UNIQUE INDEX leads_import_fingerprint_unique
  ON public.leads(import_fingerprint);

CREATE TABLE public.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  user_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.follow_up_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  created_by uuid NULL,
  user_id uuid NULL,
  contact_time timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lead_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  uploaded_by uuid NULL,
  file_size bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lead_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  completed_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NULL REFERENCES public.leads(id),
  assignee_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.crm_daily_funnel_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL DEFAULT CURRENT_DATE,
  current_milestone text NOT NULL,
  lead_count integer NOT NULL DEFAULT 0,
  total_value numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW public.v_lead_trace AS
SELECT id AS lead_id FROM public.leads;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_daily_funnel_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_profiles_read
  ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY harness_leads_all
  ON public.leads FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY harness_snapshot_all
  ON public.crm_daily_funnel_snapshot
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.crm_daily_funnel_snapshot TO authenticated;

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

INSERT INTO auth.users(id)
VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.profiles(id, role, is_active)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'admin', true),
  ('22222222-2222-4222-8222-222222222222', 'sales', true),
  ('33333333-3333-4333-8333-333333333333', 'sales', false);

INSERT INTO public.leads(
  id,
  source,
  assigned_to,
  created_by,
  quotation_value,
  current_milestone,
  import_fingerprint,
  notes
)
VALUES
  (
    'aaaaaaaa-0000-4000-8000-000000000001',
    'offline',
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    100,
    'new',
    'sam21-a',
    'synthetic-a'
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000002',
    'offline',
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    250,
    'first_contact',
    'sam21-b',
    'synthetic-b'
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000003',
    'offline',
    '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222',
    650,
    'won',
    'sam21-c',
    'synthetic-c'
  );

INSERT INTO public.activities(id, lead_id, user_id)
VALUES (
  'a1000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.business_events(id, lead_id, created_by)
VALUES (
  'b1000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111'
);
INSERT INTO public.chat_messages(id, lead_id)
VALUES (
  'c1000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002'
);
INSERT INTO public.follow_up_logs(id, lead_id, created_by, user_id)
VALUES (
  'f1000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  '22222222-2222-4222-8222-222222222222',
  '22222222-2222-4222-8222-222222222222'
);
INSERT INTO public.lead_documents(id, lead_id, uploaded_by, file_size)
VALUES
  (
    'd1000000-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    1024
  ),
  (
    'd1000000-0000-4000-8000-000000000002',
    'aaaaaaaa-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    2048
  );
INSERT INTO public.lead_milestones(id, lead_id, completed_by)
VALUES (
  'e1000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000003',
  '22222222-2222-4222-8222-222222222222'
);
INSERT INTO public.tasks(id, lead_id, assignee_id)
VALUES (
  '71000000-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
  '22222222-2222-4222-8222-222222222222'
);
INSERT INTO public.crm_daily_funnel_snapshot(
  id,
  snapshot_date,
  current_milestone,
  lead_count,
  total_value
)
VALUES
  (
    '51000000-0000-4000-8000-000000000001',
    CURRENT_DATE - 1,
    'new',
    1,
    100
  ),
  (
    '51000000-0000-4000-8000-000000000002',
    CURRENT_DATE - 1,
    'won',
    1,
    650
  );

CREATE VIEW public.sam21_rehearsal_metrics AS
SELECT
  jsonb_build_object(
    'profiles', (SELECT count(*) FROM public.profiles),
    'leads', (SELECT count(*) FROM public.leads),
    'activities', (SELECT count(*) FROM public.activities),
    'business_events', (SELECT count(*) FROM public.business_events),
    'chat_messages', (SELECT count(*) FROM public.chat_messages),
    'follow_up_logs', (SELECT count(*) FROM public.follow_up_logs),
    'lead_documents', (SELECT count(*) FROM public.lead_documents),
    'lead_milestones', (SELECT count(*) FROM public.lead_milestones),
    'tasks', (SELECT count(*) FROM public.tasks),
    'snapshots', (SELECT count(*) FROM public.crm_daily_funnel_snapshot)
  ) AS aggregate_counts,
  (SELECT coalesce(sum(quotation_value), 0) FROM public.leads)
    AS quotation_value_total,
  (
    SELECT md5(coalesce(string_agg(
      concat_ws(
        ':',
        id::text,
        coalesce(assigned_to::text, ''),
        coalesce(created_by::text, '')
      ),
      '|' ORDER BY id
    ), ''))
    FROM public.leads
  ) AS lead_owner_digest,
  (
    SELECT md5(coalesce(string_agg(
      concat_ws(
        ':',
        source_table,
        id::text,
        coalesce(lead_id::text, ''),
        coalesce(actor_id::text, '')
      ),
      '|' ORDER BY source_table, id
    ), ''))
    FROM (
      SELECT 'activities' AS source_table, id, lead_id, user_id AS actor_id
        FROM public.activities
      UNION ALL
      SELECT 'business_events', id, lead_id, created_by
        FROM public.business_events
      UNION ALL
      SELECT 'chat_messages', id, lead_id, NULL::uuid
        FROM public.chat_messages
      UNION ALL
      SELECT 'follow_up_logs', id, lead_id, coalesce(created_by, user_id)
        FROM public.follow_up_logs
      UNION ALL
      SELECT 'lead_milestones', id, lead_id, completed_by
        FROM public.lead_milestones
      UNION ALL
      SELECT 'tasks', id, lead_id, assignee_id
        FROM public.tasks
    ) history_rows
  ) AS history_relationship_digest,
  (
    SELECT md5(coalesce(string_agg(
      concat_ws(
        ':',
        id::text,
        lead_id::text,
        coalesce(uploaded_by::text, ''),
        coalesce(file_size::text, '')
      ),
      '|' ORDER BY id
    ), ''))
    FROM public.lead_documents
  ) AS document_ownership_digest;

CREATE TABLE public.sam21_rehearsal_evidence AS
SELECT
  'before'::text AS phase,
  metrics.*
FROM public.sam21_rehearsal_metrics metrics;

\ir ../../scripts/uat/sam21-readonly-reconciliation.sql
\ir ../../supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql
\ir ../../supabase/migrations/20260730110000_sam22_two_organization_isolation.sql
\ir ../../scripts/uat/sam21-readonly-reconciliation.sql

INSERT INTO public.sam21_rehearsal_evidence
SELECT
  'after'::text,
  metrics.*
FROM public.sam21_rehearsal_metrics metrics;

DO $$
DECLARE
  before_row public.sam21_rehearsal_evidence%ROWTYPE;
  after_row public.sam21_rehearsal_evidence%ROWTYPE;
  legacy_organization_id constant uuid :=
    '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid;
BEGIN
  SELECT * INTO STRICT before_row
  FROM public.sam21_rehearsal_evidence
  WHERE phase = 'before';
  SELECT * INTO STRICT after_row
  FROM public.sam21_rehearsal_evidence
  WHERE phase = 'after';

  IF before_row.aggregate_counts IS DISTINCT FROM after_row.aggregate_counts
    OR before_row.quotation_value_total IS DISTINCT FROM
      after_row.quotation_value_total
  THEN
    RAISE EXCEPTION 'sam21_aggregate_metrics_changed';
  END IF;
  IF before_row.lead_owner_digest IS DISTINCT FROM after_row.lead_owner_digest
  THEN
    RAISE EXCEPTION 'sam21_lead_owner_relationship_changed';
  END IF;
  IF before_row.history_relationship_digest IS DISTINCT FROM
    after_row.history_relationship_digest
  THEN
    RAISE EXCEPTION 'sam21_history_relationship_changed';
  END IF;
  IF before_row.document_ownership_digest IS DISTINCT FROM
    after_row.document_ownership_digest
  THEN
    RAISE EXCEPTION 'sam21_document_ownership_changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leads
    WHERE organization_id <> legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'sam21_lead_not_backfilled_to_legacy_organization';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.crm_daily_funnel_snapshot
    WHERE organization_id <> legacy_organization_id
  ) THEN
    RAISE EXCEPTION 'sam21_snapshot_not_backfilled_to_legacy_organization';
  END IF;
  IF (
    SELECT count(*)
    FROM public.memberships
    WHERE organization_id = legacy_organization_id
      AND status = 'active'
  ) <> (
    SELECT count(*) FROM public.profiles WHERE is_active IS TRUE
  ) THEN
    RAISE EXCEPTION 'sam21_active_profile_membership_count_changed';
  END IF;
END
$$;

SELECT jsonb_build_object(
  'status', 'applied',
  'before', (
    SELECT to_jsonb(evidence) - 'phase'
    FROM public.sam21_rehearsal_evidence evidence
    WHERE phase = 'before'
  ),
  'after', (
    SELECT to_jsonb(evidence) - 'phase'
    FROM public.sam21_rehearsal_evidence evidence
    WHERE phase = 'after'
  ),
  'legacy_leads', (
    SELECT count(*)
    FROM public.leads
    WHERE organization_id =
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ),
  'legacy_snapshots', (
    SELECT count(*)
    FROM public.crm_daily_funnel_snapshot
    WHERE organization_id =
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
  ),
  'active_memberships', (
    SELECT count(*)
    FROM public.memberships
    WHERE organization_id =
      '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1'::uuid
      AND status = 'active'
  )
) AS sam21_apply_evidence;
