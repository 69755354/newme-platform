# TASKBOARD.md — Machine-Verifiable Task Tracking
# Last updated: 2026-07-01
# Owner: MoA Tier 1 Technical Debt

## ⚠️ RULE
- Every audit/plan that produces action items MUST be converted into this file.
- Items NOT in this file = do not exist.
- Before every deploy: run `scripts/check-taskboard.sh`. Any ❌ = abort deploy.
- Every session start: Hermes reads this file and reports status to user.

---

## MoA Tier 1 — Technical Debt (Source: COS v3.1 P1P1计划0629.txt, lines 4189-4208)

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| 1 | src/lib/supabaseQuery.ts | CREATE | file exists + contains AbortController + contains withTimeout | ❌ | |
| 2 | src/components/DashboardErrorBoundary.tsx | CREATE | file exists + contains errorId | ❌ | |
| 3 | src/app/(dashboard)/layout.tsx | MODIFY | contains ErrorBoundary wrapping children | ✅ | 2026-06-30 |
| 4 | src/shared/hooks/usePipelineDragDrop.ts | CREATE | file exists + contains dragDrop | ❌ | |
| 5 | src/app/(dashboard)/leads/page.tsx | MODIFY | contains usePipelineDragDrop import | ❌ | |
| 6 | src/app/(dashboard)/pipeline/page.tsx | MODIFY | contains usePipelineDragDrop import | ❌ | |
| 7 | src/app/(dashboard)/leads/[id]/page.tsx | MODIFY | maybeSingle count >= 3 | ⚠️ (1/3) | |
| 8 | src/app/globals.css | MODIFY | contains error-boundary-fallback | ❌ | |

**Progress: 2/8 (25%)**

### Deploy Gate (6 steps from MoA)

| Step | Requirement | Status |
|------|------------|--------|
| 1 | useSupabaseQuery unit test (8s timeout + 2 retries + AbortController) | ❌ |
| 2 | layout.tsx ErrorBoundary → throw doesn't white-screen | ✅ |
| 3 | leads/[id] foreign key degradation → invalid ID doesn't crash | ⚠️ |
| 4 | Extract pipeline drag-drop as shared hook → pipeline regression | ❌ |
| 5 | leads integrates drag-drop → E2E + stage guard | ❌ |
| 6 | build + restart + full verification | ❌ |

---

## Phase 1 — Business Features (25/25 ✅ Complete)

All 25 items from Phase 1 business delivery are DONE. No action needed.

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
(empty)
