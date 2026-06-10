# 架构总监审查报告：CRM v2 技术架构

**审查日期**: 2026-06-02
**审查人**: 架构总监
**版本**: CRM v2 (feat/crm-v2 分支)

---

## 判定: CONDITIONAL

**通过条件**: 完成下文列出的数据模型重构 + 预警系统架构设计后，方可进入下一阶段。

现有架构对于 **266条数据/1个销售** 的场景是**可接受的**——Next.js 16 + Supabase + shadcn/ui 组合在快速迭代上没问题。但数据模型存在**结构性缺陷**，预警/预测能力为**零**，无法支撑"管理驾驶舱"业务目标。

---

## 一、现有架构评估

### 1.1 当前分层

```
┌──────────────────────────────────────────┐
│  Client (Next.js App Router)             │
│  ├── dashboard/          (PAGE, CSR)     │
│  ├── leads/              (PAGE, CSR, .bak)│
│  ├── leads/[id]/        (PAGE, CSR)      │
│  ├── leads/new/          (PAGE, CSR)      │
│  ├── projects/           (PLACEHOLDER)    │
│  └── quotes/             (PLACEHOLDER)    │
├──────────────────────────────────────────┤
│  Supabase Client SDK  ← 所有查询在客户端  │
├──────────────────────────────────────────┤
│  PostgreSQL (Supabase)                   │
│  ├── leads                               │
│  ├── activities         ← 空表            │
│  ├── quotes                              │
│  ├── projects                            │
│  ├── chat_messages                       │
│  └── profiles                            │
└──────────────────────────────────────────┘
```

### 1.2 核心问题清单

| 问题 | 严重度 | 说明 |
|------|--------|------|
| **D1. `stage` vs `funnel_stage` 双列并存** | 致命 | 初始表有 `stage` (8值), v2迁移加 `funnel_stage` (9值)。两套阶段系统，new-lead页面写 `stage`, dashboard读 `funnel_stage`。数据碎片化。 |
| **D2. 无收入预测字段** | 致命 | 老板核心需求。缺 `forecast_amount`, `weighted_amount`, `expected_close_date`。 |
| **D3. `activities` 表为空** | 高 | 导致时间轴、阶段停留时间、历史转化率均不可算。 |
| **D4. 0条成交记录** | 高 | `won` 状态无数据→转化率=0→预测无基准。 |
| **D5. 无阶段停留时间** | 高 | `stage_changed_at` 字段存在但从未使用，无 `dwell_days` 计算或视图中体现。 |
| **D6. Dashboard 全量前端聚合** | 中 | 266条数据量下载到浏览器再聚合是可接受的，但扩展性差（>1000条时退化）。 |
| **D7. 无预警系统** | 高 | 无超期未跟进提醒、无今日待办、无 bottleneck 提示。 |
| **D8. 无团队绩效** | 中 | 当前仅Figma中有 sales_performance 视图但未被前端消费。 |

---

## 二、数据模型重构方案

### 2.1 立即执行：合并 stage 体系

**扔掉 `stage` 列**（原始8值），统一使用 `funnel_stage`（9值，更细粒度匹配销售流程）。

```sql
-- 1) 将旧 stage 数据迁移到 funnel_stage（如果有的行只有 stage 没有 funnel_stage）
UPDATE leads 
SET funnel_stage = CASE stage
  WHEN 'needs_analysis' THEN 'requirement_confirmed'
  WHEN 'quoted' THEN 'quotation_submitted'
  WHEN 'negotiating' THEN 'negotiation'
  ELSE stage
END
WHERE funnel_stage IS NULL OR funnel_stage = '';

-- 2) 删除冗余 stage 列
ALTER TABLE leads DROP COLUMN IF EXISTS stage;

-- 3) 添加 NOT NULL 约束和 CHECK
ALTER TABLE leads 
  ALTER COLUMN funnel_stage SET NOT NULL,
  ALTER COLUMN funnel_stage SET DEFAULT 'new';
```

### 2.2 新增字段：收入预测

```sql
-- Revenue forecasting fields
ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_amount DECIMAL(12,2);
  -- 预估成交金额（销售手动填，与 quotation_value 区分）
ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_close_date DATE;
  -- 预计签单日期
ALTER TABLE leads ADD COLUMN IF NOT EXISTS forecast_category TEXT 
  CHECK (forecast_category IN ('commit', 'best_case', 'pipeline'));
  -- Salesforce 三档预测法：commit=高概率, best_case=中, pipeline=低
ALTER TABLE leads ADD COLUMN IF NOT EXISTS win_probability INTEGER DEFAULT 0
  CHECK (win_probability >= 0 AND win_probability <= 100);
  -- 成交概率 0-100（已有但未用，补充 CHECK）
```

### 2.3 新增字段：阶段停留时间

```sql
-- Stage dwell time (已存在 stage_changed_at，只需添加计算字段)
-- 方案：不存冗余计算值，创建视图
CREATE OR REPLACE VIEW lead_stage_dwell AS
SELECT 
  id,
  customer_name,
  funnel_stage,
  stage_changed_at,
  CASE 
    WHEN stage_changed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (COALESCE(updated_at, now()) - stage_changed_at)) / 86400
  END AS dwell_days
FROM leads;
```

### 2.4 新增字段：预警与跟催

```sql
-- 已有 next_followup_date, last_contact_date, followup_count, next_action
-- 这些字段已存在但前端未消费，补充 overdue 视图
CREATE OR REPLACE VIEW lead_alerts AS
SELECT 
  id,
  customer_name,
  phone,
  funnel_stage,
  quotation_value,
  win_probability,
  assigned_to,
  next_followup_date,
  last_contact_date,
  followup_count,
  next_action,
  CASE 
    WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE 
      THEN 'overdue_followup' 
    WHEN last_contact_date IS NOT NULL AND last_contact_date < CURRENT_DATE - INTERVAL '7 days'
      AND funnel_stage NOT IN ('won', 'lost')
      THEN 'stale_lead'
    WHEN followup_count >= 5 AND funnel_stage = 'new'
      THEN 'over_contacted'
    ELSE NULL
  END AS alert_type,
  CASE 
    WHEN next_followup_date IS NOT NULL AND next_followup_date < CURRENT_DATE 
      THEN '逾期未跟进，已超过预定跟进日期'
    WHEN last_contact_date IS NOT NULL AND last_contact_date < CURRENT_DATE - INTERVAL '7 days'
      THEN '超过7天未联系，建议尽快跟进'
    WHEN followup_count >= 5 AND funnel_stage = 'new'
      THEN '已联系5次以上但仍在新线索阶段，建议降级或淘汰'
    ELSE NULL
  END AS alert_message
FROM leads
WHERE disqualified_candidate = false;
```

### 2.5 新增表：收入预测快照

```sql
-- 月/周收入预测快照（供趋势分析和历史回溯）
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  period_type   TEXT NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  
  -- 三档预测
  commit_amount     DECIMAL(12,2) DEFAULT 0,
  best_case_amount  DECIMAL(12,2) DEFAULT 0,
  pipeline_amount   DECIMAL(12,2) DEFAULT 0,
  
  -- 实际数据（回溯时回填）
  actual_amount     DECIMAL(12,2),
  actual_count      INTEGER,
  
  -- 元数据
  snapshot_json     JSONB,  -- 原始计算明细
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_forecast_snapshots_date ON forecast_snapshots(snapshot_date DESC);
CREATE INDEX idx_forecast_snapshots_period ON forecast_snapshots(period_type, period_start);
```

### 2.6 新增视图：团队绩效增强

```sql
-- 增强版销售绩效视图（替代原始 sales_performance）
CREATE OR REPLACE VIEW sales_performance_v2 AS
SELECT 
  p.id,
  p.full_name,
  COUNT(l.id) FILTER (WHERE l.funnel_stage = 'new') AS new_leads,
  COUNT(l.id) FILTER (WHERE l.funnel_stage = 'contacted') AS contacted,
  COUNT(l.id) FILTER (WHERE l.funnel_stage = 'quotation_submitted') AS in_quote,
  COUNT(l.id) FILTER (WHERE l.funnel_stage = 'won') AS won,
  COUNT(l.id) FILTER (WHERE l.funnel_stage = 'lost') AS lost,
  
  -- 金额
  COALESCE(SUM(l.quotation_value) FILTER (WHERE l.funnel_stage = 'quotation_submitted'), 0) AS pipeline_amount,
  COALESCE(SUM(l.expected_amount) FILTER (WHERE l.funnel_stage IN ('won', 'quotation_submitted', 'negotiation')), 0) AS weighted_forecast,
  
  -- 转化率
  CASE 
    WHEN COUNT(l.id) FILTER (WHERE l.funnel_stage NOT IN ('new', 'lost')) > 0 
    THEN ROUND(
      COUNT(l.id) FILTER (WHERE l.funnel_stage = 'won')::DECIMAL / 
      COUNT(l.id) FILTER (WHERE l.funnel_stage NOT IN ('new', 'lost')) * 100, 1
    )
    ELSE 0
  END AS win_rate,
  
  -- 活跃度指标
  COUNT(l.id) FILTER (WHERE l.last_contact_date >= CURRENT_DATE - INTERVAL '3 days') AS contacted_recently,
  COUNT(l.id) FILTER (WHERE l.funnel_stage NOT IN ('won', 'lost') AND 
    (l.last_contact_date IS NULL OR l.last_contact_date < CURRENT_DATE - INTERVAL '7 days')) AS stale_leads,
  COUNT(l.id) FILTER (WHERE l.next_followup_date < CURRENT_DATE) AS overdue_tasks
  
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id AND l.disqualified_candidate = false
WHERE p.role IN ('admin', 'manager', 'sales')
GROUP BY p.id, p.full_name;
```

### 2.7 索引优化

```sql
-- 新增索引（支撑预警查询和漏斗分析）
CREATE INDEX IF NOT EXISTS idx_leads_funnel_stage ON leads(funnel_stage);
CREATE INDEX IF NOT EXISTS idx_leads_next_followup ON leads(next_followup_date) 
  WHERE disqualified_candidate = false;
CREATE INDEX IF NOT EXISTS idx_leads_last_contact ON leads(last_contact_date) 
  WHERE disqualified_candidate = false;
CREATE INDEX IF NOT EXISTS idx_leads_expected_close ON leads(expected_close_date);
CREATE INDEX IF NOT EXISTS idx_leads_forecast_cat ON leads(forecast_category);
```

---

## 三、架构分层建议

### 3.1 目标架构

```
┌────────────────────────────────────────────────────┐
│  Presentation Layer (Next.js App Router)           │
│  ├── dashboard/      ← Server Component + Client   │
│  │   ├── page.tsx    ← 只做首次数据SSR             │
│  │   └── widgets/    ← 预警条/预测卡片/漏斗/待办    │
│  ├── leads/          ← Kanban + 列表 (CSR)         │
│  ├── leads/[id]/     ← Client Component (CSR)      │
│  └── reports/        ← 新增：团队绩效/导出          │
├────────────────────────────────────────────────────┤
│  Service Layer (Next.js API Routes / Server Actions)│
│  ├── api/forecast/    ← 收入预测聚合               │
│  ├── api/alerts/      ← 预警查询                   │
│  └── api/leads/batch  ← 批量操作                   │
├────────────────────────────────────────────────────┤
│  Cron / Background (Vercel Cron Jobs or pg_cron)   │
│  ├── forecast-snapshot   ← 每日凌晨，拍快照         │
│  └── alert-check         ← 每小时，生成预警         │
├────────────────────────────────────────────────────┤
│  Data Layer (Supabase PostgreSQL)                  │
│  ├── leads (augmented)                             │
│  ├── activities (to be populated)                  │
│  ├── forecast_snapshots (new)                      │
│  ├── lead_alerts (view)                            │
│  └── sales_performance_v2 (view)                   │
└────────────────────────────────────────────────────┘
```

### 3.2 266条数据量下的权衡决策

| 计算场景 | 推荐方式 | 理由 |
|----------|----------|------|
| **漏斗计数** | 前端聚合（当前方式） | 266条全量拉取 < 50KB，浏览器聚合即时完成。无需后端的查询开销。 |
| **收入预测** | Supabase 服务端视图 | `SUM(win_probability * expected_amount)` 需要在 SQL 中做加权计算，前端做易错。 |
| **预警列表** | Supabase 视图 + API Route | 预警规则会变，视图统一维护，前端调用 `/api/alerts` 即可。 |
| **阶段停留时间** | Postgres 视图 | 涉及 `EXTRACT(EPOCH...)` 计算，交给 PG 更可靠。 |
| **历史趋势** | Vercel Cron 每日快照 | 趋势需要跨时间对比，实时计算无意义。cron 每日凌晨拍 `forecast_snapshots`。 |
| **团队绩效** | Supabase RPC (SQL Function) | 涉及多表JOIN+聚合，用 RPC 调用比前端逐条处理高效。 |

### 3.3 何时升级到后端聚合？

```
数据量增长阈值：
├── <1,000条  → 前端聚合 ✅ （266条场景）
├── 1,000-5,000条 → 使用 Supabase 视图 (当前建议逐步迁移)
└── >5,000条  → 需要 API Route + 后端缓存/Redis
```

**建议**: 底层准备好视图（2.2-2.6），前端继续用客户端 SDK 查视图。当查询时间 >200ms 时升级到 API Route。

---

## 四、预警系统架构

### 4.1 方案对比

| 方案 | 延迟 | 复杂度 | 适合场景 |
|------|------|--------|----------|
| **A: 前端实时SQL视图查询** | 即时（每次页面加载） | 低 | 🏆 **推荐** |
| **B: Cron + 通知入库** | 按cron间隔 | 中 | 未来邮件/推送通知时 |
| **C: Supabase DB Webhook** | 即时 | 中 | 事件驱动型预警（如新线索分配） |

### 4.2 推荐方案

**Phase 1 (立即)**: 方案A——使用 SQL 视图 `lead_alerts`

- Dashboard 加载时调用 `supabase.from("lead_alerts").select("*").neq("alert_type", null)`
- 前端展示预警条/卡片
- 零后端成本，SQL 视图实时反映数据库状态
- 266条下查询延迟 < 10ms

**Phase 2 (2周内)**: 方案B——Vercel Cron Jobs

```typescript
// /api/cron/check-alerts/route.ts (Vercel Cron)
export async function GET() {
  // 1. 将当前预警数据写入 alert_history 表
  // 2. 对比上次快照，发现新预警→发通知
  // 3. 更新 dashboard 右上角未读预警数
}
```

**Phase 3 (未来)**: 方案C——Supabase Database Webhooks

- 当 `leads.stage_changed_at` 更新时，触发 Webhook 检查超期
- 当 `leads.next_followup_date = today` 且未标记完成时，触发提醒

### 4.3 预警触发规则

```
1. 逾期跟进       ← next_followup_date < today
2. 7天未联系      ← last_contact_date < today-7 AND stage NOT IN (won, lost)
3. 过度联系       ← followup_count >= 5 AND stage = 'new'
4. 高金额卡住     ← quotation_value > 50K AND dwell_days > 14 AND stage = 'quotation_submitted'
5. 今晚到期       ← next_followup_date = today (当天最优先)
6. 阶段倒流       ← 检测到 stage 从 advanced 回到 early (需activities数据支持)
```

---

## 五、组件结构评估

### 5.1 当前结构

```
src/app/(dashboard)/
├── dashboard/page.tsx    ← 全量CSR，~300行，混合聚合逻辑+渲染
├── leads/page.tsx.bak    ← Kanban 看板（未完成，类型错误）
├── leads/[id]/page.tsx   ← 详情页，~360行，功能完整
├── leads/new/page.tsx    ← 新建页，~134行
├── projects/page.tsx     ← 占位符
└── quotes/page.tsx       ← 占位符
```

### 5.2 评估: **基本合理但可优化**

**优点**:
- `dashboard/`, `leads/`, `leads/[id]` 三层次清晰
- `[id]` 详情页功能完备（阶段更新、质量标注、添加备注、创建报价）
- 文件结构扁平，适合小团队快速迭代

**问题**:
1. **Dashboard 过胖**: 聚合逻辑（fetchStats）和渲染混在同一个文件，难以测试和扩展
2. **leads/list 不可用**: `.bak` 文件有类型错误，看板被阻塞
3. **无共享数据层**: 每个页面独立 `createClient()`，无全局状态管理 / React Query / SWR
4. **无 loading skeleton**: 仅简单 "加载中..." 文字

### 5.3 重构建议

```
src/
├── app/(dashboard)/
│   ├── dashboard/
│   │   ├── page.tsx              ← Server Component, 轻量
│   │   └── _components/
│   │       ├── MetricCards.tsx    ← 4个指标卡片
│   │       ├── FunnelChart.tsx    ← 漏斗图
│   │       ├── AlertBar.tsx       ← 预警条（新）
│   │       ├── ForecastCard.tsx   ← 收入预测（新）
│   │       └── WeeklyTrend.tsx    ← 趋势图
│   ├── leads/
│   │   ├── page.tsx              ← Kanban看板（修复 .bak）
│   │   └── _components/
│   │       ├── KanbanBoard.tsx
│   │       ├── LeadCard.tsx
│   │       └── FilterToolbar.tsx
│   └── reports/                  ← 新增
│       └── page.tsx              ← 团队绩效/收入预测报告
├── lib/
│   ├── supabase.ts               ← 保留（客户端单例）
│   ├── queries.ts                 ← 新增：可复用的查询封装
│   └── forecast.ts               ← 新增：预测计算工具函数
└── hooks/
    ├── useLeads.ts               ← 新增：SWR风格数据获取
    └── useAlerts.ts              ← 新增：预警数据
```

---

## 六、优先级排序

### P0 — 立即执行（本周）

| # | 任务 | 工作量 | 影响 |
|---|------|--------|------|
| 1 | **合并 stage/funnel_stage** — 迁移旧数据 + 删除 `stage` 列 | 1h | 消除数据碎片化 |
| 2 | **创建 `lead_alerts` 视图** — SQL 视图，零部署成本 | 30min | 预警系统立即可用 |
| 3 | **修复 leads/page.tsx** — 修复类型错误，让 Kanban 上线 | 2h | 解锁管理看板核心功能 |
| 4 | **Dashboard 预警条组件** — 消费 lead_alerts 视图 | 2h | 管理价值可视 |

### P1 — 本周

| # | 任务 | 工作量 | 影响 |
|---|------|--------|------|
| 5 | **新增 forecasting 字段 & 视图** — `expected_amount`, `expected_close_date`, `forecast_category` + `sales_performance_v2` | 2h | 收入预测基础 |
| 6 | **创建 `forecast_snapshots` 表** + 初始化迁移 | 1h | 趋势回溯能力 |
| 7 | **Dashboard ForecastCard** — 加权收入预测卡片 | 2h | 管理驾驶舱核心 |
| 8 | **Dashboard 组件拆分** — 将 ~300行 page.tsx 拆分为独立 widget | 2h | 可维护性 |

### P2 — 下周期

| # | 任务 | 工作量 | 影响 |
|---|------|--------|------|
| 9 | **Vercel Cron: forecast-snapshot** — 每日凌晨拍快照 | 3h | 历史趋势 |
| 10 | **Reports 页面** — 团队绩效 + 转化率分析 | 4h | 管理深度分析 |
| 11 | **Activities 数据回填** — 从现有数据推断历史活动 | 3h | 时间轴可用 |
| 12 | **预警通知** — 将预警推送到 Dashboard 或 Telegram | 4h | 主动管理 |

### P3 — 远期

| # | 任务 | 工作量 | 影响 |
|---|------|--------|------|
| 13 | Supabase Database Webhooks — 事件驱动预警 | 3h | 实时性提升 |
| 14 | React Query / SWR 引入 — 统一缓存和数据同步 | 2d | 用户体验 |
| 15 | 数据量 >5000 时迁移到 API Route 后端聚合 | 2d | 扩展性 |

---

## 七、风险与注意事项

### 7.1 技术风险

1. **`stage` 列删除风险**: 确认 `new-lead/page.tsx` 中 `stage: "new"` 已改为 `funnel_stage: "new"`。当前 new-lead 页面写 `stage` 列，删除后新建线索会失败。
2. **`.bak` 文件残留**: `leads/page.tsx.bak` 中存在对 `disqualified_candidate` 的未完善处理，需要确认生产状态。
3. **Supabase RLS 影响**: 新建的视图需要确保 RLS 策略一致（当前视图未启用 RLS，对所有认证用户可见——对于266条的规模可接受）。

### 7.2 业务风险

1. **0条成交记录 → 预测准确性低**: `won=0` 意味着无法计算历史转化率。建议手工设定初始 win_probability（例如 quotation_submitted=30%, negotiation=50%, pending_decision=70%），待积累数据后再校正。
2. **Tanya 1人场景**: 团队绩效功能当前无实际需求（单个销售不需要排名），但架构应预留多人支持（profiles 表已支持，views 已按 assigned_to 分组）。
4. **Google Sheets 并行**: Tanya 可能继续用 Sheets 管理，CRM 数据可能落后。需要数据同步策略或说服 Tanya 切换。

### 7.3 架构弹性提示

> 当前 266条/1人场景下，**不要过度设计**。所有视图/SQL 方案在 <5000条时无需引入 Redis、消息队列或专用后台任务服务。Cron 使用 Vercel 免费层的 Hobby plan 即可（每天最多执行2次 cron）。

---

## 八、总结

| 维度 | 评分 | 说明 |
|------|------|------|
| 技术栈选择 | ✅ PASS | Next.js 16 + Supabase + shadcn/ui 适合快速迭代 |
| 数据模型 | ❌ FAIL | 需合并 stage/funnel_stage + 新增预测/预警字段 |
| 组件结构 | ✅ CONDITIONAL | 三层合理，dashboard 需拆分，leads 需修复 |
| 扩展性 | ⚠️ 低风险 | 266条场景下前端聚合可行，架构已预留扩容路径 |
| 管理价值 | ❌ FAIL | 当前为"美化版 Sheets"，缺预警、预测、行动建议 |

**总体判定: CONDITIONAL**
条件: 完成 P0 + P1 数据模型重构后达到 PASS 标准。
