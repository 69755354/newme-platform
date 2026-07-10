# Security Audit — 2026-07-11

## Confirmed vulnerabilities / fixes
| ID | P | Status | Evidence | Impact | Remediation | Verification |
|---|---:|---|---|---|---|---|
| SEC-001 | P0 | Fixed | `.github/workflows/crm-ci.yml` previously referenced production repository secrets for build smoke. | CI could rely on production secrets and broaden secret exposure blast radius. | Replaced with safe placeholder build env and added separate `ci.yml`. | Inspect `.github/workflows/*.yml`; CI run. |
| SEC-002 | P1 | REVIEW | `src/shared/hooks/usePipelineDragDrop.ts` performs browser-side Supabase updates/inserts. | Ownership depends on RLS/DB only for that path; less observable than server action. | Move to server action after Phase 0 audit acceptance. | `npm run check:supabase-boundaries` reports allowlisted baseline. |

## Passing controls
- `src/app/api/leads/[id]/quality/route.ts` authenticates via `getAuthProfile`, checks `leads.assigned_to`, validates quality enum, and returns 401/403/404.
- `src/app/api/contracts/[id]/route.ts` authenticates with `auth.getUser`, checks role, then `contract.sales_id` for sales users.
- `src/app/actions/settings.ts` restricts reassignment actions to admin/boss/operator.

## Dynamic verification risks
- `GET /api/tasks/[id]` relies on RLS for ownership while PATCH adds explicit `assignee_id`; marked REVIEW in IDOR matrix.
- Notification fanout paths in `src/app/api/notify/route.ts` require dynamic recipient tests.

## npm audit classification

`npm audit --omit=dev` and full `npm audit` currently return the same summary: 4 moderate, 2 high, 0 critical. Runtime/direct high: `xlsx` (SheetJS prototype pollution and ReDoS advisories; no safe blind force-upgrade in this Phase 0.5 change). Runtime/transitive high: `hono` via `@sentry/nextjs`. Runtime moderate: `next`/`postcss`, `dompurify`, and Sentry/Next transitive paths. These are recorded as P1 review risks rather than silently ignored.
