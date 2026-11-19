# Guarded S25 database-batch provisioning

Applies `20261119150000_whatsapp_history_backfill.sql` (OS fix S25, WhatsApp coexistence history backfill:
one defaulted `backfilled` column on `whatsapp_message_events`, one server-only contacts table and two service-role
routines) to a
production database that already carries every earlier deferred migration, including both S16
files and the S18 file (and the S21 file when that one has been released). Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s16-db-batch-provisioning.md`: production is `strict` with every
earlier deferred migration recorded, so the new file can only be a deferred entry appended last.
Every generic path refuses that state (`contract_verified` wants all deferred files present,
`applied_verified` wants them all absent, `contract-apply` wants the candidate to be the live
release), so the file has to be applied before the application release by an operation that
accepts exactly this one file: `s25-db-plan` / `s25-db-provision`.

## Gate (`scripts/check-s25-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including
  the S16 ones, the S18 one and, if present, the S21 one) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule
  check, `s25-whatsapp-history-backfill-present`;
- the database is either in the state before S25 (no `backfilled` column, no contacts table and neither routine exists)
  or fully provisioned and recorded. A partial or unrecorded application is
  refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh
CI gate, like the other suffixes.

## Order

1. Release the switch on its own (this branch: the manifest has no S25 entry and the tree has no
   S25 migration file) through the normal `contract_verified` flow. It installs the new operations.
2. Merge the S25 application branch. From that main commit run
   `newme-deploy db-transition <sha> <run-id> s25-db-plan`, check that the plan lists only
   `20261119150000`, then `s25-db-provision`.
3. Release the application with `contract_verified` and the full required list.

The switch accepts the migration only while no later-numbered migration is in the live release. Its version (20261119150000) is
deliberately lower than S23 (20261119200000) and S24 (20261119300000), so the S23 and S24 gates still accept it as part of the
live prefix; provision S25 before the S23 and S24 migrations are applied. If either of those is applied first, renumber the
S25 migration after them and ship a new switch version.

## If the migration changes

`S25_EVENTS[0].sha256` and `S25_POSTURE_SQL` pin the reviewed file and predicate. Any change must
be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp` for the hash) and in
the checker, or the gate refuses.
