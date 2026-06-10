# NewMe CRM — Lead 归属权转移系统 完整设计方案

> 作者：Hermes Agent  
> 日期：2026-06-03  
> 版本：v1.0

---

## 目录

1. [现状分析](#1-现状分析)
2. [用户旅程设计](#2-用户旅程设计)
3. [数据模型](#3-数据模型)
4. [UI 入口设计方案](#4-ui-入口设计方案)
5. [业务规则](#5-业务规则)
6. [技术架构](#6-技术架构)
7. [实施优先级](#7-实施优先级)
8. [集成点清单](#8-集成点清单)

---

## 1. 现状分析

### 1.1 当前存在的问题（SAM 的痛点）

| 问题 | 表现 | 严重程度 |
|------|------|----------|
| 归属权修改脱离业务上下文 | 只能在 /settings 页面通过 dropdown 改 assigned_to | 🔴 核心 |
| 无转出/转入记录 | 改了就是改了，没有审计链路 | 🔴 核心 |
| 无通知机制 | 新销售不知道被分配了线索 | 🔴 核心 |
| 无 Timeline 事件 | Lead Timeline 上没有归属变更记录 | 🟡 重要 |
| RLS 未即时生效 | 实际只有一条 policies 在控制，但变更后页面不刷新 | 🟡 重要 |
| 报表无法分析转移 | 没有数据支撑"为什么这个销售老是转出线索" | 🟡 重要 |

### 1.2 现有基础（可复用部分）

```
✅ leads.assigned_to (UUID)        — 当前归属人
✅ leads.transfer_candidate        — 转移候选标记（DB Trigger 自动计算）
✅ leads.recovery_candidate        — 回收候选标记
✅ leads.sales_manager_review      — 主管审阅标记
✅ business_events 表              — 已有事件日志（需补充 owner_change 类型）
✅ profiles 表                     — 用户/角色系统
✅ 4 角色体系                       — admin / operator / sales / finance
✅ Dashboard 红标预警              — 已有 transfer_candidate 看板卡片
✅ 实时订阅 RLS                    — 已有的 RLS policy 框架
```

---

## 2. 用户旅程设计

### 2.1 核心场景时序图

```
[Admin/Operator]                     [System]                         [Sales(B)]
     │                                 │                                │
     ├─ 发现线索卡住 ─────────────────┤                                │
     │  (Dashboard红标/Pipeline瓶颈)   │                                │
     │                                 │                                │
     ├─ 点击"转移"按钮 ──────────────┤                                │
     │                                 │                                │
     │    ┌─────────────────────────┐ │                                │
     │    │ 弹窗: 选择目标销售 +     │ │                                │
     │    │ 选择转移原因(必选)        │ │                                │
     │    └─────────┬───────────────┘ │                                │
     │              │                 │                                │
     ├─ 确认转移 ───────────────────┤                                │
     │              │                 │                                │
     │              │  ┌─ 1.更新 assigned_to ──────────────────────┐  │
     │              │  │ 2.写入 transfer_history                    │  │
     │              │  │ 3.写入 business_events(owner_change)       │  │
     │              │  │ 4.写入 activities(timeline条目)            │  │
     │              │  │ 5.触发通知(新销售收到消息)                  │  │
     │              │  │ 6.clear transfer_candidate flag             │  │
     │              │  └───────────────────────────────────────────┘  │
     │                                 │                                │
     │  ┌─ 成功提示 ──┐               │                                │
     │  │ "已从A转至B" │               │                                │
     │  │ "查看转移历史"              │                                │
     │  └─────────────┘               │                                │
     │                                 │                                │
     │                                 │           通知: "您收到了      │
     │                                 │           新线索: XXX"         │
     │                                 │                                │
```

### 2.2 详细用户旅程（分角色）

#### 场景 A: Admin 在 Dashboard 发现 Red Alert

```
1. Admin 登录 → 看到 Dashboard
2. 看到 🔴 Red Alert 卡片显示 "14+天无跟进: 12条" + "Transfer Candidates: 5条"
3. Admin 点击 "Transfer Candidates: 5" → 跳转到 /leads?transfer=1
4. 页面显示过滤后的 5 条线索列表，每条卡片有 "转移" 按钮
5. Admin 点击某线索的 "转移" → 弹出 TransferModal
6. 弹窗内容:
   - 线索基本信息（姓名、阶段、金额、当前销售A）
   - 目标销售搜索/下拉（显示在职 sales 列表，排除当前人）
   - 转移原因: 下拉必选 [跟进超时/客户投诉/工作量调整/升单需要/销售离职/其他]
   - 备注: 可选文本
7. Admin 选择销售B + 原因 + 备注 → 确认
8. 系统执行完整转移流程 → 成功提示
9. Admin 可选择 "查看转移历史" → 进入 /leads/[id] 看 Timeline
```

#### 场景 B: Operator 在 Pipeline 视图中

```
1. Operator 打开 Pipeline 看板
2. 在 "quotation_submitted" 列看到一张标注 [Transfer] 的卡片
3. 将鼠标悬停 → 卡片右上角出现 "转移" 按钮（GripHorizontal 图标）
4. 点击 → 弹出 TransferModal（同场景 A）
5. 完成后该卡片立即从旧销售的视图消失，出现在新销售的 Pipeline 中
```

#### 场景 C: Lead 详情页直接转移

```
1. 任意有权限的用户打开 /leads/[id]
2. 右侧 "Manager Section" 卡片中显示当前分配信息
3. 增加一行 "归属销售" + [转移] 按钮
4. 点击 [转移] → 弹出 TransferModal
5. 与上面相同的体验
```

#### 场景 D: 批量转移（Manager 批量操作）

```
1. Admin 在 /leads 列表视图中勾选多条线索
2. 底部批量操作栏出现 "批量转移" 按钮
3. 点击 → 弹窗（类似批量分配但多了原因字段）
4. 选择目标销售 + 原因 → 确认
5. 每条线索逐一执行转移（含历史记录、通知）
6. 批量完成后显示结果汇总: "成功 5 条"
```

---

## 3. 数据模型

### 3.1 transfer_history 表（新建）

```sql
CREATE TABLE transfer_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  
  -- 归属变更信息
  from_user_id    UUID REFERENCES profiles(id),          -- 原销售（可为 null = 未分配）
  to_user_id      UUID REFERENCES profiles(id),          -- 新销售
  transferred_by  UUID NOT NULL REFERENCES profiles(id), -- 操作人（admin/operator）
  
  -- 业务信息
  reason          TEXT NOT NULL CHECK (reason IN (
    'followup_timeout',    -- 跟进超时
    'customer_complaint',  -- 客户投诉
    'workload_adjustment', -- 工作量调整
    'upsell_opportunity',  -- 升单需要
    'sales_resignation',   -- 销售离职
    'auto_rebalance',      -- 自动均衡
    'manual_override'      -- 手动干预
  )),
  note            TEXT,           -- 备注
  stage_at_transfer TEXT,        -- 转移时的阶段（快照）
  value_at_transfer DECIMAL(12,2), -- 转移时的报价金额（快照）
  
  -- 系统
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 索引
CREATE INDEX idx_transfer_history_lead_id ON transfer_history(lead_id);
CREATE INDEX idx_transfer_history_from_user ON transfer_history(from_user_id);
CREATE INDEX idx_transfer_history_to_user ON transfer_history(to_user_id);
CREATE INDEX idx_transfer_history_created_at ON transfer_history(created_at DESC);
CREATE INDEX idx_transfer_history_reason ON transfer_history(reason);

-- RLS
ALTER TABLE transfer_history ENABLE ROW LEVEL SECURITY;

-- admin/operator 完全访问
CREATE POLICY "transfer_history_admin_all" ON transfer_history FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

-- sales 可以查看与自己相关的转移记录
CREATE POLICY "transfer_history_sales_own" ON transfer_history FOR SELECT
  USING (from_user_id = auth.uid() OR to_user_id = auth.uid());

-- 系统/触发器写入（service role）
CREATE POLICY "transfer_history_service_insert" ON transfer_history FOR INSERT
  WITH CHECK (true);
```

### 3.2 leads 表扩展

在现有 `assigned_to` 字段基础上，增加一个辅助字段以支持更精准的 RLS：

```sql
-- 不需要新建字段。现有的 assigned_to (UUID) 就是归属人。
-- 但建议统一命名规范：如果 assigned_to 当前是 TEXT，转换为 UUID 类型
ALTER TABLE leads ALTER COLUMN assigned_to TYPE UUID USING assigned_to::UUID;
```

**注意**: 当前代码中 `assigned_to` 在 TypeScript 类型里是 `string | null`，实际 DB 中是 UUID 引用但可能存在 TEXT 值。建议在迁移前先做数据清洗。

### 3.3 business_events 补充

当前的 `business_events.event_type` 约束中已经包含 `'owner_change'`，但从未被使用。

需要补充一条触发记录逻辑：当 `assigned_to` 变更时，自动写入 `business_events`。

可以在应用层（API/Service Layer）处理，也可以新增 DB Trigger。

### 3.4 activities 表补充

在 `activities` 表中新增 `type = 'ownership_transferred'` 类型，用于 Lead Timeline 展示。

---

## 4. UI 入口设计方案

### 4.1 入口矩阵

| 页面 | 入口位置 | 触发方式 | 优先级 |
|------|----------|----------|--------|
| **Dashboard** | Transfer Candidates 卡片 | 点击数字跳转到 /leads?transfer=1 | P0 |
| **Leads 列表** | 每条线索卡片的操作按钮 | 点击 GripHorizontal 图标 | P0 |
| **Leads 列表（批量）** | 底部批量操作栏 | 勾选后出现 "批量转移" | P1 |
| **Lead 详情页** | 右侧 Manager Section | "归属销售"行 + [转移] 按钮 | P0 |
| **Pipeline 看板** | 卡片 hover 操作区 | GripHorizontal 图标 | P1 |
| **Settings 页** | 已有分配 dropdown → 升级为转移 | 带原因的转移弹窗替代直接改值 | P2 |

### 4.2 TransferModal 组件设计（核心复用组件）

```
┌─────────────────────────────────────────────────┐
│  🔄 转移归属权                                    │
│                                                    │
│  客户: 张三 (quotation_submitted · AED 50K)        │
│  当前销售: [头像] 李明                              │
│  ───────────────────────────────────────────      │
│                                                    │
│  目标销售 *                                       │
│  ┌─────────────────────────────────────┐          │
│  │ 🔍 搜索销售姓名/邮箱...              │          │
│  └─────────────────────────────────────┘          │
│                                                    │
│  ┌─ 可用销售列表 ─────────────────────────┐       │
│  │ ○ 王芳 · 3条活跃 · 转出率12%           │       │
│  │ ● 赵强 · 7条活跃 · 转出率5%  ← 选中    │       │
│  │ ○ 陈静 · 2条活跃 · 转出率8%            │       │
│  └───────────────────────────────────────┘       │
│                                                    │
│  转移原因 *                                       │
│  ┌─────────────────────────────────────┐          │
│  │ ▼ 请选择原因                        │          │
│  │  跟进超时 (14+天无动作)              │          │
│  │  客户投诉                            │          │
│  │  工作量调整                          │          │
│  │  升单需要（匹配度更高）              │          │
│  │  销售离职                            │          │
│  │  手动干预                            │          │
│  └─────────────────────────────────────┘          │
│                                                    │
│  备注 (可选)                                       │
│  ┌─────────────────────────────────────┐          │
│  │ 客户要求换人跟进...                   │          │
│  └─────────────────────────────────────┘          │
│                                                    │
│  ┌────────────────────  ───────────────────┐       │
│  │ [取消]              [✓ 确认转移]        │       │
│  └─────────────────────────────────────────┘       │
│                                                    │
│  ⚠️ 转移后: 原销售立即失去访问权限                  │
│     新销售收到通知 · Timeline 更新                  │
└─────────────────────────────────────────────────┘
```

### 4.3 Dashboard 预警区增强

在现有的 Manager Cards 区域（`dashboard/page.tsx` 第 287-300 行），对 Transfer Candidates 卡片增加直接操作入口：

```tsx
// 增强后: 出现转出汇总列表
<button onClick={() => router.push("/leads?transfer=1")}
  className="...">
  <div className="flex items-center justify-between mb-3">
    <div className="flex items-center gap-2">
      <GripHorizontal className="w-4 h-4 text-red-400" />
      <span>转移候选</span>
      <span className="text-2xl font-bold">{stats.transferCount}</span>
    </div>
    <span className="text-xs text-red-400 hover:underline">立即处理 →</span>
  </div>
  <div className="space-y-1">
    {/* 展示所有 transfer_candidate 线索的简表 */}
    {transferCandidates.slice(0, 3).map(l => (
      <div key={l.id} className="flex justify-between text-xs">
        <span>{l.customer_name}</span>
        <span className="text-muted-foreground">{l.stage} · {daysSince(l.updated_at)}天</span>
      </div>
    ))}
  </div>
</button>
```

### 4.4 Pipeline 瓶颈视图增强

在 Pipeline 页面（`pipeline/page.tsx`）每列头部增加瓶颈标记：

```tsx
// 在阶段列头部
{stageData.staleCount > 0 && (
  <span className="text-rose-400 text-xs font-medium">
    ⏳ {stageData.staleCount} 待处理
  </span>
)}
{stageData.transferCount > 0 && (
  <span className="text-red-400 text-xs font-medium ml-1">
    ↗️ {stageData.transferCount} 待转移
  </span>
)}
```

---

## 5. 业务规则

### 5.1 转移权限矩阵

| 操作 | Admin | Operator | Sales | Finance |
|------|-------|----------|-------|---------|
| 查看 Transfer Candidates | ✅ | ✅ | ❌ | ❌ |
| 执行转移（单条） | ✅ | ✅ | ❌ | ❌ |
| 执行批量转移 | ✅ | ✅ | ❌ | ❌ |
| 查看转移历史 | ✅ | ✅ | 仅自己相关 | ❌ |
| 收到线索通知 | - | - | ✅ | - |
| 拒绝接受转移 | ❌ | ❌ | ❌ | ❌ |
| 申请转出（建议） | ❌ | ❌ | 可建议 | ❌ |

**核心原则**: Sales 不能转移自己的线索，只能由 Admin/Operator 操作。但 Sales 可以发起"转出建议"（在 Lead 详情页点击"建议转出"按钮，生成一条待审批记录）。

### 5.2 transfer_candidate 触发条件

| 条件 | 触发 |
|------|------|
| 跟进超期 14+ 天（`last_contact_date` / `updated_at`） | `transfer_candidate = true` |
| 报价提交后 30+ 天无进展 | `transfer_candidate = true` |
| 下一跟进日期逾期 14+ 天 | `transfer_candidate = true` |
| 主管手动标记 | `transfer_candidate = true` |
| 高概率(≥70%) + 14天无动作 | `sales_manager_review = true`（非直接转移标记） |
| Pending Decision > 30天 | `sales_manager_review = true`（非直接转移标记） |

### 5.3 转移后自动重置规则

转移完成后，系统自动清理相关标记：

```
✅ transfer_candidate = false
✅ recovery_candidate = false（新销售从零开始）
✅ sales_manager_review = false（已处理）
⚠️ last_contact_date 不变（历史数据保留）
⚠️ next_followup_date 不清除（新销售可以看到原有安排）
```

### 5.4 通知规则

| 事件 | 通知谁 | 方式 | 内容 |
|------|--------|------|------|
| 线索转入 | 目标 Sales | 系统内消息 | "你收到了来自 [旧销售] 的线索 [客户姓名] (阶段, 金额), 原因: [原因]" |
| 线索转出 | 原 Sales | 系统内消息 | "你的线索 [客户姓名] 已转移至 [新销售], 原因: [原因]" |
| 批量转移完成 | 操作者 | Toast | "成功转移 N 条线索" |
| 转移失败 | 操作者 | Toast + Error | "线索 [ID] 转移失败: [错误]" |

---

## 6. 技术架构

### 6.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                   Frontend (Next.js)                            │
│                                                                  │
│  TransferModal (复用组件)    TransferHistoryPanel (复用组件)     │
│       │                            │                            │
│       ├─ Dashboard 入口            ├─ Lead 详情页               │
│       ├─ Leads 列表入口            ├─ Settings 历史面板          │
│       ├─ Lead 详情入口             └─ 独立 /history 页面        │
│       ├─ Pipeline 入口                                          │
│       └─ 批量操作入口                                           │
└───────────────────────┬─────────────────────────────────────────┘
                        │ API Calls (Supabase client)
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Supabase Backend                               │
│                                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  leads   │  │transfer_hist │  │business_events│              │
│  │  table   │  │    ory       │  │   table      │              │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘              │
│       │               │                 │                       │
│       ▼               ▼                 ▼                       │
│  ┌─────────────────────────────────────────────────┐           │
│  │           RLS Policies                            │           │
│  │  • admin_all (admin/operator 全权)                │           │
│  │  • sales_own_leads (sales 只看自己)               │           │
│  │  • transfer_history_* (细粒度控制)                 │           │
│  └─────────────────────────────────────────────────┘           │
│                                                                  │
│  ┌─────────────────────────────────────────────────┐           │
│  │           DB Triggers                            │           │
│  │  • trg_on_assignment_change → 写 transfer_hist   │           │
│  │  • trg_update_lead_metrics (已有)                 │           │
│  └─────────────────────────────────────────────────┘           │
│                                                                  │
│  ┌─────────────────────────────────────────────────┐           │
│  │           Realtime / Notifications               │           │
│  │  • Supabase Realtime → 通知目标 Sales            │           │
│  └─────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 API 设计

#### 核心 API: `transferLead`

```typescript
// POST /api/leads/transfer 或 Supabase RPC
async function transferLead(params: {
  leadId: string;
  toUserId: string;
  reason: TransferReason;
  note?: string;
  transferredBy: string;   // 从 auth.user() 获取
}): Promise<{
  success: boolean;
  transferRecord: TransferHistory;
  error?: string;
}>
```

**内部执行步骤**（原子化，在 Supabase RPC 函数中完成）：

```sql
-- 1. 参数校验（目标不为空/原因合法/权限检查）
-- 2. 快照当前阶段和金额
-- 3. UPDATE leads SET assigned_to = to_user_id, 
--      transfer_candidate = false, recovery_candidate = false,
--      sales_manager_review = false, updated_at = now()
--    WHERE id = lead_id
-- 4. INSERT INTO transfer_history (lead_id, from, to, by, reason, note, stage, value)
-- 5. INSERT INTO business_events (lead_id, event_type='owner_change', ...)
-- 6. INSERT INTO activities (lead_id, type='ownership_transferred', ...)
-- 7. 触发通知（通过 Supabase Realtime 或 Edge Function）
```

#### 查询 API

```typescript
// 获取某个 Lead 的转移历史
GET /api/leads/:id/transfers
→ TransferHistory[]

// 获取销售的所有转移记录（转出+转入）
GET /api/sales/:id/transfers?role=from|to|all
→ TransferHistory[]

// 获取转移统计（用于报表）
GET /api/analytics/transfers?from=2026-01-01&to=2026-06-01
→ { totalTransfers, topReasons, topOutgoingSales, topIncomingSales }
```

### 6.3 RLS 策略设计

**核心原则**: 同一行数据，不同角色看到不同的记录。

转移历史表的 RLS：

```sql
-- admin/operator: 全量可见
CREATE POLICY "th_admin_operator_all" ON transfer_history FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

-- sales: 只看到和自己相关的
CREATE POLICY "th_sales_own" ON transfer_history FOR SELECT
  USING (from_user_id = auth.uid() OR to_user_id = auth.uid());

-- finance: 只读查看转移相关（用于报表）
CREATE POLICY "th_finance_read" ON transfer_history FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
```

### 6.4 组件树设计

```
components/
├── transfer/
│   ├── TransferModal.tsx              # 核心弹窗组件（单条转移）
│   ├── TransferModalBatch.tsx         # 批量转移弹窗
│   ├── TransferHistoryPanel.tsx       # 转移历史时间线面板
│   ├── TransferReasonSelect.tsx       # 转移原因下拉选择器
│   ├── TransferCandidateCard.tsx      # Dashboard/Card 展示卡片
│   ├── TransferSalesSearch.tsx        # 销售搜索+选择组件
│   ├── TransferConfirmDialog.tsx      # 二次确认对话框
│   └── TransferNotificationBadge.tsx  # 通知小红点
│
├── hooks/
│   ├── useTransferLead.ts             # 转移逻辑 Hook
│   ├── useTransferHistory.ts          # 查询转移历史 Hook
│   └── useTransferCandidates.ts       # 获取转移候选列表 Hook
│
└── lib/
    └── transfer-utils.ts              # 工具函数（权限检查/格式化等）
```

### 6.5 详细实现流程

#### 步骤 1：新建 migration `20260603000000_add_transfer_history.sql`

```sql
-- 1. 创建 transfer_history 表（含索引、RLS）
-- 2. 创建 RPC 函数 transfer_lead()
-- 3. 补充 activities 的 type check（如果有限制）
-- 4. 为 leads.assigned_to 补充索引
```

#### 步骤 2：创建 `components/transfer/TransferModal.tsx`

**State 设计**:
```
- open: boolean
- lead: Lead | null
- step: 'select_target' | 'select_reason' | 'confirm' | 'success'
- targetUser: Profile | null
- reason: TransferReason | null
- note: string
- loading: boolean
- error: string | null
```

**数据流**:
1. 父组件传入 `lead` 和 `onComplete` 回调
2. 弹窗内加载 profiles 列表（排除当前 assigned_to）
3. 用户选择目标 + 原因 + 备注
4. 调用 `transferLead()` RPC
5. 成功 → 关闭弹窗 → 父组件刷新数据
6. 失败 → 显示错误信息

#### 步骤 3：嵌入现有页面

1. **Dashboard** (`dashboard/page.tsx`):  
   - 增强 Transfer Candidates 卡片，点击弹出 TransferCandidatesListModal
  
2. **Leads 列表** (`leads/page.tsx`):  
   - 每张卡片底部操作区增加 "转移" 按钮
   - 批量选中时底部栏增加 "批量转移" 按钮

3. **Lead 详情页** (`leads/[id]/page.tsx`):  
   - Manager Section 增加 "归属销售" 行 + 转移按钮
   - Timeline 增加 transfer 事件显示

4. **Pipeline** (`pipeline/page.tsx`):  
   - 卡片 hover 增加转移按钮

5. **Settings** (`settings/page.tsx`):  
   - 增加 "转移历史" 标签页

#### 步骤 4：通知机制

使用 Supabase Realtime 订阅：

```typescript
// 在 Dashboard/Layout 层订阅
const channel = supabase
  .channel('lead-transfers')
  .on(
    'postgres_changes',
    { 
      event: 'INSERT', 
      schema: 'public', 
      table: 'transfer_history',
      filter: `to_user_id=eq.${userId}`
    },
    (payload) => {
      // 弹出通知 Toast
      showNotification(`您收到了一条新线索: ${payload.new.lead_name}`)
    }
  )
  .subscribe()
```

### 6.6 DB Trigger 替代方案（推荐纯应用层）

虽然可以用 DB Trigger 自动捕获 `assigned_to` 变更，但**推荐在应用层完成**，原因：

1. **更好的错误处理**：注意发生异常时可以回滚前端状态
2. **更清晰的权限检查**：操作人身份在应用层更容易获取
3. **更灵活的通知**：触发通知需要更多上下文

但如果需要保证数据一致性（防止直接 SQL 修改绕过应用层），可以添加一个辅助 Trigger：

```sql
CREATE OR REPLACE FUNCTION log_ownership_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    -- 仅当通过 API 调用时记录（通过 application_name 判断）
    -- 或者不记录（让应用层处理），但记录一个审计痕迹
    INSERT INTO transfer_history (
      lead_id, from_user_id, to_user_id, transferred_by,
      reason, stage_at_transfer, value_at_transfer,
      note
    ) VALUES (
      NEW.id,
      OLD.assigned_to,
      NEW.assigned_to,
      COALESCE(current_setting('app.current_user_id', true)::UUID, auth.uid()),
      COALESCE(current_setting('app.transfer_reason', true), 'manual_override'),
      NEW.stage,
      NEW.quotation_value,
      COALESCE(current_setting('app.transfer_note', true), 'Trigger capture')
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_log_ownership_change
  AFTER UPDATE OF assigned_to ON leads
  FOR EACH ROW
  WHEN (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to)
  EXECUTE FUNCTION log_ownership_change();
```

---

## 7. 实施优先级

### Phase 1 — 核心链路（P0 · 2-3天）

| 任务 | 工作量 | 依赖 |
|------|--------|------|
| ① 创建 `transfer_history` 表 + RLS + 索引 | 0.5天 | 无 |
| ② 创建 `transfer_lead()` RPC 函数（原子化 6 步操作） | 0.5天 | ① |
| ③ 实现 `TransferModal` 组件（选择目标+原因+确认） | 1天 | ② |
| ④ Lead 详情页增加转移入口 | 0.5天 | ③ |
| ⑤ Dashboard Transfer Candidates 卡片增强为可操作 | 0.5天 | ③ |
| ⑥ RLS 即时生效验证（sales 转移后立即看不到） | 0.5天 | ② |

**交付物**: Admin 可以在 Lead 详情页和 Dashboard 完成一条完整的转移链路，原销售立即看不到，新销售立即看到。

### Phase 2 — 批量与列表（P1 · 1-2天）

| 任务 | 工作量 | 依赖 |
|------|--------|------|
| ⑦ Leads 列表每行增加转移按钮 | 0.5天 | ③ |
| ⑧ 批量转移（多选 + 弹窗） | 1天 | ③ |
| ⑨ Pipeline 卡片转移入口 | 0.5天 | ③ |
| ⑩ TransferHistoryPanel 组件（Timeline 展示） | 0.5天 | ① |

**交付物**: 所有上下文均可触发转移（列表/Pipeline/批量），转移历史可见。

### Phase 3 — 通知与报表（P2 · 1-2天）

| 任务 | 工作量 | 依赖 |
|------|--------|------|
| ⑪ 系统内通知（Realtime 订阅 + Toast） | 1天 | ② |
| ⑫ 转移统计报表（Dashboard 新增卡片） | 0.5天 | ① |
| ⑬ Settings 页面增加转移历史标签页 | 0.5天 | ⑩ |
| ⑭ 添加翻译（i18n） | 0.5天 | - |

**交付物**: 完整通知链路，报表可分析转移趋势。

### Phase 4 — 增强（P3 · 未来）

| 任务 | 说明 |
|------|------|
| 销售可发起"转出建议" | 申请+审批流程 |
| 自动均衡分配 | 基于工作量/区域/专业度自动分配 |
| 转移原因分析报表 | 哪些原因占比最高 |
| 转移后目标销售接受确认 | 两步确认流程 |

---

## 8. 集成点清单

### 8.1 需要修改的文件

```
src/app/(dashboard)/dashboard/page.tsx         # 增强 Transfer 卡片
src/app/(dashboard)/leads/page.tsx              # 列表增加转移按钮 + 批量
src/app/(dashboard)/leads/[id]/page.tsx         # 详情页增加转移入口 + 历史
src/app/(dashboard)/pipeline/page.tsx           # 卡片增加转移按钮
src/app/(dashboard)/settings/page.tsx           # 增加转移历史标签页
src/lib/i18n/translations.ts                    # 新增转移相关翻译键
```

### 8.2 需要新建的文件

```
src/components/transfer/TransferModal.tsx
src/components/transfer/TransferModalBatch.tsx
src/components/transfer/TransferHistoryPanel.tsx
src/components/transfer/TransferReasonSelect.tsx
src/components/transfer/TransferSalesSearch.tsx
src/components/transfer/TransferConfirmDialog.tsx
src/hooks/useTransferLead.ts
src/hooks/useTransferHistory.ts
src/hooks/useTransferCandidates.ts
src/lib/transfer-utils.ts
supabase/migrations/20260603000000_add_transfer_history.sql
```

### 8.3 数据库变更

```
🆕 transfer_history 表         — 新建（表+索引+RLS）
🆕 transfer_lead() RPC 函数    — 新建
🔧 leads.assigned_to 索引      — 确认存在
🔧 business_events 使用         — 新增 owner_change 类型事件写入
🔧 activities 使用              — 新增 ownership_transferred 类型
```

### 8.4 现有功能不受影响的部分

```
✅ Lead 创建流程                — 不变
✅ Stage 流转                   — 不变
✅ AI 摘要/标签                 — 不变
✅ Attribution 归因             — 不变
✅ 报价管理                     — 不变
✅ 项目/合同                    — 不变
✅ 语言切换                     — 不变
✅ 现有 /settings 分配          — 可用但建议弃用（改用带原因的新流程）
```

---

## 附录 A: 关键代码片段参考

### A.1 TransferModal 核心结构

```tsx
// TransferModal.tsx (核心组件)
"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { cn } from "@/lib/utils";
import { GripHorizontal, Search, AlertTriangle, Check, X } from "lucide-react";
import { TransferSalesSearch } from "./TransferSalesSearch";
import { TransferReasonSelect } from "./TransferReasonSelect";

interface Profile {
  id: string; full_name: string | null; email: string | null; role: string;
  active_leads?: number;
}

interface Lead {
  id: string; customer_name: string | null; stage: string;
  quotation_value: number | null; assigned_to: string | null;
}

type Step = 'select_target' | 'confirm' | 'success';

interface Props {
  open: boolean;
  onClose: () => void;
  lead: Lead;
  currentOwner?: Profile;  // 当前销售
  onComplete?: () => void; // 成功后回调刷新数据
}

export function TransferModal({ open, onClose, lead, currentOwner, onComplete }: Props) {
  const supabase = createClient();
  const { lang } = useLanguage();
  const [step, setStep] = useState<Step>('select_target');
  const [targetUser, setTargetUser] = useState<Profile | null>(null);
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);

  useEffect(() => {
    if (open) {
      fetchProfiles();
      setStep('select_target');
      setTargetUser(null);
      setReason('');
      setNote('');
      setError(null);
    }
  }, [open]);

  async function fetchProfiles() {
    const { data } = await supabase
      .from('profiles')
      .select('id, full_name, email, role')
      .in('role', ['sales'])
      .neq('id', lead.assigned_to || '');
    if (data) setProfiles(data as Profile[]);
  }

  async function handleTransfer() {
    if (!targetUser || !reason) return;
    setLoading(true);
    setError(null);
    
    const { data, error: rpcError } = await supabase.rpc('transfer_lead', {
      p_lead_id: lead.id,
      p_to_user_id: targetUser.id,
      p_reason: reason,
      p_note: note || null,
    });

    if (rpcError) {
      setError(rpcError.message);
      setLoading(false);
      return;
    }

    setStep('success');
    setLoading(false);
    onComplete?.();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-[480px] bg-gray-900 border-gray-800">
        {/* ... Header, Body, Footer ... */}
      </DialogContent>
    </Dialog>
  );
}
```

### A.2 RPC 函数核心逻辑

```sql
CREATE OR REPLACE FUNCTION transfer_lead(
  p_lead_id UUID,
  p_to_user_id UUID,
  p_reason TEXT,
  p_note TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_from_user_id UUID;
  v_stage TEXT;
  v_value DECIMAL(12,2);
  v_customer_name TEXT;
  v_result JSONB;
BEGIN
  -- 1. 获取当前状态快照
  SELECT assigned_to, stage, quotation_value, customer_name
  INTO v_from_user_id, v_stage, v_value, v_customer_name
  FROM leads WHERE id = p_lead_id;
  
  IF v_from_user_id = p_to_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', '目标销售与当前归属人相同');
  END IF;

  -- 2. 更新 leads
  UPDATE leads SET
    assigned_to = p_to_user_id,
    transfer_candidate = false,
    recovery_candidate = false,
    sales_manager_review = false,
    updated_at = now()
  WHERE id = p_lead_id;

  -- 3. 写入 transfer_history
  INSERT INTO transfer_history (
    lead_id, from_user_id, to_user_id, transferred_by,
    reason, note, stage_at_transfer, value_at_transfer
  ) VALUES (
    p_lead_id, v_from_user_id, p_to_user_id, auth.uid(),
    p_reason, p_note, v_stage, v_value
  );

  -- 4. 写入 business_events
  INSERT INTO business_events (
    lead_id, entity_type, entity_id, event_type, event_data, created_by
  ) VALUES (
    p_lead_id, 'lead', p_lead_id, 'owner_change',
    jsonb_build_object(
      'from', v_from_user_id,
      'to', p_to_user_id,
      'reason', p_reason,
      'note', p_note,
      'stage', v_stage,
      'value', v_value
    ),
    auth.uid()
  );

  -- 5. 写入 activities (Timeline)
  INSERT INTO activities (lead_id, type, content)
  VALUES (
    p_lead_id, 'ownership_transferred',
    '归属转移: ' || COALESCE(v_customer_name, '未知') ||
    ' 从 ' || COALESCE((SELECT full_name FROM profiles WHERE id = v_from_user_id), '未分配') ||
    ' 至 ' || COALESCE((SELECT full_name FROM profiles WHERE id = p_to_user_id), '未知') ||
    ' · 原因: ' || p_reason
  );

  RETURN jsonb_build_object('success', true, 'from', v_from_user_id, 'to', p_to_user_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 附录 B: 风险与注意事项

### 风险清单

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| RPC 函数中 `auth.uid()` 在匿名模式下为 null | 中 | 高 | 使用 `SECURITY DEFINER` + 应用层传递 `transferred_by` |
| 批量转移部分失败 | 低 | 中 | 每条独立执行，失败单条回滚+报错 |
| 通知被用户忽略 | 高 | 低 | 在 Dashboard 增加"未读转移"指示器 |
| 历史数据中 assigned_to 有 TEXT 格式 | 高 | 中 | 迁移前先清理数据类型 |
| Sales 离职后需批量转出所有线索 | 中 | 高 | 提供"销售离职一键转移"功能（Phase 2） |

### 设计取舍

1. **应用层 vs 数据库层**: 推荐 App Layer 调用 RPC（最佳控制力），DB Trigger 做后备安全网
2. **实时通知 vs 轮询**: 使用 Supabase Realtime（已内置），不需要额外基础设施
3. **弹窗 vs 页面跳转**: 采用 Modal 弹窗，不打断用户当前上下文
4. **单原因 vs 多原因**: 当前只允许选一个主要原因（减少复杂度），但备注可以补充
