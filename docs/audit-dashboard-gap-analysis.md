# Dashboard 管理视图 — PRD vs 交付差距分析（独立审计）

> 审计日期: 2026-07-07  
> 审计范围: PRD §4.6 统计与看板 + §5 P0 验收标准  
> 审计方法: 逐行对比 PRD 要求 vs 实际代码交付  
> 独立性声明: 不依赖 opencode 审计结果，完全基于源码阅读

---

## 一、PRD 要求速览

### 仪表盘布局（PRD §4.6）
| 层级 | 内容 | 数据源 |
|------|------|--------|
| **L1** | 4 个核心指标卡片：签约总额、已收总额、待收总额、逾期总额 | contracts + payments + installment_plans |
| **L2** | 销售业绩排名表：销售姓名、签约总额、回款总额、回款率、逾期笔数、达标标记 | contracts + payments + installment_plans |
| **L3** | 逾期预警清单：按逾期天数降序的付款计划列表 | installment_plans (status='overdue') |
| **L4** | 交付延期预警：按延期天数降序的交付里程碑列表 | delivery_plans (status='delayed') |

### 关键 P0 验收标准（PRD §5）
| 编号 | 验收标准 |
|------|---------|
| **P0-6** | Dashboard 顶部 4 指标卡片（签约总额/已收总额/待收总额/逾期总额） |
| **P0-7** | Dashboard 逾期回款清单（逾期列表按天排序） |
| **P0-8** | 销售业绩排名表（签约额/回款额/回款率/逾期笔数） |
| **P0-9** | 达标/未达标预警（回款率 < 60% 标记） |

---

## 二、当前交付现状

### 2.1 后端 API

**`/api/dashboard/summary`** (route.ts 573 行)
- ✅ 查询 contracts、payments、installment_plans（正确数据源）
- ✅ 计算 financeStats: `{ totalContractValue, received, outstanding, overdue, dueNextWeek }`
  - `totalContractValue` = SUM(active contracts) — 签约总额的等价物
  - `received` = SUM(confirmed payments) — 已收总额
  - `outstanding` = totalContractValue - received — 粗糙的待收（≠PRD 精确口径）
  - `overdue` = SUM(overdue installment_plans) — 逾期总额
- ❌ **不计算** per-salesperson 的回款率、逾期笔数、达标标记
- ❌ **不消费** `v_sales_performance` 视图（PRD §6.7 已定义，含 payment_rate / overdue_count / is_on_target）

**`/api/dashboard/weekly-review`** (route.ts 309 行)
- L1: `{ new_leads, contacted_leads, quality_judged, stage_advanced, won, lost }` — **Leads 活动指标，与 PRD 合同金融指标完全不符**
- L2: `{ assigned_leads, contacted, pending_quality, stage_advanced, won, lost, overdue_tasks }` — **Pipeline 活动统计**
- L3: `l3_by_user` — Lead 列表（客户名、阶段、联系次数、质量、备注）— **不是逾期清单/交付延期清单**
- 权限: 仅 admin/boss/operator 可访问，sales 被 403

**`/api/dashboard/team-performance`** (route.ts 199 行)
- 提供 per-salesperson: `{ totalLeads, wonLeads, activeLeads, revenue, conversionRate, avgDealSize }`
- revenue 来自 contracts.contract_amount（正确）
- ❌ 无回款额、无回款率、无逾期笔数

### 2.2 前端 Dashboard page.tsx (829 行)

**Management view L1 卡片（行 610-641）：**
```
┌─────────────────────┬─────────────────────┬─────────────────────┬─────────────────────┐
│ 签约KPI完成率 X%     │ 回款KPI完成率 X%     │ 逾期金额 AED X       │ 下周到期 AED X       │
│ (进度条)             │ (进度条)             │ ⚠ needs followup    │                     │
└─────────────────────┴─────────────────────┴─────────────────────┴─────────────────────┘
```
- 展示的是 **KPI 目标完成率百分比**，而非 PRD 要求的 **四笔绝对金额**
- 逾期/下周到期以 AED 金额展示（部分正确，但放在 KPI 完成率卡片旁边，不是独立的核心指标卡片）

**Management view L2 销售排名（行 664-701，`salesLeaderboard`）：**
```
销售名 | wonValue(AED) | totalLeads | imported | active | won | lost | completionRate%
```
- `wonValue` 来源: `leads.quotation_value`（线索报价金额）→ **不是 contracts.contract_amount（签约金额）**
- 没有回款额、回款率、逾期笔数
- `completionRate%` 是对比 KPI 目标，不是回款率
- **没有达标/未达标预警（回款率 < 60%）**

**WeeklyReview 组件（L1/L2/L3）：**
- L1: new_leads / contacted / quality / stage_advanced / won / lost — 6 个 Leads 指标
- L2: per-sales 的 assigned / contacted / pending_quality / stage_advanced / won / lost / overdue_tasks
- L3: Lead 明细列表（客户名、阶段、联系次数、质量、备注）→ **不是逾期清单**
- 这是**周复盘/Lead 活动看板**，与 PRD 的**合同金融看板**是完全不同的两套体系

---

## 三、逐项差距清单

### GAP-1: L1 顶部 4 核心指标卡片 — 做了但口径错
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 4 张独立卡片显示：签约总额、已收总额、待收总额、逾期总额（均为绝对 AED 金额） |
| **当前交付** | 4 张卡片显示：签约 KPI 完成率%(进度条)、回款 KPI 完成率%(进度条)、逾期金额、下周到期金额 |
| **严重程度** | 🔴 **P0 (CRITICAL)** — 对应 P0-6 |
| **根因** | **做了但口径错**。后端 `/api/dashboard/summary` 已正确计算出 totalContractValue/received/outstanding/overdue，但前端将其包装为 KPI 进度卡片而非独立金额卡片。同时 `outstanding` 口径与 PRD 不一致（PRD 要求来自 installment_plans pending+overdue，后端是 totalContractValue - received） |
| **修复方向** | L1 改为 4 张独立 AED 金额卡片（签约总额/已收总额/待收总额/逾期总额），百分比趋势放副标题；修正待收总额计算口径为 `SUM(installment_plans WHERE status IN ('pending','overdue'))` |

### GAP-2: L2 销售业绩排名表 — 数据源错 + 口径错
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 排名表字段：排名序号、销售姓名、**签约总额**、**回款总额**、**回款率**、**逾期笔数**、**达标标记**；数据源 contracts+payments+installment_plans |
| **当前交付 (salesLeaderboard)** | wonValue(leads.quotation_value)、totalLeads、imported、active、won、lost、completionRate%(vs KPI target) |
| **当前交付 (WeeklyReview L2)** | assigned_leads、contacted、pending_quality、stage_advanced、won、lost、overdue_tasks |
| **严重程度** | 🔴 **P0 (CRITICAL)** — 对应 P0-8 |
| **根因** | **数据源错** — 两套 L2 用的都是 leads 表 + tasks 表 + business_events 表，完全没有 contracts/payments/installment_plans 数据。PRD 定义的 `v_sales_performance` 视图（含 contract_amount / paid_amount / payment_rate / overdue_count / is_on_target）已设计但未消费 |
| **修复方向** | 使用 `v_sales_performance` 视图或 contracts+payments+installment_plans 联合查询驱动排名表；字段对齐 PRD 要求的 6 列 |

### GAP-3: L3 逾期预警清单 — 完全没做
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 列出所有 `status='overdue'` 的付款计划，按逾期天数降序；每行：客户名称、销售姓名、合同金额、逾期期次、逾期金额、逾期天数；提供「登记收款」快捷按钮 |
| **当前交付** | WeeklyReview L3 展示 Lead 明细列表（客户名、阶段、联系次数、质量、备注）；逾期金额仅作为 financeStats.overdue 出现在 L1 卡片中，不是清单 |
| **严重程度** | 🔴 **P0 (CRITICAL)** — 对应 P0-7 |
| **根因** | **完全没做**。没有任何代码渲染 overdue installment_plans 列表。`/api/dashboard/summary` 虽查询了 overduePlans（行 349），但只用于前端计算总额，不返回给前端渲染列表 |
| **修复方向** | 需新增逾期清单组件，数据源：`installment_plans JOIN contracts JOIN profiles`，条件 `status='overdue'`，按 `CURRENT_DATE - due_date DESC` 排序 |

### GAP-4: 达标/未达标预警 — 做了但口径错
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 回款率 < 60% → ⚠️ 红色背景高亮标记（DSH-12）；逾期笔数 ≥ 3 → 🔴 严重预警（DSH-13） |
| **当前交付** | salesLeaderboard 的 completionRate% 对比 KPI 目标用绿/黄色，不是回款率对比 60% 阈值。没有任何回款率 < 60% 的预警逻辑 |
| **严重程度** | 🔴 **P0 (CRITICAL)** — 对应 P0-9 |
| **根因** | **做了但口径错**。有 completionRate 标记，但那是 KPI 目标完成率（signing target），不是回款率（received / totalContractValue）。回款率根本没有在排名表中计算或展示 |
| **修复方向** | 排名表增加 payment_rate 列（= received / totalContractValue per salesperson）；< 60% 行红色高亮 + ⚠️ 标记；≥ 3 笔逾期加 🔴 |

### GAP-5: 交付延期预警 — 完全没做
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 列出所有 `status='delayed'` 的交付里程碑，按延期天数降序；每行：客户名称、销售姓名、里程碑名称、预计完成日期、延期天数、当前状态 |
| **当前交付** | 不存在 |
| **严重程度** | 🟡 **P1 (IMPORTANT)** — 对应 P1-6 |
| **根因** | **完全没做**。没有查询 delivery_plans 表的代码，没有渲染交付延期清单 |
| **修复方向** | 新增交付延期组件，数据源 `delivery_plans WHERE status='delayed'`，按 `CURRENT_DATE - expected_date DESC` 排序 |

### GAP-6: 销售视角数据隔离 — 部分做
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 销售视角下，顶部指标卡片仅显示该销售名下的合同数据（DSH-06）；排名表 sales 仅见自己（DSH-07） |
| **当前交付** | `/api/dashboard/summary` 对 sales 角色做了数据过滤（contracts by sales_id, payments by contract_id）✅；但 `/api/dashboard/weekly-review` 对 sales 返回 403 ❌ |
| **严重程度** | 🟢 **P2 (MINOR)** |
| **根因** | **部分做**。summary API 正确隔离，但 weekly-review 拒绝 sales 访问 |

### GAP-7: 回款率进度条 — 完全没做
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 排名表回款率列显示进度条：<60% 红色 / 60%-80% 黄色 / >80% 绿色（DSH-10） |
| **当前交付** | 无 |
| **严重程度** | 🟡 **P1 (IMPORTANT)** — 对应 P1-10 |
| **根因** | **完全没做**，回款率列本身就不存在 |

### GAP-8: 逾期天数颜色标记 — 完全没做
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 逾期 >30 天红色加粗；7-30 天橙色；<7 天黄色（DSH-18） |
| **当前交付** | 无 |
| **严重程度** | 🟡 **P1 (IMPORTANT)** |
| **根因** | **完全没做**，逾期清单本身不存在 |

### GAP-9: 待收总额计算口径 — 偏差
| 属性 | 详情 |
|------|------|
| **PRD 要求** | 待收总额 = SUM(installment_plans WHERE status IN ('pending','overdue'))（DSH-04） |
| **当前交付** | `outstanding = totalContractValue - received` |
| **严重程度** | 🟡 **P1** — 在合同分期场景下可能产生差异（如合同金额 ≠ 分期金额之和时有偏差） |
| **根因** | **做了但口径错**。后端逻辑略过 installment_plans 直接从合同差额计算 |
| **修复方向** | 改为 PRD 口径：`SUM(ip.amount) WHERE ip.status IN ('pending','overdue')` |

---

## 四、差距汇总矩阵

| # | 差距项 | PRD 对应 | 严重程度 | 根因分类 | 当前状态 |
|---|--------|---------|---------|---------|---------|
| 1 | L1 4 核心指标卡片 | P0-6, DSH-01~05 | 🔴 P0 CRITICAL | 做了但口径错 | financeStats 已有数据，前端渲染为 KPI 进度而非绝对金额 |
| 2 | L2 销售业绩排名表 | P0-8, DSH-07~11 | 🔴 P0 CRITICAL | 数据源错 | 使用 leads 数据而非 contracts+payments+installment_plans |
| 3 | L3 逾期预警清单 | P0-7, DSH-16~19 | 🔴 P0 CRITICAL | 完全没做 | 零代码 |
| 4 | 达标/未达标预警 | P0-9, DSH-12~15 | 🔴 P0 CRITICAL | 做了但口径错 | completionRate vs KPI target，不是 payment_rate < 60% |
| 5 | 交付延期预警 | P1-6, DSH-20~21 | 🟡 P1 IMPORTANT | 完全没做 | 零代码 |
| 6 | 销售视角数据隔离 | DSH-06 | 🟢 P2 MINOR | 部分做 | summary API ✅ / weekly-review ❌ |
| 7 | 回款率进度条 | P1-10, DSH-10 | 🟡 P1 IMPORTANT | 完全没做 | 排名表缺回款率列 |
| 8 | 逾期颜色标记 | DSH-18 | 🟡 P1 IMPORTANT | 完全没做 | 逾期清单不存在 |
| 9 | 待收总额计算口径 | DSH-04 | 🟡 P1 IMPORTANT | 做了但口径错 | 用合同差额而非 installment_plans |

---

## 五、根本原因分析

### 5.1 两套 Dashboard 体系并存导致混淆
当前代码存在**两套 Dashboard 数据/展示体系**：

1. **Leads 活动体系**（WeeklyReview + KPI 卡）: 数据源 = leads + follow_up_logs + business_events + tasks
2. **合同金融体系**（financeStats 后端）: 数据源 = contracts + payments + installment_plans

PRD 明确要求 Dashboard 以**合同金融体系**为核心，但前端渲染全部使用 **Leads 活动体系**。financeStats 虽被正确计算但仅作为 KPI 进度条的辅助数据嵌入，从未以 PRD 要求的卡片/表格/清单形式独立呈现。

### 5.2 v_sales_performance 视图未消费
PRD §6.7 精心设计了 `v_sales_performance` 视图，包含：
- `total_contract_amount` — 签约总额
- `total_paid_amount` — 回款总额
- `payment_rate` — 回款率
- `overdue_count` — 逾期笔数
- `is_on_target` — 达标标记

但 Dashboard 前端和后端 API **完全不消费此视图**。排名表组件 `salesLeaderboard` 使用的是 leads.quotation_value 而非 contracts.contract_amount。

### 5.3 WeeklyReview 的 L3 语义偏差
WeeklyReview 的 L3 展示的是"阶段变动明细"（Lead 列表），但 PRD 要求的是"逾期回款清单"（installment_plans overdue 列表）。两者数据源、展示目的、业务含义完全不同。

---

## 六、修复优先级建议

| 优先级 | 修复项 | 预估工作量 | 依赖 |
|--------|--------|-----------|------|
| 🔴 P0-1 | L1 改为 4 张独立 AED 金额卡片 | 0.5 天 | 后端数据已就绪 |
| 🔴 P0-2 | L2 排名表改为 contracts+payments+installment_plans 数据源 | 1.5 天 | 可消费 v_sales_performance 视图 |
| 🔴 P0-3 | 新增 L3 逾期回款清单组件 | 1 天 | installment_plans 表已有数据 |
| 🔴 P0-4 | 回款率 <60% 达标预警逻辑 | 0.5 天 | 伴随 P0-2 同做 |
| 🟡 P1-1 | 交付延期预警 | 1 天 | delivery_plans 表需有数据 |
| 🟡 P1-2 | 回款率进度条 + 逾期颜色标记 | 0.5 天 | 伴随 P0-2/P0-3 |
| 🟡 P1-3 | 修正待收总额口径 | 0.25 天 | 后端改动 |

---

## 七、审计结论

**PRD Dashboard §4.6 要求的 4 个核心视图（L1 指标卡 / L2 排名表 / L3 逾期清单 / L4 交付延期）中：**

- ✅ **0 个完全符合 PRD 要求**
- ⚠️ **1 个部分实现但口径错**（L1 指标卡 — 后端数据对但前端渲染错）
- ❌ **3 个完全缺失**（L2 排名表数据源错、L3 逾期清单零代码、L4 交付延期零代码）

**P0 验收标准（§5）：5 项 P0 中 4 项未达标（P0-6/P0-7/P0-8/P0-9），仅 P0-6 接近（后端数据就绪但前端渲染错）。**

整体 Dashboard 交付状态: **不满足 PRD 要求，差距显著**。
