# Deployment Log

## 2026-06-23: CRM v3 Phase A — Backfill + Build + Deploy

- **Commit**: ea6a2ec (feat/crm-v3)
- **Build ID**: Ck2LqwPhoP6CeP2sTmPkh
- **Service**: newme-platform.service ✅ active

### Files changed
- `supabase/migrations/20260623030000_crm_v3_stage_to_milestone_mapping.sql` (new)
- `src/app/api/cron/daily-funnel-snapshot/route.ts` (fix: total_value default in grouped)

### Prod migration executed
- `20260623030000` — stage→milestone backfill: 149 milestones inserted, 70 leads updated, 7 lost marked

### Dev Supabase
- Project: zwvkhiezxggkutiksnju (Singapore, free tier)
- All 6 new tables ✅, RLS ✅, functions ✅

### Verification
- Build: ✅ Compile + Sentry upload passed
- Health: ✅ HTTP 307
- Stage→milestone mapping: ✅ 0 missing, all verified

### Next
- Tanya UAT: 12 acceptance criteria
- Day 1-2: Tanya v3_workbench feature flag
