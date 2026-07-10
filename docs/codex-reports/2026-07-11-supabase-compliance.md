# Supabase Compliance Audit — 2026-07-11

## Confirmed findings
| ID | P | Classification | Evidence | Impact | Remediation | Verification |
|---|---:|---|---|---|---|---|
| SB-001 | P1 | Architecture debt | `src/shared/hooks/usePipelineDragDrop.ts` direct client `.from().update()` and `.insert()` calls. | Client mutation path should be server-mediated for auditable ownership. | Allowlisted as baseline with reason; do not expand; migrate later. | `npm run check:supabase-boundaries`. |
| SB-002 | P0 | Fixed | `.github/workflows/crm-ci.yml` no longer requires `SUPABASE_SERVICE_ROLE_KEY` for CI build smoke. | Production service role not needed in CI. | Use test placeholders. | Workflow inspection. |

## Non-violations
- Server-side Supabase calls in `src/app/api/**` and `src/app/actions/**` are not flagged solely for using `.from()`; they are evaluated for auth/ownership separately.
- Scripts under `scripts/` may reference service-role environment names for operator-only tools; they are not browser reachable.
