\set ON_ERROR_STOP on

-- The SAM-23 disposable harness intentionally models only previously governed
-- tables. These minimal legacy contracts let the SAM-78 migration prove that
-- every remaining production table is contracted without widening the old
-- harness or relying on a remote database.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS quality text,
  ADD COLUMN IF NOT EXISTS lead_status text,
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS emirate text,
  ADD COLUMN IF NOT EXISTS property_type text,
  ADD COLUMN IF NOT EXISTS property_size_sqm numeric,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS quotation_value numeric,
  ADD COLUMN IF NOT EXISTS raw_import_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS import_batch_id uuid,
  ADD COLUMN IF NOT EXISTS import_fingerprint text,
  ADD COLUMN IF NOT EXISTS imported_by uuid,
  ADD COLUMN IF NOT EXISTS imported_at timestamptz,
  -- Canonical production includes this via 20260701000008; the reduced
  -- SAM-23 harness does not apply that migration unless mirrored here.
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS next_followup_date timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS no_answer_flag boolean NOT NULL DEFAULT false;
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS final_status text;

-- The production chain applied SAM-22 before SAM-78. The reduced SAM-23
-- harness skips that migration, so mirror its tenant-local idempotency target.
CREATE UNIQUE INDEX IF NOT EXISTS leads_organization_import_fingerprint_unique
  ON public.leads (organization_id, import_fingerprint);

ALTER TABLE public.contracts
  ADD COLUMN IF NOT EXISTS party_b_name text NOT NULL
    DEFAULT 'NewMe Smart Home FZCO',
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS sales_id uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS contract_date date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'AED',
  ADD COLUMN IF NOT EXISTS party_a_contact text,
  ADD COLUMN IF NOT EXISTS first_payment_due_date date,
  ADD COLUMN IF NOT EXISTS approval_status text DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS file_metadata jsonb;
ALTER TABLE public.quotations
  ADD COLUMN IF NOT EXISTS currency text DEFAULT 'AED';
ALTER TABLE public.installment_plans
  ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.contract_approvals
  ADD COLUMN IF NOT EXISTS notes jsonb,
  ADD COLUMN IF NOT EXISTS approver_id uuid,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS customer_id uuid,
  ADD COLUMN IF NOT EXISTS sales_id uuid,
  ADD COLUMN IF NOT EXISTS property_type text,
  ADD COLUMN IF NOT EXISTS property_size numeric,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS phase text,
  ADD COLUMN IF NOT EXISTS contract_amount numeric;
ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'note',
  ADD COLUMN IF NOT EXISTS content text,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS ai_generated boolean DEFAULT false;

CREATE TABLE IF NOT EXISTS public.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid, contract_id uuid, quotation_id uuid, project_id uuid,
  type text NOT NULL DEFAULT 'note'
);
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  user_id uuid, action text NOT NULL DEFAULT 'test'
);
CREATE TABLE IF NOT EXISTS public.ad_spend (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid, action text NOT NULL DEFAULT 'test'
);
CREATE TABLE IF NOT EXISTS public.business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid
);
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid
);
CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid
);
CREATE TABLE IF NOT EXISTS public.follow_up_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  contact_time timestamptz NOT NULL DEFAULT now(),
  contact_type text NOT NULL DEFAULT 'note',
  summary text NOT NULL DEFAULT '',
  user_id uuid,
  no_answer boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.follow_up_logs
  ADD COLUMN IF NOT EXISTS contact_time timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS contact_type text NOT NULL DEFAULT 'note',
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS no_answer boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS public.knx_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.kpi_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period text NOT NULL DEFAULT '2026-01',
  target_type text NOT NULL DEFAULT 'signing',
  target_amount numeric NOT NULL DEFAULT 1,
  assigned_to uuid,
  notes text,
  set_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.kpi_targets
  ADD COLUMN IF NOT EXISTS period text NOT NULL DEFAULT '2026-01',
  ADD COLUMN IF NOT EXISTS target_type text NOT NULL DEFAULT 'signing',
  ADD COLUMN IF NOT EXISTS target_amount numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS assigned_to uuid,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS set_by uuid,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS public.lead_assignment_state (
  id integer PRIMARY KEY DEFAULT 1
);
CREATE TABLE IF NOT EXISTS public.lead_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.lead_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.lead_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.lead_mutation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.lead_workflow_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  body text,
  related_id uuid,
  related_type text,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'info',
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Notification',
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS related_id uuid,
  ADD COLUMN IF NOT EXISTS related_type text,
  ADD COLUMN IF NOT EXISTS is_read boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Dedicated non-admin principal retained through the rollback-only phase so
-- the restored authenticated self-insert ACL/policy can be exercised without
-- depending on the full lifecycle fixture, which that phase intentionally skips.
INSERT INTO auth.users(id) VALUES
  ('78000000-0088-4000-8000-000000000088')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.profiles(id, role, is_active) VALUES
  ('78000000-0088-4000-8000-000000000088', 'sales', true)
ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid, project_id uuid
);
CREATE TABLE IF NOT EXISTS public.transfer_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS public.user_session_daily (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  user_id uuid
);

-- The original activity schema used the all-zero UUID as its single-tenant
-- sentinel. Preserve that historical value while proving V4 assigns the
-- legacy organization only to the new ownership column.
INSERT INTO public.organizations(id, slug, name, industry_key, status) VALUES (
  '00000000-0000-0000-0000-000000000000',
  'legacy-zero-tenant-sentinel',
  'Disposable legacy zero tenant sentinel',
  'real_estate',
  'active'
) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.activity_logs(id, tenant_id, user_id, action) VALUES (
  '78000000-3088-4000-8000-000000000088',
  '00000000-0000-0000-0000-000000000000',
  '78000000-0088-4000-8000-000000000088',
  'legacy_zero_tenant_activity'
) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_session_daily(id, tenant_id, user_id) VALUES (
  '78000000-3288-4000-8000-000000000088',
  '00000000-0000-0000-0000-000000000000',
  '78000000-0088-4000-8000-000000000088'
) ON CONFLICT (id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.activities, public.activity_logs, public.ad_spend, public.audit_logs,
  public.business_events, public.chat_messages, public.customers,
  public.follow_up_logs, public.knx_designs, public.kpi_targets,
  public.lead_assignment_state, public.lead_deletion_requests,
  public.lead_files, public.lead_milestones, public.lead_mutation_requests,
  public.lead_workflow_stages, public.notifications, public.quotes,
  public.transfer_history, public.user_session_daily
TO authenticated, service_role;

-- Load the exact legacy read-policy shapes that V4 replaces. The reduced
-- SAM-23 harness otherwise has only blanket harness policies and could not
-- prove that organization roles are independent from profiles.role.
DROP POLICY IF EXISTS harness_leads_all ON public.leads;
DROP POLICY IF EXISTS harness_contracts_all ON public.contracts;
DROP POLICY IF EXISTS harness_payments_all ON public.payments;
CREATE POLICY policy_leads_select_admin
  ON public.leads FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
  ));
CREATE POLICY policy_leads_select_sales
  ON public.leads FOR SELECT TO authenticated
  USING (assigned_to = auth.uid());
CREATE POLICY policy_contracts_select_admin
  ON public.contracts FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
  ));
CREATE POLICY policy_contracts_select_sales
  ON public.contracts FOR SELECT TO authenticated
  USING (sales_id = auth.uid());
CREATE POLICY policy_payments_select_admin
  ON public.payments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator', 'finance')
  ));
CREATE POLICY policy_payments_select_sales
  ON public.payments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.contracts contract
    WHERE contract.id = payments.contract_id AND contract.sales_id = auth.uid()
  ));

DROP POLICY IF EXISTS harness_notifications_all ON public.notifications;
DROP POLICY IF EXISTS harness_kpi_targets_all ON public.kpi_targets;
CREATE POLICY policy_notifications_select_self
  ON public.notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_notifications_select_admin
  ON public.notifications FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss')
  ));
CREATE POLICY policy_notifications_insert_system
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY policy_notifications_insert_admin
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));
CREATE POLICY policy_notifications_update_self
  ON public.notifications FOR UPDATE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_notifications_delete_self
  ON public.notifications FOR DELETE TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY policy_kpi_targets_select_admin
  ON public.kpi_targets FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('admin', 'boss', 'operator')
  ));
CREATE POLICY policy_kpi_targets_select_sales
  ON public.kpi_targets FOR SELECT TO authenticated
  USING (assigned_to = auth.uid() OR assigned_to IS NULL);

-- Canonical legacy contract numbering proves the V4 organization/date sequence
-- starts after the highest deployed suffix instead of restarting at one.
INSERT INTO public.leads (
  id, organization_id, customer_name, source, stage, quality, lead_status
) VALUES (
  '78000000-1090-4000-8000-000000000090',
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  'SAM-78 legacy sequence seed', 'offline', 'new', 'pending', 'pending'
);
INSERT INTO public.contracts (
  id, organization_id, lead_id, contract_no, contract_date,
  contract_amount, party_a_name, party_b_name, status
) VALUES (
  '78000000-2090-4000-8000-000000000090',
  '6bc3b06e-5c05-4f45-9f1f-e9ea03a3cdd1',
  '78000000-1090-4000-8000-000000000090',
  'NEW-20260802-007', DATE '2026-08-02', 700,
  'Legacy sequence seed', 'NewMe', 'archived'
);
