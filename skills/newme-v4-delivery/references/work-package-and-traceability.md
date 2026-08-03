# Work Package and Traceability

## Work-package contract

Define one independently acceptable business outcome. Record:

- Linear ID and V4 requirement IDs;
- exact base SHA and allowed paths/contracts;
- outcome and explicit non-goals;
- data, tenant, authorization, migration and operations impact;
- positive, negative, idempotency, cleanup and rollback evidence;
- risk and executable rollback.

Do not split by file count. Do not create parallel PRs in one dependency chain. Do not create duplicate Linear issues for existing evidence.

## Evidence states

Use only: `verified-current`, `source-claim`, `target`, `validated-staging`, `validated-production`, `deferred`, `rejected`.

Repository plans are targets. Merged code is verified-current only for that exact SHA. A successful staging run is validated-staging only for its exact manifest/environment. Production requires separate exact production evidence.

## Linear and Git roles

- Linear owns current status, dependency, owner, milestone, due date and acceptance state.
- Git owns immutable PRD, ADR, code, migration, test and release evidence.
- Every PR links one Linear ID and applicable V4 IDs.
- Every Linear closeout links immutable PR/commit/CI/release evidence and names remaining exclusions.
- Correct status/evidence conflicts before using project progress as a delivery metric.

## Review scope

Review only release-blocking correctness: traceability, tenancy, authorization, data integrity, migration/rollback, idempotency, cleanup, telemetry and evidence binding. Return the affected contract, impact, minimum correction and retest. Exclude stylistic comments and already-green unchanged evidence.

## Multi-agent rule

Delegate only independent lanes: product/evidence, platform/data, one vertical, operations/reviewer. The coordinator owns the integrated acceptance contract. Never ask two agents to modify the same dependency chain or interpret the same evidence independently without a reconciliation owner.

## Closeout decision

Close an issue only when every acceptance item in its current Linear description has directly linked evidence. If scope is intentionally reduced, update the issue before closing it. A PR merge, CI success or local test alone is not a substitute for required staging, recovery, migration or pilot evidence.
