# Guarded S31 database-batch provisioning

Applies `20261120100000_dispatch_and_history_corrections.sql` (OS fix S31, corrections to the S24 dispatch routines and
the S25 history backfill: `evaluate_lead_dispatch`, `dispatch_decide`, `sweep_lead_dispatch` and
`record_whatsapp_ad_event` replaced in place with the same signatures, plus one new service-role helper
`dispatch_reevaluate_dependents`) to a production database that already carries every earlier deferred migration,
including S24 (20261119300000) and S25 (20261119400000). Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s25-db-batch-provisioning.md`: production is `strict` with every
earlier deferred migration recorded, so the new file can only be a deferred entry appended last.
Every generic path refuses that state, so the file has to be applied before the application release by an
operation that accepts exactly this one file: `s31-db-plan` / `s31-db-provision`.

## Gate (`scripts/check-s31-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including
  the S24 and S25 ones) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule
  check, `s31-dispatch-and-history-corrections-present`;
- the database is either in the state before S31 (no `dispatch_reevaluate_dependents`, and the four routines exist
  without the S31 marker) or fully provisioned and recorded (all five routines carry the marker
  `S31 corrective v1`, are security definer with the pinned search path and executable by the service role only).
  A partial or unrecorded application is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh
CI gate, like the other suffixes.

## Order

1. Release the switch on its own (this branch: the manifest has no S31 entry and the tree has no S31
   migration file) through the normal `contract_verified` flow. It installs the new operations.
2. Merge the S31 migration branch. From that main commit run
   `newme-deploy db-transition <sha> <run-id> s31-db-plan`, check that the plan lists only
   `20261120100000`, then `s31-db-provision`.
3. Release the application with `contract_verified` and the full required list.

The switch accepts the migration only as the LAST deferred entry. If another deferred migration merges before
S31 is provisioned, ship a new switch version.

## If the migration changes

`S31_EVENTS[0].sha256` and `S31_POSTURE_SQL` pin the reviewed file and predicate. Any change must
be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp` for the hash) and in
the checker, or the gate refuses.
