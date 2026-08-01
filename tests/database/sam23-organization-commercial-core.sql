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
  document_type text NOT NULL DEFAULT 'other',
  file_name text NOT NULL,
  file_url text NOT NULL,
  file_size bigint NULL,
  uploaded_by uuid NULL REFERENCES public.profiles(id),
  notes text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.lead_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  milestone_key text NULL
);
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  title text NOT NULL,
  assignee_id uuid NULL REFERENCES public.profiles(id),
  due_at timestamptz NOT NULL DEFAULT now() + interval '1 day',
  status text NOT NULL DEFAULT 'pending',
  source text NULL DEFAULT 'manual',
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW public.v_lead_trace AS
SELECT id AS lead_id FROM public.leads;

CREATE TABLE public.quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  customer_id uuid NULL,
  created_by uuid NULL REFERENCES public.profiles(id),
  quote_no text NOT NULL UNIQUE,
  subtotal numeric NOT NULL DEFAULT 0,
  total_amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  contract_id uuid NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  quotation_id uuid NULL REFERENCES public.quotations(id),
  contract_no text NOT NULL UNIQUE,
  contract_amount numeric NOT NULL CHECK (contract_amount > 0),
  party_a_name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.quotations
  ADD CONSTRAINT quotations_contract_id_fkey
  FOREIGN KEY (contract_id) REFERENCES public.contracts(id);
CREATE TABLE public.installment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (contract_id, seq)
);
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  installment_plan_id uuid NULL REFERENCES public.installment_plans(id),
  created_by uuid NULL REFERENCES public.profiles(id),
  amount numeric NOT NULL CHECK (amount > 0),
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  confirmed boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.contract_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT
    '00000000-0000-0000-0000-000000000000'::uuid,
  contract_id uuid NOT NULL REFERENCES public.contracts(id) ON DELETE CASCADE,
  step text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT
    '00000000-0000-0000-0000-000000000000'::uuid,
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES public.installment_plans(id) ON DELETE CASCADE,
  amount_allocated numeric NOT NULL CHECK (amount_allocated > 0),
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  lead_id uuid NULL REFERENCES public.leads(id),
  contract_id uuid NULL REFERENCES public.contracts(id),
  status text DEFAULT 'active',
  paid_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY harness_profiles_read
  ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY harness_leads_all
  ON public.leads FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads
  TO authenticated, service_role;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'activities',
    'business_events',
    'chat_messages',
    'follow_up_logs',
    'lead_documents',
    'lead_milestones',
    'tasks',
    'quotations',
    'contracts',
    'installment_plans',
    'payments',
    'contract_approvals',
    'payment_allocations',
    'projects'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY harness_%I_all ON public.%I
       FOR ALL TO authenticated USING (true) WITH CHECK (true)',
      table_name,
      table_name
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I
       TO authenticated, service_role',
      table_name
    );
  END LOOP;
END
$$;

INSERT INTO auth.users(id)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1'),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'),
  ('ffffffff-ffff-4fff-8fff-fffffffffff1'),
  ('99999999-9999-4999-8999-999999999991'),
  ('88888888-8888-4888-8888-888888888881');
INSERT INTO public.profiles(id, role, is_active)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'boss', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'boss', true),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'sales', true),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'finance', true),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 'sales', true),
  ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'operator', true),
  ('99999999-9999-4999-8999-999999999991', 'designer', true),
  ('88888888-8888-4888-8888-888888888881', 'sales', true);

\ir ../../supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql
\ir ../../supabase/migrations/20260730231446_sam23_organization_owned_commercial_core.sql
\ir ../../supabase/migrations/20260731015812_sam23_govern_billable_seat_rpcs.sql
\ir ../../supabase/migrations/20260801023000_sam25_allow_rls_safe_commercial_updates.sql
\ir ../../supabase/migrations/20260801025500_sam25_sync_project_paid_amount.sql

DO $$
DECLARE
  gate jsonb := public.security_definer_rpc_allowlist_gate();
BEGIN
  IF pg_catalog.has_function_privilege(
    'anon',
    'public.organization_billable_seat_count(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anonymous billable-seat count execution remained';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.organization_billable_seat_count(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated billable-seat count execution missing';
  END IF;
  IF pg_catalog.has_function_privilege(
    'anon',
    'public.sam23_enforce_billable_seat_limit()',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.sam23_enforce_billable_seat_limit()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'billable-seat trigger function remained API executable';
  END IF;
  IF gate ->> 'gate_version' <> 'sam61-allowlist-v3' THEN
    RAISE EXCEPTION 'unexpected SECURITY DEFINER allowlist gate version';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(gate -> 'violations') violation
    WHERE violation ->> 'regprocedure' IN (
      'organization_billable_seat_count(uuid)',
      'sam23_enforce_billable_seat_limit()'
    )
  ) THEN
    RAISE EXCEPTION 'SAM-23 SECURITY DEFINER gate violation remained';
  END IF;
END
$$;

SET ROLE service_role;

CREATE TEMP TABLE sam23_ids (
  key text PRIMARY KEY,
  value uuid NOT NULL
);

DO $$
DECLARE
  first_result jsonb;
  repeated_result jsonb;
  second_result jsonb;
BEGIN
  first_result := public.initialize_organization(
    'sam23:org-a:0001',
    'sam23-org-a',
    'SAM-23 Organization A',
    'real_estate',
    'starter',
    5,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  );
  repeated_result := public.initialize_organization(
    'sam23:org-a:0001',
    'sam23-org-a',
    'SAM-23 Organization A',
    'real_estate',
    'starter',
    5,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  );
  IF first_result IS DISTINCT FROM repeated_result THEN
    RAISE EXCEPTION 'idempotent organization result changed';
  END IF;

  second_result := public.initialize_organization(
    'sam23:org-b:0001',
    'sam23-org-b',
    'SAM-23 Organization B',
    'retail',
    'growth',
    20,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
  );

  INSERT INTO sam23_ids(key, value)
  VALUES
    ('org_a', (first_result ->> 'organization_id')::uuid),
    ('membership_a', (first_result ->> 'owner_membership_id')::uuid),
    ('org_b', (second_result ->> 'organization_id')::uuid),
    ('membership_b', (second_result ->> 'owner_membership_id')::uuid);

  BEGIN
    PERFORM public.initialize_organization(
      'sam23:org-a:0001',
      'sam23-org-a',
      'Changed payload',
      'real_estate',
      'starter',
      5,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    );
    RAISE EXCEPTION 'mismatched idempotency payload accepted';
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM <> 'organization_idempotency_payload_mismatch' THEN
        RAISE;
      END IF;
  END;
END
$$;

DO $$
DECLARE
  org_a uuid := (SELECT value FROM sam23_ids WHERE key = 'org_a');
  org_b uuid := (SELECT value FROM sam23_ids WHERE key = 'org_b');
  viewer_membership uuid := gen_random_uuid();
  finance_membership uuid := gen_random_uuid();
  third_membership uuid := gen_random_uuid();
  fourth_membership uuid := gen_random_uuid();
  overflow_membership uuid := gen_random_uuid();
  cross_org_membership uuid := gen_random_uuid();
  viewer_role uuid;
  finance_role uuid;
  manager_role uuid;
  seat_count integer;
BEGIN
  SELECT id INTO viewer_role FROM public.roles
  WHERE scope = 'organization' AND role_key = 'viewer';
  SELECT id INTO finance_role FROM public.roles
  WHERE scope = 'organization' AND role_key = 'finance';
  SELECT id INTO manager_role FROM public.roles
  WHERE scope = 'organization' AND role_key = 'manager';

  INSERT INTO public.memberships(
    id, organization_id, user_id, status, accepted_at
  )
  VALUES
    (
      viewer_membership,
      org_a,
      'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
      'active',
      now()
    ),
    (
      finance_membership,
      org_a,
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
      'active',
      now()
    ),
    (
      third_membership,
      org_a,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
      'active',
      now()
    ),
    (
      fourth_membership,
      org_a,
      'ffffffff-ffff-4fff-8fff-fffffffffff1',
      'active',
      now()
    ),
    (
      overflow_membership,
      org_a,
      '99999999-9999-4999-8999-999999999991',
      'active',
      now()
    ),
    (
      cross_org_membership,
      org_b,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      'active',
      now()
    );

  INSERT INTO public.membership_roles(membership_id, role_id)
  VALUES (viewer_membership, viewer_role);
  IF public.organization_billable_seat_count(org_a) <> 1 THEN
    RAISE EXCEPTION 'viewer changed billable seats';
  END IF;

  INSERT INTO public.membership_roles(membership_id, role_id)
  VALUES
    (finance_membership, finance_role),
    (third_membership, finance_role),
    (fourth_membership, finance_role);
  IF public.organization_billable_seat_count(org_a) <> 4 THEN
    RAISE EXCEPTION 'billable role count mismatch before multi-role';
  END IF;

  INSERT INTO public.membership_roles(membership_id, role_id)
  VALUES (finance_membership, manager_role);
  IF public.organization_billable_seat_count(org_a) <> 4 THEN
    RAISE EXCEPTION 'multiple billable roles double counted';
  END IF;

  INSERT INTO public.membership_roles(membership_id, role_id)
  VALUES (overflow_membership, finance_role);
  IF public.organization_billable_seat_count(org_a) <> 5 THEN
    RAISE EXCEPTION 'fifth billable seat was not counted';
  END IF;

  UPDATE public.memberships
  SET status = 'suspended'
  WHERE id = finance_membership;
  IF public.organization_billable_seat_count(org_a) <> 4 THEN
    RAISE EXCEPTION 'suspended membership did not release seat';
  END IF;
  UPDATE public.memberships
  SET status = 'active'
  WHERE id = finance_membership;
  IF public.organization_billable_seat_count(org_a) <> 5 THEN
    RAISE EXCEPTION 'reactivated membership did not restore seat';
  END IF;

  INSERT INTO public.membership_roles(membership_id, role_id)
  VALUES (cross_org_membership, finance_role);
  IF public.organization_billable_seat_count(org_b) <> 2 THEN
    RAISE EXCEPTION 'same user second organization seat not counted';
  END IF;

  INSERT INTO public.memberships(
    id, organization_id, user_id, status, accepted_at
  )
  VALUES (
    gen_random_uuid(),
    org_a,
    '88888888-8888-4888-8888-888888888881',
    'active',
    now()
  )
  RETURNING id INTO overflow_membership;

  BEGIN
    INSERT INTO public.membership_roles(membership_id, role_id)
    VALUES (overflow_membership, finance_role);
    RAISE EXCEPTION 'seat limit overflow accepted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <> 'billable_seat_limit_reached' THEN
        RAISE;
      END IF;
  END;

  INSERT INTO sam23_ids(key, value)
  VALUES
    ('viewer_membership', viewer_membership),
    ('finance_membership', finance_membership),
    ('third_membership', third_membership),
    ('fourth_membership', fourth_membership),
    ('fifth_membership', overflow_membership),
    ('cross_org_membership', cross_org_membership);
END
$$;

RESET ROLE;

INSERT INTO public.leads(id, organization_id, source, assigned_to, notes)
VALUES
  (
    'aaaaaaaa-0000-4000-8000-000000000023',
    (SELECT value FROM sam23_ids WHERE key = 'org_a'),
    'offline',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'sam23-org-a'
  ),
  (
    'bbbbbbbb-0000-4000-8000-000000000023',
    (SELECT value FROM sam23_ids WHERE key = 'org_b'),
    'offline',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    'sam23-org-b'
  );

INSERT INTO public.quotations(
  id, lead_id, quote_no, total_amount, status
)
VALUES
  (
    'aaaaaaaa-1000-4000-8000-000000000023',
    'aaaaaaaa-0000-4000-8000-000000000023',
    'SAM23-SHARED-QUOTE',
    1000,
    'accepted'
  ),
  (
    'bbbbbbbb-1000-4000-8000-000000000023',
    'bbbbbbbb-0000-4000-8000-000000000023',
    'SAM23-SHARED-QUOTE',
    2000,
    'accepted'
  );
INSERT INTO public.contracts(
  id, lead_id, quotation_id, contract_no, contract_amount, party_a_name, status
)
VALUES
  (
    'aaaaaaaa-2000-4000-8000-000000000023',
    'aaaaaaaa-0000-4000-8000-000000000023',
    'aaaaaaaa-1000-4000-8000-000000000023',
    'SAM23-SHARED-CONTRACT',
    1000,
    'Synthetic A',
    'active'
  ),
  (
    'bbbbbbbb-2000-4000-8000-000000000023',
    'bbbbbbbb-0000-4000-8000-000000000023',
    'bbbbbbbb-1000-4000-8000-000000000023',
    'SAM23-SHARED-CONTRACT',
    2000,
    'Synthetic B',
    'active'
  );
UPDATE public.quotations
SET contract_id = CASE id
  WHEN 'aaaaaaaa-1000-4000-8000-000000000023'::uuid
    THEN 'aaaaaaaa-2000-4000-8000-000000000023'::uuid
  ELSE 'bbbbbbbb-2000-4000-8000-000000000023'::uuid
END;
INSERT INTO public.installment_plans(
  id, contract_id, seq, amount, due_date
)
VALUES
  (
    'aaaaaaaa-3000-4000-8000-000000000023',
    'aaaaaaaa-2000-4000-8000-000000000023',
    1,
    1000,
    CURRENT_DATE
  ),
  (
    'bbbbbbbb-3000-4000-8000-000000000023',
    'bbbbbbbb-2000-4000-8000-000000000023',
    1,
    2000,
    CURRENT_DATE
  );
INSERT INTO public.payments(
  id, contract_id, installment_plan_id, amount, confirmed
)
VALUES
  (
    'aaaaaaaa-4000-4000-8000-000000000023',
    'aaaaaaaa-2000-4000-8000-000000000023',
    'aaaaaaaa-3000-4000-8000-000000000023',
    1000,
    false
  ),
  (
    'bbbbbbbb-4000-4000-8000-000000000023',
    'bbbbbbbb-2000-4000-8000-000000000023',
    'bbbbbbbb-3000-4000-8000-000000000023',
    2000,
    true
  );
INSERT INTO public.contract_approvals(id, contract_id, step, status)
VALUES
  (
    'aaaaaaaa-5000-4000-8000-000000000023',
    'aaaaaaaa-2000-4000-8000-000000000023',
    'admin_review',
    'approved'
  ),
  (
    'bbbbbbbb-5000-4000-8000-000000000023',
    'bbbbbbbb-2000-4000-8000-000000000023',
    'admin_review',
    'approved'
  );
INSERT INTO public.payment_allocations(
  id, payment_id, plan_id, amount_allocated
)
VALUES
  (
    'aaaaaaaa-6000-4000-8000-000000000023',
    'aaaaaaaa-4000-4000-8000-000000000023',
    'aaaaaaaa-3000-4000-8000-000000000023',
    1000
  ),
  (
    'bbbbbbbb-6000-4000-8000-000000000023',
    'bbbbbbbb-4000-4000-8000-000000000023',
    'bbbbbbbb-3000-4000-8000-000000000023',
    2000
  );
INSERT INTO public.projects(id, name, lead_id, contract_id)
VALUES
  (
    'aaaaaaaa-7000-4000-8000-000000000023',
    'Synthetic project A',
    'aaaaaaaa-0000-4000-8000-000000000023',
    'aaaaaaaa-2000-4000-8000-000000000023'
  ),
  (
    'bbbbbbbb-7000-4000-8000-000000000023',
    'Synthetic project B',
    'bbbbbbbb-0000-4000-8000-000000000023',
    'bbbbbbbb-2000-4000-8000-000000000023'
  );
INSERT INTO public.tasks(id, lead_id, title, assignee_id)
VALUES
  (
    'aaaaaaaa-8000-4000-8000-000000000023',
    'aaaaaaaa-0000-4000-8000-000000000023',
    'Synthetic task A',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  ),
  (
    'bbbbbbbb-8000-4000-8000-000000000023',
    'bbbbbbbb-0000-4000-8000-000000000023',
    'Synthetic task B',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
  );
INSERT INTO public.lead_documents(
  id, lead_id, document_type, file_name, file_url
)
VALUES
  (
    'aaaaaaaa-9000-4000-8000-000000000023',
    'aaaaaaaa-0000-4000-8000-000000000023',
    'contract',
    'sam23-a.pdf',
    'synthetic://sam23/org-a/document'
  ),
  (
    'bbbbbbbb-9000-4000-8000-000000000023',
    'bbbbbbbb-0000-4000-8000-000000000023',
    'contract',
    'sam23-b.pdf',
    'synthetic://sam23/org-b/document'
  );

DO $$
BEGIN
  BEGIN
    INSERT INTO public.contracts(
      lead_id,
      quotation_id,
      contract_no,
      contract_amount,
      party_a_name
    )
    VALUES (
      'aaaaaaaa-0000-4000-8000-000000000023',
      'bbbbbbbb-1000-4000-8000-000000000023',
      'SAM23-CROSS-ORG',
      1,
      'Forbidden'
    );
    RAISE EXCEPTION 'cross-organization contract accepted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <> 'commercial_cross_organization_parent' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO public.tasks(lead_id, title, assignee_id)
    VALUES (
      'aaaaaaaa-0000-4000-8000-000000000023',
      'Forbidden assignee',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
    );
    RAISE EXCEPTION 'cross-organization task assignee accepted';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM <>
        'task_assignee_active_organization_membership_required'
      THEN
        RAISE;
      END IF;
  END;
END
$$;

RESET ROLE;
SELECT value::text AS org_a
FROM sam23_ids
WHERE key = 'org_a'
\gset
SET ROLE authenticated;
SET request.jwt.claim.sub =
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', :'org_a')::text,
  false
);

DO $$
DECLARE
  affected_count integer;
  is_confirmed boolean;
BEGIN
  UPDATE public.contracts
  SET status = status
  WHERE id = 'aaaaaaaa-2000-4000-8000-000000000023';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'finance contract update count %, expected 1', affected_count;
  END IF;

  UPDATE public.payments
  SET confirmed = true
  WHERE id = 'aaaaaaaa-4000-4000-8000-000000000023';
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> 1 THEN
    RAISE EXCEPTION 'finance payment update count %, expected 1', affected_count;
  END IF;

  SELECT confirmed INTO is_confirmed
  FROM public.payments
  WHERE id = 'aaaaaaaa-4000-4000-8000-000000000023';
  IF is_confirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'finance payment confirmation was not persisted';
  END IF;
  IF (
    SELECT paid_amount
    FROM public.projects
    WHERE id = 'aaaaaaaa-7000-4000-8000-000000000023'
  ) IS DISTINCT FROM 1000::numeric THEN
    RAISE EXCEPTION 'finance payment confirmation did not sync project';
  END IF;
END
$$;

SET request.jwt.claim.sub =
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
SELECT set_config(
  'request.headers',
  jsonb_build_object('x-newme-organization-id', :'org_a')::text,
  false
);

DO $$
DECLARE
  visible_count integer;
  summary_row record;
BEGIN
  SELECT count(*) INTO visible_count FROM public.quotations;
  IF visible_count <> 1 THEN
    RAISE EXCEPTION 'org A quotation count %, expected 1', visible_count;
  END IF;
  SELECT count(*) INTO visible_count
  FROM public.quotations
  WHERE id = 'bbbbbbbb-1000-4000-8000-000000000023';
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'org A direct-read org B quotation';
  END IF;
  SELECT * INTO summary_row
  FROM public.v_sam23_organization_commercial_summary;
  IF summary_row.quotation_count <> 1
    OR summary_row.contract_count <> 1
    OR summary_row.confirmed_payment_amount <> 1000
    OR summary_row.project_count <> 1
    OR summary_row.task_count <> 1
    OR summary_row.document_count <> 1
  THEN
    RAISE EXCEPTION 'org A commercial summary mismatch';
  END IF;
END
$$;

DO $$
DECLARE
  residue_count integer;
BEGIN
  BEGIN
    INSERT INTO public.quotations(lead_id, quote_no, total_amount)
    VALUES (
      'bbbbbbbb-0000-4000-8000-000000000023',
      'SAM23-RLS-CROSS-ORG',
      1
    );
    RAISE EXCEPTION 'org A inserted org B quotation';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN foreign_key_violation THEN
      IF SQLERRM <> 'commercial_parent_organization_missing' THEN
        RAISE;
      END IF;
  END;

  SELECT count(*) INTO residue_count
  FROM public.quotations
  WHERE quote_no = 'SAM23-RLS-CROSS-ORG';
  IF residue_count <> 0 THEN
    RAISE EXCEPTION 'cross-organization quotation denial left residue';
  END IF;
END
$$;

SET request.headers = '{}';
DO $$
DECLARE
  visible_count integer;
BEGIN
  SELECT count(*) INTO visible_count FROM public.contracts;
  IF visible_count <> 0 THEN
    RAISE EXCEPTION 'missing organization context exposed contracts';
  END IF;
END
$$;
RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.headers;

SET ROLE service_role;
DELETE FROM public.lead_documents
WHERE id IN (
  'aaaaaaaa-9000-4000-8000-000000000023',
  'bbbbbbbb-9000-4000-8000-000000000023'
);
DELETE FROM public.tasks
WHERE id IN (
  'aaaaaaaa-8000-4000-8000-000000000023',
  'bbbbbbbb-8000-4000-8000-000000000023'
);
DELETE FROM public.projects
WHERE id IN (
  'aaaaaaaa-7000-4000-8000-000000000023',
  'bbbbbbbb-7000-4000-8000-000000000023'
);
DELETE FROM public.payment_allocations
WHERE id IN (
  'aaaaaaaa-6000-4000-8000-000000000023',
  'bbbbbbbb-6000-4000-8000-000000000023'
);
DELETE FROM public.contract_approvals
WHERE id IN (
  'aaaaaaaa-5000-4000-8000-000000000023',
  'bbbbbbbb-5000-4000-8000-000000000023'
);
DELETE FROM public.payments
WHERE id IN (
  'aaaaaaaa-4000-4000-8000-000000000023',
  'bbbbbbbb-4000-4000-8000-000000000023'
);
UPDATE public.quotations SET contract_id = NULL
WHERE id IN (
  'aaaaaaaa-1000-4000-8000-000000000023',
  'bbbbbbbb-1000-4000-8000-000000000023'
);
DELETE FROM public.installment_plans
WHERE id IN (
  'aaaaaaaa-3000-4000-8000-000000000023',
  'bbbbbbbb-3000-4000-8000-000000000023'
);
DELETE FROM public.contracts
WHERE id IN (
  'aaaaaaaa-2000-4000-8000-000000000023',
  'bbbbbbbb-2000-4000-8000-000000000023'
);
DELETE FROM public.quotations
WHERE id IN (
  'aaaaaaaa-1000-4000-8000-000000000023',
  'bbbbbbbb-1000-4000-8000-000000000023'
);
DELETE FROM public.leads
WHERE id IN (
  'aaaaaaaa-0000-4000-8000-000000000023',
  'bbbbbbbb-0000-4000-8000-000000000023'
);
DELETE FROM public.audit_events
WHERE organization_id IN (
  (SELECT value FROM sam23_ids WHERE key = 'org_a'),
  (SELECT value FROM sam23_ids WHERE key = 'org_b')
);
DELETE FROM public.organization_provisioning_requests
WHERE idempotency_key IN ('sam23:org-a:0001', 'sam23:org-b:0001');
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT membership.id
  FROM public.memberships membership
  WHERE membership.organization_id IN (
    (SELECT value FROM sam23_ids WHERE key = 'org_a'),
    (SELECT value FROM sam23_ids WHERE key = 'org_b')
  )
);
DELETE FROM public.memberships
WHERE organization_id IN (
  (SELECT value FROM sam23_ids WHERE key = 'org_a'),
  (SELECT value FROM sam23_ids WHERE key = 'org_b')
);
DELETE FROM public.organizations
WHERE id IN (
  (SELECT value FROM sam23_ids WHERE key = 'org_a'),
  (SELECT value FROM sam23_ids WHERE key = 'org_b')
);
RESET ROLE;
DELETE FROM public.membership_roles
WHERE membership_id IN (
  SELECT id
  FROM public.memberships
  WHERE user_id = '88888888-8888-4888-8888-888888888881'
);
DELETE FROM public.memberships
WHERE user_id = '88888888-8888-4888-8888-888888888881';
DELETE FROM public.profiles
WHERE id = '88888888-8888-4888-8888-888888888881';
DELETE FROM auth.users
WHERE id = '88888888-8888-4888-8888-888888888881';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organizations
    WHERE slug IN ('sam23-org-a', 'sam23-org-b')
  ) OR EXISTS (
    SELECT 1 FROM public.organization_provisioning_requests
    WHERE idempotency_key LIKE 'sam23:%'
  ) OR EXISTS (
    SELECT 1 FROM public.quotations
    WHERE quote_no LIKE 'SAM23-%'
  ) OR EXISTS (
    SELECT 1 FROM public.contracts
    WHERE contract_no LIKE 'SAM23-%'
  ) THEN
    RAISE EXCEPTION 'SAM-23 fixture cleanup failed';
  END IF;
END
$$;

SELECT 'SAM-23 organization, seats, commercial RLS, and cleanup passed'
  AS result;
