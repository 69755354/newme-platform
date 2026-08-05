-- ================================================
-- NewMe CRM v2 - 添加销售归属和统计字段
-- ================================================

-- ═══════════════ 扩展 leads 表 ═══════════════
-- 添加销售归属字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner UUID REFERENCES profiles(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales_manager UUID REFERENCES profiles(id);

-- 添加客户状态字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_status TEXT CHECK (lead_status IN ('hot','warm','cold','dormant'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS win_probability INTEGER CHECK (win_probability IN (10,30,50,70,90));

-- 添加决策信息字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS decision_maker TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS decision_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS competitor TEXT;

-- 添加跟进管理字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_contact_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_date TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_count INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS days_since_last_contact INTEGER DEFAULT 0;

-- 添加输单管理字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_price BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_competitor BOOLEAN DEFAULT false;
ALTER TABLE TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_no_budget BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_project_cancelled BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_project_delayed BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_no_response BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason_other BOOLEAN DEFAULT false;

-- 添加主管管理字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS recovery_candidate BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS transfer_candidate BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sales_manager_review BOOLEAN DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS hold_since TIMESTAMPTZ;

-- 添加金额字段
ALTER TABLE leads ADD COLUMN IF NOT EXISTS quotation_value DECIMAL(12,2) DEFAULT 0;

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner);
CREATE INDEX IF NOT EXISTS idx_leads_sales_manager ON leads(sales_manager);
CREATE INDEX IF NOT EXISTS idx_leads_lead_status ON leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_leads_win_probability ON leads(win_probability);
CREATE INDEX IF NOT EXISTS idx_leads_last_contact_date ON leads(last_contact_date);
CREATE INDEX IF NOT EXISTS idx_leads_next_followup_date ON leads(next_followup_date);
CREATE INDEX IF NOT EXISTS idx_leads_recovery_candidate ON leads(recovery_candidate);
CREATE INDEX IF NOT EXISTS idx_leads_transfer_candidate ON leads(transfer_candidate);
CREATE INDEX IF NOT EXISTS idx_leads_sales_manager_review ON leads(sales_manager_review);

-- ═══════════════ 创建 business_events 表 ═══════════════
CREATE TABLE IF NOT EXISTS business_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('lead','customer','project','quote')),
  entity_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'stage_change','status_change','probability_change','owner_change',
    'contact_made','contact_scheduled','quotation_sent','quotation_approved',
    'quotation_rejected','won','lost','recovery_candidate','transfer_candidate',
    'sales_manager_review','hold','unhold','competitor_added','decision_made'
  )),
  event_data JSONB,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_business_events_lead_id ON business_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_business_events_entity_type ON business_events(entity_type);
CREATE INDEX IF NOT EXISTS idx_business_events_event_type ON business_events(event_type);
CREATE INDEX IF NOT EXISTS idx_business_events_created_at ON business_events(created_at DESC);

-- RLS 策略
ALTER TABLE business_events ENABLE ROW LEVEL SECURITY;

-- 管理层可看所有
CREATE POLICY "business_events_admin_all" ON business_events FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','manager')));

-- 销售看自己相关的
CREATE POLICY "business_events_sales_own" ON business_events FOR SELECT
  USING (lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- 销售可创建自己相关的
CREATE POLICY "business_events_sales_create" ON business_events FOR INSERT
  WITH CHECK (created_by = auth.uid() AND lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid()));

-- ═══════════════ 更新 views ═══════════════
-- 更新销售绩效视图，包含新字段
CREATE OR REPLACE VIEW sales_performance AS
SELECT 
  p.id,
  p.full_name,
  p.role,
  COUNT(l.id) FILTER (WHERE l.stage = 'new') AS new_leads,
  COUNT(l.id) FILTER (WHERE l.stage = 'contacted') AS contacted,
  COUNT(l.id) FILTER (WHERE l.stage = 'requirement_confirmed') AS requirement_confirmed,
  COUNT(l.id) FILTER (WHERE l.stage = 'solution_submitted') AS solution_submitted,
  COUNT(l.id) FILTER (WHERE l.stage = 'quotation_submitted') AS quotation_submitted,
  COUNT(l.id) FILTER (WHERE l.stage = 'negotiation') AS negotiation,
  COUNT(l.id) FILTER (WHERE l.stage = 'pending_decision') AS pending_decision,
  COUNT(l.id) FILTER (WHERE l.stage = 'won') AS won,
  COUNT(l.id) FILTER (WHERE l.stage = 'lost') AS lost,
  COUNT(l.id) FILTER (WHERE l.lead_status = 'hot') AS hot_leads,
  COUNT(l.id) FILTER (WHERE l.lead_status = 'warm') AS warm_leads,
  COUNT(l.id) FILTER (WHERE l.lead_status = 'cold') AS cold_leads,
  COUNT(l.id) FILTER (WHERE l.lead_status = 'dormant') AS dormant_leads,
  SUM(l.quotation_value) FILTER (WHERE l.stage != 'won' AND l.stage != 'lost') AS pipeline_value,
  AVG(l.win_probability) FILTER (WHERE l.win_probability IS NOT NULL) AS avg_probability,
  COUNT(l.id) FILTER (WHERE l.recovery_candidate) AS recovery_candidates,
  COUNT(l.id) FILTER (WHERE l.transfer_candidate) AS transfer_candidates,
  COUNT(l.id) FILTER (WHERE l.sales_manager_review) AS reviews_needed,
  CASE WHEN COUNT(l.id) > 0 
    THEN ROUND(COUNT(l.id) FILTER (WHERE l.stage = 'won')::DECIMAL / COUNT(l.id) * 100, 1) 
    ELSE 0 
  END AS conversion_rate
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
WHERE p.role IN ('sales','manager')
GROUP BY p.id, p.full_name, p.role;

-- ═══════════════ 创建触发器函数自动计算字段 ═══════════════
CREATE OR REPLACE FUNCTION update_lead_metrics()
RETURNS TRIGGER AS $$
BEGIN
  -- 自动计算距离上次联系天数
  IF NEW.last_contact_date IS NOT NULL AND NEW.last_contact_date IS DISTINCT FROM OLD.last_contact_date THEN
    NEW.days_since_last_contact := EXTRACT(DAY FROM NOW() - NEW.last_contact_date);
  END IF;
  
  -- 自动检查超期并标记主管审阅
  IF NEW.stage = 'pending_decision' AND NEW.hold_since IS NULL THEN
    IF NEW.updated_at <= NOW() - INTERVAL '30 days' THEN
      NEW.sales_manager_review := true;
      NEW.hold_since := NEW.updated_at;
    END IF;
  END IF;
  
  -- 自动检查超期跟进
  IF NEW.next_followup_date IS NOT NULL AND NEW.next_followup_date <= NOW() THEN
    IF NEW.next_followup_date <= NOW() - INTERVAL '14 days' THEN
      NEW.transfer_candidate := true;
    ELSIF NEW.next_followup_date <= NOW() - INTERVAL '7 days' THEN
      NEW.recovery_candidate := true;
    END IF;
  END IF;
  
  -- 自动检查报价后超期
  IF NEW.stage = 'quotation_submitted' THEN
    IF NEW.updated_at <= NOW() - INTERVAL '30 days' THEN
      NEW.transfer_candidate := true;
    ELSIF NEW.updated_at <= NOW() - INTERVAL '14 days' THEN
      NEW.recovery_candidate := true;
    END IF;
  END IF;
  
  -- 高概率客户长期无动作通知主管
  IF NEW.win_probability >= 70 AND NEW.sales_manager_review = false THEN
    IF NEW.updated_at <= NOW() - INTERVAL '14 days' AND NEW.stage NOT IN ('won','lost') THEN
      NEW.sales_manager_review := true;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 创建触发器
CREATE TRIGGER trg_update_lead_metrics
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_lead_metrics();

-- ═══════════════ 创建函数处理业务事件 ═══════════════
CREATE OR REPLACE FUNCTION create_business_event(
  p_lead_id UUID,
  p_entity_type TEXT,
  p_entity_id UUID,
  p_event_type TEXT,
  p_event_data JSONB,
  p_created_by UUID
) RETURNS VOID AS $$
BEGIN
  INSERT INTO business_events (
    lead_id, entity_type, entity_id, event_type, event_data, created_by
  ) VALUES (
    p_lead_id, p_entity_type, p_entity_id, p_event_type, p_event_data, p_created_by
  );
END;
$$ LANGUAGE plpgsql;