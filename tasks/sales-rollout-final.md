# Sales Rollout Final — 2026-06-27

## Status: ✅ READY

**Main commit**: `d493aaa` (hotfix `eb578d8` + migration applied)  
**Service version**: `rzF2lZUbvetD`  
**Branch**: `main`

---

## Changes (3 files, +66/-7)

| File | Change | Purpose |
|------|--------|---------|
| `src/app/api/contracts/route.ts` | +46 | P0-1: Duplicate contract prevention (SELECT check → 409 + 23505 catch) + P0-2: Error context |
| `src/app/(dashboard)/leads/[id]/page.tsx` | +17 | P0-2: Error context (user_id/lead_id/action/error) + P1-1: Won button disabled |
| `supabase/migrations/20260627000000_...sql` | +10 | **APPLIED**: DB partial unique index (`idx_contracts_one_active_per_lead`) |

---

## Verification

| Gate | Result |
|------|:--:|
| Build | ✅ PASS |
| /api/health | ✅ healthy, db=UP |
| Contract duplicate → 409 | ✅ |
| Journald error context | ✅ user_id/lead_id/action/error |
| Won button disabled | ✅ |
| CC review | ✅ Accepted |
| Codex clean review | ✅ 0 P0, 0 P1 |
| Fire Drill A-F | ✅ 6/6 |
| Browser-smoke (daily) | ✅ cron active (4AM UTC) |
| Ops Health (5min) | ✅ cron active |
| Error Monitor (10min) | ✅ cron active |

---

## Ops L2 Infrastructure

| Component | Interval | Target |
|-----------|----------|--------|
| error-monitor.py | 10min | Sentry + journalctl → TG CRM PROJECT |
| ops-health-check.py | 5min | /api/health + service + disk → TG on fail |
| browser-smoke-daily.sh | daily 8AM Dubai | 14 routes Playwright → TG on fail |
| Dedup | 1h window | Same fingerprint no re-alert |
| Release fingerprint | auto | commit/env/time in all alerts |

---

## P1 Ops Debt — CLOSED ✅

| Item | Status |
|------|--------|
| **DB partial unique index** | **APPLIED** |
| Index name | `idx_contracts_one_active_per_lead` |
| Condition | `WHERE status NOT IN ('archived', 'cancelled', 'terminated')` |
| Verified | PostgREST direct insert → 23505 blocked |
| Date applied | 2026-06-27 02:05 UTC |
| Full chain | L1 disabled + L2 SELECT 409 + L3 23505 catch + L4 DB index ✅ |

### Protection layers (all active)

| Layer | Type | Mechanism |
|-------|------|-----------|
| L1 | Frontend | `disabled={saving/updating}` on submit buttons |
| L2 | API SELECT | Pre-INSERT check → 409 "Contract already exists" |
| L3 | API 23505 | Postgres unique_violation → 409 (race condition catch) |
| L4 | DB Index | Partial unique index → blocks duplicate at storage level |

---

## Rollout Message

CRM v3.1 已上线。今天开始大家直接用 Workbench 和 Leads 跟进客户。  
遇到任何问题直接截图发 CRM PROJECT 群，不需要自己判断原因。  
页面打不开、保存失败、数据不对会优先处理。  
今天我们会盯系统运行，有问题快速修。

---

## Day-1 Checklist

| Time (Dubai) | Check |
|-------------|-------|
| 09:00 | TG alerts zero, Sentry clean |
| 10:00 | Page 500s, active users |
| 12:00 | Save failures, follow-up writes |
| 16:00 | Leads/notes delta, duplicates |
| 18:00 | Full day summary, Sentry review |
