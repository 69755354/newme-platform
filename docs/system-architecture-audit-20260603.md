# NewMe CRM v2.2 — System Architecture Audit
> **Audit Date:** 2026-06-03
> **Source:** Production database + source code + Supabase Management API
> **Method:** Direct schema query + code inspection, no memory-only assumptions

---

## 1. 系统导航结构 (Navigation Structure)

**Source:** `src/app/(dashboard)/layout.tsx` lines 31-76

```
核心驾驶舱 (Overview)
  ├── /dashboard          驾驶舱 (Dashboard)

销售管理 (Sales)
  ├── /leads              线索管理 (Leads)
  ├── /pipeline           销售管道 (Pipeline)
  ├── /quotes             合同管理 (Contracts)        [badge: soon]
  ├── /quotes             回款管理 (Payments)         [badge: soon]
  └── /quotes             我的工作台 (My Workspace)   [badge: soon]

市场投流 (Marketing)
  └── /ads                投放总览 (Ads Overview)

分析中心 (Analytics)
  └── /dashboard          业绩趋势 (Performance)

系统设置 (Settings)
  └── /settings           团队管理 (Team)
```

### 已实现的实际路由 (src/app/(dashboard)/):
| 路由 | 文件 | 状态 |
|------|------|------|
| `/dashboard` | dashboard/page.tsx | ✅ 已实现 |
| `/leads` | leads/page.tsx | ✅ 已实现 |
| `/leads/[id]` | leads/[id]/page.tsx | ✅ 已实现 |
| `/leads/new` | leads/new/page.tsx | ✅ 已实现 |
| `/pipeline` | pipeline/page.tsx | ✅ 已实现 |
| `/quotes` | quotes/page.tsx | ✅ 已实现 (双用: Quotations列表) |
| `/projects` | projects/page.tsx | ✅ 已实现 (未在侧边栏显示) |
| `/ads` | ads/page.tsx | ✅ 已实现 |
| `/settings` | settings/page.tsx | ✅ 已实现 |
| `/messages` | messages/page.tsx | ✅ 已实现 (未在侧边栏显示) |

### ⚠️ 导航问题
- `/quotes` 被3个菜单项共享（Contracts / Payments / My Workspace），均标 `badge: soon` — 实际页面已实现但作为 Quotations 列表页
- `/projects` 和 `/messages` 路由已实现但未在侧边栏显示
- 5个菜单组的3个（Marketing/Analytics/Settings）只有一个子项，可折叠性低

---

## 2. Leads 数据表结构

**Source:** `information_schema.columns` on Supabase production DB

| # | 字段 | 类型 | Null | 默认值 | 说明 |
|---|------|------|------|--------|------|
| 1 | `id` | uuid | NOT NULL | gen_random_uuid() | 主键 |
| 2 | `source` | text | NOT NULL | | 来源 (meta_ads/whatsapp/website/offline/referral/other) |
| 3 | `meta_click_id` | text | NULL | | Meta Click ID |
| 4 | `meta_campaign` | text | NULL | | Meta Campaign (legacy) |
| 5 | `meta_ad_id` | text | NULL | | Meta Ad ID (legacy) |
| 6 | `quality` | text | NULL | 'pending' | AI质量评级 |
| 7 | `stage_old` | text | NULL | 'new' | (legacy stage field) |
| 8 | `customer_name` | text | NULL | | 客户姓名 |
| 9 | `phone` | text | NULL | | 电话 |
| 10 | `email` | text | NULL | | 邮箱 |
| 11 | `property_type` | text | NULL | | 房型 (villa/apartment/commercial) |
| 12 | `property_size_sqm` | integer | NULL | | 面积 (sqm) |
| 13 | `location` | text | NULL | | 位置 |
| 14 | `budget_range` | text | NULL | | 预算区间 |
| 15 | `service_needs` | ARRAY | NULL | | 服务需求 (数组) |
| 16 | `ai_summary` | text | NULL | | AI 分析摘要 |
| 17 | `ai_tags` | ARRAY | NULL | | AI 标签 |
| 18 | `ai_quality` | text | NULL | | AI 质量评分 |
| 19 | `assigned_to` | uuid | NULL | | 指派给 (旧字段) |
| 20 | `converted_at` | timestamptz | NULL | | 成交时间 |
| 21 | `lost_at` | timestamptz | NULL | | 丢单时间 |
| 22 | `lost_reason` | text | NULL | | 丢单原因 |
| 23 | `created_at` | timestamptz | NULL | now() | 创建时间 |
| 24 | `updated_at` | timestamptz | NULL | now() | 更新时间 |
| **25** | **`stage`** | **text** | **NULL** | **'new'** | **当前阶段 (9-stage pipeline)** |
| 26 | `lead_status` | text | NULL | | 热度: hot/warm/cold/dormant |
| 27 | `win_probability` | integer | NULL | | 赢率 (10/30/50/70/90) |
| 28 | `stage_changed_at` | timestamptz | NULL | | 阶段变更时间 |
| 29 | `decision_maker` | text | NULL | | 决策人 |
| 30 | `decision_date` | date | NULL | | 决策日期 |
| 31 | `competitor` | text | NULL | | 竞争对手 |
| 32 | `last_contact_date` | date | NULL | | 最近联系日期 |
| 33 | `next_followup_date` | date | NULL | | **下次跟进日期** ⚠️ |
| 34 | `followup_count` | integer | NULL | 0 | 跟进次数 |
| 35 | `next_action` | text | NULL | | **下一步行动** ⚠️ |
| 36 | `disqualified_candidate` | boolean | NULL | false | 预筛选淘汰 |
| 37 | `sales_manager_review` | boolean | NULL | false | **需经理审阅** |
| 38 | `recovery_candidate` | boolean | NULL | false | **可挽回线索** |
| 39 | `transfer_candidate` | boolean | NULL | false | **需转交线索** |
| 40 | `hold_since` | date | NULL | | 暂挂起始日期 |
| 41 | `notes` | text | NULL | | 备注 |
| 42 | `google_sheets_row_id` | text | NULL | | Google Sheets 行ID (迁移溯源) |
| 43 | `quotation_value` | numeric | NULL | | 报价金额 (AED) |
| 44 | `expected_close_date` | date | NULL | | 预计关单日 |
| 45 | `confidence_pct` | integer | NULL | 50 | 信心指数 |
| 46 | `forecast_category` | text | NULL | | 预测类别 |
| 47 | `rep_name` | text | NULL | | 销售代表姓名 |
| 48 | `source_platform` | text | NULL | | 来源平台 |
| 49 | `source_channel` | text | NULL | | 来源渠道 |
| **50-67** | `campaign_id` … `last_touch_at` | various | NULL | | **Meta Ads 归因字段 (18个)** |
| 68 | `owner` | text | NULL | | 所有者 (文本) |
| 69 | `assigned_to_uuid` | uuid | NULL | | 指派给 (UUID) |
| 70 | `owner_uuid` | uuid | NULL | | 所有者 (UUID) |
| 71 | `sales_manager` | uuid | NULL | | 销售经理 |
| 72 | `days_since_last_contact` | integer | NULL | 0 | 距上次联系天数 |
| 73-78 | `lost_reason_*` (7个boolean) | boolean | NULL | false | 丢单原因细分标记 |
| 79 | `follow_up_count` | integer | NULL | 0 | (重复字段, 同 #34) |
| 80 | `customer_id` | uuid | NULL | | 关联客户ID |

**总计: 80列**
- 核心业务字段: ~25
- Meta Ads 归因字段: ~18
- 重复/冗余字段: `followup_count`/`follow_up_count`, `assigned_to`/`assigned_to_uuid`, `owner`/`owner_uuid`
- Legacy字段: `stage_old`, `meta_campaign`, `meta_ad_id`
- ⚠️ `next_followup_date` 和 `next_action` 是Dashboard最关键的必填字段

---

## 3. Lead Status / Pipeline 流程

**Source:** Dashboard page.tsx lines 33-43, Leads page.tsx lines 20-29, Pipeline page.tsx lines 41-51

### 9-Stage Pipeline (严格顺序):

```
  1.  New Lead             (#6B7280 gray)
        ↓
  2.  Contacted            (#C48A52 copper)
        ↓
  3.  Requirement Confirmed (#E0B95A gold)
        ↓
  4.  Solution Submitted   (#9B2D5E wine)
        ↓
  5.  Quotation Submitted  (#8B5CF6 purple)
        ↓
  6.  Negotiation          (#3B82F6 blue)
        ↓
  7.  Pending Decision     (#F59E0B amber)
        ↓
  8.  Won                  (#4ADE80 emerald) ← terminal
  9.  Lost                 (#6B7280 gray)    ← terminal
```

### Lead Status (热度分类):
- 🔥 **Hot** — 高意向
- ☀️ **Warm** — 中等
- ❄️ **Cold** — 低热度
- 💤 **Dormant** — 沉睡

### Win Probability (离散预定义值):
`10 / 30 / 50 / 70 / 90` (百分比)

### 状态流转规则:
- 通过 `leads/[id]` 页面手动选择stage
- 自动流转: `createQuote()` → 自动设为 `quotation_submitted`
- Won/Lost 为终端状态，不自动流转回
- 无代码层级的pipeline stage mapping — stage字段直接存储当前阶段

### ⚠️ 缺失
- 无 `pipeline_stage_mapping` 表
- 无 stage transition rules/rules表
- 无 workflow automation (如: contacted 7天无跟进 → 自动flag)

---

## 4. Dashboard KPI 定义

**Source:** Dashboard page.tsx lines 77-222

### KPI Row 1 — 6核心卡片 (kpiCards)
| KPI | 计算来源 | 链接 |
|-----|---------|------|
| Pipeline Size | `active.filter(l => !["won","lost"].includes(l.stage)).length` | /leads |
| Total Pipeline Value | `sum(pipeline.quotation_value)` | /pipeline |
| Won Rate | `wonCount / contactedTotal * 100` | /leads?stage=won |
| Yellow Follow-ups (7-14d) | `pipeline.filter(7d ≤ last_contact < 14d).length` | /leads?alert=yellow |
| Red Follow-ups (14d+) | `pipeline.filter(last_contact ≥ 14d).length` | /leads?alert=red |
| Monthly Revenue | `sum(wonThisMonth.quotation_value)` | /leads?stage=won |

**公式细节:**
- `contactedTotal` = sum of counts in stages: contacted + requirement_confirmed + solution_submitted + quotation_submitted + negotiation + pending_decision + won
- `conversionRate` = won / contactedTotal × 100
- `weightedPipeline` = Σ(quotation_value × win_probability / 100)
- `monthStart` = 当月1日 00:00
- `newThisWeek` = 过去7天创建的线索数
- `contactRate` = (contacted + requirement_confirmed) / totalActive × 100

### KPI Row 2 — 5财务卡片 (financeCards)
| KPI | 计算来源 | ⚠️ |
|-----|---------|-----|
| Contract Value | `sum(wonLeads.quotation_value)` | **模拟数据** — 未联真实contracts表 |
| Received | `contractValue × 50%` | **模拟分配** (首期50%) |
| Outstanding | `contractValue × 50%` | 剩余30%+20% |
| Overdue | `wonLeads(>30d).quotation_value × 30%` | 模拟逾期 |
| Due Next Week | wonLeads(23-30d ago) × 30% | 模拟到期 |

⚠️ **标注 "模拟数据 · 待接入真实合同表"** — 所有财务KPI当前从 `leads.stage='won'` 派生，未使用 `contracts`/`payments` 表

### KPI Row 3 — 3管理卡片 (managerCards)
| KPI | 计算 |
|-----|------|
| Recovery Candidates | `pipeline.filter(recovery_candidate).length` |
| Transfer Candidates | `pipeline.filter(transfer_candidate).length` |
| Manager Review | `pipeline.filter(sales_manager_review).length` + highProbStale + pendingStale |

**补充指标:**
- `highProbStale`: win_probability ≥ 70% 且 last_contact ≥ 14天
- `pendingStale`: stage = "pending_decision" 且 hold_since ≥ 30天

### 7段转化漏斗 (Dashboard底部)
```
New→Contacted | Contacted→Req | Req→Solution | Solution→Quote | Quote→Neg. | Neg.→Decision | Decision→Won
```
每段显示转化率(%)和drop-off率。

---

## 5. Profiles / Users / Roles

**Source:** `information_schema.columns` + `pg_policies`

### profiles 表结构:
| 字段 | 类型 | Null | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | uuid | NOT NULL | | 对应 auth.users.id |
| `role` | text | NULL | 'sales' | 角色 |
| `full_name` | text | NULL | | 姓名 |
| `phone` | text | NULL | | 电话 |
| `avatar_url` | text | NULL | | 头像 |
| `created_at` | timestamptz | NULL | now() | |
| `updated_at` | timestamptz | NULL | now() | |
| `manager_id` | uuid | NULL | | 上级manager |
| `is_active` | boolean | NULL | true | 是否在职 |
| `last_active_at` | timestamptz | NULL | | 最后活跃时间 |
| `joined_at` | timestamptz | NULL | now() | 入职时间 |
| `email` | text | NULL | | 邮箱 (2026-06-03 新增) |

### Roles (硬编码于RLS policies):
- `admin` — 全权限
- `boss` — 全权限 (与admin并列)
- `operator` — 运营 (可读activities/contracts/leads/quotations，不可插入)
- `sales` — 销售 (只能看自己的leads/contracts)
- `finance` — 财务 (只能SELECT contracts)

### 权限控制方式:
**Row-Level Security (RLS)** — 所有public表均通过 `pg_policies` 实现:
- **activities**: 6条policies (admin_all + auth + sales_insert + sales_select + sales_update)
- **business_events**: 2条policies (admin_all + relevant_select)
- **contracts**: 3条policies (admin_all + finance_select + sales_select)
- **customers**: 2条policies (admin_all + auth)
- **leads**: policies控制 (admin/boss/operator全权限, sales仅看自己的)
- **quotations**: admin/boss/operator全权限, sales SELECT仅自己的
- **projects**: admin/boss/operator全权限, sales SELECT仅自己的
- **installment_plans**: admin/boss/operator/finance全权限
- **payments**: admin/boss/operator全权限 + finance SELECT + sales SELECT (仅自己合同)

### ⚠️ 当前用户:
- **admin@newme.ae** (SAM/boss)
- **tanya@newme.ae** (role: admin/sales, UUID: 5c766c35-fda0-4077-a7b0-478b0bbb85b4)

---

## 6. Contracts / Payments / Installments

**All tables exist in production DB** ✅

### contracts (合同表):
| 字段 | 类型 | Null |
|------|------|------|
| `id` | uuid PK | NOT NULL |
| `lead_id` | uuid FK | NOT NULL |
| `quotation_id` | uuid FK | NULL |
| `customer_id` | uuid FK | NULL |
| `sales_id` | uuid FK | NULL |
| `created_by` | uuid | NULL |
| `contract_no` | text | NOT NULL |
| `contract_date` | date | NOT NULL |
| `contract_amount` | numeric | NOT NULL |
| `currency` | text (default AED) | NULL |
| `party_a_name` | text | NOT NULL |
| `party_a_contact` | text | NULL |
| `party_b_name` | text (default 'NewMe Smart Home FZCO') | NOT NULL |
| `party_b_contact` | text | NULL |
| `file_url` | text | NULL |
| `file_metadata` | jsonb | NULL |
| `status` | text (draft/active/completed/terminated) | NOT NULL |
| `approval_status` | text (none/pending/approved/rejected) | NULL |
| `notes` | text | NULL |
| `terminated_reason` | text | NULL |
| `terminated_at` | timestamptz | NULL |
| `created_at` | timestamptz | NULL |
| `updated_at` | timestamptz | NULL |

### payments (回款表):
| 字段 | 类型 | Null |
|------|------|------|
| `id` | uuid PK | NOT NULL |
| `contract_id` | uuid FK | NOT NULL |
| `installment_plan_id` | uuid FK | NULL |
| `created_by` | uuid | NULL |
| `amount` | numeric | NOT NULL |
| `currency` | text (default AED) | NULL |
| `payment_date` | date | NOT NULL |
| `received_at` | timestamptz | NULL |
| `payment_method` | text | NULL |
| `reference_no` | text | NULL |
| `confirmed` | boolean (default false) | NULL |
| `confirmed_by` | uuid | NULL |
| `confirmed_at` | timestamptz | NULL |
| `overpayment_action` | text | NULL |
| `notes` | text | NULL |
| `created_at` | timestamptz | NULL |
| `updated_at` | timestamptz | NULL |

### installment_plans (分期计划表):
| 字段 | 类型 | Null |
|------|------|------|
| `id` | uuid PK | NOT NULL |
| `contract_id` | uuid FK | NOT NULL |
| `seq` | integer | NOT NULL |
| `amount` | numeric | NOT NULL |
| `due_date` | date | NOT NULL |
| `description` | text | NULL |
| `status` | text (pending/paid/overdue) | NOT NULL |
| `paid_amount` | numeric (default 0) | NULL |
| `created_at` | timestamptz | NULL |
| `updated_at` | timestamptz | NULL |

### 实体关系:
```
leads 1──N quotations
leads 1──N contracts
leads 1──1 customers (via customer_id)
contracts N──1 quotations (via quotation_id)
contracts 1──N installment_plans
contracts 1──N payments
payments N──1 installment_plans (via installment_plan_id)
```

### ⚠️ 当前状态:
- 表已创建，RLS已配置
- **但Dashboard部分仍使用模拟数据** (从leads.won派生，未接真实contracts/payments表)
- quotations/contracts/payments 的UI页面通过 `/quotes` 路由共享但尚未完全独立

---

## 7. Lead Detail 页面结构

**Source:** `leads/[id]/page.tsx` (677 lines)

### 页面布局: 左右两栏

**左栏 (lg:col-span-2):**
1. **AI Analysis Card** — AI摘要 + AI标签 (条件显示)
2. **Decision Info Card** — 决策人/竞争对手 (inline编辑)
3. **Follow-up Management Card** — 最近联系/跟进次数/下次跟进(必填)/下一步行动(必填)
4. **Lost Reason Card** — 仅在stage=lost时显示; 多选扣子原因
5. **Attribution Card** — 19个归因字段 (platform/channel/campaign/adset/ad/creative/form/UTM/landing/referrer)
6. **Timeline Card** — 合并activities + business_events，按时间倒序，最多100条; 包含note输入框

**右栏 (lg:col-span-1):**
- **Quick Actions** — Stage选择器 (9个按钮), 创建报价按钮
- **Status + Probability** — 热度选择 + 赢率选择

### 交互模式:
- **Inline编辑**: 点击文字 → 输入框 → Enter保存 / Escape取消
- **Stage变更** → 自动写activity (type: stage_change) + business_event
- **Note添加** → Enter发送 → 同时更新 last_contact_date
- **Quote创建** → 自动推进stage到 quotation_submitted

### ⚠️ 缺失
- 无 Tab 切换 — 所有信息单页展示
- 无 WhatsApp 对话嵌入 (chat_messages表有数据但未嵌入detail页)
- 无 Documents/文件上传区域
- 无 Transfer/Reassign 操作UI

---

## 8. Pipeline 看板结构

**Source:** `pipeline/page.tsx` (313 lines)

### 当前实现: **分析仪表盘** (非拖拽看板)

9个阶段各显示:
- Count (数量)
- Total Value (总报价)
- Avg Probability (平均赢率)
- Weighted Value (加权价值)
- Stale Count (≥7天未联系)
- Hot Count (hot状态)
- Recovery Count (recovery_candidate)
- Transfer Count (transfer_candidate)

### 顶部全局指标:
- Total Pipeline Value
- Weighted Pipeline Value
- Active Pipeline (排除won/lost)
- Active Leads Count
- At-Risk Count (≥14天未联系)

### ⚠️ 关键缺失:
- **不支持拖拽** — 当前为只读分析视图
- Card 内字段: 仅分析级别聚合，无独立lead card
- 无法直接在此页操作lead
- 点击跳转到 `/leads?stage=X` 过滤视图

---

## 9. Activity / Timeline 系统

### activities 表 (活动记录):
| 字段 | 类型 | Null | 说明 |
|------|------|------|------|
| `id` | uuid PK | NOT NULL | |
| `lead_id` | uuid FK | NULL | 关联Lead |
| `customer_id` | uuid FK | NULL | 关联Customer |
| `project_id` | uuid FK | NULL | 关联Project |
| `user_id` | uuid FK | NULL | 操作人 |
| `type` | text | NOT NULL | 事件类型 |
| `content` | text | NULL | 内容 |
| `ai_generated` | boolean | NULL | AI生成标记 |
| `created_at` | timestamptz | NULL | |
| `contract_id` | uuid FK | NULL | 关联Contract |
| `quotation_id` | uuid FK | NULL | 关联Quotation |
| `duration` | integer | NULL | 时长(分钟) |
| `is_completed` | boolean (default true) | NULL | |
| `due_at` | timestamptz | NULL | |
| `priority` | text (default normal) | NULL | |
| `metadata` | jsonb | NULL | |

### business_events 表 (业务事件审计):
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid PK | |
| `lead_id` | uuid FK | |
| `user_id` | uuid FK | |
| `event_type` | text | 事件类型 |
| `event_data` | jsonb | 变更数据 |
| `description` | text | 人类可读描述 |
| `created_at` | timestamptz | |

### 已知 Event Types (从代码中):
- `stage_change` — 阶段变更
- `note_added` — 添加备注
- `quote_sent` / `quotation_sent` — 报价发送
- `followup_scheduled` — 跟进安排
- `lost_reason_set` — 丢单原因设置
- `probability_change` — 赢率变更
- `status_change` — 热度变更

### ⚠️ 当前问题:
- `activities` 和 `business_events` 数据冗余 — 同一操作写两个表
- 缺少 `chat_messages` 到 timeline 的集成
- 无 activity 自动过期/清理机制

---

## 10. Transfer / Audit 机制

### ❌ 不存在以下表:
- `transfer_history` — **不存在**
- `audit_log` — **不存在**
- `notifications` — **不存在**
- `team_members` — **不存在**
- `sales_targets` — **不存在**

### 当前状态:
- Transfer 逻辑仅通过 leads 表的三个flag实现:
  - `transfer_candidate` (boolean) — 标记建议转交
  - `recovery_candidate` (boolean) — 标记可挽回
  - `sales_manager_review` (boolean) — 标记需经理审阅
- 无 transfer 记录表 — 无法追溯谁转移给谁、何时、原因
- `business_events` 表可部分充当审计日志 (通过 event_data JSONB)
- 无 RPC 函数用于 transfer/audit

---

## 附录A: 全表清单 (已实现的10个核心表)

| 表名 | 行数估算 | 用途 |
|------|---------|------|
| `leads` | ~249 | 销售线索 |
| `customers` | ~0 | 客户主数据 |
| `profiles` | ~0 | 用户档案 |
| `quotations` | ~0 | 报价单 |
| `contracts` | ~0 | 合同 |
| `installment_plans` | ~0 | 分期计划 |
| `payments` | ~0 | 回款记录 |
| `projects` | ~0 | 项目 |
| `activities` | ~0 | 活动/跟进记录 |
| `business_events` | ~0 | 业务事件审计 |
| `chat_messages` | ~0 | WhatsApp消息 |
| `quotation_items` | 未查询 | 报价明细行 |

### 未创建的表 (设计文档中标记为postponed):
- `delivery_plans`
- `project_milestones`
- `project_documents`
- `project_inspections`
- `sales_targets`
- `products`

---

## 附录B: 严重性评估

| 项目 | 严重程度 | 说明 |
|------|---------|------|
| Dashboard财务数据全模拟 | 🔴 CRITICAL | contracts/payments表已有但未接入 |
| Transfer无审计记录 | 🟡 HIGH | 只有boolean标记，无历史 |
| Pipeline无拖拽看板 | 🟡 HIGH | 当前是只读分析页 |
| leads表80列冗余 | 🟡 MEDIUM | 3组重复字段，legacy列未清理 |
| 侧边栏路由与实际不匹配 | 🟡 MEDIUM | /quotes被3个菜单共享，/projects未显示 |
| activities/business_events双写 | 🟢 LOW | 冗余但无害 |
| chat_messages未集成到Lead Detail | 🟢 LOW | 有数据但UI未展示 |

---

*Audit generated by direct database + source code inspection. No AI memory was used for any structural assertions.*
