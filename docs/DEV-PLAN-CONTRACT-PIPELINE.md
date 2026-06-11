# 开发计划：合同→生产链 (基于现有资源与环境)

---

## 0. 现有资源清单

### 基础设施

| 资源 | 配置 | 备注 |
|------|------|------|
| 服务器 | 43.156.231.142, Ubuntu, 4C8G | 仅计算节点，cattle 模式 |
| Supabase | ref: vfopmpxlhwzpxqegayew | DB + Auth + RLS，数据持久化层 |
| COS | tanya-1420640156 (150 obj / 1157 MB) | 文件存储，contracts/ 前缀已建 |
| 域名 | app.newme.ae (Let's Encrypt SSL) | Next.js 生产站 |
| Git | GitHub newme-platform feat/crm-v2 | 源码版本控制 |
| Hermes cattle 备份 | COS _cattle/ (491 MB) | 全量灾备，一键恢复 |

### 现有代码资产

| 模块 | 文件 | 现状 |
|------|------|------|
| 合同创建 API | `src/app/api/contracts/route.ts` | ✅ 有，但跳过审批 |
| 催款 API | `src/app/api/contracts/[id]/remind-payment/route.ts` | ✅ 有，手动触发 |
| 回款仪表盘 API | `src/app/api/dashboard/payment-tracker/route.ts` | ✅ 有，数据源需扩展 |
| 通知引擎 | `src/lib/notifications.ts` + `src/lib/notify.ts` | ✅ 完整，16 种类型 |
| 通知分发 API | `src/app/api/notify/route.ts` | ✅ 完整 |
| KPI API | `src/app/api/kpi/targets/route.ts` | ✅ 有，缺 actual 计算 |
| Cron 引擎 | `src/app/api/cron/check-overdue-followups/route.ts` | ✅ 有，可复用模式 |
| COS 预签名 | `scripts/cos-presign.py` | ⚠️ 只支持 GET 下载 |
| COS 下载 API | `src/app/api/cos/download-url/route.ts` | ✅ 有，contracts/ 已在白名单 |
| 工作流推进 | `src/app/api/workflow/route.ts` | ✅ 有 lead_workflow_stages |
| Supabase Admin | `src/lib/supabase-admin.ts` | ✅ service_role 客户端 |
| 合同列表页 | `src/app/(dashboard)/contracts/page.tsx` | ✅ 有，需改造 |
| 合同创建页 | `src/app/(dashboard)/contracts/new/page.tsx` | ✅ 有，需改造 |
| 回款页 | `src/app/(dashboard)/payments/page.tsx` | ✅ 有，需改造 |
| 项目页 | `src/app/(dashboard)/projects/page.tsx` | ✅ 有，需改造 |
| 报价计算引擎 | `src/lib/quotation-engine.ts` | ✅ 完整，含 calculateQuotation() |
| 报价生成 API | `src/app/api/quotations/generate/route.ts` | ✅ 完整，生成报价+更新 lead stage |
| 报价计算 API | `src/app/api/quotations/calculate/route.ts` | ✅ 完整，实时计算不保存 |
| 报价导出 API | `src/app/api/quotations/export/route.ts` | ✅ 有 |
| 报价列表页 | `src/app/(dashboard)/quotes/quotes-client.tsx` | ✅ 完整，需改造（加生成合同按钮） |
| 报价向导 | `src/app/(dashboard)/quotes/quote-wizard.tsx` | ✅ 完整，5 步流程 |
| 报价详情弹窗 | `src/app/(dashboard)/quotes/quote-detail-dialog.tsx` | ✅ 完整，可复用 |

### 现有数据库表

| 表 | 状态 | 需改动 |
|----|------|--------|
| contracts | ✅ 有，含 approval_status(要删)、first_payment_status/due_date | 改 status CHECK 约束、删 approval_status |
| installment_plans | ✅ 有，含 paid_amount | 加 allocated_amount、改 status CHECK |
| payments | ✅ 有，含 installment_plan_id | 删 installment_plan_id 绑定、核销走 allocations |
| projects | ✅ 有，含 paid_amount | 无需改表，联动写 API 层 |
| quotations | ✅ 有，含 total_amount/discount_rate/devices_json | 加 contract_id、quotation_type 列；扩展 status CHECK 加 won/contract_created |
| notifications | ✅ 有 | 加 contract_rejected 类型 |
| kpi_targets | ✅ 有 | 加 actual_amount 冗余字段 |

### 不存在的（需新建）

| 类型 | 名称 | 说明 |
|------|------|------|
| 表 | contract_approvals | 审批流水 |
| 表 | payment_allocations | 核销流水 |
| API | `/api/contracts/[id]/approve` | 审批动作 |
| API | `/api/contracts/[id]/upload-url` | 签发 PUT 预签名 |
| API | `/api/contracts/[id]/confirm-upload` | 确认上传完成 |
| API | `/api/contracts/[id]/revoke` | 发起变更 |
| API | `/api/payments` POST | 录入回款 |
| API | `/api/payments` GET | 回款列表 |
| API | `/api/payments/[id]/allocate` | 核销分配 |
| API | `/api/payments/[id]/confirm` | 确认回款（RPC） |
| API | `/api/projects/[id]/phase` PATCH | 推进项目阶段 |
| API | `/api/cron/check-overdue-installments` | 逾期分期扫描 |
| RPC | confirm_payment() | 事务：确认+联动 |
| RPC | approve_contract() | 事务：审批+通知 |
| RPC | allocate_payment() | 事务：核销+状态更新 |
| 脚本 | cos-presign.py 扩展 PUT | 生成上传预签名 |
| 页面 | `/contracts/[id]` | 合同详情 |
| 组件 | PaymentDialog | 回款录入弹窗 |
| 组件 | ApprovalTimeline | 审批时间线 |

---

## 1. Phase 分解

### Phase 1 — 数据基础（SQL + RPC + COS 脚本）

**目标：** 数据库 schema 改造完成，3 个 RPC 函数部署，COS 上传预签名可用。

**Task 1.1: SQL Migration**
```
文件: supabase/migrations/20260612000000_contract_pipeline_v1.sql

1. contracts 表改造:
   - 删除 approval_status 列
   - 修改 status CHECK: draft, pending_admin, pending_ceo, approved, active, revoking, superseded, suspended, completed, terminated
   - 加 sealed_file_url TEXT
   - 加 sealed_file_metadata JSONB
   - 加 quotation_id UUID REFERENCES quotations(id)（已存在确认）

2. 新建 contract_approvals 表:
   - id, tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', contract_id FK, step(admin_review/ceo_review), approver_id FK, status(pending/approved/rejected), notes, reviewed_at, created_at
   - INDEX: contract_id, tenant_id
   - 不写 RLS Policy（应用层权限控制，Axon 蒸馏时统一加）

3. 新建 payment_allocations 表:
   - id, tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000', payment_id FK, plan_id FK(installment_plans), amount_allocated, allocated_by FK, created_at
   - CHECK: amount_allocated > 0
   - INDEX: payment_id, plan_id, tenant_id
   - 不写 RLS Policy（应用层权限控制，Axon 蒸馏时统一加）

4. installment_plans 改造:
   - 加 allocated_amount DECIMAL(12,2) DEFAULT 0
   - 修改 status CHECK: pending, partial, paid, overdue, cancelled

5. payments 表改造:
   - 删除 installment_plan_id（核销走 allocations）

6. kpi_targets 改造:
   - 加 actual_amount DECIMAL(12,2) DEFAULT 0

7. notifications 类型扩展:
   - contract_rejected, contract_superseded
```

**Task 1.2: RPC 函数**
```
文件: supabase/migrations/20260612000001_rpc_functions.sql

1. confirm_payment(p_payment_id UUID, p_confirmer_id UUID)
   BEGIN;
     UPDATE payments SET confirmed=true, confirmed_by, confirmed_at
     FOR each allocation WHERE payment_id:
       SUM allocated → UPDATE installment_plans.allocated_amount
       重算 plan status (paid if allocated_amount >= amount, partial if > 0, overdue check)
     IF plan.seq = 1 → UPDATE contracts.first_payment_status
     SUM all allocations for contract → UPDATE projects.paid_amount
     累加 kpi_targets.actual_amount (WHERE period = current month AND assigned_to = contract.sales_id)
   COMMIT;

2. approve_contract(p_contract_id UUID, p_approver_id UUID, p_action TEXT, p_notes TEXT)
   BEGIN;
     INSERT contract_approvals
     UPDATE contracts.status:
       IF admin 审批 + action=approve → pending_ceo
       IF admin 审批 + action=approve + 校验全绿 → approved (可选直通)
       IF ceo 审批 + action=approve → approved
       IF action=reject → rejected → 回退到 draft
   COMMIT;

3. allocate_payment(p_payment_id UUID, p_allocations JSONB, p_allocated_by UUID)
   BEGIN;
     校验 SUM(allocations.amount) ≤ payment.amount
     INSERT payment_allocations (多条)
     FOR each affected plan:
       重算 allocated_amount (SUM allocations)
       重算 status
   COMMIT;
```

**Task 1.3: cos-presign.py 扩展**
```
文件: scripts/cos-presign.py

扩展支持 --method PUT 参数:
  当 method=PUT 时，签名 http_string 用 PUT 而非 GET
  Content-Type: application/octet-stream
  用于前端直传 COS
```

**验收标准 Phase 1：**
- [ ] Migration 在 Supabase 上执行成功（通过 Mgmt API 或 dashboard）
- [ ] 新表包含 `tenant_id` 字段，DEFAULT 为零 UUID
- [ ] RPC 函数可被 service_role 调用
- [ ] cos-presign.py --method PUT 能生成有效上传 URL

---

### Phase 2 — 审批流（API + 前端）

**目标：** 合同创建走 draft → 审批 → approved → active 完整链路。

**Task 2.1: 改造 POST /api/contracts**
```
文件: src/app/api/contracts/route.ts

改造点:
1. status 默认 "draft"（不再 "active"）
2. 新增校验函数 validateContract(contract):
   - 关联 quotation_id，算折扣率、首付比例、金额偏差
   - 返回 { warnings: [], errors: [], greenLights: [] }
3. 校验结果存入 contract_approvals.notes (JSON)
4. 创建时自动写 contract_approvals (step=admin_review, status=pending)
5. 通知 admin "新合同待审批"
```

**Task 2.2: 新建 POST /api/contracts/[id]/approve**
```
文件: src/app/api/contracts/[id]/approve/route.ts

Zod Schema:
  action: z.enum(["approve", "reject"])
  notes: z.string().optional()
  force_approve: z.boolean().optional() // admin 直通到 approved

权限:
  admin → 可审批 step=admin_review
  boss → 可审批 step=ceo_review
  
逻辑:
  调用 RPC approve_contract()
  通知相关人员
```

**Task 2.3: 改造 /contracts 列表页**
```
文件: src/app/(dashboard)/contracts/page.tsx

改造点:
1. 新增 Tab: 全部 | 待我审批 | 生效中 | 已暂停
2. Admin/Boss 看到审批操作按钮
3. Sales 看到状态标签（待审批/已生效/被驳回）
4. 被驳回的合同有"修改重提交"按钮
```

**Task 2.4: 改造 /contracts/new 页面**
```
文件: src/app/(dashboard)/contracts/new/page.tsx

改造点:
1. 提交后提示"已提交审批"而非"已创建"
2. 增加合同文件上传区域（直传 COS）
3. 上传流: 选文件 → 调 upload-url API → PUT 到 COS → 确认
```

**Task 2.5: 新建 /contracts/[id] 详情页**
```
文件: src/app/(dashboard)/contracts/[id]/page.tsx

内容:
1. 合同基本信息（金额、甲乙方、日期、状态）
2. 审批时间线（谁审的、什么时候、通过/驳回、意见）
3. 分期列表（每期金额、到期日、状态、已核销额）
4. 回款记录列表
5. 文件区域（draft 版本预览、sealed 版本预览）
6. 操作按钮（审批/驳回/修改/上传盖章版）
```

**验收标准 Phase 2：**
- [ ] Sales 创建合同后 status=draft，不直接 active
- [ ] Admin 在列表页看到待审批合同，点击可审批/驳回
- [ ] CEO 审批后合同变 approved → active
- [ ] 驳回后 Sales 收到通知，可修改重提交
- [ ] 校验结果（折扣率、首付比例）在审批页可见

---

### Phase 3 — 回款（API + 前端）

**目标：** 回款录入 → 核销 → 确认 → 自动联动完整链路。

**Task 3.1: 新建 POST /api/payments + GET /api/payments**
```
文件: src/app/api/payments/route.ts

POST (录入回款):
  Zod: { contract_id, amount > 0, payment_method, reference_no?, payment_date }
  payments.confirmed = false
  通知 admin/boss "待确认回款"

GET (回款列表):
  Admin/Boss: 全部
  Sales: 只看自己合同的
  支持筛选: confirmed/unconfirmed, contract_id, date range
```

**Task 3.2: 新建 POST /api/payments/[id]/allocate**
```
文件: src/app/api/payments/[id]/allocate/route.ts

Zod: { allocations: [{ plan_id, amount_allocated }] }
校验: SUM(amount_allocated) ≤ payment.amount
调用 RPC allocate_payment()
```

**Task 3.3: 新建 POST /api/payments/[id]/confirm**
```
文件: src/app/api/payments/[id]/confirm/route.ts

权限: admin/boss
调用 RPC confirm_payment() — 事务保护
前端无需手动触发核销联动，RPC 内自动完成全链路
```

**Task 3.4: 回款录入弹窗组件**
```
文件: src/components/PaymentDialog.tsx

交互:
1. 输入回款总额、付款方式、参考号
2. 显示该合同的分期列表
3. 自动建议分配（逾期优先 → 最近到期）
4. 可手动调整每期分配额
5. 实时显示 "已分配 / 总额" 进度
6. 提交: POST /api/payments + POST /api/payments/[id]/allocate
```

**Task 3.5: 回款确认队列**
```
在 CEO 驾驶舱 (/dashboard) 内新增区块:
- 待确认回款列表（payment_date, amount, method, sales_name, contract_no）
- 逐条确认 / 批量确认按钮
- 确认后调用 POST /api/payments/[id]/confirm
```

**验收标准 Phase 3：**
- [ ] Sales 可录入回款，系统写入 payments + payment_allocations
- [ ] 一笔 10 万回款可拆分核销到 3 期（如 3万+5万+2万）
- [ ] Admin 确认回款后，installment_plans.status 自动变为 paid/partial
- [ ] 确认后 contracts.first_payment_status 自动更新
- [ ] 确认后 projects.paid_amount 自动累加
- [ ] RPC 中任何一步失败全部回滚（模拟测试）

---

### Phase 4 — 自动化 + 联动

**Task 4.1: Cron 逾期分期扫描**
```
文件: src/app/api/cron/check-overdue-installments/route.ts

模式: 复用 check-overdue-followups 的 cron 模式
逻辑:
  1. 查 installment_plans WHERE status IN ('pending','partial') AND due_date < today
  2. 更新 status = 'overdue'
  3. 通知逻辑（按逾期天数分级）
  4. 逾期 > 30 天 → contract.status = 'suspended'
```

**Task 4.2: 项目阶段 → 分期联动**
```
文件: src/app/api/projects/[id]/phase/route.ts

PATCH:
  权限: admin/boss
  逻辑:
    procurement → installment_plans[1].due_date = today
    handover → installment_plans[last].due_date = today
    同时检查是否已有 due_date，避免覆盖已设日期
```

**Task 4.3: KPI actual 累加**
```
在 confirm_payment RPC 内:
  累加 kpi_targets.actual_amount
  WHERE period = date_trunc('month', CURRENT_DATE)
    AND assigned_to = contract.sales_id
    AND target_type = 'collection'
```

**验收标准 Phase 4：**
- [ ] Cron 手动触发后，逾期分期 status 更新为 overdue
- [ ] 逾期通知正确发送给 Sales 和 Boss
- [ ] 项目阶段推进到 procurement 后，第 2 期 due_date 自动更新
- [ ] KPI 看板显示 actual 值

---

### Phase 5 — 文件上传

**Task 5.1: 上传预签名 API**
```
文件: src/app/api/contracts/[id]/upload-url/route.ts

POST:
  Zod: { filename: string, version: z.enum(["draft", "sealed"]) }
  生成 COS key: contracts/{contract_id}/{version}_{filename}
  调用 cos-presign.py --method PUT 生成预签名 URL
  返回 { url, key }

权限: sales(draft), admin/boss(sealed)
```

**Task 5.2: 上传确认 API**
```
文件: src/app/api/contracts/[id]/confirm-upload/route.ts

POST:
  Zod: { key: string, version: z.enum(["draft", "sealed"]) }
  根据 version 更新 file_url 或 sealed_file_url
  更新 file_metadata 或 sealed_file_metadata (original_name, size, uploaded_by, uploaded_at, version)
```

**Task 5.3: 前端文件上传区域**
```
在 /contracts/[id] 页面和 /contracts/new 页面中:

1. 拖拽上传区域
2. 选文件 → POST /api/contracts/[id]/upload-url → 拿到预签名 URL
3. PUT 直传 COS (不经过 Next.js)
4. POST /api/contracts/[id]/confirm-upload → 更新合同记录
5. 显示已上传文件列表，可预览/下载
```

**验收标准 Phase 5：**
- [ ] Sales 可上传 draft 版合同文件（PDF/图片）
- [ ] Admin 可上传 sealed 版合同文件
- [ ] 文件不过境 Next.js 服务器（直传 COS）
- [ ] 合同详情页可预览/下载已上传文件

### Phase 6 — 报价→合同衔接

**目标：** 报价 `accepted` 后一键生成合同，消除手动重复录入，数据自动流转。

**Task 6.1: quotations 表变更**
```
文件: supabase/migrations/20260612000002_quotation_contract_bridge.sql

1. quotations 表新增列:
   - contract_id UUID REFERENCES contracts(id) — 标记已转换的报价
   - quotation_type TEXT DEFAULT 'standard' CHECK (quotation_type IN ('standard', 'change_order', 'supplementary'))

2. quotations 表扩展 status CHECK:
   - 新增 'won', 'contract_created' 两个状态

3. leads.stage 新增值:
   - 'contract_pending'（报价转合同后 lead 阶段推进）
```

**Task 6.2: 新建 POST /api/quotations/[id]/convert-to-contract**
```
文件: src/app/api/quotations/[id]/convert-to-contract/route.ts

Zod Schema:
  installments: z.array(z.object({
    seq: z.number().int().min(1),
    amount: z.number().positive(),
    due_date: z.string(),
    description: z.string().optional(),
  })).min(1),
  party_a_name: z.string().optional(),
  party_a_contact: z.string().optional(),
  party_b_name: z.string().optional(),
  first_payment_due_date: z.string().optional(),

权限: sales/admin/boss

事务流程（原子）:
  1. FETCH quotation WHERE id = [id] AND status IN ('accepted', 'won')
  2. 验证 quotation.contract_id IS NULL（未转换过）
  3. FETCH lead (customer_name, phone) via quotation.lead_id
  4. INSERT contracts:
     - lead_id = quotation.lead_id
     - sales_id = quotation.created_by
     - contract_amount = quotation.total_amount
     - currency = quotation.currency
     - status = 'draft'
     - party_a_name = body.party_a_name || lead.customer_name
     - party_a_contact = body.party_a_contact || lead.phone
     - party_b_name = body.party_b_name || 'NewMe Smart Home FZCO'
  5. INSERT installment_plans（关联新合同）
  6. INSERT contract_approvals (step=admin_review, status=pending)
  7. UPDATE quotations SET status='contract_created', contract_id=新合同id
  8. INSERT activities (type='contract_created')
  9. UPDATE leads SET stage='contract_pending'

步骤 2-9 任一失败全部回滚（Supabase RPC 或 API 层事务）。
```

**Task 6.3: 改造 /quotes 列表页**
```
文件: src/app/(dashboard)/quotes/quotes-client.tsx

改造点:
1. STATUS_STYLES 新增 won 和 contract_created 的样式
2. accepted 状态的报价卡片新增「生成合同」按钮
3. contract_created 状态的报价卡片显示关联合同编号（可点击跳转）
4. 按钮点击打开 ConvertToContractDialog
```

**Task 6.4: 新建 ConvertToContractDialog 组件**
```
文件: src/components/ConvertToContractDialog.tsx

内容:
1. 报价摘要区（只读）: 报价编号、金额、设备清单、折扣率
2. 分期方案表单: 动态添加分期行（seq/amount/due_date/description）
3. 甲乙方信息: 预填可改（甲方从 lead 读，乙方默认 NewMe）
4. 首期到期日选择器
5. 提交 → POST /api/quotations/[id]/convert-to-contract
6. 成功后跳转 /contracts/[new_id]
```

**Task 6.5: 改造 /contracts/[id] 详情页**
```
文件: src/app/(dashboard)/contracts/[id]/page.tsx（Phase 2 Task 2.5 的新建文件）

新增「来源报价」区域:
1. 查询 quotations WHERE contract_id = contract.id
2. 显示: 报价编号、报价金额、设备清单摘要、折扣率、报价日期
3. 点击报价编号弹出 QuotationSummaryDialog（复用 quote-detail-dialog）
```

**验收标准 Phase 6：**
- [ ] accepted 报价点击「生成合同」→ 弹窗显示报价摘要 + 分期表单
- [ ] 提交后合同创建成功，status=draft，自动进入审批流
- [ ] 报价状态变为 contract_created，contract_id 正确关联
- [ ] 合同详情页显示来源报价信息
- [ ] lead stage 推进到 contract_pending
- [ ] 已转换的报价不可再次转换（contract_id 非空时按钮禁用）

---

## 2. 执行约束（工业化规程）

### 2.1 契约先行

编写任何 API 路由前，必须先输出：
1. Zod Schema（入参校验）
2. RPC 调用点（事务边界）
3. 异常处理逻辑（DB 断开 / COS 报错 / 状态冲突）

### 2.2 禁止省略

交付代码中不得出现：
- `// TODO: ...`
- `// 逻辑同上省略`
- `/* 其余部分保持不变 */`

所有核心路由输出 100% 完整代码。

### 2.3 测试伴随

每完成一个 API 路由，附带 curl 测试组：
- 1 次成功用例
- 3 次边界失败用例（权限不足、金额负数、状态冲突）

### 2.4 并行执行策略

Phase 1（数据基础）是所有轨道的前置依赖，必须先完成。之后拆为 4 条并行轨道：

```
Phase 1 ─┬─ Track A: Phase 2 (审批流)
          ├─ Track B: Phase 3 (回款)
          ├─ Track C: Phase 5 (文件上传)
          └─ Track D: Phase 6 (报价→合同衔接)

Track A/B/C/D 之间无数据依赖，可并行开发。
Phase 4 (自动化+联动) 依赖 Track A + Track B 完成后串行执行。
```

**并行约束：**
- 每条 Track 内部仍是单点推进（Task 完成验证后再进下一个）
- 跨 Track 不共享前端组件文件（避免合并冲突）
- 合同详情页（`/contracts/[id]`）由 Track A 创建骨架，Track B/C/D 各自添加区域

### 2.5 依赖关系 DAG

```
Phase 1 (SQL+RPC+COS)
    ├── Phase 2 (审批流) ─────────┐
    ├── Phase 3 (回款) ───────────┤── Phase 4 (自动化联动)
    ├── Phase 5 (文件上传) ────────┘
    └── Phase 6 (报价→合同衔接) ─── Phase 4 (KPI 累加部分)
```

---

## 3. 时间估算

| Phase | Tasks | 串行预估 | 并行后实际等待 |
|-------|-------|---------|-------------|
| Phase 1 — 数据基础 | 1.1 + 1.2 + 1.3 | 2h | 2h（前置，不可并行） |
| Phase 2 — 审批流 | 2.1 - 2.5 | 4h | 4h（Track A） |
| Phase 3 — 回款 | 3.1 - 3.5 | 3h | 0h（Track B，与 A 并行） |
| Phase 5 — 文件 | 5.1 - 5.3 | 2h | 0h（Track C，与 A 并行） |
| Phase 6 — 报价衔接 | 6.1 - 6.5 | 3h | 0h（Track D，与 A 并行） |
| Phase 4 — 自动化 | 4.1 - 4.3 | 2h | 2h（A+B 完成后） |
| **总计** | | **~16h** | **~8h 等待时间** |

> 并行执行时实际耗时取决于最长的 Track（Phase 2 审批流 4h）+ Phase 1（2h）+ Phase 4（2h）= **~8h**。

---

## 4. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| Supabase Mgmt API 无法执行 migration | 中 | 手动在 Supabase Dashboard SQL Editor 执行 |
| COS PUT 预签名签名算法不兼容 | 低 | cos-presign.py 已有 GET 签名基础，PUT 只改 HTTP method |
| RPC 函数权限问题 | 中 | 用 SECURITY DEFINER + service_role 调用 |
| 前端直传 COS CORS | 中 | 需确认 COS bucket CORS 配置允许 PUT |
| 现有合同数据迁移 | 低 | 当前只有 2 条测试合同，无需数据迁移脚本 |
| Axon 蒸馏时 RLS 改造 | 低 | 所有新表已预留 tenant_id 字段，Axon 蒸馏时统一加 RLS Policy + 连接级 tenant context，预估 1 天 |
