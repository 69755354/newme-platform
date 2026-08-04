# SAM-79 — V4 commercial control plane

## Delivered boundary

SAM-79 implements the commercial control plane described by `V4-PF-005` and
`V4-PF-006` without introducing an external billing provider:

- immutable, versioned Starter (5 seats / 1 organization), Growth (20 / 3),
  and Scale (50+ / negotiated organization limit) plan records;
- one organization subscription with trial, active, grace, read-only,
  suspended and closed lifecycle states;
- paid-seat allocation and append-only seat event records synchronized with
  active accepted billable memberships under a subscription row lock;
- plan and approved-override entitlements, idempotent usage events, bounded
  quota enforcement and fail-closed overage;
- explicitly manual invoice references; no payment-provider settlement claim;
- authenticated platform requests, independent second approval, service-only
  execution and append-only action/state evidence;
- organization-scoped read policies, exact generated database types, a
  server-only administration API and the `/settings/commercial` UI.

## Evidence map

| Requirement | Source evidence | Executable evidence |
|---|---|---|
| plan/subscription/state | `supabase/migrations/20260805190000_v4_commercial_control_plane.sql` | `tests/database/v4-commercial-control-plane.sql` |
| seats/concurrency | `v4_sync_membership_paid_seat` and `paid_seat_allocations` | disposable PostgreSQL SAM-23/SAM-79 gate |
| entitlement/quota/idempotency | `v4_record_commercial_usage` | database test plus `SAM-79` product UAT result |
| invoice references | `commercial_invoice_references` with `source = manual` | database test plus product UAT summary |
| approval/audit | `v4_request_commercial_action`, `v4_approve_commercial_action`, `v4_execute_commercial_action` | database and API contract tests |
| RLS/API/UI | table policies, `/api/platform/commercial`, `/settings/commercial` | security contract and TypeScript gates |
| rollback | `supabase/rollback/20260805190000_v4_commercial_control_plane_rollback.sql` | disposable rollback denial/apply/verify |
| staging UAT/cleanup | `scripts/uat/product-saas-final.mjs` | exact-release `uat-product-saas` report with `SAM-79=pass` and residue zero |

## Promotion and rollback

The migration is staging-first. Promotion requires same-head CI, exact release
manifest binding, the disposable database apply/rollback gate and one
`uat-product-saas` run whose `SAM-79` result passes and whose cleanup counts are
all zero. The migration rollback is allowed only with
`newme.environment=staging|test` and refuses any non-bootstrap commercial
action, usage, invoice, state, override or seat evidence. After real commercial
use, recovery is forward-only or database restore; destructive rollback is not
permitted.

## Explicit non-claims

- No production schema, data, deployment, secret or billing-provider change is
  part of this unit.
- Manual invoice references are not payment collection, tax invoicing or
  settlement reconciliation.
- A merged change is not a deployed staging result; deployment and exact-release
  UAT remain separate promotion evidence.
