# 验收计划：合同→生产链

---

## 总原则

**每个 Phase 独立验收，不通过不进下一个。** 验收以 curl 命令 + 页面截图 + 数据库查询三维验证。

---

## Phase 1 验收：数据基础

### V1.1 — Migration 执行

```sql
-- 验证新表存在
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('contract_approvals', 'payment_allocations');

-- 验证新表含 tenant_id 字段
SELECT table_name, column_name, column_default FROM information_schema.columns 
WHERE table_name IN ('contract_approvals', 'payment_allocations') AND column_name = 'tenant_id';
-- 预期: 2 rows, column_default = '00000000-0000-0000-0000-000000000000'

-- 验证 contracts status 约束已更新
SELECT con.conname, pg_get_constraintdef(con.oid) 
FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'contracts' AND con.conname LIKE '%status%';

-- 预期: status CHECK 包含 'pending_admin','pending_ceo','approved','revoking','superseded','suspended'

-- 验证 approval_status 列已删除
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'contracts' AND column_name = 'approval_status';
-- 预期: 0 rows

-- 验证 installment_plans 新字段
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'installment_plans' AND column_name = 'allocated_amount';
-- 预期: 1 row

-- 验证 tenant_id 索引存在
SELECT indexname, indexdef FROM pg_indexes 
WHERE tablename IN ('contract_approvals', 'payment_allocations') AND indexdef LIKE '%tenant_id%';
-- 预期: 2 rows（各表一个 tenant_id 索引）

-- 注意: 现阶段不启用 RLS Policy，只预留 tenant_id 字段
-- RLS Policy 在 Axon 蒸馏时统一添加
```

**通过标准:** 全部 SQL 查询结果符合预期，无报错。新表含 tenant_id 字段且默认值为零 UUID。

### V1.2 — RPC 函数

```sql
-- 验证函数存在
SELECT routine_name FROM information_schema.routines 
WHERE routine_name IN ('confirm_payment', 'approve_contract', 'allocate_payment')
AND routine_schema = 'public';
-- 预期: 3 rows
```

**通过标准:** 3 个函数均存在。

### V1.3 — COS PUT 预签名

```bash
# 生成上传预签名 URL
python3 /home/ubuntu/newme-platform/scripts/cos-presign.py \
  "contracts/test-upload/test.txt" 3600 --method PUT

# 用 curl PUT 测试（预期返回 200 或 403 Forbidden 但说明签名格式正确）
curl -X PUT "<生成的URL>" -d "test content"
```

**通过标准:** 生成的 URL 格式正确（含 q-signature 参数），PUT 请求被 COS 接收（200）或签名验证通过但因内容问题返回非 403 SignatureDoesNotMatch。

---

## Phase 2 验收：审批流

### V2.1 — 合同创建不再直接 active

```bash
# Sales 创建合同
curl -X POST https://app.newme.ae/api/contracts \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "<test_lead_id>",
    "amount": 50000,
    "currency": "AED",
    "party_a_name": "Test Customer",
    "installments": [
      {"seq": 1, "amount": 20000, "due_date": "2026-07-01"},
      {"seq": 2, "amount": 30000, "due_date": "2026-09-01"}
    ]
  }'

# 预期: 返回 contract.status = "draft"（不是 "active"）
# 预期: 返回 contract_approvals 记录存在 (step=admin_review, status=pending)
```

**通过标准:**
- [ ] 合同 status = "draft"
- [ ] contract_approvals 表有 1 条 pending 记录
- [ ] Admin 用户收到通知

### V2.2 — Admin 审批

```bash
# Admin 审批
curl -X POST https://app.newme.ae/api/contracts/<contract_id>/approve \
  -H "Cookie: <admin_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"action": "approve", "notes": "校验通过，推给CEO"}'

# 预期: contract.status = "pending_ceo"
# 预期: contract_approvals 有 2 条记录 (admin_review=approved, ceo_review=pending)
```

**通过标准:**
- [ ] 合同 status 推进到 "pending_ceo"
- [ ] 审批历史正确记录
- [ ] Boss 收到通知

### V2.3 — CEO 审批

```bash
# Boss 审批
curl -X POST https://app.newme.ae/api/contracts/<contract_id>/approve \
  -H "Cookie: <boss_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"action": "approve", "notes": "批准"}'

# 预期: contract.status = "approved" (然后可由 Boss 手动激活为 active)
```

**通过标准:**
- [ ] 合同 status = "approved"
- [ ] Sales 收到通知 "合同已生效"
- [ ] Admin 收到通知 "请上传盖章版"

### V2.4 — 驳回

```bash
# CEO 驳回
curl -X POST https://app.newme.ae/api/contracts/<contract_id>/approve \
  -H "Cookie: <boss_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"action": "reject", "notes": "金额过高，需要重新报价"}'

# 预期: contract.status = "draft"
# 预期: Sales 收到驳回通知
```

**通过标准:**
- [ ] 合同回退到 "draft"
- [ ] Sales 能看到驳回原因
- [ ] Sales 可修改重新提交

### V2.5 — 前端页面

- [ ] `/contracts` 列表页：Tab 切换正常（全部/待我审批/生效中/已暂停）
- [ ] `/contracts/new`：提交后显示 "已提交审批" 而非 "已创建"
- [ ] `/contracts/[id]`：显示完整审批时间线（谁审批的、时间、结果、意见）
- [ ] `/contracts/[id]`：显示校验结果（折扣率、首付比例、金额偏差）

---

## Phase 3 验收：回款

### V3.1 — 回款录入

```bash
# Sales 录入回款
curl -X POST https://app.newme.ae/api/payments \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{
    "contract_id": "<contract_id>",
    "amount": 25000,
    "payment_method": "bank_transfer",
    "reference_no": "TRX-001",
    "payment_date": "2026-06-15"
  }'

# 预期: payment.confirmed = false
# 预期: Admin/Boss 收到 "待确认回款" 通知
```

**通过标准:**
- [ ] Payment 记录创建成功
- [ ] confirmed = false
- [ ] 通知发送正确

### V3.2 — 核销分配（一笔回款拆多期）

```bash
# Sales 分配核销：25,000 拆到 2 期
curl -X POST https://app.newme.ae/api/payments/<payment_id>/allocate \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{
    "allocations": [
      {"plan_id": "<plan_1_id>", "amount_allocated": 20000},
      {"plan_id": "<plan_2_id>", "amount_allocated": 5000}
    ]
  }'

# 预期: payment_allocations 有 2 条记录
# 预期: installment_plan[1].allocated_amount = 20000 (≥ amount=20000, status=paid)
# 预期: installment_plan[2].allocated_amount = 5000 (< amount=30000, status=partial)
```

**通过标准:**
- [ ] 核销流水正确记录
- [ ] 分期 allocated_amount 正确累加
- [ ] 分期 status 自动重算（paid/partial/pending）

### V3.3 — 核销超额校验

```bash
# 尝试超额分配：总额 25,000 但分配 30,000
curl -X POST https://app.newme.ae/api/payments/<payment_id>/allocate \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{
    "allocations": [
      {"plan_id": "<plan_1_id>", "amount_allocated": 25000},
      {"plan_id": "<plan_2_id>", "amount_allocated": 5000}
    ]
  }'

# 预期: 返回 400 error "Allocation total exceeds payment amount"
```

**通过标准:**
- [ ] 超额分配被拒绝
- [ ] 错误信息清晰

### V3.4 — 回款确认（事务完整性）

```bash
# Boss 确认回款
curl -X POST https://app.newme.ae/api/payments/<payment_id>/confirm \
  -H "Cookie: <boss_session_cookie>" \
  -H "Content-Type: application/json"

# 预期 (全部在同一个事务内完成):
# 1. payments.confirmed = true
# 2. installment_plans.allocated_amount 更新
# 3. installment_plans.status 重算
# 4. contracts.first_payment_status 更新 (如果涉及首期)
# 5. projects.paid_amount 累加
# 6. activities 写入
# 7. Sales 收到 "回款已确认" 通知
# 8. kpi_targets.actual_amount 累加
```

**通过标准:**
- [ ] 以上 8 项全部完成
- [ ] 数据一致性：SUM(payment_allocations) = installment_plans.allocated_amount
- [ ] 数据一致性：SUM(payments WHERE confirmed=true) = projects.paid_amount

### V3.5 — 事务回滚测试

模拟 RPC 中间步骤失败，验证全部回滚：

```sql
-- 在测试环境中手动验证 RPC 事务性
-- 方法: 临时修改 RPC 加一个 RAISE EXCEPTION 在第 4 步
-- 执行后检查前 3 步的数据是否回滚
```

**通过标准:**
- [ ] 中间步骤失败时，所有已执行写操作全部回滚
- [ ] 数据库状态与 RPC 调用前一致

### V3.6 — 前端验证

- [ ] `/contracts/[id]` 分期列表显示 "录入回款" 按钮
- [ ] 回款弹窗：输入金额后自动建议分配，可手动调整
- [ ] 回款弹窗：已分配/总额进度条实时显示
- [ ] CEO 驾驶舱：待确认回款列表显示
- [ ] 确认后分期状态实时更新

---

## Phase 4 验收：自动化

### V4.1 — 逾期扫描 Cron

```bash
# 手动触发 cron
curl "https://app.newme.ae/api/cron/check-overdue-installments?token=<CRON_SECRET>"

# 预期:
# 1. 过期分期 status 更新为 "overdue"
# 2. 逾期 1-2 天: Sales 收到通知
# 3. 逾期 3-7 天: Sales + Boss 收到通知
# 4. 逾期 > 30 天: contract.status = "suspended"
```

**通过标准:**
- [ ] 逾期分期正确标记
- [ ] 通知按逾期天数分级发送
- [ ] 极端逾期合同被暂停

### V4.2 — 项目阶段联动

```bash
# 推进项目阶段
curl -X PATCH https://app.newme.ae/api/projects/<project_id>/phase \
  -H "Cookie: <boss_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"phase": "procurement"}'

# 预期: installment_plans[1].due_date = today (第 2 期到期)
```

**通过标准:**
- [ ] procurement → 第 2 期 due_date 更新
- [ ] handover → 尾期 due_date 更新

### V4.3 — KPI 显示

```bash
# 查看 KPI
curl "https://app.newme.ae/api/kpi/targets?period=2026-06" \
  -H "Cookie: <boss_session_cookie>"

# 预期: 每条 target 包含 actual_amount 和 completion_rate
```

**通过标准:**
- [ ] actual_amount 反映已确认回款总额
- [ ] completion_rate = actual / target

---

## Phase 5 验收：文件上传

### V5.1 — 获取上传预签名 URL

```bash
# Sales 获取 draft 上传 URL
curl -X POST https://app.newme.ae/api/contracts/<contract_id>/upload-url \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"filename": "contract-draft.pdf", "version": "draft"}'

# 预期: 返回 { url: "https://tanya-1420640156.cos.ap-singapore.myqcloud.com/...", key: "contracts/.../draft_contract-draft.pdf" }
```

### V5.2 — 前端直传

```bash
# 用返回的 URL 直传
curl -X PUT "<预签名URL>" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @test-contract.pdf

# 预期: 200 OK
```

### V5.3 — 确认上传

```bash
curl -X POST https://app.newme.ae/api/contracts/<contract_id>/confirm-upload \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"key": "contracts/.../draft_contract-draft.pdf", "version": "draft"}'

# 预期: contracts.file_url 更新
```

**通过标准:**
- [ ] 预签名 URL 可用
- [ ] PUT 直传成功（文件不经过 Next.js）
- [ ] 合同 file_url 正确更新
- [ ] 文件可下载（通过 /api/cos/download-url）

### V5.4 — 权限隔离

```bash
# Sales 尝试上传 sealed 版本（应被拒绝）
curl -X POST https://app.newme.ae/api/contracts/<contract_id>/upload-url \
  -H "Cookie: <sales_session_cookie>" \
  -H "Content-Type: application/json" \
  -d '{"filename": "contract-sealed.pdf", "version": "sealed"}'

# 预期: 403 Forbidden
```

**通过标准:**
- [ ] Sales 只能上传 draft
- [ ] 只有 Admin/Boss 能上传 sealed

### V5.5 — 前端文件区域

- [ ] `/contracts/[id]` 页面显示已上传文件
- [ ] 点击可预览/下载
- [ ] draft 版本显示上传者、时间
- [ ] sealed 版本显示上传者、时间

---

## 全局验收（Phase 1-5 全部完成后）

### E2E 场景测试：完整合同生命周期

```
1. Sales 创建合同 → status=draft ✓
2. 上传合同草稿 PDF → file_url 更新 ✓
3. Admin 审批通过 → status=pending_ceo ✓
4. CEO 审批通过 → status=approved → active ✓
5. Admin 上传盖章版 → sealed_file_url 更新 ✓
6. Sales 录入回款 25,000 AED → payment 创建 ✓
7. Sales 分配核销: 第1期 20,000 + 第2期 5,000 ✓
8. CEO 确认回款 → 全链路联动（分期状态、项目金额、KPI、通知）✓
9. 项目推进到 procurement → 第2期 due_date 自动更新 ✓
10. Cron 逾期扫描 → 逾期分期标记 overdue + 通知 ✓
11. Sales 录入尾款 → 核销 → 确认 → 全部 paid ✓
12. 合同 status 自动变为 completed ✓
```

**通过标准:**
- [ ] 12 步全部通过
- [ ] 全程数据一致（可查 SQL 验证）
- [ ] 通知在每个关键节点正确触发

### 数据一致性终检

```sql
-- 1. 每个合同的核销总额 = 已确认回款总额
SELECT c.id, c.contract_no, c.contract_amount,
  COALESCE(SUM(p.amount), 0) as total_payments,
  COALESCE(SUM(pa.amount_allocated), 0) as total_allocated
FROM contracts c
LEFT JOIN payments p ON p.contract_id = c.id AND p.confirmed = true
LEFT JOIN payment_allocations pa ON pa.payment_id = p.id
GROUP BY c.id, c.contract_no, c.contract_amount;

-- 预期: total_payments = total_allocated for each contract

-- 2. 每个分期的 allocated_amount = SUM(allocation)
SELECT ip.id, ip.amount, ip.allocated_amount,
  COALESCE(SUM(pa.amount_allocated), 0) as calc_allocated
FROM installment_plans ip
LEFT JOIN payment_allocations pa ON pa.plan_id = ip.id
GROUP BY ip.id, ip.amount, ip.allocated_amount;

-- 预期: allocated_amount = calc_allocated for each plan

-- 3. 项目已付金额 = 合同已确认回款总额
SELECT p.id, p.name, p.paid_amount,
  COALESCE(SUM(pay.amount), 0) as calc_paid
FROM projects p
LEFT JOIN contracts c ON c.lead_id = p.lead_id  -- 关联方式需确认
LEFT JOIN payments pay ON pay.contract_id = c.id AND pay.confirmed = true
GROUP BY p.id, p.name, p.paid_amount;

-- 预期: paid_amount = calc_paid
```

**通过标准:** 3 组查询全部一致，无数据撕裂。

---

## 验收签署

| Phase | 验收人 | 日期 | 结果 |
|-------|--------|------|------|
| Phase 1 — 数据基础 | | | ☐ PASS / ☐ FAIL |
| Phase 2 — 审批流 | | | ☐ PASS / ☐ FAIL |
| Phase 3 — 回款 | | | ☐ PASS / ☐ FAIL |
| Phase 4 — 自动化 | | | ☐ PASS / ☐ FAIL |
| Phase 5 — 文件 | | | ☐ PASS / ☐ FAIL |
| E2E 全链路 | | | ☐ PASS / ☐ FAIL |
