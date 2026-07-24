-- =============================================================================
-- NewMe CRM v2.2 — Complete Schema Migration
-- 5 new tables + enhancements + RLS + triggers + views
-- Version: 20260605000000
-- =============================================================================

-- ═══════════════════════════════════════════════════
-- PHASE 1: 新建5表（依赖顺序：products → quotations → contracts → installment_plans → payments）
-- ═══════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  brand TEXT,
  unit TEXT DEFAULT 'pcs',
  unit_price DECIMAL(12,2) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_active ON products(is_active) WHERE is_active = true;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "products_auth_all" ON products FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()));

CREATE TABLE quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE SET NULL,
  customer_id UUID,
  created_by UUID REFERENCES profiles(id),
  quote_no TEXT NOT NULL UNIQUE,
  version INTEGER DEFAULT 1,
  subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_rate DECIMAL(5,2) DEFAULT 0,
  discount_amount DECIMAL(12,2) DEFAULT 0,
  tax_rate DECIMAL(5,2) DEFAULT 5.0,
  tax_amount DECIMAL(12,2) DEFAULT 0,
  total_amount DECIMAL(12,2) NOT NULL,
  currency TEXT DEFAULT 'AED',
  valid_until DATE NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '30 days'),
  payment_terms TEXT,
  delivery_terms TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','sent','accepted','rejected','expired')),
  pdf_url TEXT,
  ppt_url TEXT,
  devices_json JSONB,
  notes TEXT,
  internal_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_quotations_lead ON quotations(lead_id);
CREATE INDEX idx_quotations_creator ON quotations(created_by);
CREATE INDEX idx_quotations_status ON quotations(status);
CREATE INDEX idx_quotations_no ON quotations(quote_no);
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quotations_admin_all" ON quotations FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
CREATE POLICY "quotations_sales_select" ON quotations FOR SELECT
  USING (EXISTS (SELECT 1 FROM leads l WHERE l.id = quotations.lead_id AND l.assigned_to = auth.uid()));
CREATE POLICY "quotations_sales_insert" ON quotations FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'));
CREATE POLICY "quotations_sales_update" ON quotations FOR UPDATE
  USING (created_by = auth.uid());

CREATE TABLE contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE SET NULL,
  quotation_id UUID REFERENCES quotations(id),
  customer_id UUID,
  sales_id UUID REFERENCES profiles(id),
  created_by UUID REFERENCES profiles(id),
  contract_no TEXT NOT NULL UNIQUE,
  contract_date DATE NOT NULL DEFAULT CURRENT_DATE,
  contract_amount DECIMAL(12,2) NOT NULL CHECK (contract_amount > 0),
  currency TEXT DEFAULT 'AED',
  party_a_name TEXT NOT NULL,
  party_a_contact TEXT,
  party_b_name TEXT NOT NULL DEFAULT 'NewMe Smart Home FZCO',
  party_b_contact TEXT,
  file_url TEXT,
  file_metadata JSONB,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','completed','terminated')),
  approval_status TEXT DEFAULT 'none'
    CHECK (approval_status IN ('none','pending','approved','rejected')),
  notes TEXT,
  terminated_reason TEXT,
  terminated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_contracts_lead ON contracts(lead_id);
CREATE INDEX idx_contracts_quotation ON contracts(quotation_id);
CREATE INDEX idx_contracts_customer ON contracts(customer_id);
CREATE INDEX idx_contracts_sales ON contracts(sales_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_date ON contracts(contract_date);
CREATE INDEX idx_contracts_no ON contracts(contract_no);
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contracts_admin_all" ON contracts FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
CREATE POLICY "contracts_sales_select" ON contracts FOR SELECT
  USING (sales_id = auth.uid());
CREATE POLICY "contracts_finance_select" ON contracts FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

CREATE TABLE installment_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','overdue','cancelled')),
  paid_amount DECIMAL(12,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (contract_id, seq)
);
CREATE INDEX idx_installment_contract ON installment_plans(contract_id);
CREATE INDEX idx_installment_status ON installment_plans(status);
CREATE INDEX idx_installment_due ON installment_plans(due_date) WHERE status = 'pending';
ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ip_admin_all" ON installment_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));
CREATE POLICY "ip_sales_select" ON installment_plans FOR SELECT
  USING (EXISTS (SELECT 1 FROM contracts c WHERE c.id = installment_plans.contract_id AND c.sales_id = auth.uid()));

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  installment_plan_id UUID REFERENCES installment_plans(id),
  created_by UUID REFERENCES profiles(id),
  amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  currency TEXT DEFAULT 'AED',
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  received_at TIMESTAMPTZ,
  payment_method TEXT CHECK (payment_method IN ('bank_transfer','cash','cheque','card','other')),
  reference_no TEXT,
  confirmed BOOLEAN DEFAULT false,
  confirmed_by UUID REFERENCES profiles(id),
  confirmed_at TIMESTAMPTZ,
  overpayment_action TEXT CHECK (overpayment_action IN ('refund','credit','adjust')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_payments_contract ON payments(contract_id);
CREATE INDEX idx_payments_installment ON payments(installment_plan_id);
CREATE INDEX idx_payments_date ON payments(payment_date);
CREATE INDEX idx_payments_method ON payments(payment_method);
CREATE INDEX idx_payments_unconfirmed ON payments(confirmed) WHERE confirmed = false;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payments_admin_all" ON payments FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator','finance')));
CREATE POLICY "payments_sales_select" ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM contracts c WHERE c.id = payments.contract_id AND c.sales_id = auth.uid()));

-- ═══════════════════════════════════════════════════
-- PHASE 2: 增强已有表
-- ═══════════════════════════════════════════════════

-- profiles
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin','boss','sales','designer','operator','finance'));
UPDATE profiles SET role = 'admin' WHERE role = 'manager';
UPDATE profiles SET role = 'sales' WHERE role = 'salesperson';
UPDATE profiles SET role = 'operator' WHERE role = 'staff';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES profiles(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(is_active) WHERE is_active = true;

-- leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_id UUID;
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_stage ON leads(assigned_to, stage);

-- customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS unified_profile BOOLEAN DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE customers ADD COLUMN IF NOT EXISTS total_contract_amount DECIMAL(12,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS assigned_sales_id UUID REFERENCES profiles(id);
CREATE INDEX IF NOT EXISTS idx_customers_sales ON customers(assigned_sales_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- activities
ALTER TABLE activities ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS quotation_id UUID REFERENCES quotations(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS duration INTEGER;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT true;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'normal'
  CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE activities ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_type_check
  CHECK (type IN (
    'call','whatsapp','wechat','email','meeting','sms','note','task',
    'quote_sent','follow_up','stage_change','quality_change',
    'contract_signed','payment_received','site_visit','cad_review'
  ));
CREATE INDEX IF NOT EXISTS idx_activities_contract ON activities(contract_id);
CREATE INDEX IF NOT EXISTS idx_activities_quotation ON activities(quotation_id);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_due ON activities(due_at) WHERE is_completed = false;
CREATE INDEX IF NOT EXISTS idx_activities_lead_created ON activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_lead_type ON activities(lead_id, type);

-- projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contracts(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lead_id UUID;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS customer_id UUID;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sales_id UUID REFERENCES profiles(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_manager UUID REFERENCES profiles(id);
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_phase_check;
ALTER TABLE projects ADD CONSTRAINT projects_phase_check
  CHECK (phase IN ('design','procurement','installation','commissioning','handover','warranty','completed'));
CREATE INDEX IF NOT EXISTS idx_projects_contract ON projects(contract_id);
CREATE INDEX IF NOT EXISTS idx_projects_manager ON projects(project_manager);
CREATE INDEX IF NOT EXISTS idx_projects_sales ON projects(sales_id);

-- business_events (先迁移数据再约束)
UPDATE business_events SET event_type = 'stage_change'
  WHERE event_type NOT IN ('stage_change','owner_change','transfer','quotation_sent','quotation_accepted','quotation_rejected','won','lost','contract_activated','contract_completed','payment_recorded');
ALTER TABLE business_events DROP CONSTRAINT IF EXISTS chk_event_type;
ALTER TABLE business_events ADD CONSTRAINT chk_event_type
  CHECK (event_type IN (
    'stage_change','owner_change','transfer',
    'quotation_sent','quotation_accepted','quotation_rejected',
    'won','lost',
    'contract_activated','contract_completed',
    'payment_recorded'
  )) NOT VALID;

-- ═══════════════════════════════════════════════════
-- PHASE 3: RLS 策略（已有表）
-- ═══════════════════════════════════════════════════

-- Helper: SECURITY DEFINER function bypassing RLS recursion
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (SELECT role FROM profiles WHERE id = auth.uid());
END;
$$;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "profiles_select" ON profiles;
CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (true);
DROP POLICY IF EXISTS "profiles_update_self" ON profiles;
CREATE POLICY "profiles_update_self" ON profiles FOR UPDATE
  USING (id = auth.uid()) WITH CHECK (id = auth.uid());
DROP POLICY IF EXISTS "profiles_admin_all" ON profiles;
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','boss')));

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leads_admin_all" ON leads;
CREATE POLICY "leads_admin_all" ON leads FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
DROP POLICY IF EXISTS "leads_sales_see" ON leads;
CREATE POLICY "leads_sales_see" ON leads FOR SELECT USING (assigned_to = auth.uid());
DROP POLICY IF EXISTS "leads_sales_insert" ON leads;
CREATE POLICY "leads_sales_insert" ON leads FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'));
DROP POLICY IF EXISTS "leads_sales_update" ON leads;
CREATE POLICY "leads_sales_update" ON leads FOR UPDATE
  USING (assigned_to = auth.uid()) WITH CHECK (assigned_to = auth.uid());
DROP POLICY IF EXISTS "leads_admin_update" ON leads;
CREATE POLICY "leads_admin_update" ON leads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customers_admin_all" ON customers;
CREATE POLICY "customers_admin_all" ON customers FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
DROP POLICY IF EXISTS "customers_sales_see" ON customers;
CREATE POLICY "customers_sales_see" ON customers FOR SELECT USING (assigned_sales_id = auth.uid());

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "activities_admin_all" ON activities;
CREATE POLICY "activities_admin_all" ON activities FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
DROP POLICY IF EXISTS "activities_sales_select" ON activities;
CREATE POLICY "activities_sales_select" ON activities FOR SELECT
  USING (
    lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    OR contract_id IN (SELECT id FROM contracts WHERE sales_id = auth.uid())
    OR quotation_id IN (SELECT q.id FROM quotations q JOIN leads l ON l.id = q.lead_id AND l.assigned_to = auth.uid())
    OR project_id IN (SELECT id FROM projects WHERE sales_id = auth.uid())
  );
DROP POLICY IF EXISTS "activities_sales_insert" ON activities;
CREATE POLICY "activities_sales_insert" ON activities FOR INSERT
  WITH CHECK (user_id = auth.uid() AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'));
DROP POLICY IF EXISTS "activities_sales_update" ON activities;
CREATE POLICY "activities_sales_update" ON activities FOR UPDATE USING (user_id = auth.uid());

ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "be_admin_all" ON business_events;
CREATE POLICY "be_admin_all" ON business_events FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss')));
DROP POLICY IF EXISTS "be_relevant_select" ON business_events;
CREATE POLICY "be_relevant_select" ON business_events FOR SELECT
  USING (
    lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('operator','finance'))
  );

DROP POLICY IF EXISTS "projects_admin_operator_all" ON projects;
CREATE POLICY "projects_admin_operator_all" ON projects FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','boss','operator')));
DROP POLICY IF EXISTS "projects_sales_see" ON projects;
CREATE POLICY "projects_sales_see" ON projects FOR SELECT
  USING (assigned_to = auth.uid() OR sales_id = auth.uid() OR project_manager = auth.uid());

-- ═══════════════════════════════════════════════════
-- PHASE 4: 触发器
-- ═══════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_installment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_amount DECIMAL(12,2);
  v_contract_id UUID;
  v_total_paid  DECIMAL(12,2);
BEGIN
  IF NEW.confirmed != true OR NEW.installment_plan_id IS NULL THEN RETURN NEW; END IF;
  SELECT ip.amount, ip.contract_id INTO v_plan_amount, v_contract_id
  FROM public.installment_plans ip WHERE ip.id = NEW.installment_plan_id;
  SELECT COALESCE(SUM(amount), 0) INTO v_total_paid
  FROM public.payments WHERE installment_plan_id = NEW.installment_plan_id AND confirmed = true;
  UPDATE public.installment_plans SET paid_amount = v_total_paid, updated_at = now()
  WHERE id = NEW.installment_plan_id;
  IF v_total_paid >= v_plan_amount THEN
    UPDATE public.installment_plans SET status = 'paid', updated_at = now()
    WHERE id = NEW.installment_plan_id AND status = 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.installment_plans
    WHERE contract_id = v_contract_id AND status NOT IN ('paid', 'cancelled')) THEN
    UPDATE public.contracts SET status = 'completed', updated_at = now()
    WHERE id = v_contract_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_payment_after_insert ON payments;
CREATE TRIGGER trg_payment_after_insert
  AFTER INSERT OR UPDATE OF confirmed ON payments
  FOR EACH ROW
  WHEN (NEW.confirmed = true AND NEW.installment_plan_id IS NOT NULL)
  EXECUTE FUNCTION update_installment_status();

-- ═══════════════════════════════════════════════════
-- PHASE 5: 视图
-- ═══════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_funnel_conversion
WITH (security_invoker = true) AS
SELECT stage, COUNT(*) AS lead_count,
  COALESCE(SUM(quotation_value), 0) AS pipeline_value,
  ROUND(COUNT(*)::DECIMAL / NULLIF((SELECT COUNT(*) FROM leads), 0) * 100, 1) AS pct_of_total
FROM leads WHERE NOT COALESCE(disqualified_candidate, false)
GROUP BY stage ORDER BY COUNT(*) DESC;

CREATE OR REPLACE VIEW v_account_receivable_aging
WITH (security_invoker = true) AS
SELECT c.id AS contract_id, c.contract_no, c.contract_amount,
  c.party_a_name AS customer_name, c.sales_id,
  COALESCE(SUM(p.amount) FILTER (WHERE p.confirmed = true), 0) AS total_paid,
  c.contract_amount - COALESCE(SUM(p.amount) FILTER (WHERE p.confirmed = true), 0) AS total_unpaid,
  COUNT(ip.id) FILTER (WHERE ip.status = 'overdue') AS overdue_installments,
  CASE WHEN c.contract_amount > 0
    THEN ROUND(COALESCE(SUM(p.amount) FILTER (WHERE p.confirmed = true), 0) / c.contract_amount * 100, 1)
    ELSE 0 END AS payment_rate
FROM contracts c
LEFT JOIN installment_plans ip ON ip.contract_id = c.id
LEFT JOIN payments p ON p.contract_id = c.id
GROUP BY c.id, c.contract_no, c.contract_amount, c.party_a_name, c.sales_id;

CREATE OR REPLACE VIEW v_sales_personal_stats
WITH (security_invoker = true) AS
SELECT p.id AS user_id, p.full_name,
  COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost')
    AND NOT COALESCE(l.disqualified_candidate, false)) AS active_leads,
  COUNT(l.id) FILTER (WHERE l.stage = 'won') AS won_leads,
  COUNT(l.id) FILTER (WHERE l.stage = 'lost') AS lost_leads,
  COUNT(c.id) AS active_contracts,
  CASE WHEN COUNT(l.id) > 0
    THEN ROUND(COUNT(l.id) FILTER (WHERE l.stage = 'won')::DECIMAL / COUNT(l.id) * 100, 1)
    ELSE 0 END AS conversion_rate
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
LEFT JOIN contracts c ON c.sales_id = p.id AND c.status = 'active'
WHERE p.role = 'sales'
GROUP BY p.id, p.full_name;

CREATE OR REPLACE VIEW v_stagnant_leads
WITH (security_invoker = true) AS
SELECT l.id, l.customer_name, l.stage, l.assigned_to,
  p.full_name AS sales_name, l.created_at,
  (SELECT MAX(a.created_at) FROM activities a WHERE a.lead_id = l.id) AS last_activity_at,
  EXTRACT(DAY FROM now() - COALESCE(
    (SELECT MAX(a.created_at) FROM activities a WHERE a.lead_id = l.id), l.created_at
  )) AS days_inactive
FROM leads l
LEFT JOIN profiles p ON p.id = l.assigned_to
WHERE l.stage NOT IN ('won','lost')
  AND NOT COALESCE(l.disqualified_candidate, false)
  AND EXTRACT(DAY FROM now() - COALESCE(
    (SELECT MAX(a.created_at) FROM activities a WHERE a.lead_id = l.id), l.created_at
  )) > 7
ORDER BY days_inactive DESC;

-- ═══════════════════════════════════════════════════
-- PHASE 6: 清理旧策略
-- ═══════════════════════════════════════════════════
DROP POLICY IF EXISTS "admin_all" ON leads;
DROP POLICY IF EXISTS "leads_manager_all" ON leads;
DROP POLICY IF EXISTS "contracts_manager_all" ON contracts;

NOTIFY pgrst, 'reload schema';
