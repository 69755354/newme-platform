# SAM-78 gap inventory against PR #255

Verified baseline: `agent/saas-staging-isolation` at
`f2bd6576a0723fea58a13926baef2dedcc37da8e` (tree
`eab6472540d9b47e5ff2eb7a59788e3c98929ba3`). PR #255 merged the capability
catalog, organization-scoped product routes/RPCs, nullable product ownership,
generated types, and a disposable database gate. The PR body explicitly left
storage, export, workers, and the complete tenant lifecycle for later work.

| V4 contract | Exact gap after #255 | Closure in this PR |
|---|---|---|
| V4-PF-001 | No independently approved suspend/recover RPC; no `export_only` state; support sessions were not revoked by suspension. | Pending approval state machine binds requester and approver to separate authenticated sessions, freezes canonical payload/hash with TTL and idempotency, and permits only the service-only consumer to dispatch provision/suspend/recover/exit from the locked approval row. Suspension revokes support sessions; lifecycle and approval evidence is immutable. |
| V4-PF-002 | Provisioning activated members immediately; no invite placeholder/acceptance path; authorization helpers still depended on global profile roles in several routes. | Platform-approved provisioning wrapper, capability-gated invite, user acceptance, active profile/membership/role/capability checks. |
| V4-PF-003 | 21 tenant tables lacked direct organization ownership; products remained nullable with global SKU uniqueness; import used a service client; worker scanned all tenants; object keys were not organization-prefixed or registered; export reported four legacy unscoped tables. | Direct NOT NULL FK ownership, parent-equality FKs, selected-organization restrictive RLS with action-specific capabilities, immutable organization IDs, tenant-local product SKU, authenticated atomic import RPC, active-tenant worker RPC, organization-prefixed storage registry, provider-verified COS upload/HEAD/finalize, and complete export v2. |
| V4-PF-004 | Support access auditing existed only on lead resolution; expired sessions were denied by time but not transitioned/audited; audit rows remained mutable to privileged clients. | Expiry RPC with one audit row per session, suspension revocation, storage/import/export audits, immutable `audit_events`, `audit_logs`, and lifecycle requests. |
| V4-G1 | #255 tested product/capability isolation only. | Dynamic two-organization coverage includes selected-header isolation for a multi-member user, global-sales/specialist direct Lead INSERT/UPDATE/DELETE denial, organization-ID reassignment rejection, direct-ID/search/export/worker/storage/support negatives, sealed-file role downgrade, registry/finalize denial, and platform support/auditor approval denial. |
| V4-G2 | #255 database apply/rollback covered its own foundation migration only. | Versioned closure migration/rollback, generated type contract, and separately green disposable apply, fixture, rollback, fail-closed, and cleanup phases. The final combined full gate remains intentionally unexecuted pending controller acceptance. |

## P1 security closure added after the initial inventory

| Review finding | Verified closure |
|---|---|
| Multi-organization requests could act on rows in another active membership. | All 21 restrictive policies and the Lead action policies require `organization_id = requested_organization_id()` as well as the action capability; organization reassignment raises SQLSTATE `23514`. |
| Global profile sales role could bypass organization capabilities through old permissive Lead policies. | Restrictive Lead policies require `leads.read` or `leads.write`; the disposable fixture proves the existing organization-B specialist cannot directly insert, update, or delete a Lead. |
| Sealed contract files were replaceable by operations or sales. | Registration and finalization both require `storage.files.seal` for sealed versions; only owner/admin receive it. Draft sales writes require the contract's `sales_id`; owner/admin/operations use `storage.files.write_any`. |
| An authenticated client could forge an available storage registry row. | Authenticated direct INSERT/UPDATE/DELETE and finalize execution are revoked. Registration remains a bounded RPC; server-only finalization requires provider-verified size, type, metadata MD5, and ETag, with optional CRC64. |
| COS confirmation trusted request metadata and used a production-directory script path. | Confirmation accepts only `file_id`, reads stored expectations, performs a fixed-host HEAD, and invokes the service-only finalize RPC. Upload, HEAD, and download resolve one real repo-relative script inside the current release; the old `/home/ubuntu/newme-platform` storage path is rejected by tests. |
| Platform APIs accepted a claimed approver UUID, and all active platform staff could operate. | APIs accept no actor/approver/payload on approval consumption. Request/approve RPCs bind `auth.uid()`, require distinct owner/ops staff roles, and reject support/auditor. Execution re-reads the locked frozen approval row and is service-only. |
| Rollback could erase tenant ownership from new-organization data. | Its first destructive gate enumerates the exact 21 tables and reports the first table containing any non-legacy organization row. The disposable fixture exercises the guard once per table; rollback also refuses any new lifecycle, storage, or approval records. |

The implementation does not reuse Axon code, does not add billing or vertical
workflow state machines, and contains no production deployment action.

## Disposable database failure ledger

| Attempt | Exact marker | Root cause | Disposition before another run |
|---|---|---|---|
| 1 | `sam23_postgres_start_failed: permission denied while trying to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | Sandbox could not open the local Docker API. | Re-run only with the approved disposable-database command permission. |
| 2 | `relation "public.ad_spend" does not exist` at closure migration line 34 | The pre-existing SAM-23 harness intentionally omitted tables outside its commercial scope. | Added an explicit SAM-78 prelude that creates the missing legacy contracts only inside the disposable database. |
| 3 | `operator does not exist: text = uuid` at closure migration line 105 | The new prelude correctly exposed `notifications.related_id` as UUID while the backfill compared it directly with text. | Changed every notification ownership comparison to canonical text-on-text comparison. |
| 4 | `column reference "table_name" is ambiguous` at closure migration line 179 | A PL/pgSQL loop variable collided with `information_schema.columns.table_name`. | Removed the catalog-dependent branch and changed the verification loop to an unambiguous dynamic null assertion. |
| 5 | `column reference "actor_user_id" is ambiguous` in `v4_accept_organization_membership` | The acceptance replay predicate used the same unqualified name for a PL/pgSQL variable and `audit_events.actor_user_id`. | Classified with attempt 4; halted reruns and required a complete local-variable/column-name collision audit before the next database execution. |
| 6 | `column "customer_name" of relation "leads" does not exist` during the fixture import | The SAM-23 base harness has a deliberately reduced `leads` schema; the SAM-78 prelude had created missing tables but had not expanded the existing harness table to the import/worker contract. | Halted the fixture phase and added every lead column read or written by the SAM-78 import and worker RPCs to the disposable-only prelude. |
| 7 | `column "import_fingerprint" of relation "leads" does not exist` in `v4_import_leads_for_organization` | Same root cause as attempt 6: the first static harness expansion missed the SAM-22 import-idempotency field and its tenant-local unique conflict target. | No immediate rerun. Compared the full import insert contract with the base harness and added both `import_fingerprint` and `leads_organization_import_fingerprint_unique`, matching the skipped production SAM-22 migration. |
| 8 | `column "file_metadata" does not exist` in `v4_confirm_tenant_file` | Same reduced-harness root-cause class as attempts 6-7, now in the storage confirmation path: production `contracts` has `file_metadata`, while the SAM-23 harness omits it. | No immediate rerun. Expanded the audit from the fixture's direct INSERTs to every column read or written by each invoked SAM-78 RPC, then added the missing disposable-only contract field. |
| 9 | `lead_child_organization_context_mismatch` at the organization-A no-answer setup INSERT | The fixture changed from authenticated organization B to `service_role` without clearing session-local JWT and request headers. `auth.uid()` therefore remained the shared member while the header still selected organization B, and the existing child-integrity trigger correctly rejected the organization-A row. | No immediate rerun. Every authenticated-to-service fixture transition now resets both end-user JWT and organization request headers before privileged setup or lifecycle work. |
| 10 | `active organization worker did not mark lead` after three no-answer rows | The import RPC created a normal note and all four follow-up rows shared the transaction timestamp used by the worker's `ORDER BY created_at`. The unordered tie made `LIMIT 3` capable of selecting the normal note. | No immediate rerun. The worker now orders by business `contact_time`, then `created_at`, then `id`; the fixture explicitly makes the import note older than the three no-answer attempts and includes the returned worker payload in any future failure. |
| 11 | `function public.start_support_session_atomic(unknown, unknown, uuid, unknown, unknown, jsonb, timestamp with time zone, unknown) does not exist` | The production migration chain includes the canonical SAM-14 atomic support-session RPC, but the reduced SAM-23 disposable harness created only its SAM-20 tables and never applied that function migration. | Database execution paused per controller instruction. The gate now copies and applies the exact existing `20260730225759_sam14_platform_support_session_lifecycle.sql` prerequisite; no replacement function or guessed signature was added. |
| 12 | `v4_tenant_lifecycle_closure_rollback_not_fail_closed` | With `newme.environment` missing, `current_setting('newme.environment', true)` returned NULL; SQL three-valued logic made the original `IF ... NOT IN (...)` condition NULL, so the rollback continued instead of rejecting the call. | Database execution paused. The guard now normalizes missing/null to an empty string with `COALESCE`; the gate first proves the disposable connection has a NULL environment and then requires the staging/test-only exception. |

Verified staged disposable phase evidence, run separately after the last database
change:

- `SAM78_GATE_PHASE=apply`: exit 0 with `{"status":"passed","phase":"apply","environment":"disposable_test_container"}`.
- `SAM78_GATE_PHASE=fixture`: exit 0 with `{"status":"passed","phase":"fixture","cleanup":"verified","environment":"disposable_test_container"}`.
- `SAM78_GATE_PHASE=rollback`: exit 0 with `{"status":"passed","phase":"rollback","rollback_fail_closed":"verified","cleanup":"verified","environment":"disposable_test_container"}`.

Transport note: the first fixture re-verification launch after attempt 6 was
terminated by the command runner at its five-second limit with exit 124 and no
stdout/stderr. A subsequent read-only check found no SAM-78 disposable
container, so this is recorded as an indeterminate execution-transport failure,
not a database result. All later database evidence above came from synchronous,
phase-specific invocations; no background runner supplied an acceptance result.

Attempts 6-8 are explicitly classified as one repeated reduced-harness
root-cause class; they are not counted as independent database defects. No
static test result is treated as a substitute for the required real apply,
two-organization verification, rollback, and cleanup gate.

## Generated database type evidence

The official local Supabase CLI `2.110.0` generated `public` types from the full
migration set in a repository-external disposable project. The repository stamp
flow produced migration fingerprint
`3d2cb57d92c18b093cc4c7f8d981e407feca48b43c4a26c7c3b227826c910327`, and
`npm run check:database-types` accepts the generated source. The temporary type
project was stopped without backup and removed; it was never connected to a
cloud project.
