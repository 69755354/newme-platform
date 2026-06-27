# 12 — Known Bugs (Raw)

## Bug 1: Quick Create Lead Failed
- Symptom: Creating lead via QuickCreateLeadDialog fails silently
- Time: 2026-06-23/24
- Root: Writes leads.next_followup_date but doesn't create tasks row. Dashboard reads tasks → lead has no followup.

## Bug 2: Analytics React #310
- Symptom: ResponsiveContainer width/height error in recharts
- Source: Browser console on /analytics page
- Time: 2026-06-23+
- Affected: SalesLoad.tsx, WeeklyTrends.tsx
- Working tree: minWidth/minHeight fix applied (not deployed)

## Bug 3: Leads Counter Shows 0
- Symptom: Dashboard shows active leads=0 briefly
- Source: Race condition in useEffect
- Time: Intermittent

## Bug 4: req_confirmed Returns 400
- Symptom: API returns 400 "不能跳级" for requirement_confirmed milestone
- Source: canCompleteMilestone in milestones.ts
- Root: application layer (COMPLETABLE_MILESTONES) vs DB trigger layer (last_key IS NULL) disagree on new lead's first step

## Bug 5: Dashboard Sales Leaderboard Missing Tanya
- Symptom: Tanya doesn't appear in sales leaderboard
- Root: Leaderboard filters role=sales, Tanya is boss
- Time: Ongoing (by design, not bug)

## Bug 6: Project Info Save Not Confirmed
- Symptom: Pressing save on project info doesn't give clear feedback
- Source: User report
- Time: 2026-06-22

## Bug 7: Password Reset Incident (2026-06-24)
- Symptom: 5 employee passwords reset to unified test password via Auth Admin API
- Source: Employee Readiness Test session
- Root: PUT /auth/v1/admin/users/{uid} directly, no SMTP configured for recovery
- Status: Recovered (passwords restored, SMTP fix pending)

## Bug 8: v4-flash Used as Default (2026-06-15)
- Symptom: 1301/1729 requests used v4-flash instead of v4-pro
- Root: config.yaml model field empty, system auto-downgraded
- Status: Fixed (model set to deepseek-v4-pro)

## Bug 9: Codex Deleted Migration Files
- Symptom: Codex Batch 2 deleted 20260623020000_crm_v3_new_tables.sql and rls_policies.sql
- Source: git log
- Status: Restored via git checkout

## Bug 10: Codex Modified proxy.ts
- Symptom: Added PUBLIC_API_PATHS whitelist that referenced local variables (dead code)
- Status: Removed (working tree has -12 lines, comment only)

## Bug 11: meta/meta_ads Source Regression
- Symptom: meta-capi/route.ts changed source='meta'→'meta_ads' but ads-roi still filters source='meta'
- Effect: New Meta leads disappear from ads-roi analytics
- Source: Working tree diff, line meta-capi/route.ts:1228

## Bug 12: auth_login Trigger Crashed All Logins
- Symptom: "Database error granting user" for all users
- Root: trigger referenced nonexistent profiles.tenant_id column
- Time: 2026-06-24, fixed by migration 20260624143000
- Status: Fixed
