# Cross-Module Business Coupling Audit: newme-platform

**Audit Date:** 2026-06-05
**Project Root:** `/home/ubuntu/newme-platform/src/`
**Files Analyzed:** 20 module files across leads/, quotes/, contracts/, payments/, pipeline/, plus API routes and shared components.

---

## 1. Module Data Dependency Matrix

### Tables Accessed Per Module

| Module | Tables Read | Tables Written | DB Views |
|--------|------------|---------------|----------|
| **Leads** | `leads`, `profiles`, `chat_messages`, `lead_workflow_stages` | `leads`, `activities`, `business_events`, `transfer_history` | `v_lead_trace` |
| **Quotes** | `quotations`, `leads` | `quotations` | — |
| **Contracts** | `contracts`, `leads`, `profiles`, `installment_plans` | `contracts`, `installment_plans` | — |
| **Payments** | `installment_plans`, `contracts`, `profiles` | `installment_plans`, `payments` | — |
| **Pipeline** | `leads`, `profiles` | `leads`, `activities`, `business_events` | — |

### API Routes (Server-Side Cross-Module Actions)

| Route | Tables Read | Tables Written |
|-------|-------------|----------------|
| `POST /api/quotations/generate` | `leads` | `quotations`, `activities`, `business_events`, `leads.stage` |
| `POST /api/hermes/generate-quote` | `leads` | `quotations` (or fallback `quotes`), `activities`, `business_events`, `leads.stage` |
| `POST/PUT /api/workflow` | `lead_workflow_stages` | `lead_workflow_stages` |

---

## 2. Audit Findings: Five Specific Checks

### ✅ Check 4: Orphan Records — Low Risk

- **Quotes (`quotations.lead_id`)**: The UI always requires a `lead_id` to create a quote (every creation flow selects a lead first). The schema allows NULL but no UI code produces NULL lead_ids. **Low risk.**
- **Contracts (`contracts.lead_id`)**: The `/contracts/new` page forces lead selection from a filtered list. **Low risk.**
- **Installment plans (`installment_plans.contract_id`)**: Always created atomically with the contract. **No orphans.**
- **Payments (`payments.installment_id`, `payments.contract_id`)**: Always set via the recording dialog. **No orphans.**
- **⚠️ Minor**: `/api/hermes/generate-quote` has a fallback that writes to a legacy `quotes` table — records there are never displayed in any current UI. This is a **display orphan** if the fallback is ever triggered.

---

### ❌ Check 1: Lead Stage Change — NO cascade to quotes/contracts

When `lead.stage` changes (via `changeStage()` in `leads/page.tsx` line 252 or `updateStage()` in `leads/[id]/page.tsx` line 246), the code only:

1. Updates `leads.stage` + `leads.updated_at`
2. Inserts into `activities` (type: stage_change)
3. Inserts into `business_events` (type: stage_changed)

**No related quotes or contracts are updated.** If a lead moves to "lost", existing draft quotes remain in "draft" status indefinitely. If a lead is reactivated, there's no status cascade.

---

### ❌ Check 2: Quote Accepted — NO lead stage auto-advance

When a quote status changes to "accepted" (via `handleStatusChange()` in `quotes-client.tsx` line 256, or via the detail dialog), the code only:

1. Updates `quotations.status`

**The lead stage is never updated.** A lead whose quote is accepted stays at whatever stage it was (e.g., `quotation_submitted`) and never auto-advances to `negotiation`, `pending_decision`, or `won`.

The API routes (`/api/quotations/generate` and `/api/hermes/generate-quote`) DO update `leads.stage` — but they set it to `"quoted"` which is **not a valid stage key** in the 9-stage pipeline. The actual pipeline uses `"quotation_submitted"`. This is a **stage value mismatch bug**.

---

### ❌ Check 3: Contract Signed — NO payment schedule auto-generation on status change

**Current behavior:**
- When a contract is *created* via `/contracts/new`, installment plans are created *simultaneously* (line 139 in `contracts/new/page.tsx`).
- **There is NO automation when contract.status changes to "signed"** — installment plans would need to already exist.

**Misleading UI bug (CRITICAL):**
In `leads/[id]/page.tsx` lines 392-397, the "Won" button displays this toast:
```
toast.success("合同和分期计划已自动生成")
```
Translation: *"Contract and installment plans have been auto-generated"*

**BUT this is FALSE.** The actual handler only calls `updateStage("won")` which merely updates `leads.stage`. No contract or installment plan is created anywhere in that code path. This is a **broken coupling** — the toast promises automation that doesn't exist.

---

## 3. Missing Couplings — Complete List

| # | Missing Coupling | Severity | Impact |
|---|-----------------|----------|--------|
| 1 | `quotations.status → accepted` should advance `leads.stage` | HIGH | Leads stagnate after quote acceptance; sales team must manually update stage |
| 2 | `leads.stage → won` should auto-create contract + installments | HIGH | The toast literally says it does this, but it doesn't — data integrity issue |
| 3 | `leads.stage` change should cascade to quotes (e.g., "lost" → auto-reject draft quotes) | MEDIUM | Draft quotes on lost leads remain active |
| 4 | `contracts.status → signed` should trigger installment schedule | MEDIUM | No post-signing payment schedule automation |
| 5 | API-generated quotes use wrong stage value `"quoted"` instead of `"quotation_submitted"` | MEDIUM | Stage drift between API and UI |
| 6 | No cross-module foreign-key validation in UI (a contract can be created without a quote) | LOW | Possible but unlikely via UI flow |
| 7 | `v_lead_trace` view depends on DB-level SQL but has no corresponding DB triggers | LOW | The view exists for read-only trace but no triggers keep it consistent |

---

## 4. Architecture Diagram

An Excalidraw diagram has been saved at:
- `/home/ubuntu/newme-platform/cross-module-coupling-audit.excalidraw`
- `/home/ubuntu/newme-platform/cross-module-coupling-audit.svg`

---

## 5. Recommendations

### Must Fix (Data Integrity)
1. **Remove or fix the misleading toast** in `leads/[id]/page.tsx` line 395 — the "Won" button should not claim auto-creation that doesn't happen.
2. **Add a DB trigger or application handler**: When `quotations.status` changes to "accepted", auto-update `leads.stage` to the appropriate next stage (e.g., "pending_decision" or "negotiation").

### Should Fix (Business Logic)
3. **Auto-create contract on lead Won**: Either via DB trigger on `leads.stage` or in the `updateStage("won")` handler — insert a default contract + default 50/30/20 installment plan.
4. **Fix API stage value**: Change `"quoted"` to `"quotation_submitted"` in both `/api/quotations/generate` (line 159) and `/api/hermes/generate-quote` (lines 263, 309).

### Nice to Have
5. **Stage change cascade**: When lead moves to "lost", auto-reject all draft quotes.
6. **Post-signing installment generation**: When `contracts.status` changes to "signed", generate remaining installment plans if not already present.
7. **Remove legacy fallback**: The `quotes` table fallback in `/api/hermes/generate-quote` should be removed to prevent display orphans.
