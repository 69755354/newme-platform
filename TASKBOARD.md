# TASKBOARD.md — Machine-Verifiable Task Tracking (本地工具脚本真相源)
# Last updated: 2026-07-05
# Format: Frozen v2 (MoA签发版) — 4状态模型

## ⚠️ STATE MACHINE (唯一状态流)
```
TODO → IN_PROGRESS → REVIEW → DONE
                         ↓
                      BLOCKED
```

## ⚠️ RULE
- 每次状态变化 → 在【活动任务】区追加一行
- Items NOT in this file = do not exist
- Before every deploy: `scripts/check-taskboard.sh`. Any ❌ = abort
- Every session start: Hermes reads this file first

---

## 活动任务

| TASK_ID | STATUS | OWNER | UPDATED_AT |
|---------|--------|-------|------------|
|| task_P1-C | DONE | Hermes | 2026-07-04 |
|| task_P1-D | DONE | Codex→Hermes | 2026-07-04 |
|| task_P1-E | DONE | Codex→Hermes | 2026-07-04 |
|| task_P1-F | DONE | Codex→Hermes | 2026-07-04 |
|| task_P1-G | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_reads_all | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_mutations_low | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_mutations_core | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_mutations_settings | DONE | Codex→Hermes | 2026-07-04 |
| task_true_codex_reaudit | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_true_codex_fail_fix | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_true_codex_reaudit_delta | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_true_codex_deploy | DONE | Hermes | 2026-07-05 |
| task_P3_0_spec_sync | DONE | Hermes | 2026-07-05 |
| task_INFRA_codex_sandbox_diagnosis | TODO | — | 2026-07-05 |
| task_P3_1_won_at | DONE | Codex (GPT-5.5) via codex exec → Hermes apply | 2026-07-05 |
| task_P3_1b_alertpanel | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_2_first_contact_trigger | DONE | Codex (GPT-5.5) via codex exec → Hermes apply | 2026-07-05 |
| task_P3_3_quality_api | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_4_deprecate_redirect | TODO | — | 2026-07-05 |
| task_P3_5_dashboard_summary_api | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_6_dashboard_month_filter | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_7_leads_contact_quality_ui | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_8_weekly_review | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_4_deprecate_redirect | DONE | Hermes (manual) | 2026-07-05 |
| task_P3_9_smoke_acceptance | DONE | Hermes (manual safe subset) | 2026-07-05 |

---

## MoA Tier 1 — Technical Debt (IMMEDIATE, 1-2 weeks)
Source: MoA 4-round audit, 3-model unanimous sign-off, lines 478-500 + 559-600 + 643-675

### 1A. New Files (infrastructure)

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| T1-1 | src/lib/supabaseQuery.ts | CREATE | file exists + contains `useSupabaseQuery` + `AbortController` + retry logic (>=2 retries) + timeout (8s default) | ✅ | 2026-06-30 |
| T1-2 | src/components/DashboardErrorBoundary.tsx | CREATE | file exists + contains `errorId` + `Sentry` (or `sentry`) + fallback UI | ✅ | 2026-06-30 |
| T1-3 | src/shared/hooks/usePipelineDragDrop.ts | CREATE | file exists + contains `onDragStart` + `onDrop` + `draggingLeadId` | ✅ | 2026-06-30 |
| T1-4 | src/shared/hooks/useStageGuard.ts | CREATE | file exists + contains `stageGuard` or `validTransition` + STAGES definition | ✅ | 2026-06-30 |

### 1B. Modified Files (integration)

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| T1-5 | src/app/(dashboard)/layout.tsx | MODIFY | contains `ErrorBoundary` wrapping children | ✅ | 2026-06-30 |
| T1-6 | src/app/(dashboard)/leads/page.tsx | MODIFY | contains `usePipelineDragDrop` + `useStageGuard` + `useSupabaseQuery` + empty stages visible by default | ✅ | 2026-07-01 |
| T1-7 | src/app/(dashboard)/pipeline/page.tsx | MODIFY | contains `usePipelineDragDrop` (replaces inline drag) + `useSupabaseQuery` (replaces direct supabase calls) + `useStageGuard` | ✅ | 2026-07-01 |
| T1-8 | src/app/(dashboard)/leads/[id]/page.tsx | MODIFY | `maybeSingle` count >= 3 + contains `skeleton` or `Skeleton` or `loading` fallback + `useSupabaseQuery` | ✅ | 2026-07-01 |
| T1-9 | src/app/(dashboard)/products/page.tsx | MODIFY | uses `fetch('/api/products')` via API route (replaced client-side `useSupabaseQuery` + `createClient`, see P1-B Supabase removal) | ✅ | 2026-07-04 |
| T1-10 | src/app/globals.css | MODIFY | contains `error-boundary-fallback` class | ✅ | 2026-07-01 |

### 1C. Sentry Integration

| # | Requirement | Verification | Status | Done Date |
|---|-------------|-------------|--------|-----------|
| T1-11 | Sentry captureException in ErrorBoundary | DashboardErrorBoundary.tsx contains `Sentry.captureException` or `captureException` | ✅ | 2026-07-01 |
| T1-12 | Sentry error events actually received | Manual: trigger error → Sentry dashboard shows event | ✅ | 2026-07-01 |

**Tier 1 Progress: 12/12 (100%) ✅**

---

## P0 紧急性能修复（2026-07-01 立）

| # | Problem | Requirement | Verification | Status | Done Date |
|---|---------|-------------|-------------|--------|-----------|
| P0-1 | leads/[id] 加载 2.1 分钟 / 431 请求 | fetchData 的 8 个串行查询改并行 + 关键路径用 PostgREST JOIN | 详情页加载 < 5s，请求数 < 50 | ✅ | 2026-07-01 (编码 + migration + 161ms 验证) |

---

### MoA Tier 2 — UI Consistency (SHORT-TERM, 2-4 weeks)
Blocked by Tier 1 completion. Do NOT start until all Tier 1 = ✅.

|| # | Problem | Requirement | Verification | Status | Done Date |
||---|---------|-------------|-------------|--------|-----------|
|| T2-1 | P-2: Scroll behavior inconsistency | Unified scroll strategy across all dashboard pages | All pages use consistent overflow/scroll container | ✅ | 2026-07-01 |
|| T2-2 | P-3: Kanban stats scattered | Merge progress bar + numbers + percentage into single visual unit | Single stats component, not 3 separate elements | ✅ | 2026-07-01 |
|| T2-3 | P-5: Empty stage visibility | Default show empty stages + collapse toggle button | `showEmptyStages` default = true, toggle button exists | ✅ | 2026-07-01 |
|| T2-4 | 锚定功能卡片 (sticky headers/filter/action bar) — 2026-07-01 新立 | 长页面滚动时 filter/标题/搜索/操作栏跟随屏幕 | leads/page.tsx (DashboardScrollContainer 内 3 件套) + leads/[id] + payments + quotations + tasks (4 页 viewport 滚动模式) 全部锚定 | ✅ | 2026-07-01 (commits 1ac84ca + a606d9b + 0fe9543 + aa54565 + 7c7d74c) |

**Tier 2 Progress: 4/4 (100%) ✅**

---

### MoA Tier 3 — Architecture (LONG-TERM, 1-2 months)
Tier 2 unlocked (T2-1/2/3 ✅ 2026-07-01).

| # | Problem | Requirement | Verification | Status | Done Date |
|---|---------|-------------|-------------|--------|-----------|
| T3-1 | DashboardLayout unification | Full DashboardLayout refactor (方案A) | Single layout component, all pages conform | ✅ 2026-07-03 (24/24 pages) | |
| T3-2 | Performance monitoring + alerts | Lighthouse/Web Vitals baseline + alerting | Baseline recorded, alerts configured | ✅ | 2026-07-03 (web-vitals.ts + WebVitalsReporter.tsx + lighthouse-baseline.md) |
| T3-3 | Code debt elimination | Refactor large files (leads 1108行, leads/[id] 946行, pipeline 566→146行) | No single file > 500 lines, shared components extracted | ✅ | 2026-07-03 (pipeline: 5afce2f + ea791b1; leads: 15/15 steps done, page.tsx 351行) |
| T3-4 | Docs drift: coding_standards §4 contracts/payments stale | Refresh table schema section to match actual DB (contract_amount / sales_id / confirmed) | coding_standards.md §4 列与 DB service_role 查询结果一致 | ✅ | 2026-07-01 |

**Tier 3 Progress: 4/4 (100%) ✅**

---

### Pending Tasks (未启动)

| # | Task | Requirement | Verification | Status |
|---|------|-------------|-------------|--------|
| kanban-unify | 统一 kanban stage 定义 + fmtAED 到 shared/ | pipeline/leads 共享 KanbanShell + 共享 stage 常量 | shared/kanban/types.ts 存在 + leads/pipeline import from shared | ❌ |
| perf-1 | 全站性能优化 | 108 请求 → <50, 3.3MB → <1.5MB, 33.73s → <5s | Lighthouse + bundle analyzer report | 🔒 第一批完成，剩余冻结（见 SPEC.md §十一） |\n|  | ├─ xlsx lazy-load | `/leads` 首屏 -234KB | `import("xlsx")` 动态加载 | ✅ `c54d83b` |\n|  | ├─ Meta Pixel 条件加载 | 15 后台路径不加载 fbevents.js | 路由匹配验证 | ✅ `6dca992` `e7363fa` |\n|  | ├─ Bundle Analyzer 基线 | 全站客户端 JS map | ANALYZE=true 报告 | ✅ `e50a9c4` |\n|  | ├─ deploy.sh v4.0 隔离构建 | 生产 .next 零触碰 | swap 停机 <5s | ✅ `77563c8` 等 6 commits |\n|  | ├─ P0 防复发 guard | 阻止直接 build 覆盖生产 | guard-prod-build.sh | ✅ `d25faf3` |\n|  | └─ PostHog/Recharts/base-ui | 下一轮优化（解冻后） | — | 🔒 冻结 |
| hermes-ci | Hermes CI webhook 订阅 crm-ci | CI pipeline 跑通 + webhook 触发 | CI job log + webhook delivery 200 | ❌ (需决定 CI 提供商) |
| moa-tier2-detail | MoA Tier 2 决策点 3+4 方案细化 | 10-12 人天方案文档 | 文档 review + sign-off | ❌ (需确认方向) |

---

### MoA Tier 4 — Process Governance (新建 2026-07-01)
Tier 3 + P0 完成度不是前提——运维治理独立于产品进度。事由：2026-07-01 Sentry 131348591 流程违规补审。

| # | Problem | Requirement | Verification | Status | Done Date |
|---|---------|-------------|-------------|--------|-----------|
| T4-1 | hermes-rules.md §十 缺运维操作边界 | 立 §十 运维操作三档分级（🟢/🟡/🔴）+ OEEC 紧急例外 + 速查表 10 类 | 章节落地、3 档表完整、OEEC 条款存在、速查表覆盖 Sentry/服务/数据库/Secrets | ✅ | 2026-07-01 |
| T4-2 | Sentry issue 131348591 archived_forever 后未登记 ops-log + ChunkLoadError 紧急重建 | 在 HANDOFF-20260701.md 加 ## Ops Log 条目 + commit 留痕 | HANDOFF 含完整 6 字段（时间/命令/操作者/资源ID/缘由/审计报告路径） | ✅ | 2026-07-01 |
| T4-3 | deploy.sh Step 3 build guard 与服务启停冲突 | 重构 deploy.sh 让 build 步骤先自动停服务再 build 再起，或分离 build/deploy 步骤 | deploy.sh 完整跑通（5/5 步），build 不再被 guard 拦 | ✅ | 2026-07-01 (commit 5d7b60b, deploy.sh + package.json, nginx CSP 也改) |
| T4-4 | PostHog `eu-assets.i.posthog.com` 域名未白名单 CSP | CSP script-src/connect-src 加 eu-assets.i.posthog.com | 浏览器 console 不再报 CSP violation | ✅ | 2026-07-01 (nginx 改完 + reload, 生产 200 + CSP 头返回) |

**Tier 4 Progress: 4/4 (100%) ✅**

---

## Phase 1 — Business Features (25/25 ✅ COMPLETE)

All 25 items from Phase 1 business delivery are DONE. No action needed.
Includes: P0-1~P0-7, Sentry fix, RLS matrix (35 tables, 250 policies, 0 FOR ALL),
log_activity prefix, AI gateway v2.0-2.1, profiles.email migration, 3.3-3.7 dev,
integration tests, Codex review fixes, decision points 3-4, public→authenticated RLS fix.

---

## Freeze Rules (from MoA sign-off)

1. **禁止** 在任何页面直接调用 `supabase.from().select()` — 必须通过 `useSupabaseQuery`
2. **禁止** 在 leads/pipeline 实现新拖拽逻辑 — 必须复用 `usePipelineDragDrop`
3. **禁止** 移除或绕过全局 ErrorBoundary
4. **禁止** 在 Tier 1 完成前启动 Tier 2/Tier 3 工作
5. **禁止** 在 leads 详情页假设外键数据必然存在
6. **禁止** 引用未经 `supabase.from("table").select().limit(1)` 验证过的数据库列名。CC 子代理生成的任何 supabase 查询，必须在 commit 前用 service_role key 验证实际表结构

---

## How to Add New Tasks

1. Run an audit / plan
2. Add each file/action as a row in the table above
3. Define the **verification condition** (grep pattern, file existence, test pass)
4. Status: ❌ pending → ⚠️ partial → ✅ done
5. Fill in Done Date when ✅

## How to Remove Completed Tasks

After deployment + production verification, move completed rows to archive section below.

---

## Archive

### P1-B: Client Supabase Removal (analytics/ads/products) — 2026-07-04
| # | File | Change | Result |
|---|------|--------|--------|
| P1-B | src/app/(dashboard)/analytics, /ads, /products | 移除 client Supabase → server actions + API routes | analytics 995→771KB (-224KB), ads 961→738KB (-223KB), products 1066→842KB (-224KB) |

### P1-C: Dashboard Summary API Aggregation — 2026-07-04
| # | File | Change | Result |
|---|------|--------|--------|
| P1-C | src/app/api/dashboard/summary/route.ts | NEW — 聚合 14 条 server Supabase 查询，30s cache | dashboard 18 client Supabase REST calls → 1 fetch (573ms) |
| P1-C | src/app/(dashboard)/dashboard/page.tsx | −355 lines client Supabase reads, +30 lines fetch | 0 Supabase REST data calls on /dashboard Network panel |

验收: `/api/dashboard/summary` 573ms。Network 面板 0 `supabase.co/rest/v1/` 调用（仅 1 auth token）。BUILD_ID `arpeAWPUml4dotHYJ10KK`。

### P1-D: Leads List API Aggregation — 2026-07-04
|| # | File | Change | Result |
||---|------|--------|--------|
|| P1-D | src/app/api/leads/list/route.ts | NEW — 聚合 auth+profile+leads+salesUsers 4 queries | leads 4 client Supabase reads → 1 fetch |
|| P1-D | src/app/(dashboard)/leads/_hooks/useLeadsData.ts | Supabase reads → fetch('/api/leads/list') | 0 Supabase REST data calls on /leads Network panel |
|| P1-D | src/app/(dashboard)/leads/page.tsx | −createClient import, −supabase const | bulkTransfer → useLeadMutations integration |

验收: BUILD_ID `34myA0cSpjO3BQHGA3DTc`。smoke 14/14。

### P1-E: Analytics Summary API Aggregation — 2026-07-04
|| # | File | Change | Result |
||---|------|--------|--------|
|| P1-E | src/app/api/analytics/summary/route.ts | NEW — 聚合 7 条 server Supabase 查询，Promise.all 并行，30s cache | analytics 6 条分散 fetch → 1 条 /api/analytics/summary |
|| P1-E | src/app/(dashboard)/analytics/page.tsx | +AnalyticsContext, 单次 fetch 替代 6 条分散请求 | 0 client Supabase reads，AnalyticsContext 可供子组件未来迁移 |

验收: BUILD_ID `SKwOrxKMZl2AoWmEzyXS0`。smoke 14/14。5/5 页面 client Supabase reads 清零。

### P1-F: Workbench Query Parallelization — 2026-07-04
|| # | File | Change | Result |
||---|------|--------|--------|
|| P1-F | src/app/api/workbench/route.ts | 9 次串行 Supabase → 4 步（auth→profile→6并行→leadNames）+ 30s cache | -5 round-trips，缓存命中=0查询 |
|| P1-F | scripts/deploy.sh | GATE_RESULT_DIR /var/lib→~/.hermes | ubuntu 可写，不再 Permission denied |

验收: BUILD_ID `w_RxXx-k8y8aJ2dcuze9`。smoke PASS。Sentry ChunkLoadError 告警已上线(#696330)。

### 下一步摘要
- P2 reads all: ✅ 已上线 (6 页 reads → BFF API routes)
- P2 mutations low: ✅ 已上线 (team/payments/tasks server actions)
- P2 mutations core: ✅ 已上线 (pipeline/contracts server actions)
- P2 mutations settings: ✅ 已上线 (settings lead-assignment server actions)
- Post-audit patch: ✅ 已上线 (de3b52f: tasks + pipeline ownership + useSalesKpiData BFF)
- TRUE_CODEX_REAUDIT 全链: ✅ 已上线 (49cd03f: 一审→修复→二审→部署, BUILD_ID o1toe2b6XmKR_8Jdfx8oP)
- P2.5 Infra Hardening: ✅ 已上线 (11e3805 + 583ba89: 4 audit scripts + 2 release docs)
- P1/P2 Archive: FULL PASS 恢复 ✅

---

## 🔴 Open — User-Reported Bugs (Lead Detail Page, 2026-07-05 19:15 CST)

| ID | Symptom | Location | Severity | Status |
|---|---|---|---|---|
| BUG-LD-1 | 修改区域 · 酋长国 (emirate) 字段不保存 | `src/app/(dashboard)/leads/[id]/page.tsx` edit section | medium | 🔴 open |
| BUG-LD-2 | 点击区域 · 左侧内容被遮盖 (overlay 覆盖主内容) | `src/app/(dashboard)/leads/[id]/page.tsx` 布局 / z-index | medium | 🔴 open |
| BUG-LD-3 | 点击区域进入输入状态，再次点击空白处不还原 | `src/app/(dashboard)/leads/[id]/page.tsx` click-to-edit | medium | 🔴 open |
| BUG-LD-4 | admin 视角 · 转移销售下拉框被遮盖 | `src/app/(dashboard)/leads/[id]/page.tsx` reassign dropdown | medium | 🔴 open |

Note: All four are independent of P3 PRD G1/G2/G3 (quality API, weekly-review, workbench). Batch into one fix after P3 PRD ships.

## 🔴 Open — Production (2026-07-05 23:55 CST)

| ID | Symptom | Root Cause | Fix | Status |
|---|---|---|---|---|
| ROOT_WHITEPAGE_FIX | `https://app.newme.ae/` 打开后白屏 1-3s 后跳转 | Next.js 16 App Router `page.tsx` 的 `redirect()` 被编译为 client-side navigation，触发 `BAILOUT_TO_CLIENT_SIDE_RENDERING`，body 内只有空模板 | 在 `src/proxy.ts` 顶部加 `if (pathname === "/") return NextResponse.redirect(/dashboard, 307)`，edge 层强制 HTTP 307，无需客户端 JS | ⚠️ fixed in code, deploy pending |
