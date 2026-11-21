# Guarded S33 database-batch provisioning

Applies `20261121100000_sync_advance_lead_stage_from_sheet.sql` (OS fix S33: the service-role routine
`public.sync_advance_lead_stage_from_sheet(uuid, text, text)`) to a production database that already carries every
earlier deferred migration, including S32 (20261120200000). Nothing here has been applied to production.

## Why this migration

When the sales sheet says "Opportunity stage = Quotation reported", the Drive sync stores `quotation_value` and queues the
Meta quote event, but the OS stage did not move: the audited routine `transition_lead_stage` needs a signed-in actor, and a
direct write of `leads.stage` is stopped by the stage-sequence and first-contact triggers. The new routine is the narrow
service-role equivalent: forward only, one step at a time, never past `quotation_submitted`, never from or to won / lost,
never an archived lead, one `business_events` `stage_change` row per step (user NULL, `event_data.actor = system:drive_sync`).
It refuses (as a reason, not an error) a lead that fails the first-contact rule or has no next action / follow-up date.

## Why a dedicated switch

Same reasoning as `docs/s32-db-batch-provisioning.md`: production is `strict` with every earlier deferred migration
recorded, so the new file can only be a deferred entry appended last. Every generic path refuses that state, so the file has
to be applied before the application release by an operation that accepts exactly this one file:
`s33-db-plan` / `s33-db-provision`.

## Gate (`scripts/check-s33-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (including the S32 one) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule check,
  `s33-sync-advance-lead-stage-from-sheet-present`;
- the database is either in the state before S33 (the routine does not exist) or fully provisioned and recorded (exactly one
  routine with that signature: SECURITY DEFINER, `search_path=pg_catalog, public, pg_temp`, the system actor marker in its
  body, executable by `service_role` only). A half state or an unrecorded application is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh CI gate, like the other
suffixes.

## Order

Same two releases as S31 (#563 then #564) and S32 (#576 then #580):

1. Release the switch on its own (the manifest has no S33 entry and the tree has no S33 migration file) through the normal
   `contract_verified` flow.
2. Merge the S33 migration branch (migration file, manifest entry and rule check, database test, Drive sync wiring). From that
   main commit run `newme-deploy db-transition <sha> <run-id> s33-db-plan`, check that the plan lists only
   `20261121100000`, then `s33-db-provision`.
3. Release the application with `contract_verified` and the full required list. The Drive sync calls the routine only when it
   exists; until it is provisioned the call answers "routine missing" and the sync behaves as before.

The switch accepts the migration only as the LAST deferred entry. If another deferred migration merges before S33 is
provisioned, ship a new switch version.

## If the migration changes

`S33_EVENTS[0].sha256` and `S33_POSTURE_SQL` pin the reviewed file and predicate. Any change must be mirrored in the manifest
(`node scripts/check-release-manifest.mjs --stamp` for the hash) and in the checker, or the gate refuses.
