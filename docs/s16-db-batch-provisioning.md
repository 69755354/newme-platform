# Guarded S16 database-batch provisioning

Applies `20261112100000_notification_constraints_and_lead_owner_contracts.sql` and
`20261112100100_notification_warning_type.sql` (OS fix S16) to a production database that already carries every earlier deferred
migration, including `20261104110000_role_least_privilege.sql`. Nothing here has been
applied to production.

## What the migration does

- `notifications_type_check` also allows `contract_created`, `reminder` and `warning` (the
  no-answer alert; the second file restates `warning` so a database that recorded the earlier
  version of the first file, such as staging, can be brought up to date);
  `notifications_related_type_check` also allows `task` and `digest`. Every old value is
  kept; a guard in the file refuses to run if production currently allows a value the new
  list lacks.
- `convert_quotation_to_contract(uuid, jsonb)` makes the lead's owner (`leads.assigned_to`)
  the contract owner (`contracts.sales_id`); a lead without an owner falls back to the
  quotation's creator and then to the acting user. Existing contracts are untouched.

## Why a dedicated switch (same reasoning as `docs/s2-role-provisioning.md`)

Production is `strict` with all earlier deferred migrations recorded. The migration is a
ninth deferred entry (it must sort after the eighth, so it cannot be `required_for_app`,
and `db-phase-push.mjs` refuses the expand phase once the contract phase is recorded).
Every generic path refuses that state: `contract_verified` wants all deferred migrations
present (so the application release cannot go first), `applied_verified` wants them all
absent, and `contract-apply` / `contract-verify` want the candidate to be the live release.
So the migration has to be applied before the application release, by an operation that
accepts exactly this one file.

## Gate

`s16-db-plan` / `s16-db-provision` follow the additive-suffix pattern
(`meta-crm-*`, `s2-roles-*`). `scripts/check-s16-db-batch-provisioning.mjs` refuses unless:

- the live database is in `strict` mode and both releases declare `strict`;
- the required prefix and every prior manifest declaration are unchanged;
- the only change is two deferred entries (these exact SQL hashes, last in the list) plus two
  posture predicates (`s16-notification-constraints-and-lead-owner-present`,
  `s16-notification-warning-type-present`);
- the database is either untouched (neither constraint lists a new value and the routine
  still takes the owner from the quotation) or fully provisioned and recorded. A partial
  or unrecorded application is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a
fresh CI gate, exactly as for the other suffixes.

## Order

1. Release the switch on its own: a main commit whose manifest has no S16 entry and whose
   tree has no S16 migration file (the first commit of this branch is exactly that), through
   the normal `contract_verified` flow. It installs the new `newme-deploy` operations.
2. Merge the rest. From that main commit run
   `newme-deploy db-transition <sha> <run-id> s16-db-plan`, check that the plan lists only
   `20261112100000`, then `s16-db-provision`, then check the posture.
3. Release the application with `contract_verified` and the full required list.

The switch accepts the migration only as the LAST deferred entry. If another deferred
migration merges first, extend the pinned suffix in a new switch version.

## If the migration changes

`S16_EVENT.sha256` and `S16_POSTURE_SQL` pin the reviewed file and predicate. A change to
either must be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp`
for the hash) and in the checker, or the gate refuses.
