# Guarded S43 database provisioning

Applies `20261124300000_s43_leave_cover.sql` (OS fix S43, leave cover) to a production database that already carries every
earlier deferred migration, including S39 (`20261123100000`).

The file is additive only:

| object | what |
|---|---|
| `profiles.cover_user_id`, `cover_start`, `cover_end` | three nullable columns |
| `profiles_cover_not_self`, `profiles_cover_dates` | two check constraints |
| `idx_profiles_cover_user` | one partial index |
| `set_leave_cover(uuid,uuid,date,date)` | new definer routine, admin / boss only, `authenticated` and `service_role` yes, `anon` no |
| `trg_profiles_cover_admin_only()` + trigger `profiles_cover_admin_only` | new definer routine and BEFORE UPDATE OF trigger: a signed-in non-admin/boss cannot write the three columns directly |

No existing table data, policy or routine changes. Nothing here has been applied to production. The application reads the
columns only behind its own fallback (Postgres `42703` falls back to the query without them) and routes notifications to a
cover only when `NEWME_LEAVE_COVER_ENABLED=true` (default off).

## Why a dedicated switch

Same reasoning as `docs/s39-db-batch-provisioning.md`: production is `strict` with every earlier deferred migration
recorded, so the new file can only be a deferred entry appended last, and every generic path refuses that state. The file
has to be applied by an operation that accepts exactly this file: `s43-db-plan` / `s43-db-provision`.

## Gate (`scripts/check-s43-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check (S39 included) are unchanged;
- the only change is one deferred entry (this exact SQL hash, last in the list) plus one rule check, `s43-leave-cover`, byte
  for byte as the manifest on the S43 branch declares it;
- the database is in one of exactly two states:
  - **before**: none of the S43 objects exists (no cover column, no constraint, no index, neither routine, no trigger);
  - **provisioned and recorded**: `20261124300000` is in `supabase_migrations.schema_migrations`; the three columns exist
    nullable with the right types, both constraints and the index exist, `set_leave_cover` and the trigger routine exist
    once each (definer, pinned `search_path`, marker `leave_cover_not_allowed`, the grants above) and the enabled
    BEFORE UPDATE ROW trigger is bound to that routine.

  The file runs in one transaction, so there is no resumable prefix. Every half state is refused explicitly (some objects
  present and some absent, applied but unrecorded, recorded but absent).

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh CI gate.

## Order

1. Release this switch on its own through the lite lane, no database operation. The manifest then has no S43 entry and the
   tree has no S43 migration file.
2. Merge the S43 branch (`fix/os-s43-roles`, #613), then release it with the database operation:
   `release_lite.sh <logdir> "<title>" 613 --dbop s43` (backup, then `s43-db-plan`, which must list exactly `20261124300000`,
   then `s43-db-provision`, then the application release).

The switch accepts the migration only as the LAST deferred entry. If another deferred migration merges first, ship a new
switch version.

## If the migration changes

`S43_EVENTS[0].sha256`, `S43_POSTURE_SQL` (the manifest predicate) and the present / prior queries pin the reviewed file and
the state checks. Any change must be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp`) and in the
checker, or the gate refuses.
