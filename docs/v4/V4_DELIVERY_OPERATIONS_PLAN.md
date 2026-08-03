# NewMe V4 Delivery and Operations Plan

Status: Repository execution baseline; implementation in progress
Date: 2026-08-03
Applies to: V4 planning, implementation, staging, pilot and production release
Current execution snapshot: `V4_EXECUTION_BACKLOG.md`
External audit manifest: `V4_EXTERNAL_AUDIT_INDEX.md`

## 1. Delivery model

V4 is delivered as one platform with two independently releasable vertical packs. Work is organized around end-to-end acceptance slices, not layers or one-file chores.

The dependency order is mandatory:

1. evidence and architecture lock;
2. tenant identity, membership and isolation;
3. commercial control plane;
4. shared workflow/operations services;
5. real-estate commercial slice;
6. retail commercial slice;
7. controlled agents and external adapters;
8. operational/migration rehearsal;
9. pilot and commercial release decision.

Observability, security, backup, migration and rollback are acceptance dimensions within every milestone, not a final hardening phase.

## 2. Architecture decisions

### ADR-V4-001: extend NewMe; do not merge application stacks

Use NewMe's organization, CI, staging and release foundations as the implementation base. Port domain semantics and test cases from the Axon and International City packages. Do not copy the Axon Express/Prisma runtime or its schema into production.

Reason: the supplied Axon schema is tenantless and its package self-reports unversioned schema changes, local uploads, no committed CI/tests and no off-host recovery proof.

### ADR-V4-002: shared platform core, separate vertical state machines

Shared: organization, membership, capability, plan, seat, entitlement, usage, support session, audit, approval, task, notification, file, integration, idempotency and outbox.

Separate:

- real estate: listing, landlord, viewing, property offer, deal, commission, payroll and publish readiness;
- retail: SKU, inventory movement, price/discount, quotation, order, procurement, delivery, COD and reconciliation.

The words customer, offer, payment or task do not justify a shared business table when lifecycle or accounting semantics differ.

### ADR-V4-003: server-side industry entitlement

`organizations.industry_key` and entitlements control vertical availability. Enforcement covers UI, API/RPC, database policies, worker/cron, import/export, object storage and integration actions. A client feature flag is not authorization.

### ADR-V4-004: deterministic tool gateway

Agents and integrations use versioned domain commands through a policy gateway. The server injects actor and tenant context; L3 actions require approval; L4 actions are prohibited. No agent has a service-role database bypass.

### ADR-V4-005: expand by verified slices

M1 is proved by organization onboarding → invitation/seat → authorized business write → audit → suspension/recovery. Real estate then proves the first vertical commercial slice; retail validates that the shared core generalizes without weakening isolation.

## 3. Work hierarchy and Linear contract

Create one Linear project: **NewMe V4 SaaS — Real Estate and Retail**.

Use nine milestones matching M0–M8 in the PRD. Create a bounded set of twelve delivery issues:

| Work package | Milestone | Scope | Exit evidence |
|---|---|---|---|
| V4-01 Requirements, source and architecture lock | M0 | sources, licensing, glossary, ADRs, traceability | approved PRD + exact source register |
| V4-02 Tenant identity and isolation foundation | M1 | org/membership/capability/tenant FK/RLS/support/audit | disposable DB + two-org negative matrix |
| V4-03 Commercial control plane | M2 | plan/seat/entitlement/usage/invoice/dunning/lifecycle | state-machine + reconciliation |
| V4-04 Shared operational services | M3 | files/tasks/approval/outbox/notification/import/export | tenant-safe E2E + failure recovery |
| V4-05 Real-estate domain and commercial slice | M4 | party/listing/lead/viewing/offer/deal/commission | full role/positive/negative/cleanup matrix |
| V4-06 Retail catalog, inventory and pricing | M5 | topology/catalog/SKU/ledger/transfer/pricing/quote | movement and price reconciliation |
| V4-07 Retail order, procurement, delivery and finance | M5 | order/PR/PO/receiving/delivery/COD/AR/refund | actor separation + finance reconciliation |
| V4-08 Agent and integration control plane | M6 | gateway/risk/approval/events/adapters | spoof/replay/prohibited-action tests |
| V4-09 Migration, import and reconciliation | M7 | legacy mapping/masked clone/backfill/exceptions | counts, hashes and destruction evidence |
| V4-10 SRE, security, backup and performance | M1–M7 | telemetry/alerts/restore/load/advisors/secrets | measured SLO/RPO/RTO and security gates |
| V4-11 Release, canary and rollback | M7 | artifact provenance/migration order/canary/rollback | complete rehearsal on exact SHA |
| V4-12 Pilot cohort and commercial launch | M8 | design partners/support/billing/exit | per-organization evidence register |

Rules:

- Linear owns status, dependency, owner, target and acceptance state.
- Git owns immutable PRD, ADR, code, migration, test and release evidence.
- A Linear issue links its implementing PR; a PR links its V4 IDs and Linear issue.
- Existing SAM-18/19/21/22/23/27/52/63/75 are related foundation evidence, not duplicate V4 tasks.
- A work package may contain several code PRs, but it has one acceptance matrix and one close decision.

## 4. Git and PR workflow

### Branches

- `main`: production release source only.
- `agent/saas-staging-isolation`: current staging integration source during transition.
- `codex/v4-*`: short-lived implementation or planning branches.

The team must decide and document when V4 receives a dedicated integration branch or when staging becomes the release candidate branch. Until that decision, no PR targets production `main` by implication.

### PR contract

Every implementation PR contains:

1. Linear ID and V4 requirement IDs;
2. exact base/head and bounded change list;
3. behavior and explicit non-goals;
4. schema/data/API/RLS/worker/storage impact;
5. positive, negative, idempotency and cleanup tests;
6. deployment/migration order;
7. risk and executable rollback;
8. same-head CI and, when required, exact-release staging UAT.

PRs are sized by acceptance unit, not file count. Do not split schema, service, UI and tests into separate PRs if none is independently safe or useful. Do split independent verticals, migrations or operational controls when they have distinct rollback and evidence.

### Required CI

- toolchain and dependency provenance;
- secret/artifact boundary;
- migration/static database contracts;
- disposable database apply/verify/rollback;
- tenant/RLS negative tests;
- type, lint and repository tests;
- production build for full candidates;
- release hygiene and worktree cleanliness.

An infrastructure failure is recorded as infrastructure failure and fixed at the runner. It must not be relabelled as green code evidence.

## 5. Test strategy

### Test pyramid

- domain unit tests: state machines, pricing, inventory, entitlements and policy decisions;
- contract tests: route, RPC, migration, event and adapter shapes;
- disposable database tests: schema, RLS, triggers, grants, rollback and generated types;
- integration tests: object storage, queues, retries and external sandboxes;
- browser tests: critical role-based workflows and accessibility;
- exact-release staging UAT: two organizations per vertical plus cleanup;
- release rehearsal: migration, canary, rollback, restore and load.

### Common negative matrix

Every tenant-owned write considers:

- unauthenticated;
- inactive profile or membership;
- wrong role/capability;
- wrong organization/direct ID;
- disabled vertical/entitlement/quota;
- invalid lifecycle transition;
- duplicate idempotency key;
- malformed/oversized/prototype-polluted input where applicable;
- worker/cron/integration context spoofing;
- cleanup or rollback failure.

### Evidence format

Machine evidence contains release SHA, project/environment ID, actor class without credentials, marker/run ID, checks, object IDs or hashes, cleanup counts and completion time. Secrets, raw tokens and customer PII are prohibited.

## 6. Database and migration operations

1. A schema change has versioned forward migration, verification and rollback or an explicitly approved restore-only boundary.
2. CI applies the complete migration chain to a disposable supported PostgreSQL image.
3. Staging reads migration history first, applies only the exact missing versions in order, and verifies schema/grants/policies/types.
4. Application/database compatibility is documented for deploy and rollback.
5. Large backfills use bounded batches, progress checkpoints, lock/statement timeouts and reconciliation.
6. Global unique identifiers becoming organization-scoped require conflict inventory before constraint changes.
7. No `db push`, ad-hoc production DDL or history-only repair is an accepted release method.

## 7. Production-data rehearsal

Copying production data into the existing shared staging environment is rejected. A safer rehearsal is allowed only as a separately approved, isolated clone:

1. create a dedicated ephemeral project/account/network with no route to production writes;
2. approve scope, owner, expiry, access list and data-processing purpose;
3. restore an encrypted snapshot using platform-owned recovery capability;
4. pseudonymize or tokenize names, phones, email, addresses, documents and free text before application testers gain access;
5. disable outbound email, messaging, webhook, portal and payment integrations;
6. use clone-only secrets and deny production credentials;
7. run migrations, reconciliation, application/UAT, performance sampling and rollback rehearsal;
8. retain only aggregate evidence and approved exception records;
9. destroy database, storage, credentials, logs and temporary exports on expiry;
10. record destruction and access-revocation evidence.

If masking cannot preserve a needed invariant, use a smaller restricted subset with named approval. Raw production data never becomes a general developer fixture.

## 8. Environments and release path

### Development

Local Supabase/application environments use synthetic fixtures. They prove fast correctness, not release readiness.

### CI

Ephemeral databases and isolated build artifacts. No shared staging mutation from PR quick checks.

### Staging

One exact canonical SHA, immutable artifact, release manifest, health/readiness and explicit migration history. UAT actions are serialized and marker-scoped.

### Clone rehearsal

Separate from staging, short-lived and data-restricted as defined in section 7.

### Production

Production remains unchanged until a separately approved release window. The release candidate must have:

- exact Git SHA and green full CI;
- artifact/manifest/runtime provenance;
- migration plan and compatibility decision;
- staging acceptance for the claimed verticals;
- canary and health/readiness plan;
- direct predecessor and tested rollback;
- backup/restore evidence;
- named release, database, security and business owners.

## 9. Deployment and rollback sequence

1. freeze candidate SHA and source branch;
2. verify full CI and supply-chain evidence;
3. capture environment health, current release, migration history and backup capability;
4. build immutable artifact once;
5. apply approved compatible migrations or execute the documented coordinated window;
6. deploy candidate to isolated port/release;
7. run health/readiness and smoke tests;
8. atomically switch release pointer;
9. execute serialized vertical UAT and observe telemetry;
10. close or roll back according to predetermined thresholds.

Rollback never means restoring leaked credentials or guessing schema changes. If database compatibility blocks app rollback, run the approved reverse migration/restore first or remain on the new application release while recovering.

## 10. Operational readiness

Before pilot:

- define service and tenant-level SLOs and alert owners;
- monitor health, readiness, latency, errors, queues, database saturation, storage, tenant usage and financial reconciliation;
- provide incident severity, communication, escalation and post-incident review;
- verify support-session controls and customer audit access;
- verify PITR/backup metadata and isolated restore;
- implement release retention and safe disk cleanup that protects active release pointers;
- test credential rotation without restoring compromised credentials;
- document customer export, suspension, closure and legal-retention behavior.

## 11. Multi-agent engineering model

Use agents only for independent, bounded lanes that can be reconciled against one shared acceptance contract.

### Recommended lane set

1. **Product/evidence lane:** source ledger, conflicts, PRD and traceability.
2. **Platform/data lane:** tenancy, authorization, migration, commercial control plane.
3. **Vertical lane:** one vertical acceptance slice at a time.
4. **Operations/reviewer lane:** CI, security, release, DR and independent challenge.

With four total agent slots, the coordinating agent remains accountable for integration; it does not delegate interpretation of execution rules.

### Cross-review rule

Before implementation or publication:

- platform/data reviews vertical assumptions and data ownership;
- vertical reviews whether platform abstractions serve a real workflow;
- operations reviews migration, observability, rollback and evidence;
- product/evidence checks every claim against a source/state.

Reviewers return contradictions and release-blocking findings, not stylistic commentary.

### Anti-fragmentation rules

- one Linear work package per independently acceptable business outcome;
- one source/evidence read, reused by all later work;
- no second audit unless the source, SHA, environment or acceptance contract changed;
- no PR containing only a test plan for code that cannot yet be safely implemented, except an approved architecture/decision PR;
- no one-file task churn when files share one behavior and rollback;
- at most one active integration PR per dependency chain;
- every blocked item names one exact missing authority, evidence or environment condition;
- completed evidence is referenced, not copied into new issues.

## 12. Reusable prompt contracts

### Planning prompt

```text
Objective: produce one acceptance-ready work package for <Linear ID> and <V4 IDs>.
Read only: <exact source files/commits/issues>.
Current evidence: <immutable references>; do not re-audit unchanged evidence.
Scope: <business outcome>.
Non-goals: <explicit exclusions>.
Return: facts vs claims vs targets, affected contracts, dependency order, tests, migration, telemetry, risk and executable rollback.
Stop if: source SHA changed, ownership is ambiguous, or required authority is missing.
```

### Implementation prompt

```text
Implement <Linear ID>/<V4 IDs> as one coherent acceptance slice on exact base <SHA>.
Allowed paths/contracts: <list>.
Required behavior: <positive and negative cases>.
Data/security: tenant ownership, role/capability, lifecycle, idempotency, audit and cleanup.
Validation: focused tests, disposable DB if applicable, type/lint/repository/full CI, exact-release UAT if applicable.
Delivery: one bounded PR with migration/deploy order, risk and rollback.
Do not: add dependencies, refactor unrelated code, claim unexecuted evidence, deploy or mutate production.
```

### Reviewer prompt

```text
Review exact diff <base...head> for <Linear ID>/<V4 IDs>.
Check only release-blocking correctness: source traceability, tenant isolation, authorization, data integrity, migration/rollback, idempotency, cleanup, telemetry and evidence binding.
Reproduce focused failures once. Classify each finding with file/contract, impact and minimum correction.
Do not repeat already-green unchanged gates or create adjacent scope.
```

### Release prompt

```text
Candidate <SHA>, environment <exact ID>, previous release <SHA>.
Preconditions: full CI, artifact hash, migration history, backup/restore, health/readiness, owner/window/rollback.
Execute serialized build → migration → deploy → smoke/UAT → observation.
Record exact evidence and cleanup. Stop on any SHA, tenant, migration, health, permission or residue mismatch.
Never access or change production unless this prompt explicitly names and authorizes production.
```

## 13. Reusable repository skill

The companion `skills/newme-v4-delivery/` Skill Pack encodes the evidence states, dependency order, work-package rules, tenant/migration controls, Git/CI contract, staging/release procedure, vertical acceptance matrices, reusable templates and deterministic validators. It is intended to let later agents execute the same delivery system without recreating this analysis or rewriting recurring evidence formats.

## 14. Immediate next delivery sequence

1. reconcile SAM-77/SAM-78 status and dependency evidence against `V4_EXECUTION_BACKLOG.md`;
2. obtain exact commit/tree/licensing evidence for the Axon private repository, or formally defer code reuse without blocking domain planning;
3. finish the incomplete V4-02 tenant lifecycle, cross-layer isolation and exact-release staging acceptance;
4. execute V4-03 commercial control plane and V4-04 shared services as independent parallel work packages after G1/G2 pass;
5. proceed to the real-estate and retail commercial slices only after their shared contracts stabilize.

This sequence deliberately places tenant safety before billing and both vertical packs.
