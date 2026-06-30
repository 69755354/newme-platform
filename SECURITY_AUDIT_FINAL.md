# NewMe CRM — Security Audit Report
**Date:** 2026-06-12 | **Branch:** feat/crm-v2 | **Auditor:** Hermes Agent
**Method:** Source code analysis + Live DB verification + JWT Claims simulation

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Tables scanned | 24 |
| Tables with RLS | 21 (87.5%) |
| Tables **WITHOUT** RLS | 3 🔴 |
| RLS policies deployed | 61 |
| Dashboard pages audited | 12 |
| Pages with hard route guard | 3 |
| Pages bypassable by URL | 9 🔴 |
| **P0 Critical findings** | **4** |
| **P1 High findings** | **5** |
| **P2 Medium findings** | **3** |

---

## P0 — Critical (Must fix before any user goes live)

### P0-1: 3 Tables have NO RLS — full data exposure

Any authenticated user (or `public` role) can read/write ALL rows.

| Table | Risk | Data exposure |
|-------|------|---------------|
| `contract_approvals` | Any user can approve/reject contracts | Financial fraud |
| `payment_allocations` | Any user can allocate payments | Financial manipulation |
| `marketing_campaigns` | Any user can modify campaigns | Data integrity |

**Verification:** `pg_tables.rowsecurity = false` confirmed on Live DB.

**Fix:**
```sql
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;
-- Add policies matching existing patterns (admin_all, sales_select)
```

### P0-2: `notifications_service_insert` has `WITH_CHECK = true`

Anyone (including anonymous) can INSERT notifications to ANY user's inbox.

**Live DB confirmed:** `notifications_service_insert | INSERT | roles={public} | WITH_CHECK: true`

**Fix:**
```sql
DROP POLICY notifications_service_insert ON notifications;
CREATE POLICY notifications_service_insert ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (true);  -- at minimum restrict to authenticated users
-- Better: use a service_role call from backend only
```

### P0-3: 9 of 12 dashboard pages lack route guards

Middleware only protects 3 routes. The following pages can be accessed by direct URL:

| Bypassable page | Expected role | Actual |
|----------------|---------------|--------|
| `/dashboard/leads` | admin/boss/sales | Any logged-in user |
| `/dashboard/leads/[id]` | owner/admin | Any logged-in user |
| `/dashboard/contracts` | admin/boss | Any logged-in user |
| `/dashboard/contracts/[id]` | admin/boss | Any logged-in user |
| `/dashboard/analytics` | admin/boss | Any logged-in user |
| `/dashboard/team` | admin/boss | Any logged-in user |
| `/dashboard/quotations` | admin/sales | Any logged-in user |
| `/dashboard/quotations/[id]` | admin/sales | Any logged-in user |
| `/dashboard/projects` | admin/sales | Any logged-in user |

**Fix:** Add role checks to `middleware.ts` for ALL dashboard routes, or implement server-side role validation in each page component.

### P0-4: `profiles` SELECT allows self-lookup only, but `profiles_admin_all` uses `public` role

`profile_self | SELECT | roles={public}` — technically any anonymous request can attempt to query profiles. The USING clause (`id = auth.uid()`) protects against bulk reads, but combined with the admin policy on `public`, this needs tightening.

**Current:** Works because `auth.uid()` returns NULL for anonymous. But defense-in-depth says restrict to `authenticated`.

---

## P1 — High (Fix within sprint)

### P1-1: Sales user data isolation untested

**Status:** Cannot verify without production sales user passwords.

**RLS policy analysis says:**
- `leads`: `leads_sales_select` (SELECT on public) — using clause restricts to `assigned_to = auth.uid()` ✅
- `contracts`: `contracts_sales_select` (SELECT on public) — using clause restricts to `sales_id = auth.uid()` ✅
- `quotations`: `quotations_sales_select` (SELECT on public) — using clause restricts via lead ownership ✅
- `activity_logs`: `sales_see_own_activity` (SELECT on public) — restricts to own user ✅

**Recommendation:** Create a test sales account or get Mohamed/Faheem credentials to run full isolation test.

### P1-2: Multiple policies use `roles={public}` instead of `roles={authenticated}`

Tables affected: `activity_logs`, `business_events`, `chat_messages`, `contracts`, `installment_plans`, `kpi_targets`, `lead_workflow_stages`, `leads`, `notifications`, `payments`, `profiles`, `projects`, `quotations`, `quotes`, `transfer_history`, `user_session_daily`

**Risk:** These policies rely solely on USING clause logic, not on authentication status. If a USING clause has a logic error, anonymous users could access data.

### P1-3: `business_events` allows `be_admin_all` on `public` role

`be_admin_all | ALL | roles={public}` — anyone can attempt admin operations. USING clause checks `get_my_role()` which returns NULL for anonymous, but should be `authenticated`.

### P1-4: No audit trail for role elevation

`profiles_update_self` allows role change if user is admin/boss. But no trigger logs role changes. A compromised admin session could silently promote other accounts.

### P1-5: `get_my_role()` is SECURITY DEFINER

This function runs as the table owner. If the function logic has any injection point, it bypasses RLS. Verified function exists and works, but should be reviewed for edge cases.

---

## P2 — Medium (Backlog)

### P2-1: `kpi_targets_modify` policy unclear purpose

`kpi_targets_modify | UPDATE | roles={authenticated}` — separate from `kpi_admin_all`. May allow unintended updates.

### P2-2: No rate limiting on auth endpoints

No evidence of rate limiting on Supabase Auth endpoints visible from application code.

### P2-3: JWT tokens lack `app_role` claim

Both admin and boss JWTs show `role=authenticated`. Role differentiation relies entirely on `get_my_role()` querying the profiles table on every request. Consider adding `app_role` to JWT custom claims for performance.

---

## Role × Page Matrix

| Page | Admin | Boss | Sales | Operator | Guard? |
|------|-------|------|-------|----------|--------|
| `/dashboard` | ✅ Full | ✅ Full | ✅ Own | ✅ Limited | middleware ✅ |
| `/dashboard/leads` | ✅ All | ✅ All | 🔶 Own | ✅ All | ❌ None |
| `/dashboard/leads/[id]` | ✅ All | ✅ All | 🔶 Own | ✅ All | ❌ None |
| `/dashboard/contracts` | ✅ All | ✅ All | ❌ None* | ❌ None | ❌ None |
| `/dashboard/contracts/[id]` | ✅ All | ✅ All | ❌ None* | ❌ None | ❌ None |
| `/dashboard/analytics` | ✅ All | ✅ All | ❌ No | ❌ No | ❌ None |
| `/dashboard/team` | ✅ All | ✅ All | ❌ No | ❌ No | ❌ None |
| `/dashboard/quotations` | ✅ All | ✅ All | 🔶 Own | ❌ No | ❌ None |
| `/dashboard/quotations/[id]` | ✅ All | ✅ All | 🔶 Own | ❌ No | ❌ None |
| `/dashboard/projects` | ✅ All | ✅ All | 🔶 Own | ✅ Own | ❌ None |
| `/dashboard/notifications` | ✅ All | ✅ All | ✅ Own | ✅ Own | middleware ✅ |
| `/dashboard/settings` | ✅ All | ✅ All | ❌ No | ❌ No | middleware ✅ |

> *Contracts has RLS `contracts_sales_select` but the page component may not render for sales. RLS protects data but UI may leak.

---

## Live DB Verification Results

### JWT Simulation (2026-06-12)

| Table | Admin (count) | Boss (count) | Match? |
|-------|---------------|--------------|--------|
| leads | 290 | 290 | ✅ |
| contracts | 2 | 2 | ✅ |
| payments | 0 | 0 | ✅ |
| notifications | 77 | 77 | ✅ |
| profiles | 6 | 6 | ✅ |
| quotations | 5 | 5 | ✅ |
| contract_approvals | 0 | 0 | ⚠️ No RLS |
| payment_allocations | 0 | 0 | ⚠️ No RLS |

Admin and Boss see identical data — **correct behavior** for these roles.

### RLS Status (Live DB)

- ✅ 21/24 tables have RLS enabled
- 🔴 `contract_approvals` — RLS OFF
- 🔴 `marketing_campaigns` — RLS OFF  
- 🔴 `payment_allocations` — RLS OFF

---

## Recommended Fix Priority

1. **Immediate (today):** Enable RLS on 3 unprotected tables + fix `notifications_service_insert`
2. **This sprint:** Add route guards to all 9 unprotected pages
3. **This sprint:** Change `public` role policies to `authenticated`
4. **Backlog:** Add `app_role` to JWT claims, add audit triggers for role changes
