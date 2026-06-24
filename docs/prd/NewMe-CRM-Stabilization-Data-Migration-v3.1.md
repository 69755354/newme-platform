# NewMe CRM Stabilization + Data Migration v3.1

**Status:** Phase 0 — Scope Lock (not yet in development)
**Date:** 2026-06-24
**Based on:** Tanya raw feedback + Book2.xlsx + Fact Pack + Dual Audit (Codex + CC/GLM 5.2)

---

## Core Principle

连续 7 天业务可用 > 架构漂亮 > 新功能 > Analytics

Tanya 能正常创建 lead、导入旧 lead、跟进客户、查看记录、管理销售，才算成功。

---

## Phase 0 — Scope Lock (CURRENT)

→ `tasks/v3.1/phase-0-scope-lock.md`

## Phase 1 — Minimum Business Viability

→ `tasks/v3.1/phase-1-minimum-viability.md`

## Phase 2 — Completion

→ `tasks/v3.1/phase-2-completion.md`

## Phase 3 — Stabilization

→ `tasks/v3.1/phase-3-stabilization.md`

---

## Explicitly NOT in Scope

- New Analytics components (LeadSources, TeamPerformance)
- Dashboard beautification
- Command Center enhancement
- Notification enhancement
- Proxy modification
- Auth trigger modification
- RLS modification
- UI redesign
- New architecture
- New workflow engine
- P2/P7 items
- Any unapproved scope creep

---

## Data Sources

- Book2.xlsx (COS: 副本Book2.xlsx, KNX Clinent sheet, 60 rows, 50 phones)
- Production DB: vfopmpxlhwzpxqegayew.supabase.co
- Working tree: 28 files changed, +347/-220, NOT deployed
- Dual audit: Codex NO-GO + CC/GLM 5.2 NO-GO

## Key Facts from Excel

| Metric | Value |
|---|---|
| Total rows | 60 |
| With phone | 50 |
| Duplicate phones | 0 |
| Date range | 2025-11-08 ~ 2026-06-23 |
| Source: instgram | 24 |
| Source: empty | 36 |
| Status: empty | 21 |
| Status: poor Leads | 17 |
| Status: Under discussion | 7 |
| Status: Under design | 7 |
| Client Quality: empty | 35 |

---

## Execution Rules

1. Before any coding: read this PRD, DEV_PLAN, and current task card
2. Output PRD_READ_CONFIRMATION including exact scope, non-scope items, acceptance checklist
3. Do NOT redesign, rename stages, add stages, change UX, modify unrelated modules, invent requirements
4. Do NOT skip data migration validation
5. Do NOT report completion without typecheck/build/smoke checks
6. Product interpretation and scope decisions are NOT delegated to LLM

---

## LLM Division

| Role | Model | Allowed | Forbidden |
|---|---|---|---|
| Controller | DS v4-pro | Scope guard, Go/No-Go, risk assessment, Flight Recorder | Bulk code changes, DB writes, account changes, taking over failed workers |
| Executor | CC → GLM 5.2 | Scanning, small batch code (3-5 files), tsc/build, SQL validation, Excel parsing | Expanding scope, touching auth/users/password |
| Auditor | Codex CLI | Audit, security check, scope creep check, migration check | Writing code, deleting migrations, modifying proxy/auth, refactoring |
