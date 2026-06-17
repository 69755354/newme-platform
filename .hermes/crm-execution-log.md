# CRM Execution Log

> Executor: GLM 5.2 (Coding Plan) · Supervisor: DeepSeek Reasoner (CRM项目总监)
> Branch: `feat/crm-v2` · Work dir: `/home/ubuntu/newme-platform`

---

## Batch 1: Security — STATUS: completed

**Headline:** All 4 tasks resolved. Tasks 1–3 were **already fixed** in code and live DB
(verified against Supabase production catalogs, not migration files); this batch
captured the one piece of **migration drift** into version control and added the one
**genuinely missing** control (Task 4 route guard).

### Verification method
Direct queries against the **live** Supabase DB via the Management API
`/v1/projects/{ref}/database/query` endpoint (read system catalogs
`pg_class.relrowsecurity` + `pg_policies`). This is authoritative — migration files
were treated as *claims*, the live catalog as *truth*.

---

### Task 1 — P0-1 RLS on contract_approvals / payment_allocations / marketing_campaigns → DONE

**Finding:** All 3 tables **already have RLS enabled** in production (`relrowsecurity=true`,
confirmed by catalog query). Migration `20260612000007_fix_p0_security_rls.sql` was
applied. The CRM-TASK-ORDER (2026-06-18) was stale on this item.

**Live policies (verified):**
| Table | Policy | Cmd | Rule |
|-------|--------|-----|------|
| contract_approvals | `ca_admin_all` | ALL | `get_my_role() IN ('admin','boss')` |
| contract_approvals | `ca_sales_select` | SELECT | owns the linked contract |
| payment_allocations | `pa_admin_all` | ALL | `get_my_role() IN ('admin','boss')` |
| payment_allocations | `pa_sales_select` | SELECT | owns the linked contract/payment |
| marketing_campaigns | `mc_admin_all` | ALL | `get_my_role() IN ('admin','boss')` |

All policies are scoped `TO authenticated`, so anon is mathematically denied.

**Migration created:** `supabase/migrations/20260618000000_fix_rls_p0.sql` (idempotent
re-affirmation — `ENABLE ROW LEVEL SECURITY` + `DROP/CREATE POLICY` matching the live
secure state). **Applied to live DB** — re-queried catalogs afterward, all 6 policies
present and correct.

**Deliberate deviation — did NOT add `sales_insert`:** The task template requested a
`sales_insert … WHERE assigned_to = auth.uid()` policy. **None of these 3 tables have
an `assigned_to` column** (`contract_approvals.contract_id→contracts.sales_id`;
`payment_allocations.payment_id`/`allocated_by`; `marketing_campaigns` is admin-only).
Approvals, allocations and campaigns are created by admins / the server (service_role,
which bypasses RLS). Granting sales INSERT would be a **security regression**, so the
existing admin-only-write design is retained. This matches the already-applied live state.

---

### Task 2 — P0-2 Fix notifications INSERT policy → DONE

**Finding:** Live `notifications_service_insert` is already hardened to
`WITH CHECK (user_id = auth.uid())` — **stricter** than the `WITH CHECK (true)` the
task spec asked for (per the 2026-06-15 production audit). An authenticated user can
only create notifications for *themselves*; cross-user injection is blocked.
Server-side creation via `supabaseAdmin` (service_role) bypasses RLS, so legitimate
system notifications are unaffected.

**Drift captured:** The hardened `user_id = auth.uid()` check existed **only in the live
DB, not in any committed migration** — a fresh DB rebuilt from migrations would have
reverted to the insecure `WITH CHECK (true)`. Migration `20260618000000_fix_rls_p0.sql`
now encodes the strict version. **Applied + re-verified** (catalog shows
`with_check = (user_id = auth.uid())`).

---

### Task 3 — P0-3 Meta CAPI webhook auth bypass → DONE (already fixed in working tree)

**Finding:** `src/app/api/leads/meta-capi/route.ts` lines 14–24 are already correct:
```ts
const webhookSecret = process.env.META_CAPI_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error("META_CAPI_WEBHOOK_SECRET not configured");
  return NextResponse.json({ error: "Server misconfigured" }, { status: 503 });
}
// …Bearer token compared; returns 401 on mismatch
```
Secret is **required** (503 if unconfigured), no fail-open path, auth check runs before
any business logic. The file shows as modified-uncommitted in `git status`; the change is
present in the working tree. No further code change needed. (File: `src/app/api/leads/meta-capi/route.ts`)

---

### Task 4 — P1-1 Route guard middleware → DONE (code change)

**Framework-correct decision:** The task asked to "create `src/middleware.ts`", but
**Next.js 16 deprecated `middleware.ts` and renamed it to `proxy.ts`** (confirmed in
`node_modules/next/dist/docs/.../upgrading/version-16.md`: *"The `middleware` filename is
deprecated… renamed to `proxy`"*; also documented in `src/lib/supabase-middleware.ts`).
A new `src/middleware.ts` would be a **dead file** that Next.js 16 ignores. Instead I
**enhanced the existing `src/proxy.ts`**, which is the active entry point.

**Gaps fixed in `src/proxy.ts`:**
1. **Auth gate added.** Previously, any route *not* in `PROTECTED_ROUTES` (e.g.
   `/dashboard`, `/leads`, `/leads/new`) passed through **without any session check** —
   an anonymous user could hit them directly (only a 5 s client-side redirect stood in
   the way). Now `isDashboardPage()` requires a valid session for **all** dashboard page
   prefixes and redirects to `/login?redirect=…`. `/api/*` is excluded (API routes return
   401 JSON, not an HTML redirect).
2. **Role gate expanded.** `PROTECTED_ROUTES` previously covered only `/settings`,
   `/team`, `/pipeline`. Added `/analytics`, `/ads`, `/products`, `/projects` (admin /
   boss / operator only) — closing the "sales can directly visit management pages" hole.
3. **Matcher** gained `/payments/:path*`.

**Verification:** Full-project `tsc` (run by the edit lint hook) reports **no new errors**
from this edit. The `@/lib/supabase-middleware` resolution warning is **pre-existing**
(git HEAD's `proxy.ts` has the byte-identical import; the app compiles & runs). Targeted
isolated type-check of `proxy.ts` produced no errors. Activity-tracking, bearer-header
dev fallback, and the existing role-fetch logic are all preserved unchanged.

**Runtime note:** The currently-running service (port 3001) is the **old build** and does
not include this change. The new proxy takes effect only after rebuild + restart, which is
**Batch 4 (P0-5/P0-6 deploy)**. Batch 1 deliverable = correct, type-verified code.

---

### Task 5 — Apply migrations → DONE

- DB access: obtained project region (`ap-southeast-1`) + DB password from `.env.local`;
  Management-API PAT (`SUPABASE_PAT`) verified (HTTP 200). Direct/pooler `psql` failed
  (IPv6 unreachable / Supavisor credential masking), so applied migrations via the
  Management API `/database/query` endpoint instead — equally authoritative.
- `20260618000000_fix_rls_p0.sql` applied → response `[]` (DDL success). Post-apply
  catalog re-query confirms all 6 target policies present and correct.

---

## Summary table

| Task | Status | Action | Applied to live DB |
|------|--------|--------|--------------------|
| 1 — RLS 3 tables | DONE | Drift captured into migration; secure state already live | ✅ verified |
| 2 — notifications INSERT | DONE | Hardened policy encoded in migration (stricter than spec) | ✅ verified |
| 3 — Meta CAPI webhook | DONE | Already fixed in working tree; verified | n/a (code) |
| 4 — route guard | DONE | Enhanced `src/proxy.ts` (Next.js 16 convention, not `middleware.ts`) | n/a (code; pending rebuild) |
| 5 — apply migrations | DONE | via Management API `/database/query` | ✅ |

**New/changed files:**
- `supabase/migrations/20260618000000_fix_rls_p0.sql` (new)
- `src/proxy.ts` (modified — auth gate + expanded role gate)

**Carry-forward to Batch 4 (deploy):** rebuild + restart so the `proxy.ts` change and the
uncommitted `meta-capi/route.ts` fix go live. The DB-side security (Tasks 1–2) is already
protecting production.
