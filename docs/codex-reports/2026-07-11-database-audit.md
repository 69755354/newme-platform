# Database Audit — 2026-07-11

## Confirmed controls
| ID | P | Type | Evidence | Impact | Fix/next step | Verification |
|---|---:|---|---|---|---|---|
| DB-001 | P1 | Fixed | `supabase/migrations/20260706000001_auto_first_contact_trigger.sql` contains first-contact trigger logic. | First contact automation is migration-backed. | Static DB harness checks token presence. | `npm run check:db-static`. |
| DB-002 | P1 | Fixed | `supabase/migrations/20260706000002_check_milestone_order_compat.sql` contains `check_milestone_order`. | Milestone order is DB-enforced. | Add dynamic DB test when disposable DB is available. | `npm run check:db-static`. |
| DB-003 | P1 | Fixed | `supabase/migrations/20260706000005_add_leads_archived.sql` widens business event type list with `leads_archived`. | Audit event type no longer blocks archive event. | Keep static token check. | `npm run check:db-static`. |

## Architecture debt
- RLS coverage is migration-backed but not dynamically exercised in CI because CI must not connect to production DB.
- Rollback SQL files are present; destructive operations require manual review before any non-test run.

## Harness
See `docs/database/regression-harness.md` and `scripts/check-db-static.mjs`.
