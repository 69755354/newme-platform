# CRM v3 — 开发计划（技术方案 + 数据库迁移 + 上线计划）

> 基于 PRD v1.4 · 冻结业务逻辑，进入工程阶段
> v1.5 — 统一profiles引用、修正Pending Decision映射、重写deriveStage、修正漏斗统计口径、补充完整RLS策略

---

## 第一部分：环境与分支策略

### 1.1 分支

```
main              生产环境，只修bug
feat/crm-v3       所有Phase A开发，开发完合并到main上线
```

### 1.2 环境规划

| 环境 | Supabase | 代码 | 域名 | 用途 |
|------|----------|------|------|------|
| **dev** | `crm-dev`（新项目） | feat/crm-v3 | 本地 localhost:3001 | 开发+迁移测试 |
| **prod** | `crm-prod`（当前vfopmpxlhwzpxqegayew） | main | app.newme.ae | 线上真实业务 |

**Dev环境建立步骤：**
1. Supabase Dashboard → New Project → 命名为 `newme-crm-dev`
2. 从prod导出schema + 20条匿名化真实lead → 导入dev
3. 本地 `.env.local` 指向dev Supabase
4. 迁移脚本先在dev跑10次，确认100%通过再碰prod

**Seed Data：**
- 从prod导出20条真实lead，匿名化（客户名→"Test Client N"，电话→"+971 50 XXX XXXX"）
- 导入dev环境
- 在dev环境反复跑迁移脚本，直到Mapping 100%正确

---

## 第二部分：数据库迁移

### 2.1 新增表

#### Migration 001: user_features（用户级灰度开关）

```sql
CREATE TABLE user_features (
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL CHECK (feature_key IN (
    'v3_workbench', 'v3_milestone', 'v3_followup'
  )),
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, feature_key)
);

-- 默认只开Tanya
INSERT INTO user_features (user_id, feature_key, enabled)
SELECT id, 'v3_workbench', true
FROM profiles
WHERE email = 'tanya@newme.ae';
```

#### Migration 002: lead_milestones

```sql
CREATE TABLE lead_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  milestone_key TEXT NOT NULL CHECK (milestone_key IN (
    'first_contact', 'basic_info', 'drawings', 'requirements',
    'solution', 'quotation', 'meeting'
    -- 注意：没有 closure。成交/丢单用 leads.final_status
  )),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(lead_id, milestone_key)
);
CREATE INDEX idx_lead_milestones_lead ON lead_milestones(lead_id);
```

#### Migration 003: tasks（提前到Phase A）

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assignee_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT CHECK (task_type IN (
    'follow_up', 'meeting', 'quote_review', 'contract_sign', 'other'
  )),
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_lead ON tasks(lead_id);
CREATE INDEX idx_tasks_due ON tasks(due_at) WHERE completed_at IS NULL;
```

#### Migration 004: follow_up_logs（只记录历史）

```sql
CREATE TABLE follow_up_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sales_id UUID NOT NULL REFERENCES profiles(id) ON DELETE SET NULL,
  contact_method TEXT CHECK (contact_method IN ('phone','whatsapp','meeting','email','other')),
  content TEXT,
  customer_feedback TEXT,
  intention_change TEXT CHECK (intention_change IN ('up','same','down')),
  -- 注意：不包含 next_follow_up_at。未来动作归tasks表
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual','whatsapp_auto')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_follow_up_logs_lead ON follow_up_logs(lead_id);
CREATE INDEX idx_follow_up_logs_sales ON follow_up_logs(sales_id);
```

**follow_up_logs 只记录「已经发生了什么」**。记录完跟进后，系统自动在tasks表生成一条「下次跟进」任务。

**职责分离：**
- `follow_up_logs` = 历史（发生了什么）
- `tasks` = 未来（接下来干什么）

例如：
```
记录跟进：06-20 WhatsApp 客户说价格偏高
  → follow_up_logs 写入一条记录
  → tasks 自动生成「06-28 跟进报价反馈」
```

#### Migration 005: lead_documents

```sql
CREATE TABLE lead_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('drawing','solution','contract','other')),
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_size INTEGER,
  description TEXT,
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lead_documents_lead ON lead_documents(lead_id);
```

### 2.2 leads 表新增字段

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS final_status TEXT
  CHECK (final_status IN ('won', 'lost'));
  -- 替代Milestone中的closure。只记录最终结果，不混入过程Milestone。

ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_result TEXT
  CHECK (contact_result IN ('interested','not_interested','no_answer'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS not_interested_reason TEXT
  CHECK (not_interested_reason IN ('job_seeking','partnership','misclick','other'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS project_type TEXT
  CHECK (project_type IN ('villa','apartment','developer'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS project_status TEXT
  CHECK (project_status IN ('under_construction','ready','renovation'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS emirate TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_company_type TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_position TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ac_brand TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS smart_requirements JSONB DEFAULT '[]';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS customer_budget NUMERIC(12,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_sign_date DATE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT
  CHECK (lost_reason IN ('price','solution','competitor','decision_maker','budget','other'));
```

### 2.3 Migration Mapping：旧stage → Milestone

**映射规则：**

| 旧stage | 自动完成的Milestone |
|---------|-------------------|
| New | (无) |
| Contacted | first_contact |
| No Answer | first_contact |
| Interested | first_contact + basic_info |
| Req Confirmed | first_contact + basic_info + drawings + requirements |
| Solution Sub. | first_contact + basic_info + drawings + requirements + solution |
| Quotation Sub. | first_contact + basic_info + drawings + requirements + solution + quotation |
| Negotiation | first_contact + basic_info + drawings + requirements + solution + quotation + meeting |
| Pending Decision | first_contact + basic_info + drawings + requirements + solution + quotation + meeting |
| Won | first_contact + basic_info + drawings + requirements + solution + meeting + leads.final_status='won' |
| Lost | first_contact + leads.final_status='lost' |

**执行SQL（UNION ALL，可读性优先）：**

```sql
-- first_contact
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'first_contact', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage NOT IN ('new')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'first_contact');

-- basic_info
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'basic_info', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage IN ('interested','req_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision','won')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'basic_info');

-- drawings
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'drawings', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage IN ('req_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision','won')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'drawings');

-- requirements
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'requirements', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage IN ('req_confirmed','solution_submitted','quotation_submitted','negotiation','pending_decision','won')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'requirements');

-- solution
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'solution', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage IN ('solution_submitted','quotation_submitted','negotiation','pending_decision','won')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'solution');

-- quotation
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'quotation', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage IN ('quotation_submitted','negotiation','pending_decision','won')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'quotation');

-- meeting
INSERT INTO lead_milestones (lead_id, milestone_key, completed_at, notes)
SELECT l.id, 'meeting', l.updated_at, 'auto-migrated'
FROM leads l WHERE l.stage IN ('negotiation','pending_decision','won')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id AND lm.milestone_key = 'meeting');

-- final_status（Won/Lost）
UPDATE leads SET final_status = 'won' WHERE stage = 'won' AND final_status IS NULL;
UPDATE leads SET final_status = 'lost' WHERE stage = 'lost' AND final_status IS NULL;
```

**验证SQL：**

```sql
-- 检查是否有旧lead遗漏（New阶段除外）
SELECT COUNT(*) FROM leads l
WHERE l.stage NOT IN ('new')
  AND NOT EXISTS (SELECT 1 FROM lead_milestones lm WHERE lm.lead_id = l.id);
-- 期望: 0

-- 按stage看Milestone覆盖率
SELECT l.stage, COUNT(*) as leads,
  COUNT(lm.id) as milestones
FROM leads l LEFT JOIN lead_milestones lm ON lm.lead_id = l.id
GROUP BY l.stage ORDER BY l.stage;
```

### 2.4 RLS策略

所有5张新表启用Row Level Security，按以下规则：

| 表 | SELECT | INSERT | UPDATE | DELETE |
|---|--------|--------|--------|--------|
| `user_features` | 自己可读，admin可读全部 | admin可写 | admin可写 | admin可写 |
| `lead_milestones` | 销售看自己的lead，admin看全部 | 销售给自己lead加，admin可加全部 | 同INSERT | 同INSERT |
| `tasks` | 销售看自己任务，admin看全部 | 销售给自己建，admin可建全部 | 同INSERT | 同INSERT |
| `follow_up_logs` | 销售看自己的lead，admin看全部 | 销售给自己的lead加 | 仅admin | 仅admin |
| `lead_documents` | 销售看自己的lead，admin看全部 | 同上 | 同上 | 同上 |

**核心SQL：**

```sql
-- 所有表共用角色判断函数（已有）
-- get_my_role() 已存在，返回当前用户角色

-- user_features
ALTER TABLE user_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self_read_features" ON user_features
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR get_my_role() IN ('admin','boss'));
CREATE POLICY "admin_write_features" ON user_features
  FOR ALL TO authenticated
  USING (get_my_role() IN ('admin'))
  WITH CHECK (get_my_role() IN ('admin'));

-- lead_milestones: 销售只能看/写自己的lead
ALTER TABLE lead_milestones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales_milestones" ON lead_milestones
  FOR SELECT TO authenticated
  USING (
    auth.uid() IN (SELECT assigned_to FROM leads WHERE id = lead_id)
    OR get_my_role() IN ('admin','boss','operator')
  );
CREATE POLICY "sales_insert_milestones" ON lead_milestones
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IN (SELECT assigned_to FROM leads WHERE id = lead_id)
    OR get_my_role() IN ('admin')
  );

-- tasks
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales_tasks" ON tasks
  FOR SELECT TO authenticated
  USING (assignee_id = auth.uid() OR get_my_role() IN ('admin','boss'));
CREATE POLICY "sales_insert_tasks" ON tasks
  FOR INSERT TO authenticated
  WITH CHECK (assignee_id = auth.uid() OR get_my_role() IN ('admin'));

-- follow_up_logs
ALTER TABLE follow_up_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales_followups" ON follow_up_logs
  FOR SELECT TO authenticated
  USING (
    auth.uid() IN (SELECT assigned_to FROM leads WHERE id = lead_id)
    OR get_my_role() IN ('admin','boss','operator')
  );
CREATE POLICY "sales_insert_followups" ON follow_up_logs
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IN (SELECT assigned_to FROM leads WHERE id = lead_id)
    OR get_my_role() IN ('admin')
  );

-- lead_documents
ALTER TABLE lead_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sales_documents" ON lead_documents
  FOR SELECT TO authenticated
  USING (
    auth.uid() IN (SELECT assigned_to FROM leads WHERE id = lead_id)
    OR get_my_role() IN ('admin','boss','operator')
  );
CREATE POLICY "sales_upload_documents" ON lead_documents
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() IN (SELECT assigned_to FROM leads WHERE id = lead_id)
    OR get_my_role() IN ('admin')
  );
```

---

## 第三部分：Feature Flag（用户级灰度）

### 3.1 实现方式

不是全局环境变量。是**用户级**开关，存在 `user_features` 表里。

```typescript
// lib/feature-flags.ts
export async function isFeatureEnabled(userId: string, feature: string): Promise<boolean> {
  const { data } = await supabase
    .from('user_features')
    .select('enabled')
    .eq('user_id', userId)
    .eq('feature_key', feature)
    .single();
  return data?.enabled ?? false;
}
```

### 3.2 灰度名单

| 功能 | 默认启用 | 灰度计划 |
|------|---------|---------|
| `v3_workbench` | Tanya | Day 1-2 Tanya → Day 3-5 全体销售 |
| `v3_milestone` | 不启用 | Day 5-7 开Tanya → Day 8-14 全体 |
| `v3_followup` | 不启用 | Day 10以后 |

**admin默认全部开启**（老板不需要灰度）。

### 3.3 前端行为

```typescript
// 根据feature flag决定显示哪个页面
const showV3 = await isFeatureEnabled(user.id, 'v3_workbench');
if (showV3) redirect('/workbench');
else redirect('/leads'); // 旧版
```

---

## 第四部分：技术方案

### 4.1 前端架构

```
src/
  app/(dashboard)/
    workbench/           → 销售工作台
    leads/[id]/          → Lead详情页（三区布局）
  components/
    workbench/
      InboxPanel.tsx
      TaskList.tsx
      OverdueList.tsx
      ProgressCard.tsx
    leads/
      LeadHeader.tsx
      LeadTimeline.tsx     → 月度折叠
      LeadMilestones.tsx
      LeadNextAction.tsx
      LeadFoldSection.tsx
  lib/
    milestones.ts
    feature-flags.ts       → 用户级Feature Flag
    health-score.ts        → Phase B
```

### 4.2 Milestone计算

```typescript
// 前台阶段：根据milestone_count映射
// 0=new, 1=contacted, 2=qualified, 3=drawings, 4=requirements,
// 5=solution, 6=quotation, 7=negotiation, won/lost=终结

const STAGE_LABELS = [
  'new', 'contacted', 'qualified', 'drawings',
  'requirements', 'solution', 'quotation', 'negotiation'
];

export function deriveStage(milestones: { key: string; completed_at: string|null }[], finalStatus?: string): string {
  if (finalStatus === 'won') return 'won';
  if (finalStatus === 'lost') return 'lost';
  
  const count = milestones.filter(m => m.completed_at).length;
  return STAGE_LABELS[Math.min(count, STAGE_LABELS.length - 1)] || 'new';
}

export function nextAction(milestones: { key: string; completed_at: string|null }[]): string {
  const done = new Set(milestones.filter(m => m.completed_at).map(m => m.key));
  if (!done.has('first_contact')) return '首次联系客户';
  if (!done.has('basic_info')) return '收集客户信息';
  if (!done.has('drawings')) return '索要图纸';
  if (!done.has('requirements')) return '确认需求清单';
  if (!done.has('solution')) return '制作方案';
  if (!done.has('quotation')) return '发出报价';
  if (!done.has('meeting')) return '安排面谈';
  return '跟进报价';
}
```

---

## 第五部分：Observability（监控方案）

> 上线后每天自动统计，发到CRM PROJECT群。

### 5.1 每日指标

| 指标 | SQL | 说明 |
|------|-----|------|
| 新增Lead | `SELECT COUNT(*) FROM leads WHERE created_at > today()` | 获客 |
| 跟进记录数 | `SELECT COUNT(*) FROM follow_up_logs WHERE created_at > today()` | 销售活跃度 |
| 超时跟进数 | `SELECT COUNT(*) FROM leads WHERE next_follow_up < now()` | 逾期风险 |
| Milestone推进数 | `SELECT COUNT(*) FROM lead_milestones WHERE completed_at > today()` | 工作流推进 |
| 工作台使用率 | 日志统计 `/workbench` PV | v3采纳率 |
| Lead详情页PV | 日志统计 `/leads/[id]` PV | 最常用页面 |
| 页面错误数 | `console.error` / 500 统计 | 系统稳定性 |

### 5.2 采用率看板

```sql
-- 每日活跃销售数
SELECT COUNT(DISTINCT sales_id) FROM follow_up_logs
WHERE created_at > now() - interval '7 days';

-- 使用v3 vs v2的比例
SELECT 
  COUNT(CASE WHEN path LIKE '/workbench%' THEN 1 END) as v3_views,
  COUNT(CASE WHEN path LIKE '/leads%' AND path NOT LIKE '/leads/[id]%' THEN 1 END) as v2_views
FROM page_views
WHERE created_at > today();
```

### 5.3 每日漏斗快照

每天自动生成一张漏斗快照表，用于分析历史趋势：

```sql
-- crm_daily_funnel_snapshot（每天 cron 执行一次 INSERT）
CREATE TABLE IF NOT EXISTS crm_daily_funnel_snapshot (
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  stage_new INTEGER NOT NULL DEFAULT 0,
  stage_contacted INTEGER NOT NULL DEFAULT 0,
  stage_qualified INTEGER NOT NULL DEFAULT 0,
  stage_drawings INTEGER NOT NULL DEFAULT 0,
  stage_requirements INTEGER NOT NULL DEFAULT 0,
  stage_solution INTEGER NOT NULL DEFAULT 0,
  stage_quotation INTEGER NOT NULL DEFAULT 0,
  stage_negotiation INTEGER NOT NULL DEFAULT 0,
  stage_won INTEGER NOT NULL DEFAULT 0,
  stage_lost INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date)
);

-- 每日插入：统计当前所在层，不是累计覆盖率
INSERT INTO crm_daily_funnel_snapshot (
  snapshot_date, stage_new, stage_contacted, stage_qualified,
  stage_drawings, stage_requirements, stage_solution, stage_quotation,
  stage_negotiation, stage_won, stage_lost
)
SELECT
  CURRENT_DATE,
  COUNT(*) FILTER (WHERE milestone_count = 0 AND final_status IS NULL) as stage_new,
  COUNT(*) FILTER (WHERE milestone_count = 1 AND final_status IS NULL) as stage_contacted,
  COUNT(*) FILTER (WHERE milestone_count = 2 AND final_status IS NULL) as stage_qualified,
  COUNT(*) FILTER (WHERE milestone_count = 3 AND final_status IS NULL) as stage_drawings,
  COUNT(*) FILTER (WHERE milestone_count = 4 AND final_status IS NULL) as stage_requirements,
  COUNT(*) FILTER (WHERE milestone_count = 5 AND final_status IS NULL) as stage_solution,
  COUNT(*) FILTER (WHERE milestone_count = 6 AND final_status IS NULL) as stage_quotation,
  COUNT(*) FILTER (WHERE milestone_count >= 7 AND final_status IS NULL) as stage_negotiation,
  COUNT(*) FILTER (WHERE final_status = 'won') as stage_won,
  COUNT(*) FILTER (WHERE final_status = 'lost') as stage_lost
FROM (
  SELECT l.id, l.final_status,
    COUNT(lm.id) FILTER (WHERE lm.completed_at IS NOT NULL) as milestone_count
  FROM leads l
  LEFT JOIN lead_milestones lm ON lm.lead_id = l.id
  GROUP BY l.id, l.final_status
) sub;
```

三个月后，老板可以看到真正的漏斗：
```
new=100 → contacted=80 → qualified=60 → drawings=40 → requirements=20
→ solution=15 → quotation=10 → negotiation=8 → won=5
```
每一级是**当前所在层的线索数**，不是累计覆盖。哪一级流失最严重一目了然。

### 5.4 监控cron

沿用现有每日报告cron，新增统计指标输出到日报中。

---

## 第六部分：Acceptance Criteria（验收标准）

### 6.1 Phase A 验收

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | 销售登录后5秒内看到今日任务 | 手动计时 |
| 2 | 新增Lead到首次联系不超过24小时 | cron统计 |
| 3 | No Answer超时100%触发提醒 | 手动造一条验证 |
| 4 | Migration后0条Lead丢失 | 验证SQL |
| 5 | 旧stage字段不丢失、不报错 | 打开旧lead页面检查 |
| 6 | 工作台默认展示Inbox > 今日跟进 > 超时 | 肉眼验证 |
| 7 | 点击Inbox/任务/卡片进入Lead详情页 | 手动点击 |
| 8 | Lead详情页三区布局：身份卡 > 时间线(5条) > 折叠区 | 肉眼验证 |
| 9 | 时间线按月折叠：显示「6月·跟进12次·面谈2次」| 手动造数据验证 |
| 10 | 记录跟进后下次跟进时间必填，不填无法提交 | 手动验证 |
| 11 | No Answer强制要求填下次跟进时间 | 手动验证 |
| 12 | Feature Flag关闭v3_workbench时回退到旧版 | 改user_features验证 |

### 6.3 性能验收

| # | 标准 | 说明 |
|---|------|------|
| 1 | Lead详情页 P95 < 1.5s | timeline + documents + milestones + tasks 不能超过1.5秒 |
| 2 | 销售工作台 P95 < 2s | Inbox + 任务列表 + 超时 + 进度 加载 |
| 3 | Lead列表 P95 < 1s | 旧页面不受影响 |
| 4 | 数据库迁移执行 < 30s | 5张新表 + 旧数据Mapping，不能拖慢上线 |

> 如果超过阈值：前端做懒加载（时间线默认只加载最近5条，其余点击展开）

### 6.4 业务流验收

销售完整走通一条线索的**全流程**：

```
Lead创建 → 首次联系(选感兴趣) → 填写信息收集 → 上传图纸 → 确认需求
→ 标记方案完成 → 发出报价 → 记录面谈 → 跟单记录(至少2次) → 成交
```

要求每一步数据正确写入、下一动作自动更新、时间线可追溯。

### 6.5 UAT Checklist（Tanya验证）

| # | 问题 | 答案 |
|---|------|------|
| 1 | 今天任务看得懂吗？ | ✅ / ❌ |
| 2 | 超时提醒看得懂吗？ | ✅ / ❌ |
| 3 | Lead详情比旧版好找信息吗？ | ✅ / ❌ |
| 4 | Timeline能看懂吗？ | ✅ / ❌ |
| 5 | Milestone逻辑（下一步该做什么）合理吗？ | ✅ / ❌ |
| 6 | 报价流程顺畅吗？ | ✅ / ❌ |
| 7 | **愿意继续使用V3吗？** | **✅ / ❌ ← 最关键** |

最后一条不通过 → v3不能上线。

### 6.2 回滚验收

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | git revert + build + restart 在2分钟内完成 | 计时 |
| 2 | 回滚后旧lead页面访问正常 | 打开旧页面 |
| 3 | 新表数据不丢失（回滚后重新打开v3可见）| DROP后恢复 |

---

## 第七部分：上线计划

### 7.1 回滚时间修正（重要）

| 操作 | 时间 | 说明 |
|------|------|------|
| git revert + build | 30秒 | 代码回滚 |
| 服务重启 | 5秒 | systemctl restart |
| 数据库回滚（DROP新表） | 1分钟 | 可选，不DROP也不影响旧业务 |
| **业务完全恢复** | **5-30分钟** | 需要验证旧页面正常、数据完整 |

不写「30秒恢复」。给老板正确预期。

### 7.2 上线检查清单

- [ ] Supabase全库备份完成
- [ ] 迁移SQL dry-run通过（先SELECT确认Mapping正确）
- [ ] `user_features` 中Tanya已启用v3_workbench
- [ ] 构建通过（npm run build exit 0）
- [ ] 服务重启后HTTP 200
- [ ] 日志无报错
- [ ] 迁移验证SQL返回0条遗漏lead
- [ ] Tanya走通完整流程
- [ ] Feature Flag关闭后回退旧版正常

### 7.3 灰度时间线

| 日 | 动作 | Feature Flag | 验证 |
|----|------|-------------|------|
| Day 1 | 上线 + Tanya验证 | v3_workbench: Tanya | Tanya走通完整业务流 |
| Day 3 | + Mohamed | v3_workbench: Tanya+Mohamed | 2人各跑一条完整流程 |
| Day 7 | 开全体销售 | v3_workbench: 全体 | 全部销售可用 |
| Day 10 | 开Milestone | + v3_milestone: 全体 | 双轨运行 |
| Day 14 | 默认入口切V3 | 旧入口隐藏 | 默认进/workbench |
| Day 30 | 停止旧stage写入 | 旧stage不再更新 | 只读保留 |
| Day 45 | 删除旧stage代码依赖 | 前端不再引用旧字段 | 旧字段代码清理 |
| Day 60 | 清理旧stage数据库字段 | DROP COLUMN | 最后清理 |

---

## 第八部分：Phase A 任务拆分

| 日 | 内容 | 产出 |
|----|------|------|
| Day 1 | 建分支 + 数据库迁移全部(5张新表 + leads加字段 + RLS + Migration Mapping)| 迁移脚本 + dry-run |
| Day 1-3 | 销售工作台 + 用户级Feature Flag | `/workbench` 灰度上线 |
| Day 3-7 | Lead详情页三区 + 时间线折叠 + Milestone + 下一动作 | `/leads/[id]` 灰度上线 |
| Day 7-10 | 跟进引擎 + No Answer + 超时检测cron + 通知 | 跟进全流程 |
| Day 10-12 | Observability cron + Acceptance Criteria验证 | 监控+验收 |
| Day 12-14 | Bug修复 + 全量开放 | Feature Flag全开 |

---

## 第九部分：风险记录

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|---------|
| Milestone映射错误，旧lead显示为空线索 | 高 | 中 | dev环境先跑20条seed data验证；迁移前抽样50条prod lead核对 |
| 销售拒绝使用Workbench | 高 | 高 | 灰度两周+UAT Checklist+收集反馈；最后一条「愿意继续使用V3」不通过不上线 |
| 跟进通知Cron失效，No Answer超时未提醒 | 中 | 中 | 日报监控统计超时数；对比tasks.due_at与当前时间 |
| 旧stage写入未完全停止，双轨数据不一致 | 中 | 低 | Day 30代码审计确认所有写入点已关闭 |

---

## 附录

### A. 文件清单

| 文件 | 状态 |
|------|------|
| `PRD-CRM-v3-sales-workflow.md` | ✅ v1.4 已冻结 |
| `02_DEV_PLAN.md` | ✅ v1.4 本文档 |
| 数据库迁移SQL | 📝 Dev环境执行 |
| Seed Data（20条匿名lead）| 📝 Dev环境导入 |

### B. v1.1→v1.2 变更摘要

| 变更 | 说明 |
|------|------|
| 全局Feature Flag → 用户级 | `user_features` 表 + 灰度名单 |
| closure拆分 → leads.final_status | Milestone不记录结果，只记录过程 |
| Migration SQL重写 | CROSS JOIN LATERAL → UNION ALL |
| 回滚时间修正 | 30秒→5-30分钟 |
| tasks表提前到Phase A | Day 1直接建 |
| 新增Observability | 每日指标 + 采用率 |
| 新增Acceptance Criteria | 12条验收标准 |
