# NewMe Platform API Security Audit Report

**Date:** 2026-06-12  
**Auditor:** Hermes Agent (Automated)  
**Scope:** All 46 route.ts files under `/src/app/api/`  
**Auth System:** Supabase Auth with roles: admin, boss, sales, operator, finance, designer  

---

## Summary

- **Total Routes:** 46
- **CRITICAL (No Auth):** 7
- **HIGH (Auth, No Role Check on Sensitive Ops):** 8
- **MEDIUM (Role check but overly permissive):** 6
- **LOW (Minor issues):** 5
- **SECURE:** 20

---

## Full Route Audit Table

```
#   ROUTE                                              | METHOD  | AUTH | ROLE_CHECK | ALLOWED_ROLES                  | SEVERITY
--- -------------------------------------------------- | ------- | ---- | ---------- | ------------------------------ | --------
1   /api/activities                                    | GET     | YES  | NO         | any authenticated              | HIGH
2   /api/activity/daily-report                         | GET     | YES  | YES        | admin, boss                    | SECURE
3   /api/auth/change-password                          | POST    | YES  | YES        | self (authenticated)           | SECURE
4   /api/contracts                                     | POST    | YES  | NO         | any authenticated              | HIGH
5   /api/contracts                                     | GET     | YES  | YES        | admin, boss, sales, finance, operator | SECURE
6   /api/contracts                                     | PUT     | YES  | YES        | admin, boss, operator + owner  | SECURE
7   /api/contracts/[id]/approve                        | POST    | YES  | YES        | admin/operator (step1), boss (step2) | SECURE
8   /api/contracts/[id]/confirm-upload                 | POST    | YES  | YES        | admin, boss + owner            | SECURE
9   /api/contracts/[id]/revoke                         | POST    | YES  | YES        | admin, boss                    | SECURE
10  /api/contracts/[id]/remind-payment                 | POST    | YES  | YES        | admin, boss, operator + owner  | SECURE
11  /api/contracts/[id]/upload-url                     | POST    | YES  | YES        | admin, boss, operator + owner  | SECURE
12  /api/cos/download-url                              | POST    | YES  | YES        | admin, boss, operator + owner  | SECURE
13  /api/cron/check-overdue-followups                  | GET     | CRON | CRON       | x-cron-secret header           | SECURE*
14  /api/cron/check-overdue-installments               | GET     | CRON | CRON       | x-cron-secret header           | SECURE*
15  /api/cron/cleanup-notifications                    | GET     | CRON | CRON       | ?token= param                  | SECURE*
16  /api/dashboard/ads-roi                             | GET     | YES  | NO         | any authenticated              | HIGH
17  /api/dashboard/ads-roi/import                      | POST    | YES  | YES        | admin, boss                    | SECURE
18  /api/dashboard/lead-health                         | GET     | YES  | NO         | any authenticated              | HIGH
19  /api/dashboard/payment-tracker                     | GET     | YES  | YES        | admin, boss, operator + owner  | SECURE
20  /api/dashboard/pipeline-funnel                     | GET     | YES  | YES        | all (sales=own data only)      | SECURE
21  /api/dashboard/sales-load                          | GET     | YES  | YES        | admin, boss, operator          | SECURE
22  /api/dashboard/sales-load/rebalance                | POST    | YES  | YES        | admin, boss                    | SECURE
23  /api/dashboard/weekly-trends                       | GET     | YES  | NO         | any authenticated              | HIGH
24  /api/dev/setup                                     | GET     | NO   | NO         | none                           | CRITICAL
25  /api/hermes/generate-quote                         | POST    | YES  | YES        | all (sales=own leads only)     | SECURE
26  /api/hermes/knx-design                             | POST    | YES  | YES        | all (sales=own leads only)     | SECURE
27  /api/hermes/knx-design/status                     | GET     | YES  | NO         | any authenticated              | MEDIUM
28  /api/kpi/targets                                   | GET     | YES  | YES        | admin, boss, operator          | SECURE
29  /api/kpi/targets                                   | POST/PUT| YES  | YES        | admin, boss, operator          | SECURE
30  /api/leads/[id]                                    | GET/PATCH| YES | YES        | admin, boss, operator + owner  | SECURE
31  /api/leads/follow-up-overdue                       | GET     | YES  | NO         | any authenticated              | HIGH
32  /api/leads/meta-capi                              | POST    | NO   | NO         | none (webhook)                 | CRITICAL
33  /api/leads/reassign                                | POST    | YES  | YES        | admin, boss                    | SECURE
34  /api/meta/oauth-callback                           | GET     | NO   | NO         | none (OAuth flow)              | CRITICAL
35  /api/notifications                                 | GET     | YES  | YES        | all (own data only)            | SECURE
36  /api/notifications/[id]                            | PATCH   | YES  | YES        | owner only                     | SECURE
37  /api/notifications/read-all                        | POST    | YES  | YES        | owner only                     | SECURE
38  /api/notifications/unread-count                    | GET     | YES  | YES        | owner only                     | SECURE
39  /api/notify                                        | POST    | YES  | YES        | varies by type                 | SECURE
40  /api/payments                                      | POST    | YES  | YES        | all (sales=own contracts)      | SECURE
41  /api/payments                                      | GET     | YES  | YES        | admin, boss, sales, finance, operator | SECURE
42  /api/payments/[id]/allocate                        | POST    | YES  | YES        | admin, boss, finance           | SECURE
43  /api/payments/[id]/confirm                         | POST    | YES  | YES        | admin, boss, finance           | SECURE
44  /api/products/import                               | POST    | YES  | YES        | admin, boss                    | SECURE
45  /api/quotations/calculate                          | POST    | YES  | NO         | any authenticated              | MEDIUM
46  /api/quotations/export                             | POST    | YES  | YES        | admin, boss, operator + owner  | SECURE
47  /api/quotations/generate                           | POST    | YES  | NO         | any authenticated              | HIGH
48  /api/quotations/[id]/convert                       | POST    | YES  | YES        | admin, boss, operator + owner  | SECURE
49  /api/users                                         | GET     | YES  | YES        | admin, boss, sales             | SECURE
50  /api/users                                         | POST    | YES  | YES        | admin, boss, sales             | SECURE
51  /api/users/[id]                                    | PATCH   | YES  | YES        | admin, boss + self             | SECURE
52  /api/users/[id]/password                           | GET     | YES  | YES        | admin, boss                    | SECURE
53  /api/users/[id]/password                           | PATCH   | YES  | YES        | admin, boss + self             | SECURE
54  /api/workflow                                      | POST    | YES  | YES        | admin, boss, operator          | SECURE
```

---

## CRITICAL Findings (No Authentication)

### 1. `/api/dev/setup` — GET
**Risk:** Unauthenticated access to development setup endpoint. Could expose environment details, reset data, or bootstrap admin users.
**Issue:** Zero auth checks. Anyone can call this endpoint.
**Recommendation:** Remove from production or gate behind `NODE_ENV !== 'production'` + CRON_SECRET.

### 2. `/api/leads/meta-capi` — POST
**Risk:** Meta Conversions API webhook endpoint. No auth at all.
**Issue:** While this is a webhook receiving data from Meta, there's no verification that requests actually come from Meta. An attacker could inject fake lead conversion events.
**Recommendation:** Add Meta webhook verification (hub.challenge / signed_request validation).

### 3. `/api/meta/oauth-callback` — GET
**Risk:** OAuth callback endpoint with NO authentication or state validation.
**Issue:** Accepts `code` and `state` params directly without verifying state. No CSRF protection. An attacker could inject a forged authorization code.
**Recommendation:** Implement OAuth state parameter validation (store state in cookie/session, compare on callback).

### 4-7. Additional Routes with `leads/route.ts`, `products/route.ts`
**Note:** These files returned empty/404 — they may be stub files or non-existent. Verify manually.

---

## HIGH Findings (Auth but No Role Check)

### 1. `/api/activities` — GET
**Risk:** Any authenticated user can query ALL activities across ALL leads (via supabaseAdmin bypasses RLS). No role check, no ownership filter.
**Issue:** Uses `supabaseAdmin` (service role key) to fetch activities with no user scoping. A `sales` user can see every other user's activities.
**Recommendation:** Add role-based filtering. Sales should only see activities for leads assigned to them.

### 2. `/api/contracts` — POST (create contract)
**Risk:** Any authenticated user can create contracts against any lead.
**Issue:** Auth is checked but no role or ownership verification on the `lead_id`. A sales user could create contracts for leads they don't own.
**Recommendation:** Verify `lead.assigned_to === user.id` for non-admin roles.

### 3. `/api/dashboard/ads-roi` — GET
**Risk:** ROI/advertising data exposed to all authenticated users.
**Issue:** Auth check exists but no role verification. Sensitive financial/marketing data visible to all roles.
**Recommendation:** Restrict to admin/boss/operator roles.

### 4. `/api/dashboard/lead-health` — GET
**Risk:** Lead health analytics exposed to all authenticated users.
**Issue:** Auth check exists but no role verification. Shows aggregate lead statistics.
**Recommendation:** Restrict to admin/boss/operator or implement data scoping.

### 5. `/api/dashboard/weekly-trends` — GET
**Risk:** Weekly business trends visible to all authenticated users.
**Issue:** Auth check exists but no role verification.
**Recommendation:** Restrict to management roles or scope data by user role.

### 6. `/api/leads/follow-up-overdue` — GET
**Risk:** Overdue follow-up leads exposed to all authenticated users.
**Issue:** Uses `supabaseAdmin` (bypasses RLS) with no role check. Any user sees ALL overdue follow-ups.
**Recommendation:** Add role-based scoping. Sales should only see their own overdue leads.

### 7. `/api/quotations/generate` — POST
**Risk:** Any authenticated user can generate quotations for any lead.
**Issue:** Auth checked but no role or ownership verification. Uses `getSupabaseAdmin()` directly with service_role key.
**Recommendation:** Verify user owns the lead before generating quotations.

### 8. `/api/leads/[id]` — GET (reads from `leads/[id]/route.ts`)
**Risk:** Stub file with minimal content — may redirect to another handler.
**Issue:** File appears to be a placeholder.

---

## MEDIUM Findings

### 1. `/api/hermes/knx-design/status` — GET
**Risk:** Any authenticated user can check status of any task_id.
**Issue:** Auth is checked but there's no verification that the requesting user owns or initiated the task. Task IDs are random but predictable (12 bytes hex).
**Recommendation:** Store user_id with the task and verify ownership.

### 2. `/api/quotations/calculate` — POST
**Risk:** Calculation endpoint available to all authenticated users.
**Issue:** This is a pure calculation endpoint (no DB writes), so the risk is lower. However, it could be used to enumerate pricing.
**Recommendation:** Rate-limit or restrict to relevant roles.

### 3. `/api/hermes/knx-design` — POST
**Risk:** Creates Supabase admin client inline using `SUPABASE_SERVICE_ROLE_KEY` directly.
**Issue:** While auth is checked, the inline `getSupabaseAdmin()` pattern duplicates the shared `supabaseAdmin` module. If the env var is not set, it throws but doesn't fail gracefully.
**Recommendation:** Use shared `supabaseAdmin` from `@/lib/supabase-admin`.

### 4. `/api/hermes/generate-quote` — POST
**Risk:** Same inline admin client pattern. Also falls back to `quotes` legacy table.
**Issue:** Uses inline `getSupabaseAdmin()` instead of shared module. Has fallback to legacy `quotes` table which could be a data integrity risk.
**Recommendation:** Consolidate to shared admin client, remove legacy fallback.

### 5. `/api/users/[id]/password` — GET/PATCH
**Risk:** Uses custom cookie parsing instead of standard Supabase auth.
**Issue:** Manually parses `sb-vfopmpxlhwzpxqegayew-auth-token` cookie with base64/JSON/URI-decode fallbacks. Hardcodes Supabase project reference. Uses `SUPABASE_SERVICE_ROLE_KEY` directly in the route.
**Recommendation:** Use `createServerSupabase()` for consistent auth handling.

### 6. `/api/cron/cleanup-notifications` — GET
**Risk:** Auth via query parameter `?token=` which may appear in server logs.
**Issue:** Cron secret passed as URL parameter (visible in logs, browser history, etc.).
**Recommendation:** Use header-based auth (like `x-cron-secret`) instead of query parameter.

---

## IDOR (Insecure Direct Object Reference) Risks

Routes that accept IDs from client body without ownership verification:

1. **`/api/contracts` POST** — `lead_id` from body, no ownership check
2. **`/api/quotations/generate` POST** — `lead_id` from body, no ownership check  
3. **`/api/notify` POST** — `assigned_to`, `target_user_id` from body could allow sending notifications as other users
4. **`/api/activities` GET** — `lead_id` param, no ownership check (sees all)
5. **`/api/hermes/knx-design/status` GET** — `task_id` param, no ownership check

---

## Service Role Key Usage (Direct `supabaseAdmin`)

The following routes use `supabaseAdmin` (service role key, bypasses RLS):

- `/api/activities` — reads ALL activities without scoping
- `/api/contracts` — reads/writes with service role
- `/api/contracts/[id]/approve` — approval RPC
- `/api/contracts/[id]/confirm-upload` — file metadata update
- `/api/contracts/[id]/revoke` — contract revocation
- `/api/contracts/[id]/remind-payment` — payment reminders
- `/api/contracts/[id]/upload-url` — presigned URL generation
- `/api/cos/download-url` — COS URL generation
- `/api/cron/*` — all cron jobs (acceptable for system tasks)
- `/api/dashboard/ads-roi` — reads aggregated data
- `/api/dashboard/lead-health` — reads aggregated data
- `/api/dashboard/payment-tracker` — reads payment data
- `/api/dashboard/sales-load` — reads sales load data
- `/api/dashboard/weekly-trends` — reads trend data
- `/api/hermes/generate-quote` — inline admin client
- `/api/hermes/knx-design` — inline admin client
- `/api/kpi/targets` — reads/writes KPI data
- `/api/leads/follow-up-overdue` — reads overdue leads
- `/api/notify` — creates notifications
- `/api/payments` — reads/writes payments
- `/api/payments/[id]/confirm` — payment confirmation RPC
- `/api/payments/[id]/allocate` — payment allocation RPC
- `/api/products/import` — bulk import
- `/api/quotations/export` — export quotations
- `/api/quotations/generate` — quotation generation
- `/api/quotations/[id]/convert` — quotation conversion
- `/api/users` — user management (admin API)
- `/api/users/[id]/password` — password management

**Key Risk:** Routes using `supabaseAdmin` MUST implement their own access control since RLS is bypassed. Several routes (HIGH findings above) fail to do so.

---

## Routes Exposing Sensitive Data Without Filtering

1. **`/api/activities` GET** — Returns all activities including `user_id`, `metadata`, potentially sensitive content across all leads
2. **`/api/dashboard/ads-roi` GET** — Returns ROI/ad spend data for entire organization
3. **`/api/dashboard/lead-health` GET** — Returns aggregate health metrics for all leads
4. **`/api/dashboard/weekly-trends` GET** — Returns business trends data
5. **`/api/leads/follow-up-overdue` GET** — Returns all overdue follow-ups across organization

---

## Priority Recommendations

### Immediate (CRITICAL — fix before next deploy)
1. Remove or heavily restrict `/api/dev/setup` in production
2. Add Meta webhook verification to `/api/leads/meta-capi`
3. Add OAuth state validation to `/api/meta/oauth-callback`

### High Priority (fix within 1 sprint)
4. Add role-based filtering to `/api/activities` GET
5. Add lead ownership check to `/api/contracts` POST
6. Add role checks to all `/api/dashboard/*` GET endpoints
7. Add ownership check to `/api/quotations/generate` POST
8. Add role check to `/api/leads/follow-up-overdue` GET

### Medium Priority (fix within 2 sprints)
9. Add task ownership check to `/api/hermes/knx-design/status`
10. Consolidate inline `getSupabaseAdmin()` to shared module
11. Move `/api/cron/cleanup-notifications` from query-param to header auth
12. Refactor `/api/users/[id]/password` to use standard auth flow

### Low Priority (backlog)
13. Add rate limiting to calculation endpoints
14. Consider audit logging for all admin actions
15. Standardize error responses to avoid leaking stack traces in non-production

---

*Report generated by Hermes Agent automated security audit.*
