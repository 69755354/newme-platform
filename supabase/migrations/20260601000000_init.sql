-- ================================================
-- NewMe 业务平台 — 数据库初始化 (Phase 1)
-- Supabase PostgreSQL
-- ================================================

-- 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ═══════════════ 用户表 (接 Supabase Auth) ═══════════════
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role          TEXT DEFAULT 'sales' CHECK (role IN ('admin','manager','sales','designer')),
  full_name     TEXT,
  phone         TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 新用户自动创建 profile
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ═══════════════ Leads ═══════════════
CREATE TABLE leads (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source         TEXT NOT NULL CHECK (source IN ('meta_ads','whatsapp','website','offline','referral','other')),
  meta_click_id  TEXT,
  meta_campaign  TEXT,
  meta_ad_id     TEXT,
  
  -- 状态
  quality        TEXT DEFAULT 'pending' CHECK (quality IN ('pending','valid','job_seeker','fake','duplicate')),
  stage          TEXT DEFAULT 'new' CHECK (stage IN ('new','contacted','needs_analysis','quoted','negotiating','won','lost')),
  
  -- 客户信息 (逐步补充)
  customer_name  TEXT,
  phone          TEXT,
  email          TEXT,
  property_type  TEXT,
  property_size_sqm INTEGER,
  location       TEXT,
  budget_range   TEXT,
  service_needs  TEXT[],
  
  -- AI 提取
  ai_summary     TEXT,
  ai_tags        TEXT[],
  ai_quality     TEXT CHECK (ai_quality IN ('hot','warm','cold')),
  
  -- 分配
  assigned_to    UUID REFERENCES profiles(id),
  
  -- 时间
  converted_at   TIMESTAMPTZ,
  lost_at        TIMESTAMPTZ,
  lost_reason    TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════ WhatsApp 聊天 ═══════════════
CREATE TABLE chat_messages (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID REFERENCES leads(id) ON DELETE CASCADE,
  wa_message_id  TEXT UNIQUE,
  direction      TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number    TEXT,
  to_number      TEXT,
  content        TEXT,
  media_url      TEXT,
  media_type     TEXT,
  
  -- AI 提取
  extracted      JSONB,
  
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_chat_lead_id ON chat_messages(lead_id);
CREATE INDEX idx_chat_sent_at ON chat_messages(sent_at);

-- ═══════════════ 客户 ═══════════════
CREATE TABLE customers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID REFERENCES leads(id),
  name           TEXT NOT NULL,
  phone          TEXT,
  email          TEXT,
  whatsapp       TEXT,
  address        TEXT,
  notes          TEXT,
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════ 项目 ═══════════════
CREATE TABLE projects (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID REFERENCES customers(id),
  name           TEXT NOT NULL,
  property_type  TEXT,
  property_size  INTEGER,
  location       TEXT,
  
  -- 阶段
  phase          TEXT DEFAULT 'design' CHECK (phase IN ('design','procurement','installation','commissioning','handover','warranty')),
  status         TEXT DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','cancelled')),
  
  -- 文件 (COS URLs)
  cad_url        TEXT,
  quote_url      TEXT,
  ppt_url        TEXT,
  contract_url   TEXT,
  
  -- 金额 (AED)
  quoted_amount  DECIMAL(12,2),
  contract_amount DECIMAL(12,2),
  paid_amount    DECIMAL(12,2) DEFAULT 0,
  
  assigned_to    UUID REFERENCES profiles(id),
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════ 报价单 ═══════════════
CREATE TABLE quotes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID REFERENCES projects(id),
  lead_id        UUID REFERENCES leads(id),
  version        INTEGER DEFAULT 1,
  
  devices        JSONB,
  device_details JSONB,
  total_amount   DECIMAL(12,2),
  
  generated_by   TEXT DEFAULT 'hermes',
  status         TEXT DEFAULT 'draft' CHECK (status IN ('draft','sent','approved','rejected')),
  
  quote_url      TEXT,
  ppt_url        TEXT,
  
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════ 跟进活动 ═══════════════
CREATE TABLE activities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        UUID REFERENCES leads(id) ON DELETE CASCADE,
  customer_id    UUID REFERENCES customers(id),
  project_id     UUID REFERENCES projects(id),
  user_id        UUID REFERENCES profiles(id),
  
  type           TEXT NOT NULL CHECK (type IN ('call','whatsapp','email','meeting','quote_sent','follow_up','note','stage_change','quality_change')),
  content        TEXT,
  ai_generated   BOOLEAN DEFAULT false,
  
  created_at     TIMESTAMPTZ DEFAULT now()
);

-- ═══════════════ 索引 ═══════════════
CREATE INDEX idx_leads_quality   ON leads(quality);
CREATE INDEX idx_leads_stage     ON leads(stage);
CREATE INDEX idx_leads_assigned  ON leads(assigned_to);
CREATE INDEX idx_leads_source    ON leads(source);
CREATE INDEX idx_leads_created   ON leads(created_at DESC);
CREATE INDEX idx_leads_updated   ON leads(updated_at DESC);
CREATE INDEX idx_leads_quality_stage ON leads(quality, stage);
CREATE INDEX idx_projects_customer ON projects(customer_id);
CREATE INDEX idx_projects_phase   ON projects(phase);
CREATE INDEX idx_quotes_project   ON quotes(project_id);
CREATE INDEX idx_quotes_lead      ON quotes(lead_id);
CREATE INDEX idx_activities_lead  ON activities(lead_id);
CREATE INDEX idx_activities_created ON activities(created_at DESC);

-- ═══════════════ RLS 策略 ═══════════════
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 管理层全部可看
CREATE POLICY "admin_all" ON leads FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

-- 销售看自己的 leads
CREATE POLICY "sales_own_leads" ON leads FOR SELECT
  USING (assigned_to = auth.uid() OR assigned_to IS NULL);

CREATE POLICY "sales_update_own" ON leads FOR UPDATE
  USING (assigned_to = auth.uid());

-- 聊天记录：有权限看 lead 的人就能看
CREATE POLICY "chat_access" ON chat_messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM leads l 
    WHERE l.id = chat_messages.lead_id 
    AND (l.assigned_to = auth.uid() OR 
         EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')))
  ));

-- 客户
CREATE POLICY "customer_admin" ON customers FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

CREATE POLICY "customer_sales" ON customers FOR SELECT
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- 项目
CREATE POLICY "project_admin" ON projects FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

CREATE POLICY "project_sales_see" ON projects FOR SELECT
  USING (assigned_to = auth.uid());

-- 报价
CREATE POLICY "quote_admin" ON quotes FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

-- 活动
CREATE POLICY "activity_admin" ON activities FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

CREATE POLICY "activity_sales_see" ON activities FOR SELECT
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

CREATE POLICY "activity_sales_create" ON activities FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Profiles：每个人看自己的，管理员看全部
CREATE POLICY "profile_self" ON profiles FOR SELECT
  USING (id = auth.uid() OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

-- ═══════════════ 视图 ═══════════════
-- 每日 lead 漏斗
CREATE VIEW lead_funnel_daily AS
SELECT 
  date_trunc('day', created_at) AS day,
  source,
  quality,
  stage,
  COUNT(*) AS count
FROM leads
GROUP BY 1,2,3,4
ORDER BY 1 DESC;

-- 销售绩效
CREATE VIEW sales_performance AS
SELECT 
  p.id,
  p.full_name,
  COUNT(l.id) FILTER (WHERE l.stage = 'new') AS new_leads,
  COUNT(l.id) FILTER (WHERE l.stage = 'quoted') AS quoted,
  COUNT(l.id) FILTER (WHERE l.stage = 'won') AS won,
  COUNT(l.id) FILTER (WHERE l.stage = 'lost') AS lost,
  CASE WHEN COUNT(l.id) > 0 
    THEN ROUND(COUNT(l.id) FILTER (WHERE l.stage = 'won')::DECIMAL / COUNT(l.id) * 100, 1) 
    ELSE 0 
  END AS conversion_rate
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
WHERE p.role = 'sales'
GROUP BY p.id, p.full_name;

-- ═══════════════ 初始数据 ═══════════════
-- 在 Supabase Dashboard → Authentication → Add User 手动创建第一个管理员
-- 然后在这里更新其 profile role 为 'admin'
