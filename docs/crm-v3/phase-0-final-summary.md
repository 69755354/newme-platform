# Phase 0 Final Summary

**Status:** ✅ COMPLETE — 等待森哥 GO 进 Phase 1
**Date:** 2026-06-25
**Cleaned:** 7 files reverted

---

## 清理结果

已回退 7 个文件到 production HEAD：

| 文件 | 原因 |
|------|------|
| `analytics/_components/SalesLoad.tsx` | REMOVE — chart 美化，不在 scope |
| `analytics/_components/WeeklyTrends.tsx` | REMOVE — chart 美化，不在 scope |
| `command-center/page.tsx` | REMOVE — 错误处理，不在 scope |
| `api/cron/check-alerts/route.ts` | REMOVE — dedup 改动，不在 scope |
| `proxy.ts` | 禁止区 — auth + audit + 401 guard |
| `lib/supabase-middleware.ts` | 禁止区 — autoRefreshToken |
| `api/users/route.ts` | 默认回退 — auth 区，不进 v3.1 |

## 剩余 Modified 文件（23 个，全部 KEEP）

### final_status 迁移消费者（15 个）

| 文件 | PRD 项 |
|------|--------|
| `(dashboard)/ads/page.tsx` | Data-model adaptation |
| `(dashboard)/contracts/new/page.tsx` | Phase 1 manage sales |
| `(dashboard)/dashboard/page.tsx` | Phase 1 core view |
| `(dashboard)/leads/[id]/page.tsx` | Phase 1 view + follow-up |
| `(dashboard)/leads/page.tsx` | Phase 1 manage sales |
| `(dashboard)/pipeline/page.tsx` | Phase 1 manage sales |
| `(dashboard)/settings/ads/page.tsx` | Data-model adaptation |
| `(dashboard)/settings/page.tsx` | Data-model adaptation |
| `api/dashboard/ads-roi/route.ts` | ⚠️ 需修 source `meta` → `meta_ads` |
| `api/dashboard/lead-health/route.ts` | Data-model adaptation |
| `api/dashboard/pipeline-funnel/route.ts` | DevPlan milestone table |
| `api/dashboard/sales-load/route.ts` | Data-model adaptation |
| `api/dashboard/weekly-trends/route.ts` | Data-model adaptation |
| `api/leads/follow-up-overdue/route.ts` | Phase 1 follow-up |
| `api/quotations/[id]/convert/route.ts` | Phase 1 manage sales |

### tasks 迁移消费者（2 个）

| 文件 | PRD 项 |
|------|--------|
| `api/cron/check-overdue-followups/route.ts` | DevPlan tasks — Phase 1 minimum |
| `api/workbench/route.ts` | Phase 1 workbench |

### milestone 架构（3 个）

| 文件 | PRD 项 |
|------|--------|
| `lib/milestones.ts` | DevPlan milestone 独立表 |
| `api/leads/[id]/milestone/route.ts` | DevPlan milestone 独立表 |
| `(dashboard)/quotes/quotes-client.tsx` | DevPlan milestone 独立表 |

### stage:"new" 移除（2 个）

| 文件 | PRD 项 |
|------|--------|
| `(dashboard)/leads/new/page.tsx` | Phase 1 create lead |
| `components/QuickCreateLeadDialog.tsx` | Phase 1 create lead |

### source 修正保留（1 个）

| 文件 | PRD 项 | 备注 |
|------|--------|------|
| `api/leads/meta-capi/route.ts` | KEEP meta_ads | ⚠️ ads-roi consumer 需同步修 |

---

## Phase 1 最小文件清单

基于 23 个 modified + Phase 1 7 个 P0/P1 任务：

| P 项 | 涉及文件 |
|------|---------|
| P0-1 Notes/Timeline | `leads/[id]/page.tsx` (timeline 显示 import_note) |
| P0-2 Create Lead 稳定性 | `leads/new/page.tsx`, `QuickCreateLeadDialog.tsx`, `api/users/route.ts` (需重新应用 fix) |
| P0-3 Excel Import | 新建 import 路由 + `leads/page.tsx` |
| P0-4 Mohamed 归档 | 新建归档逻辑 |
| P0-5 Dashboard Ownership | `dashboard/page.tsx` |
| P1-6 Project Info Save | `leads/[id]/page.tsx` |
| P0-7 Tasks Safety Patch | `leads/new/page.tsx`, `QuickCreateLeadDialog.tsx`, `leads/[id]/page.tsx`, `api/workbench/route.ts` |

---

## 风险评估

| 维度 | 状态 |
|------|------|
| 涉及 migration | ✅ YES — final_status/current_milestone/tasks/lead_milestones 需要对应 migration 已应用 |
| 涉及 proxy | ❌ NO — proxy.ts 已回退 |
| 涉及 auth | ⚠️ users/route.ts 默认回退，但修复需在 Phase 1 重新应用（一行改回 authError.message） |
| 涉及 RLS | ❌ NO — 不在 23 个文件内 |
| 涉及 account | ❌ NO |
| 需要 森哥 GO | ✅ YES — Phase 1 开始前必须 |

---

## Excel 数据（Phase 0 产出）

| 指标 | 值 |
|------|-----|
| 总行 | 61 |
| 有效行 | 52（9 仅 ID → skipped） |
| 电话 | 50，0 重复 |
| Status 空 | 21 → default new/pending |
| Source | instgram 24 / 空 37 |
| Notes 非空 | 40 → 必须进 timeline |

---

## 下一步

Phase 0 完成。等森哥 GO 进 Phase 1。
