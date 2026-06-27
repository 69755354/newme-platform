# 13 — Recent Changes (48h)

Source: git log --since="2026-06-22"

## Commits
1. 1b1e054 — [GLM-CP] fix: Phase A P0 security (auth guards, mandatory secrets, service_role cleanup)
2. 50fe114 — [GLM-CP] fix: Codex review findings P0+P1
3. 3a6762c — [GLM-CP] fix: auto-refresh expired access token in createServerSupabase
4. 673309a — docs: sync CRM v3 design docs from COS to repo
5. 4b5a2e2 — [GLM-CP] Epic 7 partial: Create Contract button + WhatsApp chat bubbles (via CC)
6. 3b296b3 — [GLM-CP] fix: phone dial using customer_name instead of phone
7. 7f626eb — [GLM-CP] Epic 6: bottom folding panel + blue-gray brand color system (via CC)
8. c16aa73 — [GLM-CP] Phase B: Health Score badge + 7 extension fields UI (via CC)
9. ce12574 — [GLM-CP] Phase B: Command Center page + health-score + nav + i18n
10. 85c3e51 — [GLM-CP] fix: hook symlink resolution
11. 20aff89 — [GLM-CP] fix: pre-push zero-check graceful fallback
12. 3bddf74 — [GLM-CP] infra: 3-mechanism error prevention chain (git hooks)
13. b5a7538 — hide: workbench + games nav items (not ready for production)
14. de5e83f — fix: add missing mgmtWorkbench/salesWorkbench i18n keys
15. e23ae2e — Phase B: leads extension fields migration + health-score.ts
16. 7aecabc — fix: daily-funnel-snapshot grouped default + deployment log
17. ea6a2ec — migration: stage->milestone backfill mapping (prod 2026-06-23 verified)
18. 4f56f86 — docs: add rule_011 architecture source control + audit finalization
19. dacf97d — docs: architecture baseline audit
20. faf7ac8 — chore: add rollback.sql + seed.sql
21. c8a7bf8 — feat: CRM v3 Phase A — all 5 epics code + prod migration

## Working Tree (unstaged, NOT deployed)
28 files, +347/−220 lines

### Changed Files
- pipeline/page.tsx, dashboard/page.tsx, leads/[id]/page.tsx, leads/page.tsx
- leads/new/page.tsx, contracts/new/page.tsx, ads/page.tsx, command-center/page.tsx
- quotes/quotes-client.tsx, settings/ads/page.tsx, settings/page.tsx
- SalesLoad.tsx, WeeklyTrends.tsx, QuickCreateLeadDialog.tsx
- proxy.ts, milestones.ts
- All dashboard API routes (ads-roi, lead-health, pipeline-funnel, sales-load, weekly-trends)
- check-alerts/route.ts, check-overdue-followups/route.ts
- milestones/route.ts ([id]/milestone), follow-up-overdue/route.ts
- meta-capi/route.ts, quotations convert/route.ts, workbench/route.ts

### New (Untracked) Files
- LeadSources.tsx, TeamPerformance.tsx (analytics components — SCOPE CREEP)
- /api/dashboard/lead-sources/, /api/dashboard/team-performance/ (SCOPE CREEP)
- Multiple migration files (20260623* and 20260624*)
