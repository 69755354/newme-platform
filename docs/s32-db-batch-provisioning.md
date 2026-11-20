# Guarded S32 database-batch provisioning

Applies `20261120200000_tasks_future_only_not_valid.sql` (OS fix S32: the check constraint
`public.tasks.tasks_future_only`, `CHECK (due_at > now() - interval '30 days')`, re-created with the same
expression as `NOT VALID`) to a production database that already carries every earlier deferred migration,
including S31 (20261120100000). Nothing here has been applied to production.

## Why this migration

The first restore drill (2026-11-20) restored 0 of 112 `public.tasks` rows. The constraint is time-dependent and
validated, so `pg_dump` writes it inline in `CREATE TABLE`; on restore `COPY` re-checks every historic row against
today's clock, the first row older than the window aborts the `COPY` and the whole table is lost on any target,
Supabase included. `NOT VALID` keeps INSERT/UPDATE checks and makes `pg_dump` emit the constraint after the data.

## Why a dedicated switch

Same reasoning as `docs/s31-db-batch-provisioning.md`: production is `strict` with every earlier deferred
migration recorded, so the new file can only be a deferred entry appended last. Every generic path refuses that
state, so the file has to be applied before the application release by an operation that accepts exactly this one
file: `s32-db-plan` / `s32-db-provision`.

## Gate (`scripts/check-s32-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including the S31 one) are
  unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule check,
  `s32-tasks-future-only-not-valid`;
- the database is either in the state before S32 (exactly one validated `tasks_future_only` with the production
  expression `CHECK ((due_at > (now() - '30 days'::interval)))`) or fully provisioned and recorded (the same
  expression, `NOT VALID`). A missing constraint, another expression or an unrecorded application is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh CI gate, like the
other suffixes.

## Order

Switch and migration are in the same branch (PR #576), so one merge covers both:

1. Release the merged main commit through the normal `contract_verified` flow. It installs the new operations and
   the updated backup scripts (`newme-db-backup.sh` now joins the installer's managed set next to
   `newme-restore-drill.sh`; nothing is run by hand).
2. From that main commit run `newme-deploy db-transition <sha> <run-id> s32-db-plan`, check that the plan lists
   only `20261120200000`, then `s32-db-provision`. The gate verifies the constraint is `NOT VALID` with the same
   expression afterwards.
3. The next nightly backup (01:30 Dubai) carries the constraint after the data and the whatsapp_privacy schema;
   the restore drill then passes (`sudo systemctl start newme-restore-drill.service` to run it early).

The switch accepts the migration only as the LAST deferred entry. If another deferred migration (for example S33,
20261120300000) merges before S32 is provisioned, ship a new switch version.

## If the migration changes

`S32_EVENTS[0].sha256` and `S32_POSTURE_SQL` pin the reviewed file and predicate. Any change must be mirrored in
the manifest (`node scripts/check-release-manifest.mjs --stamp` for the hash) and in the checker, or the gate
refuses.
