# Database Regression Harness — Phase 0

This repository does not connect to production databases in CI. Phase 0 adds an offline static harness via `npm run check:db-static`.

Covered statically:
- migration timestamp uniqueness and lexical ordering
- RLS enable evidence for `leads`, `contracts`, `payments`, `tasks`, `business_events`, `profiles`
- trigger/function/event evidence for `first_contact`, `quality_checked`, `leads_archived`, `won_at`, `check_milestone_order`, `confirm_payment`
- destructive DROP review signal

Dynamic test database plan (not run by default CI):
1. Start an isolated local Supabase project or disposable test database.
2. Apply migrations in order.
3. Seed admin, boss, sales A, sales B, leads, contracts, payments, tasks.
4. Assert sales A cannot read/update sales B resources.
5. Assert admin/boss can read management-scoped resources.
6. Assert lead milestone order, first-contact, new→contacted, won_at, won/lost protection, business_events allowed values, and payment/contract ownership.

No production migration is executed by this harness.
