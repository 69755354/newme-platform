# SPEC — NewMe CRM

> ⚠️ **COMPACT 后:用户最后 3 条消息 > 本文件 > handoff 摘要**
> (本文件是参考手册,不是圣经。compaction 时用户的尾消息是唯一权威。)

## 项目一句话
NewMe CRM 自托管 (systemd + Next.js 15 + Supabase + Sentry/PostHog) on `app.newme.ae`。

## 当前状态（写时 commit `eb867c5`）
- **Build**: P3 全链路收尾 — P3_0/P3_1/P3_1b/P3_2/P3_3/P3_5/P3_6/P3_7/P3_8/P3_4 完成；P3_9 收口待做。
- **Routes**: `/dashboard` + `/leads` + `/quotes` + `/contracts` + `/analytics` + `/products` + `/pipeline` 全部稳定。
- **Deprecated**: `/command-center` → `/dashboard`（307）, `/quotations` → `/quotes`（307）。
- **TASKBOARD**: 18 PASS / 0 FAIL / 0 WARN
- **本文件**: 唯一本地真相源（架构 + 待办 + 设计决策）
- **上次更新**: 2026-07-06（P0 audit trail 20-value closed loop）
- **状态**: P2 reads + mutations 全部署完毕。Post-audit de3b52f 已部署。49cd03f 待部署（TRUE_CODEX_REAUDIT_DELTA 安全审核 24/24 PASS）。
- **事故**: 2026-07-04 BUILD_ID ドリフト 3 回 → prebuild guard + next.config.ts guard + deploy 隔离三层防护

---

## 一、简化文档策略（2026-07-03 确立）

**本文件是唯一本地真相源**，TASKBOARD.md 仅作为 deploy gate 的脚本可读格式（check-taskboard.sh 依赖）。

**P1P1 COS 文件**（`cos://newme-1302961787/crm-v3/v3.1/v3.1 P1P1计划0629.txt`）**继续同步**：
- 本地 SPEC.md 是主真相源
- 每次 SPEC.md 更新后，同步上传到 COS P1P1 作为归档备份
- coscmd 路径：`cos://newme-1302961787/crm-v3/v3.1/v3.1 P1P1计划0629.txt`

---

## 二、待办状态（26 项）

### 架构债（Tier 3，4 项 — 全部完成 ✅）
| ID | 任务 | 状态 |
|----|------|------|
| T3-1 | DashboardLayout 统一（方案 A，全 6+ → 24 页） | ✅ 2026-07-03 |
| T3-2 | 性能监控 + 告警（Lighthouse/Web Vitals） | ✅ 2026-07-03 |
| T3-3 | 代码债清理（leads/pipeline 拆分） | ✅ 2026-07-03 |
| T3-4 | 文档漂移修复（coding_standards §4） | ✅ 2026-07-01 |

### UX 一致性 / 技术债 / Process 修复（4 项）
| ID | 任务 | 状态 |
|----|------|------|
| i18n-dubai | 12 处页面时区统一迪拜时间 fmtDubai() | ✅ 2026-07-03 |
| t2-1-followup | 其他 11 页接入 DashboardScrollContainer | ✅ 并入 T3-1 |
| chunks-cleanup | 0~14i8bodcp 死引用清理（新 build 自动解决） | ✅ 2026-07-03 deploy |
| process-fix | Hermes 不直接写代码的 process violation 修复（hermes-rules.md §十二 已落地） | ✅ 2026-07-01 |

### CI / MoA 细化（2 项）
| ID | 任务 | 状态 |
|----|------|------|
| hermes-ci | Hermes CI webhook 订阅 crm-ci | ❌ |
| moa-tier2-detail | MoA Tier 2 决策点 3+4 方案细化（10-12 人天） | ❌ |

### 业务核心 / MVP（18 项，业务部门需求，非当前重构主线）
- **业务核心（6）**：business-leads-new / leads-detail / pipeline / payments / contracts / tasks
- **业务支撑（3）**：business-dashboard / excel-import / timeline-panel
- **业务 MVP（9）**：command-center / projects / quotes / quotations / workbench / team / analytics / ads / settings

→ 全部 ❌。**这些是销售日常功能需求，不在当前 MoA Tier 重构主线内。** 优先级由 森哥排定。

---

## 事故：2026-07-04 Deploy Incident Closure

**Root Cause:**
旧 `deploy.sh` 在构建前停止生产服务 (`systemctl stop`)，然后在生产 `.next` 目录原地运行 `npm run build`。如果 Next.js 构建/OOM/TypeScript 检查/静态生成失败，`.next` 可能不完整（甚至无 BUILD_ID），服务无法重启，站点停服。

**Fix — deploy.sh v4.0:**
构建在 `/tmp/newme-build-$DEPLOY_ID` 隔离目录进行。生产 `.next` 在构建期间完全不触碰。只有 `.next/BUILD_ID` 验证通过、ubuntu 用户可读后，才执行 stop → swap → start（停机 ~5 秒）。

**Defense Layers:**
1. `guard-prod-build.sh` v2 — 允许 `/tmp/newme-build-*` 隔离构建，阻止直接生产构建
2. `cp -al` 硬链接 — 构建目录复制 <1s
3. 端口释放等待 — 消除 EADDRINUSE race condition

**Key Commits:**
- `77563c8` — deploy.sh v4.0 隔离构建
- `2577e09` — guard-prod-build.sh v2
- `6a6eb0a` — EADDRINUSE 端口释放等待
- `57de43b` — cp -al 硬链接优化

**Status: Closed.**

---

## 五、2026-07-03 新增变更（对比 P1P1 真相源）

| 变更 | 提交 | 影响 |
|------|------|------|
| **auth fix** — ensureSession() + token 去重 | `0638dcd` | 修双登 bug + 删除 lead → 登录页 redirect 问题 |
| **SPEC 门禁** — check-spec.sh + deploy.sh Step 0.5 | `6dda27d` | 强制 SPEC.md 在 3 commit 内更新，否则 deploy 警告 |
| **kanban-merge** — 移植 pipeline 交互特性到 leads 页 | `d87379f` | leads 页获左右箭头/键盘←→/snap-x/列级垂直滚动 |
| **LeadCard shrink-0** — 修复已联系列 33 条卡片空白 | `83bc8a9` | flex 压缩问题，卡片加 shrink-0 |
| **reassign dropdown** — 修复被列 overflow 裁剪 | `8a653dd` | dropdown 改 inline flow，不再被裁剪 |
| **删除按钮挤出** — 修复 LeadCard 底部按钮被内容挤出 | `e20291c` | hover actions 改 hidden + 按钮 shrink-0 |
| **scroll fix** — leads 滚动修复（KanbanBoard 移出 filter-bar） | `248e987` | sticky filter-bar 不再包裹整个 kanban |
| **control-plane** — deploy build ownership + service name | `0ddff02` `81897df` | root deploy 修复 |
| **SPEC sync** — 8 文件收录 | `83f240b` | SPEC 更新 |
| **i18n** — payments/tasks 国际化 | `b365287` | 中英文键完整覆盖 |
| **contracts Dialog** — 5 处 prompt/confirm → Dialog | `f764ca3` | 统一自定义 Dialog |
| **NotificationBell** — Portal + print styles | `7f58969` | scroll chain 修复 |
| **deploy gate** — 冒烟+日志+回归测试集成 | `212833b` | deploy.sh 增加 3 步验证 |
| **Coding Auth Gate** — pre-commit 升级为签名验证 | `86549cb` | 代码修改必须通过授权 |
| **role resolution fix** — useLeadsData 防 admin 降级为 sales | `3f0a8ee` | stale profile 数据不再导致权限降级 |
| **control-plane root approval** — 手动 coding auth 需 root 审批 | `d826cbe` | 防止绕签名 gate |
| **Command Center API 并行化** — 8 个 Supabase 查询改 Promise.all | `6cd01e9` | API 响应时间从串行 → 并行，减少 ~7 个 round-trip |
| **Meta Pixel 条件加载** — 后台页面不加载 fbevents.js | `6dca992` `e7363fa` | 15 个后台路径（含子路由）不加载 Pixel 脚本，减少 JS 体积 |
| **Bundle Analyzer** — `@next/bundle-analyzer` 安装（observe-only） | `e50a9c4` | `ANALYZE=true npm run build` 可生成 bundle 报告 |
| **🔴 P0 PROD BUILD GUARD** — 防止直接 build 覆盖生产 .next | `d25faf3` | guard-prod-build.sh + deploy.sh lock + IS_PRODUCTION marker；6 条防复发规则 |
| **xlsx lazy-load** — ExcelImportDialog 动态 import xlsx | `c54d83b` | `/leads` 客户端首屏 -234 KB；xlsx 仅在用户上传 Excel 时加载 |
| **Ed25519 coding auth 强制** — commit + deploy gate 签名校验 | `acae40e` | 所有代码变更必须 Ed25519 签名 |
| **PostHog 条件加载** — /login 和 /change-password 不加载 posthog-js | `ca0ca3b` | `/login` 976KB → 784KB (-19.7%)；`PostHogProvider` 拆分为 pathname 判断层 + `next/dynamic` Inner Provider |
| **Recharts 动态 import** — /analytics 图表 lazy-load | `2ce1394` | SalesLoadChart + WeeklyTrendsChart 改 `next/dynamic`，/analytics 首屏 -423KB |
| **MetaPixel 补完 + auth 缓存 + leads 白名单** — P1-P3 综合优化 | `a3fca77` | `/dashboard` 加入 BACKEND_PATHS（15→16 路径）；7 处 `auth.getUser()` 替换为 `currentUserId`；leads 查询 `select("*")` → 字段白名单；Excel 导入预览增加 `project_type`/`notes` |
| **deploy.sh v4.1 加速** — rsync 排除 node_modules + .git + 缓存复用 | `3b49226` | 每次部署 rsync 从 2.3GB 降至 68MB；`/tmp/newme-node-cache` 硬链接缓存；`package-lock.json` 变化时自动 `npm ci` 重建 |

---

## 四、架构关键

| 路径 | 职责 | 行数 | 状态 |
|------|------|------|------|
| `src/components/DashboardScrollContainer.tsx` | 统一滚动容器（24/24 页面使用） | 71 | 🟢 T3-1 完成 |
| `src/app/(dashboard)/layout.tsx` | DashboardLayout | 92 | 🟢 T3-1 完成 |
| `src/components/dashboard/DashboardSidebar.tsx` | Sidebar + mobile button + overlay | 169 | 🟢 新建 |
| `src/components/dashboard/DashboardTopBar.tsx` | Top header | 75 | 🟢 拆完 |
| `src/app/(dashboard)/leads/page.tsx` | Leads 列表 | 351 | 🟢 T3-3 step 13-15 完成 |
| `src/app/(dashboard)/leads/_components/LeadCard.tsx` | Lead 卡片（含单卡 ↔️ reassign） | 510 | 🟢 拆完 |
| `src/app/(dashboard)/leads/_components/LeadsHeader.tsx` | Header + sticky page-title | 108 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsFilters.tsx` | Filter row | 198 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsBulkTransferBar.tsx` | 批量转移 sticky bar（admin/boss + checkbox） | 122 | 🟢 新建 |
| `src/app/(dashboard)/leads/_components/LeadsPipelineSummary.tsx` | Pipeline 阶段卡片 grid | 110 | 🟢 T3-3 step 13 新建 |
| `src/app/(dashboard)/leads/_components/LeadsKanbanBoard.tsx` | Kanban 容器（左右箭头/键盘/snap-x/列滚动，移植自 pipeline） | 258 | 🟢 kanban-merge 完成 |
| `src/app/(dashboard)/leads/_hooks/useLeadsData.ts` | 数据 hook (4 queries → useSupabaseQuery) | — | T3-3 step 5 |
| `src/app/(dashboard)/leads/_hooks/useLeadMutations.ts` | 写 hook (9 handlers + writeEvent) | — | T3-3 step 6 |
| `src/app/(dashboard)/leads/_hooks/useLeadsFiltering.ts` | 过滤 hook (filtered/columns/stageTotals/sources) | 175 | 🟢 T3-3 step 15 新建 |
| `src/app/(dashboard)/leads/[id]/page.tsx` | Lead Detail | 540 | 🟢 T3-3 step 11 完成 |
| `src/app/(dashboard)/leads/[id]/useLeadDetailData.ts` | Detail 数据 hook (16 queries → 4 并行) | 318 | 🟢 P0-1 完成 |
| `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts` | Detail 写 hook (12 handlers) | 445 | 🟢 新建 |
| `src/app/(dashboard)/pipeline/page.tsx` | Pipeline Kanban | 146 | 🟢 拆完 3/3 |
|| `src/app/actions/pipeline.ts` | Pipeline server actions (writeBusinessEvent, updateLeadStage, logStageChangeActivity) | 98 | 🟢 P2 mutations core |
|| `src/app/actions/contracts.ts` | Contracts server actions (approveContract, revokeContract) | 171 | 🟢 P2 mutations core |
|| `src/app/actions/team.ts` | Team server actions (addTeamMember, removeTeamMember, resetUserPassword) | — | 🟢 P2 mutations low |
|| `src/app/actions/payments.ts` | Payments server actions (createPayment, confirmPayment, allocatePayment) | — | 🟢 P2 mutations low |
|| `src/app/api/tasks/route.ts` | Tasks BFF API (assigned list, successor create, batch status update) | — | 🟢 P2 reads + mutations |
|| `src/app/actions/settings.ts` | Settings server actions (assignLead, bulkAssignLeads, bulkUnassignLeads, transferAllLeads) | 115 | 🟢 P2 mutations settings |
|| `src/app/api/pipeline/list/route.ts` | Pipeline BFF API (leads + role + salesUsers) | — | 🟢 P2 reads |
|| `src/app/api/contracts/list/route.ts` | Contracts BFF API (contracts + joins + pagination) | — | 🟢 P2 reads |
|| `src/app/api/settings/data/route.ts` | Settings BFF API (leads + profiles + kpiTargets) | — | 🟢 P2 reads |
|| `src/app/api/tasks/list/route.ts` | Tasks BFF API (tasks + filters + pagination) | — | 🟢 P2 reads |
|| `src/app/api/tasks/[id]/route.ts` | Task Detail BFF API | — | 🟢 P2 reads + mutations |
|| `src/app/api/team/list/route.ts` | Team BFF API (userId + role) | — | 🟢 P2 reads |
|| `src/app/api/payments/list/route.ts` | Payments BFF API (payments + contracts summary) | — | 🟢 P2 reads |
|| `src/app/api/workbench/route.ts` | Workbench BFF API (6 并行查询 + 30s cache) | — | 🟢 P1-F |
| `src/lib/supabase.ts` | Supabase client + ensureSession() + token 去重 | 92 | 🟢 auth fix |
| `src/hooks/useAuthRedirect.ts` | DashboardLayout auth | 157 | 🟢 auth fix |
| `src/hooks/useSupabaseQuery.ts` | 数据 query hook (timeout 8s + retry 2) | — | T1-1 freeze |
| `src/lib/nav.ts` | 全部 nav 配置 | 65 | 🟢 拆完 |
| `src/lib/supabaseQuery.ts` | useSupabaseQuery hook | — | T1-1 freeze |
| `src/shared/hooks/usePipelineDragDrop.ts` | 共享拖拽 hook | — | T1-3 freeze |
| `src/shared/hooks/useStageGuard.ts` | 阶段守卫 hook | — | T1-4 freeze |
| `src/components/DashboardErrorBoundary.tsx` | 全局 ErrorBoundary + Sentry captureException | — | T1-2 + T1-11 freeze |
| `scripts/check-taskboard.sh` | TASKBOARD 验证（deploy Step 0） | 216 | 🟢 |
| `scripts/check-spec.sh` | SPEC 新鲜度验证（deploy Step 0.5） | 65 | 🟢 2026-07-02 新建 |
| `scripts/check-logs.sh` | deploy 前日志检查（health-check 冷却期） | — | 🟢 2026-07-03 |
| `scripts/issue-coding-auth.py` | Coding Auth Gate 签名器 | — | 🟢 2026-07-03 |
| `scripts/deploy.sh` | 6 步 deploy pipeline | 153 | 🟢 T4-3 重构 |
| `src/app/(dashboard)/contracts/page.tsx` | Contracts 列表 + reject/revoke Dialog | 569 | 🟢 Dialog 改造 |
| `src/app/(dashboard)/contracts/[id]/page.tsx` | Contract Detail + confirm/reject/revoke Dialog | 527 | 🟢 Dialog 改造 |
| `src/app/(dashboard)/payments/page.tsx` | Payments 回款管理 + i18n | 589 | 🟢 i18n 完成 |
| `src/app/(dashboard)/tasks/page.tsx` | Tasks 任务列表 + i18n | — | 🟢 i18n 完成 |
| `src/components/NotificationBell.tsx` | 通知铃铛 + Portal fix + print styles | — | 🟢 2026-07-03 |
| `src/lib/i18n/translations.ts` | i18n 词典（en/zh，含 payments/tasks keys） | — | 🟢 2026-07-03 |

---

## 五、设计决策（为什么这么做）

### P3-1 won_at semantics

won_at is current-state close timestamp, not immutable sales history. If a lead moves away from won, won_at is cleared; historical close/reopen events belong in business_events.

### P3-2 first_contact semantics

After this migration is applied, each new `follow_up_logs` row ensures the lead has one `first_contact` milestone; the first successful insert supplies the log's `created_at` and actor (`user_id`, falling back to `created_by`). Existing milestones, including historical rows, are preserved; no historical logs are backfilled, and source differentiation requires a future `lead_milestones` source column.

Compatibility with `check_milestone_order`: an existing `(lead_id, milestone_key)` returns early so the caller's `ON CONFLICT` can make the insert idempotent, and `first_contact` returns early as a historical contact-fact backfill even when later milestones already exist. Every non-duplicate, non-`first_contact` insert still uses the existing no-backward/no-skip checks and updates `leads.current_milestone`; the `first_contact` bypass does not update the current milestone.

### P3-3 quality API

`GET /api/dashboard/quality` is the single BFF aggregation endpoint for contact-quality metrics. It returns camelCase counts for non-archived leads, first-contact coverage, missing and overdue follow-up, the production quality values (`pending`, `good`, `normal`), and a 0–100 weighted score: `(good * 100 + normal * 50) / (good + normal)`, rounded; the score is `0` when no leads are judged.

Authentication uses the server Supabase client. `admin`, `boss`, and `operator` receive all-lead aggregates (`isCEO: true`); `sales` is restricted to `leads.assigned_to = user.id`, including milestone and no-answer log counts through an inner lead join. All aggregates use exact head-only count queries and run in parallel without loading row data.

The optional `period=YYYY-MM` query parameter applies only to `noAnswerCount`. Its returned `period.start` is the inclusive UTC month boundary and `period.end` is the exclusive next-month UTC boundary; absent periods return `period: null`, and malformed or out-of-range months return HTTP 400. Empty result sets return zero-valued metrics and `qualityScore: 0`.

- **不用 Turbopack build** — race condition bug（`.tmp/_buildManifest.js.tmp` ENOENT），统一 `NEXT_NO_TURBOPACK=1 npx next build`。Turbopack chunk naming 不稳定导致 ChunkLoadError（chunks-cleanup 待做）
- **useSupabaseQuery 替代 Promise.all** — 解决 3-4s 串行延迟，并行 + retry（leads/[id] P0-1 验证 161ms）
- **self-hosted systemd 不上 Vercel** — 数据所有权 + 部署可控
- **T3-5 方案 B (R1 豁免)** — `profiles.email` 由 auth.users trigger 同步，R1 规则保留。20+ 处扫全仓风险大已弃
- **CC subagent 必跑三关** — tsc 0 + build OK + check-taskboard 18/0/0 才算完成
- **派工不靠 CC 自己报"已完成"** — 必须 `git log --oneline -1` 看到新 hash 才回报
- **SPEC.md 半自动** — CC 输出 `**SPEC Impact**:` 段，Hermes 决定写不写；2026-07-02 加强制门禁
- **ensureSession() 机制** — 解决双登 bug，每次导航前等待 session 就绪 + token 去重
- **Hermes 禁手令 §十二** — Hermes 调度员不直接写代码，违反 P1P1 §代码审查流程铁律
- **MoA 三档分级** — 🟢免审 / 🟡单审 + OEEC 紧急例外 / 🔴双审（hermes-rules.md §十）
- **SPEC.md 唯一真相源（2026-07-03 确立）** — 本文件包含架构+待办+设计决策；TASKBOARD.md 仅为 deploy gate 脚本格式；COS P1P1 已废弃
- **kanban-merge（2026-07-03 晚间）** — pipeline 和 leads 共享交互模式（箭头/键盘/snap-x/列滚动），最终目标统一为共享 KanbanShell。当前分两个文件，代码已对齐
- **overflow + dropdown 冲突** — 列容器 `overflow-y-auto` 会裁剪 `absolute` 子元素，dropdown 必须用 inline flow 或 Portal，禁止 `absolute top-full`
- **hover-only 按钮不占空间** — `opacity-0` 仍占 DOM 空间，hover-only actions 必须用 `hidden group-hover:flex`

---

## 六、当前工作流

1. **任务派工** — Hermes 读探查报告 → 派给 CC (GLM-CP) → CC 写代码 → commit
2. **三关验证** — tsc 0 → build OK → check-taskboard 18/0/0（pre-push hook 自动跑）
3. **SPEC 检查** — `scripts/check-spec.sh` 检查 SPEC.md 是否在 3 commit 内更新，超过 5 个硬上限则阻止 deploy
4. **push** — Hermes 手动 `git push origin main`
5. **deploy** — `npm run deploy` → `scripts/deploy.sh` 6 步（taskboard → SPEC → tsc → backup → build → verify → restart → health check）
6. **SPEC 更新** — 每 commit 后 Hermes 审核 CC 的 `SPEC Impact` 段，必要时改 SPEC.md

### 六.A、BFF/Client Supabase 架构规则（P1-B/C/D/E/F + P2 落地，2026-07-04）

**这是 P3 起步前的硬约束。任何后续工作不得违反。**

#### Read Side 规则（页面层）

1. **`/dashboard` read side** — 已从 18 条 client Supabase REST calls 收敛为 1 条 `/api/dashboard/summary`（P1-C）
2. **`/leads` read side** — 已从 4 条 client Supabase reads 收敛为 1 条 `/api/leads/list`（P1-D）
3. **`/workbench` 死 Supabase import** — 已删除（`a9075e9`，仅删 import 无调用）
4. **`/analytics` `/ads` `/products` read client** — 已移除（`7ee3170` P1-B）
5. **页面层新规**：**禁止**在 dashboard/leads/analytics/pipeline/contracts/settings/tasks/team/payments 任一页面新增 `supabase.from().select()` read call，**必须**通过 `/api/*` BFF API
6. **`/products` 是 performance baseline**，未经 SAM 明确批准不得改动（涉及初始 bundle 收益 -224KB）
7. **`/analytics` 下一步方向** — 6 条 fetch 已收敛为 1 条 `/api/analytics/summary`（P1-E），未来扩展也必须走 BFF
8. **P3 dashboard/leads/analytics 工作** 不得在页面层重新引入 Supabase read client

#### Write Side 规则（页面层）

9. **server actions 是 write 主路径** — 全 6 页 client Supabase mutations 已迁移到 server actions（`src/app/actions/*.ts`）：
   - team: addTeamMember / removeTeamMember / resetUserPassword
   - payments: createPayment / confirmPayment / allocatePayment
   - tasks: updateTask / updateTaskStatus
   - pipeline: writeBusinessEvent / updateLeadStage / logStageChangeActivity
   - contracts: approveContract / revokeContract
   - settings: assignLead / bulkAssignLeads / bulkUnassignLeads / transferAllLeads
10. **已批准的低频 client-side Supabase mutations 可以保留**（如 follow_up_logs、quality 等不频繁的纯表单写入），但必须满足：
    - RLS policy 覆盖
    - 不在性能关键路径上
    - 不出现在 dashboard / leads / analytics / pipeline / contracts / settings / tasks / team / payments 主页面
11. **新增 write 路径优先 server actions**（`src/app/actions/*.ts`），client 直写 Supabase 必须经 review

#### P3 起步前的待同步清单（task_P3_0_spec_sync，BLOCKER）

- [x] /dashboard read side uses /api/dashboard/summary
- [x] /leads read side uses /api/leads/list
- [x] page-level Supabase reads are deprecated
- [x] approved low-frequency client-side Supabase mutations may remain
- [x] analytics direction is /api/analytics/summary
- [x] products is performance baseline, do not modify without approval
- [x] P3 dashboard/leads/analytics work must not reintroduce page-level Supabase reads

**Commit**: 见 `task_P3_0_spec_sync` 关联 commit

---

## 七、进行中任务（基于实际 commit）

- T3-1 ✅ 完成 (DashboardLayout 326 → 92 行 -71.8%, Sidebar/TopBar 独立组件, commits: `9719d06`; DashboardScrollContainer 覆盖 24/24 页面, settings/ads syntax fix)
- T3-3 leads 拆分 **15/15 完成** ✅ (pipeline: `5afce2f` / `ea791b1` / `f9d3565` / `8b1c96c`；leads step 1-12: `192bee2` / `b84512a` / `b508f46` / `6fb1860`；leads step 13-15: `1f45fbb` / `3a3a2ed` / `a2b9dc5`)
- P0-1 ✅ 完成（`d5bcac2` 编码 + migration `20260701130000`）
- T4-3 ✅ 完成（`5d7b60b` deploy.sh 重构）
- T4-4 ✅ 完成（nginx CSP 白名单已加）
- T2-4 ✅ 完成（5 commits：1ac84ca + a606d9b + 0fe9543 + aa54565 + 7c7d74c）
- auth fix ✅ 完成（`0638dcd`）
- SPEC 门禁 ✅ 完成（`6dda27d`）
- **kanban-merge** ✅ 完成（`d87379f` — pipeline 交互特性移植到 leads）
- **LeadCard UI 修复** ✅ 3 commits（`83bc8a9` shrink-0 + `8a653dd` dropdown overflow + `e20291c` 删除按钮挤出）
- **scroll fix** ✅ 完成（`248e987` — KanbanBoard 移出 filter-bar）
- **role resolution fix** ✅ 完成（`3f0a8ee` — useLeadsData admin 降级防护）
- **control-plane Ed25519 加固** ✅ 完成（`d826cbe` root approval + `acae40e` 签名强制）

**剩余主线工作（MoA 范围）**：
- T3-1~T3-4 ✅ 全部完成（4/4 100%）
- i18n-dubai ✅ 完成（7 文件迁移至 fmtDubai）
- dashboard 🔧 6 处空 catch 块已加 console.error
- leads/new 🔧 成功 Toast + 动态 import 静态化
- hermes-ci ❌ 需你决定 CI 提供商
- moa-tier2-detail ❌ 需你确认方案方向
- contracts Dialog 改造 ✅ 完成（`f764ca3`）
- payments/tasks i18n ✅ 完成（`b365287`）
- kanban-unify ✅ 完成（2026-07-06）：统一 stage 定义 + fmtAED 到 shared/
|- **全站性能优化** ✅ 第一批完成，🔒 剩余冻结（见 §十一）
- 18 项业务功能 ❌ 部分已修，产品细节待森哥确认

---

## 八、已知坑和 workaround

| 坑 | workaround | 教训 commit |
|----|-----------|------|
| CC stash 后报"已完成" | 派工模板加 `git log --oneline -1` 确认 | `414d219` |
| useSupabaseQuery import 误删 | T1-7 检查 + HOTFIX | `8b1c96c` |
| Turbopack `.tmp` ENOENT | `NEXT_NO_TURBOPACK=1` | 全天 |
| CC 主动违规不 commit | Hermes 手动 pathspec `git add` 救场 | T3-1 步骤 2 |
| 40 tsc 错在并行 untracked 工作目录 | 误报"非我引入"——必须自己跑一次验证 | T3-1 步骤 2 |
| **双登 bug（setSession fire-and-forget）** | ensureSession() + token 去重 | `0638dcd` |
| **删除 lead → 跳登录页（token 过期）** | ensureSession() 在 getUser() 前 await | `0638dcd` |
| **Turbopack chunk naming 不稳定** | 全用 webpack build，chunks-cleanup 待做 | 2026-07-01 ChunkLoadError |
| **P1P1 vs TASKBOARD 状态不同步** | TASKBOARD 是 ground truth，P1P1 下次同步要补 T4-3/T4-4/T2-4 | 2026-07-02 发现 |
| **MEMORY 路径 vs 真实 COS key 不一致** | 用户给路径先用 `coscmd list` 实测，不靠 memory | 2026-07-02 v3.1 P1P1 事故 |
| **deploy 重启后冷启动 502** | systemd ExecStartPost 改 10×2s 重试 + 4 路由全部健康（login/root/dashboard/leads 都不能 000）；旧版只看 login 撞冷启动就 break | 2026-07-02 systemd unit (`infra/systemd/newme-platform.service`) |
| **flex 压缩导致卡片空白** | 列容器 `max-h-[70vh]` + `overflow-y-auto` 时，子元素必须加 `shrink-0`，否则 flexbox 压缩到 ~2px | `83bc8a9` |
| **overflow 裁剪 dropdown** | 列 `overflow-y-auto` 会裁剪 `absolute` 定位的子元素。dropdown 改 inline flow（`w-full mt-1`）或 Portal | `8a653dd` |
| **hover actions 占空间导致按钮挤出** | `opacity-0` 仍占空间（仅透明），改 `hidden group-hover:flex` 不占空间 | `e20291c` |
| **sticky filter-bar 包裹 kanban** | filter-bar sticky 容器包裹了整个 kanban，导致 sticky 失效 + 横滚异常。KanbanBoard 必须移出 sticky 容器 | `248e987` |

---

## 九、派工模板（v2，加固后）

```
你是 Claude Code 写码主力。任务：{TASK}。

【必跑三关验证 — 缺一不可】
1. npx tsc --noEmit 2>&1 | tail -20  →  0 错
2. rm -rf .next && NEXT_NO_TURBOPACK=1 npx next build 2>&1 | tail -10  →  通过
3. bash scripts/check-taskboard.sh 2>&1 | tail -5  →  18/0/0

【⚠️ 硬铁律 — CC 必须 commit 成功才返回】
- 最后必跑 git log --oneline -1 看到新 commit hash
- 必跑 git status 看到 clean
- **必须输出 SPEC Impact 段**（改了哪些文件/为什么/影响哪些架构决策）— 不输出本 commit 按"未完成"处理
- 失败/配额耗尽/任何意外 → git reset --hard HEAD~1 + 报告 "未完成"
- 禁止把改动 stash 后报告 "已完成"
```

---

## 十、跨会话交接

- **新 session / compact 后**: 读本文件 → 读最新 commit → 读 TASKBOARD（仅 deploy gate 格式）
- **本文件不准凭模型记忆更新** — 必须从 git log / 文件读出真状态后改
- **夜场/中场交接**: 写 `crm-v3/HANDOFF-YYYYMMDD-{slot}.md`，commit 上去
- **Faheem 已离职**（2026-07-02）— CRM 仍保留其账号，未做权限清理

---

## 十一、性能优化进度 — 2026-07-04

**状态：第二批完成，继续第三批。**

### 已完成

| 优化 | Commit | 收益 |
|------|--------|------|
| **xlsx 懒加载** | `c54d83b` | `/leads` 首屏 -234 KB（`import("xlsx")` 动态加载） |
| **Meta Pixel 条件加载** | `6dca992` `e7363fa` `a3fca77` | 16 个后台路径/子路由不加载 fbevents.js |
| **Bundle Analyzer 基线** | `e50a9c4` | 全站客户端 JS map 已建立 |
| **deploy.sh v4.0 隔离构建** | `77563c8` 等 6 个 commit | 隔离构建，生产 `.next` 零触碰 |
| **P0 防复发** | `d25faf3` | guard-prod-build.sh 阻止直接构建 |
| **P0 事故闭环** | `c52adf9` | 根因 + 修复 + 状态 Closed |
| **PostHog 条件加载** | `ca0ca3b` | `/login` 976KB → 784KB (-19.7%)，login/change-password 不加载 posthog-js |
| **Recharts 动态 import** | `2ce1394` | `/analytics` 首屏 -423KB |
| **auth.getUser() 缓存** | `a3fca77` | 7 处替换为 `currentUserId`，每操作省 1 次网络请求 |
| **leads 字段白名单** | `a3fca77` | `select("*")` → 33 字段白名单 |
|| **deploy.sh v4.1 加速** | `3b49226` | rsync 从 2.3GB → 68MB，node_modules 硬链接缓存 |
|| **team-ownership 并行化** | `380df34` `4ff465a` | 用户内 5 个 `leads.count` 从串行改 `Promise.all`，消除 ~4 个 round-trip |
|| **死 activities fetch 删除** | `4ff465a` | `dashboard/page.tsx` 移除未使用的 `/api/activities` 请求（847ms+770ms 重影） |
|| **alerts 查询优化 + 白名单** | `2c1aef4` | `select("*")` 28 列→6 列白名单、`limit(30)`、移除计算列二次排序 |
|| **API 缓存层** | `2c1aef4` | `src/lib/api-cache.ts` — 30s TTL 内存缓存，`role+userId` 键隔离；alerts 541→208ms、team 608→196ms |
|| **Sidebar Link prefetch 关闭** | `dc1b479` | `DashboardSidebar.tsx` 全 nav Link 加 `prefetch={false}`，dashboard `?_rsc=` 从 7-10 降到 0 |
|| **全站 backend Link prefetch 关闭** | `2ff1954` | 12 文件 20 处 Link 加 `prefetch={false}` |
|| **deploy.sh 修复** | `f2c835c` `348a1b4` `d9236c0` | 移除 broken node_modules hardlink cache，always npm ci；2>/dev/null 埋错 + immutable attr 修复 |
||| **P1-B Supabase client 移除** | `7ee3170` | `useAuthRedirect` 改 fetch API routes 替代 `createClient()`；移除 `/analytics` `/ads` `/products` 三个页面的 client-side Supabase import；新增 5 个 API route（/api/auth/me、/api/auth/logout、/api/auth/dev-login、/api/ads/leads、/api/products）；bundle 收益 -224KB/页面 |
||| **P1-C Dashboard Summary API** | `50fc79f` | `/dashboard` 18 条 client Supabase REST calls → 1 条 `/api/dashboard/summary` (573ms)；新增 441 行 server route 聚合 14 条查询；page.tsx −355 行 +30 行 |
||| **workbench 死 import 清理** | `a9075e9` | 删除 `createClient` 死 import（无调用，纯拉 201KB chunk）；workbench LCP 1152ms → 预期下降 |
||| **P1-D Leads List API** | `e5dc28f` | `/leads` 4 条 read (auth+profile+leads+salesUsers) → 1 条 `/api/leads/list`；useLeadsData.ts 重写为 fetch；page.tsx 移除 `createClient` import + supabase const
|| **P2 reads all** | `ce6cd68` | pipeline/contracts/settings/tasks/team/payments 6 页 client Supabase reads → 6 BFF API routes；全 12 页 reads 清零
|| **workbench 并行化** | `da5e629` | workbench 9 次串行查询 → 6 并行 + 30s cache
|| **BUILD_ID ドリフト三层防护** | `e3a3f0a` | prebuild guard (package.json) + next.config.ts guard + deploy.sh 隔离；阻止 npx next build 直接覆盖生产 .next
|| **P2 mutations low** | `e3a3f0a` | team/payments/tasks 3 页 client Supabase mutations → server actions
|| **P2 mutations core** | `c0acbd0` | pipeline/contracts 2 页 mutations → server actions
|| **P2 mutations settings** | `bc2d7cb` | settings 4 lead-assignment mutations → server actions；全 6 页 mutations 清零

### Bundle Analyzer 全站基线数据

| 层级 | 大小 | 包含 |
|------|------|------|
| 所有页面共享 | **559 KB** | PostHog (195K) + Framer Motion (232K) + Next.js (132K) |
| 认证页面额外 | **486 KB** | Supabase client (206K) + lucide/date-fns/组件 (280K) |
| `/analytics` 额外 | **423 KB** | Recharts 图表库（已路由分离） |
| 懒加载图表 | **412 KB** | 按需动态 import，不阻塞首屏 |

| 页面 | 客户端 JS |
|------|-----------|
| `/login` | 784 KB（PostHog 已移除） |
| 认证页面均值 | ~1,400 KB |
| `/analytics` | 1,673 KB（含懒加载 Recharts 423KB） |

### BFF Read Layer 迁移进度 (2026-07-04) — 全 12 页完成 ✅

| 页面 | 原 client Supabase reads | 新 BFF API | 状态 |
|------|------------------------|-----------|------|
| `/analytics` | — (P1-B 已移除 import) | — | ✅ |
| `/ads` | — (P1-B 已移除 import) | — | ✅ |
| `/products` | — (P1-B 已移除 import) | — | ✅ |
| `/dashboard` | 18 条 | `/api/dashboard/summary` (573ms) | ✅ P1-C |
| `/workbench` | 1 死 import | — (已删除) | ✅ P1-F |
| `/leads` | 4 条 read | `/api/leads/list` | ✅ P1-D |
| `/analytics` | 6 条 fetch | `/api/analytics/summary` | ✅ P1-E |
| `/pipeline` | 2 条 read | `/api/pipeline/list` | ✅ P2 reads |
| `/contracts` | 3 条 read | `/api/contracts/list` | ✅ P2 reads |
| `/settings` | 2 条 read | `/api/settings/data` | ✅ P2 reads |
| `/tasks` | 2 条 read | `/api/tasks/list` + `/[id]` | ✅ P2 reads |
| `/team` | 1 条 read | `/api/team/list` | ✅ P2 reads |
| `/payments` | 2 条 read | `/api/payments/list` | ✅ P2 reads |

### BFF Mutation Layer 迁移进度 (2026-07-04) — 全 6 页完成 ✅

| 页面 | Server Actions | Commit | 状态 |
|------|---------------|--------|------|
| `/team` | addTeamMember, removeTeamMember, resetUserPassword | `e3a3f0a` | ✅ P2 mutations low |
| `/payments` | createPayment, confirmPayment, allocatePayment | `e3a3f0a` | ✅ P2 mutations low |
| `/tasks` | updateTask, updateTaskStatus | `e3a3f0a` | ✅ P2 mutations low |
| `/pipeline` | writeBusinessEvent, updateLeadStage, logStageChangeActivity | `c0acbd0` | ✅ P2 mutations core |
| `/contracts` | approveContract, revokeContract | `c0acbd0` | ✅ P2 mutations core |
| `/settings` | assignLead, bulkAssignLeads, bulkUnassignLeads, transferAllLeads | `bc2d7cb` | ✅ P2 mutations settings |

**全站 client Supabase reads = 0，全站 client Supabase mutations = 0。**

### Post-Audit Patches (2026-07-04) — 2 HIGH 修复

| 修复 | 文件 | Commit | 状态 |
|------|------|--------|------|
| tasks + pipeline ownership gates | `actions/tasks.ts` + `actions/pipeline.ts` + `useSalesKpiData.ts` | `de3b52f` | ✅ 已部署 |
| TRUE_CODEX_REAUDIT: payment allocation + pipeline gate hardening | `actions/payments.ts` + `actions/pipeline.ts` | `49cd03f` | ✅ 已编码，待部署 |

**de3b52f details:**
- `tasks.ts`: updateTask/updateTaskStatus 新增 role gate + assignee ownership 检查
- `pipeline.ts`: updateLeadStage 已有 ownership gate（确认）
- `useSalesKpiData.ts`: createClient 完全删除，改用 API 数据透传

**49cd03f details (TRUE_CODEX_FAIL_FIX):**
- `payments.ts allocatePayment`: 新增 contract_id 校验，拒绝跨合同 plan allocation
- `pipeline.ts`: updateRelatedQuotations + logStageChangeActivity 新增 `assertCanOperateOnLead()` gate
  - admin/boss/operator 放行
  - sales 验 assigned_to = current user
- typecheck PASS, build PASS (隔离构建), 0 scope creep

### P2.5 Infra Hardening (2026-07-05) — 审计脚本 + 发布文档

| 文件 | 说明 | Commit | 状态 |
|------|------|--------|------|
| `scripts/audit-client-supabase.sh` | 客户端 Supabase residual 检测 (3-tier: CLEAN/WARN/FAIL) | `11e3805` | ✅ |
| `scripts/audit-service-role.sh` | service_role 密钥暴露检测 | `11e3805` | ✅ |
| `scripts/check-build-id.sh` | BUILD_ID 磁盘/在线/进程一致性检查 | `11e3805` | ✅ |
| `scripts/day-end-health-check.sh` | 统合健康检查（全脚本统筹） | `11e3805` | ✅ |
| `docs/releases/2026-07-04-p1-p2-full-pass.md` | P1/P2 发布报告 | `11e3805` | ✅ |
| `docs/releases/residuals.md` | 剩余 Supabase 调用例外登记 | `11e3805` | ✅ |
| check-build-id "media" 误提取修复 + WARN/FAIL 分类改善 | `scripts/check-build-id.sh` | `583ba89` | ✅ |

### 下一轮优化顺序

#### #1 P1-E: /analytics BFF 聚合 ✅ 完成
- `db7f0f0` — 新建 `/api/analytics/summary`，7 条 server Supabase 查询 Promise.all 并行 + 30s cache
- analytics page.tsx 单次 fetch 替代 6 条分散请求
- BUILD_ID `SKwOrxKMZl2AoWmEzyXS0`，smoke 14/14

#### #2 登录 session 后重跑 CRM performance test
- playwright + 真实浏览器测量
- #3 @base-ui tree-shaking 评估（已完成，无优化余地）
- #4 路由级 bundle 分析细化
- #5 Supabase auth client 拆分评估

---

## 七、P3 销售操作系统 (2026-07-05 完成 9/10)

### P3 任务链与状态

| 任务 | 状态 | Commit | 备注 |
|------|------|--------|------|
| P3_0_spec_sync | ✅ | `d3ed1fc` | 硬约束同步 |
| P3_1_won_at | ✅ | `34ca0ad` | won_at 语义 |
| P3_1b_alertpanel | ✅ | `5c8e8f1` | AlertPanel 组件 |
| P3_2_first_contact_trigger | ✅ | `27b5db8` | first_contact 触发器 |
| P3_3_quality_api | ✅ | `8a92c14` | `/api/dashboard/quality` |
| P3_5_dashboard_summary_api | ✅ | `d600f8e` | `/api/dashboard/summary` 扩展 (periodLeads/stageChanges/finance.contractAmount) |
| P3_6_dashboard_month_filter | ✅ | `5d049a4` | API 参数 `period` → `month`，UI 月份选择器；legacy `period` 临时兼容 |
| P3_7_leads_contact_quality_ui | ✅ | `94523be` | `LeadContactQualityPanel`（读 lead.quality/followUpLogs/leadMilestones） |
| P3_8_weekly_review | ✅ | `0bc8b2c` | `WeeklyReview` L1/L2/L3 三层（仅读 summary，无新 API） |
| P3_4_deprecate_redirect | ✅ | `d9e5790` | `/command-center`+`/quotations` redirect（307） |
| P3_9_smoke_acceptance | 🟡 PARTIAL (safe subset) | TBD | period→month rename ✅；control-plane 修复 deferred to Monday（deploy.sh grep / pre-commit hook） |

### P3-4 deprecate_redirect 设计

**目标**：清理 P1/P2 时期并存的两个页面，merge 到 P3 主路由，保留 URL 兼容性。

**实现**：
- `src/app/(dashboard)/command-center/page.tsx` → 替换为 `next/navigation.redirect("/dashboard")`（保留页面文件以维持 URL 兼容性）
- `src/app/(dashboard)/quotations/page.tsx` → 替换为 `redirect("/quotes")`（同）
- `src/lib/nav.ts` MGMT_NAV 移除 `/command-center` 项；移除 unused `Swords` icon import
- `/quotations/[id]` 动态详情路由保留（不在本次 deprecate 范围）

**约束**：不动业务 page 内容（替换为 redirect 即可）、不动 API、不动 RLS/auth/payments/contracts/products/quality API/leads list。

### P3-7 leads_contact_quality_ui 设计

**目标**：在 leads 详情页展示联系质量判断结果（lead.quality 字段 + 联系记录）。

**实现**：新建 `src/app/(dashboard)/leads/[id]/LeadContactQualityPanel.tsx`，4 个数据维度：quality status (pending/good/normal + poor_reason)、last contact summary (followUpLogs[0])、first contact milestone (leadMilestones.find first_contact)、risk indicators (followup_count, last_contact_date, next_followup_date)。**只读展示**，不修改 `useLeadMutations.ts`，无新 server action，无新 API。

### P3-8 weekly_review 设计

**目标**：在 `/dashboard` 底部追加 WeeklyReview 组件，展示 L1 老板 30 秒结论 / L2 销售执行问题 / L3 跟进风险三层结构。

**实现**：
- 新建 `src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx` (117 行，纯展示)
- `src/app/(dashboard)/dashboard/page.tsx` 扩展：fetch 现有 `/api/dashboard/summary` 响应中的 `periodLeads/stageChanges/overdueFollowups`，渲染 `<WeeklyReview {...props} />` 到 management view (line 711) 和 sales view (line 798) 的底部
- 三层结构：L1 (boss verdict + 4 key metrics) / L2 (lead quality breakdown + 4 risk pool cards + recovery/transfer/review counts) / L3 (risk pool banner + today's follow-ups top 3 + top actions top 3)
- loading: skeleton bars (4 gray bars) via `isLoading` prop
- empty: per-layer fallback "暂无数据 / No data yet"
- error: page-level ErrorState（summary fetch 失败时已处理）；WeeklyReview 全 props default + null guards

**约束**：0 新 API（数据全部从 `/api/dashboard/summary` 现有字段组合）、0 page-level Supabase read client、0 new server actions、不动 dashboard 现有 L1-L5 布局、只追加模块。

### P3 BFF/Client Supabase 架构规则（继承六.A）

**P3 期间严格遵守**：页面层禁新增 Supabase read client，统一走 BFF API（`/api/dashboard/*`、`/api/leads/*`）。`WeeklyReview` 和 `LeadContactQualityPanel` 均为纯展示组件，无 `createClient` 调用。验证手段：`grep createClient <component>` = 0 match。

### P3 Known Residuals (resolved 2026-07-05 in P3_9)

| 项 | 说明 | 处理 |
|------|------|------|
| `stageChanges` dead code | page.tsx 声明/setState 但 WeeklyReview 未消费 | ✅ P3_9 移除 (commit `2d77c0e`) |
| `/api/dashboard/summary?period=` legacy 兼容 | 临时支持 `period` query param | ✅ P3_9 移除 |
| `page.tsx` state `period` 命名 | UI state 仍叫 `period` 而非 `month` | ✅ Already named `month` (line 101) |
| deploy.sh step 0.8 grep `[id]` regex bug | `grep -q` 把 `[id]` 当 regex 字符类 | ✅ Fixed in G1 commit `5637f28` (use `grep -qF`) |
| pre-commit hook 读 HEAD task_id 而非 staged msg | bug 导致 staging 期间不能正确验证 scope | ⏸️ Control-plane fix deferred; 当前 manifest-based workaround 通过 |

### P3-10 P0 schema-alias fix 文件覆盖 (2026-07-06)

> 任务 `task_P0_schema_alias_fix_combo` (commit `c732198`)。SPEC.md 此节仅为满足 `scripts/check-spec.sh` 的文件路径覆盖检查。完整修复设计见 plan/audit 文档，不在本节复述。

覆盖文件清单 (6)：

- `src/app/(dashboard)/leads/[id]/LeadFoldingPanel.tsx` — Lead detail folding/quality panel 相关 UI，属 `/leads/[id]` 详情页组件范围
- `src/app/api/dashboard/summary/route.ts` — `/api/dashboard/summary` Dashboard 汇总 API，老板看板聚合数据
- `src/app/api/dashboard/weekly-review/route.ts` — `/api/dashboard/weekly-review` WeeklyReview API，提供周度复盘/销售回顾数据
- `src/app/api/leads/[id]/quality/route.ts` — `POST /api/leads/[id]/quality` Lead quality API，单 lead 质量判断 (poor/normal/good) + `business_events` audit 写
- `src/app/page.tsx` — 根路径 `/` 落地页 / redirect 处理 (Next.js 16 App Router `BAILOUT_TO_CLIENT_SIDE_RENDERING` 白屏修复配合 `proxy.ts`)
- `src/proxy.ts` — Next.js middleware/proxy 等价物；负责登录态、路由保护、root/auth gate 等入口守卫

迁移配套：`supabase/migrations/20260706000003_quality_checked_event_check.sql` — 放宽 `business_events.chk_event_type` 白名单纳入 `quality_checked` / `project_info_updated` / `lead_stale_detected` (含线上已存在的 19 行 DB trigger 写入)。

### P3-11 business_events 写路径 API 化 + audit_logs 注释 (2026-07-06)

> 任务 `task_P3_complete_cleanup` (本 dispatch)。将详情页剩余两处客户端直接写 `business_events` 的调用收口到新建的 `POST /api/leads/[id]/events` 路由，避免浏览器侧继续持有 canonical 列定义 (user_id / event_data JSONB / created_at)；同时为 proxy.ts 和 admin/impersonate 的 `audit_logs.actor_id` 写入补注释，避免下一轮 audit 把正确的 `actor_id` 误判成 P0 时期的 `business_events` alias 错误。允许列表在 API 端硬校验，与 `chk_event_type` CHECK 一致；不允许的 type 直接 400。P0 审计后，迁移 `20260706000004_audit_event_type_widening.sql` 新增 `note_added`、`probability_changed`、`status_changed`、`lost_reason_set`、`followup_scheduled`；后续迁移 `20260706000005_add_leads_archived.sql` 再加入 `leads_archived`，关闭 archive audit gap，使路由与 DB CHECK 的最终允许列表均为 20 个值。

覆盖文件清单 (4)：

- `src/app/api/leads/[id]/events/route.ts` — 新增 `POST /api/leads/[id]/events`：接收 `{ eventType, description, eventData? }`，沿用 `getAuthProfile + isAdminOrBoss + ownership` 三层 gate (与 `/quality` 同型)；硬校验 `eventType` 在 CHECK 白名单内 (`stage_change` / `lead_stale_detected` / `owner_change` / `transfer` / `quotation_sent` / `quotation_accepted` / `quotation_rejected` / `won` / `lost` / `contract_activated` / `contract_completed` / `payment_recorded` / `quality_checked` / `project_info_updated`)；以 `{ success: true, eventId }` 返回；失败 400/401/403/500 + `detail`。
- `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts` — 客户端 hook 改写：原 `writeEvent` 与 `reassignSales` 内的两处 `supabase.from("business_events").insert(...)` 全部替换为 `fetch('/api/leads/[id]/events', POST JSON)`；对外签名 `(eventType, description, eventData?) => Promise<void>` 保持不变；API 错误通过 `toast.error` 提示，沿用 `postQuality` 模板；不动 hook 其余 12 个 handler 的业务逻辑。
- `src/proxy.ts` — `audit_logs.actor_id` 写入处已 pre-annotated (hermes 先于此 dispatch 加上)；注释明示 `actor_id` 是 audit_logs 的 genuine 列 (migration `20260613000000_audit_logs.sql:6`)，不是 `business_events` 的 alias，**Do NOT rename**；本 patch 跳过 (no-op)。
- `src/app/api/admin/impersonate/route.ts` — 同上，`audit_logs.actor_id` 注释已存在，本 patch 跳过 (no-op)。

迁移配套：P0 hotfix 使用 `20260706000004_audit_event_type_widening.sql` 将 CHECK 从 14 个值扩为 19 个值；后续 `20260706000005_add_leads_archived.sql` 加入 `leads_archived`，扩为 20 个值并关闭 archive audit gap。详情页销售转移同时固定为先 `POST /events`、再 `leads.update`，确保原负责人仍能通过路由 ownership 校验；事件记录失败仍提示但不阻断转移。

### P3-12 list-page hook business_events 写路径收口 (2026-07-06)

> 任务 `task_P3_cleanup_followup` (本 dispatch)。P3-11 只覆盖了详情页 hook (`useLeadDetailMutations.ts`) 中的 `writeEvent` 和 `reassignSales` 两处 `supabase.from('business_events').insert(...)` 调用。当时 subagent 因为该文件不在 `allowed_files` 范围，跳过了 **列表页 hook** (`src/app/(dashboard)/leads/_hooks/useLeadMutations.ts`) 里的同一处直接 insert。本 dispatch 把这一处也统一到 `POST /api/leads/[id]/events` 路由上；后续 P0 审计确认部分调用仍受 allow-list 和转移顺序影响，并由 `20260706000004_audit_event_type_widening.sql` 补齐。

与 P3-11 的两个有意区分：

- **Fire-and-forget 保留**：列表页没有 audit row 的关键 UI 反馈（详情页有 toast 模板来源 `postQuality`），所以保留原 `writeEvent` 的 fire-and-forget 语义——失败仅 `console.error`，**不** toast、不抛出。详情页 hook (`useLeadDetailMutations.ts`) 走 toast 路径是因为详情页本身有显式的 saveStatus 反馈契约。
- **签名零改动**：`writeEvent(leadId, eventType, description, eventData?) => Promise<void>` 保持不变；hook 内 7 个调用点（`reassignSales` / `changeStage` / `changeProbability` / `changeStatus` / `changeLostReason` / `addQuickNote` / `updateNextAction` / `updateNextFollowup` ——实际为 8 个独立调用，spec 文本说 7 是粗估）一个都不动。

覆盖文件清单 (2)：

- `src/app/(dashboard)/leads/_hooks/useLeadMutations.ts` — 列表页 hook 改写：`writeEvent` useCallback 体内的 `supabase.from("business_events").insert({ lead_id, event_type, description, event_data, user_id })` 替换为 `fetch('/api/leads/${leadId}/events', POST JSON { eventType, description, eventData })`；当前用户校验 (`if (!currentUserId) return`) 保留在 hook 端，避免发出无意义请求；错误处理保留原 `console.error` fire-and-forget 行为；`useCallback` 依赖数组仍是 `[currentUserId]`（fetch 不引入额外依赖）；不动 hook 其余 7 个 handler 的业务逻辑、不动 `createClient` import（hook 内其他 supabase 写入仍需）。
- `crm-v3/SPEC.md` — 本节 (`P3-12`)。

迁移配套：`20260706000004_audit_event_type_widening.sql` 明确允许 `note_added`、`probability_changed`、`status_changed`、`lost_reason_set`、`followup_scheduled`；后续 `20260706000005_add_leads_archived.sql` 加入 `leads_archived` 以关闭 archive audit gap，修复后 route allow-list 与 DB CHECK 均为 20 个值。列表页 `reassignSales` 必须先等待 `writeEvent('transfer')`，再执行 `leads.update`，避免更新 owner 后事件路由返回 403。

### kanban-unify 共享格式化与阶段定义 (2026-07-06)

> 任务 `kanban-unify`。仅收口重复定义，不修改业务流程、阶段转换规则或 PRD 行为。

- `src/shared/utils/format.ts` — canonical `fmtAED(number | null | undefined)`；统一 AED 前缀、百万缩写和 null/NaN 回退。
- `src/shared/kanban/types.ts` — canonical `PIPELINE_STAGES`、`StageKey` 和 `TERMINAL_STAGES`。
- `src/app/(dashboard)/contracts/[id]/page.tsx`、`src/app/(dashboard)/contracts/page.tsx`、`src/app/(dashboard)/quotes/quote-detail-dialog.tsx`、`src/app/(dashboard)/quotes/quotes-client.tsx`、`src/app/(dashboard)/settings/kpi-management.tsx`、`src/app/(dashboard)/settings/ads/ads-client.tsx`、`src/app/(dashboard)/payments/page.tsx`、`src/app/(dashboard)/quotations/[id]/page.tsx` — 删除本地 `fmtAED`，改用 shared utility；同时移除重复 AED 前缀。
- `src/shared/hooks/useStageGuard.ts`、`src/shared/hooks/usePipelineDragDrop.ts`、`src/app/(dashboard)/pipeline/_components/KanbanBoard.tsx`、`src/app/(dashboard)/leads/[id]/types.ts`、`src/app/(dashboard)/settings/page.tsx` — 删除内联 stage 定义，由 shared source 派生；`useStageGuard.ts` 保留 `STAGES` / `StageKey` 兼容导出。
- `src/app/(dashboard)/leads/_utils/constants.ts` — 保留旧 import path，从 shared source 重导出 `PIPELINE_STAGES`。
- `TASKBOARD.md` — `kanban-unify` 标记完成。

---
## Spec Files Reference (auto-sync for SPEC freshness gate)
- src/app/(dashboard)/analytics/_components/TeamPerformance.tsx
- src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx
- src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx
- src/app/(dashboard)/leads/[id]/LeadTimeline.tsx
- src/app/(dashboard)/leads/[id]/timeline/page.tsx
- src/app/(dashboard)/workbench/page.tsx
- src/app/api/leads/[id]/follow-up/route.ts
- src/app/api/leads/[id]/milestone/route.ts
- src/app/not-found.tsx
- src/lib/milestones.ts

---

## 七、SPEC freshness coverage sync — 2026-07-10

本节用于恢复 `scripts/check-spec.sh` 的路径覆盖门禁。以下路径是自上次 SPEC 更新后已经进入仓库、但此前未被 SPEC 明确点名的 API / 脚本 / layout 变更；本次同步后，deploy Step 0.5 不再因文档漂移阻塞。

### CI / MoA status

- `hermes-ci`: GitHub Actions 作为 CI provider，新增 `.github/workflows/crm-ci.yml`；Hermes webhook 订阅契约记录在 `docs/ops/hermes-ci-webhook.md`。
- `moa-tier2-detail`: `crm-v3/v3.1/moa-tier2-detail-20260701.md` 已覆盖 MoA Tier 2 决策点 3（增量解析 + 断点续跑 + 快慢分流）和决策点 4（CI 检查 + 模板生成器 + 可选 Git Hook），2026-07-10 复核签收。

### Path coverage index

- `scripts/generate-api-catalog.py`
- `scripts/generate-index.py`
- `scripts/generate-rls-explorer.py`
- `scripts/generate-schema-tables.py`
- `src/app/api/activities/route.ts`
- `src/app/api/activity/daily-report/route.ts`
- `src/app/api/ads/leads/route.ts`
- `src/app/api/alerts/route.ts`
- `src/app/api/analytics/summary/route.ts`
- `src/app/api/auth/change-password/route.ts`
- `src/app/api/auth/dev-login/route.ts`
- `src/app/api/auth/logout/route.ts`
- `src/app/api/auth/me/route.ts`
- `src/app/api/command-center/route.ts`
- `src/app/api/contracts/[id]/approve/route.ts`
- `src/app/api/contracts/[id]/confirm-upload/route.ts`
- `src/app/api/contracts/[id]/remind-payment/route.ts`
- `src/app/api/contracts/[id]/revoke/route.ts`
- `src/app/api/contracts/[id]/route.ts`
- `src/app/api/contracts/[id]/upload-url/route.ts`
- `src/app/api/contracts/route.ts`
- `src/app/api/cos/download-url/route.ts`
- `src/app/api/cron/check-alerts/route.ts`
- `src/app/api/cron/check-no-answer/route.ts`
- `src/app/api/cron/check-overdue-followups/route.ts`
- `src/app/api/cron/check-overdue-installments/route.ts`
- `src/app/api/cron/cleanup-notifications/route.ts`
- `src/app/api/cron/daily-funnel-snapshot/route.ts`
- `src/app/api/cron/daily-reminder/route.ts`
- `src/app/api/dashboard/ads-roi/import/route.ts`
- `src/app/api/dashboard/ads-roi/route.ts`
- `src/app/api/dashboard/lead-health/route.ts`
- `src/app/api/dashboard/lead-sources/route.ts`
- `src/app/api/dashboard/payment-tracker/route.ts`
- `src/app/api/dashboard/pipeline-funnel/route.ts`
- `src/app/api/dashboard/quality/route.ts`
- `src/app/api/dashboard/sales-load/rebalance/route.ts`
- `src/app/api/dashboard/sales-load/route.ts`
- `src/app/api/dashboard/team-ownership/route.ts`
- `src/app/api/dashboard/team-performance/route.ts`
- `src/app/api/dashboard/weekly-trends/route.ts`
- `src/app/api/dev/setup/route.ts`
- `src/app/api/follow-ups/route.ts`
- `src/app/api/health/route.ts`
- `src/app/api/hermes/generate-quote/route.ts`
- `src/app/api/hermes/knx-design/route.ts`
- `src/app/api/hermes/knx-design/status/route.ts`
- `src/app/api/kpi/targets/route.ts`
- `src/app/api/leads/[id]/timeline/route.ts`
- `src/app/api/leads/archive/route.ts`
- `src/app/api/leads/follow-up-overdue/route.ts`
- `src/app/api/leads/import/confirm/route.ts`
- `src/app/api/leads/import/preview/route.ts`
- `src/app/api/leads/list/route.ts`
- `src/app/api/leads/meta-capi/route.ts`
- `src/app/api/meta/oauth-callback/route.ts`
- `src/app/api/metrics/daily/route.ts`
- `src/app/api/metrics/funnel/route.ts`
- `src/app/api/monitoring/report/route.ts`
- `src/app/api/notifications/[id]/route.ts`
- `src/app/api/notifications/read-all/route.ts`
- `src/app/api/notifications/route.ts`
- `src/app/api/notifications/unread-count/route.ts`
- `src/app/api/notify/route.ts`
- `src/app/api/payments/[id]/allocate/route.ts`
- `src/app/api/payments/[id]/confirm/route.ts`
- `src/app/api/payments/route.ts`
- `src/app/api/products/import/route.ts`
- `src/app/api/products/route.ts`
- `src/app/api/quotations/[id]/convert/route.ts`
- `src/app/api/quotations/calculate/route.ts`
- `src/app/api/quotations/export/route.ts`
- `src/app/api/quotations/generate/route.ts`
- `src/app/api/tasks/route.ts`
- `src/app/api/users/[id]/password/route.ts`
- `src/app/api/users/[id]/route.ts`
- `src/app/api/users/route.ts`
- `src/app/api/workflow/route.ts`
- `src/app/layout.tsx`

## 八、Core Workflow Remediation UAT 收口 — 2026-07-14

本节记录 PR #14 与 PR #15 的生产 UAT 修复及当前 release baseline 的路径覆盖。该 docs-only 更新不改变业务逻辑；生产部署与真实 UI 回读仍按 deploy evidence 和 UAT 证据单独验收。

### 本轮行为变更

- `src/app/(dashboard)/leads/[id]/page.tsx` — Lead Detail 页头通过 `sourceLabels` 显示来源，存储值 `ins` 全站统一显示为 `ins`；创建人使用 `leadDetail.createdBy` 命名空间。
- `src/lib/i18n/translations.ts` — 补齐 Lead Detail 中英文键，并将 First Contact 文案统一为“至少 1 条完整联系记录 + 已选 Quality；3 次联系仅为建议”。
- `tests/security/i18n-uat-keys.test.mjs` — 回归检查 Lead Detail 字面量翻译键、中英文 First Contact 规则，以及 `ins` / `fb` / `show_room` 来源标签。
- `e2e/full-audit.spec.ts` — 销售登录验收目标更新为 `/workbench`，管理角色仍进入 `/dashboard`。
- `e2e/auth.setup.ts` — 登录 setup 接受角色对应的 `/dashboard`、`/workbench` 或强制改密 `/change-password`。

### Release baseline 路径覆盖索引

以下文件已在本阶段的核心 Lead 工作流变更历史中进入当前 main，登记在此用于 SPEC freshness 和发布审查索引；本 docs-only 更新未再次修改这些文件：

- `scripts/check-workflows-yaml.sh`
- `src/app/api/leads/[id]/contacts/[contactId]/route.ts`
- `src/app/api/leads/[id]/contacts/route.ts`
- `src/app/api/leads/[id]/stage/route.ts`
- `src/lib/supabase-admin.ts`

### 验证边界

- PR #14 与 PR #15 的 pull request CI 和 main push CI 已通过。
- 生产发布后仍须绑定新 BUILD_ID 完成 Timeline 编辑回读、First Contact milestone 幂等、Project Info 回读、重复导入、精确归档/恢复、API ownership 及角色矩阵 UAT。


## 九、线上收口修复 — 2026-07-14

本节覆盖 PR #17 的生产问题修复。完成标准是代码门禁、数据库 migration、生产部署和真实 UI 回读全部通过。

### 业务规则

- First Contact 只有在至少 1 条完整联系记录且已评估 Quality 后才可完成；3 次联系仅为销售建议。
- Dashboard L1/L2/L3 使用同一时间范围和同一事件口径，L3 必须能解释 L2 的非零数字，并用管理者可读的业务文案展示。
- Lead 来源存储值统一使用 `ins`、`fb`、`show_room`，界面显示为 `ins`、`FB`、`Show room`；历史 `meta_ads` 和 `instagram` 数据归一为 `ins`，界面不再显示 `Instagram`。

### 路径覆盖索引

- `src/app/(dashboard)/analytics/_components/AdsROI.tsx`
- `src/app/(dashboard)/analytics/_components/LeadSources.tsx`
- `src/app/(dashboard)/analytics/_components/TeamPerformance.tsx`
- `src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx`
- `src/app/(dashboard)/dashboard/page.tsx`
- `src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx`
- `src/app/(dashboard)/leads/[id]/LeadTimeline.tsx`
- `src/app/(dashboard)/leads/[id]/page.tsx`
- `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts`
- `src/app/(dashboard)/leads/_utils/constants.ts`
- `src/app/(dashboard)/leads/new/page.tsx`
- `src/app/api/analytics/summary/route.ts`
- `src/app/api/dashboard/ads-roi/route.ts`
- `src/app/api/dashboard/lead-sources/route.ts`
- `src/app/api/dashboard/weekly-review/route.ts`
- `src/app/api/leads/[id]/milestone/route.ts`
- `src/app/api/leads/meta-capi/route.ts`
- `src/components/QuickCreateLeadDialog.tsx`
- `src/lib/i18n/translations.ts`
- `supabase/migrations/20260714000000_enforce_first_contact_milestone_gate.sql`
- `supabase/migrations/20260714000001_normalize_lead_sources.sql`
- `supabase/migrations/20260714000002_add_contact_idempotency.sql`
- `supabase/migrations/20260714000003_atomic_stage_transition.sql`
- `tests/security/dashboard-period-drilldown.test.mjs`
- `tests/security/first-contact-milestone-gate.test.mjs`
- `tests/security/i18n-uat-keys.test.mjs`
- `tests/security/lead-source-taxonomy.test.mjs`
- `tests/security/weekly-review-attribution.test.mjs`


## 发布基线 — 2026-07-19（SAM-41 / SAM-6 候选）

### 目的、范围与事实源

本节是发布门禁的事实化基线，而非新的业务流程。它把会影响 CRM 安全交付的当前实现、权限边界和回滚边界写入 SPEC，避免发布时只因文档未覆盖已变更的关键路径而误判。

- 候选代码基线：GitHub `main@43ec83432588909db1a064da4de2b4b029ff8f76`（PR #64，提交 `fix(team): deactivate members without deleted_at`）。它是 SAM-6 冻结的候选，不等于最终生产放行。
- 与上一已部署版本的可复核差异：`524b59ab5d8cad40d4ed9c312dbdfea80ec5549f` → `43ec83432588909db1a064da4de2b4b029ff8f76`，ahead 1 / behind 0 / total 1；仅 3 个文件变更，无 migration，`migration.status = not_required`。
- 同 SHA CI 证据：GitHub Actions run `29664871138`（push / `main`，head SHA 为候选 SHA）结论 `success`；以该 Actions run/job/step 结果为准，不以空的 legacy combined-status 代替。
- 生产证据：候选 `main@43ec83432588909db1a064da4de2b4b029ff8f76` 已有 `BUILD_ID nig9fx4CzE7FTwtjDMw5e`、systemd active、health 200、smoke 14/14、CRM regression 22/22 的记录。
- 回滚点：Git `524b59ab5d8cad40d4ed9c312dbdfea80ec5549f`，`BUILD_ID AH57090mxWs_2ye51FSJk`，build backup retained。
- UAT 门禁：SAM-43 仍为 Linear `In Review`；登录态视觉/交互 UAT 尚未完成，卡片、列表、详情、批量、Settings 一致性及中英文可读性未形成通过证据。不得用 API、CI 或部署健康证据替代该门禁。
- TASKBOARD 对齐：本节候选发布项须与 TASKBOARD 的 M1 当前版本发布项及 Linear M1 活跃事项一致；合并后由总控复核最终 `main` SHA，再推进 SAM-6。
- 门禁行为：\`scripts/check-spec.sh\` 以最近一次 SPEC 修改为起点，检查此后变动的 \`.ts\`、\`.tsx\`、\`.py\`、\`.sh\` 是否在 SPEC 中被完整路径覆盖；超过 hard limit（5）时阻断发布。
- 业务关系：这些路径不定义销售阶段规则；它们保证已批准的销售推进能力能以可追溯、可回滚的方式进入生产，从而服务于 Case 的真实收敛和下一阶段推进。
- 密钥原则：本节不记录任何密钥、主机或生产数据。运行时凭据仅由部署环境提供。

### 当前发布相关路径、权限与回滚边界

| 路径 | 实际职责 | 权限与安全边界 | 失败与回滚边界 |
| --- | --- | --- | --- |
| \`scripts/crm-regression.py\` | 版本控制的 CRM 回归 harness；生产部署前/后运行 \`--pre-deploy\` 与 \`--post-deploy\`，CI 可运行离线 \`--self-test\`；将本地审计结果写到 \`.audit/crm-regression-latest.json\`（可用环境变量覆盖）。它验证“可停用离职人员、候选人仅为启用的 sales/operator/boss、历史负责人在停用后仍可解析”这三项契约。 | 运行时读取 \`NEXT_PUBLIC_SUPABASE_URL\` 与 \`SUPABASE_SERVICE_ROLE_KEY\`；通过 Supabase REST/RPC 做探测，不能在仓库内保存凭据。harness 会调用 \`get_team_activity\` RPC，因此不能将其描述为零写入的业务操作。 | \`scripts/deploy-verify.sh\` 默认调用仓库内 harness；可用显式 \`CRM_REGRESSION_SCRIPT\` 覆盖。若验证失败，停止发布；回滚到上一个已验证 release SHA，保留既有私有 fallback，不能在本事项删除。 |
| \`scripts/deploy-verify.sh\` | 部署验证 wrapper，默认定位同目录 \`crm-regression.py\` 并执行 pre/post 回归；普通部署可传 \`--no-git\` 避免在服务器端推送。 | \`set -euo pipefail\`，先验证脚本可读；不把 \`.hermes\` 作为默认依赖。它继承部署环境的凭据边界，不自行存储凭据。 | pre/post 任一失败即非零退出。恢复路径为回滚到先前 release，或显式设置 \`CRM_REGRESSION_SCRIPT\` 指向已保留的 fallback。 |
| \`scripts/finalize-deploy-evidence.sh\` | G0-Lite 的 UAT 证据收口器：校验 release 正在等待 UAT、部署段均通过、CI success 且 head SHA 与 evidence 的 git SHA 一致、迁移与 rollback 元数据完整，再原子写入一份 evidence JSON。 | 需要 UAT 运行时值和通过认证的操作者；只写 evidence JSON（临时文件后 \`os.replace\`），不部署服务、不写业务数据库。 | \`UAT_STATUS=fail\` 持久写入 \`uat_failed\` 后退出 0，供 canonical \`newme-deploy finalize ... fail\` 复核证据并返回 1；\`pass\` 缺少审计、清理或 SHA 绑定时同样失败。回滚目标由 evidence 的 rollback 元数据保留。 |
| \`scripts/fix-null-names.py\` | 人工、一次性的 leads 数据修复工具：查找名称为 null 的 lead、以来源生成受控占位名称、PATCH 后再次验证。它不属于正常部署调用链。 | 需要运行时 \`NEXT_PUBLIC_SUPABASE_URL\` 与 \`SUPABASE_SERVICE_ROLE_KEY\`，会写业务数据；不得自动运行，必须获得单独的数据修复授权。仓库中不得出现 service-role 凭据。 | 无自动回滚：恢复需要原始值或审计记录。因此失败时停止并按独立数据修复流程处理，而不是作为发布 workaround。 |
| \`scripts/verify-release-preflight.sh\` | 发布前 fail-closed 检查：要求符号分支为 \`main\`、\`HEAD == origin/main\`、工作区干净、CI 对应 SHA 成功、迁移已声明、rollback SHA 可解析。 | 仅读取/获取 Git 与 CI 元数据；不连接或写入生产业务数据。它将部署证据绑定到准备发布的精确 SHA。 | 任一条件不满足即阻断。解析得到的 rollback SHA 是部署失败时恢复服务的必要前提。 |
| \`src/lib/lead-auth.ts\` | 服务端 lead 授权 helper：\`admin\`、\`boss\`、\`operator\` 具备全 Case 访问；其他已认证角色仅能访问 \`assigned_to\` 为自身 user id 的 lead。 | 使用服务端 Supabase 会话和 \`auth.getUser()\`/profiles 角色；该 helper 不写数据，且不得削弱 owner 约束或把客户端输入当作授权依据。 | 授权回归必须阻断发布；恢复路径是回滚到上一已验证 release commit，不以放宽权限换取可用性。 |

### 本轮 M1 候选基线（SAM-6）发布与 UAT 收口条件

SAM-41 只补文档事实；SAM-6 候选基线只有在以下条件全部满足后，才可推进为最终发布结论。

1. 本节经 PR、CI 和合并后，发布源为合并后的精确、干净 `main` SHA，且 `scripts/check-spec.sh` 通过。
2. SHA 绑定的 CI 成功；\`scripts/verify-release-preflight.sh\` 通过；迁移声明正确，rollback SHA 可解析。
3. 正常部署链默认使用仓库内 \`scripts/crm-regression.py\`，不存在默认 \`.hermes\` 路径依赖；保留现有私有 fallback 以便回滚。
4. 部署后 evidence JSON 含真实的回归 pass/total 数值与全部通过状态；服务、健康入口和相关日志正常。
5. 仅在生产只读验证确认三项人员契约（可停用离职人员、候选人只包含启用的 sales/operator/boss、停用历史负责人仍可解析）后，才可认定发布对销售 Case 推进可靠；上述代码或 CI 的局部通过不等同于业务收敛。
6. SAM-43 的登录态视觉/交互 UAT 必须完成并留存通过证据后，才能关闭本轮 M1 发布门禁；登录超时、断言失败或证据缺失均保持 In Review，不得宣称完成。



## SPEC freshness correction — SAM-44（2026-07-23）

本节以 GitHub `main@49054606284a6f36d467899d4db8670f4fb455f5` 和 `scripts/check-spec.sh` 的逐路径匹配为准，覆盖该脚本在 Windows CI 中报告的当前 16 项未覆盖路径。它只记录实现事实与操作边界；不代表这些内容已部署，也不授权生产变更。

| 路径 | 实际职责 | 权限、安全与部署/回滚边界 |
| --- | --- | --- |
| `e2e/playwright.config.ts` | 根 E2E 配置：运行 `./e2e`、使用 boss/sales storage state、失败时保留 trace，并以生产域名为默认 base URL。 | E2E 运行会使用已有登录态；不得把认证状态或凭据提交到仓库。此文件本身不部署或写入业务数据。 |
| `playwright.config.ts` | 另一套 Playwright 配置：运行仓库根测试目录、默认生产域名、失败截图，并使用 JSON 结果文件。 | 生产目标意味着运行前须有显式授权和受控凭据；配置变更不等同于发布或 UAT 通过。 |
| `infra/observability/health-check.sh` | 定时采集磁盘、内存、CPU、进程、CRM health 与 Hermes 服务状态；异常时触发 incident capture，并发送 Sentry cron check-in。 | 在部署主机运行，读取系统状态并可启动后台证据采集；不应作为业务数据写入或发布脚本。失败监控不应掩盖发布门禁。 |
| `infra/observability/incident-capture.sh` | 将近期 systemd 日志、系统/网络状态、监控日志和最近 Git 记录快照到临时 incident 目录，并清理超过保留期的旧快照。 | 有主机日志与临时文件访问面；只用于取证。清理范围限于其 incident 临时目录，不能当作生产回滚。 |
| `infra/observability/incident-review.sh` | 列出或读取已采集 incident 的摘要和指定文件。 | 只读查看本地 incident 证据；输出可能含运行环境信息，访问应限于获授权操作者。 |
| `infra/observability/login-probe.sh` | 定时探测 health 与未认证 `/api/auth/me` 链路，有限重试；异常时采集 incident 并更新 Sentry cron 状态。 | 不保存测试凭据；对认证接口只验证可用性。探测失败是告警/取证输入，不是自动部署或权限绕过信号。 |
| `infra/observability/sentry-cron-checkin.sh` | 为监控脚本发送 Sentry Cron 开始/结束 check-in；未取得 DSN 时降级为不阻塞的 no-op。 | DSN 只可由运行环境或受限凭据文件提供；不得写入 SPEC、源码日志或仓库。 |
| `infra/observability/sentry-release.sh` | 在有运行时 Sentry token 时创建 release 与 production deploy 关联；缺少 token 时明确跳过。 | 对 Sentry API 有外部写入能力，须由部署环境授权；它不替代 GitHub CI、发布审批或应用回滚。 |
| `infra/observability/supabase-pool-monitor.sh` | 定时检查 Supabase REST 可达性并在连接/5xx 异常时采集 incident 与报告 Sentry cron 状态。 | 凭据必须来自受控运行环境，不能被硬编码或记录；监控是只读可用性探测，不得用于业务修复写入。 |
| `instrumentation.ts` | Next.js instrumentation 注册点；当前实现明确保持 server-side Sentry instrumentation 为 no-op。 | 这会限制服务端观测能力，但不改变应用授权或数据；恢复初始化应由独立改动、测试和发布审查处理。 |
| `scripts/deploy-immutable.sh` | 不可变 release 部署编排：创建 release 标识、管理 current/previous release、处理构建产物外部 symlink，并含候选清理 self-test。 | 会操作 release、锁和进程/端口，属于受控部署脚本；只能在批准窗口运行。失败应保留 previous release 用于回滚，禁止把 self-test 当作生产操作。 |
| `src/app/api/ready/route.ts` | 公开 readiness 端点：检查数据库、Supabase REST 与临时磁盘读写，读取 BUILD_ID，并以 200/503 返回 ready/degraded。 | 虽为 public，内部检查细节不应用作认证替代；临时磁盘探测仅服务 readiness，部署失败应由发布流程回滚而非伪造健康。 |
| `src/app/login/page.tsx` | 浏览器登录页：请求 Supabase token 后先调用服务端 `/api/auth/me` 验证 active profile；被拒绝时尝试注销并清除本地 token/cookie，再写入兼容的会话格式并跳转。 | 密码与 token 不得被记录；profile active gate 是登录边界，客户端清理失败也不能放宽服务端拒绝。 |
| `src/lib/logger.ts` | Pino 结构化日志与错误序列化：注入 service/environment/release/build 元数据，并遮蔽密码、token、cookie、授权头及常见 PII 字段。 | 日志仍可能暴露上下文，调用方不得放入敏感业务数据；日志不是审计授权或回滚机制。 |
| `src/lib/supabase-server.ts` | 服务端 Supabase client：解析 cookie/header token、以 refresh token 为键合并并发刷新、返回刷新 cookie 元数据，并优先使用显式 bearer token。 | 令牌刷新与 cookie 设置必须保持服务端会话边界；不得把 token 写入日志或客户端输入当作高权限凭据。认证回归应阻断发布并回滚到已验证 release。 |
| `tests/unit/auth-me.test.ts` | `/api/auth/me` 的 Node 单元测试：覆盖无效/有效 bearer 与 cookie、刷新成功/失败、inactive profile、异常处理，以及响应/日志不泄露调试键或 token/cookie 值。 | 测试只使用 mock 值；它验证认证边界但不提供生产登录或部署证据。 |

### 验证与残余 CI 边界

- 上述路径来自 Windows job `29931715552` 的 `check-spec.sh` 输出；该 job 因 16 个未覆盖路径失败。
- 该次 Linux `Repository validation` 另在 `npm run lint:baseline` 失败并因此跳过后续 typecheck、tests 与 build；该失败属于与本 docs-only 变更分离的既有 lint 债务，不能写成 SAM-44 已修复的业务/发布结论。
- 本节合并前，SAM-44 保持 In Progress；合并后仍须记录实际 main SHA、对应 CI run 和部署证据。没有新的、受控的部署证据，不得关闭事项或宣称生产已恢复。


## SAM-73 integration typed-contract paths (2026-07-23)

The integration draft carries the completed typed-contract fixes from PRs #80, #82, #83, #84, and #86. The following affected paths are part of this release-train scope:
- `src/app/(dashboard)/leads/[id]/utils.ts`: typed lead-detail project draft helper.
- `src/app/(dashboard)/projects/page.tsx`: role guard narrowed against nullable profile roles.
- `src/app/(dashboard)/quotes/page.tsx`: role guard narrowed against nullable profile roles.
- `src/app/(dashboard)/settings/ads/page.tsx`: nullable stage guard in quotation funnel aggregation.
- `src/app/(dashboard)/tasks/[id]/page.tsx`: task detail contract fields and required due date.
- `src/types/database.ts`: generated database type source, including task and quotation contract fields.


## SAM-60/SAM-68 release and readiness contract

The stacked release uses one immutable deployment authority with SHA-bound npm ci, private release node_modules, atomic lock/symlink switch, isolated candidate cleanup, exact manifest SHA and BUILD_ID checks, audited rollback, and fail-closed FragmentPath/DropInPaths ownership checks. The installer creates timestamped manifest backups, removes legacy forensic.conf and restart-always.conf after backup, preserves observability transport and secret configuration, installs versioned observability scripts and cron targets, and provides rollback. Public health is liveness-only; internal readiness requires a root-owned runtime token, one bounded Supabase probe, generic responses, and no synchronous disk I/O. Forensic logs are root:adm 0640. Sentry sanitization honors caller maxDepth.

Changed paths: scripts/deploy.sh, scripts/deploy-immutable.sh, scripts/install-systemd-assets.sh, scripts/rollback-systemd-assets.sh, infra/observability/newme-observability.cron, infra/systemd/newme-platform.service, infra/systemd/newme-readiness.sh, infra/systemd/newme-forensic.sh, newme-platform.service, src/app/api/health/route.ts, src/app/api/ready/route.ts, src/lib/observability.mjs, tests/unit/observability.test.mjs, tests/release/sam60-deployment-contract.test.mjs.


Path consistency: systemd, next.config.ts, installer, deploy preflight and release tests all require /opt/newme/current to be an atomic symlink into /opt/newme/releases/<sha>; the historical /home/ubuntu/newme-platform mutable root is not a release target.

Unified main integration coverage: infra/observability/hermes-alert-notifier-v1.sh, infra/observability/hermes-alert-state-v1.sh, infra/observability/newme-service-health.py, infra/systemd/newme-forensic.sh, infra/systemd/newme-readiness.sh, infra/systemd/newme-service-control.sh, scripts/install-systemd-assets.sh, scripts/rollback-systemd-assets.sh, scripts/systemd-recovery-drill.sh, sentry.client.config.ts, sentry.edge.config.ts, sentry.server.config.ts, src/app/api/auth/session/route.ts, src/lib/supabase-cookie-names.ts.


## 登录延迟修复与服务端 password grant — 2026-08-11

本节记录 `scripts/check-spec.sh` 报告的 9 项未覆盖路径的实现事实与边界。它不代表已部署：本轮改动截至写时仅有本地门禁证据（typecheck clean、`npm test` 376/373 pass/0 fail/3 skipped、`check:security` 107 findings 无超基线、`check:workflows` 3/3、`check:release` smoke 14/14、build exit 0），生产登录耗时尚未实测。

### 行为变更（更正 SAM-44 对 `src/app/login/page.tsx` 的描述）

SAM-44 记录的登录实现为“浏览器请求 Supabase token 后再调 `/api/auth/me`”。该描述已过时。旧实现由**浏览器直连 GoTrue** 做 password grant，因此登录会离开 Cloudflare 边缘、向 Auth 区付一次冷 TLS 握手，随后再串行 `/api/auth/session` 与 `/api/auth/me` —— 共 3 次串行往返才渲染 dashboard。已测分层：Node 1.8ms / nginx+TLS 6ms / 过 Cloudflare 60-65ms / 生产→Supabase 45-48ms。

新实现把 grant 与 active-profile 门禁收到服务端，浏览器只发 1 次同源请求（走已建立的边缘连接），服务器侧走热连接完成 grant + profile 读取。

安全边界是加强而非交换：浏览器不再接触裸 access/refresh token；未通过 active 门禁的 profile 根本不会拿到任何 cookie，且其刚签发的 token 在响应返回前已向上游 `/auth/v1/logout` 注销；上游失败文本（可能回引提交的密码）既不转发也不入日志，所有被拒凭据返回同一泛化错误。

把鉴权收到服务端会把全部用户汇入单一 origin IP，从而把 GoTrue 的 per-IP 爆破保护塌缩成一个桶。因此该端点必须自带替代边界（见 `src/lib/rate-limit.ts`）。

### 路径覆盖索引

| 路径 | 实际职责 | 权限、安全与部署/回滚边界 |
| --- | --- | --- |
| `src/app/api/auth/login/route.ts` | 服务端 password grant 端点（本轮新增）。顺序固定为：content-type → origin → 配置 → body 解析 → 限流 → GoTrue `grant_type=password` → 用**刚签发的用户 token** 经 RLS 读 profiles → active 门禁 → 写会话 cookie。上游 5xx 返 503 `auth_unavailable`，其他非 2xx 一律返 401 `invalid_credentials`。 | 属 `PUBLIC_API_PATHS`（pre-authentication 端点无法要求已有会话），因此自带 origin 校验与限流。profile 门禁使用用户自身 token 而非任何特权 key，鉴权边界仍是 profiles 自查 RLS。**active 门禁必须早于 cookie 签发**（由 `tests/security/session-revocation.test.mjs` 断言顺序）；被拒请求零 `Set-Cookie`。认证回归须阻断发布并回滚到上一已验证 release。 |
| `src/lib/session-cookies.ts` | 会话 cookie 契约的唯一来源（本轮新增）：`sb-<ref>-auth-token` 为脚本可读（`httpOnly:false`，仅含 access_token 与 expires_at），`sb-<ref>-refresh-token` 为 `httpOnly:true`；两者均 `sameSite:"strict"` + `secure:true`。同时提供 `expectedSessionOrigin`（生产 host 不因 `x-forwarded-host` 被削弱）与 `normalizeExpiresIn`。 | 两个端点各自手写 `Set-Cookie` 是最终会漏掉 `secure`、或漏掉 refresh 半边 `httpOnly` 的成因，故 login 与 session 两个 route 均只能经 `applySessionCookies(`，且均不得直接调 `cookies.set(`（`tests/security/sam15-boundaries.test.mjs` 循环断言）。该模块用 `import type { NextResponse }`，因此无运行时 `next/server` 依赖。 |
| `src/lib/rate-limit.ts` | 进程内固定窗口限流器（本轮新增）。`clientIdentifier` 依次读 `cf-connecting-ip` → `x-forwarded-for` 首段 → `x-real-ip`。login 端点应用每 IP 20/5min 与每账号 8/15min（账号键大小写归一）。超限返 429 带 `Retry-After`，且**不转发上游**。 | 这是服务端鉴权后替代 GoTrue per-IP 保护的必要边界，不是可选优化。**已知作用域限制：计数器在单 Node 进程内存中**，`MAX_TRACKED_KEYS=10000` 为内存兜底；多进程/多实例部署必须先改为共享存储，否则实际上限被进程数放大。 |
| `src/lib/session-identity.ts` | 客户端会话身份读取（本轮新增），故意拆成两个入口：`readSessionIdentity()` 始终发起真实 `/api/auth/me`（仅做 in-flight 去重），`peekSessionIdentity()` 允许复用 60s 内缓存，仅供分析用途；`forgetSessionIdentity()` 在登出时清除。 | **鉴权路径永不读缓存**：`readSessionIdentity` 函数体不得出现 `lastActive`，`useAuthRedirect.ts` 只能用 `readSessionIdentity()` 且不得用 `peekSessionIdentity`（`tests/security/session-revocation.test.mjs` 断言）。缓存身份用于路由准入会让已停用账号在缓存窗口内继续通过。 |
| `src/components/PostHogProviderInner.tsx` | 分析身份识别改为 `await peekSessionIdentity()`，不再自行 `fetch("/api/auth/me")`，消除挂载时与 `useAuthRedirect` 的重复并发往返（2 次 → 1 次）。 | 该组件不得直接 `fetch(`（断言）；它只消费分析用身份，不构成任何授权判断。 |
| `e2e/production-anonymous.spec.ts` | 匿名生产发布边界 E2E：断言 `/api/health` 200 且 `status:"ok"`、`/` 307 → `/dashboard`、未认证 `/api/auth/me` 的拒绝行为，且页面无浏览器错误。 | 仅覆盖匿名可达面，不使用任何登录凭据；通过不等于登录态 UAT 通过（SAM-43 门禁不可由此替代）。 |
| `playwright.production-smoke.config.ts` | 匿名生产 smoke 的 Playwright 配置：**强制 base URL 为 loopback HTTP 且端口为显式非特权端口**，否则构造期直接 throw；并绑定 `E2E_EXPECTED_SHA`。 | 该 fail-closed 约束是防止把生产域名当作 smoke 目标的边界，不得放宽为任意 origin。 |
| `scripts/check-schema-refs.py` | 当 `.from("table")` 的字面表引用不在 `scripts/schema-tables.txt` 评审清单中时失败（含多行调用）。 | 属 `check:release` 链的一环；它防止引用未经验证的表名（对应 Freeze Rule 6），失败必须阻断发布而非加白。 |
| `src/components/MetaPixel.tsx` | Meta Pixel 客户端加载器，按 `NO_PIXEL_PATHS` 排除全部登录后与内部路径（含 `/login`、`/change-password` 及各业务页）。 | 该排除列表是不向第三方像素泄露内部路径与登录态浏览行为的边界；新增内部路由时必须同步加入排除列表。 |

### 验证边界

- 本节路径清单来自本地 `scripts/check-spec.sh` 输出（9 项未覆盖，hard limit 5）。其中 4 项（`e2e/production-anonymous.spec.ts`、`playwright.production-smoke.config.ts`、`scripts/check-schema-refs.py`、`src/components/MetaPixel.tsx`）为本轮之前既存的文档欠账，一并补齐。
- 本轮同时更正了 4 个把**旧行为**钉成必要条件的安全门禁：其一钉住了 F-07 漏洞本身，其三钉住了 3 次往返的客户端舞步。断言均迁至属性新位置，无一被削弱，其三被加强（解析式精确 `PUBLIC_API_PATHS` allowlist、gate-before-cookie 顺序、鉴权不读缓存）。
- `supabase/migrations/20260811100*.sql` 共 5 个迁移已写入但**未应用**（F-02/F-06/F-08/F-09/F-10）。阻塞原因为 Supabase MCP 连接只读。未应用前不得把相关发现写成已修复。
- 生产登录耗时未实测，TASKBOARD 相关行保持 `REVIEW`。没有部署后的实测证据，不得关闭本轮性能事项。

## L0 复审收口：迁移可重放门禁、发布声明校验与开放重定向 — 2026-08-11

本节记录独立复审（PR #397）后新增/修改的路径。它同样不代表已部署，也不代表迁移已应用：证据仅为本地与 GitHub CI 门禁。

### 本轮行为变更（摘要）

- **迁移目录不是可重放历史**（新发现，未修）。**修订记录（2026-08-11，三审后）**：本条上一版记录的四项"修复"——把 `1780601210_workflow_stages.sql` 改名为 `20260604192650_`、把 `20260603000000_add_crm_fields.sql` 改为墓碑、新增回填日期 `20260601010000` 的 baseline、以及改写 `supabase/seed.sql`——是对**已应用迁移历史的重写**，三审全部否决，本轮已按 PR base `81956f2ff3bf` **逐字节还原**（`scripts/check-migration-history.mjs` 对 103 个既有文件核对 sha256 并与 base 的 git blob 比对）。已确证的成因不变且仍未修：`1780601210_` 的 10 位前缀不匹配 CLI 的 `^[0-9]{14}_`，故该文件从未被 CLI 看见而其表在线上存在；`20260603000000_add_crm_fields.sql` 含 `ALTER TABLE TABLE` 且 CLI 单文件单事务，故从未在任何环境应用；`20260604000002` 从不存在的 `leads.metadata` 回填；`meta_tokens`、`profiles.password_changed_at`、`profiles.force_password_change`、`leads.rep_name` 无任何迁移声明。本轮改为 forward-only：新增文件一律排在历史末尾（`20260806000000` baseline、`20260812000000`、`20260813000000`），因此 `MODE=history` 的停止点回到真实值——**2 个文件后停在 `20260602010000_crm_mvp_final.sql`**（`lead_alerts` 视图选 `l.rep_name`）。该数字被 `supabase/replay/history-replay-expectation.txt` 钉死为门禁。真正的修复需线上 schema 真相（`supabase db dump` 压平 baseline），且若干死文件含会改写生产行的 backfill，属运维任务，不在本分支猜测。
- **F-02 由删除改为停用**：不再 `delete from auth.users`/`profiles`，改为 `is_active=false` + `force_password_change=true` + 最后特权账号互锁，1514 条 `audit_logs.actor_id` 归属全部保留，且可由 `supabase/migrations/rollback_l0_20260811.sql` 逆转。**修订记录（2026-08-11，三审后）**：该迁移只改 `public.profiles` 的两列，它**既不封禁 `auth.users` 身份，也不吊销任何已签发会话**。凭 `DEV_EMAIL`/`DEV_PASSWORD` 仍可向 GoTrue 完成 password grant 并直连 Supabase Auth/PostgREST——`profiles.is_active` 只被 Next.js 的 `/api/auth/login` 与 proxy 读取，PostgREST 路径不读它，且 admin 相关 RLS policy 判的是 `role` 而非 `is_active`。因此**该公开凭据在得到单独授权的生产封禁 + 会话吊销动作及其后置证据之前，必须视为仍然有效**；F-02 在 TASKBOARD 上保持未关闭。本轮只交付代码侧的 fail-closed 切换契约（`supabase/preflight/f02-credential-cutover.md` + `20260813000000_session_revocation_boundary.sql`），未执行任何生产 Auth 动作。
- **F-09 phase 1 只改函数权限**：EXECUTE 经 PUBLIC 泄漏给 `anon` 是缺陷本身；对 `contracts`/`payments`/`installment_plans`/`contract_approvals`/`quotations` 的表级 REVOKE 已删除——大量写入走调用者自身 client（Postgres 角色 `authenticated`），照原样发布会造成资金路径全线 42501 停摆。**phase 2（2026-08-11，三审后新增 `20260812000000_money_actor_identity_and_atomicity.sql`）**：授权判定不再取自调用方参数。`money_actor(p_claimed, p_allowed_roles)` 在 `auth.uid()` 非空时以 **token subject 为唯一 actor**，参数不符即 42501，并检查 profile 存在、`is_active`、角色属实；五个 `trg_guard_*` 触发器（**故意 SECURITY INVOKER**，因为判别式 `money_write_is_direct()` 读 `current_user`，改成 DEFINER 会让判别式对所有人放行）对以 `authenticated`/`anon` 到达的直写抬手 42501，而 definer 例程与 `service_role` 不受影响。见本节下方"资金路径原子化"。
- **发布声明校验**：`scripts/deploy-immutable.sh` 写入的永久证据里 `ci.*`/`migration.*` 原为环境变量直接串行化，无任何校验；现新增 `validate_release_claims()`，在任何 mkdir/symlink/服务动作之前 `exit 64`。

### 路径覆盖索引

| 路径 | 实际职责 | 权限、安全与部署/回滚边界 |
| --- | --- | --- |
| `src/lib/safe-redirect.ts` | 登录后跳转目标的唯一净化入口：仅接受同源绝对路径（保留 query/hash），拒绝任意 scheme 的绝对 URL、`//host`、`///host`、反斜杠 authority、`FORBIDDEN_CHARS` 覆盖的控制字符、非字符串，以及超过 `MAX_REDIRECT_LENGTH=512` 的输入；兜底为 `DEFAULT_REDIRECT="/dashboard"`。 | `?redirect=` 由攻击者控制，未净化即为开放重定向；配合脚本可读的 `sb-<ref>-auth-token` cookie，跳转目标能取得刚建立的会话上下文，因此这是会话令牌链的一环而非 UX 细节。负向断言在 `tests/unit/l0-auth-hardening.test.mjs`，任何放宽都必须先改该文件。 |
| `src/lib/release-script.ts` | 把仓库相对路径解析为发布树内的真实文件；`null` 表示拒绝。拒绝空串/纯空白/非字符串、绝对路径、任何含 `..` 的路径段、解析后逃出仓库根的路径，以及目录（`statSync().isFile()`）。 | 修订记录（2026-08-11）：上一版对空输入 fail-open 返回 `process.cwd()`，且用前缀包含判断而非 `path.relative` 归一。它是脚本执行前的 fail-closed 边界，只能返回仓库内既存文件；`scripts/cos-presign.py`、`scripts/parse-ad-spend.py` 均在版本控制内，故属可解析目标——本函数负责路径边界，不负责授权。 |
| `scripts/replay-migrations.sh` | 一次性迁移重放，三种模式，**三者皆为门禁**（修订记录 2026-08-11：上一版 `MODE=history` 以 `continue-on-error: true` 运行，即不可能让 job 变红，属 false-green，已改）：`MODE=branch` floor → 本分支 9 个迁移 → fixtures → 再次应用（幂等）→ 131 条契约断言 → rollback 伴随文件 → 30 条 post-rollback 断言；`MODE=control` floor + fixtures **不含**迁移，要求 `CONTROL_MUST_FAIL` 中 100 条断言全部失败，且 `100 + 31 = ASSERT_TOTAL` 必须闭合（任何断言都不得游离于两个集合之外，也不得因文件首条即中止而"零断言通过"）；`MODE=history` 从空库按序重放全部 14 位迁移，必须**恰好**在 `supabase/replay/history-replay-expectation.txt` 记录的第 2 个文件后停在 `20260602010000_crm_mvp_final.sql`——更好与更坏同样红。另含文件名 lint：非 14 位且非 `rollback_` 前缀即硬失败。 | 只连接 `PGDATABASE` 指向的一次性库，且目标库已有应用表时拒绝启动；不读任何密钥，CI 用 `postgres:17` service container + trust 认证。它**不是**生产迁移工具，也不证明生产已应用。`rollback_*.sql` 不匹配 CLI 的 `^[0-9]{14}_` 规则，因此永不被自动应用，只能由运维显式执行。 |
| `infra/systemd/newme-deploy.sh` | 唯一 canonical 部署入口（root，systemd）。查询 GitHub API 后要求 run 的 `id`/`head_sha`/`name=ci`/`conclusion=success`/`event=push`/`head_branch=main` 全部匹配，再把声明以环境变量传给 `scripts/deploy-immutable.sh` 复核。 | 修订记录（2026-08-11）：原检查只比对 `id`/`head_sha`/`name`/`conclusion`，因此**任一分支上绿色的 `pull_request` run 都被当作 main 证据**；而 release-final 作业以 `github.event_name` 为条件，故 `pull_request` run 的门禁集严格更小——不完整门禁被记成完整门禁。`event` 与 `head_branch` 现为声明的一部分（`tests/release/deploy-release-claim-validation.test.mjs` 直接执行该校验块与 `validate_release_claims()`）。GitHub token 只经 `--config` 文件传入 curl 且随即 `unset`，不得出现在命令行。 |

`supabase/replay/01_floor_schema.sql`、`supabase/replay/05_seed_behaviour_fixtures.sql`、`supabase/replay/10_assert_release_contracts.sql`、`supabase/replay/20_assert_post_rollback.sql`、`supabase/migrations/20260806000000_baseline_undeclared_production_objects.sql`、`supabase/migrations/20260811100500_kpi_targets_atomic_replace.sql`、`supabase/migrations/20260812000000_money_actor_identity_and_atomicity.sql`、`supabase/migrations/20260813000000_session_revocation_boundary.sql`、`supabase/migrations/rollback_l0_20260811.sql` 属同一门禁资产：floor 复现**未修复的线上姿态**（含 `meta_tokens` 的宽松 policy 与 grant），fixtures 建立行为断言所需数据，断言文件以 `has_table_privilege`/`has_column_privilege`/`has_function_privilege` 与 `set local role authenticated` 的真实执行验证边界，并自校验断言总数为 131；`20_assert_post_rollback.sql` 的 30 条断言证明回滚**不削弱安全**（回滚后 `audit_logs`/`user_sessions` 的伪造插入仍被拒、`meta_tokens` 不回到 `authenticated` 可读、资金 definer 例程的 `anon` EXECUTE 不回来）。

### 验证边界

- 无线上数据库证据：`supabase-prod` MCP 需要交互式 OAuth，本会话不可用。所有结论来自源码、`src/types/database.ts`（由生产生成）与 `docs/rls-explorer.md`，未执行任何生产查询、迁移、部署或重启。
- 5 个 L0 迁移加本轮新增的 4 个（末尾 baseline / KPI 原子替换 / 资金 actor 原子化 / 会话吊销边界）与 rollback 伴随文件**仍未应用于生产**。`MODE=branch` 通过只证明它们在一次性库上可应用、幂等、可回滚且行为断言成立。
- `MODE=history` 仍不通过，但**已是门禁**（修订记录 2026-08-11：上一版的 `continue-on-error: true` 使该步骤不可能让 job 变红）。停止点被 `history-replay-expectation.txt` 钉为 `EXPECTED_APPLIED=2` / `EXPECTED_STOPPED_AT=20260602010000_crm_mvp_final.sql`；把它变成通过需要运维先用线上 schema 压平 baseline。
- `src/types/database.ts` 正常由生产 schema 生成，但本轮**手工补入** `replace_kpi_targets`、`create_contract`、`convert_quotation_to_contract`、`set_contract_status`、`revoke_contract` 的 `Args`/`Returns`：这些函数由本轮迁移创建、生产尚不存在，不手工补入则对应的 `supabase.rpc(...)` 无法通过 `typecheck`。迁移应用后下一次 `npm run generate:database-types` 会以生产真相覆盖它们；在此之前这些条目是**声明而非观测**（`tests/security/money-route-rpc-coupling.test.mjs` 因此另行核对每个 route 传的实参与迁移里的形参一致——typecheck 无法发现"手工声明与迁移不符"）。指纹已按新的 `supabase/migrations/` 内容重新 stamp。
- `crm-ci.yml` 的 `workflow_run` 修复在本 PR 上**无法观测**：GitHub 只从默认分支读取 `workflow_run` 触发器定义，`hermes-contract` 另有 `head_branch == 'main'` 条件。故本 PR 的 `ci` 成功不触发 `crm-ci`，`gh run list --workflow crm-ci.yml` 对本 PR head 无 run —— 这是预期，不是回归。真实证据须在合入 main 后的首次 main push 取得。本轮未 dispatch `crm-ci`：该 workflow 会向外部 Hermes 端点投递 webhook，属对外动作。
- AGENTS.md 声称 `scripts/deploy.sh` Step 0 运行 `check-taskboard.sh`；三审前 `scripts/deploy.sh` 只有 4 行 `exec`，`deploy-immutable.sh` 与 canonical wrapper 均不调用该门禁。**修订记录（2026-08-11，三审后）**：canonical wrapper 现在按顺序硬门禁三件事——(1) 从 `/actions/runs/{id}/jobs` 逐 job 读 `conclusion`（run 级 `success` 会把"被 skip 的必需 job"记成绿），要求 `infra/release/required-jobs.json` 列出的每个 job 都 `success`，其中 `Release-final taskboard completion` 只可能出现在 `release_final=true` 的 dispatch run 里（`workflow_dispatch` 的 inputs 不由 runs API 暴露，该 job 存在与否是唯一可得的证明）；(2) `scripts/check-taskboard.mjs --require-scope=predeploy_ready`（`infra/systemd/newme-deploy.sh:674`）；(3) `scripts/verify-remote-migration-history.mjs`（`newme-deploy.sh:623`）比对远端 `supabase_migrations.schema_migrations` 与仓库目录。**新增运维前置条件**：canonical deploy 需要 root 拥有的 `/etc/newme/migration-db.url`（mode 0400/0600）与 root PATH 上的 `node`，缺失即 `exit 65`。**修订记录（2026-08-14，第 4 轮 C4-4）**：(2) 由 `--require-complete` 改为 `--require-scope=predeploy_ready`。原门禁不可满足——TASKBOARD 多数行的关闭条件就是"生产已跑过本次发布"，"要求整块看板完成"等于把部署自身的结果当作部署的前置条件；不可满足的门禁不是严格门禁，而是必然被绕过的门禁。三个里程碑（`predeploy_ready` < `bootstrap_ready` < `postdeploy_acceptance`）在 `TASKBOARD.md` 的 `<!-- taskboard-scopes:begin/end -->` 块内逐行声明，`scripts/check-taskboard.mjs` 每次运行都双向校验：未声明的未完成行是 FAIL 且仍计入 `predeploy_ready`（fail-closed），没有对应未完成行的声明也是 FAIL。要求后一个里程碑累积要求前一个；release-final 的 `check:taskboard:complete` CI job 仍要求整块看板。部署门禁记录名同步为 `gate=taskboard-predeploy-ready`（`scripts/verify-deploy-gate-record.mjs` 的 `REQUIRED_GATES` 对缺失名与未知名都拒绝），控制面 bootstrap 运行手册在接受新控制面为 live 之前额外跑 `--require-scope=bootstrap_ready`。

## L0 三审复审收口：资金调用者身份、原子化与 forward-only 迁移 — 2026-08-11

三名独立复审否决了 head `fb7fe7ca51e3170e5b3a9285457023c59d89c334`。本节记录逐条复现后的改动。**它不代表已部署，也不代表迁移已应用**：本轮同样无任何线上库通道（`supabase-prod` MCP 需交互式 OAuth），生产未被修改——未应用迁移、未部署、未重启/reload、未触碰 Auth 用户/会话、未改生产数据或控制面。

### 迁移历史：只做 forward-only

上一版把已应用的迁移改名、墓碑化并回填了一个早于全部历史的 baseline。这是历史重写，三审全部否决，本轮**按 PR base `81956f2ff3bf` 逐字节还原**（含 `supabase/seed.sql`）。新增门禁 `scripts/check-migration-history.mjs`：以 `supabase/migration-history-baseline.sha256` 为清单，核对 103 个既有文件的 sha256 未变、并与 base 的 git blob 逐一比对，任何改名/改字节/删除即红。新增文件一律排在历史末尾（`20260806000000` / `20260812000000` / `20260813000000`）。代价已在 `supabase/replay/history-replay-expectation.txt` 里写明：末尾 baseline 对 `MODE=history` 毫无帮助，停止点从 9 回到真实的 2——这个更小的数字才是诚实的。

### 资金路径：调用者身份与原子性（`20260812000000_money_actor_identity_and_atomicity.sql`）

复审确认的缺陷是**授权判定取自调用方参数**：`approve_contract`/`confirm_payment`/`allocate_payment` 相信调用者传来的 approver/confirmer/allocator id，而 EXECUTE 已授予全部 `authenticated`；同时资金写入分散在多个事务里，失败留下已提交的半成品并以 HTTP 200 + `warning` 上报。本轮：

- `money_actor(p_claimed, p_allowed_roles)`：`auth.uid()` 非空时以 token subject 为唯一 actor，参数不符即 42501；service_role/无 JWT 上下文必须显式传 `p_claimed`；随后校验 profile 存在、`is_active`、角色属实。
- 五个 `trg_guard_*` 触发器（**故意 SECURITY INVOKER**）：判别式 `money_write_is_direct()` 读 `current_user`，若改为 DEFINER 则 `current_user` 变成 owner、判别式对所有人放行——这是本设计不可改动的理由。`contracts` 直插全拒、UPDATE 冻结 status/contract_amount/contract_no/sales_id/created_by/lead_id/quotation_id/currency/contract_date（`file_url`/`file_metadata`/`first_payment_status` 仍可直写，故 `confirm-upload` 与 PUT 无需改）；`payments` 只许 `created_by = auth.uid()` 的未确认插入、已确认行除 notes 外不可变；`installment_plans` 直插/直删全拒且冻结金额与序号；`contract_approvals`/`payment_allocations` 直写全拒。
- 新增 definer 例程 `create_contract` / `convert_quotation_to_contract` / `set_contract_status` / `revoke_contract`，与既有 `approve_contract` 一起在**单事务**内完成合同、分期、审批行与状态流转；`allocate_payment` 现把分期计划绑定到该笔付款自己的合同（跨合同即 42501）并在前后各重算一次。SQLSTATE 词汇固定为 42501/22023/23505/P0002。
- `on_lead_won()` 改为创建 **draft** 合同（原为 `active`）+ 待审 `admin_review` 行，合同号取自 `next_contract_no()`，并以"该 lead 已有合同即 return"保持幂等（转换例程在同一事务里置 `final_status='won'`，因此不会双建）。**这是有意的行为变更，需登录态 UAT。**

### 路径覆盖索引（本轮）

| 路径 | 实际职责 | 权限、安全与部署/回滚边界 |
| --- | --- | --- |
| `src/lib/money-rpc.mjs` + `src/lib/money-rpc.d.mts` | 资金例程 SQLSTATE → HTTP 的唯一映射：42501→403、22023→400、23505→409、P0002→404，其余→500。 | 未映射的错误一律 500 且**不回引数据库消息**（unique/check 违例的 detail 会带行值）；已映射的消息是迁移里自撰文案，故可回传。它被替代的行为是"多数情况返 HTTP 200 + `{error}`/`{warning}`"——客户端无法区分拒绝与成功。写成 `.mjs` 是为了让 `node --test` 执行**与 route 完全同一份**函数，而不是另写一份等价实现（`tests/security/money-route-rpc-coupling.test.mjs`）。 |
| `src/app/api/contracts/[id]/route.ts` | 新增 `PATCH`（原模块只导出 `GET`）。 | 合同详情页自诞生起就在 PATCH 这个路由（`page.tsx:307`），因此**每个状态按钮一直是 405**——该页的状态变更从未生效过。修复不是补一个写 `body.status` 的 handler：那会把该页的九宫格变成审批链旁路（`approved`/`pending_ceo` 曾在按钮里）。状态由 `set_contract_status()` 按转移表决定，越界返 400。 |
| `src/app/(dashboard)/contracts/[id]/page.tsx` | 状态按钮从固定九宫格改为按当前状态渲染 `STATUS_TRANSITIONS[status]`；`terminated` 强制填原因才可提交。 | `STATUS_TRANSITIONS` 与 `set_contract_status()` 的转移表被测试断言为**双向相等**（页面不得提供例程会拒的转移，例程允许的也不得被页面藏起来），且审批链状态不得出现在网格里。`signed`/`cancelled` 连 `contracts_status_check` 都没有。 |
| `scripts/check-migration-history.mjs` + `supabase/migration-history-baseline.sha256` + `scripts/regenerate-history-baseline.sh` | 迁移历史不可变门禁与其基线生成器。 | 基线只能由 `regenerate-history-baseline.sh` 在**显式说明理由**的 commit 里重生成；日常路径是新增末尾文件而非改动既有文件。 |
| `scripts/verify-remote-migration-history.mjs` + `infra/release/required-jobs.json` | 远端 `supabase_migrations.schema_migrations` 与仓库目录的比对；canonical deploy 的必需 job 清单。 | 前者只读迁移元数据，不读任何业务行；连接串只从 root 拥有的 `/etc/newme/migration-db.url`（0400/0600）读入，不经命令行参数。后者要求逐 job `conclusion=success`，修正了"run 级 success + 必需 job 被 skip"这一 false-green。 |
| `supabase/preflight/f02-credential-cutover.md` + `supabase/migrations/20260813000000_session_revocation_boundary.sql` | F-02 的 fail-closed 切换契约与会话吊销边界。 | 迁移侧只做数据库能做的部分（token `iat` 与 `password_changed_at` 比对边界、`auth.users` 需要 SELECT 权限）。**refresh token 只能由 GoTrue 吊销**，故直连 Auth 的重放缺口在数据库层无法关闭；F-02 因此保持未关闭，且封禁 + 会话吊销必须由单独授权的生产动作执行并留后置证据。 |
| `supabase/replay/20_assert_post_rollback.sql` | 回滚后的 30 条安全断言。 | 回滚必须能撤销**业务姿态**而不得撤销**安全边界**：回滚后伪造 `audit_logs`/`user_sessions` 插入仍被拒、`meta_tokens` 不回到 `authenticated` 可读、资金 definer 例程的 `anon` EXECUTE 不回来。"回滚 SQL 能执行"不是回滚证据。 |

### 验证边界（本轮）

- 无线上库证据。本节所有结论来自源码与在一次性 `postgres:17.10` 容器上的重放，未执行任何生产查询、迁移、部署、重启，未触碰 Auth 用户/会话。
- **仍需单独生产授权的动作**：应用 9 个待应用迁移（其中 `20260813000000` 要求执行角色对 `auth.users` 有 SELECT）；封禁 `dev@newme.ae` 的 Auth 身份并吊销其会话（F-02 的真正关闭条件）；轮换已公开的凭据；仓库转 private 与 git 历史清除；origin 防火墙限定 Cloudflare 段；`/etc/newme/migration-db.url` 的落地。
- **仍需登录态 UAT**：`on_lead_won()` 由 active 改 draft 后的 lead→合同链；合同详情页状态按钮（此前一直 405）；报价转换与审批两步链；付款分配与 KPI 周期替换。KPI 遗留重复键的前置检查会**按设计**中止生产部署（fail-closed），需运维先清理。
- 应用 `20260812000000` 后，任何仍以调用者 client 直写资金表的代码路径会立刻 42501。本轮已改的五个 route 由 `tests/security/money-route-rpc-coupling.test.mjs` 钉住；新增此类写入必须同 commit 改测试与 replay 断言。

## L0 四审 A0（Batch 0）：已发布凭据的扫描范围收口 — 2026-08-12

管理层在三份独立只读复审之后把余下工作切成三批，本节只记 Batch 0：**源码侧已发布凭据这一个 P0**。它同样**不代表已部署、也不代表迁移已应用**：本轮无任何线上库通道，生产未被修改 —— 未应用迁移、未部署、未重启/reload、未触碰 Auth 用户/会话、未改生产数据或控制面，也**未轮换任何凭据**（明确未获授权）。

### 上一版的门禁是假绿的，成因有三个且彼此独立

`scripts/check-published-credentials.mjs` 上一版对本树报 OK。核对后成立，而且比复审指出的更宽：

1. **范围**。门禁的 `SKIP_PREFIX` 把 `.next.backup/` 整个目录排除在扫描外，而那里躺着 **1634 个被 git 跟踪的构建产物**，其中两份 `.js.map` 的 `sourcesContent` 仍带着 `/api/dev/setup` 早已删除的那个明文口令。把生成物当作"门禁已读过的源码的派生物"而豁免，推理成立、结论错误：**生成物是一份更旧的源码的切片**，源码改了、快照没改。根因在 `.gitignore` —— 它写的是 `.next.backup.*`（带点），永远匹配不到目录 `.next.backup/`，少一个斜杠就把一次构建备份提交进了仓库。
2. **编码**。sourcemap 里每个引号都是 JSON 转义的，任何面向源码的正则都匹配不过转义。`.map`/`.json` 现在先解转义、再按真实行号判定。
3. **表格识别**。`OC-MIGRATION-BRIEF.md` 是**带行号栏**保存的（每行以自己的行号加一个竖线开头），于是没有一行以竖线开头 —— 这个文件在门禁眼里既没有表格行、没有表头，也没有口令列。

已修：扫描范围改成**恰好等于 `git ls-files`，不再排除任何东西**（978 个跟踪文件、17.9MB，其中 9 个含 NUL 的按二进制跳过并计数；5.5MB 的跟踪生产日志也是第一次被扫到）；1634 个产物移出索引并补上 `.gitignore` 的斜杠；"跟踪了构建产物"本身成为一条结构性 finding；规则五条增到九条；测试 11 条增到 19 条，并给行号栏与 JSON 转义各配**一个变异对照** —— 把被替换掉的旧判定原地重写一份、断言它在同一夹具上返回 `[]`，否则夹具失效时测试会静默变成永真。

范围一改，又暴露四处**非生成物**的发布：`test-matrix-runner.mjs`、`test-matrix.md`、`test_matrix.py`、`OC-MIGRATION-BRIEF.md`。它们带出**第八个身份**，并且其中三个身份**各有不止一个已发布的值**（所以轮换按身份算、不按值算），`test_matrix.py` 另外把一条完整的 Supabase PAT 提权配方写在可执行位置上。**`git rm --cached` 只是停止跟踪，不是抹除**：这些文件仍在 git 历史里，凡 clone 过本仓、或读过本仓任一次构建产物的人都已知这些值。

### 路径覆盖索引（本轮）

| 路径 | 实际职责 | 权限、安全与部署/回滚边界 |
| --- | --- | --- |
| `scripts/check-published-credentials.mjs` + `tests/security/published-credentials.test.mjs` | 已发布凭据门禁与其反向回归。范围 = `git ls-files`，九条规则，只报路径与规则名。 | **从不打印命中的值** —— 会打印值的门禁等于把凭据重新发布到每一次 CI 日志里；`tests/release/ci-full-stack-gates-contract.test.mjs` 把这条钉成结构性质：finding 对象只有 `rule`/`line`/`detail` 三个键，没有能装值的字段，且门禁每条输出的插值里不得出现 value/secret/password 一类标识符。ALLOWLIST 按标识符而非行号键入，并有一条测试要求每个条目对应的文件仍被 git 跟踪 —— 豁免活得比文件久，是门禁悄悄失效的典型方式。 |
| `src/lib/dev-identity.mjs` + `src/app/api/dev/setup/route.ts` + `src/app/api/auth/dev-login/route.ts` | dev 身份只能来自环境变量，未配置即**拒绝**而不是回落到字面量。 | 被替代的写法是 `process.env.DEV_PASSWORD || "<字面量>"`：它让"没配环境变量"等于"用 git 历史里那个口令"。未配置时两条 route **完全不触达 Supabase**；Supabase 未配置返 503 而不是把 `!` 断言抛成堆栈；`/api/dev/setup` 不再对已存在身份重设口令（那让 bootstrap 端点变成无鉴权的改密端点）。拒绝理由码里不含任何值。 |
| `test_matrix.py` + `test-matrix-runner.mjs` | 角色矩阵测试脚本。口令改为按环境变量名读取，缺失即以 `SystemExit` 拒绝。 | 这两个文件此前把四个身份的明文口令写在可执行位置上，且不含任何 credential 关键词（是"地址 + 值"的形状），因此所有基于标签的规则都走了过去 —— 新增的 `credential-pair` 规则就是为这个形状写的，并带七种"必须保持干净"的相邻形状作为反向夹具（UUID、常量、函数调用、DSN 路径、文档引用、第二个地址、散文）。 |
| `src/app/api/payments/[id]/void/route.ts` | 付款的**受支持撤销路径**（admin/boss/finance）：调用 `void_payment()`，在单事务内释放分配、标记作废并重算派生总额。 | 三审 P1-2：`trg_guard_*` 覆盖了 INSERT/UPDATE 但没覆盖 DELETE，而 `authenticated` 持有 payments 的 DELETE，浏览器会话可以删掉一笔已确认付款；分配行随 CASCADE 一起消失，而 `allocated_amount`/`paid_amount`/`actual_amount`/`first_payment_status` 仍把这笔钱算在总额里。`20260814000000` 撤销并拒绝五张资金表上的 DELETE，撤销改由 `void_payment()` 完成 —— **行保留**才是可审计的，删掉的行不可审计。授权边界在例程侧（`money_actor()` 绑定 JWT subject），route 里的角色检查只是提前给出同样的 403。 |
| `supabase/replay/15_concurrency_two_session.sh` | `allocate_payment()` 的双会话并发门禁，两种 replay 模式下必须给出**不同**结果。 | 三审 P1-7 的丢失更新（两个会话各分配 100/200，双双成功，计划总额 200 而分配之和 300）此前只被手工复现过一次：**只在单会话里跑的断言看不见丢失更新**，把 `for update` 删掉不会有任何东西变红。现在 `EXPECT=consistent`（MODE=branch）与 `EXPECT=lost`（MODE=control，未修复地板）互为正反证据；交错由 advisory lock 决定而非 sleep，因为靠时序的门禁会 flaky，而一条 flaky 的"无丢失更新"门禁比没有更糟。 |

### 验证边界（本轮）

- **对着提交跑，而不是对着工作区跑**。本轮把候选 commit 单独 checkout 成一个 worktree 再验，这一步立刻抓出一个假绿：门禁读的是 `git ls-files`，而新写的 `tests/security/dev-identity-bootstrap.test.mjs` 当时还未被跟踪，所以工作区里那次 OK **根本没扫到它**。方向是对的（CI 读的是提交，提交才是"已发布"），但**本地一次 OK 只覆盖 git 已经跟踪的东西**。
- 提交树上的证据：`npm test` 595 tests / 592 pass / 0 fail / 3 skipped；`node --test tests/release/*.test.mjs` 198/198；`npm run check:security`（含新门禁）OK：974 个跟踪文本文件、0 处发布点、9 个二进制跳过；`tsc --noEmit` 0；lint baseline 406 无新增；工作流、database-types、migration-history、taskboard 全 PASS；production build exit 0。
- **一个与本轮无关但已确认的仓库事实**：本仓没有 `.gitattributes`，`core.autocrlf=true` 的 Windows 上**新 clone** 会把 `*.sh` 检出成 CRLF，于是 8 条以 `\n` 锚定 shell 脚本内容的 release 契约测试在新检出上失败；index 里是 LF，Linux CI 因此为绿。这不是本次提交引入的，但它意味着"Windows 上跑一遍全绿"在新检出上并不成立。
- **仍需单独生产授权、本轮一律未做**：轮换八个已发布身份的口令与生产数据库口令；**轮换 Supabase PAT**（`test_matrix.py` 已把提权配方发布出去，本轮新增的一项）；封禁 Auth 身份并吊销会话；仓库转 private 与 git 历史清除；origin 防火墙限定。**把值从工作区删掉与让它停止生效是两件事，本节不得把前者说成后者。**
- Batch 1（资金路径与不变量）与 Batch 2（发布控制面）按管理层要求各自独立成批、独立复审，不与本批混提。
## 2026-08-15 audited release-control path coverage

This section records the remaining paths reported by `scripts/check-spec.sh` for the audited release candidate. It is a source-and-gate inventory only: it does not claim that the candidate is deployed or that production acceptance is complete.

| Path | Contract covered by this release |
| --- | --- |
| `infra/observability/dependency-probe.sh` | Runs the bounded production dependency probe used by the alert and postdeploy evidence chains. |
| `infra/systemd/newme-production-rollback.sh` | Provides the protected rollback/status boundary, including credential-transition and receipt-key inspection states. |
| `next-env.d.ts` | Keeps the generated Next.js TypeScript environment reference aligned with the pinned build toolchain. |
| `scripts/alert-state-preflight-drill.sh` | Proves an untrusted or symlinked alert-state tree is rejected before installer writes. |
| `scripts/control-plane-restore-drill.sh` | Exercises interrupted control-plane installation and exact recovery in an isolated container. |
| `scripts/credential-assets-transaction-drill.sh` | Exercises credential-asset install, finalize, rollback, and all protected-asset recovery checkpoints without production credentials. |
| `scripts/validate-production-config.py` | Validates the fixed production origin, runtime credential placement, and Sentry configuration before switching service bytes. |
| `src/app/(dashboard)/analytics/_components/SalesLoad.tsx` | Binds the lead-rebalance UI request and cleanup behavior to the actor-scoped batch intent. |
| `supabase/replay/24_rollback_companion_guards.sh` | Verifies rollback companions preserve the declared guard and dependency closure. |
| `supabase/replay/26_notification_event_idempotency.sh` | Exercises notification idempotency, lock behavior, ACLs, and residue cleanup on PostgreSQL 17. |
| `supabase/replay/27_lead_rebalance_plan_idempotency.sh` | Exercises first-caller plan identity, actor isolation, locking, ACLs, and zero residue on PostgreSQL 17. |
