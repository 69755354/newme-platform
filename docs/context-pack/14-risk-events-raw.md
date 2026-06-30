# 14 — Risk Events (Raw)

## Event 1: Employee Password Mass Reset
- Time: 2026-06-24 ~05:00 WIB
- What: 5 employee passwords reset to unified test password via Auth Admin API
- Impact: All 5 employees lost access to original passwords (irrecoverable — only hash stored)
- Fixed: Passwords manually restored
- Evidence: Session 20260624_070438, Auth Admin API logs

## Event 2: auth_login Trigger Crash
- Time: 2026-06-24 ~14:30 (migration timestamp)
- What: on_auth_login trigger referenced nonexistent profiles.tenant_id → all logins failed with "Database error granting user"
- Impact: All users unable to log in
- Fixed: Migration 20260624143000 removed tenant_id reference
- Evidence: Migration file, user reports

## Event 3: approval_status Column Missing
- Time: 2026-06-24
- What: Code referencing contracts.approval_status before column existed
- Impact: Contract approval flow broken
- Fixed: Migration 20260624000004 added column
- Evidence: Migration file

## Event 4: Browser Session Killed
- Time: 2026-06-24 ~08:20
- What: Previous Hermes session permanently killed, all tool calls returned "Session already killed"
- Impact: Lost context, had to restart CRM A/B verification
- Fixed: New session started
- Evidence: Session start message

## Event 5: v4-flash Used as Default Model
- Time: 2026-06-15
- What: 1301/1729 requests (75%) used v4-flash instead of v4-pro because config.yaml model field was empty
- Impact: Lower quality responses for 2+ weeks
- Fixed: config.yaml model set to deepseek-v4-pro
- Evidence: llm-cost-ledger.jsonl audit

## Event 6: Codex Deleted Migration Files
- Time: 2026-06-24
- What: Codex Batch 2 deleted 2 production migration files (new_tables.sql, rls_policies.sql)
- Impact: Migration history compromised; files restored via git checkout
- Fixed: Files restored
- Evidence: git reflog

## Event 7: Codex Modified proxy.ts with Dead Code
- Time: 2026-06-24
- What: Codex added PUBLIC_API_PATHS whitelist referencing local variables in module scope (never executed)
- Impact: Dead code in proxy.ts, misleading comment added
- Fixed: Removed, replaced with comment
- Evidence: Working tree diff

## Event 8: Analytics React #310
- Time: 2026-06-23+
- What: ResponsiveContainer throws #310 error on analytics pages
- Impact: Charts fail to render in some viewport sizes
- Fixed: Working tree adds minWidth/minHeight (not deployed)
- Evidence: Browser console logs
