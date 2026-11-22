# Guarded S36 + S37 database-batch provisioning

Applies, as one batch and in this order, to a production database that already carries every earlier deferred migration,
including S33 (20261121100000):

1. `20261122200000_quotation_value_follows_quotations.sql` (OS fix S36): `leads.quotation_value` follows the quotations.
   Three SECURITY DEFINER routines (`sync_lead_quotation_value(uuid,numeric)`, `trg_sync_lead_quotation_value()`,
   `trg_lead_won_sync_quotation_value()`), three row triggers (`trg_quotation_sync_lead_value` on `quotations`,
   `trg_contract_sync_lead_value` on `contracts`, `trg_lead_won_sync_value` on `leads`) and a backfill that fills only leads
   with no amount yet.
2. `20261122300000_s37_new_lead_not_dormant.sql` (OS fix S37): the trigger routine `public.derive_lead_status()` replaced in
   place so a never-contacted lead created in the last 48 hours is `hot` instead of `dormant`.

Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s33-db-batch-provisioning.md`: production is `strict` with every earlier deferred migration recorded,
so the new files can only be deferred entries appended last. Every generic path refuses that state, so the files have to be
applied before the application release by an operation that accepts exactly these two files, in this order:
`s36-db-plan` / `s36-db-provision` (one switch for the batch; S37 has no operation of its own).

## Gate (`scripts/check-s36-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including the S33 one) are unchanged;
- the only change is two deferred entries (these exact SQL hashes, S36 then S37, last in the list) plus two rule checks,
  `s36-quotation-value-follows-quotations-present` then `s37-new-lead-not-dormant`, byte for byte as the manifest declares;
- the database is in one of exactly two states:
  - **before both**: none of the three S36 routines and none of the three S36 triggers exist, and exactly one
    `public.derive_lead_status()` exists whose body does not carry the `48 hours` marker (the production body);
  - **fully provisioned and recorded**: both versions are in `supabase_migrations.schema_migrations`; the three S36 routines
    are SECURITY DEFINER with `search_path=pg_catalog, public, pg_temp` and not executable by `anon` / `authenticated`; the
    three triggers sit on their exact tables, call their exact routines, are not internal and are enabled (`O`);
    `derive_lead_status()` is SECURITY DEFINER with the pinned search_path and carries the `48 hours` marker.

  A half state is refused: S36 applied but not S37 (recorded or not), S37 applied before S36, either one applied but not
  recorded, a record without the objects, or `derive_lead_status()` missing altogether.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh CI gate, like the other
suffixes.

## Order

Same two releases as S31 (#563 then #564), S32 (#576 then #580) and S33:

1. Release the switch on its own (the manifest has no S36 / S37 entry and the tree has no S36 / S37 migration file) through
   the normal `contract_verified` flow, no database operation.
2. Merge the S37 branch (`fix/os-s37-numbers`, which already carries the S36 branch: both migration files, both manifest
   entries and rule checks, the database tests and the application changes). From that main commit run
   `newme-deploy db-transition <sha> <run-id> s36-db-plan`, check that the plan lists exactly `20261122200000` then
   `20261122300000`, then `s36-db-provision`. (`tools/release_lite.sh ... --dbop s36` runs exactly this pair.)
3. Release the application with `contract_verified` and the full required list.

The switch accepts the two migrations only as the LAST deferred entries. If another deferred migration merges before the
batch is provisioned, ship a new switch version.

## If a migration changes

`S36_EVENTS[i].sha256`, `S36_POSTURE` (the manifest predicates) and `S36_PRESENT` / `S36_PRIOR` pin the reviewed files and
the state checks. Any change must be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp` for the
hash) and in the checker, or the gate refuses.
