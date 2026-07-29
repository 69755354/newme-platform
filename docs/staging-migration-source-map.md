# Staging / Production Migration Source Map

## Scope and safety boundary

This record compares migration *version histories only*. It does not copy, export, reset, restore, or write either database.

- Staging project: `bfsiibofuzoglziltgyd`
- Production project: `vfopmpxlhwzpxqegayew` (read-only metadata)
- Authoritative staging source used for the review: `agent/saas-staging-isolation@0f831993baca84dbb77d8702ba0804556583dbfe`

## Verified history counts

At the recorded verification point:

| History | Count |
| --- | ---: |
| staging | 116 |
| production | 98 |
| common version identifiers | 94 |
| staging-only version identifiers | 22 |
| production-only version identifiers | 4 |

A shared version identifier is not proof of SQL equivalence. In particular, version `20260604000000` names `fix_lead_insert_rls` in staging and `fix_schema` in production, so it is explicitly excluded from any automatic equivalence claim.

## Staging-only versions

```text
20260604192650_workflow_stages
20260723000000_quotation_status_audit_fields
20260723090000_add_task_detail_fields
20260723110000_allow_active_admin_lead_assignee
20260723130000_lock_definer_boundaries
20260723140000_atomic_lead_reassignment
20260724100000_fix_transition_lead_stage_definer_search_path
20260724172009_sam61_finish_definer_boundary_cleanup
20260724173351_sam62_allow_transfer_activity
20260724173708_sam62_fix_reassignment_notification_uuid
20260724174225_sam62_create_transfer_history
20260724181538_sam74_restore_application_schema_contract
20260724181940_sam74_restore_circuit_diagrams_contract
20260725235642_restrict_legacy_unassigned_leads_policy
20260726080621_add_profile_force_password_change
20260726092618_harden_lead_mutation_idempotency_and_transfer_audit
20260726092851_revoke_remaining_transfer_history_write_privileges
20260726130911_harden_audit_session_table_grants
20260726160522_harden_next_quote_no_authorization
20260726210812_add_security_definer_allowlist_gate_rpc
20260726211121_version_security_definer_allowlist_gate_rpc
20260726213846_harden_security_definer_allowlist_gate_rpc
```

## Production-only versions

```text
1780601210_workflow_stages
20260722233049_20260723000000_quotation_status_audit_fields
20260722233115_20260723090000_add_task_detail_fields
20260725072332_l0_restore_runtime_atomic_contracts
```

The first three production-only names are candidates for manual semantic comparison with similarly named staging migrations. They are not mapped as equivalent by name alone.

## L0 status

`20260725072332_l0_restore_runtime_atomic_contracts` is not present in the recorded staging source tree or its inspected historical refs. The observable staging SAM-74 restoration migrations are:

- `20260724181538_sam74_restore_application_schema_contract`
- `20260724181940_sam74_restore_circuit_diagrams_contract`

Those files are not sufficient evidence that the production L0 migration is covered. Therefore:

1. no migration-history record may be added, deleted, or rewritten;
2. no equivalence claim may be made for the L0 migration;
3. the remaining required step is a SQL-level semantic comparison, followed by an isolated local replay only if a source correction is necessary.

## Repository-to-history drift

The recorded staging source tree contained 119 migration files while staging history contained 116 applied versions. The unapplied source files were:

```text
20260727130000_add_activities_project_fk_index.sql
20260728081210_grant_sam26_runner_service_role_profiles_and_counts.sql
20260728121000_reproduce_data_api_table_grants.sql
```

This is source/history drift to resolve through the staging release process; it is not authorization to alter production history.

## Decision

The map intentionally records unresolved items instead of normalizing counts. Any migration correction must first pass an isolated full replay and the staging verification gates. Production remains read-only.
