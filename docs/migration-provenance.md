# Migration provenance: staging versus production (P0-4)

## Scope and evidence boundary

This is a read-only provenance snapshot taken on 2026-07-28.  It compares:

- staging project `bfsiibofuzoglziltgyd` migration history (117 entries);
- production project `vfopmpxlhwzpxqegayew` migration history (98 entries);
- public-schema object-name metadata only (no row values or business data); and
- the current canonical staging Git tree at `22a108f59df42ccd922119b031a68d958352f864` (119 forward migration files).

All cloud evidence in this document was collected with read-only `SELECT` statements against migration metadata and PostgreSQL system catalogs; no cloud DDL, DML, business-row read, secret read, migration-history change, schema change, data change, or project-setting change occurred. A later disposable-local privilege diagnostic is explicitly separated below. The cloud staging history count of 117 is a point-in-time database snapshot and must not be conflated with the current 119-file Git chain. At the original history snapshot, `e8334817a4add5b720377def2a2c48ead5ac3ad0...agent/saas-staging-isolation` was `identical`; the canonical branch subsequently advanced to `22a108f59df42ccd922119b031a68d958352f864`. This document does not claim that later Git-only migrations have been applied to cloud staging.

`Source commit` is the last Git commit that introduced the file content in the canonical tree. `Blob` is the Git blob SHA for that exact file. A production history row has no source blob when Supabase history exposes only its version and name.

## Classification summary

| Category | Result | Forward repair decision |
| --- | --- | --- |
| Exact-version common history | 94 versions | No action. |
| Version-shifted but equivalent | workflow stages (byte-identical); quotation audit and task detail (history names embed the canonical file versions) | No action. |
| Same-version label conflict | `20260604000000` is `fix_schema` in production and `fix_lead_insert_rls` in staging; staging also has `20260604000004_fix_schema` | Definition-level comparison required before any forward migration. |
| Staging-only history | 19 post-`20260723110000` contract/security migrations, plus the four version-only rows listed below | Do not port to production under this staging-only unit. |
| Production-only history | legacy workflow version, two early-version aliases, and `l0_restore_runtime_atomic_contracts` | Three aliases are accounted for; L0 is definition-level **not equivalent** (see dedicated finding). |
| Data API privilege provenance | the 118-file replay exposed missing grants; canonical migration 119 encodes the bounded repair | Locally resolved and runner-proven; no cloud application or deployment claim. |

## Version-shifted and conflicting records

| Production history | Staging history / canonical file | Source commit | Blob | Semantic classification | Validation evidence | Forward repair |
| --- | --- | --- | --- | --- | --- | --- |
| `1780601210_workflow_stages` | `20260604192650_workflow_stages` (`supabase/migrations/20260604192650_workflow_stages.sql`) | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `d740ac3991884d2f7c59001998a8f50e21034018` | Equivalent, renumbered | The legacy Git path and canonical path resolve to the identical blob SHA. | No. |
| `20260722233049_20260723000000_quotation_status_audit_fields` | `20260723000000_quotation_status_audit_fields` | `82b11c40e6275a799a05994115b9d8e4499ccfbc` | `38f53e6558ae17e7254a43a2ac761cba44c412bb` | Equivalent version alias | Production history name embeds the canonical staging version and filename. | No. |
| `20260722233115_20260723090000_add_task_detail_fields` | `20260723090000_add_task_detail_fields` | `82b11c40e6275a799a05994115b9d8e4499ccfbc` | `7ca005df9d70711ad8f75fb9127bcff66b7724d9` | Equivalent version alias | Production history name embeds the canonical staging version and filename. | No. |
| `20260604000000_fix_schema` | Same staging version is `fix_lead_insert_rls`; the staging `fix_schema` file is `20260604000004_fix_schema` | `e939e44c72ad07188bd69d4c59ea5dc83b4287a8` | `4092b8ee11b6f830daa4df2cfeea776b89c2f4a6` | Conflict; not proven equivalent | History-only access does not expose the production SQL body, and no canonical Git blob exists for the production version/name pair. | No migration yet; require definition-level comparison first. |

## Staging-only applied records

These records are present in staging history but absent from production history by version. The three semantic aliases and the `fix_schema` version-only record are covered above; the remaining applied staging-only records are listed here.

| Version and file | Source commit | Blob | Semantic category | Validation evidence | Forward repair |
| --- | --- | --- | --- | --- | --- |
| `20260723110000_allow_active_admin_lead_assignee.sql` | `6408f2d56fbe6cb591dee0d1eea543cc1dda996c` | `71223f3dce3a9946bc5f9a75ef95d9b3e0520c94` | lead-assignee policy | Present in staging history and canonical tree; absent from production history. | No production port in this unit. |
| `20260723130000_lock_definer_boundaries.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `4734f7b912e2eee52dd82f55c8eed3b3acbd189f` | SECURITY DEFINER boundary | Same evidence. | No production port in this unit. |
| `20260723140000_atomic_lead_reassignment.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `c773b8a6be269967910f15fbcb44b45b8464f15c` | atomic reassignment RPC | Same evidence. | No production port in this unit. |
| `20260724100000_fix_transition_lead_stage_definer_search_path.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `cfc09c21d540e8f7caa5bcd95b8ecbec07ba0e33` | RPC search-path hardening | Same evidence. | No production port in this unit. |
| `20260724172009_sam61_finish_definer_boundary_cleanup.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `5a3b3757c87c848183fc04d40d7964f424bf33ba` | SAM-61 security cleanup | Same evidence. | No production port in this unit. |
| `20260724173351_sam62_allow_transfer_activity.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `eb1f600eac22d9b654a3331ca55719432655d7b2` | transfer activity type | Same evidence. | No production port in this unit. |
| `20260724173708_sam62_fix_reassignment_notification_uuid.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `f060777b7782670e8d2a5bd81087018e2988dc6e` | reassignment notification compatibility | Same evidence. | No production port in this unit. |
| `20260724174225_sam62_create_transfer_history.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `a55cec57e1532d7a1a37bfedf099f2549bd2a27b` | transfer-history baseline | Same evidence. | No production port in this unit. |
| `20260724181538_sam74_restore_application_schema_contract.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `13539cc2fb3dcc0b12bf07e97e2550f6ca819c20` | application schema contract | Same evidence; no SAM-74 test was rerun for this audit. | No production port in this unit. |
| `20260724181940_sam74_restore_circuit_diagrams_contract.sql` | `a56935ea8ffd826ea667e5522dabcfb542e9e9e2` | `ff636d27567730f5ddd88a068bf4741a7d384410` | circuit-diagrams contract | Same evidence; no SAM-74 test was rerun for this audit. | No production port in this unit. |
| `20260725235642_restrict_legacy_unassigned_leads_policy.sql` | `3b138dcc2ef622e963cdafab896096cfec69898c` | `57c7684c9ce23b31700989f6ba94194e9e4aaef4` | legacy lead policy | Same evidence. | No production port in this unit. |
| `20260726080621_add_profile_force_password_change.sql` | `bd14751a4ea36f7dc79e605e8663149deb32f5b1` | `e076bc052629d487b037f0c75276980f0109aaa8` | profile password-state contract | Same evidence. | No production port in this unit. |
| `20260726092618_harden_lead_mutation_idempotency_and_transfer_audit.sql` | `b684cab56cfbde781b3b1159b3c70061602fca23` | `fb96b9bfb225bd4a51dbdf3587090a405f1ec3d8` | idempotency and transfer audit | Same evidence. | No production port in this unit. |
| `20260726092851_revoke_remaining_transfer_history_write_privileges.sql` | `b684cab56cfbde781b3b1159b3c70061602fca23` | `3c39b418a59f958863e732a871a36e92e5d8f913` | transfer-history grant hardening | Same evidence. | No production port in this unit. |
| `20260726130911_harden_audit_session_table_grants.sql` | `46aae3be3926d706dec0fe7052c77ed95fce2343` | `bd446d3a0f7180bfa562ae895aa3f27243126fee` | audit-session grants | Same evidence. | No production port in this unit. |
| `20260726160522_harden_next_quote_no_authorization.sql` | `859113062bed790e51d922f94c039577d01a590b` | `ae272799427657cb110df80d4a1fed506a8bf044` | quote-number authorization | Same evidence. | No production port in this unit. |
| `20260726210812_add_security_definer_allowlist_gate_rpc.sql` | `6de713f0d94cb01f60a598285e958f4bfa70da5b` | `0302ffc6cdf03e8e18ecf03c8b9e98433b476f76` | SECURITY DEFINER allowlist gate | Same evidence. | No production port in this unit. |
| `20260726211121_version_security_definer_allowlist_gate_rpc.sql` | `5147b67fd953c35fd932745dbe9b73c8e7ba6b18` | `0f78f881c57ace731ef5b0d538bfd76becc681fe` | allowlist gate versioning | Same evidence. | No production port in this unit. |
| `20260726213846_harden_security_definer_allowlist_gate_rpc.sql` | `4b02c9274a70e56cc5697dff81d6ef02a3ac3184` | `5ed33b7dd08b473969dea71f70c498044d1bcac2` | allowlist gate hardening | Same evidence. | No production port in this unit. |

`20260727130000_add_activities_project_fk_index.sql` is in the canonical Git tree (source commit `7a64bb3cb517a9c446774c610c5e1d5cdfc31f24`, blob `4e501bf045a583b152c60b6a1bbfe2df4e15b4af`) but is not in the staging history snapshot. It is Git-only and is intentionally not counted as an applied staging difference.

`20260728081210_grant_sam26_runner_service_role_profiles_and_counts.sql` is also present in the current canonical source after the history snapshot. It was included in the separately recorded fresh local 118-migration replay, but is not claimed as applied to cloud staging and is not counted as an applied staging difference here.

`20260728121000_reproduce_data_api_table_grants.sql` is migration 119 in the current canonical source. It was proven by a fresh local 119/119 replay and the two-run SAM-51/SAM-66 loopback regression, but is not claimed as applied to cloud staging.

## Data API privilege provenance gap

A fresh disposable-local replay of all 118 forward migrations at `f4b9f7dae9448e73562bbbd904ce07b24f24fda9` completed, but its Data API table privileges are not equivalent to the shared staging project. Direct behavior and privilege metadata showed:

- local `authenticated` access to `public.profiles` failed with PostgreSQL `42501 permission denied for table profiles`, while shared staging reports `SELECT = true`;
- local `authenticated` privileges on `public.leads` reported `SELECT = false` and `INSERT = false`, while shared staging reports both as true; and
- local `service_role` `INSERT` on `public.leads` reported false, while shared staging reports true.

This is a forward-chain reproducibility gap in the Data API grant layer, not evidence that shared staging is unhealthy and not an authorization to reset it. The only diagnostic `GRANT` was temporary and limited to the disposable local stack; shared staging and production received no DDL or DML, and production was not queried for this finding. The bounded forward repair is `20260728121000_reproduce_data_api_table_grants.sql`, merged by PR #171 at canonical SHA `22a108f59df42ccd922119b031a68d958352f864`. A fresh 119/119 replay verified authenticated/service-role grants, preserved RLS on every authenticated CRUD table, kept anonymous lead access absent, and completed two marker-clean SAM-51/SAM-66 loopback runs. Browser and live-cloud UAT remain separate; shared staging was not mutated.

## Production-only L0 finding

`supabase_migrations.schema_migrations` is readable in production and exposes `version`, `statements`, `name`, `created_by`, `idempotency_key`, and `rollback`. The exact read-only row for `20260725072332_l0_restore_runtime_atomic_contracts` contains one transactional statement batch with these embedded source markers:

- `20260724173351_sam62_allow_transfer_activity.sql` — blob `eb1f600eac22d9b654a3331ca55719432655d7b2`;
- `20260723140000_atomic_lead_reassignment.sql` — blob `c773b8a6be269967910f15fbcb44b45b8464f15c`;
- `20260724100000_fix_transition_lead_stage_definer_search_path.sql` — blob `cfc09c21d540e8f7caa5bcd95b8ecbec07ba0e33`; and
- `20260724173708_sam62_fix_reassignment_notification_uuid.sql` — blob `f060777b7782670e8d2a5bd81087018e2988dc6e`.

The batch affects `activities.activities_type_check`; `lead_mutation_requests` and `lead_deletion_requests` (RLS/grants); the five atomic RPCs below; and their function grants. Both projects were queried read-only through `pg_get_functiondef`, `pg_constraint`, `pg_class`, `pg_policies`, and function/table ACL metadata. Hashes are `md5` of whitespace-normalized definitions; they are direct definition-level evidence rather than row-data evidence.

| Object(s) | Production hash | Staging hash | Result |
| --- | --- | --- | --- |
| `activities.activities_type_check` | `eb6cf12bd3bed8ca93e70933b4146ad1` | `eb6cf12bd3bed8ca93e70933b4146ad1` | Equal. |
| `public.lead_mutation_requests` and `public.lead_deletion_requests` RLS/grant metadata | `f6f94d426a2ff9776fb24f881880544f` | `f6f94d426a2ff9776fb24f881880544f` | Equal: RLS enabled; only `postgres` and `service_role` table ACLs. |
| `transition_lead_stage(uuid,text,text,text,uuid)` | `bbdb8a544b7e40dbac7c8873c2027cf5` | `bbdb8a544b7e40dbac7c8873c2027cf5` | Equal; same SECURITY DEFINER, search path, and function ACL metadata. |
| `delete_lead_atomic(uuid,uuid)` | `7cd9c65d41482e4ecc676d04576631a2` | `8988aaf4457c7e8f9070ac80b28f0436` | Different definition. |
| `reassign_lead_atomic(uuid,uuid,timestamptz,uuid,text)` | `1c44e50d31d2257e68f5f732f16305d7` | `405bdf5dfe24ad9e1e435636f7f719e9` | Different definition. |
| `record_lead_contact_atomic(uuid,text,timestamptz,text,text,text,uuid)` | `ebc7f1786aef2a3bbd4c6d3d5002c014` | `6c6c0b325a4dd1cbe603bc9f9a71b8a0` | Different definition. |
| `record_lead_note_atomic(uuid,text,uuid)` | `8889a8d5f23dfe94998224ca00c76ca1` | `854dd4af9fcd35ee7cb9b4a87d366a72` | Different definition. |
| Deny-all policies on both idempotency tables | `35a74a4b04fff662e38ef4210da792e7` (`Default deny all`, no explicit `WITH CHECK`) | `fd25b06033a9ab294a177dd40028aa6d` (`auto_deny_all`, explicit `WITH CHECK false`) | Different policy definition representation. |

**Conclusion: not equivalent at definition level.** Three contract objects match exactly, but four atomic RPC definitions and the deny-all policy definitions do not. This resolves the former provenance gap without requiring a speculative migration. No forward repair is authorized or applied in this staging-only audit; any remediation requires a separate, production-scoped decision using these hashes as the baseline.

SAM-74 was not rerun, and no database change was made.

## Schema-name metadata cross-check

The public-schema name lists are not identical. Staging includes `lead_assignment_state`; production includes `meta_tokens`, `marketing_campaigns`, and `audit_log_archived_20260615`. Canonical migrations explicitly create or conditionally handle these objects, so name-level metadata corroborates that the projects are not schema-identical. It does not prove column, view, function, policy, or grant equivalence and therefore does not change the L0 conclusion.

