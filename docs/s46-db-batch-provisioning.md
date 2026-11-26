# Guarded S46 database provisioning

Applies three reviewed files, in this order, to a production database that already carries every earlier deferred
migration, including S43 (`20261124300000`):

| file | what |
|---|---|
| `20261126000100_s46_leads_delete_admin_boss_only.sql` | drops policy `policy_leads_delete_sales` on `leads`; replaces `delete_lead_atomic(uuid,uuid)` in place so only admin and boss can delete a lead (a salesperson gets `FORBIDDEN_LEAD_DELETE`); grants re-stated (`authenticated`, `service_role` yes, `anon` no) |
| `20261126000200_s46_milestone_order_ignores_reopened.sql` | `check_milestone_order()` replaced in place: a reopened milestone (`completed_at` null) no longer counts as the latest step |
| `20261126000300_s46_quotation_value_currency_and_lock.sql` | `sync_lead_quotation_value(uuid,numeric)` and `trg_sync_lead_quotation_value()` replaced in place (old quotation currency checked before clearing, foreign-currency contracts kept out of the AED lead value, lead row locked before recomputing, a lock error only logs a warning); trigger `trg_contract_sync_lead_value` recreated to also watch `currency` |

No table, column or data is written. Nothing here has been applied to production.

## Why a dedicated switch

Same reasoning as `docs/s36-db-batch-provisioning.md` (multi-file) and `docs/s43-db-batch-provisioning.md`: production is
`strict` with every earlier deferred migration recorded, so the files can only be deferred entries appended last, and every
generic path refuses that state. They are applied by an operation that accepts exactly these files:
`s46-db-plan` / `s46-db-provision`.

## Gate (`scripts/check-s46-db-batch-provisioning.mjs`)

Refuses unless:

- the live database is `strict` and both releases declare `strict`;
- the required prefix, every prior manifest declaration and every prior rule check are unchanged;
- the only change is three deferred entries (these exact SQL hashes, last, in this order) plus three rule checks
  (`s46-leads-delete-admin-boss-only`, `s46-milestone-order-ignores-reopened`, `s46-quotation-value-currency-and-lock`),
  byte for byte as the manifest on the S46 branch declares them;
- per file, the database is in the **before** state (production bodies: the sales policy and the `'sales'` branch of
  `delete_lead_atomic` present; `check_milestone_order` without `completed_at IS NOT NULL`; the quotation routine without the
  row lock and the contract trigger without `currency`) or **provisioned and recorded** (the version is in
  `supabase_migrations.schema_migrations` and the new objects are present);
- a failure after an earlier file committed leaves a resumable prefix (earlier files recorded and present, the rest absent and
  unrecorded): plan / provision then apply only the rest. Any other combination (applied but unrecorded, recorded but absent,
  a later file recorded before an earlier one, a mismatched object) is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main SHA and a fresh CI gate.

## Order

1. Release this switch on its own through the lite lane, no database operation. The manifest then has no S46 entries and the
   tree has no S46 migration file.
2. Merge the S46 branch (`fix/os-s46-migrations`, #617), then release it with the database operation:
   `release_lite.sh <logdir> "<title>" 617 --dbop s46` (backup, then `s46-db-plan`, which must list exactly the three S46
   versions, then `s46-db-provision`, then the application release; the application part changes who sees the delete button).

The switch accepts the files only as the LAST deferred entries. If another deferred migration merges first, ship a new switch
version.

## If a migration changes

`S46_EVENTS[*].sha256`, `S46_POSTURE` (the manifest predicates) and the present / prior queries pin the reviewed files and the
state checks. Any change must be mirrored in the manifest (`node scripts/check-release-manifest.mjs --stamp`) and in the
checker, or the gate refuses.
