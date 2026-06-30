# NewMe CRM v2.1 数据模型 — 执行摘要

## 已创建的文档

| 文件 | 说明 | 大小 |
|------|------|------|
| `docs/newme-crm-data-model-design.md` | 完整设计文档（含 HubSpot 研究、ERD、DDL、索引、RLS、迁移策略） | 77KB |
| `supabase/migrations/20260605000000_newme_crm_v21_full.sql` | 可直接执行的完整 DDL 迁移文件 | 42KB |
| `docs/newme-crm-5layer-erd.svg` | ER 关系图（SVG 格式） | — |
| `docs/newme-crm-5layer-erd.excalidraw` | ER 关系图（可编辑 Excalidraw 格式） | — |

## 5层数据模型总览

```
Layer 1: Leads (线索)       — 已存在 ✅ 增强
Layer 2: Quotations (报价)   — 新建 🆕 (products + quotations + quotation_items)
Layer 3: Contracts (合同)    — 新建 🆕 (contracts + installment_plans + delivery_plans)
Layer 4: Projects (项目)     — 已存在 ✅ 重构
Layer 5: Payments (回款)     — 新建 🆕 (payments + sales_targets)
```

## HubSpot 研究关键发现

HubSpot CRM 的核心对象模型（Contact→Company→Deal→Quote→Line Item→Product→Activity）与 NewMe 的 Lead→Quotation→Contract→Project→Payment 高度对应。关键借鉴：

1. **Deal Pipeline + Probability** → leads 的 9 阶段管道 + win_probability
2. **Line Items** → quotation_items（独立的行项目表）
3. **Quote Lifecycle** → DRAFT→SENT→VIEWED→NEGOTIATING→ACCEPTED→REJECTED→EXPIRED
4. **Association Labels** → 用 FK 实现 HubSpot 的定向关联标签
5. **Activities/Engagements** → activities 表增强（增加 contract/quotation/project 关联）
6. **Stage Calculated Properties** → triggers 和视图实现

## 核心业务规则

- **Leads → Quotations**: 1:N（一个线索可以有多个报价版本）
- **Quotations → Contracts**: N:1（一个报价被接受生成一个合同）
- **Contracts → Payments**: 1:N（合同驱动分期计划 → 收款）
- **Contracts → Projects**: 1:1（合同签约后启动项目交付）
- **付款计划校验**: 分期金额之和 == 合同金额
- **自动对账**: 收款 → 累计分期 → 全额即标记 paid → 全部分期 paid → 合同 completed
- **逾期检测**: 每天自动扫描超出到期日未付的分期

## 下一步行动

| # | 任务 | 负责人 |
|---|------|--------|
| 1 | 执行迁移文件 `20260605000000_newme_crm_v21_full.sql` | DBA |
| 2 | 建立产品库（导入现有设备数据到 products 表） | 产品 |
| 3 | 前端新建合同/报价/回款页面 | 前端 |
| 4 | 配置 Supabase 定时任务（逾期检测） | 后端 |
| 5 | 数据迁移：旧 projects/quotes 记录 → 新 contracts/quotations | 数据 |
