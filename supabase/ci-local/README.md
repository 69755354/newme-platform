# CI-only task-followup database contract gate

This is a narrowed `profiles -> leads -> tasks` contract project. It verifies
the production-observed last-pending-task invariant and current task RLS owner
boundary. It is not a full-schema replay, is not a production migration source,
and must never be linked or pushed.

The canonical root migration chain is intentionally untouched. Its independent
clean-reset blockers and every source Git blob used here are recorded in
`PROVENANCE.md`.

## Exact gate

Use the official Supabase CLI 2.113.0 binary. Verify its SHA-256 is
`6CAE923943F7CDC7CD9F5BE3860F3838C0F9AEBA22A51B8FD7678C8103090F05`, then run
from the repository root:

```text
node supabase/ci-local/verify-provenance.mjs
supabase db start --workdir supabase/ci-local
supabase db reset --local --workdir supabase/ci-local --yes
node supabase/ci-local/verify-reset.mjs
supabase db reset --local --workdir supabase/ci-local --yes
node supabase/ci-local/verify-reset.mjs
supabase test db --local --workdir supabase/ci-local supabase/ci-local/supabase/tests/database
supabase stop --project-id newme-ci-task-followup-v1 --no-backup
```

Both resets must report migration application and `Seeding data from seed.sql`;
the adjacent verifier must print `PASS seed marker task-followup-ci-v1|1`.
The pgTAP command must report exactly one file, 14 tests, and `Result: PASS`.
`Files=0` or `Result: NOTESTS` is a failure even though `pg_prove` exits zero.
