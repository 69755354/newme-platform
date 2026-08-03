# NewMe V4 Current Execution Backlog

Status: Live execution snapshot, not a release claim
Snapshot date: 2026-08-03 (Asia/Shanghai)
Linear project: [NewMe V4 SaaS — Real Estate and Retail](https://linear.app/samnewme/project/newme-v4-saas-real-estate-and-retail-6400aa7c0e9d)

## 1. Snapshot contract

Linear is the live status and dependency source. Git is the immutable plan, code and evidence source. This file records the directly queried state at the snapshot date so an auditor can reproduce the execution decision; it does not replace later Linear state.

Git evidence at this snapshot:

- planning baseline: PR [#254](https://github.com/69755354/newme-platform/pull/254), merge `a7c456ab2eeae9502da80abc351f7008791e5769`;
- first tenant/capability foundation slice: PR [#255](https://github.com/69755354/newme-platform/pull/255), head `631509a13ffa053347a937387171eb05819905a8`, merge/canonical `f2bd6576a0723fea58a13926baef2dedcc37da8e`;
- exact-head full CI for #255: run [30768558258](https://github.com/69755354/newme-platform/actions/runs/30768558258), Repository validation job `91551547421`, success.

## 2. Status correction required before execution

The live Linear project reports one Done, one In Progress and ten Backlog issues. SAM-78 is marked Done, while its own evidence comment says it remains incomplete and explicitly lists storage/export/worker isolation, the full provisioning-to-recovery chain, SKU uniqueness contraction and staging deployment as not delivered. Therefore M1's displayed 100% progress is not accepted as delivery evidence.

Required correction:

1. restore SAM-78 to In Progress until its complete acceptance matrix is executed;
2. resolve SAM-77's source/ownership decision, or record Axon source reuse as deferred and remove the contradictory blocker on a completed child;
3. make M7 close dependencies consistent with the required M0→M8 delivery order, while still allowing non-closing preparation work to start early.

## 3. Current delivery work packages

| Order | Linear | Live state | Delivery outcome still required | Direct predecessors |
|---|---|---|---|---|
| P0 | [SAM-77](https://linear.app/samnewme/issue/SAM-77/v4-01-lock-requirements-sources-and-architecture) | In Progress | Approve the repository PRD/ADR/source register; bind the private Axon repository to an exact commit/tree and ownership/license evidence, or formally defer code reuse. | None |
| P0 | [SAM-78](https://linear.app/samnewme/issue/SAM-78/v4-02-deliver-tenant-identity-and-isolation-foundation) | Done, evidence-conflicted | Finish all tenant-owned foreign keys and isolation across RLS/API/RPC/worker/storage/import/export; complete support access, immutable audit, lifecycle suspension/recovery, two-organization staging UAT and residue-zero cleanup. | SAM-77 governance decision |
| P1 | [SAM-79](https://linear.app/samnewme/issue/SAM-79/v4-03-deliver-commercial-control-plane) | Backlog | Deliver plans, paid seats, entitlements, quotas, usage, invoice references, trial/grace/read-only/suspension/recovery/closure and platform administration. | SAM-78 |
| P1 | [SAM-80](https://linear.app/samnewme/issue/SAM-80/v4-04-deliver-shared-workflow-and-operational-services) | Backlog | Deliver tenant-safe files, tasks, approvals, timeline, notifications, outbox/retry/dead-letter, imports, exports, idempotency and reporting primitives. | SAM-78 |
| P2 | [SAM-81](https://linear.app/samnewme/issue/SAM-81/v4-05-deliver-real-estate-commercial-slice) | Backlog | Deliver landlord/listing→lead/match→viewing→offer→deal→commission/payroll as one exact-release commercial slice. | SAM-79, SAM-80 |
| P2 | [SAM-82](https://linear.app/samnewme/issue/SAM-82/v4-06-deliver-retail-catalog-inventory-and-pricing) | Backlog | Deliver retail topology, SKU resolver, inventory ledger, transfer/stocktake, deterministic pricing/VAT/discount and quotation. | SAM-79, SAM-80 |
| P3 | [SAM-83](https://linear.app/samnewme/issue/SAM-83/v4-07-deliver-retail-orders-procurement-delivery-and-finance) | Backlog | Deliver order, procurement, receipt, delivery, COD, finance confirmation, refund and reconciliation with actor separation. | SAM-82 |
| P4 | [SAM-84](https://linear.app/samnewme/issue/SAM-84/v4-08-deliver-controlled-agent-and-integration-gateway) | Backlog | Deliver server-injected actor/tenant commands, L0–L4 policy, approvals, signed events, replay protection and controlled adapters. | SAM-81, SAM-83 |
| P5 | [SAM-85](https://linear.app/samnewme/issue/SAM-85/v4-09-rehearse-migration-import-and-reconciliation) | Backlog | Rehearse masked isolated clone migration, scoped backfill, exception handling, reconciliation and verified destruction. | Stable target schema; final close after vertical data models |
| P5 | [SAM-86](https://linear.app/samnewme/issue/SAM-86/v4-10-prove-sre-security-backup-and-performance) | Backlog | Prove provenance, tenant-aware observability, alert ownership, backup/restore RPO/RTO, load behavior and noisy-neighbor controls. | SAM-80; final close on release candidate |
| P6 | [SAM-87](https://linear.app/samnewme/issue/SAM-87/v4-11-rehearse-canary-deployment-and-rollback) | Backlog | Execute exact-SHA migration→build→deploy→canary→UAT→observation→rollback rehearsal. | SAM-85, SAM-86 |
| P7 | [SAM-88](https://linear.app/samnewme/issue/SAM-88/v4-12-run-design-partner-pilot-and-commercial-decision) | Backlog | Complete real-estate and retail design-partner onboarding, support, billing boundary, backup and exit; then build repeatability evidence across 5–10 organizations. | SAM-81, SAM-83, SAM-87 |

## 4. Execution topology

```text
SAM-77 → SAM-78
             ├─ SAM-79 ─┬─ SAM-81 ───────────┐
             └─ SAM-80 ─┤                    │
                         └─ SAM-82 → SAM-83 ──┤
                                             ├─ SAM-84
SAM-85 preparation ──────────────────────────┤
SAM-86 preparation ──────────────────────────┤
                                             └─ SAM-87 → SAM-88
```

Allowed parallel work:

- SAM-79 and SAM-80 after the corrected SAM-78 gate;
- SAM-81 and SAM-82 after SAM-79/SAM-80 contracts stabilize;
- SAM-85 tooling and SAM-86 infrastructure may start early, but neither may close on an unstable target release.

## 5. Throughput rules

1. Keep one active integration PR per dependency chain.
2. Size work by independently acceptable business outcome, not file count.
3. Keep schema, service, UI, tests, deployment and rollback together when separating them would create an unsafe partial state.
4. Reuse immutable evidence; rerun only when source, SHA, environment or acceptance contract changes.
5. Require exact-head CI. Quick-validation build skips are not full release evidence.
6. Require exact-release staging UAT and residue-zero cleanup for environment claims.
7. Update Linear only after the acceptance evidence required by that issue exists; a green PR alone is not Done.

## 6. Next execution unit

Complete the SAM-77 governance correction and reusable delivery Skill Pack in one PR. After it merges, restore SAM-78 to evidence-consistent In Progress and complete its remaining end-to-end tenant lifecycle and staging acceptance before starting SAM-79 or SAM-80 implementation.
