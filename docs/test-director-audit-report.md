# 测试总监质量审查报告

> **审查人**: 测试总监
> **审查日期**: 2026-06-03
> **审查文件**:
> 1. `docs/newme-crm-data-model-design.md` — 架构总监
> 2. `docs/newme-crm-role-interfaces-design.md` — 产品总监
> 3. `supabase/migrations/20260605000000_newme_crm_v21_full.sql` — 实际迁移文件
> **审查方法**: 逐行交叉验证 + 执行可行性分析 + 边界条件测试

---

## 1. PASS/FAIL 清单

### 1.1 架构总监结论验证

| 结论 | 判定 | 证据 |
|------|------|------|
| B1: 表顺序为 BLOCKER | ✅ **CONFIRMED** | 迁移 SQL PART 3 中 activities 增加 `contract_id UUID REFERENCES contracts(id)`，但 contracts 表在 PART 7 才创建，PostgreSQL 不允许前向 FK 引用 |
| B2: 角色迁移为 BLOCKER | ✅ **CONFIRMED** | `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT` 顺序敏感，需确认 profiles 表已有数据时不会失败 |
| 5 个 WARNING | ⚠️ **部分遗漏**（见下方） | |
| 4 个 P0 安全缺口 | ❌ **仍存在** | 最严重：`SECURITY DEFINER` 触发器仍然存在于迁移 SQL 中（PART 17.2, line 594/1409），视图 RLS 旁路问题未修复 |
| 建议新增 5 个视图 | ❌ **未实现** | 迁移 SQL 中只有 2 个视图（v_sales_performance, v_contract_payment_overview），缺少销售专用去金额化视图 |
| Middleware 分权 | ❌ **未实现** | 迁移中无任何 middleware 层分权代码 |

### 1.2 产品总监结论验证

| 结论 | 判定 | 证据 |
|------|------|------|
| 砍 6 张表 | ⚠️ **正确方向但未明确列清单** | 产品说"推迟的6张"未在文档中列明表名。根据 Sprint 5-6 推测为: project_milestones, project_documents, project_inspections, delivery_plans, products, sales_targets |
| Activities 升格为地基 | ✅ **正确** | 迁移 SQL PART 3 对 activities 做了大幅增强，加了 contract/quotation/project 关联 |
| 砍 80% 触发器/RLS | ❌ **产品总监自己的建议也未完全执行** | 见下方"产品总监DDL修正未落地" |
| 三套角色界面 | ✅ **设计合理** | 角色矩阵清晰，噪音分析到位 |
| 销售看不到金额 | ❌ **RLS 层面未实现** | 迁移中 contracts RLS 对 sales 暴露全部字段（含 contract_amount），v_sales_performance 也暴露金额 |
| 先做销售→老板→运营 | ⚠️ **逻辑合理但有前置依赖** | 见"鸡和蛋"问题 |

---

## 2. 矛盾点清单

### 矛盾 1: boss 角色 — 产品说要，架构没做

**产品总监**（`newme-crm-role-interfaces-design.md` §6.1）:
> 当前角色枚举：'admin','sales','designer','operator','finance'
> 当前问题：老板 SAM 在系统中应有一个明确的角色，而不是用 admin 冒充

**迁移 SQL**（line 15）:
```sql
CHECK (role IN ('admin','sales','designer','operator','finance'));
```
**→ 没有 boss 角色**。产品总监的修正建议完全未落地。

**影响**: 老板 SAM 只能用 `admin` 角色登录。但 `admin` 拥有所有表的 ALL 权限（包括 INSERT/UPDATE/DELETE），而老板应该"只看不操作"。如果老板误操作，可能删数据。如果故意不给 admin，老板什么都看不到（RLS 拒绝）。

### 矛盾 2: 视图 RLS 旁路 — 架构审计说了但没修

**架构总监 RLS 审计结论**: 视图 RLS 旁路（security_definer）是 P0 安全缺口。

**迁移 SQL**（line 594, 1409）:
```sql
$$ LANGUAGE plpgsql SECURITY DEFINER;
```
**→ 仍然存在**。`log_contract_event()` 函数用 `SECURITY DEFINER` 执行，绕过当前用户的 RLS 权限。

此外，`v_sales_performance` 和 `v_contract_payment_overview` 是两个标准视图。标准视图的查询在执行时使用视图所有者（默认是创建者）的权限，**不经过底层表的 RLS**。这意味着：
- 一个 sales 用户如果无法直接 SELECT contracts 表中的金额，但可以 SELECT v_sales_performance 看到所有销售的合同金额
- 这与产品总监"销售看不到金额"的设计完全矛盾

### 矛盾 3: 产品说 RLS/simplify，架构留下了18组RLS+2个视图

**产品总监第一轮**: "砍80%触发器/RLS"

**迁移 SQL**: 18 组 RLS 策略 + 2 个 complex 视图（含多层 CTE）+ 3 个触发器

**影响**: 架构的 18 组 RLS 策略本身有内部矛盾。例如：
- `products` RLS: 任何认证用户可以用 ALL（可删产品）
- `sales_targets` RLS: 只有 `admin` 可以 ALL，但产品设计里老板应该能设置目标
- 部分表（leads, customers, activities, profiles, business_events）**完全没有 RLS 策略**

### 矛盾 4: 迁移顺序导致循环依赖

`activities` 表在 PART 3 被增强，添加了：
- `contract_id UUID REFERENCES contracts(id)` — contracts 在 PART 7 创建
- `quotation_id UUID REFERENCES quotations(id)` — quotations 在 PART 5 创建
- `project_id UUID REFERENCES projects(id)` — projects 在 PART 11 增强

**如果一次性执行整个迁移文件**，PART 3 会因 `contracts` 表不存在而失败。

**可能的绕过**: 有 `IF NOT EXISTS` 但 `REFERENCES contracts(id)` 仍然会触发"relation 'contracts' does not exist"错误。

### 矛盾 5: 数据模型 vs 实际迁移文件不一致

数据模型文档中的 DDL（§10）和实际迁移文件（20260605000000_newme_crm_v21_full.sql）有差异：

| 项目 | 数据模型文档 | 实际迁移文件 |
|------|-------------|-------------|
| 函数名 | `log_contract_event()` | `log_contract_status_event()` |
| 索引 | 有 `idx_leads_stage_amount` 等增强索引 | 缺少这些索引 |
| 函数返回 | `auto_detect_overdue()` 返回 void | `auto_detect_overdue_and_delays()` 返回 TABLE |
| RLS 策略名 | 略有不同命名 | 策略名不同 |

**影响**: 两个文件不同步。如果团队基于文档开发，拿到迁移文件会发现"货不对板"。

---

## 3. 遗漏点清单

### 3.1 RLS 覆盖缺失（严重）

以下现有表在迁移中**完全没有 RLS 策略更新**：

| 表名 | 迁移中的 RLS | 影响 |
|------|-------------|------|
| `leads` | ❌ 无 | 所有人可见所有线索（违背产品设计"销售仅见自己线索"） |
| `customers` | ❌ 无 | 所有人可见所有客户 |
| `activities` | ❌ 无 | 所有人可见所有活动记录 |
| `profiles` | ❌ 无 | 所有人可见所有用户信息 |
| `business_events` | ❌ 无 | 所有人可见所有审计日志 |

**产品总监的数据可见范围矩阵**要求对以上表做细粒度 RLS，但迁移中只对新表做了。这意味着即使新表 RLS 正确，通过旧表的数据泄露渠道仍然存在。

### 3.2 profiles 表为空 = 全局锁定（致命）

**当前状态**: profiles 表为空（任务书中明确指出）。

**RLS 策略全部依赖**:
```sql
EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator'))
```

**当 profiles 为空时**:
1. 任何用户登录后 `auth.uid()` 返回一个 UUID
2. 该 UUID 在 profiles 表中不存在
3. 所有 RLS 策略的 `EXISTS` 子查询返回 false
4. 所有 RLS 保护的表返回 0 条记录
5. **系统完全不可用** — 老板、销售、运营都看不到任何数据
6. 甚至连登录后的"我的信息"都看不到

**缺失**: 没有任何 bootstrap 机制来创建第一个用户 profile。需要有一个"首用户初始化"流程或者 RLS 策略包含对 profiles 表自身的特殊处理。

### 3.3 触发器写数据忽略 RLS（严重）

`update_installment_status()` 触发器在 `AFTER INSERT ON payments` 时执行，它会：
1. 更新 `installment_plans.paid_amount`
2. 更新 `installment_plans.status` 为 'paid'
3. 更新 `contracts.status` 为 'completed'

**问题**: 触发器在触发者权限（`SECURITY DEFINER`）下运行，会绕过 RLS。如果运营人员登记了一笔不属于她的合同的回款，触发器仍然会正确更新分期状态——但合同本身可能不是她该看到的。

**更严重的问题**: `trg_payment_after_insert` 的 WHEN 条件是：
```sql
WHEN (NEW.confirmed = true AND NEW.installment_plan_id IS NOT NULL)
```
如果 `confirmed = true` 是默认值（`DEFAULT true`），那么**每笔支付登记都会立即触发分期状态更新**，没有"待确认"的缓冲。

### 3.4 级联删除风险（中等）

以下外键使用 `ON DELETE CASCADE`：
- `quotations.lead_id → leads.id`
- `contracts.lead_id → leads.id`
- `installment_plans.contract_id → contracts.id`
- `payments.contract_id → contracts.id`
- `projects.contract_id → contracts.id`

**场景**: 如果某人（比如 admin）删除了一个 lead，将级联删除：
1. 该 lead 本身
2. 所有关联的 quotations
3. 所有关联的 contracts
4. 所有 contract 下的 installment_plans
5. 所有 contract 下的 payments
6. 所有关联的 projects（以及其 milestones, documents, inspections）

**这是灾难性的数据丢失**。至少应该用 `SET NULL` 或软删除。

### 3.5 并发写入问题（中等）

**场景 1**: 两个用户同时为同一个 installment_plan 登记付款。
- `update_installment_status()` 读取 `paid_amount`，计算，然后 UPDATE
- 没有 `SELECT ... FOR UPDATE` 锁定
- 可能两个事务都读到旧的 paid_amount，都 UPDATE，导致少算一笔

**场景 2**: 销售 Tanya 在移动端拖拽 Kanban 卡片推进阶段，同时老板 SAM 在后台查看同一线索的详情。
- 没有行级锁
- 乐观锁需要 `updated_at` 版本控制，但目前没有实现

### 3.6 NULL 值边界情况（多个）

| 字段 | 问题 |
|------|------|
| `quotations.valid_until DATE NOT NULL` | 如果报价 AI 生成时没有设置有效期，会报错 |
| `quotations.total_amount DECIMAL(12,2) NOT NULL` | 行项目为空时（空报价），total_amount 值为 0，但逻辑上"空报价"应该允许 |
| `contracts.contract_amount CHECK(amount > 0)` | 零金额合同不允许——但赠品/免费服务场景是否永远不需要？ |
| `payment_terms TEXT` | 通过 quotation 传给 contract 的支付条款没有保证 |
| `project_documents.file_url TEXT NOT NULL` | 必须先上传文件到 Storage 再创建记录，如果上传失败，`file_url` 为空导致 INSERT 失败 |

### 3.7 两个 Director 都没提到的问题

| 问题 | 严重程度 | 说明 |
|------|---------|------|
| 没有数据归档策略 | 低 | `business_events` 预计百万级/"500条/天"，无清理机制 |
| 没有全文搜索索引 | 中 | 客户搜索、合同搜索靠 `LIKE` 或模糊匹配，性能差 |
| `quote_no` 生成逻辑未实现 | 高 | 格式 'Q-YYYYMMDD-XXXX' 需要在应用层生成唯一编号，没有相关函数 |
| `contract_no` 生成逻辑未实现 | 高 | 同上 |
| `party_a_name TEXT NOT NULL` | 中 | 创建合同时必须有甲方名称，但如果是已有客户，应该从 customers 自动填充 |
| 没有软删除/恢复机制 | 中 | 一旦误删，数据无法恢复 |

---

## 4. 实际可用性分析

### 4.1 销售 Tanya 能用吗？—— ❌ **当前不能用**

**第一步操作**（假设 profiles 已有数据）：

1. **登录** → 登录成功（Auth 层面）
2. **打开"今日待办"** → 查询 `leads WHERE assigned_to = auth.uid()`
3. **问题 1**: `leads` 表没有 RLS 策略（迁移中没加），但旧系统可能有？如果旧 leads 有 RLS，它可能过滤正确也可能不匹配新角色定义
4. **问题 2**: 即使能查到 leads，`activities` 表也没有 RLS — 她可以看到所有人的活动记录（包括老板的备注、运营的内部记录）
5. **问题 3**: `customers` 没有 RLS — 她可以看到所有客户（包括别人的）
6. **问题 4**: 她想创建报价 → `quotations INSERT` → RLS 要求角色是 admin/operator → **她是 sales，被拒绝！**
7. **问题 5**: 她想标记成交 → `contracts INSERT` → 同样被 RLS 拒绝（sales 只能 SELECT）

**结论**: 销售 Tanya 只能"看"（如果旧 leads RLS 正确），**不能做任何写操作**。产品总监设计的"创建报价、推进阶段、标记成交"全部被 RLS 阻塞。

### 4.2 老板 SAM 能用吗？—— ❌ **当前不能用**

**第一步操作**：

1. **登录** → 登录成功
2. **打开 Dashboard** → 需要查询 `leads`, `contracts`, `payments`, `installment_plans`
3. **问题 1**: 老板角色是 `boss`，但 role CHECK 约束只允许 `admin/sales/designer/operator/finance`
4. **问题 2**: 即使强制设为 `admin`，也能看到数据——但 admin 有 ALL 权限，产品总监设计"只看不操作"
5. **问题 3**: `v_sales_performance` 视图没有 RLS — 任何能 SELECT 视图的人看到全部销售业绩

### 4.3 运营能用吗？—— ⚠️ **部分能用**

运营角色（`operator`）在 RLS 中定义为"可 ALL"的表：
- quotations ✅
- contracts ✅
- installment_plans ✅
- delivery_plans ✅
- payments ✅
- projects ✅
- project_* ✅

**但**：
- `customers` 没有 RLS → 运营可以看到但无法控制别人看到的
- `activities` 没有 RLS → 同上
- 运营不能设置 `sales_targets`（只有 admin 可以）
- 运营的待办工作台依赖 `payments WHERE confirmed = false`，但因为 `confirmed DEFAULT true`，新登记的支付默认是已确认的，待确认清单永远为空

### 4.4 "鸡和蛋"问题

| 场景 | 问题 | 解决方案缺失 |
|------|------|-------------|
| 需要 profiles 才能 RLS，但 RLS 允许谁创建 profile？ | profiles 表没有 RLS，但也没有 bootstrap 机制 | 没有首次管理员创建流程 |
| 需要 products 才能创建 quotation_items，但 products 还没导入 | `product_id` 是可选（可为 NULL），但产品库为空时报价行项目功能半残 | 迁移中只有建表，没有数据导入 SQL |
| 需要 contracts 才能创建 payments，但 contracts 怎么来？ | 产品设计"标记成交→创建合同"，但合同创建 INSERT 的 RLS 只允许 admin/operator | 销售不能创建合同，但成交流程需要合同 |
| 需要 customers 才能关联合同，但 customers 从哪里来？ | `customer_id` 可选（可为 NULL），但如果为空，合同没有客户名字 | 没有从 lead 自动创建 customer 的触发器 |

---

## 5. 产品总监 DDL 修正建议未落地清单

产品总监在 `newme-crm-role-interfaces-design.md` §6 中明确提出的修正，**全部未在迁移 SQL 中实现**：

| 修正项目 | 产品总监要求 | 迁移 SQL 状态 |
|---------|-------------|--------------|
| boss 角色 | 新增 'boss' 角色枚举 | ❌ 未实现 |
| 自动分配触发器 | 新线索自动分配给默认销售 | ❌ 未实现 |
| Boss RLS 策略 | leads/contracts/payments/installments/projects 的 boss SELECT 策略 | ❌ 未实现 |
| 销售专用业绩视图 | v_sales_personal_stats（无金额） | ❌ 未实现 |
| 销售合同视图 | v_sales_contracts（隐藏金额） | ❌ 未实现 |
| Dashboard 索引 | idx_leads_stage_amount, idx_contracts_date_amount 等 | ❌ 未实现 |
| 运营待办索引 | idx_payments_unconfirmed, idx_delivery_pending | ❌ 未实现 |

**这就是说**: 产品总监写的角色界面方案文档和实际迁移 SQL 之间，存在 7 个已知的、已被文档化的差距。

---

## 6. 最终建议

### 结论: ❌ **这个方案当前不能上线**

### 差什么才能上线？

#### P0 — 致命问题（必须修，否则不可用）

1. **bootstrap 机制缺失**: profiles 表为空时整个系统锁死。需要：
   - 首用户初始化 seed SQL（插入第一个 admin/boss/operator/sales）
   - 或 RLS 策略中对 profiles 表自身做豁免

2. **已有表 RLS 缺失**: leads, customers, activities, profiles, business_events 必须添加 RLS 策略。否则数据通过旧表泄露。

3. **迁移执行顺序**: PART 3 activities 的 FK 引用必须在 contracts/quotations/projects 创建之后，否则迁移脚本执行失败。

4. **视图 RLS 旁路**: `v_sales_performance` 暴露所有销售金额给任何能 SELECT 的用户。需要改为 `SECURITY BARRIER` 视图或限制视图的访问权限。

5. **销售写操作被 RLS 阻塞**: sales 角色在所有新表上只有 SELECT 权限。需要为 sales 添加:
   - `quotations INSERT`（创建报价）
   - `activities INSERT`（记录活动）
   - 但 `contracts` 和 `payments` 应该仍然只读给 sales（产品设计）

#### P1 — 严重问题（建议修，否则上线后出事故）

6. **级联删除风险**: `ON DELETE CASCADE` 链可能导致一次性删除整个客户的所有数据。建议改为 `ON DELETE SET NULL` + 软删除。

7. **产品总监 DDL 修正未落地**: 至少需要实现 boss RLS 策略和销售去金额化。当前迁移 SQL 与产品设计文档矛盾。

8. **两个文档不同步**: 数据模型文档（docs/newme-crm-data-model-design.md）和实际迁移 SQL 有不一致之处，需要对齐。

#### P2 — 应该修的问题

9. **并发写入保护**: `update_installment_status()` 需要 `SELECT ... FOR UPDATE` 锁

10. **confirmed = true 默认值**: 改为 `DEFAULT false`，支付登记后需要运营确认才能触发分期更新

11. **quote_no / contract_no 自动生成**: 需要 PostgreSQL 函数或序列

12. **NULL 值边界处理**: `valid_until NOT NULL`、`file_url NOT NULL` 等字段需要合理默认值或允许 NULL

### 修复优先级

```
立即
  ├── 1. profiles bootstrap SQL（插入首批用户）
  ├── 2. 修复迁移 SQL 执行顺序（PART 3 FK 移到后面）
  ├── 3. 为 leads/customers/activities/profiles/business_events 添加 RLS
  └── 4. 为 sales 角色添加必要的 INSERT 权限（quotations, activities）

紧急（上线前）
  ├── 5. 实现 boss RLS 策略（产品总监§6.3）
  ├── 6. 替换级联删除为 SET NULL
  ├── 7. 降低 v_sales_performance 视图权限或改为 security_barrier
  └── 8. confirmed 默认值改为 false

建议（Sprint 1-2 前）
  ├── 9. 对齐数据模型文档和迁移 SQL
  ├── 10. 添加 quote_no 自动生成函数
  └── 11. 添加并发写入保护
```

### 一个能上线的简化版本

对于只有 1 个老板 + 1 个销售 + 0 个运营的小团队，**当前架构过度设计了**。一个更务实的 MVP 方案：

1. **暂时不使用 RLS**（凭业务约束，团队信任）
2. **只建 6 张表**: leads, customers, products, quotations, quotation_items, contracts（+ activities 增强）
3. **延期**: installment_plans, payments, projects*, delivery_plans, sales_targets
4. **手动 bootstrap**: 直接在数据库中 INSERT 2 个 profile 记录
5. **销售用 1 个角色**: 跳过三层分权，先跑通核心流程

但这与当前设计文档的愿景不符。如果坚持现在这个复杂方案，**上述 P0 问题必须全部修复**。
