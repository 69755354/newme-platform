# 销售团队管理模块 — 技术架构方案（v2.0）

> **架构版本**: v2.0 | **更新日期**: 2026-06-03 | **负责人**: 架构总监
>
> **核心变更**: 去掉销售经理角色(6→4角色)、新增 contracts 合同表、合同驱动的回款对账系统、统计视图与预警体系

---

## 目录

1. [总体架构](#1-总体架构)
2. [数据模型详情](#2-数据模型详情)
3. [RLS 策略设计](#3-rls-策略设计)
4. [API 设计](#4-api-设计)
5. [前端路由与组件树](#5-前端路由与组件树)
6. [统计视图体系](#6-统计视图体系)
7. [预警查询体系](#7-预警查询体系)
8. [电子合同存储方案](#8-电子合同存储方案)
9. [性能策略](#9-性能策略)
10. [关键设计决策](#10-关键设计决策)
11. [部署顺序](#11-部署顺序)
12. [附录：权限矩阵](#12-附录权限矩阵)

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         NewMe CRM (Next.js 16)                           │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  路由层 (App Router)                                                     │
│  ├─ /leads           ← 改造: 增加成员筛选 + 批量分配 + 合同Tab           │
│  ├─ /pipeline        ← 改造: 增加成员筛选器                               │
│  ├─ /dashboard       ← 改造: 增加团队业绩 + 逾期回款 + 合同统计          │
│  ├─ /team                              ← 新增: 团队管理首页               │
│  │    ├─ /team/members                 ← 新增: 成员管理 CRUD             │
│  │    ├─ /team/performance             ← 新增: 业绩看板                  │
│  │    ├─ /team/targets                 ← 新增: 目标管理                  │
│  │    ├─ /team/contracts               ← 新增: 合同总览                  │
│  │    └─ /team/payments                ← 新增: 回款对账报表              │
│  ├─ /contracts                         ← 新增: 合同列表                  │
│  │    └─ /contracts/[id]               ← 新增: 合同详情                  │
│  ├─ /my-performance                    ← 新增: 个人业绩                  │
│  └─ /my-targets                        ← 新增: 个人目标                  │
│                                                                          │
│  数据层 (Supabase)                                                       │
│  ├─ 新表: contracts, installment_plans                                    │
│  ├─ 改造: payments (关联 contract_id + installment_plan_id)               │
│  ├─ 新表: sales_targets                                                  │
│  ├─ 扩展: profiles (role枚举简化, is_active)                             │
│  ├─ 视图: v_contract_summary, v_sales_performance(重构)                  │
│  ├─ 视图: v_delivery_status, v_installment_overdue                       │
│  ├─ RLS: 4角色 × (contracts/installment_plans/payments/leads)           │
│  └─ 索引: 12个索引支撑查询性能                                            │
│                                                                          │
│  存储层 (Supabase Storage)                                               │
│  ├─ bucket: 'contracts' — 电子合同PDF存档                                │
│  ├─ 路径: {contract_id}/{filename}                                       │
│  └─ RLS: admin/operator/finance 可读, admin/operator 可写               │
│                                                                          │
│  组件层 (Shared Components)                                              │
│  ├─ SalesSelector          ← 新增: 销售选择下拉                         │
│  ├─ LeadTransferDialog     ← 新增: 转交弹窗                             │
│  ├─ ContractForm           ← 新增: 合同创建/编辑表单                    │
│  ├─ InstallmentPlanEditor  ← 新增: 分期计划编辑器                      │
│  ├─ PaymentForm            ← 改造: 关联合同+分期                        │
│  ├─ ContractUploader       ← 新增: 电子合同PDF上传                     │
│  └─ CommissionCalculator   ← 新增: 提成计算器                          │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据模型详情

### 2.1 角色枚举精简

**变更**: 去掉 `manager` 角色，RLS 简化为 4 角色

```sql
-- 更新 profiles 表的 role 约束
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check,
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('admin','operator','sales','finance','designer'));

-- 保留扩展字段
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  is_active BOOLEAN DEFAULT true;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  last_active_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  joined_at TIMESTAMPTZ DEFAULT now();
```

### 2.2 核心新表：contracts（合同表）

```sql
CREATE TABLE contracts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  deal_id           UUID UNIQUE,                              -- 可选的成交编号

  -- 客户信息 (冗余，合同独立于线索)
  customer_name     TEXT NOT NULL,
  customer_email    TEXT,
  customer_phone    TEXT,

  -- 合同日期与金额
  contract_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  total_amount      DECIMAL(12,2) NOT NULL CHECK (total_amount > 0),
  currency          TEXT NOT NULL DEFAULT 'AED',
  deposit_amount    DECIMAL(12,2) DEFAULT 0 CHECK (deposit_amount >= 0),

  -- 状态机
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN (
                        'draft','pending_approval','active',
                        'completed','terminated'
                      )),

  -- 签署与审批
  signed_by         UUID REFERENCES profiles(id),
  signed_at         TIMESTAMPTZ,
  approved_by       UUID REFERENCES profiles(id),
  approved_at       TIMESTAMPTZ,

  -- 电子合同 (PDF 存储在 Supabase Storage)
  pdf_url           TEXT,
  pdf_filename      TEXT,

  -- 交付计划 (JSONB，或通过独立表管理)
  delivery_milestones JSONB DEFAULT '[]'::jsonb,
  -- 示例:
  -- [
  --   {"name": "设计确认", "due_date": "2026-07-01", "status": "pending", "completed_at": null},
  --   {"name": "设备交付", "due_date": "2026-08-01", "status": "pending", "completed_at": null},
  --   {"name": "安装调试", "due_date": "2026-09-01", "status": "pending", "completed_at": null},
  --   {"name": "验收交付", "due_date": "2026-10-01", "status": "pending", "completed_at": null}
  -- ]

  -- 元数据
  notes             TEXT,
  created_by        UUID REFERENCES profiles(id),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now()
);

-- 索引
CREATE INDEX idx_contracts_lead ON contracts(lead_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_date ON contracts(contract_date);
CREATE INDEX idx_contracts_signed_by ON contracts(signed_by);
CREATE INDEX idx_contracts_approved_by ON contracts(approved_by);
CREATE INDEX idx_contracts_customer ON contracts(customer_name);

-- RLS
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
```

### 2.3 新建：installment_plans（付款计划表）

```sql
CREATE TABLE installment_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  contract_id       UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  lead_id           UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,

  -- 分期信息
  seq               INTEGER NOT NULL CHECK (seq > 0),         -- 第几期 (1-based)
  description       TEXT NOT NULL,                            -- 如"首付款 30%", "中期款 40%"
  amount            DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  percentage        DECIMAL(5,2) CHECK (percentage > 0 AND percentage <= 100),

  -- 日期
  due_date          DATE NOT NULL,
  paid_date         DATE,
  paid_amount       DECIMAL(12,2) DEFAULT 0,
  overdue_days      INTEGER GENERATED ALWAYS AS (
                      CASE
                        WHEN status = 'pending' AND due_date < CURRENT_DATE
                        THEN (CURRENT_DATE - due_date)::INTEGER
                        ELSE 0
                      END
                    ) STORED,

  -- 状态
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','paid','overdue','cancelled')),

  -- 关联实际收款
  payment_id        UUID REFERENCES payments(id),

  -- 元数据
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),

  -- 唯一约束
  UNIQUE (contract_id, seq)
);

-- 索引
CREATE INDEX idx_ip_contract ON installment_plans(contract_id);
CREATE INDEX idx_ip_lead ON installment_plans(lead_id);
CREATE INDEX idx_ip_status ON installment_plans(status);
CREATE INDEX idx_ip_due ON installment_plans(due_date)
  WHERE status = 'pending';
CREATE INDEX idx_ip_overdue ON installment_plans(due_date)
  WHERE status = 'pending' AND due_date < CURRENT_DATE;

-- RLS
ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;
```

### 2.4 改造：payments（回款记录表）

```sql
-- 改造 payments 表：从独立分期字段改为关联 contract + installment_plan
-- 保留向后兼容，新增关联字段

ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  contract_id UUID REFERENCES contracts(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS
  installment_plan_id UUID REFERENCES installment_plans(id);

-- 可选删除旧的分期字段 (视数据迁移策略而定)
-- ALTER TABLE payments DROP COLUMN IF EXISTS installment_seq;
-- ALTER TABLE payments DROP COLUMN IF EXISTS total_installments;

CREATE INDEX IF NOT EXISTS idx_payments_contract ON payments(contract_id);
CREATE INDEX IF NOT EXISTS idx_payments_installment ON payments(installment_plan_id);

-- 在 payments.lead_id 上已有索引
-- 在 payments.status, payments.expected_date 上已有索引

-- RLS (更新)
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- 删除旧策略 (若存在)
DROP POLICY IF EXISTS "payments_admin_all" ON payments;
DROP POLICY IF EXISTS "payments_manager_see" ON payments;
DROP POLICY IF EXISTS "payments_self_see" ON payments;

-- 新策略见第3节
```

### 2.5 保留：sales_targets（销售目标表）

```sql
CREATE TABLE IF NOT EXISTS sales_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 归属
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  set_by          UUID NOT NULL REFERENCES profiles(id),

  -- 周期
  period_type     TEXT NOT NULL CHECK (period_type IN ('monthly','quarterly')),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,

  -- 金额
  target_amount   DECIMAL(12,2) NOT NULL CHECK (target_amount > 0),

  -- 元数据
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE (user_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_targets_user ON sales_targets(user_id);
CREATE INDEX IF NOT EXISTS idx_targets_period ON sales_targets(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_targets_type ON sales_targets(period_type);

ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;
```

### 2.6 leads 表调整

```sql
-- 去掉 sales_manager 字段引用 (若存在)
-- ALTER TABLE leads DROP COLUMN IF EXISTS sales_manager;

-- 确保 assigned_to 存在
-- leads 表已有 assigned_to (UUID → profiles.id)

-- 触发器：lead→contract 签约后自动更新 lead 阶段
CREATE OR REPLACE FUNCTION sync_lead_on_contract_signed() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'active' AND OLD.status IN ('draft','pending_approval') THEN
    UPDATE leads
    SET funnel_stage = 'won',
        quotation_value = NEW.total_amount,
        updated_at = now()
    WHERE id = NEW.lead_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_contract_signed_sync_lead
  AFTER UPDATE OF status ON contracts
  FOR EACH ROW
  WHEN (NEW.status = 'active' AND OLD.status IN ('draft','pending_approval'))
  EXECUTE FUNCTION sync_lead_on_contract_signed();
```

---

## 3. RLS 策略设计

### 3.1 四角色权限矩阵

| 数据资源 | admin | operator | sales | finance |
|---------|-------|----------|-------|---------|
| **contracts** (读) | ALL | ALL | 仅自己关联 | ALL |
| **contracts** (写) | ALL | ALL(除删) | 仅自己(新建+草稿) | ❌ |
| **installment_plans** (读) | ALL | ALL | 仅自己关联 | ALL |
| **installment_plans** (写) | ALL | ALL(除删) | ❌ | INSERT+UPDATE |
| **payments** (读) | ALL | ALL | 仅自己关联 | ALL |
| **payments** (写) | ALL | INSERT+UPDATE | ❌ | INSERT+UPDATE |
| **leads** (读) | ALL | ALL | 仅 assigned_to=self | ❌ |
| **leads** (写) | ALL(含删) | INSERT+UPDATE(含分配) | UPDATE(仅自己) | ❌ |
| **sales_targets** (读) | ALL | ALL | 仅自己 | ❌ |
| **sales_targets** (写) | ALL | ❌ | ❌ | ❌ |

### 3.2 contracts RLS

```sql
-- admin: ALL
CREATE POLICY "contracts_admin_all" ON contracts FOR ALL
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  ));

-- operator: ALL
CREATE POLICY "contracts_operator_all" ON contracts FOR ALL
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'operator'
  ));

-- sales: 仅查看自己关联的合同 (signed_by = self, 或 lead 归属自己)
CREATE POLICY "contracts_sales_select" ON contracts FOR SELECT
  USING (
    signed_by = auth.uid()
    OR lead_id IN (
      SELECT id FROM leads WHERE assigned_to = auth.uid()
    )
  );

-- sales: 可创建自己关联的合同
CREATE POLICY "contracts_sales_insert" ON contracts FOR INSERT
  WITH CHECK (
    signed_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'sales'
    )
  );

-- sales: 可编辑草稿状态的合同
CREATE POLICY "contracts_sales_update" ON contracts FOR UPDATE
  USING (
    status = 'draft'
    AND (signed_by = auth.uid() OR lead_id IN (
      SELECT id FROM leads WHERE assigned_to = auth.uid()
    ))
  )
  WITH CHECK (status IN ('draft', 'pending_approval'));

-- finance: SELECT only on contracts
CREATE POLICY "contracts_finance_select" ON contracts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'finance'
  ));
```

### 3.3 installment_plans RLS

```sql
-- admin: ALL
CREATE POLICY "ip_admin_all" ON installment_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- operator: ALL
CREATE POLICY "ip_operator_all" ON installment_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- sales: SELECT only on own contracts' installment plans
CREATE POLICY "ip_sales_select" ON installment_plans FOR SELECT
  USING (
    contract_id IN (
      SELECT c.id FROM contracts c
      JOIN leads l ON l.id = c.lead_id
      WHERE l.assigned_to = auth.uid()
    )
  );

-- finance: SELECT + INSERT + UPDATE
CREATE POLICY "ip_finance_select" ON installment_plans FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

CREATE POLICY "ip_finance_insert" ON installment_plans FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));

CREATE POLICY "ip_finance_update" ON installment_plans FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
```

### 3.4 payments RLS

```sql
-- admin: ALL
CREATE POLICY "payments_admin_all" ON payments FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- operator: SELECT + INSERT + UPDATE
CREATE POLICY "payments_operator_select" ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));
CREATE POLICY "payments_operator_insert" ON payments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));
CREATE POLICY "payments_operator_update" ON payments FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- sales: SELECT only on own contracts' payments
CREATE POLICY "payments_sales_select" ON payments FOR SELECT
  USING (
    lead_id IN (
      SELECT id FROM leads WHERE assigned_to = auth.uid()
    )
  );

-- finance: SELECT + INSERT + UPDATE
CREATE POLICY "payments_finance_select" ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
CREATE POLICY "payments_finance_insert" ON payments FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
CREATE POLICY "payments_finance_update" ON payments FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
```

### 3.5 leads RLS 更新

```sql
-- 保留现有 sales 策略: 仅看自己
-- 保留现有 admin 策略: ALL

-- operator: ALL (同 admin 但不可删除)
CREATE POLICY "leads_operator_all" ON leads FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

-- 删除旧的 manager 策略 (若存在)
DROP POLICY IF EXISTS "manager_team_leads" ON leads;
```

### 3.6 sales_targets RLS

```sql
CREATE POLICY "targets_admin_all" ON sales_targets FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "targets_operator_see" ON sales_targets FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));

CREATE POLICY "targets_self_see" ON sales_targets FOR SELECT
  USING (user_id = auth.uid());
```

---

## 4. API 设计

### 4.1 模式：Client-side 查询 + Server Actions 写入

| 操作类型 | 方式 | 理由 |
|---------|------|------|
| 读取 leads/pipeline/contracts | `supabase.from('...').select()` 客户端直调 | 利用 PG 索引 + RLS 自动过滤 |
| 合同创建/签署 | Server Action (`'use server'`) | 需要验证权限 + 更新 lead 状态 + 记录事件 |
| 收款登记 | Server Action | 关联多条记录 (payment + installment_plan update + business_event) |
| 分期计划设置 | Server Action | 批量插入 + 金额校验 + 事件记录 |
| 业绩/统计查询 | 视图 + RPC | 聚合查询避免 N+1 |
| 电子合同上传 | Server Action → Storage SDK | 文件校验 + bucket RLS |

### 4.2 Server Actions 关键接口

```typescript
// app/actions/contracts/create-contract.ts
'use server'

export async function createContract(params: {
  leadId: string;
  customerName: string;
  totalAmount: number;
  contractDate: string;
  deliveryMilestones?: DeliveryMilestone[];
  notes?: string;
}) {
  // 1. 验证当前用户角色 (sales 仅可建 own lead 合同)
  // 2. 插入 contracts 表 (status='draft')
  // 3. 记录 business_event (type='contract_created')
  // 4. 返回 contract.id
}

// app/actions/contracts/sign-contract.ts
'use server'

export async function signContract(contractId: string, approvedBy?: string) {
  // 1. 更新 status='active', signed_at=now(), signed_by=auth.uid()
  // 2. 若包含 approvedBy, 更新 approved_by, approved_at
  // 3. 触发器自动更新 lead.funnel_stage = 'won'
  // 4. 记录 business_event (type='contract_signed')
  // 5. 自动创建 installment_plans (若有 deposit_amount 或约定分期)
}

// app/actions/contracts/upload-pdf.ts
'use server'

export async function uploadContractPdf(contractId: string, formData: FormData) {
  // 1. 验证权限
  // 2. 上传到 Supabase Storage bucket 'contracts'
  //    路径: `${contractId}/${filename}`
  // 3. 更新 contracts.pdf_url + pdf_filename
  // 4. 返回 public URL
}

// app/actions/installments/setup-plan.ts
'use server'

export async function setupInstallmentPlan(contractId: string, installments: {
  seq: number;
  description: string;
  amount: number;
  percentage: number;
  dueDate: string;
}[]) {
  // 1. 验证总额 = contract.total_amount - deposit_amount
  // 2. 批量 INSERT installment_plans
  // 3. 记录 business_event
}

// app/actions/payments/record-payment.ts
'use server'

export async function recordPayment(params: {
  contractId: string;
  installmentPlanId: string;
  amount: number;
  paymentDate: string;
  paymentMethod: 'bank_transfer' | 'cash' | 'cheque' | 'card' | 'other';
  notes?: string;
}) {
  // 1. INSERT into payments
  // 2. UPDATE installment_plans SET status='paid', paid_date, paid_amount, payment_id
  // 3. 若所有分期已付清 → 自动更新 contract.status = 'completed'
  // 4. 记录 business_event (type='payment_recorded')
}

// app/actions/targets/set-target.ts
'use server'

export async function setSalesTarget(params: {
  userId: string;
  periodType: 'monthly' | 'quarterly';
  periodStart: string;  // YYYY-MM-DD
  targetAmount: number;
}) {
  // 1. 校验权限 (仅 admin)
  // 2. UPSERT (user_id, period_type, period_start)
  // 3. 记录 business_event
}
```

### 4.3 RPC 查询接口

```sql
-- 合同统计 (按销售维度)
CREATE OR REPLACE FUNCTION get_contract_stats(
  p_user_id UUID DEFAULT NULL,
  p_start_date DATE DEFAULT NULL,
  p_end_date DATE DEFAULT NULL
)
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  contract_count BIGINT,
  total_contract_amount DECIMAL,
  total_received DECIMAL,
  total_pending DECIMAL,
  overdue_count BIGINT,
  overdue_amount DECIMAL,
  collection_rate DECIMAL
) AS $$
  -- 实现见第6节统计视图
$$ LANGUAGE sql STABLE;
```

---

## 5. 前端路由与组件树

### 5.1 新增/改造页面路由

| 路由 | 文件 | 可见角色 | 功能 |
|------|------|---------|------|
| `/contracts` | `contracts/page.tsx` | admin,operator,finance,sales | 合同列表（角色过滤范围不同） |
| `/contracts/[id]` | `contracts/[id]/page.tsx` | admin,operator,finance,sales | 合同详情（基本信息+分期+回款+交付） |
| `/contracts/new` | `contracts/new/page.tsx` | admin,operator,sales | 新建合同（关联 Won Lead） |
| `/team/contracts` | `team/contracts/page.tsx` | admin,operator,finance | 合同总览（全局统计） |
| `/team/payments` | `team/payments/page.tsx` | admin,operator,finance | 回款对账报表 |
| `/team` | `team/page.tsx` | admin,operator | 团队首页（成员列表） |
| `/team/members` | `team/members/page.tsx` | admin,operator | 成员管理 CRUD |
| `/team/performance` | `team/performance/page.tsx` | admin,operator,finance | 团队业绩排名 |
| `/team/targets` | `team/targets/page.tsx` | admin | 目标设定与管理 |
| `/my-performance` | `my-performance/page.tsx` | sales | 个人业绩看板 |
| `/my-targets` | `my-targets/page.tsx` | sales | 个人目标进度 |
| `/leads/[id]` | `leads/[id]/page.tsx` | **改造** | 增加「合同」Tab + 「回款」Tab |

### 5.2 合同详情页组件树

```
/contracts/[id]/page.tsx
├── ContractHeader
│   ├── 状态标签 (draft/active/completed/terminated)
│   ├── 操作按钮 (签署/上传PDF/编辑/终止)
│   └── 客户信息卡片
├── ContractAmountCard
│   ├── 合同总额
│   ├── 已收金额 (SUM paid)
│   ├── 待收金额 (SUM pending)
│   └── 回款率进度条
├── InstallmentPlanPanel         ← 核心
│   ├── 分期计划列表 (表格)
│   │   ├── 期次 | 描述 | 到期日 | 金额 | 状态 | 操作
│   │   └── 逾期标记 (红色高亮)
│   ├── 登记收款按钮 (finance/operator)
│   └── 设置分期计划按钮 (admin/operator)
├── DeliveryMilestonePanel
│   ├── 交付里程碑列表
│   │   ├── 名称 | 到期日 | 状态 | 完成时间
│   │   └── 超期标记 (红色高亮)
│   └── 编辑里程碑按钮
├── PaymentHistoryTable
│   ├── 日期 | 方式 | 金额 | 关联分期 | 登记人
│   └── 导出按钮
├── ContractPdfViewer
│   ├── PDF 预览/下载链接
│   └── 上传/替换按钮
└── ContractNotes
```

### 5.3 共享组件

| 组件 | 用途 | 可见角色 |
|------|------|---------|
| `SalesSelector` | 下拉选择销售（头像+姓名+角色） | admin,operator |
| `LeadTransferDialog` | 模态框：目标销售选择 + 原因 + 确认 | admin,operator |
| `ContractForm` | 合同创建/编辑表单（关联 Lead） | admin,operator,sales |
| `InstallmentPlanEditor` | 分期计划编辑器（动态行+金额校验） | admin,operator,finance |
| `PaymentForm` | 收款登记表单（关联合同+分期） | admin,operator,finance |
| `ContractUploader` | PDF上传组件（拖放+进度） | admin,operator |
| `PerformanceTable` | 可排序的业绩对比表格 | admin,operator,finance |
| `OverdueAlertCard` | 逾期预警卡片（Dashboard） | admin,operator,finance |

### 5.4 前端导航配置

```typescript
const NAV_ITEMS = {
  common: [
    { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
    { label: 'Pipeline', path: '/pipeline', icon: TrendingUp },
    { label: 'Leads', path: '/leads', icon: Users },
  ],
  contracts: [
    { label: '合同管理', path: '/contracts', icon: FileText,
      roles: ['admin','operator','sales','finance'] },
  ],
  team: [
    { label: '团队管理', path: '/team', icon: UserCog,
      roles: ['admin','operator'] },
    { label: '合同总览', path: '/team/contracts', icon: FileText,
      roles: ['admin','operator','finance'] },
    { label: '业绩看板', path: '/team/performance', icon: BarChart3,
      roles: ['admin','operator','finance'] },
    { label: '目标管理', path: '/team/targets', icon: Target,
      roles: ['admin'] },
    { label: '回款对账', path: '/team/payments', icon: DollarSign,
      roles: ['admin','operator','finance'] },
  ],
  my: [
    { label: '我的业绩', path: '/my-performance', icon: User,
      roles: ['sales'] },
    { label: '我的目标', path: '/my-targets', icon: Target,
      roles: ['sales'] },
  ],
};
```

---

## 6. 统计视图体系

### 6.1 v_contract_summary（全局合同汇总）

```sql
CREATE OR REPLACE VIEW v_contract_summary AS
SELECT
  -- 全局汇总
  COUNT(c.id) AS total_contracts,
  COUNT(c.id) FILTER (WHERE c.status = 'active') AS active_contracts,
  COUNT(c.id) FILTER (WHERE c.status = 'draft') AS draft_contracts,
  COUNT(c.id) FILTER (WHERE c.status = 'completed') AS completed_contracts,
  COUNT(c.id) FILTER (WHERE c.status = 'terminated') AS terminated_contracts,

  -- 金额汇总
  COALESCE(SUM(c.total_amount) FILTER (WHERE c.status IN ('active','completed')), 0)
    AS total_contract_value,
  COALESCE(SUM(c.total_amount) FILTER (WHERE c.status = 'active'), 0)
    AS active_contract_value,

  -- 已收/待收
  COALESCE((
    SELECT SUM(p.amount) FROM payments p
    WHERE p.contract_id = c.id AND p.status = 'paid'
  ), 0) AS total_received,

  COALESCE((
    SELECT SUM(ip.amount) FROM installment_plans ip
    WHERE ip.contract_id = c.id AND ip.status IN ('pending','overdue')
  ), 0) AS total_pending,

  -- 逾期
  COALESCE((
    SELECT COUNT(*) FROM installment_plans ip
    WHERE ip.contract_id = c.id AND ip.status = 'pending'
      AND ip.due_date < CURRENT_DATE
  ), 0) AS overdue_installment_count,

  COALESCE((
    SELECT SUM(ip.amount) FROM installment_plans ip
    WHERE ip.contract_id = c.id AND ip.status = 'pending'
      AND ip.due_date < CURRENT_DATE
  ), 0) AS overdue_amount,

  -- 回款率
  CASE
    WHEN SUM(c.total_amount) > 0
    THEN ROUND(
      COALESCE((
        SELECT SUM(p.amount) FROM payments p
        WHERE p.contract_id = c.id AND p.status = 'paid'
      ), 0) / SUM(c.total_amount) * 100, 1
    )
    ELSE 0
  END AS collection_rate

FROM contracts c;

COMMENT ON VIEW v_contract_summary IS '全局合同汇总统计，用于 Dashboard 顶部卡片';
```

### 6.2 v_sales_performance（重构版 — 按销售维度）

```sql
-- 替代 v1 的旧视图，去掉 manager 引用，新增合同+回款指标
CREATE OR REPLACE VIEW v_sales_performance AS
SELECT
  p.id AS user_id,
  p.full_name,
  p.role,
  p.is_active,

  -- ---------- Pipeline 指标 ----------
  COUNT(l.id) FILTER (
    WHERE l.funnel_stage NOT IN ('won','lost')
      AND l.disqualified_candidate = false
  ) AS active_leads,

  COALESCE(SUM(l.quotation_value) FILTER (
    WHERE l.funnel_stage NOT IN ('won','lost')
      AND l.disqualified_candidate = false
  ), 0) AS pipeline_value,

  -- ---------- 合同指标 ----------
  COUNT(c.id) FILTER (WHERE c.status IN ('active','completed')) AS won_contracts,
  COALESCE(SUM(c.total_amount) FILTER (
    WHERE c.status IN ('active','completed')
      AND DATE_TRUNC('month', c.contract_date) = DATE_TRUNC('month', CURRENT_DATE)
  ), 0) AS contract_amount_month,

  COALESCE(SUM(c.total_amount) FILTER (
    WHERE c.status IN ('active','completed')
  ), 0) AS total_contract_amount,

  -- ---------- 回款指标 ----------
  COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0) AS total_received,
  COALESCE(SUM(pay.amount) FILTER (
    WHERE pay.status = 'paid'
      AND DATE_TRUNC('month', pay.payment_date) = DATE_TRUNC('month', CURRENT_DATE)
  ), 0) AS received_this_month,

  -- 应收总额 (所有 active 合同的待收分期)
  COALESCE((
    SELECT SUM(ip.amount)
    FROM installment_plans ip
    JOIN contracts c2 ON c2.id = ip.contract_id
    WHERE c2.lead_id IN (SELECT id FROM leads WHERE assigned_to = p.id)
      AND ip.status IN ('pending','overdue')
  ), 0) AS pending_receivable,

  -- ---------- 回款率 ----------
  CASE
    WHEN COALESCE(SUM(c.total_amount) FILTER (
      WHERE c.status IN ('active','completed')
    ), 0) > 0
    THEN ROUND(
      COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0) /
      NULLIF(SUM(c.total_amount) FILTER (
        WHERE c.status IN ('active','completed')
      ), 0) * 100, 1
    )
    ELSE 0
  END AS collection_rate,

  -- ---------- 逾期指标 ----------
  COALESCE((
    SELECT COUNT(*)
    FROM installment_plans ip
    JOIN contracts c2 ON c2.id = ip.contract_id
    WHERE c2.lead_id IN (SELECT id FROM leads WHERE assigned_to = p.id)
      AND ip.status = 'pending' AND ip.due_date < CURRENT_DATE
  ), 0) AS overdue_count,

  COALESCE((
    SELECT SUM(ip.amount)
    FROM installment_plans ip
    JOIN contracts c2 ON c2.id = ip.contract_id
    WHERE c2.lead_id IN (SELECT id FROM leads WHERE assigned_to = p.id)
      AND ip.status = 'pending' AND ip.due_date < CURRENT_DATE
  ), 0) AS overdue_amount,

  -- ---------- 转化率 ----------
  CASE
    WHEN COUNT(l.id) FILTER (WHERE l.funnel_stage IN ('won','lost')) > 0
    THEN ROUND(
      COUNT(l.id) FILTER (WHERE l.funnel_stage = 'won')::DECIMAL /
      COUNT(l.id) FILTER (WHERE l.funnel_stage IN ('won','lost')) * 100, 1
    )
    ELSE 0
  END AS conversion_rate

FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
LEFT JOIN contracts c ON c.lead_id = l.id
LEFT JOIN payments pay ON pay.lead_id = l.id AND pay.status = 'paid'
WHERE p.role IN ('sales')
GROUP BY p.id, p.full_name, p.role, p.is_active;

COMMENT ON VIEW v_sales_performance IS '销售业绩视图 v2 — 含合同额、回款率、逾期指标';
```

### 6.3 v_delivery_status（交付里程碑状态）

```sql
-- 展开 JSONB delivery_milestones 为行
CREATE OR REPLACE VIEW v_delivery_status AS
SELECT
  c.id AS contract_id,
  c.customer_name,
  c.contract_date,
  c.total_amount,
  p.full_name AS sales_name,
  p.id AS sales_id,

  -- 里程碑统计
  (c.delivery_milestones #>> '{}')::jsonb AS milestones_raw,

  -- 已完成的里程碑数量
  COALESCE((
    SELECT COUNT(*)
    FROM jsonb_array_elements(c.delivery_milestones) AS m
    WHERE m->>'status' = 'completed'
  ), 0) AS completed_milestones,

  -- 总里程碑数量
  COALESCE(jsonb_array_length(c.delivery_milestones), 0) AS total_milestones,

  -- 超期里程碑数量
  COALESCE((
    SELECT COUNT(*)
    FROM jsonb_array_elements(c.delivery_milestones) AS m
    WHERE (m->>'status')::text != 'completed'
      AND (m->>'due_date')::date < CURRENT_DATE
  ), 0) AS overdue_milestones,

  -- 里程碑进度百分比
  CASE
    WHEN jsonb_array_length(c.delivery_milestones) > 0
    THEN ROUND(
      (SELECT COUNT(*)::DECIMAL
       FROM jsonb_array_elements(c.delivery_milestones) AS m
       WHERE m->>'status' = 'completed'
      ) / jsonb_array_length(c.delivery_milestones) * 100, 0
    )
    ELSE 0
  END AS delivery_progress_pct,

  -- 是否有超期里程碑 (预警用)
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(c.delivery_milestones) AS m
    WHERE (m->>'status')::text != 'completed'
      AND (m->>'due_date')::date < CURRENT_DATE
  ) AS has_overdue_milestone

FROM contracts c
JOIN profiles p ON p.id = c.signed_by
WHERE c.status IN ('active', 'completed')
  AND jsonb_array_length(c.delivery_milestones) > 0;

COMMENT ON VIEW v_delivery_status IS '交付里程碑状态视图，含超期预警标记';
```

---

## 7. 预警查询体系

### 7.1 逾期付款计划查询

```sql
-- 查询所有逾期的分期付款计划
-- 用于 Dashboard「逾期回款」卡片
SELECT
  ip.id AS installment_id,
  c.id AS contract_id,
  c.customer_name,
  p.full_name AS sales_name,
  p.id AS sales_id,
  ip.seq,
  ip.description,
  ip.amount,
  ip.due_date,
  (CURRENT_DATE - ip.due_date) AS overdue_days,
  c.total_amount AS contract_amount

FROM installment_plans ip
JOIN contracts c ON c.id = ip.contract_id
JOIN leads l ON l.id = c.lead_id
JOIN profiles p ON p.id = l.assigned_to

WHERE ip.status = 'pending'
  AND ip.due_date < CURRENT_DATE

ORDER BY overdue_days DESC, ip.due_date ASC;

-- 可用于前端定时轮询 (每5分钟)
-- 或通过 Supabase Realtime 订阅 status='pending' 的 insert/update
```

### 7.2 超期交付里程碑查询

```sql
-- 查询所有超期的交付里程碑
-- 用于 Dashboard「交付风险」卡片
SELECT
  c.id AS contract_id,
  c.customer_name,
  p.full_name AS sales_name,
  milestone->>'name' AS milestone_name,
  (milestone->>'due_date')::date AS due_date,
  milestone->>'status' AS status,
  (CURRENT_DATE - (milestone->>'due_date')::date) AS overdue_days,
  c.total_amount AS contract_amount

FROM contracts c
JOIN profiles p ON p.id = c.signed_by,
LATERAL jsonb_array_elements(c.delivery_milestones) AS milestone

WHERE c.status = 'active'
  AND milestone->>'status' != 'completed'
  AND (milestone->>'due_date')::date < CURRENT_DATE

ORDER BY overdue_days DESC, due_date ASC;
```

### 7.3 低回款率预警查询

```sql
-- 按销售聚合，回款率 < 60% 标记为低回款预警
-- 用于 Dashboard「销售健康度」卡片
SELECT
  p.id AS sales_id,
  p.full_name AS sales_name,
  COALESCE(SUM(c.total_amount) FILTER (
    WHERE c.status IN ('active','completed')
  ), 0) AS total_contract_amount,
  COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0) AS total_received,
  COALESCE(SUM(ip.amount) FILTER (
    WHERE ip.status IN ('pending','overdue')
  ), 0) AS total_pending,
  COALESCE(SUM(ip.amount) FILTER (
    WHERE ip.status = 'pending' AND ip.due_date < CURRENT_DATE
  ), 0) AS overdue_amount,

  -- 回款率
  CASE
    WHEN COALESCE(SUM(c.total_amount), 0) > 0
    THEN ROUND(
      COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0) /
      NULLIF(SUM(c.total_amount), 0) * 100, 1
    )
    ELSE 0
  END AS collection_rate,

  -- 预警等级
  CASE
    WHEN COALESCE(SUM(c.total_amount), 0) = 0 THEN 'no_contracts'
    WHEN ROUND(
      COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0) /
      NULLIF(SUM(c.total_amount), 0) * 100, 1
    ) < 30 THEN 'critical'    -- < 30% → 危险
    WHEN ROUND(
      COALESCE(SUM(pay.amount) FILTER (WHERE pay.status = 'paid'), 0) /
      NULLIF(SUM(c.total_amount), 0) * 100, 1
    ) < 60 THEN 'warning'     -- 30-60% → 警告
    ELSE 'normal'
  END AS alert_level

FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
LEFT JOIN contracts c ON c.lead_id = l.id AND c.status IN ('active','completed')
LEFT JOIN payments pay ON pay.contract_id = c.id AND pay.status = 'paid'
LEFT JOIN installment_plans ip ON ip.contract_id = c.id
WHERE p.role = 'sales' AND p.is_active = true
GROUP BY p.id, p.full_name
HAVING COALESCE(SUM(c.total_amount), 0) > 0
ORDER BY collection_rate ASC;
```

### 7.4 Dashboard 预警卡片设计

| 卡片 | 数据源 | 刷新频率 | 可见角色 |
|------|--------|---------|---------|
| **逾期回款** | §7.1 查询 | 每5分钟 | admin,operator,finance |
| **交付风险** | §7.2 查询 | 每15分钟 | admin,operator |
| **低回款率销售** | §7.3 查询 | 每15分钟 | admin,operator |
| **合同签署待办** | status='draft' 的 contracts 数量 | 实时 | admin,operator,sales |
| **未分配线索** | leads WHERE assigned_to IS NULL | 实时 | admin,operator |

---

## 8. 电子合同存储方案

### 8.1 Supabase Storage 配置

```sql
-- 创建 bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contracts',
  'contracts',
  false,                            -- 不公开访问（通过 RLS 控制）
  10485760,                         -- 10MB 限制
  ARRAY['application/pdf']::text[]  -- 仅允许 PDF
);
```

### 8.2 存储 RLS 策略

```sql
-- bucket RLS
-- 读取: admin, operator, finance 可读任何合同 PDF
CREATE POLICY "contracts_read_admin_operator_finance"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'contracts'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('admin','operator','finance')
    )
  );

-- 读取: sales 仅可读自己合同的 PDF
CREATE POLICY "contracts_read_sales_own"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'contracts'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid() AND role = 'sales'
    )
    AND auth.uid() IN (
      SELECT c.signed_by FROM contracts c
      WHERE c.id::text = (storage.foldername(name))[1]  -- path: {contract_id}/{filename}
    )
  );

-- 写入: admin, operator 可上传/覆盖
CREATE POLICY "contracts_write_admin_operator"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'contracts'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('admin','operator')
    )
  );

CREATE POLICY "contracts_update_admin_operator"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'contracts'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('admin','operator')
    )
  );

-- 删除: 仅 admin
CREATE POLICY "contracts_delete_admin"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'contracts'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );
```

### 8.3 上传前端流程

```
用户选择PDF → ContractUploader 组件
  ↓
Client-side 校验: 文件类型(application/pdf), 大小(<10MB)
  ↓
Server Action: uploadContractPdf(contractId, formData)
  ↓
1. 创建 signed URL (若需客户端上传) 或 直接服务端上传
2. 上传至 storage/contracts/{contractId}/{uuid}.pdf
3. 更新 contracts.pdf_url, pdf_filename
4. 记录 business_event (type='contract_pdf_uploaded')
  ↓
返回 public URL 或 signed URL 供前端展示
```

---

## 9. 性能策略

| 场景 | 方案 | 预估 |
|------|------|------|
| 合同列表 (全量) | PG 索引 + RLS 下推，单次查询 <50ms | contracts < 1万行 |
| 合同详情 (含分期+付款) | 3 个独立查询并行 (contracts + installment_plans + payments) | <100ms |
| 业绩排名查询 | 视图 v_sales_performance (直接查询，非物化) | <20ms |
| 全局合同统计 | 视图 v_contract_summary (直接查询) | <10ms |
| 逾期分期扫描 | 部分索引 idx_ip_overdue (WHERE pending AND due_date < today) | <5ms |
| 交付里程碑展开 | JSONB 函数 jsonb_array_elements + GIN 索引 | <20ms |
| 电子合同 PDF 下载 | Supabase Storage CDN (边缘缓存) | <500ms |
| 实时预警通知 | Supabase Realtime (channel: `installment_plans:status=overdue`) | <500ms |

### 额外建议索引

```sql
-- 加速逾期查询的部分索引
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ip_due_pending
  ON installment_plans(due_date)
  WHERE status = 'pending';

-- 加速合同金额聚合
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contracts_amount_status
  ON contracts(total_amount) WHERE status IN ('active','completed');

-- 加速 v_sales_performance 中的 leads 关联
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_assigned_stage
  ON leads(assigned_to, funnel_stage) WHERE disqualified_candidate = false;
```

---

## 10. 关键设计决策

| 决策 ID | 决策 | 选项 | 选择理由 |
|---------|------|------|---------|
| D-001 | **去掉销售经理角色** | 保留 vs 去掉 | 用户明确要求简化，4角色(admin/operator/sales/finance)足够覆盖业务；经理功能由 admin+operator 分担 |
| D-002 | **contracts 独立表**（非 leads 扩展） | 存 leads 扩展字段 vs 独立表 | 合同有独立生命周期和状态机(draft→active→completed)，分期/付款/交付需要独立关联 |
| D-003 | **installment_plans 独立表**（非 payments 字段标记） | payments 存分期字段 vs 独立表 | 分期需要跟踪状态、逾期天数、批量管理，独立表更灵活；generated column `overdue_days` 降低计算复杂度 |
| D-004 | **交付里程碑存 JSONB**（非独立表） | 独立 milestones 表 vs JSONB | 交付里程碑数量少且固定(4-6个)，JSONB 减少 JOIN 复杂度；需 GIN 索引配合展开查询 |
| D-005 | **合同签署自动触发 lead 阶段更新** | 手动 vs 触发器 | 合同签署 = 成交 (Won)，触发器确保一致性，减少前端调用复杂度 |
| D-006 | **回款路径：contracts → installment_plans → payments** | 直接 contracts→payments vs 三级 | 三级结构支持精确的对账——知道每笔收款还的是哪期分期，逾期计算精确到期次 |
| D-007 | **统计用视图（非物化）** | 物化视图 vs 普通视图 | 数据量小(<1万行)时普通视图延迟可接受(<50ms)，避免物化视图刷新延迟导致数据不一致 |
| D-008 | **电子合同存 Supabase Storage 非 DB** | DB bytea vs Storage | 10MB PDF 不适合存 DB，Storage 有 CDN + 独立 RLS + 文件类型校验 |
| D-009 | **finance 可读 contracts 不可写** | 写权限 vs 只读 | 财务只需查看合同确定应收，不可篡改；对 installment_plans 和 payments 有写权限以记录收款 |
| D-010 | **sales 可创建草稿合同** | 仅 admin/operator 可建 vs sales 可建 | 销售需要创建合同草稿提交审批，但 status='draft' 限制不可自行签署/激活 |

---

## 11. 部署顺序

### 📅 Sprint 1 (P0) — 核心回款闭环

| 任务 | 预估工时 | 交付物 |
|------|---------|--------|
| contracts 表 + installment_plans 表 + 改造 payments | 1.5 天 | SQL 迁移脚本 + 索引 + RLS |
| 合同创建/编辑页面 | 1.5 天 | ContractForm + 合同列表页 |
| 合同详情页（分期展示 + 回款登记） | 2 天 | 分期计划面板 + PaymentForm |
| 电子合同 PDF 上传 | 1 天 | ContractUploader + Storage RLS |
| Dashboard 新增合同/回款统计卡片 | 1 天 | 全局合同汇总 + 逾期卡片 |
| 团队业绩排名（含合同额+回款率） | 1 天 | v_sales_performance + 排名表 |
| Lead 分配/转交/未分配池 | 2 天 | SalesSelector + LeadTransferDialog |

### 📅 Sprint 2 (P1) — 增强功能

| 任务 | 预估工时 | 交付物 |
|------|---------|--------|
| 批量分配 + 归属历史追溯 | 1 天 | 批量操作 UI + business_events 消费 |
| 销售成员管理 (CRUD + 停用/激活) | 1.5 天 | 成员管理页面 |
| 销售目标设定 + 完成率 | 2 天 | sales_targets + 目标管理页面 |
| 交付里程碑管理 | 1 天 | 里程碑面板 + 超期预警 |
| 合同签署审批流程 | 1 天 | draft→pending_approval→active 工作流 |
| 批量分期计划模板 | 1 天 | InstallmentPlanEditor 批量生成 |

### 📅 Sprint 3 (P2) — 深度分析

| 任务 | 预估工时 | 交付物 |
|------|---------|--------|
| 业绩趋势图 (6个月) | 1 天 | 月度合同额/回款额折线图 |
| 低回款率预警通知 | 1 天 | 定时任务 + 站内通知 |
| 回款报表导出 (CSV/Excel) | 1 天 | 对账报表导出 |
| 合同模板 | 0.5 天 | 合同内容模板 |
| 财务专用回款排名 | 1 天 | 财务视角的合同+回款报表 |

---

## 12. 附录：权限矩阵

### 12.1 功能权限矩阵

| 操作 | admin | operator | sales | finance |
|------|-------|----------|-------|---------|
| 查看所有 Lead | ✅ | ✅ | ❌ 仅自己 | ❌ |
| 创建/编辑 Lead | ✅ | ✅ | ✅ 仅自己 | ❌ |
| 分配/转交 Lead | ✅ | ✅ | ❌ | ❌ |
| 批量调配 Lead | ✅ | ✅ | ❌ | ❌ |
| 查看归属历史 | ✅ | ✅ | ✅ 仅自己 | ❌ |
| 查看合同列表 | ✅ 全部 | ✅ 全部 | ✅ 仅自己 | ✅ 全部 |
| 创建合同(草稿) | ✅ | ✅ | ✅ 仅自己能关联 | ❌ |
| 签署/激活合同 | ✅ | ✅ | ❌ | ❌ |
| 上传电子合同PDF | ✅ | ✅ | ❌ | ❌ |
| 设置分期计划 | ✅ | ✅ | ❌ | ✅ |
| 登记收款 | ✅ | ✅ | ❌ | ✅ |
| 查看回款报表 | ✅ | ✅ | ✅ 仅自己 | ✅ |
| 查看团队业绩排名 | ✅ | ✅ | ❌ | ✅ |
| 查看个人业绩 | ✅ | ✅ | ✅ | ✅ |
| 设定销售目标 | ✅ | ❌ | ❌ | ❌ |
| 管理成员 | ✅ | ✅ | ❌ | ❌ |
| 角色/权限配置 | ✅ | ❌ | ❌ | ❌ |

### 12.2 数据范围矩阵

| 角色 | contracts 范围 | installment_plans 范围 | payments 范围 | leads 范围 |
|------|---------------|------------------------|--------------|-----------|
| admin | 全部 | 全部 | 全部 | 全部 |
| operator | 全部 | 全部 | 全部 | 全部 |
| sales | 仅 `signed_by=self` 或 `lead.assigned_to=self` | 仅自己的合同关联 | 仅关联自己的合同 | 仅 `assigned_to=self` |
| finance | 全部(只读) | 全部(读+写) | 全部(读+写) | ❌ |

### 12.3 CRUD 矩阵速查

```
表名         admin  operator  sales            finance
─────────────────────────────────────────────────────────
contracts    CRUD   CRUD      CR(只读+Draft写) R(只读)
installment  CRUD   CRUD      R                CRU
payments     CRUD   CRU       R                CRU
leads        CRUD   CRU       RU(仅自己)       -
sales_targets CRUD  R         R                -
profiles     CRUD   CRU       R                R
```

---

> **文档版本记录**
>
> | 版本 | 日期 | 修改人 | 修改内容 |
> |------|------|--------|---------|
> | v1.0 | 2026-06-03 | 架构总监 | 初始版本（含销售经理角色，6角色RLS） |
> | v2.0 | 2026-06-03 | 架构总监 | **重大重构**: 去掉销售经理(4角色RLS)、新增 contracts/installment_plans 表、合同驱动回款对账、统计视图与预警体系、电子合同存储 |

---

## 变更摘要 (v1.0 → v2.0)

| 领域 | v1.0 | v2.0 |
|------|------|------|
| **角色** | 6 角色 (admin/manager/senior_sales/sales/trainee/finance) | 4 角色 (admin/operator/sales/finance) |
| **核心表** | payments (独立分期字段), sales_targets | contracts + installment_plans (重构 payments 关联) |
| **回款模型** | 直接 payments.lead_id, 分期用 installment_seq 标记 | contracts → installment_plans → payments 三级关联 |
| **交付管理** | 无 | contracts.delivery_milestones JSONB |
| **电子合同** | 无 | Supabase Storage bucket 'contracts' + PDF 上传 |
| **统计视图** | v_sales_performance (仅管道+成交+基本回款) | v_contract_summary + v_sales_performance(v2) + v_delivery_status |
| **预警查询** | 逾期 pending 付款查询 | 逾期分期 + 超期交付 + 低回款率(三级预警: normal/warning/critical) |
| **RLS 复杂度** | 6角色 × 3表 ≈ 18条策略 | 4角色 × 4表 ≈ 24条策略 (更简单清晰) |
