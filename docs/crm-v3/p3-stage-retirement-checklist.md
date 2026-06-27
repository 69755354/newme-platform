# P3: Stage 退役清单

> 产出者: GLM 5.2 (Coding Plan) · **只读扫描，未修改任何源码**
> 扫描日期: 2026-06-24（Phase A 落地 = 2026-06-23，当前约 **Day1**）
> 关键词: `stage` · `contract_won` · `won`/`lost` · `final_status` · `current_milestone` · `lead_milestones` · `trg_lead_won`
> 扫描范围: `src/` · `supabase/` · `docs/`
> Schema Authority: `docs/crm-v3/03_ARCHITECTURE_RULES.yaml`（rule_007 / rule_014 / rule_015 / rule_008 / rule_011）

---

## 0. 背景与口径

CRM v3 的真相源迁移（rule_007/014/015）：
- **过程指标** → `leads.current_milestone`（由 `lead_milestones` 表 + trigger `trg_check_milestone_order` 维护）
- **结果指标** → `leads.final_status`（仅 `'won'` / `'lost'`）
- **旧字段** `leads.stage` → 进入退役期：`rule_008` 读兼容 → `rule_011` **Day30（≈2026-07-23）停写** → **Day60（≈2026-08-22）删列**。

`src/lib/milestones.ts:deriveStage()` 当前为 **dead code**（零引用），签名 `deriveStage(milestoneCount: number)` 只吃计数、不接受 `milestones[]` 也不接受 `final_status`，无法表达 won/lost —— **退役链条卡在这一环**。本清单假设 P4（`milestones.ts` 重构 + 正确的 `deriveStage`）将先于本清单的大部分改动完成。

**动作列取值定义：**

| 动作 | 含义 |
|------|------|
| **删除** | 可安全删除（纯展示且无业务依赖，或 Day45 已过） |
| **改 final_status** | won/lost 结果判定应改为读/写 `final_status` |
| **改 current_milestone** | 过程判定应改为读 `current_milestone` |
| **改 deriveStage** | 显示用 stage 应通过重构后的 `deriveStage` 推导 |
| **保留（Day45）** | stage 只读展示，过渡期结束（≈2026-08-07）后删除 |
| **保留（其他）** | 有业务原因必须保留（已标注原因） |

> 时间线参考：今天 Day1。`won`/`lost` 的**写入**当前即可迁（见 §2）；**过程读**建议先做 `deriveStage` 再迁；**纯展示读**保留至 Day45。

---

## 1. 总览

- **总命中文件数**: 约 **48 个**（业务代码 26 + migration 17 + 文档 5）
- **API 路由**: **15 个文件**
  - 直读/直写 `stage`（须改）: `convert`、`hermes/generate-quote`、`quotations/generate`、`pipeline-funnel`、`sales-load`、`team-performance`、`workbench`、`lead-health`、`lead-sources`、`ads-roi`、`weekly-trends`、`follow-up-overdue`、`notify`、`cron/check-overdue-followups`
  - 已合规（用 `current_milestone`/`final_status`）: `metrics/funnel`、`metrics/daily`、`command-center`、`leads/[id]/milestone`、`cron/daily-funnel-snapshot`
- **UI 页面**: **13 个文件**（`pipeline`、`dashboard`、`leads`、`leads/[id]`、`settings`、`settings/ads`、`ads`、`contracts/new`、`quotes/quotes-client`、`quotes/quote-detail-dialog`、`workbench` + analytics 4 组件 `SalesLoad`/`LeadHealth`/`PipelineFunnel`/`TeamPerformance`/`LeadSources`，外加 `components/lead-workflow.tsx`）
- **Migration / DB**: **17 个文件**
- **库函数**: **2 个文件**（`src/lib/milestones.ts`、`src/lib/i18n/translations.ts`）

**写入点（Day30 前必须迁完）**: 8 个业务写入点 + 3 个 SQL trigger 函数
**读取点**: ~30 处 won/lost 判定 + 2 处漏斗/管道过程聚合
**待删除**: 0 个可立即删；`trg_lead_won` 为**高风险不可删**（见 §4/§6 风险点）

---

## 2. 必须改的写入点（改 `final_status` 或 milestone）

> 优先级最高。`stage` 一旦停写（Day30），这些点不改则业务断流。按业务关键度排序。

| # | 文件 | 行号 | 关键词 | 读/写 | 上下文 | 动作 |
|---|------|------|--------|------|--------|------|
| W1 | `src/app/api/quotations/[id]/convert/route.ts` | 152 | `contract_won` | **写** | 转合同 `leads.update({ stage:"contract_won" })`，**不写 `final_status='won'`**（rule_007 违规，与 P5 叠加） | **改 final_status** → `final_status:'won'`（删 stage 写入；保留 `updated_at`） |
| W2 | `src/app/(dashboard)/leads/[id]/page.tsx` | 261 / 270 | `won` | **写** | `updateStage("won")`（handleWon），仅更新 stage，**依赖 trigger `trg_lead_won` 建合同/分期/项目** | **改 final_status** → 写 `final_status:'won'`；**注意** trigger 联动（见 §6 风险点 R1） |
| W3 | `src/app/(dashboard)/leads/[id]/page.tsx` | 261 / 481 | `lost` | **写** | `updateStage("lost")`（lost 按钮） | **改 final_status** → `final_status:'lost'` |
| W4 | `src/app/(dashboard)/leads/page.tsx` | 320 / 341 | `stage` | **写** | 列表页改 stage：`updates={stage:newStage, ...}` + `supabase.update(updates)`，触发 `lead_stage_change` 通知 | **改 current_milestone**（过程态走 milestone 推进）；won/lost 分支走 `final_status` |
| W5 | `src/app/(dashboard)/leads/page.tsx` | 397-398 | `lost` | **写** | `update({ lost_reason:reason, stage:"lost" })`（记录丢单原因） | **改 final_status** → `stage:"lost"` 改 `final_status:"lost"`，`lost_reason` 保留 |
| W6 | `src/app/(dashboard)/pipeline/page.tsx` | 322 / 337 | `stage` | **写** | 看板拖拽 `updates={stage:targetStage, last_contact_date}` + `supabase.update`，并写 `stage_change` 事件 | **改 current_milestone**（拖拽改为里程碑推进）；won/lost 拖拽改 `final_status`；详见 §6 R2 |
| W7 | `src/app/api/quotations/generate/route.ts` | 159-168 | `stage` | **写** | `// 7. Update lead stage` → `stage:"quotation_submitted"` | **改 current_milestone** → 改为 INSERT `quotation` milestone（经 `canCompleteMilestone` 校验，让 trigger 刷 `current_milestone`） |
| W8 | `src/app/api/hermes/generate-quote/route.ts` | 266 | `stage` | **写** | `// 8. Update lead stage` → `stage:"quotation_submitted"`（分支 A） | **改 current_milestone** → INSERT `quotation` milestone |
| W9 | `src/app/api/hermes/generate-quote/route.ts` | 314 | `stage` | **写** | `// 8. Update lead stage to 'quotation_submitted'`（分支 B） | **改 current_milestone** → INSERT `quotation` milestone |

**SQL trigger 写/读 stage（写入链路的 DB 侧兜底，须协同迁移）：**

| 文件 | 行号 | 关键词 | 性质 | 动作 |
|------|------|--------|------|------|
| `supabase/migrations/20260603000001_fix_lead_won_trigger.sql` | 148-153 | `won`/`trg_lead_won` | **定义** | `AFTER UPDATE OF stage WHEN NEW.stage='won'` → `on_lead_won()`（**建合同+分期+项目+事件**）。**不可删** —— 见 §4/§6 R1，须改触发列为 `final_status` |
| `supabase/migrations/20260604000002_auto_lead_status.sql` | 7 / 40 | `won`/`lost` | **读** | `IF NEW.stage IN ('won','lost') THEN` 保持 lead_status 不变 | **保留（其他）**：auto-status 逻辑读 stage 判断终态；stage 列删后需改读 `final_status` |
| `supabase/migrations/20260604000004_fix_schema.sql` | 234-309 | `lost` | **读**（trigger `on_lost`） | `WHEN NEW.stage='lost'` → 自动置 `lost_reason_*` 布尔；离开 lost 则清零 | **改 final_status**：触发条件改 `NEW.final_status='lost'`（与 W5 协同） |

---

## 3. 必须改的读取点（改 `current_milestone` 或 `final_status`）

### 3a. won/lost 结果判定 → 改 `final_status`

| # | 文件 | 行号 | 关键词 | 读/写 | 上下文 | 动作 |
|---|------|------|--------|------|--------|------|
| R1 | `src/app/(dashboard)/dashboard/page.tsx` | 277 / 291 / 309 / 341 / 394 | `won`/`lost` | 读 | 5 处 `.not("stage","in",'("won","lost")')`（管道/活跃 lead 过滤） | **改 final_status** → `.is('final_status',null)`（参考 `metrics/daily/route.ts:39` 合规写法） |
| R2 | `src/app/(dashboard)/dashboard/page.tsx` | 499 / 612 | `won`/`lost` | 读 | `active.filter(l => !["won","lost"].includes(l.stage))` | **改 final_status** |
| R3 | `src/app/(dashboard)/dashboard/page.tsx` | 504 / 530 / 533 / 563 / 596 / 613 | `won` | 读 | `l.stage === "won"`（本月成交、来源 won 计数、我的 won lead） | **改 final_status** |
| R4 | `src/app/(dashboard)/dashboard/page.tsx` | 513-514 | `won` | 读 | `stageCounts.won` 转化率分母 | **改 final_status**（统计源切 `final_status`） |
| R5 | `src/app/api/dashboard/sales-load/route.ts` | 79 / 136 | `won`/`lost` | 读 | `!["won","lost"].includes(l.stage)`（活跃 lead 过滤） | **改 final_status** |
| R6 | `src/app/api/dashboard/team-performance/route.ts` | 75 / 166 | `won` | 读 | `l.stage === "won"`（来源 won 计数） | **改 final_status** |
| R7 | `src/app/api/dashboard/team-performance/route.ts` | 86 / 171 | `won` | 读 | `myLeads.filter(l => l.stage === "won")`（销售 won 数） | **改 final_status** |
| R8 | `src/app/api/dashboard/team-performance/route.ts` | 88 / 182 | `won`/`lost` | 读 | `!["won","lost"].includes(l.stage)`（活跃 lead） | **改 final_status** |
| R9 | `src/app/api/workbench/route.ts` | 36 | `won`/`lost` | 读 | `.or("...stage.not.in.(won,lost),current_milestone.not.in.(won,lost)")`（混用两源） | **改 final_status** → 统一为 `final_status.is.null`；移除 stage 分支 |
| R10 | `src/app/api/workbench/route.ts` | 29 | `stage` | 读 | inbox 列 `select("...,stage,current_milestone,...")` | **改 current_milestone**：select 去 `stage`（保留 `current_milestone`），展示用 deriveStage |
| R11 | `src/app/api/dashboard/lead-health/route.ts` | 63 | `won`/`lost` | 读 | `.or("...not.stage.in.(won,lost)")`（健康判定排除终态） | **改 final_status** |
| R12 | `src/app/api/leads/follow-up-overdue/route.ts` | 31 | `won`/`lost` | 读 | `.not("stage","in",'("won","lost")')`（逾期检测排除终态） | **改 final_status** |
| R13 | `src/app/api/cron/check-overdue-followups/route.ts` | 30 | `won`/`lost` | 读 | `.not("stage","in",'("won","lost")')`（cron 逾期排除终态） | **改 final_status** |
| R14 | `src/app/api/dashboard/ads-roi/route.ts` | 67 / 76 / 78 / 133-134 | `won` | 读 | `lead.stage === "won"`（Meta 广告 ROI 转化数） | **改 final_status** |
| R15 | `src/app/api/dashboard/lead-sources/route.ts` | 89 | `won` | 读 | `l.stage === "won"`（来源转化计数） | **改 final_status** |
| R16 | `src/app/api/dashboard/weekly-trends/route.ts` | 132 | `won` | 读 | `newLeads.filter(l => l.stage === "won")` | **改 final_status** |
| R17 | `src/app/(dashboard)/ads/page.tsx` | 96-97 | `won` | 读 | `l.stage === "won"`（ads 报表 won 计数） | **改 final_status** |
| R18 | `src/app/(dashboard)/settings/ads/page.tsx` | 55-60 | `won` | 读 | `["quotation_submitted",...,"won"].includes(l.stage)` + `l.stage === "won"` | **改 final_status**（won 判定）；过程判定见 §3b |
| R19 | `src/app/(dashboard)/contracts/new/page.tsx` | 61 | `won` | 读 | `.in("stage", ["won","quotation_submitted","negotiation","pending_decision"])`（可选合同 lead） | **改 final_status/current_milestone**：won → `final_status='won'`；其余 → `current_milestone` |
| R20 | `src/app/api/notify/route.ts` | 208 | `won`/`lost` | 读 | `importantStages = ["won","lost","negotiation","quotation_submitted"]`（通知分级） | **改 final_status/current_milestone**：won/lost 看 `final_status`，过程态看 `current_milestone` |

### 3b. 过程判定（漏斗/管道聚合）→ 改 `current_milestone` / `deriveStage`

| # | 文件 | 行号 | 关键词 | 读/写 | 上下文 | 动作 |
|---|------|------|--------|------|--------|------|
| P1 | `src/app/api/dashboard/pipeline-funnel/route.ts` | 52 | `stage` | 读 | `select("id,stage,...")` | **改 current_milestone** → select `current_milestone, final_status` |
| P2 | `src/app/api/dashboard/pipeline-funnel/route.ts` | 73 | `stage` | 读 | `const s = l.stage \|\| "new"`（漏斗按 stage 分组）—— **违反 rule_015**；`metrics/funnel/route.ts:38` 已合规 | **改 current_milestone** → 改 `normalizeMilestone(l.current_milestone)`，won/lost 走 `final_status`（参照 `metrics/funnel/route.ts:50`） |
| P3 | `src/app/api/dashboard/pipeline-funnel/route.ts` | 173 | `lost` | 读 | business_events `to_stage === "lost"`（"我在哪丢最多"） | **保留（其他）**：读的是**历史事件流** `stage_change`，非当前 lead 状态；stage 列删后业务事件仍可保留 `to_stage` 文本，无需改 |
| P4 | `src/app/(dashboard)/dashboard/page.tsx` | 494 / 499 | `stage` | 读 | 管道聚合 `l.stage === key` | **改 deriveStage**：按 `deriveStage(milestones, final_status)` 桶分 |

### 3c. 已合规（无需改，作为迁移参照样板）

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/app/api/metrics/funnel/route.ts` | 40 / 50-53 | select `current_milestone, final_status`；won/lost 走 `final_status`，否则 `normalizeMilestone(current_milestone)` ✅ |
| `src/app/api/metrics/daily/route.ts` | 39 / 44 / 51 | `.is('final_status',null)` / `.eq('final_status','won'/'lost')` ✅ |
| `src/app/api/command-center/route.ts` | 48 / 59 / 80 | `.is('final_status',null)` + `lead_milestones` ✅ |
| `src/app/api/leads/[id]/milestone/route.ts` | 43 / 52 / 88 | select `current_milestone, final_status`；rule_007 阻断 won/lost 推 milestone ✅ |
| `src/app/api/cron/daily-funnel-snapshot/route.ts` | 26 / 35-36 | 按 `current_milestone` 分组 ✅ |
| `src/app/api/workbench/route.ts` | 63 / 69 / 75 | progress 面板按 `current_milestone` 聚合 ✅（但同文件 29/36 行仍读 stage，见 R9/R10） |

---

## 4. 需要删除的旧代码

| 对象 | 位置 | 性质 | 动作 |
|------|------|------|------|
| `trg_lead_won` trigger | `supabase/migrations/20260603000001_fix_lead_won_trigger.sql:148-153` | 定义：`AFTER UPDATE OF stage WHEN NEW.stage='won'` | ⛔ **不可直接删除** — 该 trigger 承担「won→自动建合同+3分期+项目+事件+活动」的核心自动化（`on_lead_won()` 函数体 `:96-145`）。`handleWon()`（`leads/[id]/page.tsx:265-270`）仅写 stage、**完全依赖此 trigger**。若 won 迁到 `final_status`，trigger 触发条件失效 → 自动建合同断流。**处置**: 改 `WHEN (NEW.final_status='won')`（列改 final_status），函数体不变；勿删。见 §6 R1 |
| `on_lead_won()` 函数 | `supabase/migrations/20260603000001_fix_lead_won_trigger.sql:96-145` | 定义 | 同上，**保留**，仅改触发时机 |
| `on_lost()` trigger 函数 | `supabase/migrations/20260604000004_fix_schema.sql:234-309` | 读：`WHEN NEW.stage='lost'` 置 `lost_reason_*` | **改 final_status**，非删除 |
| stage 注释引用 | `src/app/(dashboard)/leads/[id]/page.tsx:269` | 读（注释） | 注释 "by the DB trigger trg_lead_won" —— trigger 改造后同步更新注释 |

> ⚠️ **本扫描未发现任何可「立即安全删除」的 stage 代码**。所有 stage 读取要么有业务依赖（统计/过滤/展示），要么处于 Day45 保留期。`trg_lead_won` 尤其危险 —— 删除会导致成交自动建合同功能静默失效。

---

## 5. 保留（Day45 展示，≈ 2026-08-07 后可删）

> 这些是**纯展示用** stage 读取（颜色映射、标签、列定义），不影响业务判定。按 rule_008，过渡期保留 stage 文本展示至 Day45，期间显示值应由重构后的 `deriveStage(milestones, final_status)` 提供（读 stage 列仅为兼容旧数据）。

| 文件 | 行号（示例） | 用途 | 动作 |
|------|------|------|------|
| `src/app/(dashboard)/leads/[id]/page.tsx` | 34 / 39-40 / 463 / 477 / 482 / 491 / 845 / 1325 | STAGES 数组、颜色、stage 选择器、won/lost 展示块、lost reason 区 | **保留（Day45）**；详情页 stage 文本展示 |
| `src/app/(dashboard)/leads/page.tsx` | 31-32 / 43-44 / 274-275 / 280 / 715 / 742 / 908 | 看板列定义、颜色、win_probability 映射、TERMINAL_STAGES、lost reason | **保留（Day45）**；列定义最终随看板重写（见 W6） |
| `src/app/(dashboard)/pipeline/page.tsx` | 31-39 / 65-70 / 264-268 / 284 / 486 / 513-516 / 543-544 | STAGES 列、stale/crit 判定（65-67 判定**兼读**：见 §3 R9/R10）、TERMINAL | **保留（Day45）** 列定义；65-67/515 的 `!["won","lost"]` **判定部分**应先迁 `final_status` |
| `src/app/(dashboard)/dashboard/page.tsx` | 44 / 48 | STAGE_KEYS、颜色映射 | **保留（Day45）** |
| `src/app/(dashboard)/settings/page.tsx` | 29-30 / 232 / 394-395 | STAGES、activeUnassigned 过滤、stage 颜色 | **保留（Day45）**；232 行 `!["won","lost"]` 判定迁 `final_status` |
| `src/app/(dashboard)/settings/ads/page.tsx` | 45-74 | STAGES 数组 + 颜色 | **保留（Day45）** |
| `src/app/(dashboard)/ads/page.tsx` | 79-223 | ads 报表分组/展示 | **保留（Day45）**（won 计数部分见 R17） |
| `src/app/(dashboard)/analytics/_components/SalesLoad.tsx` | 56 / 67-68 / 79-80 | stage 序列/标签/颜色 | **保留（Day45）** |
| `src/app/(dashboard)/analytics/_components/PipelineFunnel.tsx` | 45-70 / 252-266 / 330 | 颜色/标签/lost 小图例 | **保留（Day45）** |
| `src/app/(dashboard)/analytics/_components/LeadHealth.tsx` | 63-64 / 76-77 / 299 | stage 标签/颜色 | **保留（Day45）** |
| `src/app/(dashboard)/analytics/_components/TeamPerformance.tsx` | 36 | `won: number` 类型 | **保留（Day45）**（数据源在 API，见 R6-R8） |
| `src/app/(dashboard)/analytics/_components/LeadSources.tsx` | 13 / 30 / 186-211 | `won` 字段展示 | **保留（Day45）**（数据源在 API，见 R15） |
| `src/app/(dashboard)/quotes/quotes-client.tsx` | 279 | STAGE_ORDER（报价排序） | **保留（Day45）** |
| `src/app/(dashboard)/quotes/quote-detail-dialog.tsx` | 64 / 66 | `won` 颜色 + QUOTE_STATUSES | **保留（其他）**：`quotations.status` 表的 `won`（合同状态枚举），**非 lead stage**，独立保留 |
| `src/app/(dashboard)/workbench/page.tsx` | 46-47 | milestoneColors 映射 | **保留（Day45）** |
| `src/components/lead-workflow.tsx` | (多处) | 工作流组件 stage 展示 | **保留（Day45）** |
| `src/lib/i18n/translations.ts` | 136 / 455 / 675-702 / 770 / 1408 / 1727 / 1947-1974 / 2493 | `stageLabels.won/lost`、`pipeline.stageWon/Lost` 多语言 | **保留（Day45）**；标签复用于 deriveStage 展示 |

---

## 6. 总结

### 预计改动文件数

| 类别 | 文件数 | 说明 |
|------|--------|------|
| 写入点（Day30 前） | **5 业务 + 1 SQL trigger** | convert / leads[详情] / leads[列表] / pipeline / quotations+hermes（合并计 1）；`on_lead_won`/`on_lost` trigger 改造 |
| 读取点 won/lost（→ final_status） | **11 API + 2 页面** | dashboard/sales-load/team-performance/workbench/lead-health/follow-up-overdue/overdue-cron/ads-roi/lead-sources/weekly-trends/notify + ads/settings-ads/contracts-new |
| 读取点过程（→ current_milestone） | **3 处** | pipeline-funnel（52,73）、dashboard 管道聚合（494,499）、workbench select（29） |
| 前置依赖 | `src/lib/milestones.ts` | 重构 `deriveStage`（P4，签名 `→ (milestones[], finalStatus?)`） |
| **合计需改业务文件** | **约 20 个** | + 2 个 trigger migration + Day45 后再清 §5 展示层 |

### 顺序建议

1. **P4 先行** —— 重构 `src/lib/milestones.ts:deriveStage`（接受 milestones 数组 + final_status），补单测。否则 §3b 的「改 deriveStage」无处落地。
2. **写入先行于读取**（Day30 红线是「停写」）：
   - **W1** convert → `final_status='won'`（与 P5 合并，且**必须同步改 `trg_lead_won`** 触发列为 `final_status`，见 R1 风险）
   - **W2/W3** 详情页 won/lost → `final_status`（W2 强依赖 trigger 改造）
   - **W7/W8/W9** 报价生成（generate / hermes）→ INSERT `quotation` milestone
   - **W4/W5/W6** 列表页 / 看板拖拽 → milestone 推进 + won/lost 走 final_status
3. **读取批量迁**（§3a R1-R20）—— won/lost 判定统一换 `final_status`；可按文件并行。
4. **过程聚合迁**（§3b P1/P2/P4）→ `current_milestone` / `deriveStage`。
5. **Day45 后** 清 §5 纯展示层 + 移除 `select stage` 残留。
6. **Day60** 删 `leads.stage` 列（含改 §2 残留 trigger `NEW.stage` 引用、`auto_lead_status`、init/final 等 migration 的 CHECK 约束）。

### 风险点

- **🔴 R1 — `trg_lead_won` 是 load-bearing，不可删**：`on_lead_won()` 自动建合同+3分期+项目+业务事件+活动（`20260603000001_fix_lead_won_trigger.sql:96-145`）。`leads/[id]/page.tsx:265-270 handleWon()` 仅写 stage、**完全依赖此 trigger** 完成「成交自动化」。won 迁 `final_status` 时**必须**把触发条件 `WHEN (NEW.stage='won')` 改为 `WHEN (NEW.final_status='won')`，否则自动建合同静默断流。改前需回归「报价→转合同/成交」全链路。
- **🟠 R2 — 看板拖拽语义变化**：当前 `pipeline/page.tsx` 拖拽直接写 `stage`（任意前后跳）。改为里程碑推进后须遵守 `canCompleteMilestone` 的「不跳级/不回退」约束，UX 上「拖到 won/lost 列」要改为独立按钮（写 final_status）。涉及 `STAGE_INDEX`/`canRevert` 守卫逻辑（`:287-297`）重写。
- **🟠 R3 — `final_status` 数据完整性前提**：§3a 批量迁 won/lost 读取前，**P5 的 won 回填 migration 必须先在生产跑通**（`20260624000002_fix_won_lost_migration.sql` 已补 `final_status='won'` + won 的 7 步 milestone + `current_milestone='meeting'`，但属未提交新文件，需先 review + dev 验证）。否则历史 won 线索 `final_status IS NULL`，迁后统计直接归零。**验证 SQL**: `SELECT stage, final_status, COUNT(*) FROM leads WHERE stage='won' GROUP BY 1,2;`
- **🟡 R4 — won/lost 双源并存期**：`workbench/route.ts:36` 现已 `.or(stage.not.in.(won,lost), current_milestone.not.in.(won,lost))` 两源并用。迁移期需明确「两源任一命中终态即排除」，避免某源漏判导致终态 lead 混入活跃池。
- **🟡 R5 — `quotations.status` 的 `won` 与 lead stage 同名易混**：`quote-detail-dialog.tsx:66` 的 `QUOTE_STATUSES` 含 `won` 属**报价/合同状态枚举**（`20260612000000_contract_pipeline_v1.sql:95` 的 CHECK），与 lead stage 无关，迁移时**勿误改**。
- **🟡 R6 — `business_events.to_stage` 历史文本**：`pipeline-funnel/route.ts:173` 读 `to_stage='lost'` 是历史事件流，stage 列删除后该文本字段不受影响（P3 保留），但须确认新事件落库时仍写 `to_stage` 文本。

### 与既有计划的关系

本清单聚焦 **P3（stage 退役）**，与 `docs/crm-v3/phase-b-scan-plan.md` 的 **P3/P4/P5** 高度重叠：
- 本清单 §2 写入点 = phase-b P3 的「stage 直写」+ P5 的 convert
- 本清单 §3b = phase-b P3 的「stage 直读」
- 本清单 §6 R3 = phase-b P5 的 won 回填缺口（已被新 migration `20260624000002` 覆盖）
- 本清单 §4 = phase-b P5 第 4 步「评估旧 trigger」

**建议作为 phase-b P3/P4/P5 的执行清单**，按 §6 顺序推进。
