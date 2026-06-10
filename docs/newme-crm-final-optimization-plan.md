# 产品总监最终优化方案 — 可执行精简版

> **合成依据**: 产品总监前两轮审查 + 架构总监前两轮审查 + GPT战略反馈 + 角色分权界面方案  
> **状态**: 终稿  
> **约束**: 200条线索, 1销售(Tanya), 迪拜市场, app.newme.ae (Next.js + Supabase)  
> **核心理念**: 只做让Tanya今天就开始用的功能, 不从"完整CRM"出发

---

## 1. 精简后的DDL修正清单

### 1.1 到底建哪些表 (基于当前926行DDL)

| # | 表名 | 当前状态 | 判定 | 说明 |
|---|------|---------|------|------|
| 1 | leads | 已有 | **需保留** | 核心入口, 增强9阶段+quotation_value |
| 2 | customers | 已有 | **需保留** | 增强字段 (assigned_sales_id, tags, last_activity_at) |
| 3 | activities | 已有 | **升格为地基** | 这是MVP的核心, 不是附属表 |
| 4 | products | 新建 | **保留, 推迟CRUD** | 只建表+导入数据, 管理界面推迟到运营阶段 |
| 5 | quotations | 新建 | **保留** | 销售的报价入口, 简化字段 |
| 6 | quotation_items | 新建 | **推迟** | MVP报价只填总金额, 不需要行项目 |
| 7 | contracts | 新建 | **保留** | 运营的核心, 但第一阶段只建表 |
| 8 | installment_plans | 新建 | **保留** | 分期计划, 但第一阶段只建表 |
| 9 | delivery_plans | 新建 | **推迟** | 运营阶段才需要 |
| 10 | payments | 新建 | **保留** | 回款登记, 第二阶段启用 |
| 11 | projects | 已有 | **保留** | 增强contract_id/lead_id等字段 |
| 12 | project_milestones | 新建 | **推迟** | 运营阶段才需要 |
| 13 | project_documents | 新建 | **推迟** | 运营阶段才需要 |
| 14 | project_inspections | 新建 | **推迟** | 运营阶段才需要 |
| 15 | sales_targets | 新建 | **推迟** | 老板Dashboard阶段才需要 |
| 16 | business_events | 已有 | **简化** | 砍掉80%事件类型 |
| 17 | profiles | 已有 | **增强** | 加boss角色, 加is_active/last_active_at |

### 1.2 BLOCKER 修正 (架构总监Round1)

#### B1: 表创建顺序错误
```
当前DDL中 activities 的 FK 引用 contracts/quotations
但 contracts 和 quotations 在 DDL 中创建在 activities 之后

修复: 将 activities 增强（Part 3）移到 contracts（Part 7）和 quotations（Part 5）之后
```

#### B2: profiles 角色迁移缺少数据UPDATE
```
当前 DDL 只改了 CHECK 约束，没有 UPDATE 现有数据

修复: 在约束变更后追加:
UPDATE profiles SET role = 'sales' WHERE role = 'salesperson';
UPDATE profiles SET role = 'operator' WHERE role = 'staff';
UPDATE profiles SET role = 'admin' WHERE role = 'manager';
```

### 1.3 P0安全缺口修正 (架构总监Round2)

#### Gap 1: 旧策略引用'manager'角色（已废弃但RLS有效）
```sql
-- 当前DDL中不包含此策略（已清理），但生产数据库可能有残留
-- 需执行:
DROP POLICY IF EXISTS "leads_manager_all" ON leads;
DROP POLICY IF EXISTS "contracts_manager_all" ON contracts;
-- 以及其他引用 'manager' 的策略
```

#### Gap 2: 视图 security_definer 绕过全部RLS
```sql
-- 当前视图全部使用默认 security_invoker = false
-- 修复: 所有视图改为 security_invoker
ALTER VIEW v_sales_performance SET (security_invoker = true);
ALTER VIEW v_contract_payment_overview SET (security_invoker = true);
```

#### Gap 3: activities表sales只能通过lead_id访问
```sql
-- 当前RLS: activities只关联lead_id，没有contract_id/quote_id/project_id策略
-- 修复: 创建综合RLS策略
CREATE POLICY "activities_sales_select" ON activities FOR SELECT
  USING (
    lead_id IN (SELECT id FROM leads WHERE assigned_to = auth.uid())
    OR contract_id IN (SELECT id FROM contracts WHERE sales_id = auth.uid())
    OR quotation_id IN (SELECT id FROM quotations q
      JOIN leads l ON l.id = q.lead_id WHERE l.assigned_to = auth.uid())
    OR project_id IN (SELECT id FROM projects WHERE sales_id = auth.uid())
    OR user_id = auth.uid()
  );
```

#### Gap 4: leads表缺少sales INSERT策略
```sql
-- 当前DDL: leads 没有 sales 的 INSERT policy
-- 修复:
CREATE POLICY "leads_sales_insert" ON leads FOR INSERT
  WITH CHECK (
    assigned_to = auth.uid()
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales')
  );
```

### 1.4 新增boss角色及RLS

```sql
-- 在 profiles 角色枚举中增加 boss
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('boss','admin','sales','designer','operator','finance'));

-- boss RLS策略: 全量SELECT + leads UPDATE(仅分配字段)
CREATE POLICY "leads_boss_select" ON leads FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "leads_boss_update" ON leads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- contracts/payments/installment_plans/projects: boss可SELECT全部
CREATE POLICY "contracts_boss_select" ON contracts FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "payments_boss_select" ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "installment_boss_select" ON installment_plans FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "projects_boss_select" ON projects FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "activities_boss_select" ON activities FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "quotations_boss_select" ON quotations FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "profiles_boss_select" ON profiles FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
```

### 1.5 简化business_events (从30种砍到10种)

```sql
ALTER TABLE business_events DROP CONSTRAINT IF EXISTS chk_event_type;
ALTER TABLE business_events ADD CONSTRAINT chk_event_type
  CHECK (event_type IN (
    'stage_change', 'owner_change', 'contact_made',
    'quotation_sent', 'quotation_accepted', 'quotation_rejected',
    'won', 'lost', 'payment_recorded', 'contract_signed'
  ));
```

### 1.6 新增5个推荐视图 (架构总监Round2)

```sql
-- v_funnel_conversion: 管道漏斗转化率
CREATE OR REPLACE VIEW v_funnel_conversion AS
WITH stage_counts AS (
  SELECT stage, COUNT(*) AS cnt,
    COALESCE(SUM(quotation_value), 0) AS total_value
  FROM leads
  WHERE disqualified_candidate = false OR disqualified_candidate IS NULL
  GROUP BY stage
)
SELECT * FROM stage_counts ORDER BY
  array_position(ARRAY['new','contacted','requirement_confirmed',
    'solution_submitted','quotation_submitted','negotiation',
    'pending_decision','won','lost'], stage);

-- v_account_receivable_aging: 应收账款账龄
CREATE OR REPLACE VIEW v_account_receivable_aging AS
SELECT
  c.id AS contract_id, c.contract_no, c.party_a_name,
  p.full_name AS sales_name,
  ip.amount, ip.due_date,
  CURRENT_DATE - ip.due_date AS overdue_days,
  CASE
    WHEN CURRENT_DATE - ip.due_date <= 30 THEN '1-30天'
    WHEN CURRENT_DATE - ip.due_date <= 60 THEN '31-60天'
    WHEN CURRENT_DATE - ip.due_date <= 90 THEN '61-90天'
    ELSE '90天以上'
  END AS aging_bucket
FROM installment_plans ip
JOIN contracts c ON c.id = ip.contract_id
LEFT JOIN profiles p ON p.id = c.sales_id
WHERE ip.status = 'overdue';

-- v_sales_personal_stats: 销售个人统计(无金额)
CREATE OR REPLACE VIEW v_sales_personal_stats AS
SELECT
  p.id AS user_id, p.full_name,
  COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost')) AS active_leads,
  COUNT(l.id) FILTER (WHERE l.stage = 'won') AS won_count,
  COUNT(l.id) FILTER (WHERE l.stage = 'lost') AS lost_count,
  CASE WHEN COUNT(l.id) FILTER (WHERE l.stage IN ('won','lost')) > 0
    THEN ROUND(COUNT(l.id) FILTER (WHERE l.stage = 'won')::DECIMAL
      / COUNT(l.id) FILTER (WHERE l.stage IN ('won','lost')) * 100, 1)
    ELSE 0
  END AS conversion_rate
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
WHERE p.id = auth.uid()
GROUP BY p.id, p.full_name;
```

### 1.7 索引优化 (架构总监Round1 WARNING修正)

```sql
-- 新增: 销售Dashboard每日首页查询
CREATE INDEX IF NOT EXISTS idx_leads_today_pipeline
  ON leads(assigned_to, stage) INCLUDE (quotation_value, last_contact_date, stage_changed_at);

-- 新增: 老板Dashboard按月聚合
CREATE INDEX IF NOT EXISTS idx_contracts_monthly
  ON contracts(contract_date) INCLUDE (contract_amount, sales_id);

-- 新增: 运营待办
CREATE INDEX IF NOT EXISTS idx_payments_unconfirmed
  ON payments(confirmed, created_at DESC) WHERE confirmed = false;

-- 删除冗余索引: idx_contracts_sales_status 被 idx_contracts_sales + idx_contracts_status 覆盖
-- 删除冗余索引: idx_payments_contract_amount 被 idx_payments_contract 覆盖
-- 修正时区: 确保 TIMESTAMPTZ 默认使用 Dubai (+04:00)
ALTER DATABASE postgres SET timezone = 'Asia/Dubai';
```

### 1.8 超额支付处理 (架构总监Round1 WARNING)

```sql
-- 当前DDL没有处理多付场景（客户多付了钱）
-- 新增: payments.overpayment_handling 字段
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  overpayment_action TEXT CHECK (overpayment_action IN ('credit','refund','other'));
```

---

## 2. 第一阶段实施范围 — 让Tanya今天就用 (Sprint 1)

### 2.1 最小可作战系统定义

> **目标**: Tanya 登录后能回答"今天先跟谁", 并在5秒内记录跟进  
> **表** (实时可用): leads, customers, activities, quotations (简版), contracts (只建表不写代码), profiles  
> **推迟到第二阶段**: 所有金钱交易(回款/分期), 项目交付, 产品库CRUD, 老板Dashboard

### 2.2 销售Tanya界面 (Phase 1.1 — Sprint 1, 本周)

**默认首页: 今日待办**
```
核心逻辑:
  1. 按 (stage_changed_at + 3天) 排序 → 停滞越久越靠前
  2. 按 (last_contact_date > 2天) 次排序
  3. recovery_candidate = true → 红色置顶
  4. 每条显示: 客户名 | 阶段 | 金额 | 停留X天 | [快速跟进]按钮
  5. 顶部计数: "今天已跟进 X/N"
```

**我的管道 (Kanban)**
```
9栏: new → contacted → requirement_confirmed → solution_submitted →
      quotation_submitted → negotiation → pending_decision → won / lost
- 拖拽推进阶段 → 自动 UPDATE leads.stage + INSERT activities
- 点击卡片 → 线索详情 (基本信息+活动时间线+报价列表)
- 操作: [推进阶段] [创建报价] [标记成交] [标记输单] [记录活动]
```

**快速跟进记录**
```
弹窗: 选线索 → 选类型 → 写备注 → 保存
自动: INSERT INTO activities (type='whatsapp/call/meeting/note', ...)
```

**我的业绩 (无金额)**
```
仅显示: 活跃线索数 | 本月成交数 | 本月输单数 | 转化率
金额: 完全不显示 (连自己的也不显示金额)
```

### 2.3 第一阶段DDL变更指令

```
1. ✅ 按B1修正调整创建顺序: activities→quotations→contracts→installments→payments
2. ✅ profiles加boss角色 + 数据UPDATE迁移
3. ✅ leads加sales INSERT策略
4. ✅ activities加综合RLS (contract_id/quote_id/project_id)
5. ✅ 删掉废弃的'manager'角色RLS策略
6. ✅ 视图加 security_invoker = true
7. ✅ business_events缩到10种类型
8. ✅ 时区设Asia/Dubai
9. ✅ quotation_items表推迟 (MVP报价只填总金额)
10. ✅ delivery_plans/project_milestones/project_documents/project_inspections 推迟
11. ✅ sales_targets推迟
12. ✅ 新增推荐视图: v_funnel_conversion, v_sales_personal_stats

暂缓(不改动): products CRUD, 所有触发器中与交付/里程碑/验收相关的
```

### 2.4 第一阶段前端开发范围

| 页面 | 数据源 | 备注 |
|------|--------|------|
| 今日待办 | leads + activities | 优先级排序算法 |
| 我的管道(Kanban) | leads (assigned_to=me) | 9栏+拖拽 |
| 线索详情 | leads + activities + quotations | 只读+操作 |
| 快速跟进 | activities INSERT | 弹窗 |
| 创建报价(简版) | quotations INSERT | 只有总金额 |
| 标记成交/输单 | leads UPDATE | won/lost |
| 我的业绩 | v_sales_personal_stats | 无金额 |

---

## 3. 第二阶段实施范围 — 老板Dashboard (Sprint 3-4)

### 3.1 老板SAM界面

**核心原则**: 只看不操作 (除分配/转移线索), 手机端友好, 30秒看完

**默认首页: 驾驶舱 Dashboard**
```
4 KPI Card: 管道总额 | 本月签约额 | 本月回款 | 逾期金额
预警区块: 红线线索(>14天停滞) | 逾期分期 | 回收标记 | 销售停摆
管道漏斗: 各阶段数量+总金额
团队速览: 每人一行(名称|活跃线索|管道价值|本月签约|本月回款|最后活动)
```

**其他页面**: 线索管道(只读+分配) → 回款看板 → 合同总览 → 团队概况

### 3.2 第二阶段启用的表/数据

| 表 | 启用方式 | 说明 |
|----|---------|------|
| payments | 数据录入+查询 | 回款登记(运营录入, 老板看汇总) |
| installment_plans | 数据录入+查询 | 分期计划(运营录入, 老板看逾期) |
| sales_targets | 建表+录入 | 老板设定销售目标 |
| delivery_plans | 仅建表 | 数据录入推迟到第三阶段 |

### 3.3 老板视角的数据权限

```
- 看到全部线索 ALL SELECT (no WHERE filter)
- 看到全部合同, 回款, 分期, 项目
- 看到每个人的销售业绩 (含金额)
- 操作: 线索分配/转移 (UPDATE leads.assigned_to)
- 操作: 销售目标CRUD
- 不能: 创建/修改合同/报价/回款
```

---

## 4. 第三阶段实施范围 — 运营界面+项目交付 (Sprint 5-6)

### 4.1 运营Operator界面

**默认首页: 待办工作台**
```
- 待确认回款: 最近未确认的payments
- 待更新交付: 里程碑到期的delivery_plans
- 今日逾期提醒: 当天到期/已逾期的分期
```

**合同管理**: CRUD + PDF上传 + 分期设置  
**回款管理**: 登记/确认/编辑  
**项目交付**: 里程碑管理 + 文档上传 + 验收管理  
**产品库**: CRUD (仅运营可改)  

### 4.2 第三阶段启用的表

| 表 | 说明 |
|----|------|
| delivery_plans | 交付计划, 里程碑跟踪 |
| project_milestones | 项目里程碑明细 |
| project_documents | CAD/PDF/照片上传 |
| project_inspections | 验收记录 |
| quotation_items | 行项目(完整报价) |
| products CRUD | 产品库管理页面 |

---

## 5. 删掉不做 / 推迟的范围

### 5.1 明确推迟的表

| 表 | 推迟原因 | 预计启用 |
|----|---------|---------|
| quotation_items | MVP报价只填总金额, 不需要行项目 | 第三阶段 |
| delivery_plans | 没有运营就不需要交付计划 | 第三阶段 |
| project_milestones | 没有运营就不需要里程碑 | 第三阶段 |
| project_documents | 没有运营就不需要文档上传 | 第三阶段 |
| project_inspections | 没有运营就不需要验收 | 第三阶段 |
| sales_targets | 老板Dashboard阶段需要 | 第二阶段 |

### 5.2 明确推迟的触发器

| 触发器 | 理由 |
|--------|------|
| 分期自动逾期检测 | 不需要UTC定时任务, 查询时计算 |
| 交付延期检测 | 推迟到第三阶段 |
| 分期→合同自动完成 | 推迟到第二阶段 |
| 报价过期自动标记 | MVP阶段手动操作即可 |

### 5.3 明确推迟的RLS策略

| 策略 | 理由 |
|------|------|
| delivery_plans所有RLS | 表已推迟 |
| project_milestones所有RLS | 表已推迟 |
| project_documents所有RLS | 表已推迟 |
| project_inspections所有RLS | 表已推迟 |
| sales_targets所有RLS | 表已推迟 |

### 5.4 明确不做的功能

| 功能 | 理由 |
|------|------|
| 移动端App | 先用PWA/响应式, 不做原生App |
| 邮件/WhatsApp集成 | 手动记录足够, 自动集成高成本低回报 |
| 电子签名 | 迪拜市场不成熟, 未来考虑 |
| 多语言(i18n) | 当前只有Tanya+老板, 英文/中文够用 |
| 报表导出Excel | Google Sheets已有此能力 |
| 数据导入(批量) | 一次性迁移即可 |
| 审计日志(business_events) | 从30种砍到10种, 仅保留核心事件 |
| 产品库管理页面 | 先建表导入数据, 运营阶段再做CRUD页面 |
| 报价行项目编辑器 | 简版报价只填总金额 |
| 客户统一档案(完整版) | 只建customers表, 详情页推迟 |

---

## 6. 角色分权最终版 — 三套界面信息架构

### 6.1 同一代码库架构

```
app.newme.ae (Next.js)
  ├── /api/*           → 同一API, 角色过滤在Middleware层
  ├── /dashboard       → 老板驾驶舱 (role: boss)
  ├── /sales/*         → 销售工作台 (role: sales)
  ├── /ops/*           → 运营工作台 (role: operator)
  └── /auth/*          → 登录/设置

Middleware (supabase/middleware.ts):
  ├── 1. 读取 profiles.role
  ├── 2. 重定向到对应首页: /dashboard | /sales/today | /ops/todo
  ├── 3. API调用注入角色header → Supabase RLS自动过滤
  └── 4. 非法路由访问 → 403
```

### 6.2 老板SAM侧边栏 (6项)

| # | 菜单 | 数据范围 | 操作 |
|---|------|---------|------|
| 1 | **驾驶舱** 📊 | 全量聚合 | 只看 |
| 2 | 线索管道 | 全量线索 | 只读+分配/转移 |
| 3 | 回款看板 | 全量回款 | 只看 |
| 4 | 合同总览 | 全量合同 | 只看 |
| 5 | 团队概况 | 全量销售数据(含金额) | 只看 |
| 6 | 个人设置 | — | — |

**不出现在老板侧边栏**: 报价、产品库、活动记录、分期明细

### 6.3 运营工作台侧边栏 (8项)

| # | 菜单 | 数据范围 | 操作 |
|---|------|---------|------|
| 1 | **待办工作台** | 待确认回款+待更新交付 | 确认/更新 |
| 2 | 合同管理 | 全量合同 | CRUD |
| 3 | 回款管理 | 全量回款 | 登记/确认/编辑 |
| 4 | 项目交付 | 全量项目 | CRUD |
| 5 | 客户档案 | 全量客户 | CRUD |
| 6 | 产品库 | 全量产品 | 只读(后续CRUD) |
| 7 | 分期管理 | 全量分期 | 设置/修改 |
| 8 | 个人设置 | — | — |

**不出现在运营侧边栏**: 线索管道、报价管理、销售业绩、Dashboard大盘

### 6.4 销售Tanya侧边栏 (7项)

| # | 菜单 | 数据范围 | 操作 |
|---|------|---------|------|
| 1 | **今日待办** 📋 | 自己的线索 | 跟进/记录 |
| 2 | 我的管道 | 自己的线索 | Kanban+拖拽 |
| 3 | 我的客户 | 自己的客户 | 只读 |
| 4 | 我的合同 | 自己的合同 | 只读(隐藏金额) |
| 5 | 我的业绩 | 自己的数据 | 只读(无金额) |
| 6 | — | 分隔线 | — |
| 7 | 个人设置 | — | — |

**不出现在销售侧边栏**: 产品库、报价管理(在线索详情操作)、回款管理、项目交付详情、团队概况、销售目标金额

### 6.5 销售看不到的金融数据清单

| 数据 | 处理方式 |
|------|---------|
| contract_amount | API返回时隐藏, 前端不渲染 |
| payment.amount | 不在销售界面出现 |
| installment_plans.amount | 不在销售界面出现 |
| 别人的performance | RLS过滤 + 前端不显示 |
| sales_targets.target_amount | 不进入销售API |
| 累计回款总额 | 不在销售界面出现 |
| 管道总金额 | 仅显示自己的线索求和 |
| 成交金额 | 仅显示数量, 不显示金额 |

### 6.6 安全架构决策

```
RLS (数据库层)        → 基础行级过滤, 防止越权查询
  ├── sales: assigned_to = auth.uid()
  ├── boss: 全量SELECT
  └── operator: 全量CRUD

Middleware (API层)    → 角色隔离, 防止错误路由
  ├── /api/sales/*    → 仅sales角色可访问
  ├── /api/boss/*     → 仅boss角色可访问
  └── /api/ops/*      → 仅operator角色可访问

前端组件层            → 数据字段级隐藏(销售隐藏金额)
  ├── 角色context读取 user.profile.role
  ├── 数据如含金额字段, sales角色自动过滤
  └── 使用通用组件 + 角色参数控制渲染
```

---

## 7. 实施路线图 (6 Sprint)

```
                    Sprint 1-2                     Sprint 3-4                 Sprint 5-6
        ┌──────────────────────────┐    ┌──────────────────────┐   ┌──────────────────────┐
        │   🥇 销售Tanya的界面       │    │   🥈 老板SAM的Dashboard │   │   🥉 运营Operator界面    │
        │                          │    │                      │   │                      │
  DDL   │  10张核心表+修正BLOCKERS  │    │  payments/installments │   │  delivery_plans      │
 修正   │  +boss角色+RLS补全       │    │  +sales_targets启用    │   │  +project_milestones  │
        │  +security_invoker       │    │  +所有trigger启用      │   │  +项目文档/验收       │
        │                          │    │                      │   │  +quotation_items     │
 前端   │  今日待办                │    │  驾驶舱(4KPI+预警)     │   │  待办工作台           │
 开发   │  我的管道(Kanban)        │    │  回款看板              │   │  合同管理(CRUD+PDF)   │
        │  线索详情                │    │  合同总览              │   │  回款登记             │
        │  快速跟进                │    │  团队概况              │   │  分期管理             │
        │  简版报价(总金额)        │    │  线索分配/转移         │   │  项目里程碑管理       │
        │  标记成交/输单           │    │  移动端适配            │   │  文档上传/验收        │
        │  我的业绩(无金额)        │    │                      │   │  产品库CRUD          │
        │                          │    │                      │   │  客户档案            │
        └──────────────────────────┘    └──────────────────────┘   └──────────────────────┘
                  ↓                              ↓                           ↓
             Tanya开始用                      SAM看到价值                  全流程跑通
```

---

## 8. 快速启动指令 (本周)

### 当前待执行SQL清单

```
1. ALTER profiles 增加 boss 角色 + UPDATE迁移已有数据
2. 按正确顺序重新创建 activities/quotations/contracts/installments/payments
3. 为 leads 增加 sales INSERT 策略
4. 为 activities 增加综合RLS (contract_id/quote_id/project_id)
5. 删除废弃 'manager' 角色 RLS 策略
6. 所有视图加 security_invoker = true
7. business_events 从30种缩到10种
8. 时区设 Asia/Dubai
9. 新增索引 (idx_leads_today_pipeline, idx_payments_unconfirmed等)
10. 新增视图 (v_funnel_conversion, v_sales_personal_stats)
11. 删除冗余索引 (idx_contracts_sales_status, idx_payments_contract_amount)
12. 新增 payments.overpayment_action 字段
```

### DDL迁移文件更新

基于以上修正, 需要生成一个新的迁移文件 `20260606000000_newme_crm_final_simplified.sql`, 内容为:
- 保留10张核心表的DDL (leads, customers, activities, profiles, products, quotations, contracts, installment_plans, payments, projects)
- 推迟6张表 (quotation_items, delivery_plans, project_milestones, project_documents, project_inspections, sales_targets)
- 加入所有BLOCKER修正 + P0安全补丁 + 索引优化
- 简化版business_events
- 安全增强的RLS策略
- 新增5个推荐视图

---

*本文档由产品总监基于前两轮审查结论+架构总监审查+GPT战略反馈+角色分权需求综合输出。*
*下一动作: 生成简化版DDL迁移文件 20260606000000_newme_crm_final_simplified.sql*
