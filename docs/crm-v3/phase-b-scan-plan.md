# Phase B 扫描报告 — 实施计划

> 产出者: GLM 5.2 (Coding Plan) · 只读审计，未修改任何源码、未 build / deploy
> 审计日期: 2026-06-24（Phase A 落地 = 2026-06-23，当前约 Day1）
> Schema Authority: `03_ARCHITECTURE_RULES.yaml`
> 引用约定: 所有 `文件:行号` 均已逐行核对源码，非推测

---

## 总体评估

| 维度 | 结论 | 说明 |
|------|------|------|
| 代码与 PRD 一致性 | ⚠️ | 销售工作台**数据结构断裂**（Phase A 核心交付物“销售能按工作流工作”未达成）；PRD 3.2 的工作台分区与实际 API 不一致 |
| 代码与 ARCH_RULES 一致性 | ⚠️ | rule_016（待跟进只看 tasks）3 处违规；rule_014/015（deriveStage 集中且替代 stage）完全未落地（dead code）；rule_007（won/lost 迁移）`won` 缺口；rule_102（API 不用 service_role）多处违规 |
| 主要发现数 | **14** | 见下各 P 项 |
| 预计工作总量 | **中** | P1/P6 可单点速修；P2/P3/P5 需多文件协同；P4 为校准；P7 仅登记 |

**最严重 3 项（建议优先）：**
1. **P1** — 工作台前后端数据结构不匹配 → 销售登录后四块面板全空（`panels` 包裹 vs 扁平数组）
2. **P6** — `/api/quotations/generate` 用 service_role 且**无归属校验** → 任意登录用户可给任意 lead 生成报价（IDOR）
3. **P5** — `won` 线索迁移缺口 → 生产 `stage='won'` 的线索既无 `final_status` 也无 milestone，漏斗/看板失真

---

### P1: Workbench API 数据结构修复

**状态:** ❌（前后端契约断裂，直接导致销售页面空数据）

**影响文件:**
- `src/app/api/workbench/route.ts:82-91` — API 把数据包在 `panels.{inbox,tasks,overdue,progress}` 里，每个面板是 `{label, count, items}` 对象；`progress` 是 `Record<string, number>`（milestone→计数）
- `src/app/(dashboard)/workbench/page.tsx:107-110` — 前端读取扁平的 `data?.inbox / data?.tasks / data?.overdue / data?.progress`，且接口（`page.tsx:33-38`）声明它们是**数组**
- `src/app/(dashboard)/workbench/page.tsx:27-31` — `ProgressGroup` 期望 `{current_milestone, count, percentage}` 数组，与 API 返回的对象结构不兼容

**根因:**
API 与前端是两个独立 Epic 分别实现、未对齐契约。API 返回 `{ panels: {...} }`，前端 `data?.inbox` 恒为 `undefined` → `?? []` 兜底 → **四块面板全部显示空状态**。即使解开 `panels` 包裹，`progress` 的“对象 vs 数组”仍是第二处断裂。

> 附带（非阻塞，已排除）：曾怀疑 tasks 查询选了不存在的 `status`/`source` 列。核对 `supabase/migrations/20260623020000_crm_v3_new_tables.sql:42-43` —— `tasks` 表**确有** `status`/`source` 列，该查询合法，非空数据根因。

**修复方案:**
1. **统一契约（推荐改 API 端，前端少动）**：在 `workbench/route.ts:82-91` 返回扁平结构 ——
   - `inbox: inboxItems ?? []`、`tasks: tasksItems ?? []`、`overdue: overdueItems ?? []`
   - `progress` 改为前端期望的 `ProgressGroup[]`：把 `Record` 转成 `Object.entries(progress).map(([current_milestone, count]) => ({ current_milestone, count, percentage: ... }))`，并补 `percentage` 计算（占总数百分比）
2. （可选）保留 `label/count` 时，前端改为读 `data?.panels?.inbox?.items`；但需同步修 `progress` 形状。**二选一即可，不要两边各改一半。**
3. **验证方法**: 登录任一销售账号（有 assigned lead + 有 pending task），打开 `/workbench`，确认 Inbox/Tasks/Overdue/Progress 四块均出数；浏览器 DevTools 看 `/api/workbench` 200 且 `json.inbox` 为数组。

**改动风险:** 小 —— 单文件改动（API 或前端其一），无 DB 迁移、无 RLS。回归面仅工作台一页。

---

### P2: tasks 成为唯一待跟进真相源

**状态:** ⚠️（部分合规：tasks 已用于 Tasks/Overdue 面板；但“待跟进/今日跟进/逾期”判定仍混用 `leads.next_followup_date`，违反 rule_016）

**影响文件（违规 — 用 `next_followup_date` 判定待跟进/逾期）:**
- `src/app/api/workbench/route.ts:36-37` — Inbox 面板用 `next_followup_date.lte.${today}` 判定“Needs Follow-up”（rule_016 违规；同时也是 P1 的数据源）
- `src/app/api/command-center/route.ts:120,126` — “今日跟进”用 `.eq('next_followup_date', todayStr)`
- `src/app/api/cron/check-overdue-followups/route.ts:29,31,57` — 逾期检测读 `next_followup_date`，并据此算逾期天数

**影响文件（合规 — 已用 tasks）:**
- `src/app/api/workbench/route.ts:44-60` — Tasks / Overdue 面板查 `tasks`（`assignee_id=user.id, status='pending'`，overdue 加 `due_at<now`）✅
- `src/app/api/command-center/route.ts:114-118` — 逾期计数查 `tasks.due_at<now` ✅
- `src/app/api/cron/daily-reminder/route.ts:22-33` — 今日提醒查 `tasks.due_at` ✅
- `src/app/api/metrics/daily/route.ts:61-70` — pending/overdue 计数查 `tasks` ✅

**根因:**
Phase A 同时存在两套“待跟进”真相源：**新源 `tasks`**（Tasks/Overdue 面板）+ **旧源 `leads.next_followup_date`**（Inbox/今日跟进/逾期 cron）。rule_016 明确禁止后者用于跟进判定 —— 三套源（含 follow_up_logs）必有同步问题，且当前已出现“同一销售 Tasks 面板有数、Inbox 面板空”的不一致。

**修复方案:**
1. `workbench/route.ts` Inbox 面板：改为查 **当前用户名下、有未完成 task 的 lead**（`tasks WHERE assignee_id=user.id AND status='pending'` JOIN leads），或直接与 Tasks 面板合并。删除 `next_followup_date` 读取。
2. `command-center/route.ts:120-126`：“今日跟进”改为 `tasks WHERE assignee_id IN (团队) AND due_at::date = today AND status='pending'`。
3. `cron/check-overdue-followups/route.ts`：整体改为查 `tasks WHERE status='pending' AND due_at<now`，逾期天数 = `now - tasks.due_at`。
4. `next_followup_date` 列**保留可写可显示**（lead 详情页 `leads/[id]/page.tsx:748-751`、列表页展示），但**禁止用于任何跟进/逾期判定**。
5. **验证方法**: 造一条 lead：`next_followup_date=今天` 但**无** task → 修复后 Inbox/今日跟进/逾期均**不应**出现它；再造一条有 pending task、`due_at` 已过 → Overdue 与逾期 cron 必须命中。

**改动风险:** 中 —— 涉及 1 个 API + 1 个 cron + 1 个看板 API 的查询逻辑改写；须保证 cron 仍能产生逾期通知（业务连续性）。无 schema 变更。

---

### P3: stage 退出主逻辑

**状态:** ⚠️（milestone 机制已建表并有 trigger，但 `deriveStage()` 为 **dead code**，业务逻辑仍大量直读/直写 `stage`；rule_014/015 未达成）

**核心缺陷:**
- `src/lib/milestones.ts:25-29` — `deriveStage(milestoneCount: number)` 签名错误：只吃**计数**，**不接受 milestones 数组也不接受 final_status** → 无法表达 won/lost（PRD/ARCH 要求 won/lost 由 `final_status` 推导）。
- 全仓 grep 确认：**`deriveStage` 零引用**（仅 `canCompleteMilestone` 被引用，见 `src/app/api/leads/[id]/milestone/route.ts:3`）。即 rule_014“三处引用同一函数”完全未落地。

**影响文件（stage 直读 — 业务逻辑，rule_015 违规）:**
- `src/app/api/dashboard/pipeline-funnel/route.ts:52,73` — 漏斗按 `l.stage` 分组聚合（`const s = l.stage || "new"`）；本应按 `current_milestone`（见 `metrics/funnel/route.ts:38` 已合规）
- `src/app/(dashboard)/dashboard/page.tsx:494,499` — `l.stage === key`、`!["won","lost"].includes(l.stage)` 管道聚合
- `src/app/api/dashboard/sales-load/route.ts:79` 与 `team-performance/route.ts:88` — `!["won","lost"].includes(l.stage)` 过滤活跃 lead
- `src/app/api/workbench/route.ts:29,36` — select 含 `stage`，`.or(...stage.not.in.(won,lost)...)`

**影响文件（stage 直写 — 业务写入，须 Day30 前停止）:**
- `src/app/api/quotations/generate/route.ts:166-172` — 报价生成写 `stage='quotation_submitted'`
- `src/app/api/hermes/generate-quote/route.ts:266,314` — Hermes 报价写 `stage='quotation_submitted'`
- `src/app/api/quotations/[id]/convert/route.ts:152` — 转合同写 `stage='contract_won'`（**注意**：与 P5 叠加 —— 这里写的是 stage 而非 `final_status='won'`）
- `src/app/(dashboard)/pipeline/page.tsx:322,337` — 看板拖拽改 stage（UI 写入）

**影响文件（合规 — 已用 milestone/current_milestone）:**
- `src/app/api/metrics/funnel/route.ts:38` — 按 `current_milestone` 分组 ✅
- `src/app/api/command-center/route.ts:80`、`src/app/api/cron/daily-funnel-snapshot/route.ts:26` — 用 milestone ✅

**根因:**
`deriveStage` 设计时按“计数→stage”写，未对齐 milestone 数组 + final_status 的真实输入，导致没人能正确调用它 → 业务被迫继续读 `stage`。stage 退役链条（rule_008 读兼容→Day30 停写→Day60 删列）卡在“没有可用的 deriveStage”这一环。

**修复方案:**
1. 重写 `src/lib/milestones.ts:deriveStage` —— 入参改为 `(milestones: {key,completed_at}[], finalStatus?: 'won'|'lost')`，内部按 `MILESTONE_KEYS`（剔除 `'new'`/`'negotiation'`，见 P4）计数并映射，`finalStatus` 优先返回 won/lost。补单测。
2. 把 **读** stage 的业务点迁移到 `deriveStage`：`pipeline-funnel`、`dashboard/page`、`sales-load`、`team-performance`、`workbench`。`won/lost` 判定改读 `final_status`。
3. 把 **写** stage 的业务点改为“完成对应 milestone + 让 trigger 刷 `current_milestone`”：`quotations/generate`、`hermes/generate-quote` 改为 INSERT `quotation` milestone（经 `canCompleteMilestone` 校验）；`convert` 改为设 `final_status='won'`（与 P5 合并修）；`pipeline` 拖拽改为里程碑推进。
4. **保留** `leads/[id]/page.tsx` 对 `stage` 的**只读展示**直至 Day45（rule_008）。
5. **验证方法**: `grep -rn "\.stage\b\|stage:" src/app/api src/app/\(dashboard\)` 复盘；建一 `stage='won'` 旧 lead，确认经 `deriveStage` 后漏斗归入“won”而非“new”；Day45 前详情页仍能看到 stage 文本。

**改动风险:** 中-大 —— 触及漏斗/看板/工作台/Hermes 多处核心读路径；须分批迁移并保证 Day45 前 stage 只读展示不破。无 schema 变更（列暂留）。

> ⚠️ **时间线提示**: rule_011 规定 Day30（≈2026-07-23）停写 stage、Day60（≈2026-08-22）删列。当前 Day1，stage 写入**暂不违规**，但 P3 是为 Day30 做的提前迁移准备，越早完成越安全。

---

### P4: milestone 禁止跳序

**状态:** ⚠️（校验**机制已存在**且双层防护 —— 应用层 + DB trigger；但 `MILESTONE_KEYS` 包含 `'new'` 导致**首步校准错误**）

**已有防护（合规）:**
- `src/lib/milestones.ts:36-69` — `canCompleteMilestone(completedKeys, targetKey)` 校验：无效 key、重复、往回、跳级（`targetOrder > maxCurrentOrder+1`）
- `src/app/api/leads/[id]/milestone/route.ts:75-82` — API 完成前调用 `canCompleteMilestone`，不合法返回 400；`:53` 还校验 won/lost lead 不可再完成 meeting（rule_007）
- `supabase/migrations/20260623020000_crm_v3_leads_extensions.sql`（trigger `check_milestone_order`，BEFORE INSERT）— DB 层兜底校验跳级/往回，并刷 `current_milestone`

**缺陷（需校准）:**
- `src/lib/milestones.ts:1-11` — `MILESTONE_KEYS = ['new','first_contact',...,'meeting','negotiation']`，把 **`'new'`(index 0)** 当成可完成里程碑。
- `src/lib/milestones.ts:50-55` — `canCompleteMilestone` 在 `currentMilestones.length===0` 时**只允许 `targetOrder===0`（即 'new'）作为首步**。而 PRD 的首个真实里程碑是 `first_contact`(order 1)。**后果**：全新 lead（无任何 milestone）通过 API 完成 `first_contact` 会被应用层判为“不能跳级”而拒绝；但 DB trigger（`last_key IS NULL` → 放行）允许 —— **应用层与 DB 层行为不一致**，新线索可能卡在“无法标记首次联系”。

**根因:**
`MILESTONE_KEYS` 混用了“stage 标签”（`new`/`negotiation`，用于 `deriveStage` 的计数映射）和“可完成里程碑”（`first_contact`...`meeting`）。两个语义挤进一个数组，污染了顺序校验的下标基准。

**修复方案:**
1. 拆分两个数组：`COMPLETABLE_MILESTONES = ['first_contact','basic_info','drawings','requirements','solution','quotation','meeting']`（PRD 4.1 的 7 个，不含 new/negotiation/closure）；`STAGE_LABELS` 单独保留给 `deriveStage`。
2. `canCompleteMilestone` 的“首步”判断改为：空集时允许 `first_contact`（order 0 in 新数组）；移除对 `'new'` 的特殊放行。
3. 确认 DB trigger `milestone_order()` 的 CASE 与新数组一致（同步移除/降级 `'new'`/`'negotiation'`，或保持但与应用层口径统一）。
4. **验证方法**: 新建 lead → 直接完成 `first_contact` 应成功（200）；尝试跳过 `basic_info` 直接 `drawings` 应 400；完成 `meeting` 前 `solution` 未完成应 400。

**改动风险:** 小-中 —— 改动集中在 `lib/milestones.ts` + 1 个 trigger 函数（需幂等 migration，rule_009）。须复核既有已迁移 lead 的 `current_milestone` 不受 `milestone_order` 重定义影响。

---

### P5: won/lost migration 补全

**状态:** ❌（`lost` 已迁移，`won` **完全漏迁**；且无 DB 级 milestone_key 约束兜底）

**影响文件 / 缺口:**
- `supabase/migrations/20260623030000_crm_v3_stage_to_milestone_mapping.sql:78-80` — **只有** `UPDATE leads SET final_status='lost' WHERE stage='lost'`；**缺失** `final_status='won' WHERE stage='won'` 的回填（DEV_PLAN:253-254 原本两段都有，落地时 won 被漏）
- 同文件 milestone INSERT（`:9-76`）所有 `WHERE stage IN (...)` 子句**均不含 `'won'`** → `stage='won'` 的线索**既无 final_status 也无任何 milestone**，且 `current_milestone` 停在 `'new'`（step 9 `:83-93` 因无 milestone 不更新）
- `supabase/migrations/20260623020000_crm_v3_new_tables.sql:7-16` — `lead_milestones` 表**无 `CHECK(milestone_key IN (...))`**（DEV_PLAN:67-71 原有，落地时删了）→ DB 层不拦截 `won/lost/closure` 被当 milestone 写入（rule_007 缺兜底）
- `src/app/api/quotations/[id]/convert/route.ts:148-152` — 转合同写 `stage='contract_won'`，**不写 `final_status='won'`**（rule_007 违规 + 与 P3 叠加）
- `supabase/migrations/20260603000001_fix_lead_won_trigger.sql` — 旧 trigger `trg_lead_won`（`AFTER UPDATE OF stage WHEN NEW.stage='won'`）仍存活，与新的 `final_status` 体系并存，可能双轨冲突

**根因:**
迁移脚本把 `won` 当“结果态”从 milestone 映射中剔除了（符合 rule_007“won 不进 milestone”），但**忘了把 won 同步写进 `final_status`** —— 即“剔除对了，补录漏了”。叠加 convert 流程只写 stage，导致生产 won 线索在 v3 模型里“隐形”。

**修复方案:**
1. **补迁移（幂等，rule_009）** `supabase/migrations/`：
   - `UPDATE leads SET final_status='won' WHERE stage='won' AND final_status IS NULL;`
   - 为 won 线索补过程 milestone（按 DEV_PLAN:204 口径：first_contact…meeting 全套，UNION ALL + `NOT EXISTS` 幂等），使其时间线可重建（rule_013）
   - 补 `current_milestone` 为 `meeting`（won 线索的最高过程态）
2. **加 DB 约束**：`ALTER TABLE lead_milestones ADD CONSTRAINT milestone_key_valid CHECK (milestone_key IN ('first_contact','basic_info','drawings','requirements','solution','quotation','meeting'));`（与 P4 的 COMPLETABLE 数组一致）
3. **改 convert 流程** `convert/route.ts:148-152`：删除 `stage='contract_won'` 写入，改为 `UPDATE leads SET final_status='won'`（视业务需要保留 stage 只读值，但**真相源切到 final_status**）。
4. **评估旧 trigger** `fix_lead_won_trigger.sql`：若 won 现由 `final_status` 表达，该 trigger 的触发条件（`stage='won'`）应废弃或改为监听 `final_status`，避免双写。需单独评审，勿盲目删。
5. **验证方法**: `SELECT stage, final_status, COUNT(*) FROM leads WHERE stage='won' GROUP BY 1,2;` 修复后 `final_status` 应全为 `won`；`SELECT COUNT(*) FROM lead_milestones lm JOIN leads l ON l.id=lm.lead_id WHERE l.stage='won';` 应 > 0 且含完整 7 步；漏斗（`metrics/funnel`）won 层计数应上升。

**改动风险:** 中 —— 涉及生产数据回填迁移（**必须先在 dev 跑通 + 抽样核对**，rule_010）与 convert 业务路径改动。回填为纯 INSERT/UPDATE 且幂等，风险可控；convert 改动需回归“报价→合同”全流程。

> ⚠️ **ARCH_RULES vs 生产冲突**: rule_007 声明 won/lost 只在 `final_status`；但生产 `stage='won'` 线索 `final_status IS NULL`。**文档（规则）与 Ground Truth（生产）不一致**，本项即消除该偏差。
> ⚠️ **DEV_PLAN vs migration 冲突**: DEV_PLAN:204/253-254 含 won 的完整映射，实际 `...mapping.sql` 漏掉 won。落地脚本偏离了设计档。

---

### P6: /api/quotations/generate 增加角色/所有权检查

**状态:** ❌（**P1 安全**：service_role + 零归属校验 = IDOR）

**影响文件:**
- `src/app/api/quotations/generate/route.ts:15-24,91` — `getSupabaseAdmin()` 构造 **service_role** client，所有 DB 操作（`:94,109,137,149,166`）均走它 → **rule_102 违规**（API 路由禁用 service_role）
- `src/app/api/quotations/generate/route.ts:94-98` — 仅 `.eq("id", lead_id).single()` 校验 lead 存在，**无 `assigned_to === user.id` 校验、无角色判断** → 任意已登录用户传任意 `lead_id` 即可为非自己的线索生成报价、改其 stage（`:166-172`）、写 activity/event（**水平越权 / IDOR**）
- 输入校验仅 `lead_id`/`devices` 非空（`:63-81`），未做归属

**对照（同仓已建立的正确模式）:**
- `src/app/api/leads/[id]/timeline/route.ts:32-43` — `MANAGEMENT_ROLES=[admin,boss,operator,manager]`，非管理角色须 `assigned_to === user.id` 才放行
- `src/app/api/quotations/export/route.ts:78-83` — 非 admin/boss 校验 `quote.leads.assigned_to === user.id`
- `src/app/api/quotations/calculate/route.ts:15`、`[id]/convert/route.ts:16` — 用 `createServerSupabase()`（合规）

**根因:**
该路由早期为“后台自动报价”设计，直接用 service_role 绕过 RLS，未补用户态归属校验；后续同类路由都加了 ownership，本路由漏网。

**修复方案:**
1. 删除 `getSupabaseAdmin()`，所有操作改用已有的 `supabase`（`createServerSupabase`，`:54` 已建）—— 让 RLS 生效（rule_101/102）。
2. 在 `:98` 之后、写库之前加归属校验（复用 timeline 模式）：
   ```ts
   const MANAGEMENT_ROLES = ["admin","boss","operator","manager"];
   const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
   if (!profile || !MANAGEMENT_ROLES.includes(profile.role)) {
     const { data: ownLead } = await supabase.from("leads")
       .select("id").eq("id", lead_id).eq("assigned_to", user.id).maybeSingle();
     if (!ownLead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
   }
   ```
3. lead 查询补选 `assigned_to`；`created_by`/`user_id` 继续用 `user.id`。
4. **验证方法**: 用销售 A 账号尝试给销售 B 的 `lead_id` POST `/api/quotations/generate` → 应 403；给自己的 lead → 200 且写入 quotations/activities 正常；管理员对任意 lead → 200。

**改动风险:** 小-中 —— 单文件改动；但 service_role→user client 后，所有写操作（quotations/activities/business_events/leads）都受 RLS 约束，须确认这些表对“销售+自己 lead”有 INSERT 策略（rule_101），否则会出现“校验过了但写不进去”的回归。**影响范围**: 报价生成、lead stage 推进、activity/event 记录。

> 🔒 **安全影响范围**: 当前漏洞可被任意登录销售利用，批量为他人的高质量线索生成报价、篡改其 `stage`，干扰他人 pipeline 与漏斗统计。属**必修 P1**。

---

### P7: Product Import service_role 安全债（只登记，不修）

**状态:** 登记（P1 安全债，Phase B 不修，仅记录位置与风险）

**位置:**
- `src/app/api/products/import/route.ts:152-159` — 有 **admin-only 角色校验**（`profile.role !== "admin"` → 403）✅
- `src/app/api/products/import/route.ts:161-166` — 用 `process.env.SUPABASE_SERVICE_ROLE_KEY` 构造 `adminClient` 做 bulk INSERT（**rule_102 违规**：API 路由用 service_role 绕过 RLS）
- 功能：CSV 上传 → 批量 upsert `products`（名称/类目/SKU/单价），`:201-227` 分批 100 条插入

**风险:**
- 直接风险**有限**（已有 admin 门槛，非 admin 不可达；products 表非客户敏感数据）。
- 真正风险是**规则一致性**（rule_102）与**攻击面扩散**：service_role 一旦因其他漏洞（如 XSS 偷 token + 提权到 admin）被利用，可无 RLS 约束地批量改写产品价格/目录。
- **同仓 service_role 扩散面（一并登记，供后续清债）**: 非 cron 的 API 路由使用 service_role 的还有 ——
  - `src/app/api/quotations/generate/route.ts`（见 P6，**本次修**）
  - `src/app/api/quotations/export/route.ts`（有归属校验，但仍是 service_role）
  - `src/app/api/activity/daily-report/route.ts`、`src/app/api/kpi/targets/route.ts`、`src/app/api/admin/impersonate/route.ts`、`src/app/api/users/route.ts`、`src/app/api/users/[id]/password/route.ts`
  - `src/app/api/auth/change-password/route.ts`（**疑似无角色校验即用 service_role 改密，风险高于 import**）
  - `src/app/api/leads/meta-capi/route.ts`（外部 webhook，仅校验 webhook secret、无 JWT）
  - 合规用法（cron）：`src/app/api/cron/*`（rule_102 允许）

**处置建议（不在 Phase B 执行）:**
- 后续建立“API 路由禁用 service_role”的 CI 检查（grep `SUPABASE_SERVICE_ROLE_KEY`/`supabaseAdmin` 在 `src/app/api` 下，cron 目录白名单）。
- 优先级排序：`auth/change-password`、`admin/impersonate`、`meta-capi` > `products/import`。

**改动风险:** 不修 → 无风险。仅作为 Phase C/安全专项的 backlog 登记。

---

## 附:PRD / ARCH_RULES 与代码的冲突清单

| # | 冲突点 | 性质 | 关联 P 项 |
|---|--------|------|-----------|
| C-1 | PRD 3.2 工作台分区（Inbox/今日跟进/超时/新增/本周预计）vs API 实际只返回 inbox/tasks/overdue/progress（缺“今日新增”“本周预计”） | PRD ↔ 代码 | P1 |
| C-2 | ARCH rule_014：deriveStage 须被 workbench/lead/cron 三处引用 → 实际**零引用**且签名错 | ARCH ↔ 代码 | P3 |
| C-3 | ARCH rule_015：业务逻辑不得直读 stage → pipeline-funnel/dashboard/sales-load 等仍直读 | ARCH ↔ 代码 | P3 |
| C-4 | ARCH rule_007：won/lost 只在 final_status → 生产 won 线索 `final_status IS NULL` | ARCH ↔ 生产(Ground Truth) | P5 |
| C-5 | DEV_PLAN:204/253-254 won 完整映射 vs 实际 `...mapping.sql` 漏 won | 设计档 ↔ migration | P5 |
| C-6 | DEV_PLAN:67-71 lead_milestones 有 CHECK(milestone_key IN ...) vs 实际表无此约束 | 设计档 ↔ migration | P5 |
| C-7 | ARCH rule_006：milestone 7 步序列 vs 代码 `MILESTONE_KEYS` 含 `new`/`negotiation`（9 元素） | ARCH ↔ 代码 | P4 |
| C-8 | ARCH rule_016：待跟进只看 tasks vs workbench-inbox/command-center/overdue-cron 读 next_followup_date | ARCH ↔ 代码 | P2 |
| C-9 | ARCH rule_102：API 不用 service_role vs quotations/generate、products/import 等多处使用 | ARCH ↔ 代码 | P6/P7 |

---

## 建议执行顺序与工作量

| 序 | P 项 | 状态 | 工作量 | 风险 | 依赖 |
|----|------|------|--------|------|------|
| 1 | **P6** quotations/generate 鉴权 | ❌ | 小 | 小-中（RLS 回归） | 无 —— 安全先修 |
| 2 | **P1** 工作台契约对齐 | ❌ | 小 | 小 | 无 —— 恢复销售可用性 |
| 3 | **P5** won/lost 补迁 + CHECK + convert | ❌ | 中 | 中（生产迁移） | 无 |
| 4 | **P4** MILESTONE_KEYS 校准 | ⚠️ | 小-中 | 小-中 | 建议先于 P3（P3 依赖正确的 deriveStage） |
| 5 | **P3** stage 退出主逻辑 | ⚠️ | 中-大 | 中-大 | 依赖 P4 的 milestones.ts 重构 |
| 6 | **P2** tasks 唯一真相源 | ⚠️ | 中 | 中 | 可与 P1 并行（workbench 同文件） |
| 7 | **P7** Product Import 登记 | 登记 | — | — | 不执行 |

**关键路径**: P6 → P1（先恢复可用+止血）→ P4 → P3（milestone 体系闭环）→ P5（数据订正）→ P2（真相源统一）。P7 仅登记。
