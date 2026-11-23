# Guarded S39 database provisioning

Applies `20261123100000_s39_stage_rules_relaxed.sql` (OS fix S39) to a production database that already carries every
earlier deferred migration, including the S36 + S37 batch (20261122200000, 20261122300000).

The file replaces seven existing routines in place (`CREATE OR REPLACE`, same signatures, same security modes, pinned
`search_path`, same grants) so that a stage or milestone may be skipped going forward (never backwards), leaving `new` needs
one complete contact record and no quality rating:

| routine | mode | grants pinned by the file |
|---|---|---|
| `trg_check_stage_sequence()` | invoker | – |
| `trg_check_first_contact_gate()` | invoker | – |
| `trg_enforce_first_contact_milestone()` | definer | – |
| `recomplete_lead_milestone(uuid,text,text)` | definer | `authenticated` yes, `anon` no |
| `check_milestone_order()` | definer | – |
| `sync_advance_lead_stage_from_sheet(uuid,text,text)` | definer | `service_role` only |
| `transition_lead_stage(uuid,text,text,text,uuid)` | definer | `authenticated` yes, `anon` no |

No table, column, policy, trigger or data change. Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s33-db-batch-provisioning.md` and `docs/s36-db-batch-provisioning.md`: production is `strict`
with every earlier deferred migration recorded, so the new file can only be a deferred entry appended last. Every generic
path refuses that state, so the file has to be applied before the application release by an operation that accepts exactly
this file: `s39-db-plan` / `s39-db-provision`.

## Gate (`scripts/check-s39-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (S36 + S37 included) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule check,
  `s39-stage-rules-relaxed`, byte for byte as the manifest on the S39 branch declares it;
- the database is in one of exactly two states, judged over all seven routines:
  - **before**: each of the seven routines exists exactly once and carries its current production body: the old marker
    present (`Stage must advance sequentially`, `NEW.quality`, `lead_quality`, `Previous milestone must be completed
    first`, `Cannot skip:`, `v_lead.quality`, `v_allowed_next_stage`) and the S39 marker absent;
  - **provisioned and recorded**: `20261123100000` is in `supabase_migrations.schema_migrations`; each routine exists
    exactly once with the S39 marker and without the old one, `search_path=pg_catalog, public, pg_temp`, the security mode
    the file declares (definer for five, invoker for the two stage triggers) and, for `transition_lead_stage`,
    `recomplete_lead_milestone` and `sync_advance_lead_stage_from_sheet`, exactly the grants in the table above.

  The file runs in one transaction (`scripts/db-phase-push.mjs`), so a partial apply should not exist. The gate still refuses
  every half state explicitly: some routines new and some old, a routine missing or duplicated, the new bodies present but
  the version unrecorded, the version recorded but the bodies still old. There is no resumable prefix: one file, one
  transaction, either it is all there and recorded or none of it is.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh CI gate, like the other
suffixes.

## Order

Same two releases as S33 and S36:

1. Release the switch on its own through the lite lane, no database operation:
   `release_lite.sh <logdir> "<title>" <switch PR>`. The manifest then has no S39 entry and the tree has no S39 migration
   file.
2. Merge the S39 branch (`fix/os-s39-sales`, #604: the migration file, the manifest entry and rule check, the database test
   and the application changes), then release it through the lite lane with the database operation:
   `release_lite.sh <logdir> "<title>" 604 --dbop s39`. That runs the database backup, then
   `newme-deploy db-transition <sha> <run-id> s39-db-plan` (the plan must list exactly `20261123100000`), then
   `s39-db-provision`, then the application release.

The switch accepts the migration only as the LAST deferred entry. If another deferred migration merges before it is
provisioned, ship a new switch version.

## If the migration changes

`S39_EVENTS[0].sha256`, `S39_POSTURE` (the manifest predicate) and `S39_ROUTINES` (the markers, modes and grants behind
`S39_PRESENT` / `S39_PRIOR`) pin the reviewed file and the state checks. Any change must be mirrored in the manifest
(`node scripts/check-release-manifest.mjs --stamp` for the hash) and in the checker, or the gate refuses.
