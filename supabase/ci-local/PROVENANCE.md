# Local database contract gate provenance

This directory is a CI-only, local-only Supabase project. It must never be
linked, pushed, or used as a production migration source. The canonical legacy
chain remains in `../../migrations`; none of those existing files are changed.

The canonical chain cannot be replayed without rewriting already-applied
history: official Supabase CLI 2.113.0 reaches PostgreSQL `42P01` because
`1780601210_workflow_stages.sql` references `public.leads` before
`20260601000000_init.sql`. Diagnostic reordering then exposes independent
`42703` (`leads.rep_name`) and `42601` (`ALTER TABLE TABLE`) failures. This
baseline therefore makes the narrowed task-followup contract executable while
remaining fail-closed about full-schema equivalence.

## Immutable sources

| Contract | Source commit/path | Git blob |
|---|---|---|
| initial `profiles` / `leads` shape | `6762d706cb6a9fde469fc994244a3898296ff552:supabase/migrations/20260601000000_init.sql` | `4cbac950899405cade64efeecdb4e111452fc637` |
| original `tasks` shape | `c8a7bf83e5c:supabase/migrations/20260623020000_crm_v3_new_tables.sql` | `76ab226c40d0c44e0c63adf7f94b90ccc65589b1` |
| current task RLS predicates | `6762d706cb6a9fde469fc994244a3898296ff552:supabase/migrations/20260630200000_rls_policy_remediation.sql` | `c0f82e4efdc50e8015fe5d5da58f9611052cf321` |
| deployed follow-up guard body and behavior | `9623e6ca759:docs/final-v3-test-report-20260603.md` | `720eb923c79e661c2283bf011687bb08be11d9b5` |
| deployed trigger name inventory | `729c31a9d96^:docs/context-pack/04-db-schema-facts.md` | `d4d3864fd442ac5d5079f5244578c3ed1e781b74` |
| restored task-to-lead migration | `d8278c4c218:supabase/migrations/20260702000002_p0_10_sync_lead_from_tasks.sql` | `9be49177c86170c834dc4017ae2e05f5f1f3c4c4` |
| restored lead-to-task migration | `d8278c4c218:supabase/migrations/20260702000003_p0_10_sync_task_from_lead.sql` | `0d6cf5a3e9e183feefc0a43415f6fe2b266336a4` |
| current function search-path hardening | `6762d706cb6a9fde469fc994244a3898296ff552:supabase/migrations/20260805202917_hotfix_public_definer_acl_search_path.sql` | `ed6fbb9dd762d3c6ef5bfe5ac57b44930fb2c7bd` |

## Accepted gate asset hashes

These Git blob hashes are also checked by `verify-provenance.mjs`; changing an
accepted baseline, seed, config, hardening slice, or pgTAP contract fails closed.

| Gate asset | Git blob |
|---|---|
| `supabase/config.toml` | `23e1c341f14c1866a9340db72e67665bf413c4e9` |
| `supabase/migrations/00000000000000_ci_task_followup_baseline.sql` | `4ccb3ea9e6d2d21c39139b26752e89178c3e1f8d` |
| `supabase/migrations/20260805202917_ci_task_followup_function_hardening.sql` | `fc59555e654e25f10659101519657f0d94de5707` |
| `supabase/seed.sql` | `067597064b38b4af967dadb655a7960de1fe3bb8` |
| `supabase/tests/database/task_followup_rls.sql` | `0cd2b6ca2717f8a92318a28f6b43a7fe846ec051` |

## Forward-only rule

The two `20260702...` files are byte-for-byte restorations of deleted Git
migrations; their production versions are unchanged. Future database changes
must be appended as new forward migrations. Never edit this baseline or either
restored migration after acceptance; regenerate a new versioned CI baseline
with a new source manifest instead.
