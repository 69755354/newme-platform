# NewMe V4 staging Go/No-Go package

**Decision date:** 2026-08-06  
**Scope:** staging only — no production deployment, production database write, production secret read, or production configuration change.

## 1. Immutable release and code evidence

| Item | Verified evidence |
|---|---|
| Release SHA | `faa77d6512c5cf1aae6fedf064ff15e026894778` |
| Staging project | `bfsiibofuzoglziltgyd` |
| Same-head CI | [run 31070047624](https://github.com/69755354/newme-platform/actions/runs/31070047624), successful |
| Current release | `/opt/newme-staging/current` resolves to the immutable `faa77...` release and its manifest binds the same SHA |
| Migration evidence | `migrate-sam78` completed; root-owned 0600 evidence retained on the staging control host |
| V4 UAT evidence | `/var/lib/newme-staging-control/last-uat-v4-acceptance.json`, root-owned 0600 |

## 2. Executed staging acceptance

The exact release ran `newme-staging-control uat-v4 faa77...`.

The evidence report verifies:

- `ok=true`, scope `v4-staging-acceptance`, and release health HTTP 200;
- project binding is exactly `bfsiibofuzoglziltgyd`;
- `SAM-81`, `SAM-83`, `SAM-84`, and `SAM-86` each returned `pass`;
- cleanup returned `verified`;
- all 22 marker-cleanup classes returned zero residues, including organization, identity, membership, property, catalog, inventory/order, receipt, handoff, gateway-event, allocation, and reconciliation fixtures.

Post-UAT staging health remained HTTP 200. A read-only localhost production health probe remained HTTP 200; no production action was taken.

## 3. Capacity and rollback protection

Before any build, deploy, or UAT, capacity/current-release/active-container state was recorded. When free space fell below the 15 GiB control threshold, no UAT was started.

Two bounded cleanup actions were then performed and logged under `/var/lib/newme-staging-control/capacity/`:

1. one unreferenced pinned disposable PostgreSQL test image, recoverable by pulling its exact digest;
2. fourteen individually verified anonymous UAT-runner home volumes, each with no active container reference and recoverable by the next UAT run.

No `docker system prune`, broad deletion, scheduled cleanup, release-directory deletion, current release deletion, previous rollback release deletion, or production cleanup occurred.

Post-UAT free space was **16,384,987,136 bytes** with filesystem use at **73%**. The current immutable release remained `faa77...`; the direct predecessor recorded by deployment state is `b5c008958144cf415fbd132d6c5918cd9a51fccf`.

## 4. Decision

### Staging acceptance: GO (bounded)

The exact SHA is acceptable for the executed, synthetic, marker-clean V4 staging acceptance scope above.

### Commercial pilot and production: NO-GO

This package does **not** authorize commercial launch or production release. The following remain independently required:

- **SAM-77:** final source/ownership/governance decision;
- **SAM-78/79/80/82:** complete end-to-end tenant isolation, commercial-control and shared-service acceptance beyond the four executed V4 scenarios;
- **SAM-85:** authorized masked isolated-clone migration/import/reconciliation rehearsal and verified destruction;
- **SAM-87:** exact-SHA canary/deploy/observation/rollback rehearsal;
- **SAM-88:** authorized real-estate and retail design-partner cohort with provisioning, paid-seat/billing boundary, bounded support, backup/restore, exit, and repeatability evidence;
- Linear status synchronization after the Linear app connection is reauthenticated.

No missing item above may be inferred as complete from a green CI run, a successful synthetic staging UAT, or this document.

## 5. Production safety boundary

Production remains outside this package. Any future production proposal needs a separately approved exact SHA, independent Go/No-Go review, production-specific backup/rollback evidence, named operator/window, and a fresh capacity preflight.
