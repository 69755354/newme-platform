# PRD: 合同→生产链线上化 (Contract-to-Production Pipeline)

> 目标：将合同创建、审批、签约、回款、催收全流程从线下搬到 CRM，实现数据闭环。
> 规模：2 个销售、1 个行政、1 个 CEO。不是银行核心系统，但必须是正确的系统。

---

## 1. 现状问题

### 1.1 合同创建跳过审批

`POST /api/contracts` 硬编码 `status: "active"`, `approval_status: "none"`。销售创建即生效，无任何人审批过。

### 1.2 合同文件无上传入口

`contracts.file_url` 和 `file_metadata` 字段已存在但永远为 null。无上传 API、无前端入口。纸质合同线下签，系统里是空壳。

### 1.3 回款表空壳

`payments` 表有结构但无录入页面、无确认流程、无核销逻辑。`installment_plans` 逾期无自动动作。Tanya 靠脑子记催款。

### 1.4 KPI 不挂钩实际数据

`kpi_targets` 有 6 条记录但 `assigned_to` 全 null。目标无法归到具体人，无法算完成率。

### 1.5 项目阶段不驱动分期

`projects.phase`（design → procurement → installation → commissioning → handover → warranty）与 `installment_plans.due_date` 无联动。设备到了不知道该收二期款。

### 1.6 状态机冲突

`contracts.status`（draft/active/completed/terminated）与 `contracts.approval_status`（none/pending/approved/rejected）双字段独立管理，极易不同步。合同生效后需要变更时无回滚路径。

---

## 2. 目标用户与角色

| 角色 | 人物 | 在合同流程中的职责 |
|------|------|-------------------|
| Sales | Mohamed / Faheem | 创建合同、上传草稿版、录入回款、分配核销 |
| Admin | Ayana | 行政审批、上传盖章版、确认回款 |
| Boss | Tanya | CEO 审批、确认回款、查看 KPI 和回款仪表盘 |

---

## 3. 产品设计

### 3.1 审批流

**状态机（单字段 `contracts.status`）：**

```
draft → pending_admin → pending_ceo → approved → active
            ↓              ↓            ↓
        rejected      rejected     superseded
active → revoking → draft（重新走审批）
active → suspended（逾期 >30 天，cron 自动）
active → completed（全部回款 + 交付完成）
```

**删除 `approval_status` 字段**，用 `status` 单字段承载完整生命周期。

**审批规则（写在校验函数，不写 DB trigger）：**

| 校验项 | 阈值 | 绿灯 | 红灯 |
|--------|------|------|------|
| 折扣率 | (quotation.total - contract.amount) / quotation.total | ≤ 15% | > 15% → 强制 CEO 审批 |
| 首付比例 | installment_plans[0].amount / contract.amount | ≥ 40% | < 30% → 强制 CEO 审批 |
| 合同金额 vs 报价 | contract.amount vs quotation.total_amount | 偏差 < 5% | 偏差 > 20% → 红色警告 |

全绿灯时 admin 审批后可选择直通 `approved` 或推给 CEO。有红色警告时必须推给 CEO。

**审批交互：**

- Admin 视角：`/contracts` 页面新增 "待我审批" Tab，看到合同卡片含自动校验结果（折扣率、首付比例、金额对比），通过/驳回按钮，需写审批意见
- CEO 视角：`/contracts` 页面新增 "待CEO审批" Tab，看到行政已审的合同 + 行政审批意见 + 系统校验结果，通过/驳回
- Sales 视角：提交后合同卡片显示 "待行政审批"，被驳回时收到通知并看到驳回原因，可修改重新提交

**变更流程：**

合同 `active` 后如需变更（加设备、改金额）：
1. Sales 发起 `revoke` → status 变为 `revoking`
2. 修改合同内容 → status 回到 `draft`
3. 重新走完整审批流
4. 原合同被标记 `superseded`，新合同替代

### 3.2 合同文件管理

**两个上传时机：**

1. **创建合同时** — Sales 上传草稿版（合同 PDF/照片）
2. **审批通过后** — Admin 上传盖章版（替换草稿版）

**上传方式（前端直传 COS，不过境 Next.js 服务器）：**

```
前端 → POST /api/contracts/[id]/upload-url → 获取 COS PUT 预签名 URL
前端 → PUT 直传 COS
前端 → POST /api/contracts/[id]/confirm-upload → 更新 file_url
```

**存储路径：**
```
COS bucket: tanya-1420640156
contracts/{contract_id}/draft_{filename}   — 销售上传，可替换
contracts/{contract_id}/sealed_{filename}  — 行政上传，不可替换只能追加
```

**下载：** 复用现有 `/api/cos/download-url`（`contracts/` 前缀已在白名单）。

**权限：**
- Sales：上传/替换 draft 版本
- Admin/Boss：上传 sealed 版本，下载全部版本

### 3.3 回款录入 + 核销 + 确认

**核销模型（解决一笔回款跨多期问题）：**

引入 `payment_allocations` 核销流水表。Payment 与 InstallmentPlan 解耦为多对多关系：
- 一笔 payment 可拆分核销到多期
- 一期可收多笔 payment

**Sales 录入回款：**

`/contracts/[id]` 合同详情页 → 分期列表每行有 "录入回款" 按钮 → 弹窗：
1. 输入回款总额、付款方式（bank_transfer/cash/cheque/card/other）、参考号
2. 系统自动建议分配：按逾期优先 → 最近到期优先 → 顺位填充
3. Sales 可手动调整每期分配额
4. 提交：payment 写入（confirmed=false）+ payment_allocations 写入
5. 通知 Admin/Boss "待确认回款"

**Admin/Boss 确认回款：**

CEO 驾驶舱内 → 待确认回款列表 → 看到回款详情（金额、方式、参考号、分配明细）：
- 确认触发 RPC 事务（见 3.6）
- 批量确认支持

**确认后自动联动：**
- installment_plans.allocated_amount 累加
- installment_plans.status 重算（pending → partial → paid）
- contracts.first_payment_status 更新（首期相关）
- projects.paid_amount 累加
- activities 写入 "收到第 N 期款 AED XXX"
- 通知 Sales "回款已确认"

### 3.4 自动催收

**Cron 任务 `/api/cron/check-overdue-installments`：**

每日 09:00 Dubai 时间触发：

| 逾期天数 | 动作 |
|----------|------|
| 逾期 1-2 天 | 通知 Sales "XX 合同第 N 期已逾期" |
| 逾期 3-7 天 | 通知 Sales + Boss |
| 逾期 > 7 天 | 合同标红 + installment_plans.status = overdue |
| 逾期 > 30 天 | contract.status = suspended |

同时扫描当日到期但未付的 installment_plans，更新 status = overdue。

### 3.5 项目阶段 → 分期联动

当项目阶段推进时自动触发对应分期到期：

| 项目阶段变化 | 分期联动 |
|-------------|---------|
| → procurement | installment_plans[1]（第 2 期）due_date = today |
| → handover | installment_plans[last]（尾期）due_date = today |

在 `/api/projects/[id]/phase` API 中实现，不用 DB trigger。

### 3.6 KPI 自动关联

**改造 `/api/kpi/targets` GET：**

返回数据增加 `actual` 和 `completion_rate` 字段：
- `signing` 类型：SUM(contracts.contract_amount) WHERE sales_id = assigned_to AND status IN ('approved', 'active', 'completed') AND date_trunc('month', contract_date) = period
- `collection` 类型：SUM(payments.amount) WHERE confirmed = true AND 关联合同的 sales_id = assigned_to AND date_trunc('month', payment_date) = period

**当前阶段不需要物料化视图或快照表**（合同数 < 10），在 confirm_payment RPC 内冗余累加到 kpi_targets.actual_amount 字段即可。

---

## 4. 页面清单

| 页面 | 状态 | 核心交互 |
|------|------|---------|
| `/contracts` | 改造 | 新增审批状态 Tab（全部/待审批/生效中/已暂停）；Admin/Boss 看审批按钮；Sales 看录入回款按钮 |
| `/contracts/new` | 改造 | 提交后 status=draft；增加合同文件上传区域（直传 COS）；校验反馈（折扣率、首付比例红色警告） |
| `/contracts/[id]` | 新建 | 合同详情：基本信息 + 审批时间线 + 分期列表 + 回款记录 + 核销明细 + 文件预览区 |
| 回款弹窗组件 | 新建 | 选分期 → 填金额 → 自动校验不超期应付 → 提交；支持一笔回款拆分多期 |
| 回款确认队列 | 新建 | CEO 驾驶舱内：待确认回款列表 → 逐条或批量确认 |
| `/projects` | 改造 | 项目阶段推进按钮；推进时自动触发对应分期到期 |
| KPI 看板 | 改造 | 目标 vs 实际（actual 从冗余字段读） |

---

## 5. 数据权限与多租户策略

### 5.1 应用层数据权限（当前实现）

| 表 | Sales | Admin | Boss |
|----|-------|-------|------|
| contracts | SELECT/INSERT 自己的；UPDATE status=draft 时 | ALL | ALL |
| contract_approvals | SELECT 自己合同的 | SELECT pending_admin 的；INSERT 审批记录 | ALL |
| payments | INSERT/SELECT 自己合同的 | SELECT ALL；UPDATE confirmed | SELECT ALL；UPDATE confirmed |
| payment_allocations | INSERT/SELECT 自己合同的 | SELECT ALL | SELECT ALL |
| installment_plans | SELECT 自己合同的 | ALL | ALL |

权限控制在 API 路由层通过 `get_my_role()` + `get_my_user_id()` 实现，不依赖 RLS。

### 5.2 多租户预留（Axon 商业化蒸馏）

**策略：字段预留 + RLS 延后。**

所有新建表（`contract_approvals`、`payment_allocations`）均包含 `tenant_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'` 字段。现有表（`contracts`、`payments`、`installment_plans`）后续统一加字段。

**现阶段不做的事：**
- ❌ 不写 RLS Policy（单租户阶段，加了反而拖慢开发调试）
- ❌ 不做连接级 `set_config('app.tenant_id', ...)` 注入
- ❌ 不改现有表的 tenant_id（等 Axon 蒸馏时统一改造）

**Axon 蒸馏时统一做的事（预估 1 天）：**
1. 所有业务表加 `tenant_id` 字段 + 索引
2. 每张表写 RLS Policy（`USING (tenant_id = current_setting('app.tenant_id')::uuid)`）
3. API 中间件在每个请求前 `set_config('app.tenant_id', ...)`
4. 所有 RPC 函数开头设 tenant context
5. 全量回归测试

**为什么现在只加字段不加 RLS：** RLS 是承重墙不是地基。开发阶段每次 `SELECT * FROM contracts` 都要先 `set_config`，忘了就查不到数据，排查成本高。字段预留了，迁移成本几乎为零。

---

## 6. 不做什么（红线）

- ❌ 不做电子签名（现阶段纸质签 + 拍照上传足够）
- ❌ 不做自动催收 WhatsApp/邮件（只做系统内通知）
- ❌ 不做财务报表（不是 ERP，只做回款追踪）
- ❌ 不做合同模板生成（现阶段手动上传 PDF）
- ❌ 不做多币种自动换算（全部 AED）
- ❌ 不做物料化视图 / 复杂缓存（数据量 < 100 条，直查足够）
- ❌ 不做 RLS Policy（字段预留 `tenant_id`，Axon 蒸馏时统一加，详见 §5.2）

---

## 7. 成功指标

| 指标 | 验收标准 |
|------|---------|
| 合同审批 | 任何合同创建后必须经过至少 1 人审批才能生效 |
| 文件管理 | 每个生效合同都有至少 1 份文件（draft 或 sealed） |
| 回款核销 | 一笔回款可拆分核销到多期，数据不锁死 |
| 自动催收 | 逾期分期在 24h 内产生通知 |
| 事务完整性 | confirm_payment RPC 执行中任何一步失败，全部回滚 |
| KPI 可见 | Boss 能看到每个销售的签约额/回款额 vs 目标 |
