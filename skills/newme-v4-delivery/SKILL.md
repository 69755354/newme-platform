---
name: newme-v4-delivery
description: Execute or review NewMe V4 SaaS work across planning, tenant isolation, migrations, Git and CI, staging release, real-estate and retail slices, operations, Linear evidence and commercial release. Use when a task mentions NewMe V4, SaaS commercialization, tenant or organization isolation, V4 Linear work packages, migrations, exact-head CI, staging UAT, production-data rehearsal, vertical packs, release readiness or external audit.
---

# NewMe V4 Delivery

## Load the authoritative context

Read these files before planning or changing V4 behavior:

1. `docs/v4/V4_SAAS_PRD.md`
2. `docs/v4/V4_REQUIREMENTS_TRACEABILITY.md`
3. `docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md`
4. `docs/v4/V4_EXECUTION_BACKLOG.md`

Read `docs/v4/V4_EXTERNAL_AUDIT_INDEX.md` for an audit request. Read only the active Linear issue, code, migration and release evidence required by the work package.

## Select the workflow

- Planning, issue definition, traceability or closeout: read `references/work-package-and-traceability.md`.
- Tenant ownership, RLS, database change, rollback or production-data rehearsal: read `references/tenant-data-and-migrations.md`.
- Branch, PR, CI, evidence binding or publication: read `references/git-ci-and-evidence.md`.
- Build, deploy, staging UAT, cleanup, rollback, incident or disk operation: read `references/staging-release-and-operations.md`.
- Real-estate or retail implementation/review: read `references/vertical-acceptance.md` plus the tenant/data reference.

Do not load unrelated references.

## Execute one acceptance package

1. Read the live Linear issue and exact Git base once.
2. Create a work-package manifest from `assets/work-package.template.json`.
3. State Linear/V4 IDs, exact base, allowed paths, outcome, non-goals, data/security impact, validation, risk and executable rollback.
4. Run `node skills/newme-v4-delivery/scripts/validate-work-package.mjs <manifest>` before implementation.
5. Implement one independently acceptable business outcome. Keep schema, service, UI, tests and operations together when separation creates an unsafe partial state.
6. Run focused checks, applicable disposable database gates and exact-head CI. Run a production build for a release candidate.
7. Require exact-release staging UAT and residue-zero cleanup for environment claims.
8. Publish one bounded PR using `assets/pr-body.template.md`.
9. Update Linear using `assets/linear-evidence-comment.template.md` only after immutable evidence exists. A green PR is not Done when staging, restore or pilot evidence remains.

## Evidence discipline

Classify material claims as `verified-current`, `source-claim`, `target`, `validated-staging`, `validated-production`, `deferred` or `rejected`. Bind repository behavior to an exact Git SHA and executed evidence. Bind environment behavior to an exact release manifest and environment ID.

Treat the Axon archive and its tenantless schema as domain input, not reusable SaaS implementation. Treat International City acceptance scenarios as targets, not executed results.

## Required order and safety

Follow M0→M8 unless an approved ADR changes it: evidence/architecture; tenant isolation; commercial control plane; shared services; real estate; retail; agents/integrations; operations/migration rehearsal; pilot.

For tenant-owned behavior verify immutable organization ownership, active profile and membership, capability, entitlement/quota/lifecycle, database/RLS/API/RPC/worker/storage/import/export boundaries, idempotency, immutable audit, cleanup and rollback. UI hiding, a branch/location field, a single role or a client flag is not authorization.

Share platform primitives, not vertical state machines. Keep real-estate listing/viewing/offer/deal/commission separate from retail SKU/inventory/quotation/order/procurement/delivery/COD.

Route agents and integrations through versioned server-side commands. Inject actor and tenant context server-side. Require approval for L3 and prohibit L4 authorization changes, cross-tenant access, audit deletion, raw database writes, forged financial facts and hidden customer sends.

## Stop conditions

Stop without expanding scope when:

- the source/base SHA or acceptance contract changes;
- ownership, license or deployment authority is missing;
- the same command, connection or unchanged gate fails twice;
- a migration cannot prove forward/rollback compatibility;
- environment SHA, project, health, permission or cleanup residue mismatches;
- unrelated worktree changes overlap the package.

Classify infrastructure failure as infrastructure evidence, never code failure or green evidence. Do not rerun an unchanged audit without a changed source, SHA, environment or contract.

## Deterministic checks

- `node skills/newme-v4-delivery/scripts/validate-governance.mjs`
- `node skills/newme-v4-delivery/scripts/validate-work-package.mjs <manifest.json>`
- `node skills/newme-v4-delivery/scripts/validate-release-evidence.mjs <evidence.json>`
- `node --test skills/newme-v4-delivery/scripts/validate-scripts.test.mjs`

Use the templates under `assets/`; do not rewrite recurring evidence formats from scratch.

## Production boundary

Never load raw production data into shared staging. Use only an approved isolated ephemeral clone with clone-only credentials, outbound integrations disabled, masking before application access, bounded retention, aggregate evidence and verified destruction.

Do not access or change production unless a separate authorization names the exact production target, candidate SHA, window, owners and rollback.
