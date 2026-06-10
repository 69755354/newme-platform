# NewMe CRM 数据模型设计文档 v2.0

> **文档状态**: 终稿 v2.0  
> **编写人**: 架构总监（基于 HubSpot CRM 数据模型研究）  
> **更新日期**: 2026-06-03  
> **目标版本**: CRM v2.1（5层数据模型重构）  

---

## 目录

1. [HubSpot CRM 数据模型研究](#1-hubspot-crm-数据模型研究)
2. [NewMe 5层数据模型总览](#2-newme-5层数据模型总览)
3. [实体关系图（ERD）](#3-实体关系图erd)
4. [第1层：Leads（线索）](#4-第1层leads线索)
5. [第2层：Quotations（报价）](#5-第2层quotations报价)
6. [第3层：Contracts（合同）](#6-第3层contracts合同)
7. [第4层：Projects（项目）](#7-第4层projects项目)
8. [第5层：Payments（回款）](#8-第5层payments回款)
9. [运营支撑表](#9-运营支撑表)
10. [完整 DDL（PostgreSQL/Supabase）](#10-完整-ddl)
11. [关键索引策略](#11-关键索引策略)
12. [RLS 策略矩阵](#12-rls-策略矩阵)
13. [迁移策略](#13-迁移策略)
14. [HubSpot vs NewMe 模型映射](#14-hubspot-vs-newme-模型映射)

---

## 1. HubSpot CRM 数据模型研究

### 1.1 HubSpot 核心对象体系

HubSpot CRM 采用**四层数据架构**：

| 层级 | HubSpot 术语 | 等价 RDBMS 术语 | 说明 |
|------|-------------|----------------|------|
| L1 | Objects | Database Tables | 数据顶级容器 |
| L2 | Records | Individual Rows | 对象实例 |
| L3 | Properties | Data Fields | 记录属性 |
| L4 | Associations | Foreign Key Relationships | 对象间关联 |

### 1.2 HubSpot 标准对象

| 对象 | 用途 | NewMe 映射 |
|------|------|-----------|
| **Contacts** | 个人联系人（基本信息、沟通记录） | `customers` + `leads` |
| **Companies** | 公司/组织（B2B 场景） | `profiles`（乙方） |
| **Deals** | 交易/商机（Pipeline 跟踪） | `leads`（增强 stage 管道） |
| **Tickets** | 客户服务工单 | 未来: `service_tickets` |
| **Quotes** | 报价单（含电子签名 + 支付） | **新建: `quotations`** |
| **Line Items** | 产品行项目（Price × Qty） | **新建: `quotation_items`** |
| **Products** | 产品库（SKU、价格、描述） | **新建: `products`** |
| **Activities** | 互动记录（call/email/meeting/note/task） | `activities`（增强） |

### 1.3 HubSpot 关联模型

HubSpot 使用**定向关联标签**（Association Labels）连接对象：

```
Contact ──→ Company          (many-to-one)
Contact ──→ Deal             (many-to-many)
Contact ──→ Ticket           (many-to-one)
Deal    ──→ Company          (many-to-one)
Deal    ──→ Line Items       (one-to-many)
Deal    ──→ Quote            (one-to-one)
Quote   ──→ Line Items       (one-to-many)
Quote   ──→ Contact (signer) (many-to-one)
```

**关联类型 ID**（关键）：
- `20`: Line Item → Deal
- `64`: Quote → Deal
- `67`: Quote → Line Item
- `69`: Quote → Contact (buyer)
- `71`: Quote → Company
- `286`: Quote → Quote Template
- `702`: Quote → Contact (signer)

### 1.4 HubSpot Deal Pipeline（阶段设计）

HubSpot 默认 Deals 管道有 7 个阶段（含概率权重）：

| 阶段 | 概率 | 说明 |
|------|------|------|
| Appointment Scheduled | 20% | 预约会议 |
| Qualified to Buy | 40% | 有购买资格 |
| Presentation Scheduled | 60% | 已安排演示 |
| Decision Maker Bought-In | 80% | 决策者认可 |
| Contract Sent | 90% | 合同已发送 |
| Closed Won | 100% | 成交 |
| Closed Lost | 0% | 输单 |

**阶段计算属性**：HubSpot 自动跟踪每个阶段的 `Date Entered` / `Date Exited` / `Time in Stage` / `Cumulative Time`，用于报表和工作流触发。

### 1.5 HubSpot 报价/产品体系

- **Products**：产品库，含 SKU、名称、描述、价格、层级定价
- **Line Items**：产品实例化（应用于 Deal 或 Quote），含 quantity、price、amount
- **Quotes**：报价头（标题、过期日、模板、签名方式、支付方式）
- **Quote Templates**：渲染模板（CPQ 模板）

报价生命周期：`DRAFT → PENDING_APPROVAL → APPROVED → REJECTED → ACCEPTED`

### 1.6 HubSpot Activities（活动模型）

HubSpot 将以下互动统一归类为 Activities（亦称 Engagements）：

| 活动类型 | 存储内容 |
|---------|---------|
| Call | 通话时长、方向、备注、录音 URL |
| Email | 主题、正文、收件人、附件 |
| Meeting | 会议标题、时间、参与人、纪要 |
| Note | 纯文本备注 |
| Task | 待办事项、到期日、负责人 |
| WhatsApp/LinkedIn/SMS | 消息内容、方向、时间戳 |

每个 Activity 可以关联到任意 CRM 对象（Contact/Company/Deal/Ticket）。

### 1.7 HubSpot 数据模型给 NewMe 的启示

| HubSpot 优势 | NewMe 借鉴 | 落地方案 |
|-------------|-----------|---------|
| 对象模型清晰分层 | 标准化 5 层业务域模型 | Lead→Quotation→Contract→Project→Payment |
| Deal Pipeline + 概率 | 增强 leads.stage + win_probability | 9 阶段管道已实现 |
| 灵活的关联标签 | 统一的关联关系设计 | FK + 关联映射表 |
| Line Item 机制 | quotation_items 行项目 | 支持多产品报价 |
| Activities 统一模型 | activities 表增强 | 增加类型和关联灵活性 |
| Quote 电子签名 | 预留电子签名字段 | contracts + quotations |
| 自动计算属性 | 触发器 + 视图 | update_lead_metrics / v_sales_performance |
| 管道阶段计算 | stage_changed_at 已有 | 扩展时间跟踪 |

---

## 2. NewMe 5层数据模型总览

### 2.1 业务流 vs 数据层映射

```
业务阶段      数据表             状态流转
─────────────────────────────────────────────────────
Marketing   → leads            new → contacted → ...
                ↓
报价阶段     → quotations       draft → sent → approved → rejected
                ↓
签约阶段     → contracts        draft → active → completed → terminated
                ↓
交付阶段     → projects         design → procurement → installation → handover
                ↓
回款阶段     → payments         pending → paid → overdue
```

### 2.2 核心业务规则

1. **Leads 驱动报价**：一个 Lead 可以有多个报价版本（Quotation v1, v2...）
2. **报价驱动合同**：一个报价被接受后生成一个合同
3. **合同驱动回款**：合同是回款的"根"，合同金额 → 分期计划 → 收款记录
4. **合同驱动项目**：合同签约后启动项目交付
5. **合同独立于项目**：允许先交付后签约（灵活业务场景）

### 2.3 数据流关系

```
Lead (1) ──→ Quotation (N) ──→ Contract (1) ──→ Payment (N)
                    │                  │
                    │                  └── Installment (N)
                    │
                    └── [accepted] ──→ Contract
                    
Contract (1) ──→ Project (1) ──→ CAD Files, Inspections, Handover
```

---

## 3. 实体关系图（ERD）

### 3.1 核心 5 层关系

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  ┌─────────┐     ┌──────────────┐     ┌───────────┐                │
│  │  leads  │────→│ quotations   │────→│ contracts │                │
│  │         │1..N │              │1..1 │           │                │
│  └─────────┘     └──────┬───────┘     └─────┬─────┘                │
│                         │                   │                      │
│                         │1..N               │1..N                  │
│                         ▼                   ▼                      │
│                  ┌──────────────┐    ┌──────────────┐              │
│                  │quotation_    │    │ installment_ │              │
│                  │   items      │    │   plans      │              │
│                  └──────────────┘    └──────┬───────┘              │
│                                             │1..N                  │
│                                             ▼                      │
│                                    ┌──────────────┐               │
│                                    │  payments    │               │
│                                    └──────────────┘               │
│                                                                     │
│  ┌──────────┐     ┌──────────────┐                                 │
│  │ contracts│────→│   projects   │                                 │
│  │          │1..1 │              │                                 │
│  └──────────┘     └──────┬───────┘                                 │
│                          │                                         │
│                ┌─────────┴─────────┐                              │
│                ▼                   ▼                               │
│        ┌──────────────┐   ┌──────────────┐                        │
│        │  project_    │   │  project_    │                        │
│        │  milestones  │   │  documents   │                        │
│        └──────────────┘   └──────────────┘                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

运营支撑表:
┌───────────┐  ┌──────────────┐  ┌──────────────┐
│ customers │  │  activities  │  │  profiles    │
└───────────┘  └──────────────┘  └──────────────┘
```

### 3.2 完整实体列表

| # | 表名 | 层级 | 说明 | 状态 |
|---|------|------|------|------|
| 1 | `leads` | L1 - 线索 | 潜在客户，9 阶段管道 | ✅ 已存在（增强） |
| 2 | `products` | L2 - 产品库 | 产品/服务目录，SKU | 🆕 新建 |
| 3 | `quotations` | L2 - 报价 | 报价头信息 | 🆕 新建 |
| 4 | `quotation_items` | L2 - 报价明细 | 报价行项目 | 🆕 新建 |
| 5 | `contracts` | L3 - 合同 | 签约合同 | 🆕 新建（见 PRD） |
| 6 | `installment_plans` | L3 - 分期 | 付款计划 | 🆕 新建（见 PRD） |
| 7 | `delivery_plans` | L3 - 交付 | 交付里程碑 | 🆕 新建（见 PRD） |
| 8 | `projects` | L4 - 项目 | 项目交付管理 | ✅ 已存在（重构） |
| 9 | `project_milestones` | L4 - 项目里程碑 | 项目阶段节点 | 🆕 新建 |
| 10 | `project_documents` | L4 - 项目文档 | CAD/PDF/照片 | 🆕 新建 |
| 11 | `project_inspections` | L4 - 项目验收 | 验收记录 | 🆕 新建 |
| 12 | `payments` | L5 - 回款 | 实收记录 | 🆕 新建（见 PRD） |
| 13 | `customers` | 运营 | 统一客户档案 | ✅ 已存在（增强） |
| 14 | `activities` | 运营 | 互动记录 | ✅ 已存在（增强） |
| 15 | `profiles` | 运营 | 用户/团队 | ✅ 已存在（增强） |
| 16 | `sales_targets` | 运营 | 销售目标 | 🆕 新建（见 PRD） |
| 17 | `business_events` | 运营 | 业务事件日志 | ✅ 已存在（增强） |

---

## 4. 第1层：Leads（线索）

### 4.1 现状

`leads` 表已实现完整 9 阶段管道：

```
new → contacted → requirement_confirmed → solution_submitted →
quotation_submitted → negotiation → pending_decision → won → lost
```

### 4.2 增强字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `assigned_to_uuid` | UUID → profiles | 负责人（UUID 版，替换 TEXT） |
| `quotation_value` | DECIMAL(12,2) | 报价金额 |
| `win_probability` | INTEGER | 赢单概率（0-100） |
| `stage_changed_at` | TIMESTAMPTZ | 阶段变更时间 |
| `last_contact_date` | DATE | 最后联系日 |
| `recovery_candidate` | BOOLEAN | 回收候选标记 |
| `transfer_candidate` | BOOLEAN | 转交候选标记 |

### 4.3 新增触发器

`update_lead_metrics` — 自动计算：
- `days_since_last_contact`
- `follow_up_count` 增量
- `recovery_candidate`（7天未跟进）
- `transfer_candidate`（14天未跟进）
- 报价超时 14/30 天标记
- 高概率长时间停留审查标记

---

## 5. 第2层：Quotations（报价）

### 5.1 设计思路

HubSpot 的 Quote + Line Item 模式：Quote 是"头"，Line Item 是"行"。Deal 可以关联多个 Line Items，Quote 也可以关联 Line Items。

NewMe 的报价场景：
- 营销线索 → AI 自动生成报价（Hermes 报价系统）
- 销售人工调整报价
- 报价通过 WhatsApp/PDF 发送给客户
- 客户接受后 → 生成合同

### 5.2 quotations 表

```sql
CREATE TABLE quotations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id),
  created_by      UUID REFERENCES profiles(id),

  -- 报价编号
  quote_no        TEXT NOT NULL UNIQUE,            -- Q-YYYYMMDD-XXXX

  -- 版本控制
  version         INTEGER DEFAULT 1,
  parent_quote_id UUID REFERENCES quotations(id),  -- 基于某旧版本修改

  -- 核心金额
  subtotal        DECIMAL(12,2) NOT NULL DEFAULT 0, -- 行项目合计
  discount_rate   DECIMAL(5,2) DEFAULT 0,           -- 折扣率 %
  discount_amount DECIMAL(12,2) DEFAULT 0,           -- 折扣金额
  tax_rate        DECIMAL(5,2) DEFAULT 5.0,          -- VAT 税率 (UAE=5%)
  tax_amount      DECIMAL(12,2) DEFAULT 0,           -- 税额
  total_amount    DECIMAL(12,2) NOT NULL,            -- 最终总额
  currency        TEXT DEFAULT 'AED',

  -- 条款
  valid_until     DATE NOT NULL,                    -- 有效期
  payment_terms   TEXT,                             -- 付款条款描述（如"30%首付+70%尾款"）
  delivery_terms  TEXT,                             -- 交付条款
  warranty_period TEXT,                             -- 保修期

  -- 状态
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN (
                      'draft','sent','viewed','negotiating',
                      'accepted','rejected','expired'
                    )),

  -- 文件
  pdf_url         TEXT,                             -- 报价 PDF 文件 URL
  ppt_url         TEXT,                             -- 报价 PPT 演示 URL
  devices_json    JSONB,                            -- 设备清单（从 Hermes 报价系统）

  -- 备注
  notes           TEXT,
  internal_notes  TEXT,                             -- 内部备注

  -- 元数据
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### 5.3 quotation_items 表

```sql
CREATE TABLE quotation_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  quotation_id    UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id),     -- 可选，关联产品库

  -- 行项目信息
  seq             INTEGER NOT NULL,                 -- 序号
  item_type       TEXT NOT NULL DEFAULT 'product'
                    CHECK (item_type IN (
                      'product','service','installation',
                      'discount','surcharge','other'
                    )),
  description     TEXT NOT NULL,                    -- 描述
  sku             TEXT,                             -- SKU（冗余）
  unit            TEXT DEFAULT 'pcs',               -- 单位

  -- 价格
  quantity        DECIMAL(12,2) NOT NULL DEFAULT 1,
  unit_price      DECIMAL(12,2) NOT NULL,
  discount_rate   DECIMAL(5,2) DEFAULT 0,           -- 行折扣率
  tax_rate        DECIMAL(5,2) DEFAULT 5.0,         -- 行税率
  line_total      DECIMAL(12,2) NOT NULL,           -- quantity × unit_price × (1-discount)

  -- 备注
  notes           TEXT,

  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (quotation_id, seq)
);
```

### 5.4 products 表（产品库）

```sql
CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  sku             TEXT NOT NULL UNIQUE,              -- 产品编码
  name            TEXT NOT NULL,                     -- 产品名称
  description     TEXT,                              -- 详细描述
  category        TEXT,                              -- 分类（lighting/curtain/ac/climate/sensor/...）
  brand           TEXT,                              -- 品牌

  unit            TEXT DEFAULT 'pcs',
  unit_price      DECIMAL(12,2) NOT NULL,            -- 标准单价 (AED)
  cost_price      DECIMAL(12,2),                     -- 成本价（用于利润分析）

  -- 技术参数
  specs           JSONB,                             -- {power, voltage, protocol, ...}
  warranty_period TEXT,                              -- 保修期

  -- 图片
  image_url       TEXT,

  -- 状态
  is_active       BOOLEAN DEFAULT true,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

---

## 6. 第3层：Contracts（合同）

### 6.1 设计思路

HubSpot 没有原生的"合同"对象，但 NewMe 的核心业务流程中合同是**回款的锚点**。合同设计参考 PRD v2.0，补充了 quotation 关联和项目关联。

### 6.2 contracts 表（增强版）

```sql
CREATE TABLE contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  quotation_id    UUID REFERENCES quotations(id),          -- 从报价生成
  customer_id     UUID REFERENCES customers(id),           -- 统一客户
  sales_id        UUID REFERENCES profiles(id),            -- 签约销售
  created_by      UUID REFERENCES profiles(id),

  -- 核心字段
  contract_no     TEXT NOT NULL UNIQUE,                    -- CT-YYYYMMDD-XXXX
  contract_date   DATE NOT NULL,                           -- 签约日期
  contract_amount DECIMAL(12,2) NOT NULL CHECK (contract_amount > 0),
  currency        TEXT DEFAULT 'AED',

  -- 双方信息
  party_a_name    TEXT NOT NULL,                           -- 甲方（客户）
  party_a_contact TEXT,                                    -- 甲方联系方式
  party_b_name    TEXT NOT NULL DEFAULT 'NewMe Smart Home FZCO',
  party_b_contact TEXT,                                    -- 乙方联系方式

  -- 电子合同存档
  file_url        TEXT,                                    -- PDF 文件 URL
  file_metadata   JSONB,                                   -- {filename, size, type, uploaded_at}
  extracted_fields JSONB,                                  -- AI 提取字段

  -- 状态
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','completed','terminated')),

  -- 审批预留
  approval_status TEXT DEFAULT 'none'
                    CHECK (approval_status IN ('none','pending','approved','rejected')),
  approved_by     UUID REFERENCES profiles(id),
  approved_at     TIMESTAMPTZ,

  -- 版本
  version         INTEGER DEFAULT 1,

  -- 备注
  notes           TEXT,
  terminated_reason TEXT,
  terminated_at   TIMESTAMPTZ,

  -- 元数据
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### 6.3 合同状态机

```
                    ┌──────────┐
                    │  draft   │
                    └────┬─────┘
                         │ 自动生效（当前跳过审批）
                         ▼
                    ┌──────────┐          ┌──────────────┐
                    │  active  │ ←──────→ │  terminated  │
                    └────┬─────┘          └──────────────┘
                         │ 所有分期已 paid
                         ▼
                    ┌──────────┐
                    │completed │
                    └──────────┘
```

### 6.4 installment_plans 表（PRD 已定义）

```sql
CREATE TABLE installment_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,

  seq             INTEGER NOT NULL,               -- 第几期（1-based）
  amount          DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  due_date        DATE NOT NULL,
  description     TEXT,                           -- "首付款"、"中期款"、"尾款"

  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','overdue','cancelled')),

  paid_amount     DECIMAL(12,2) DEFAULT 0,        -- 已收累计

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (contract_id, seq)
);
```

### 6.5 delivery_plans 表（PRD 已定义）

```sql
CREATE TABLE delivery_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,

  milestone_name  TEXT NOT NULL,
  description     TEXT,
  expected_date   DATE NOT NULL,
  actual_date     DATE,

  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','delayed')),

  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (contract_id, milestone_name)
);
```

### 6.6 合同审计触发器

每次合同状态变更自动记录 business_events：

| 触发事件 | event_type | 说明 |
|---------|-----------|------|
| status = 'draft' → 'active' | `contract_activated` | 合同生效 |
| status = 'active' → 'completed' | `contract_completed` | 合同完成 |
| status = 'active' → 'terminated' | `contract_terminated` | 合同终止 |
| 分期状态变 'paid' | `installment_paid` | 分期已付 |
| 分期状态变 'overdue' | `installment_overdue` | 分期逾期 |
| 交付里程碑变更 | `delivery_milestone` | 交付状态更新 |

---

## 7. 第4层：Projects（项目）

### 7.1 设计思路

HubSpot 有 Projects 对象（含 Pipeline），但 NewMe 的项目管理需要跟踪智能家居交付的完整流程：
- CAD 设计图纸
- 设备采购清单
- 现场安装
- 调试配置
- 客户验收
- 保修服务

### 7.2 projects 表（重构版）

```sql
CREATE TABLE projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  lead_id         UUID REFERENCES leads(id),
  customer_id     UUID REFERENCES customers(id),
  sales_id        UUID REFERENCES profiles(id),            -- 销售负责人
  project_manager UUID REFERENCES profiles(id),            -- 项目经理

  -- 基本信息
  name            TEXT NOT NULL,
  property_type   TEXT,                                    -- villa/apartment/commercial
  property_size   INTEGER,                                 -- 面积 (sqm)
  location        TEXT,
  description     TEXT,

  -- 项目阶段
  phase           TEXT NOT NULL DEFAULT 'design'
                    CHECK (phase IN (
                      'design','procurement','installation',
                      'commissioning','handover','warranty','completed'
                    )),
  priority        TEXT DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),

  -- 时间
  start_date      DATE,
  target_end_date DATE,
  actual_end_date DATE,

  -- 预算
  budget_amount   DECIMAL(12,2),                            -- 预算金额
  cost_amount     DECIMAL(12,2),                            -- 实际成本

  -- 状态
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','on_hold','completed','cancelled')),

  -- 元数据
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### 7.3 project_milestones 表

```sql
CREATE TABLE project_milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,                     -- "CAD 设计确认"
  description     TEXT,
  phase           TEXT NOT NULL,                     -- 所属阶段
  seq             INTEGER NOT NULL,                  -- 排序

  -- 时间
  planned_date    DATE NOT NULL,
  actual_date     DATE,

  -- 状态
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','delayed','skipped')),

  -- 责任人
  assigned_to     UUID REFERENCES profiles(id),
  completed_by    UUID REFERENCES profiles(id),

  -- 备注
  notes           TEXT,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (project_id, name)
);
```

### 7.4 project_documents 表

```sql
CREATE TABLE project_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id    UUID REFERENCES project_milestones(id),

  doc_type        TEXT NOT NULL
                    CHECK (doc_type IN (
                      'cad','pdf','photo','video','quote',
                      'invoice','report','other'
                    )),
  name            TEXT NOT NULL,
  description     TEXT,

  file_url        TEXT NOT NULL,                     -- Supabase Storage URL
  file_size       INTEGER,
  file_type       TEXT,                              -- MIME type
  thumbnail_url   TEXT,                              -- 缩略图

  uploaded_by     UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);
```

### 7.5 project_inspections 表

```sql
CREATE TABLE project_inspections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  inspection_type TEXT NOT NULL
                    CHECK (inspection_type IN (
                      'site_survey','wiring_check','installation_check',
                      'commissioning_test','handover','warranty_visit'
                    )),
  inspection_date DATE NOT NULL,
  inspector       TEXT,                              -- 检查人姓名
  result          TEXT
                    CHECK (result IN ('pass','fail','conditional_pass','pending')),

  -- 检查项
  checklist       JSONB,                             -- [{item, pass, notes}, ...]
  notes           TEXT,
  photos          TEXT[],                             -- 照片 URL 数组

  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
```

### 7.6 HubSpot 项目阶段 vs NewMe 项目阶段

| HubSpot 项目阶段 | NewMe 项目阶段 | 说明 |
|-----------------|---------------|------|
| Planning | design | CAD 设计出图 |
| Execution | procurement | 设备采购 |
| Execution | installation | 现场安装 |
| Execution | commissioning | 系统调试 |
| Review | handover | 验收交付 |
| Completed | warranty | 保修期 |
| On Hold / Cancelled | — | 暂停/取消 |

---

## 8. 第5层：Payments（回款）

### 8.1 设计思路

遵循 HubSpot 的"交易驱动回款"思路。NewMe 中"合同"就是"交易"，回款关联合同的分期计划。

### 8.2 payments 表（PRD 已定义，补充）

```sql
CREATE TABLE payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  contract_id         UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  installment_plan_id UUID REFERENCES installment_plans(id),
  lead_id             UUID REFERENCES leads(id),     -- 保留下钻兼容
  created_by          UUID REFERENCES profiles(id),  -- 登记人

  -- 金额
  amount              DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  currency            TEXT DEFAULT 'AED',

  -- 时间
  payment_date        DATE NOT NULL,
  received_at         TIMESTAMPTZ,                   -- 实际到账时间

  -- 支付方式
  payment_method      TEXT CHECK (payment_method IN
                        ('bank_transfer','cash','cheque','card','other')),
  reference_no        TEXT,                          -- 银行流水号 / 支票号

  -- 确认
  confirmed           BOOLEAN DEFAULT true,          -- 是否已确认到账
  confirmed_by        UUID REFERENCES profiles(id),
  confirmed_at        TIMESTAMPTZ,

  -- 备注
  notes               TEXT,

  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);
```

### 8.3 自动对账逻辑

```
收款登记 (payments 表 INSERT)
       │
       ▼
update_installment_status() 触发器
       │
       ├── 1. 更新 installment_plans.paid_amount = SUM(payments.amount)
       │
       ├── 2. IF paid_amount >= plan_amount
       │       → installment_plans.status = 'paid'
       │
       └── 3. IF 合同所有分期 status IN ('paid','cancelled')
               → contracts.status = 'completed'
```

### 8.4 逾期检测逻辑

```sql
-- 每日计划任务
UPDATE installment_plans
SET status = 'overdue', updated_at = now()
WHERE status = 'pending'
  AND due_date < CURRENT_DATE;
```

---

## 9. 运营支撑表

### 9.1 customers 表（增强）

```sql
-- 现有表增强
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  unified_profile BOOLEAN DEFAULT true;              -- 是否统一客户

ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  tags TEXT[];                                       -- 客户标签

ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  total_contract_amount DECIMAL(12,2) DEFAULT 0;     -- 累计签约额（冗余统计）

ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  last_activity_at TIMESTAMPTZ;                      -- 最近互动时间

ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  assigned_sales_id UUID REFERENCES profiles(id);    -- 专属销售
```

### 9.2 activities 表（增强）

```sql
-- 扩展 activity 类型
ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_type_check;

ALTER TABLE activities
  ADD CONSTRAINT activities_type_check
  CHECK (type IN (
    'call','whatsapp','wechat','email','meeting',
    'sms','note','task','quote_sent','follow_up',
    'stage_change','quality_change','contract_signed',
    'payment_received','site_visit','cad_review'
  ));

-- 增加关联灵活性
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  contract_id UUID REFERENCES contracts(id);

ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  quotation_id UUID REFERENCES quotations(id);

ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  project_id UUID REFERENCES projects(id);

-- 增加活动元数据
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  duration INTEGER;                                  -- 通话/会议时长（分钟）

ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  is_completed BOOLEAN DEFAULT true;                 -- 任务是否完成

ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  due_at TIMESTAMPTZ;                                -- 任务到期时间

ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  metadata JSONB;                                    -- 扩展元数据
```

### 9.3 profiles 表（增强，PRD v2.0）

```sql
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin','sales','designer','operator','finance'));

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  is_active BOOLEAN DEFAULT true;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  last_active_at TIMESTAMPTZ;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  joined_at TIMESTAMPTZ DEFAULT now();

-- operator 和 finance 角色新增（v2.0）
-- admin: 超级管理员
-- sales: 普通销售
-- designer: 设计师
-- operator: 行政（线索调配、合同管理）
-- finance: 财务（收款登记、回款报表）
```

### 9.4 sales_targets 表

```sql
CREATE TABLE sales_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  set_by          UUID NOT NULL REFERENCES profiles(id),

  period_type     TEXT NOT NULL CHECK (period_type IN ('monthly','quarterly')),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,

  target_amount   DECIMAL(12,2) NOT NULL CHECK (target_amount > 0),

  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (user_id, period_type, period_start)
);
```

---

## 10. 完整 DDL

以下是所有新增表和变更的完整 DDL，为一个可执行的迁移文件。

### 10.1 20260603000001_newme_crm_v2_full.sql

```sql
-- ================================================
-- NewMe CRM v2.1 — 完整数据模型迁移
-- 5-Layer: Lead → Quotation → Contract → Project → Payment
-- ================================================

-- ═══════════════ 1. profiles 增强（v2.0 角色精简） ═══════════════
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin','sales','designer','operator','finance'));

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  manager_id UUID REFERENCES profiles(id);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  is_active BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  last_active_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  joined_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_active ON profiles(is_active) WHERE is_active = true;

-- ═══════════════ 2. customers 增强 ═══════════════
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  unified_profile BOOLEAN DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  tags TEXT[];
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  total_contract_amount DECIMAL(12,2) DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  last_activity_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS
  assigned_sales_id UUID REFERENCES profiles(id);

CREATE INDEX IF NOT EXISTS idx_customers_sales ON customers(assigned_sales_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- ═══════════════ 3. activities 增强 ═══════════════
ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_type_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_type_check
  CHECK (type IN (
    'call','whatsapp','wechat','email','meeting',
    'sms','note','task','quote_sent','follow_up',
    'stage_change','quality_change','contract_signed',
    'payment_received','site_visit','cad_review'
  ));

ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  contract_id UUID REFERENCES contracts(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  quotation_id UUID REFERENCES quotations(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  project_id UUID REFERENCES projects(id);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  duration INTEGER;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  is_completed BOOLEAN DEFAULT true;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  due_at TIMESTAMPTZ;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS
  metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_activities_contract ON activities(contract_id);
CREATE INDEX IF NOT EXISTS idx_activities_quotation ON activities(quotation_id);
CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id);
CREATE INDEX IF NOT EXISTS idx_activities_type ON activities(type);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(user_id);
CREATE INDEX IF NOT EXISTS idx_activities_due ON activities(due_at) WHERE is_completed = false;

-- ═══════════════ 4. products 表（新建） ═══════════════
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT,
  brand           TEXT,
  unit            TEXT DEFAULT 'pcs',
  unit_price      DECIMAL(12,2) NOT NULL,
  cost_price      DECIMAL(12,2),
  specs           JSONB,
  warranty_period TEXT,
  image_url       TEXT,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active) WHERE is_active = true;

-- ═══════════════ 5. quotations 表（新建） ═══════════════
CREATE TABLE IF NOT EXISTS quotations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id),
  created_by      UUID REFERENCES profiles(id),
  quote_no        TEXT NOT NULL UNIQUE,
  version         INTEGER DEFAULT 1,
  parent_quote_id UUID REFERENCES quotations(id),
  subtotal        DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_rate   DECIMAL(5,2) DEFAULT 0,
  discount_amount DECIMAL(12,2) DEFAULT 0,
  tax_rate        DECIMAL(5,2) DEFAULT 5.0,
  tax_amount      DECIMAL(12,2) DEFAULT 0,
  total_amount    DECIMAL(12,2) NOT NULL,
  currency        TEXT DEFAULT 'AED',
  valid_until     DATE NOT NULL,
  payment_terms   TEXT,
  delivery_terms  TEXT,
  warranty_period TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','viewed','negotiating','accepted','rejected','expired')),
  pdf_url         TEXT,
  ppt_url         TEXT,
  devices_json    JSONB,
  notes           TEXT,
  internal_notes  TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotations_lead ON quotations(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotations_creator ON quotations(created_by);
CREATE INDEX IF NOT EXISTS idx_quotations_status ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotations_no ON quotations(quote_no);
CREATE INDEX IF NOT EXISTS idx_quotations_valid ON quotations(valid_until) WHERE status IN ('draft','sent','viewed','negotiating');
CREATE INDEX IF NOT EXISTS idx_quotations_parent ON quotations(parent_quote_id);

-- ═══════════════ 6. quotation_items 表（新建） ═══════════════
CREATE TABLE IF NOT EXISTS quotation_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id    UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES products(id),
  seq             INTEGER NOT NULL,
  item_type       TEXT NOT NULL DEFAULT 'product'
                    CHECK (item_type IN ('product','service','installation','discount','surcharge','other')),
  description     TEXT NOT NULL,
  sku             TEXT,
  unit            TEXT DEFAULT 'pcs',
  quantity        DECIMAL(12,2) NOT NULL DEFAULT 1,
  unit_price      DECIMAL(12,2) NOT NULL,
  discount_rate   DECIMAL(5,2) DEFAULT 0,
  tax_rate        DECIMAL(5,2) DEFAULT 5.0,
  line_total      DECIMAL(12,2) NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (quotation_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_quotation_items_quote ON quotation_items(quotation_id);
CREATE INDEX IF NOT EXISTS idx_quotation_items_product ON quotation_items(product_id);

-- ═══════════════ 7. contracts 表（新建，PRD v2.0） ═══════════════
CREATE TABLE IF NOT EXISTS contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  quotation_id    UUID REFERENCES quotations(id),
  customer_id     UUID REFERENCES customers(id),
  sales_id        UUID REFERENCES profiles(id),
  created_by      UUID REFERENCES profiles(id),
  contract_no     TEXT NOT NULL UNIQUE,
  contract_date   DATE NOT NULL,
  contract_amount DECIMAL(12,2) NOT NULL CHECK (contract_amount > 0),
  currency        TEXT DEFAULT 'AED',
  party_a_name    TEXT NOT NULL,
  party_a_contact TEXT,
  party_b_name    TEXT NOT NULL DEFAULT 'NewMe Smart Home FZCO',
  party_b_contact TEXT,
  file_url        TEXT,
  file_metadata   JSONB,
  extracted_fields JSONB,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','completed','terminated')),
  approval_status TEXT DEFAULT 'none'
                    CHECK (approval_status IN ('none','pending','approved','rejected')),
  approved_by     UUID REFERENCES profiles(id),
  approved_at     TIMESTAMPTZ,
  version         INTEGER DEFAULT 1,
  notes           TEXT,
  terminated_reason TEXT,
  terminated_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_lead ON contracts(lead_id);
CREATE INDEX IF NOT EXISTS idx_contracts_quotation ON contracts(quotation_id);
CREATE INDEX IF NOT EXISTS idx_contracts_customer ON contracts(customer_id);
CREATE INDEX IF NOT EXISTS idx_contracts_sales ON contracts(sales_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_date ON contracts(contract_date);
CREATE INDEX IF NOT EXISTS idx_contracts_no ON contracts(contract_no);

-- ═══════════════ 8. installment_plans 表（新建，PRD v2.0） ═══════════════
CREATE TABLE IF NOT EXISTS installment_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  amount          DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  due_date        DATE NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','overdue','cancelled')),
  paid_amount     DECIMAL(12,2) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (contract_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_installment_contract ON installment_plans(contract_id);
CREATE INDEX IF NOT EXISTS idx_installment_status ON installment_plans(status);
CREATE INDEX IF NOT EXISTS idx_installment_due ON installment_plans(due_date) WHERE status = 'pending';

-- ═══════════════ 9. delivery_plans 表（新建，PRD v2.0） ═══════════════
CREATE TABLE IF NOT EXISTS delivery_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  milestone_name  TEXT NOT NULL,
  description     TEXT,
  expected_date   DATE NOT NULL,
  actual_date     DATE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','delayed')),
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (contract_id, milestone_name)
);

CREATE INDEX IF NOT EXISTS idx_delivery_contract ON delivery_plans(contract_id);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_plans(status);
CREATE INDEX IF NOT EXISTS idx_delivery_delayed ON delivery_plans(expected_date, status)
  WHERE status IN ('pending','delayed');

-- ═══════════════ 10. payments 表（新建，PRD v2.0 合同联动版） ═══════════════
CREATE TABLE IF NOT EXISTS payments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  installment_plan_id UUID REFERENCES installment_plans(id),
  lead_id             UUID REFERENCES leads(id),
  created_by          UUID REFERENCES profiles(id),
  amount              DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  currency            TEXT DEFAULT 'AED',
  payment_date        DATE NOT NULL,
  received_at         TIMESTAMPTZ,
  payment_method      TEXT CHECK (payment_method IN ('bank_transfer','cash','cheque','card','other')),
  reference_no        TEXT,
  confirmed           BOOLEAN DEFAULT true,
  confirmed_by        UUID REFERENCES profiles(id),
  confirmed_at        TIMESTAMPTZ,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_contract ON payments(contract_id);
CREATE INDEX IF NOT EXISTS idx_payments_installment ON payments(installment_plan_id);
CREATE INDEX IF NOT EXISTS idx_payments_lead ON payments(lead_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_payments_method ON payments(payment_method);
CREATE INDEX IF NOT EXISTS idx_payments_confirmed ON payments(confirmed) WHERE confirmed = true;

-- ═══════════════ 11. projects 表（重构） ═══════════════
-- 保留旧表，添加新字段
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  contract_id UUID REFERENCES contracts(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  lead_id UUID REFERENCES leads(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  customer_id UUID REFERENCES customers(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  sales_id UUID REFERENCES profiles(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  project_manager UUID REFERENCES profiles(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  priority TEXT DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  start_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  target_end_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  actual_end_date DATE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  budget_amount DECIMAL(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  cost_amount DECIMAL(12,2);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS
  created_by UUID REFERENCES profiles(id);

-- 扩展 phase 枚举
ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_phase_check;
ALTER TABLE projects
  ADD CONSTRAINT projects_phase_check
  CHECK (phase IN ('design','procurement','installation','commissioning','handover','warranty','completed'));

CREATE INDEX IF NOT EXISTS idx_projects_contract ON projects(contract_id);
CREATE INDEX IF NOT EXISTS idx_projects_manager ON projects(project_manager);
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_sales ON projects(sales_id);

-- ═══════════════ 12. project_milestones 表（新建） ═══════════════
CREATE TABLE IF NOT EXISTS project_milestones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  phase           TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  planned_date    DATE NOT NULL,
  actual_date     DATE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','delayed','skipped')),
  assigned_to     UUID REFERENCES profiles(id),
  completed_by    UUID REFERENCES profiles(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_project_milestones_status ON project_milestones(status);
CREATE INDEX IF NOT EXISTS idx_project_milestones_phase ON project_milestones(phase);

-- ═══════════════ 13. project_documents 表（新建） ═══════════════
CREATE TABLE IF NOT EXISTS project_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id    UUID REFERENCES project_milestones(id),
  doc_type        TEXT NOT NULL
                    CHECK (doc_type IN ('cad','pdf','photo','video','quote','invoice','report','other')),
  name            TEXT NOT NULL,
  description     TEXT,
  file_url        TEXT NOT NULL,
  file_size       INTEGER,
  file_type       TEXT,
  thumbnail_url   TEXT,
  uploaded_by     UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_docs_project ON project_documents(project_id);
CREATE INDEX IF NOT EXISTS idx_project_docs_type ON project_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_project_docs_milestone ON project_documents(milestone_id);

-- ═══════════════ 14. project_inspections 表（新建） ═══════════════
CREATE TABLE IF NOT EXISTS project_inspections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  inspection_type TEXT NOT NULL
                    CHECK (inspection_type IN (
                      'site_survey','wiring_check','installation_check',
                      'commissioning_test','handover','warranty_visit'
                    )),
  inspection_date DATE NOT NULL,
  inspector       TEXT,
  result          TEXT CHECK (result IN ('pass','fail','conditional_pass','pending')),
  checklist       JSONB,
  notes           TEXT,
  photos          TEXT[],
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_inspections_project ON project_inspections(project_id);
CREATE INDEX IF NOT EXISTS idx_project_inspections_type ON project_inspections(inspection_type);

-- ═══════════════ 15. sales_targets 表（新建，PRD v2.0） ═══════════════
CREATE TABLE IF NOT EXISTS sales_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  set_by          UUID NOT NULL REFERENCES profiles(id),
  period_type     TEXT NOT NULL CHECK (period_type IN ('monthly','quarterly')),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  target_amount   DECIMAL(12,2) NOT NULL CHECK (target_amount > 0),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_targets_user ON sales_targets(user_id);
CREATE INDEX IF NOT EXISTS idx_targets_period ON sales_targets(period_start, period_end);

-- ═══════════════ 16. 业务事件类型扩展 ═══════════════
ALTER TABLE business_events
  DROP CONSTRAINT IF EXISTS chk_event_type;
ALTER TABLE business_events
  ADD CONSTRAINT chk_event_type
  CHECK (event_type IN (
    'stage_change', 'status_change', 'probability_change', 'owner_change',
    'assignment_change', 'transfer',
    'contact_made', 'contact_scheduled', 'quotation_sent', 'quotation_approved',
    'quotation_rejected', 'won', 'lost', 'recovery_candidate', 'transfer_candidate',
    'sales_manager_review', 'hold', 'unhold', 'competitor_added', 'decision_made',
    'payment_recorded', 'payment_overdue',
    'target_set',
    'contract_created', 'contract_activated', 'contract_completed', 'contract_terminated',
    'installment_paid', 'installment_overdue',
    'delivery_milestone',
    'quotation_created', 'quotation_updated', 'quotation_accepted',
    'project_phase_change', 'project_status_change',
    'inspection_completed', 'document_uploaded'
  ));

-- ═══════════════ 17. 核心触发器 ═══════════════

-- 17.1 收款后自动更新分期状态
CREATE OR REPLACE FUNCTION update_installment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_amount DECIMAL(12,2);
  v_contract_id UUID;
BEGIN
  -- 获取分期计划信息
  SELECT ip.amount, ip.contract_id INTO v_plan_amount, v_contract_id
  FROM installment_plans ip
  WHERE ip.id = NEW.installment_plan_id;

  -- 更新分期累计收款金额
  UPDATE installment_plans
  SET paid_amount = (
    SELECT COALESCE(SUM(amount), 0)
    FROM payments
    WHERE installment_plan_id = NEW.installment_plan_id
      AND confirmed = true
  )
  WHERE id = NEW.installment_plan_id;

  -- 如果累计收款 >= 计划金额，标记为 paid
  UPDATE installment_plans
  SET status = 'paid', updated_at = now()
  WHERE id = NEW.installment_plan_id
    AND status = 'pending'
    AND paid_amount >= v_plan_amount;

  -- 检查合同是否全部分期已 paid
  IF NOT EXISTS (
    SELECT 1 FROM installment_plans
    WHERE contract_id = v_contract_id
      AND status NOT IN ('paid', 'cancelled')
  ) THEN
    UPDATE contracts
    SET status = 'completed', updated_at = now()
    WHERE id = v_contract_id
      AND status = 'active';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_after_insert ON payments;
CREATE TRIGGER trg_payment_after_insert
  AFTER INSERT ON payments
  FOR EACH ROW
  WHEN (NEW.confirmed = true AND NEW.installment_plan_id IS NOT NULL)
  EXECUTE FUNCTION update_installment_status();

-- 17.2 合同状态变更记录事件
CREATE OR REPLACE FUNCTION log_contract_event()
RETURNS TRIGGER AS $$
DECLARE
  v_event_type TEXT;
  v_description TEXT;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_event_type := CASE NEW.status
      WHEN 'active' THEN 'contract_activated'
      WHEN 'completed' THEN 'contract_completed'
      WHEN 'terminated' THEN 'contract_terminated'
      ELSE 'status_change'
    END;
    v_description := '合同 ' || NEW.contract_no || ' 状态变更: ' || COALESCE(OLD.status, '') || ' → ' || NEW.status;

    INSERT INTO business_events (lead_id, event_type, description, metadata, created_by)
    VALUES (NEW.lead_id, v_event_type, v_description,
      jsonb_build_object('contract_id', NEW.id, 'old_status', OLD.status, 'new_status', NEW.status),
      auth.uid());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_contract_status_change ON contracts;
CREATE TRIGGER trg_contract_status_change
  AFTER UPDATE OF status ON contracts
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION log_contract_event();

-- 17.3 分期逾期自动检测（交付计划延期）
CREATE OR REPLACE FUNCTION auto_detect_overdue()
RETURNS void AS $$
BEGIN
  -- 标记逾期分期
  UPDATE installment_plans
  SET status = 'overdue', updated_at = now()
  WHERE status = 'pending'
    AND due_date < CURRENT_DATE;

  -- 标记交付延期
  UPDATE delivery_plans
  SET status = 'delayed', updated_at = now()
  WHERE status IN ('pending', 'in_progress')
    AND expected_date < CURRENT_DATE - INTERVAL '3 days';
END;
$$ LANGUAGE plpgsql;

-- ═══════════════ 18. 核心视图 ═══════════════

-- 18.1 销售业绩视图（含合同+回款统计）
CREATE OR REPLACE VIEW v_sales_performance AS
WITH sales_contracts AS (
  SELECT
    c.sales_id,
    COUNT(c.id) AS contract_count,
    COALESCE(SUM(c.contract_amount), 0) AS total_contract_amount,
    COALESCE(SUM(c.contract_amount) FILTER (
      WHERE DATE_TRUNC('month', c.contract_date) = DATE_TRUNC('month', CURRENT_DATE)
    ), 0) AS monthly_contract_amount
  FROM contracts c
  WHERE c.status IN ('active', 'completed')
  GROUP BY c.sales_id
),
sales_payments AS (
  SELECT
    c.sales_id,
    COUNT(p.id) AS payment_count,
    COALESCE(SUM(p.amount), 0) AS total_paid_amount,
    COALESCE(SUM(p.amount) FILTER (
      WHERE DATE_TRUNC('month', p.payment_date) = DATE_TRUNC('month', CURRENT_DATE)
    ), 0) AS monthly_paid_amount
  FROM payments p
  JOIN contracts c ON c.id = p.contract_id
  WHERE p.confirmed = true
  GROUP BY c.sales_id
),
sales_overdue AS (
  SELECT
    c.sales_id,
    COUNT(ip.id) AS overdue_count,
    COALESCE(SUM(ip.amount), 0) AS overdue_amount
  FROM installment_plans ip
  JOIN contracts c ON c.id = ip.contract_id
  WHERE ip.status = 'overdue'
  GROUP BY c.sales_id
)
SELECT
  p.id AS user_id,
  p.full_name,
  p.role,
  p.is_active,
  COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost') AND COALESCE(l.disqualified_candidate, false) = false) AS active_leads,
  COALESCE(SUM(l.quotation_value) FILTER (WHERE l.stage NOT IN ('won','lost') AND COALESCE(l.disqualified_candidate, false) = false), 0) AS pipeline_value,
  COALESCE(sc.contract_count, 0) AS contract_count,
  COALESCE(sc.total_contract_amount, 0) AS total_contract_amount,
  COALESCE(sc.monthly_contract_amount, 0) AS monthly_contract_amount,
  COALESCE(sp.total_paid_amount, 0) AS total_paid_amount,
  COALESCE(sp.monthly_paid_amount, 0) AS monthly_paid_amount,
  CASE
    WHEN COALESCE(sc.total_contract_amount, 0) > 0
    THEN ROUND(COALESCE(sp.total_paid_amount, 0) / sc.total_contract_amount * 100, 1)
    ELSE 0
  END AS payment_rate,
  COALESCE(so.overdue_count, 0) AS overdue_count,
  COALESCE(so.overdue_amount, 0) AS overdue_amount,
  CASE
    WHEN COALESCE(sc.total_contract_amount, 0) > 0
      AND COALESCE(sp.total_paid_amount, 0) / sc.total_contract_amount >= 0.6
    THEN true
    ELSE false
  END AS is_on_target
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
LEFT JOIN sales_contracts sc ON sc.sales_id = p.id
LEFT JOIN sales_payments sp ON sp.sales_id = p.id
LEFT JOIN sales_overdue so ON so.sales_id = p.id
WHERE p.role IN ('sales')
GROUP BY p.id, p.full_name, p.role, p.is_active,
         sc.contract_count, sc.total_contract_amount, sc.monthly_contract_amount,
         sp.total_paid_amount, sp.monthly_paid_amount,
         so.overdue_count, so.overdue_amount;

COMMENT ON VIEW v_sales_performance IS '销售业绩汇总视图（v2.0）：含管道、合同、回款、逾期、达标标记';

-- 18.2 合同回款总览视图
CREATE OR REPLACE VIEW v_contract_payment_overview AS
SELECT
  c.id AS contract_id,
  c.contract_no,
  c.contract_date,
  c.contract_amount,
  c.status AS contract_status,
  c.sales_id,
  p.full_name AS sales_name,
  c.party_a_name AS customer_name,
  COALESCE(SUM(pay.amount) FILTER (WHERE pay.confirmed = true), 0) AS total_paid,
  c.contract_amount - COALESCE(SUM(pay.amount) FILTER (WHERE pay.confirmed = true), 0) AS total_unpaid,
  COUNT(ip.id) AS total_installments,
  COUNT(ip.id) FILTER (WHERE ip.status = 'paid') AS paid_installments,
  COUNT(ip.id) FILTER (WHERE ip.status = 'overdue') AS overdue_installments,
  CASE
    WHEN c.contract_amount > 0
    THEN ROUND(COALESCE(SUM(pay.amount) FILTER (WHERE pay.confirmed = true), 0) / c.contract_amount * 100, 1)
    ELSE 0
  END AS payment_rate
FROM contracts c
LEFT JOIN profiles p ON p.id = c.sales_id
LEFT JOIN installment_plans ip ON ip.contract_id = c.id
LEFT JOIN payments pay ON pay.contract_id = c.id
GROUP BY c.id, c.contract_no, c.contract_date, c.contract_amount, c.status, c.sales_id, p.full_name, c.party_a_name;

COMMENT ON VIEW v_contract_payment_overview IS '合同回款总览视图：每份合同的已收/未收/逾期汇总';

-- ═══════════════ 19. RLS 策略 ═══════════════

-- 19.1 products RLS
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "products_all_authenticated" ON products FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()));
CREATE POLICY "products_all_read_anon" ON products FOR SELECT
  TO public
  USING (true);

-- 19.2 quotations RLS
ALTER TABLE quotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quotations_admin_operator_all" ON quotations FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "quotations_sales_see" ON quotations FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM leads l WHERE l.id = quotations.lead_id AND l.assigned_to = auth.uid()
  ));

-- 19.3 quotation_items RLS
ALTER TABLE quotation_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quotation_items_admin_operator_all" ON quotation_items FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "quotation_items_sales_see" ON quotation_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM quotations q
    JOIN leads l ON l.id = q.lead_id
    WHERE q.id = quotation_items.quotation_id AND l.assigned_to = auth.uid()
  ));

-- 19.4 contracts RLS
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contracts_admin_operator_all" ON contracts FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "contracts_sales_see" ON contracts FOR SELECT
  USING (sales_id = auth.uid());

CREATE POLICY "contracts_finance_see" ON contracts FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- 19.5 installment_plans RLS
ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "installment_admin_operator_finance_all" ON installment_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator','finance')));

CREATE POLICY "installment_sales_see" ON installment_plans FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM contracts c WHERE c.id = installment_plans.contract_id AND c.sales_id = auth.uid()
  ));

-- 19.6 delivery_plans RLS
ALTER TABLE delivery_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delivery_admin_operator_all" ON delivery_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "delivery_sales_see" ON delivery_plans FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM contracts c WHERE c.id = delivery_plans.contract_id AND c.sales_id = auth.uid()
  ));

CREATE POLICY "delivery_finance_see" ON delivery_plans FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

-- 19.7 payments RLS
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_admin_operator_finance_all" ON payments FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator','finance')));

CREATE POLICY "payments_sales_see" ON payments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM contracts c WHERE c.id = payments.contract_id AND c.sales_id = auth.uid()
  ));

-- 19.8 projects RLS（增强）
CREATE POLICY "projects_admin_operator_all" ON projects FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "projects_sales_see" ON projects FOR SELECT
  USING (assigned_to = auth.uid() OR sales_id = auth.uid() OR project_manager = auth.uid());

-- 19.9 project_milestones RLS
ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_milestones_admin_operator_all" ON project_milestones FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "project_milestones_sales_see" ON project_milestones FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_milestones.project_id
      AND (p.assigned_to = auth.uid() OR p.sales_id = auth.uid() OR p.project_manager = auth.uid())
  ));

-- 19.10 project_documents RLS
ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_docs_admin_operator_all" ON project_documents FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "project_docs_sales_see" ON project_documents FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_documents.project_id
      AND (p.assigned_to = auth.uid() OR p.sales_id = auth.uid() OR p.project_manager = auth.uid())
  ));

-- 19.11 project_inspections RLS
ALTER TABLE project_inspections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_inspections_admin_operator_all" ON project_inspections FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "project_inspections_sales_see" ON project_inspections FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = project_inspections.project_id
      AND (p.assigned_to = auth.uid() OR p.sales_id = auth.uid() OR p.project_manager = auth.uid())
  ));

-- 19.12 sales_targets RLS
ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "targets_admin_all" ON sales_targets FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "targets_self_see" ON sales_targets FOR SELECT
  USING (user_id = auth.uid());

-- ═══════════════ 20. Schema 刷新 ═══════════════
NOTIFY pgrst, 'reload schema';
```

---

## 11. 关键索引策略

### 11.1 查询模式驱动的索引

| 查询模式 | 涉及表 | 索引策略 | 说明 |
|---------|--------|---------|------|
| 销售看自己的管道 | leads | `(assigned_to, stage)` | 复合索引加速角色过滤 |
| 合同列表 + 过滤 | contracts | `(sales_id, status, contract_date DESC)` | 常用列表查询 |
| 付款计划到期检查 | installment_plans | `(due_date) WHERE status='pending'` | 部分索引加速逾期检测 |
| 回款汇总统计 | payments | `(contract_id, confirmed, amount)` | 覆盖索引避免回表 |
| Dashboard 逾期清单 | installment_plans | `(status, due_date DESC)` | 逾期排序 |
| 报价查找 | quotations | `(lead_id, status)` | 按线索和状态查询 |
| 活动时间线 | activities | `(lead_id, created_at DESC)` | 时间线展示 |
| 项目文档查找 | project_documents | `(project_id, doc_type)` | 按项目和类型 |

### 11.2 推荐索引总结

```sql
-- leads 增强索引
CREATE INDEX IF NOT EXISTS idx_leads_assigned_stage ON leads(assigned_to, stage);
CREATE INDEX IF NOT EXISTS idx_leads_stage_created ON leads(stage, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_created_date ON leads(created_at::date);

-- contracts 索引
CREATE INDEX IF NOT EXISTS idx_contracts_sales_status ON contracts(sales_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_date_desc ON contracts(contract_date DESC);

-- payments 覆盖索引
CREATE INDEX IF NOT EXISTS idx_payments_contract_amount ON payments(contract_id, confirmed) INCLUDE (amount);

-- installment_plans 逾期检查
CREATE INDEX IF NOT EXISTS idx_installment_due_pending ON installment_plans(due_date) WHERE status = 'pending';

-- activities 时间线
CREATE INDEX IF NOT EXISTS idx_activities_lead_created ON activities(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_lead_type ON activities(lead_id, type);
```

---

## 12. RLS 策略矩阵

| 表 | admin | operator | sales | finance | public (anon) |
|----|-------|----------|-------|---------|--------------|
| leads | 全部 | 全部 | 仅自己分配 | ❌ | 仅 INSERT（表单） |
| customers | 全部 | 全部 | 仅关联自己的 | ❌ | ❌ |
| products | 全部 | 全部 | 全部 | 全部 | 仅 SELECT |
| quotations | 全部 | 全部 | 仅关联自己的 | ❌ | ❌ |
| quotation_items | 全部 | 全部 | 仅关联自己的 | ❌ | ❌ |
| contracts | 全部 | 全部 | 仅自己签约 | 全部 SELECT | ❌ |
| installment_plans | 全部 | 全部 | 仅合同关联 | 全部 | ❌ |
| delivery_plans | 全部 | 全部 | 仅合同关联 | 仅 SELECT | ❌ |
| payments | 全部 | 全部 | 仅合同关联 | 全部 | ❌ |
| projects | 全部 | 全部 | 已分配/销售/经理 | ❌ | ❌ |
| project_milestones | 全部 | 全部 | 仅项目关联 | ❌ | ❌ |
| project_documents | 全部 | 全部 | 仅项目关联 | ❌ | ❌ |
| project_inspections | 全部 | 全部 | 仅项目关联 | ❌ | ❌ |
| sales_targets | 全部 | ❌ | 仅自己 | ❌ | ❌ |
| activities | 全部 | 全部 | 仅关联自己的 | ❌ | ❌ |
| profiles | 全部 SELECT | 全部 SELECT | 仅自己 | 全部 SELECT | ❌ |
| business_events | 全部 | 全部 | 仅关联自己的 | ❌ | ❌ |

---

## 13. 迁移策略

### 13.1 阶段 1：数据模型上线（当前 Sprint）

```
1. 执行完整 DDL（上述迁移文件）
2. 建立 products 产品库（导入现有设备数据）
3. 保留现有 leads / projects / quotes 表
4. 新表 contracts / payments / installment_plans 从零开始
```

### 13.2 阶段 2：数据迁移与清理

```sql
-- 从已有的 quotes 表迁移数据到 quotations
INSERT INTO quotations (lead_id, quote_no, total_amount, valid_until, status, devices_json, created_at)
SELECT
  lead_id,
  'Q-' || TO_CHAR(created_at, 'YYYYMMDD') || '-' || LPAD(ROW_NUMBER() OVER (ORDER BY created_at)::TEXT, 4, '0'),
  total_amount,
  created_at::DATE + INTERVAL '30 days',
  CASE WHEN status = 'approved' THEN 'accepted' WHEN status = 'sent' THEN 'sent' ELSE 'draft' END,
  devices_json,
  created_at
FROM quotes;

-- 从 projects 表迁移合同数据到 contracts
INSERT INTO contracts (lead_id, contract_no, contract_amount, contract_date, status, party_a_name, created_at)
SELECT
  l.id,
  'CT-' || TO_CHAR(p.created_at, 'YYYYMMDD') || '-' || LPAD(ROW_NUMBER() OVER (ORDER BY p.created_at)::TEXT, 4, '0'),
  p.contract_amount,
  p.created_at::DATE,
  CASE WHEN p.status = 'completed' THEN 'completed' WHEN p.status = 'cancelled' THEN 'terminated' ELSE 'active' END,
  COALESCE(c.name, '旧客户'),
  p.created_at
FROM projects p
JOIN customers c ON c.id = p.customer_id
JOIN leads l ON l.id = c.lead_id
WHERE p.contract_amount IS NOT NULL AND p.contract_amount > 0;
```

### 13.3 阶段 3：接口与应用适配

| 前端路由 | 数据源变更 | 影响 |
|---------|-----------|------|
| `/sales/contracts` | 新 `contracts` 表 | 全新页面 |
| `/sales/payments` | 新 `payments` 表 + `installment_plans` | 全新页面 |
| `/sales/leads` (详情页) | 增加 Quotation Tab | 扩展 |
| `/sales/leads` (Won 操作) | 触发合同创建 | 流程变更 |
| `/overview` (Dashboard) | 消费 `v_contract_payment_overview` | 指标源变更 |
| `/sales/pipeline` | 不变（仍用 leads） | 无影响 |

### 13.4 数据完整性保障

1. **分期金额校验**：分期金额之和必须等于合同金额
2. **收款不超分期**：累计收款 ≤ 分期金额（允许分次付清）
3. **合同不可编辑**：状态为 `completed` 或 `terminated` 的合同禁止修改
4. **删除保护**：有付款记录的合同禁止删除

---

## 14. HubSpot vs NewMe 模型映射

| HubSpot 对象 | NewMe 表 | 映射说明 |
|-------------|---------|---------|
| Contact | `customers` + `leads` | HubSpot 的 Contact 包含个人信息和沟通历史；NewMe 拆分为客户档案和线索 |
| Company | `profiles`（乙方） | NewMe 作为乙方公司，信息在 profiles 中 |
| Deal | `leads` (enhanced) | HubSpot 的 Deal 含 Pipeline Stage + Amount + Probability；NewMe leads 已实现 |
| Product | `products` | 产品库，含 SKU、价格、分类 |
| Line Item | `quotation_items` | 报价/合同中的行项目 |
| Quote | `quotations` | 报价单，含版本、有效期、状态流转 |
| Ticket | 未来 `service_tickets` | 服务工单（当前未实现） |
| Task | `activities` WHERE type='task' | 待办任务在 activities 表中 |
| Meeting | `activities` WHERE type='meeting' | 会议记录 |
| Call | `activities` WHERE type='call' | 通话记录 |
| Note | `activities` WHERE type='note' | 备注 |
| Email | `activities` WHERE type='email' | 邮件记录 |
| Custom Object "Contract" | `contracts` | HubSpot 没有原生合同，需用自定义对象实现 |
| Custom Object "Payment" | `payments` + `installment_plans` | HubSpot 无原生分期/回款 |
| Custom Object "Project" | `projects` + `project_milestones` | HubSpot 有 Projects 对象（Enterprise） |
| Deal Pipeline | leads.stage (9 阶段) | 类似 HubSpot Deal Pipeline + 概率权重 |
| Association Labels | FK + 映射表 | 用外键实现 HubSpot 的关联标签 |
| Properties | Columns | 用列实现 HubSpot 的属性系统 |
| Calculated Properties | Triggers + Views | 用触发器和视图实现计算属性 |
| Activity/Engagement | `activities` | 类似 HubSpot 的统一活动模型 |

---

## 附录 A：数据字典速查

| 表名 | 行数预估 | 增长速率 | 核心字段数 | 备注 |
|------|---------|---------|-----------|------|
| leads | 万级 | ~100/天 | 30+ | 核心表，需要归档策略 |
| customers | 千级 | ~20/天 | 10+ | 与 leads 1:1 初期 |
| products | 百级 | ~5/月 | 15 | 产品库，相对稳定 |
| quotations | 千级 | ~30/天 | 25 | 报价可能有多个版本 |
| quotation_items | 万级 | ~100/天 | 15 | 报价行项目 |
| contracts | 千级 | ~5/天 | 25 | 核心业务表 |
| installment_plans | 万级 | ~20/天 | 10 | 每合同 N 条 |
| payments | 千级 | ~10/天 | 15 | 回款记录 |
| projects | 千级 | ~5/天 | 20 | 项目表 |
| project_milestones | 万级 | ~20/天 | 12 | 每项目 N 条 |
| project_documents | 万级 | ~30/天 | 10 | 文档/照片 |
| activities | 十万级 | ~200/天 | 12 | 增长最快 |
| business_events | 百万级 | ~500/天 | 8 | 审计日志，需定期清理 |

---

## 附录 B：关键 API 接口清单

| 接口 | 方法 | 说明 |
|------|------|------|
| `GET /api/quotations?lead_id=xxx` | Server Action | 获取线索的报价列表 |
| `POST /api/quotations` | Server Action | 新建报价 |
| `POST /api/quotations/:id/generate-pdf` | Server Action | 生成报价 PDF |
| `GET /api/contracts?status=active` | Server Action | 合同列表 |
| `POST /api/contracts` | Server Action | 从报价/Lead 创建合同 |
| `POST /api/contracts/:id/upload-pdf` | Server Action | 上传电子合同 |
| `PUT /api/contracts/:id/installments` | Server Action | 设定/修改付款计划 |
| `PUT /api/contracts/:id/deliveries` | Server Action | 设定交付计划 |
| `POST /api/payments` | Server Action | 登记收款 |
| `GET /api/dashboard/overview` | Supabase RPC | 驾驶舱聚合数据 |
| `POST /api/projects/:id/milestones` | Server Action | 项目里程碑管理 |
| `POST /api/projects/:id/documents` | Server Action | 项目文档上传 |
| `POST /api/projects/:id/inspections` | Server Action | 项目验收记录 |

---

> **文档版本记录**
>
> | 版本 | 日期 | 修改人 | 修改内容 |
> |------|------|--------|---------|
> | v1.0 | 2026-06-03 | 架构总监 | 初始版本：HubSpot 研究 + 5层数据模型 + 完整 DDL |
