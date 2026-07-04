# SPEC — NewMe CRM

> ⚠️ **COMPACT 后:用户最后 3 条消息 > 本文件 > handoff 摘要**
> (本文件是参考手册,不是圣经。compaction 时用户的尾消息是唯一权威。)

## 项目一句话
NewMe CRM 自托管 (systemd + Next.js 15 + Supabase + Sentry/PostHog) on `app.newme.ae`。

## 当前状态（写时 commit `49cd03f`）
- **Build**: P2 全完成 + Post-Audit Patches + P2.5 Infra Hardening — 6 BFF API routes + 7 server action files + 4 审计脚本。
- **TASKBOARD**: 18 PASS / 0 FAIL / 0 WARN
- **本文件**: 唯一本地真相源（架构 + 待办 + 设计决策）
- **上次更新**: 2026-07-05（TRUE_CODEX_FAIL_FIX + P2.5 infra hardening）
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
|| `src/app/actions/tasks.ts` | Tasks server actions (updateTask, updateTaskStatus) | — | 🟢 P2 mutations low |
|| `src/app/actions/settings.ts` | Settings server actions (assignLead, bulkAssignLeads, bulkUnassignLeads, transferAllLeads) | 115 | 🟢 P2 mutations settings |
|| `src/app/api/pipeline/list/route.ts` | Pipeline BFF API (leads + role + salesUsers) | — | 🟢 P2 reads |
|| `src/app/api/contracts/list/route.ts` | Contracts BFF API (contracts + joins + pagination) | — | 🟢 P2 reads |
|| `src/app/api/settings/data/route.ts` | Settings BFF API (leads + profiles + kpiTargets) | — | 🟢 P2 reads |
|| `src/app/api/tasks/list/route.ts` | Tasks BFF API (tasks + filters + pagination) | — | 🟢 P2 reads |
|| `src/app/api/tasks/[id]/route.ts` | Task Detail BFF API | — | 🟢 P2 reads |
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
- kanban-unify ❌ 待做：统一 stage 定义 + fmtAED 到 shared/
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
