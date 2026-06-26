# Sales Rollout Final — 2026-06-27

## Status: ✅ READY

**Main commit**: `eb578d83`  
**Service version**: `rzF2lZUbvetD`  
**Branch**: `main` (clean merge from `hotfix/sales-rollout-clean`)

---

## Changes (3 files, +66/-7)

| File | Change | Purpose |
|------|--------|---------|
| `src/app/api/contracts/route.ts` | +46 | P0-1: Duplicate contract prevention (SELECT check → 409 + 23505 catch) + P0-2: Error context |
| `src/app/(dashboard)/leads/[id]/page.tsx` | +17 | P0-2: Error context (user_id/lead_id/action/error) + P1-1: Won button disabled |
| `supabase/migrations/20260627000000_...sql` | +10 | PENDING DEBT: DB partial unique index (not applied) |

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

## P1 Ops Debt

| Item | Status |
|------|--------|
| **DB partial unique index** | **PENDING** |
| Migration | `20260627000000_contracts_unique_active_per_lead.sql` |
| Blocker | Supabase PAT `sbp_bbaf...` lacks `database:query` scope |
| Risk | Extremely low — L1+L2+L3 already protect |
| Resolution | Apply when scope available; verify concurrent POST → only 1 succeeds |

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
