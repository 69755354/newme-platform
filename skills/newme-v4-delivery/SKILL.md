---
name: newme-v4-delivery
description: Execute or review NewMe V4 SaaS work for the shared platform, real-estate pack, retail pack, migrations, Linear planning, Git delivery, staging validation, operations, and commercial release. Use when a task mentions NewMe V4, SaaS commercialization, tenant isolation, real estate, retail, vertical packs, production-data rehearsal, V4 Linear work packages, or V4 release readiness.
---

# NewMe V4 Delivery

## Required context

Read these repository documents before planning or changing V4 behavior:

1. `docs/v4/V4_SAAS_PRD.md`
2. `docs/v4/V4_REQUIREMENTS_TRACEABILITY.md`
3. `docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md`

Read only the additional code, migration, Linear issue and release evidence needed by the active work package.

## Evidence discipline

Classify every material claim as one of:

- `verified-current`
- `source-claim`
- `target`
- `validated-staging`
- `validated-production`
- `deferred`
- `rejected`

Never promote a source claim because a document calls it production-ready. Bind implemented behavior to an exact Git SHA and executed evidence. Bind environment behavior to an exact release manifest and environment identifier.

The Axon archive and its tenantless Prisma snapshot are domain inputs, not a reusable SaaS implementation. The International City acceptance tables are target scenarios, not executed results.

## Dependency order

Work in this order unless an approved ADR changes it:

1. M0 evidence, ownership, architecture and traceability
2. M1 tenant identity, membership, capability and isolation
3. M2 plan, seat, entitlement and lifecycle control plane
4. M3 shared workflow and operational services
5. M4 real-estate commercial slice
6. M5 retail commercial slice
7. M6 controlled agents and integrations
8. M7 operations, migration and release rehearsal
9. M8 pilot and commercial decision

Tenant identity and isolation always precede billing and vertical expansion.

## Define one work package

Before implementation, state in at most six lines:

- Linear ID and V4 requirement IDs
- exact base SHA and allowed paths/contracts
- business outcome and explicit non-goals
- data/security/migration impact
- validation and exact-release evidence
- risk and executable rollback

One work package is an independently acceptable business outcome. Keep its schema, service, UI, tests and operations changes together when separating them would create unsafe partial states. Do not split work by file count.

## Implement the shared platform safely

For tenant-owned behavior verify:

- immutable organization ownership and composite integrity
- active profile and membership
- capability and record ownership where required
- industry entitlement, quota and lifecycle state
- database/RLS, API/RPC, worker/cron, storage, import and export boundaries
- idempotency and immutable audit
- exact cleanup and rollback

Do not treat UI hiding, branch/location, a single role field or a client feature flag as tenant authorization.

## Keep vertical semantics separate

Share organization, capability, approval, audit, files, tasks, notifications, idempotency, integrations and commercial control-plane primitives.

Keep real-estate listing/viewing/property-offer/deal/commission/payroll separate from retail SKU/inventory/quotation/order/procurement/delivery/COD. Similar names do not justify one state machine or table.

## Control agents and integrations

Route all agent actions through versioned domain commands. Inject actor and tenant context server-side. Apply risk levels L0–L4. Require approval for L3. Prohibit L4 actions: authorization changes, cross-tenant access, audit deletion, raw database writes, forged financial/sign-off facts and hidden customer sends.

Keep external adapters disabled until credentials, consent, policy, sandbox behavior, retries, reconciliation and audit pass.

## Validate

Run only relevant local checks before full CI. When applicable require:

1. focused domain and negative tests
2. disposable database apply/verify/rollback
3. generated type and migration-history checks
4. tenant/RLS/API/worker/storage negatives
5. type, lint and repository tests
6. production build for full release candidates
7. exact-release staging UAT and residue-zero cleanup
8. migration/canary/rollback/restore rehearsal for release work

Infrastructure failures are infrastructure evidence, not code failures or green evidence. Do not repeat an unchanged audit or gate without a changed source, SHA, environment or acceptance contract.

## Use multi-agent work without fragmentation

Delegate only independent lanes:

- product/evidence
- platform/data
- one vertical slice
- operations/reviewer

The coordinating agent owns the integrated result. Cross-review only release-blocking correctness: traceability, tenancy, authorization, data integrity, migration/rollback, idempotency, cleanup, telemetry and evidence binding.

Do not create parallel PRs in one dependency chain. Do not create one-file chores when several files implement one behavior. Do not create duplicate Linear issues for prior evidence; link existing SAM items.

## Publish and trace

Linear is the status/dependency/owner source. Git is the immutable product/code/evidence source.

Every PR must include:

- Linear ID and V4 requirement IDs
- base/head and scope
- positive/negative/idempotency/cleanup behavior
- data, security, migration and operations impact
- validation evidence
- deployment order, risk and rollback

Every Linear issue links its PR and lists the acceptance evidence required to close. A green PR does not close an issue that still requires staging, recovery or pilot evidence.

## Rehearse production data safely

Never load raw production data into shared staging. Use an approved isolated ephemeral clone with clone-only credentials, outbound integrations disabled, masking before application access, bounded retention, aggregate evidence and verified destruction.

## Release decision

Use gates G0–G8 from the PRD. Claim only the verticals whose tenant, change, commercial, security, operations, migration and pilot gates pass. Production remains unchanged unless a separate authorization names exact production target, candidate SHA, window, owners and rollback.
