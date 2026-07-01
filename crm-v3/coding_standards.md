# NewMe CRM v3 — 编码规范（Phase 1）

> 产生时间: 2026-06-30
> 来源: MoA 4轮审计裁决结论 + 71个 migration 实际代码分析
> 适用范围: newme-platform 全部 CRM 模块

---

## 1. Migration 命名规范

### 格式
```
YYYYMMDDHHMMSS_描述.sql
```

### 时间戳
- `YYYYMMDD` = 创建日期（UTC）
- `HHMMSS` = 创建时间，同日多文件用递增序号区分
- 示例：`20260630143000_add_customer_avatar.sql`

### 描述命名
- 全小写，下划线分隔
- 动词开头：`create_`, `add_`, `fix_`, `drop_`, `alter_`, `rename_`
- 禁止无意义描述：`update.sql`, `fix2.sql`, `changes.sql`

### 已存在的反模式（不追溯修改，新增必须遵守）
| 反模式 | 示例 | 正确写法 |
|--------|------|---------|
| 无时间戳 | `1780601210_workflow_stages.sql` | `20260601000000_create_workflow_stages.sql` |
| 同日多文件无序号 | `20260623020000_crm_v3_new_tables.sql` + `20260623020000_crm_v3_rls_policies.sql` | `...001_crm_v3_new_tables.sql` + `...002_crm_v3_rls_policies.sql` |
| rollback 文件混入 | `rollback_crm_v3.sql` | 放 `supabase/rollbacks/` 目录 |

### Rollback 文件
- 统一放 `supabase/rollbacks/` 目录
- 命名：`rollback_YYYYMMDD_描述.sql`
- 禁止放 migrations/ 目录（会被 Supabase 自动执行）

---

## 2. P0/P1/P2 优先级分级标准

### P0 — 阻塞性/数据完整性
**定义**：不做会导致数据丢失、权限泄露、业务流程断裂
**处理**：立即修复，不走审批流程
**示例**：
- RLS 策略缺失（任何人可读写任何数据）
- 外键约束缺失（孤儿记录）
- 金额字段精度错误（报价/合同金额算错）
- auth 触发器失效（新用户无 profile）

### P1 — 功能性/业务必需
**定义**：不做会导致核心功能不可用，但不丢数据
**处理**：当日内完成，走标准 review
**示例**：
- 新建表（tasks, follow_up_logs, pipeline_stages）
- 前端页面缺失（Tasks 页 404）
- API 路由缺失（GET /api/tasks 返回 500）
- 字段缺失导致表单保存失败

### P2 — 优化/体验提升
**定义**：不做不影响核心流程，但影响用户体验或可维护性
**处理**：排入下一迭代
**示例**：
- 列表分页/排序优化
- 搜索建议/自动补全
- 报表图表美化
- 代码重构（无功能变化）

---

## 3. 硬规则清单（代码约束铁律）

### 🔴 R1 — profiles.email 必须 JOIN
```sql
-- ✅ 正确：从 auth.users 获取 email
SELECT p.*, u.email
FROM profiles p
JOIN auth.users u ON u.id = p.id;

-- ❌ 禁止：profiles 表不加 email 列
ALTER TABLE profiles ADD COLUMN email TEXT;  -- 禁止！
```
**原因**：email 是 auth 层管理的，profiles 冗余存储会导致双写不一致。

### 🔴 R2 — assigned_to 统一用 UUID 列
```sql
-- ✅ 正确：直接使用 UUID 引用 profiles
assigned_to UUID REFERENCES profiles(id)

-- ❌ 禁止：使用 text 类型或额外 _uuid 后缀列
assigned_to TEXT          -- 禁止！无法外键约束
assigned_to_uuid UUID     -- 禁止！冗余列，和 assigned_to 冲突
```
**原因**：已存在 `assigned_to_uuid` 遗留列，代码中统一用 `assigned_to`（UUID 类型），忽略 `_uuid` 后缀列。

### 🔴 R3 — 禁止臆造字段
- 新建 migration 中每个字段必须对应明确的业务需求
- 禁止"以防万一"加字段（如 `extra_data JSONB`, `metadata TEXT`）
- 如需 JSONB 扩展字段，必须说明具体用途和查询场景

### 🔴 R4 — 金额字段精度
```sql
-- ✅ 正确：NUMERIC(12,2) 或 INTEGER（分）
amount NUMERIC(12,2) NOT NULL DEFAULT 0
amount_cents INTEGER NOT NULL DEFAULT 0

-- ❌ 禁止：REAL/FLOAT（精度丢失）
amount REAL    -- 禁止！浮点精度问题
amount FLOAT   -- 禁止！
```

### 🔴 R5 — 时区统一 TIMESTAMPTZ
```sql
-- ✅ 正确
created_at TIMESTAMPTZ DEFAULT now()
due_at TIMESTAMPTZ

-- ❌ 禁止
created_at TIMESTAMP     -- 无时区，跨时区会乱
due_at DATE              -- 除非明确只需日期
```

### 🔴 R6 — 外键必须有 ON DELETE 行为
```sql
-- ✅ 正确：明确级联策略
lead_id UUID REFERENCES leads(id) ON DELETE CASCADE
customer_id UUID REFERENCES customers(id) ON DELETE SET NULL

-- ❌ 禁止：不写 ON DELETE（默认 RESTRICT，删不掉）
lead_id UUID REFERENCES leads(id)  -- 必须显式声明
```

### 🔴 R7 — 索引命名规范
```sql
-- ✅ 正确：idx_表名_列名
CREATE INDEX idx_leads_assigned_to ON leads(assigned_to);
CREATE INDEX idx_leads_stage ON leads(stage);

-- ❌ 禁止：无名索引或随意命名
CREATE INDEX ON leads(assigned_to);           -- 禁止！
CREATE INDEX my_index ON leads(assigned_to);  -- 禁止！
```

### 🔴 R8 — CC 子代理查询必须验证列
```bash
# CC 修改了任何 supabase 查询后 → commit 前必须：
# 1. 用 service_role key 查实际表结构
# 2. 对照代码中引用的列名逐一确认
# 3. 不存在 → 要么 migration，要么删引用
```
**原因**：2026-06-30 CC 编造了 `leads.product_id`、`leads.created_by`、`leads.poor_reason` 等列，导致生产崩溃两天。
详见 §3A。
```

### 🔴 R9 — 审核权责规范（永久固化）
所有 **代码 / 方案 / 文档 / 运维操作** 变更必须遵循 `crm-v3/rules/hermes-rules.md` 定义的流转链路：
- **调度** → **前置预检** → **CC** → **Codex 1 审** → **Hermes 2 审终审**
- Codex 1 审和 Hermes 2 审权责完全解耦，不重叠
- **强制前置预检**：CC 交付后必须先校验完整性 + 约束合规，未通过不打 Codex
- **§3A 强制门禁**：改动 Supabase 查询时必须用 service_role 验证列存在
- **运维操作边界**（hermes-rules.md §十）：🟢免审 / 🟡单审 / 🔴双审 三档分级 + OEEC 紧急例外
- **流程异常**：见 hermes-rules.md §九（1 审越界 / 漏判 / 跨会话等兜底）
- **模型可换**：规则只约束角色，不绑定具体 LLM 模型

**原因**：2026-07-01 沉淀 4 轮 MoA 实战（T1-T2 全收 + T3-4）形成正式规则。
**违反**：commit 被 pre-push hook 拦截。

---

## 3A. 数据库列验证规则（2026-07-01 CC 事故后立碑）

### 铁律
**任何 CC 子代理生成的 supabase 查询，commit 前必须验证其引用的列名在数据库实际存在。**

### 验证步骤
```bash
# 1. 查实际表结构（service_role key 确保看到完整 schema）
cd /home/ubuntu/newme-platform && export $(grep -v '^#' .env.local | xargs)
node -e "
const {createClient}=require('@supabase/supabase-js')
const s=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
s.from('表名').select('*').limit(1).then(r=>console.log(Object.keys(r.data[0]||{})))
"
# 2. 对照 CC 代码中引用的列名，确认每个都存在
# 3. 不存在 → 要么建列（做 migration），要么删引用
```

### 事故记录
- **日期**：2026-06-30 ~ 2026-07-01
- **影响**：leads/[id] 详情页崩溃两天，生产不可用
- **CC 编造的列**：`leads.product_id`、`leads.created_by`（当时不存在）、`leads.poor_reason`
- **根本原因**：CC 在 b6df025 commit 中修改了 leads/[id]/page.tsx 的 supabase 查询，引用了 3 个不存在的列名。Codex 审计只检查了 TypeScript 类型，未验证 DB schema。Hermes 二审被跳过。三层防线全破。
- **处罚**：此规则加入硬规则清单，违反 = commit 被拒

---

## 4. 表结构速查表

### profiles
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK → auth.users(id) CASCADE | init |
| role | TEXT | DEFAULT 'sales', CHECK(admin/boss/operator/sales/finance/designer) | init, role_immutable |
| full_name | TEXT | | init |
| phone | TEXT | | init |
| avatar_url | TEXT | | init |
| created_at | TIMESTAMPTZ | DEFAULT now() | init |
| updated_at | TIMESTAMPTZ | DEFAULT now() | init |
> ⚠️ email 不在 profiles 表，JOIN auth.users 获取

### leads
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK, DEFAULT gen_random_uuid() | init |
| source | TEXT | CHECK(meta_ads/whatsapp/website/offline/referral/other) | init |
| meta_click_id | TEXT | | init |
| meta_campaign | TEXT | | init |
| meta_ad_id | TEXT | | init |
| quality | TEXT | DEFAULT 'pending', CHECK(pending/valid/job_seeker/fake/duplicate) | init |
| stage | TEXT | DEFAULT 'new', CHECK(new/contacted/needs_analysis/quoted/negotiating/won/lost) | init, won_lost_migration |
| customer_name | TEXT | | init |
| phone | TEXT | | init |
| email | TEXT | | init |
| property_type | TEXT | | init |
| property_size_sqm | INTEGER | | init |
| location | TEXT | | init |
| budget_range | TEXT | | init |
| service_needs | TEXT[] | | init |
| ai_summary | TEXT | | init |
| ai_tags | TEXT[] | | init |
| ai_quality | TEXT | CHECK(hot/warm/cold) | init |
| assigned_to | UUID | → profiles(id) | init |
| converted_at | TIMESTAMPTZ | | init |
| lost_at | TIMESTAMPTZ | | init |
| lost_reason | TEXT | | init |
| created_at | TIMESTAMPTZ | DEFAULT now() | init |
| updated_at | TIMESTAMPTZ | DEFAULT now() | init |
| no_answer | BOOLEAN | DEFAULT false | add_no_answer_flag |
| follow_up_date | DATE | | add_followup_date_to_logs |
| created_by | UUID | → profiles(id) | leads_created_by |
| poor_quality | BOOLEAN | DEFAULT false | poor_lead |

### customers
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK, DEFAULT gen_random_uuid() | init |
| lead_id | UUID | → leads(id) | init |
| name | TEXT | NOT NULL | init |
| phone | TEXT | | init |
| email | TEXT | | init |

### contracts
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK, DEFAULT gen_random_uuid() | newme_crm_v22_complete |
| lead_id | UUID | → leads(id) ON DELETE SET NULL | newme_crm_v22_complete |
| quotation_id | UUID | → quotations(id) | newme_crm_v22_complete |
| customer_id | UUID | | newme_crm_v22_complete |
| sales_id | UUID | → profiles(id) | newme_crm_v22_complete |
| created_by | UUID | → profiles(id) | newme_crm_v22_complete |
| contract_no | TEXT | NOT NULL UNIQUE | newme_crm_v22_complete |
| contract_date | DATE | NOT NULL DEFAULT CURRENT_DATE | newme_crm_v22_complete |
| contract_amount | NUMERIC(12,2) | NOT NULL CHECK(contract_amount > 0) | newme_crm_v22_complete |
| currency | TEXT | DEFAULT 'AED' | newme_crm_v22_complete |
| party_a_name | TEXT | NOT NULL | newme_crm_v22_complete |
| party_a_contact | TEXT | | newme_crm_v22_complete |
| party_b_name | TEXT | NOT NULL DEFAULT 'NewMe Smart Home FZCO' | newme_crm_v22_complete |
| party_b_contact | TEXT | | newme_crm_v22_complete |
| file_url | TEXT | | newme_crm_v22_complete |
| file_metadata | JSONB | | newme_crm_v22_complete |
| status | TEXT | NOT NULL DEFAULT 'draft' CHECK(draft/active/completed/terminated) | newme_crm_v22_complete |
| approval_status | TEXT | DEFAULT 'none' CHECK(none/pending/approved/rejected) | newme_crm_v22_complete |
| notes | TEXT | | newme_crm_v22_complete |
| terminated_reason | TEXT | | newme_crm_v22_complete |
| terminated_at | TIMESTAMPTZ | | newme_crm_v22_complete |
| created_at | TIMESTAMPTZ | DEFAULT now() | newme_crm_v22_complete |
| updated_at | TIMESTAMPTZ | DEFAULT now() | newme_crm_v22_complete |

### tasks
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | crm_v3_new_tables |
| lead_id | UUID | → leads(id) CASCADE | crm_v3_new_tables |
| title | TEXT | NOT NULL | crm_v3_new_tables |
| description | TEXT | | crm_v3_new_tables |
| status | TEXT | DEFAULT 'pending', CHECK(pending/in_progress/done/cancelled) | crm_v3_new_tables |
| priority | TEXT | DEFAULT 'medium', CHECK(low/medium/high/urgent) | crm_v3_new_tables |
| assigned_to | UUID | → profiles(id) | crm_v3_new_tables |
| due_at | TIMESTAMPTZ | | crm_v3_new_tables, relax_tasks_due_check |
| completed_at | TIMESTAMPTZ | | crm_v3_new_tables |
| created_by | UUID | → profiles(id) | crm_v3_new_tables |
| created_at | TIMESTAMPTZ | DEFAULT now() | crm_v3_new_tables |
| updated_at | TIMESTAMPTZ | DEFAULT now() | crm_v3_new_tables |

### follow_up_logs
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | crm_v3_new_tables |
| lead_id | UUID | → leads(id) CASCADE | crm_v3_new_tables |
| type | TEXT | CHECK(call/visit/email/whatsapp/other) | crm_v3_new_tables |
| content | TEXT | NOT NULL | crm_v3_new_tables |
| next_action | TEXT | DEFAULT 'follow_up' | add_default_next_action |
| next_action_date | DATE | | crm_v3_new_tables |
| outcome | TEXT | | crm_v3_new_tables |
| follow_up_date | DATE | | add_followup_date_to_logs |
| created_by | UUID | → profiles(id) | crm_v3_new_tables |
| created_at | TIMESTAMPTZ | DEFAULT now() | crm_v3_new_tables |
| updated_at | TIMESTAMPTZ | DEFAULT now() | crm_v3_new_tables |

### pipeline_stages (lead_workflow_stages)
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | workflow_stages |
| name | TEXT | NOT NULL | workflow_stages |
| order_index | INTEGER | NOT NULL | workflow_stages, fix_milestone_order |
| is_terminal | BOOLEAN | DEFAULT false | workflow_stages |
| created_at | TIMESTAMPTZ | DEFAULT now() | workflow_stages |

### payments
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK, DEFAULT gen_random_uuid() | newme_crm_v22_complete |
| contract_id | UUID | → contracts(id) ON DELETE CASCADE | newme_crm_v22_complete |
| installment_plan_id | UUID | → installment_plans(id) | newme_crm_v22_complete |
| created_by | UUID | → profiles(id) | newme_crm_v22_complete |
| amount | NUMERIC(12,2) | NOT NULL CHECK(amount > 0) | newme_crm_v22_complete |
| currency | TEXT | DEFAULT 'AED' | newme_crm_v22_complete |
| payment_date | DATE | NOT NULL DEFAULT CURRENT_DATE | newme_crm_v22_complete |
| received_at | TIMESTAMPTZ | | newme_crm_v22_complete |
| payment_method | TEXT | CHECK(bank_transfer/cash/cheque/card/other) | newme_crm_v22_complete |
| reference_no | TEXT | | newme_crm_v22_complete |
| confirmed | BOOLEAN | DEFAULT false | newme_crm_v22_complete |
| confirmed_by | UUID | → profiles(id) | newme_crm_v22_complete |
| confirmed_at | TIMESTAMPTZ | | newme_crm_v22_complete |
| overpayment_action | TEXT | CHECK(refund/credit/adjust) | newme_crm_v22_complete |
| notes | TEXT | | newme_crm_v22_complete |
| created_at | TIMESTAMPTZ | DEFAULT now() | newme_crm_v22_complete |
| updated_at | TIMESTAMPTZ | DEFAULT now() | newme_crm_v22_complete |

### quotations
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | init |
| lead_id | UUID | → leads(id) | init |
| quote_number | TEXT | NOT NULL | init |
| total_amount | NUMERIC(12,2) | | init |
| status | TEXT | CHECK(draft/sent/accepted/rejected) | init |
| created_by | UUID | → profiles(id) | init |

### products
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | create_products |
| name | TEXT | NOT NULL | create_products |
| category | TEXT | | create_products |
| unit_price | NUMERIC(12,2) | NOT NULL | create_products |
| ac_brand | TEXT | | add_ac_brand_column |

### projects
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | init |
| lead_id | UUID | → leads(id) | init, fix_projects_lead_fk |
| name | TEXT | NOT NULL | init |
| status | TEXT | DEFAULT 'active' | init |

### activities
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | activity_tracking |
| lead_id | UUID | → leads(id) | activity_tracking |
| type | TEXT | | activity_tracking |
| description | TEXT | | activity_tracking |
| created_by | UUID | → profiles(id) | activity_tracking |
| created_at | TIMESTAMPTZ | DEFAULT now() | activity_tracking |

### notifications
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | create_notifications |
| user_id | UUID | → profiles(id) | create_notifications |
| type | TEXT | | create_notifications, add_notification_types |
| title | TEXT | | create_notifications |
| message | TEXT | | create_notifications |
| is_read | BOOLEAN | DEFAULT false | create_notifications |

### ad_spend
| 字段 | 类型 | 约束 | 来源 |
|------|------|------|------|
| id | UUID | PK | ad_spend |
| platform | TEXT | | ad_spend |
| amount | NUMERIC(12,2) | | ad_spend |
| spend_date | DATE | | ad_spend |

---

## 5. RLS 策略编写规范

### 基本原则
- 每张表必须 `ENABLE ROW LEVEL SECURITY`
- 所有策略必须显式声明 FOR SELECT / INSERT / UPDATE / DELETE
- 禁止 `FOR ALL`（不明确，难审计）

### 角色权限矩阵
| 角色 | 自身数据 | 团队数据 | 全局数据 | 系统配置 |
|------|---------|---------|---------|---------|
| admin | ✅ CRUD | ✅ CRUD | ✅ CRUD | ✅ CRUD |
| boss | ✅ CRUD | ✅ CRUD | ✅ CRUD | ✅ R |
| operator | ✅ CRU | ✅ CRU | ✅ R | ❌ |
| sales | ✅ CRU | ❌ | ❌ | ❌ |
| finance | ✅ CRU | ✅ R | ❌ | ❌ |
| designer | ✅ R | ❌ | ❌ | ❌ |

### 模板
```sql
-- 命名规范：policy_表名_操作_角色
CREATE POLICY policy_leads_select_all
  ON leads FOR SELECT
  USING (true);  -- 或按角色限制

CREATE POLICY policy_leads_insert_sales
  ON leads FOR INSERT
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY policy_leads_update_own
  ON leads FOR UPDATE
  USING (auth.uid() = assigned_to)
  WITH CHECK (auth.uid() = assigned_to);
```

### 审计日志
- `activities` 表记录所有关键操作
- `audit_logs` 表（如存在）记录系统级变更
- 禁止在业务表中用 trigger 自动写 audit（性能问题），改用应用层

---

## 6. 前端规范（补充）

### 路由跳转
```typescript
// ✅ 正确：window.location.href（建完立即可见）
window.location.href = '/leads/' + newId;

// ❌ 禁止：router.push（缓存导致看不到新数据）
router.push('/leads/' + newId);
```
> 来源：P0-2 Create Lead 修复经验

### 数据获取
- 使用 Supabase JS Client，禁止裸 fetch
- email 字段：前端 JOIN 获取，不存 profiles 表

### 表单状态
- Save / Saving / Saved / Error 四态
- 必须 toast 提示保存结果
- 刷新后数据持久（不丢表单）

---

_文档版本: v1.0 | 2026-06-30 | MoA 4轮审计产出_
