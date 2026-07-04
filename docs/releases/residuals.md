# Supabase Client Residuals — Exception Registry

> **Purpose**: Document all known client-side Supabase usage that remains after P1/P2 migration.
> Each entry records the path, type of usage, risk level, and the decision that allows it.
> This registry is the single source of truth for residual exceptions.
>
> **Last updated**: 2026-07-04 (P1/P2 release)

---

## Active Residuals

### RES-001: dashboard/page.tsx — activities.insert (quick log)
- **Path**: `src/app/(dashboard)/dashboard/page.tsx:440`
- **Type**: Client mutation (`.insert()`)
- **Risk**: **LOW**
- **Decision**: P1-C — Accepted. Quick log of dashboard view activity is low-priority and non-critical. No sensitive data. Does not affect core business logic.
- **Migration status**: Not planned for P1/P2. May be moved to server action in P3.
- **Reviewed**: 2026-07-04

### RES-002: payments/page.tsx — installment_plans.select
- **Path**: `src/app/(dashboard)/payments/page.tsx:264`
- **Type**: Client read (`.select()`)
- **Risk**: **LOW**
- **Decision**: P2 — Accepted. Read-only query for installment plan display. Data is not sensitive. Low volume query.
- **Migration status**: Not planned for P2. May be moved to BFF API route in future iteration.
- **Reviewed**: 2026-07-04

---

## Out-of-Scope Residuals

These areas were explicitly excluded from the P1/P2 migration scope. They still contain client-side Supabase usage but are not yet migrated.

| Area | Path Pattern | Type | Notes |
|------|-------------|------|-------|
| Quotations | `src/app/(dashboard)/quotations/*` | Full client Supabase | Separate module, not in P1/P2 scope |
| Leads sub-pages | `src/app/(dashboard)/leads/**/*` | Full client Supabase | Detail pages, not in P1/P2 scope |
| Projects | `src/app/(dashboard)/projects/*` | Full client Supabase | Separate module, not in P1/P2 scope |
| Quotes | `src/app/(dashboard)/quotes/*` | Full client Supabase | Separate module, not in P1/P2 scope |
| Contracts/new | `src/app/(dashboard)/contracts/new/*` | Full client Supabase | Create flow, not in P1/P2 scope |

---

## Resolved Residuals

*None yet — all active residuals are awaiting future phases.*

---

## Audit Process

Run these scripts to verify residual status:
- `scripts/audit-client-supabase.sh` — scan for client Supabase usage
- `scripts/audit-service-role.sh` — scan for service_role exposure
- `scripts/day-end-health-check.sh` — full health check including residuals

---

## Decision Log

| Date | ID | Decision | Rationale | Approver |
|------|-----|----------|-----------|----------|
| 2026-07-04 | RES-001 | ACCEPT (LOW) | Non-critical activity logging; no business impact | P1-C review |
| 2026-07-04 | RES-002 | ACCEPT (LOW) | Read-only display query; non-sensitive data | P2 review |
| 2026-07-04 | Out-of-scope | DEFER to P3+ | Separate modules not in migration scope | Release planning |
