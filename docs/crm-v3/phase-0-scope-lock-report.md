# NewMe CRM v3.1 — Phase 0 Scope Lock Audit Report

**Auditor:** CC / GLM 5.2 (Executor role, read-only audit pass)
**Date:** 2026-06-25
**Inputs:** PRD `docs/prd/NewMe-CRM-Stabilization-Data-Migration-v3.1.md`, DevPlan `docs/devplan/v3.1-dev-plan.md`, `git diff HEAD`
**Scope:** classify every modified file as **KEEP / REMOVE / REVIEW**

---

## TL;DR

The 28→35 modified files are dominated by **one coherent, half-finished architectural migration** —
splitting terminal outcomes (`won`/`lost`) out of the `stage` enum into a `final_status` column, plus a
`current_milestone` / `lead_milestones` model and a new `tasks` table replacing `leads.next_followup_date`.
These are exactly the **Architecture Decisions** listed in the DevPlan (milestone 独立表, follow_up_logs+tasks),
so their *consumers* are legitimately Phase-1 KEEP.

**But** the working tree also drags in four explicitly-forbidden or out-of-scope changes:
**proxy.ts** (auth + audit-table + middleware 401-guard removal), **supabase-middleware.ts**
(`autoRefreshToken:false`), **api/users/route.ts** (auth/user-creation path), and Notification/Analytics/Command-Center
touches. These need a human (森哥) decision before Phase 1 starts.

> **Counts (current working tree):** 35 `M` files = **30 source** + **5 non-source artifacts**.
> PRD line 56 records "28 files" — the tree has grown since that snapshot. Non-source artifacts
> (`logs/pm2-*.log`, `supabase/.temp/*-version`, `tsconfig.tsbuildinfo`) are not audited as scope; they
> should be **gitignored / stripped from any commit**, not `git checkout`'d as code.

---

## Classification Summary

| Class | Count (source files) | Meaning |
|---|---|---|
| **KEEP** | 22 | Adapts consumers to the v3.1 `final_status` / `milestone` / `tasks` data model — required for the migrated app to run. Depends on the untracked v3.1 migrations being applied. |
| **REVIEW** | 4 | Forbidden-zone (proxy/auth/users) or carries a real bug / risk. **Needs 森哥 decision.** |
| **REMOVE** | 4 | Out-of-scope modules (Analytics / Command Center / Notification). Trivially safe to `git checkout`. |

---

## KEEP — v3.1 data-model adaptation (22 files)

All KEEP files are mechanically aligned to the DevPlan architecture decisions. They are necessary, not
optional: if the v3.1 migrations (`final_status`, `current_milestone`, `tasks`, `lead_milestones`) are applied,
these consumers *must* read the new columns or the app silently mis-buckets every lead.

> ⚠️ **KEEP is conditional.** Keeping the code means the team has committed to the
> `final_status`/`milestone`/`tasks` architecture as v3.1 scope. If 森哥 instead reverts the architecture,
> *all 22 KEEP files + their migrations must be reverted together* — they cannot be cherry-picked.

### A. `final_status` migration consumers (won/lost out of `stage`)

| File | PRD / DevPlan anchor | Reason |
|---|---|---|
| `src/app/(dashboard)/ads/page.tsx` | Data-model adaptation | `stage==="won"` → `final_status==="won"` |
| `src/app/(dashboard)/contracts/new/page.tsx` | Phase-1 manage sales | `.in("stage",…won)` → `or(final_status.eq.won, current_milestone.in.…) ` |
| `src/app/(dashboard)/dashboard/page.tsx` | Phase-1 core view | stage→final_status throughout funnel/source/signing |
| `src/app/(dashboard)/leads/[id]/page.tsx` | Phase-1 view + follow-up | final_status + next `tasks` row for follow-up edit |
| `src/app/(dashboard)/leads/page.tsx` | Phase-1 manage sales | drag-to-stage writes `final_status` for won/lost; filter/columns |
| `src/app/(dashboard)/pipeline/page.tsx` | Phase-1 manage sales | kanban terminal guard + optimistic update on final_status |
| `src/app/(dashboard)/settings/ads/page.tsx` | Data-model adaptation | select `final_status`, won detection |
| `src/app/(dashboard)/settings/page.tsx` | Data-model adaptation | lead table reads `final_status` |
| `src/app/api/dashboard/ads-roi/route.ts` | Data-model adaptation | won filter → final_status |
| `src/app/api/dashboard/lead-health/route.ts` | Data-model adaptation | dormant query `final_status.is.null` |
| `src/app/api/dashboard/pipeline-funnel/route.ts` | DevPlan milestone table | funnel reads `current_milestone` + `final_status` |
| `src/app/api/dashboard/sales-load/route.ts` | Data-model adaptation | won/overdue → final_status |
| `src/app/api/dashboard/weekly-trends/route.ts` | Data-model adaptation | won → final_status |
| `src/app/api/leads/follow-up-overdue/route.ts` | Phase-1 follow-up | `not stage in (won,lost)` → `final_status.is.null` |
| `src/app/api/quotations/[id]/convert/route.ts` | Phase-1 manage sales | `stage:"contract_won"` → `final_status:"won"` |

### B. `tasks` table migration consumers (follow-ups off `leads.next_followup_date`)

| File | PRD / DevPlan anchor | Reason |
|---|---|---|
| `src/app/api/cron/check-overdue-followups/route.ts` | DevPlan `tasks` (未来) | overdue source = `tasks` table (⚠️ also adds 7d dedup — see Notes) |
| `src/app/api/workbench/route.ts` | Phase-1 workbench | inbox follows open `tasks`; response flattened to match existing frontend `ProgressGroup[]` |

### C. Milestone architecture

| File | PRD / DevPlan anchor | Reason |
|---|---|---|
| `src/lib/milestones.ts` | DevPlan milestone 独立表 | `COMPLETABLE_MILESTONES` refines ordering rule |
| `src/app/api/leads/[id]/milestone/route.ts` | DevPlan milestone 独立表 | rule_007 broadened; won/lost syncs `final_status` |
| `src/app/(dashboard)/quotes/quotes-client.tsx` | DevPlan milestone 独立表 | quote-accepted → `lead_milestones` insert (was: stage bump) |

### D. Drop `stage:"new"` default (aligns with new model)

| File | PRD / DevPlan anchor | Reason |
|---|---|---|
| `src/app/(dashboard)/leads/new/page.tsx` | Phase-1 create lead | removes hardcoded `stage:"new"` (⚠️ needs DB default/nullable — see Notes) |
| `src/components/QuickCreateLeadDialog.tsx` | Phase-1 create lead | same |

---

## REVIEW — forbidden zone / risk / bug (4 files) — **needs 森哥 GO**

### 🔴 `src/proxy.ts`
- **Why flagged:** DevPlan forbids **"不碰 proxy 认证逻辑"**; PRD lists **"Proxy modification"** as NOT in scope.
  This file does three things at once:
  1. Wraps `supabase.auth.getUser()` in try/catch (expired token → treated as unauthenticated). **Auth behavior change.**
  2. Renames audit insert `audit_log` → `audit_logs`, columns `user_id`→`actor_id`, `event_type`→`action`, `metadata`→`details`. **Needs the audit_logs migration + confirms `audit_log` (old) is retired.**
  3. **Removes the middleware-level API 401 guard** (`PUBLIC_API_PATHS` + `if(!user) return 401`), deferring auth to route level.
- **Decision needed:** Is this an approved P0 security refactor (commit `1b1e054` "Phase A P0 security") or unauthorized proxy creep? Removing the middleware 401 guard is a **security-relevant** change — must be confirmed by Codex/Auditor before KEEP.
- **Cannot blindly strip:** `git checkout` reverts auth + audit in one shot, but if `audit_logs` migration is applied elsewhere, the old `audit_log` insert returns and breaks. Coupled.

### 🔴 `src/lib/supabase-middleware.ts`
- **Why flagged:** Adds `auth: { autoRefreshToken: false }` to the **middleware** Supabase client.
  This is auth/session behavior on every SSR request — adjacent to the forbidden proxy/middleware-auth zone.
  Related commit `3a6762c` ("auto-refresh expired access token in createServerSupabase") suggests an active
  token-refresh refactor.
- **Decision needed:** Was disabling middleware refresh intentional (leave refresh to client) and verified end-to-end?
  If wrong, users get bounced on token expiry. **Verify with a login smoke test before KEEP.**

### 🟡 `src/app/api/users/route.ts`
- **Why flagged:** Touches the **user-creation / auth** path, which the Executor role is explicitly **FORBIDDEN**
  ("touching auth/users/password"). The actual change is minor — adds `console.error` + returns `authError.message`.
- **Decision needed:** The change itself is harmless and improves debuggability, but it sits in the forbidden
  zone. Confirm 森哥 accepts this as a P0 error-message fix (commit `7e9b64a` "create user real error message").

### 🟡 `src/app/api/leads/meta-capi/route.ts`
- **Why flagged:** Two concerns.
  1. **Bug:** writes `source = "meta_ads"`, but `api/dashboard/ads-roi/route.ts:53` filters `.eq("source","meta")`.
     New Meta/CAPI leads will **drop out of the Ads-ROI dashboard.** Source rename is inconsistent.
  2. Removes the `meta_creative_id` write (potential data-loss if the column still exists).
  - The `stage:"new"` removal here is fine (aligns with new model).
- **Decision needed:** Should source stay `"meta"` (fix the mismatch) or should ads-roi be updated to `"meta_ads"`?
  Either way this file is currently **internally inconsistent** and must not ship as-is.

---

## REMOVE — out-of-scope modules (4 files) — safe to `git checkout`

| File | NOT-in-scope category | Safe to strip? | Reason |
|---|---|---|---|
| `src/app/(dashboard)/analytics/_components/SalesLoad.tsx` | Analytics / Dashboard beautification | ✅ Yes — purely adds `minWidth={0} minHeight={0}` to a recharts `ResponsiveContainer`; no logic, no other consumer. | Console-warning chart fix; Analytics is out of scope. |
| `src/app/(dashboard)/analytics/_components/WeeklyTrends.tsx` | Analytics / Dashboard beautification | ✅ Yes — identical one-prop chart fix. | Same as above. |
| `src/app/(dashboard)/command-center/page.tsx` | Command Center enhancement | ✅ Yes — isolated fetch `.then` error-handling; no cross-file dependency. | Command Center is out of scope. |
| `src/app/api/cron/check-alerts/route.ts` | Notification enhancement | ✅ Yes — standalone dedup window `24h → 7d`; no other consumer. | Notification is out of scope. (Note: `check-overdue-followups` carries the *same* 7d dedup but is KEEP because its main change is the `tasks` migration — the dedup there is coupled and must stay or be reverted with it.) |

> These four are harmless bug-fixes, not feature work. They are classified REMOVE only because they live in
> explicitly out-of-scope modules and a clean Phase-0 scope lock should not carry Analytics/Command-Center/Notification
> churn. If 森哥 prefers, they can be downgraded to KEEP as trivial stability fixes — zero downstream impact either way.

---

## Notes / Risks worth surfacing

1. **KEEP set is all-or-nothing with its migrations.** The 22 KEEP files assume `final_status`,
   `current_milestone`, `tasks`, `lead_milestones` exist. The matching untracked migrations
   (`20260623020001_crm_v3_new_tables.sql`, `…_fix_won_lost_migration.sql`, `…_fix_trg_lead_won.sql`,
   `…_fix_milestone_order.sql`, `…_next_quote_no_rpc.sql`, etc.) must be reviewed/applied as one unit.
   Do **not** apply the code without the migrations, nor the migrations without the code.

2. **`stage:"new"` removal (Group D) depends on schema.** `leads/new/page.tsx` and `QuickCreateLeadDialog.tsx`
   no longer set `stage`. Confirm `leads.stage` has a DB default or is nullable, else lead creation inserts fail.
   (Migration `…_add_default_next_action.sql` and the new-tables migration are the likely source of the default.)

3. **`final_status || stage` fallbacks are transitional.** Several files bucket by `l.final_status || l.stage`.
   This dual-read is intentional during the won/lost migration window (DevPlan W7-W9) but means the data must be
   fully migrated to `final_status` before this fallback can be removed — track as Phase-2 cleanup.

4. **`workbench` response shape change is frontend-matched.** `api/workbench/route.ts` flattens
   `panels.{inbox,tasks,…}` → top-level `{inbox,tasks,overdue,progress}`, and `workbench/page.tsx` already
   declares `progress: ProgressGroup[]`. KEEP is consistent — but verify no *other* consumer reads the old
   `panels` shape before shipping.

5. **Non-source artifacts in the diff** (`logs/pm2-error.log` +17k, `logs/pm2-out.log` +6.8k,
   `supabase/.temp/gotrue-version`, `supabase/.temp/storage-version`, `tsconfig.tsbuildinfo`) must **not** be
   committed. Add to `.gitignore` / unstage. They are noise, not scope.

---

## Final Roll-up

- **KEEP:** 22
- **REMOVE:** 4
- **REVIEW:** 4
- **Phase 1 涉及文件 (KEEP set):** the 22 files in sections A–D above (create/import/follow-up/view/manage-sales
  paths + their data-model adaptation).
- **涉及 migration?** **YES** — `final_status`, `current_milestone`, `tasks`, `lead_milestones`, `audit_logs`
  rename. Backed by untracked migrations under `supabase/migrations/` (not in the 28, but coupled — must be
  reviewed alongside the KEEP code).
- **涉及 auth?** **YES** — `proxy.ts` (`getUser` try/catch), `supabase-middleware.ts` (`autoRefreshToken:false`),
  `users/route.ts` (user-creation error path). All in the forbidden zone.
- **涉及 proxy?** **YES** — `src/proxy.ts` directly (auth + audit table + 401-guard removal).
- **涉及 RLS?** **Not in the 28 modified files.** ⚠️ But an untracked migration `20260623020002_crm_v3_rls_policies.sql`
  exists — RLS changes are NOT in scope; flag it for the migration audit, separately from this file audit.
- **涉及 account?** **YES** — `api/users/route.ts` touches the create-user/auth path.
- **是否需要森哥 GO?** **YES — 必须.** Three blockers require a human decision before Phase 1:
  1. **Commit-or-revert the `final_status`/`milestone`/`tasks` architecture** (determines KEEP vs mass-revert of 22 files + migrations).
  2. **proxy.ts + supabase-middleware.ts + users/route.ts** sit in the explicitly-forbidden proxy/auth/users zone and must be approved as P0 security work (or reverted).
  3. **meta-capi source mismatch** (`meta_ads` vs `meta`) ships a live Ads-ROI bug — must be resolved either way.
