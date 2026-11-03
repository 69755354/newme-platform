# Guarded S2 role-rule provisioning

Applies `20261104110000_role_least_privilege.sql` (OS fix S2, PR #502) to a
production database that already carries every earlier deferred migration.
Nothing here has been applied to production.

## Why a dedicated switch

Production runs in `strict` mode with all seven earlier deferred migrations
recorded. The S2 version adds an eighth deferred migration, and every existing
release path refuses that state: `contract_verified` wants all deferred
migrations present, `applied_verified` wants them all absent, `contract-apply`
wants the candidate to be the live release, and the CRM switch only accepts a
live release without CRM. The gate programs are installed with the release, so
the switch has to ship in a release that does not itself add the migration.

## Gate

`s2-roles-plan` / `s2-roles-provision` follow the additive-suffix pattern
(`meta-ads-*`, `meta-capi-*`, `meta-crm-*`). `scripts/check-s2-role-provisioning.mjs`
refuses unless:

- the live database is in `strict` mode and both releases declare `strict`;
- the required prefix and every prior manifest declaration are unchanged;
- the only change is one deferred entry (this exact SQL hash) plus one posture
  predicate (`s2-role-least-privilege-present`), so the live release is the
  candidate minus this one migration;
- the database is either untouched (unrecorded; the stage RPC still has the old
  whitelist, the old company-wide designer/finance rules are still there and no
  S2 object exists) or fully provisioned and recorded. A partial or unrecorded
  application is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main
SHA and a fresh CI gate, exactly as for CRM.

## Order

1. Merge and release THIS switch on its own (a release whose manifest has no new
   deferred migration; normal `contract_verified` flow). It becomes the live
   release.
2. Merge the S2 version (PR #502). From that main commit run
   `newme-deploy db-transition <sha> <run-id> s2-roles-plan`, check that the plan
   lists only `20261104110000`, then `s2-roles-provision`, then `contract-verify`
   (the new predicate must read true).
3. Release the S2 version with `contract_verified`; then role smoke tests.

The switch accepts the S2 migration only as the LAST deferred entry. If another
deferred migration (for example S3) merges before step 2, either provision S2
first or extend the pinned suffix in a new switch version.

## If the S2 migration changes

`S2_EVENT.sha256` and `S2_POSTURE_SQL` pin the reviewed file and predicate. A
change to either in PR #502 must be mirrored here, or the gate refuses.
