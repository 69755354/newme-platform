# Guarded S18 database-batch provisioning

Applies `20261118200000_whatsapp_ctwa_leads.sql` (OS fix S18, Click-to-WhatsApp ad leads:
five additive lead columns, three server-only tables, one service-role writer) to a
production database that already carries every earlier deferred migration, including both S16
files. Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s16-db-batch-provisioning.md`: production is `strict` with every
earlier deferred migration recorded, so the new file can only be a deferred entry appended last.
Every generic path refuses that state (`contract_verified` wants all deferred files present,
`applied_verified` wants them all absent, `contract-apply` wants the candidate to be the live
release), so the file has to be applied before the application release by an operation that
accepts exactly this one file: `s18-db-plan` / `s18-db-provision`.

## Gate (`scripts/check-s18-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including
  the two S16 ones) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule
  check, `s18-whatsapp-ctwa-leads-present`;
- the database is either untouched (none of the five lead columns, none of the three tables, no
  writer routine) or fully provisioned and recorded. A partial or unrecorded application is
  refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh
CI gate, like the other suffixes.

## Order

1. Release the switch on its own (this branch: the manifest has no S18 entry and the tree has no
   S18 migration file) through the normal `contract_verified` flow. It installs the new operations.
2. Merge the S18 application branch. From that main commit run
   `newme-deploy db-transition <sha> <run-id> s18-db-plan`, check that the plan lists only
   `20261118200000`, then `s18-db-provision`.
3. Release the application with `contract_verified` and the full required list.

The switch accepts the migration only as the LAST deferred entry. If another deferred migration
merges first, ship a new switch version.

## If the migration changes

`S18_EVENTS[0].sha256` and `S18_POSTURE_SQL` pin the reviewed file and predicate. Any change must
be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp` for the hash) and in
the checker, or the gate refuses.
