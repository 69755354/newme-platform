# Guarded S24 database-batch provisioning

Applies `20261119300000_lead_dispatch_and_review.sql` (OS fix S24, lead dispatch states, phone review and duplicate review:
three new tables with row-level security and no client or service-role writes, plus the evaluation and decision routines) to a
production database that already carries every earlier deferred migration, including both S16
files and the S18 file (and the S21 file). Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s16-db-batch-provisioning.md`: production is `strict` with every
earlier deferred migration recorded, so the new file can only be a deferred entry appended last.
Every generic path refuses that state (`contract_verified` wants all deferred files present,
`applied_verified` wants them all absent, `contract-apply` wants the candidate to be the live
release), so the file has to be applied before the application release by an operation that
accepts exactly this one file: `s24-db-plan` / `s24-db-provision`.

## Gate (`scripts/check-s24-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including
  the S16 ones, the S18 one and, if present, the S21 one) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule
  check, `s24-lead-dispatch-review-present`;
- the database is either in the state before S24 (none of the three tables and none of the routines exist)
  or fully provisioned and recorded. A partial or unrecorded application is
  refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh
CI gate, like the other suffixes.

## Order

1. Release the switch on its own (this branch: the manifest has no S24 entry and the tree has no
   S24 migration file) through the normal `contract_verified` flow. It installs the new operations.
2. Merge the S24 application branch. From that main commit run
   `newme-deploy db-transition <sha> <run-id> s24-db-plan`, check that the plan lists only
   `20261119300000`, then `s24-db-provision`.
3. Release the application with `contract_verified` and the full required list.

The switch accepts the migration only as the LAST deferred entry. S21 and S23 have the smaller versions
(20261119100000, 20261119200000), so their application branches must be merged before this one; if another deferred
migration merges after S24 instead, ship a new switch version.

## If the migration changes

`S24_EVENTS[0].sha256` and `S24_POSTURE_SQL` pin the reviewed file and predicate. Any change must
be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp` for the hash) and in
the checker, or the gate refuses.
