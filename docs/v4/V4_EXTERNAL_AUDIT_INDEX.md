# NewMe V4 External Audit Index

Status: Audit manifest
Repository snapshot date: 2026-08-03 (Asia/Shanghai)
Linear query interval: 2026-08-03T01:19:03.715Z to 2026-08-03T01:19:04.955Z

## 1. Audit objective

Determine whether the NewMe V4 plan is source-traceable, internally consistent, executable, tenant-safe and capable of producing evidence-bound commercial releases for real estate and retail. Audit implementation and environment claims only against their exact Git SHA, CI run, release manifest and environment evidence.

## 2. Repository audit objects

| ID | Audit object | Repository path | Audit question |
|---|---|---|---|
| A01 | V4 product requirements | `docs/v4/V4_SAAS_PRD.md` | Are product scope, shared/vertical boundaries, non-functional requirements and G0–G8 release gates complete and mutually consistent? |
| A02 | V4 delivery and operations plan | `docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md` | Does the dependency, Git/CI, migration, staging, release, rollback and multi-agent model produce safe complete slices? |
| A03 | V4 requirements traceability | `docs/v4/V4_REQUIREMENTS_TRACEABILITY.md` | Does every V4 requirement map to source IDs, acceptance evidence and a release gate without promoting source claims? |
| A04 | Current execution backlog | `docs/v4/V4_EXECUTION_BACKLOG.md` | Does the live execution order match Linear dependencies and the evidence-backed status of every work package? |
| A05 | Reusable delivery Skill router | `skills/newme-v4-delivery/SKILL.md` | Does a new agent select and execute the correct workflow without recreating the original analysis? |
| A06 | Work-package and traceability rules | `skills/newme-v4-delivery/references/work-package-and-traceability.md` | Are scope, acceptance, evidence and closeout rules deterministic and anti-fragmentation? |
| A07 | Tenant and migration rules | `skills/newme-v4-delivery/references/tenant-data-and-migrations.md` | Do tenant ownership, RLS, migration, rollback and clone controls fail closed? |
| A08 | Git, CI and evidence rules | `skills/newme-v4-delivery/references/git-ci-and-evidence.md` | Are exact SHA, diff, CI, infrastructure-failure and publication rules reproducible? |
| A09 | Staging and operations rules | `skills/newme-v4-delivery/references/staging-release-and-operations.md` | Are build, manifest, migration, deploy, UAT, cleanup, rollback and disk safety serialized and reversible? |
| A10 | Vertical acceptance rules | `skills/newme-v4-delivery/references/vertical-acceptance.md` | Are shared primitives and real-estate/retail state machines separated and commercially testable? |
| A11 | Work-package validator | `skills/newme-v4-delivery/scripts/validate-work-package.mjs` | Does malformed, unbound or incomplete work-package input fail closed? |
| A12 | Release-evidence validator | `skills/newme-v4-delivery/scripts/validate-release-evidence.mjs` | Does evidence with SHA drift, failed CI, non-zero residue or secret-shaped fields fail closed? |
| A13 | Governance package validator | `skills/newme-v4-delivery/scripts/validate-governance.mjs` | Are all required documents, issue IDs, gates, references, templates and validation paths present? |
| A14 | Reusable templates | `skills/newme-v4-delivery/assets/` | Do work-package, PR, Linear closeout and release-evidence templates capture every mandatory field? |
| A15 | Validator regression suite | `skills/newme-v4-delivery/scripts/validate-scripts.test.mjs` | Do positive templates pass and malformed IDs, non-zero residue and secret-shaped evidence fail closed? |
| A16 | Staging commercial acceptance record | `docs/v4/V4_STAGING_COMMERCIAL_ACCEPTANCE.md` | Is one exact staging release bound to build, migration, CI, UAT, cleanup, capacity and rollback evidence without promotion to production? |
| A17 | Production Go/No-Go record | `docs/v4/V4_PRODUCTION_GO_NO_GO.md` | Does the production decision remain fail-closed when staging is positive but production gates are absent? |

## 3. Linear audit objects

Project: [NewMe V4 SaaS — Real Estate and Retail](https://linear.app/samnewme/project/newme-v4-saas-real-estate-and-retail-6400aa7c0e9d)

| Linear | State at query | Audit object | Required cross-check |
|---|---|---|---|
| [SAM-77](https://linear.app/samnewme/issue/SAM-77/v4-01-lock-requirements-sources-and-architecture) | In Progress | Requirements, sources and architecture lock | PR #254, source registry, ownership/license decision and M0 status |
| [SAM-78](https://linear.app/samnewme/issue/SAM-78/v4-02-deliver-tenant-identity-and-isolation-foundation) | Done (evidence-conflicted) | Tenant identity and isolation | PR #255, its incomplete-scope comment, live Done status and M1 progress conflict |
| [SAM-79](https://linear.app/samnewme/issue/SAM-79/v4-03-deliver-commercial-control-plane) | Backlog | Commercial control plane | V4-PF-005..008 and G3 |
| [SAM-80](https://linear.app/samnewme/issue/SAM-80/v4-04-deliver-shared-workflow-and-operational-services) | In Progress | Shared operational services | V4-PF-009..012 and G1/G5/G6 |
| [SAM-81](https://linear.app/samnewme/issue/SAM-81/v4-05-deliver-real-estate-commercial-slice) | Backlog | Real-estate commercial slice | V4-RE-001..008, V4-PILOT-001 and G4 |
| [SAM-82](https://linear.app/samnewme/issue/SAM-82/v4-06-deliver-retail-catalog-inventory-and-pricing) | Backlog | Retail catalog, inventory and pricing | V4-RT-001..005 and G4 |
| [SAM-83](https://linear.app/samnewme/issue/SAM-83/v4-07-deliver-retail-orders-procurement-delivery-and-finance) | Backlog | Retail order-to-finance | V4-RT-006..009 and G4 |
| [SAM-84](https://linear.app/samnewme/issue/SAM-84/v4-08-deliver-controlled-agent-and-integration-gateway) | Backlog | Agent and integration gateway | V4-AI-001..003, V4-INT-001 and G5 |
| [SAM-85](https://linear.app/samnewme/issue/SAM-85/v4-09-rehearse-migration-import-and-reconciliation) | Backlog | Migration and reconciliation | V4-MIG-001 and G2/G7 |
| [SAM-86](https://linear.app/samnewme/issue/SAM-86/v4-10-prove-sre-security-backup-and-performance) | Backlog | SRE, security, backup and performance | V4-OPS-001..004 and G5/G6 |
| [SAM-87](https://linear.app/samnewme/issue/SAM-87/v4-11-rehearse-canary-deployment-and-rollback) | Backlog | Canary and rollback rehearsal | V4-OPS-001, V4-MIG-001 and G2/G6/G7 |
| [SAM-88](https://linear.app/samnewme/issue/SAM-88/v4-12-run-design-partner-pilot-and-commercial-decision) | Backlog | Design-partner pilot | V4-PILOT-001..003 and G8 |

Linear is live state. The auditor must record the query timestamp and must not substitute this repository snapshot for current status.

The Linear connector used during the 2026-08-06 staging acceptance required
reauthentication. No Linear state was created, edited or inferred; this table
remains a historical snapshot until a fresh authenticated query is recorded.

## 4. Immutable Git evidence

| Evidence | Reference |
|---|---|
| Planning baseline PR | [#254](https://github.com/69755354/newme-platform/pull/254) |
| Planning baseline merge | `a7c456ab2eeae9502da80abc351f7008791e5769` |
| Tenant foundation PR | [#255](https://github.com/69755354/newme-platform/pull/255) |
| Tenant foundation exact head | `631509a13ffa053347a937387171eb05819905a8` |
| Tenant foundation merge/canonical at snapshot | `f2bd6576a0723fea58a13926baef2dedcc37da8e` |
| Tenant foundation full CI | [run 30768558258](https://github.com/69755354/newme-platform/actions/runs/30768558258), job `91551547421`, success |
| Governance delivery PR | [#256](https://github.com/69755354/newme-platform/pull/256) |
| First-audit exact head | `80f7e2349324900cf5852f31b3a0459532fd6c1a` |
| First-audit exact-head CI | [run 30775237766](https://github.com/69755354/newme-platform/actions/runs/30775237766), job `91569377924`, success |
| Independent first reviews | Hermes review `4840188187`; OpenCode/GLM-5.2 review `4840192089` |
| Audit-remediation implementation commit | `2be17e85caf32b24e013da223c958e2b1ec47b0b` |
| Audit-remediation implementation CI | [run 30777036124](https://github.com/69755354/newme-platform/actions/runs/30777036124), job `91574370569`, success |
| Second-audit exact head | `8dbab48898757640326b5f316e62a8ca6e6573f7` |
| Second-audit exact-head CI | [run 30777227710](https://github.com/69755354/newme-platform/actions/runs/30777227710), job `91574892604`, success |
| Independent second reviews | Hermes review `4840962516`; OpenCode/GLM-5.2 review `4840970662` |
| V4 staging cleanup correction PR | [#376](https://github.com/69755354/newme-platform/pull/376) |
| V4 staging cleanup exact-head CI | [run 31102534969](https://github.com/69755354/newme-platform/actions/runs/31102534969), head `77abe85d55d305acceacf254e7daa598c57d7b50`, success |
| Audit-index exact-head CI | [run 31105064081](https://github.com/69755354/newme-platform/actions/runs/31105064081), rerun attempt 2, head `a3d81fc85ee471f5cdf32c311f9628a8c32ffed5`, success |
| Final-evidence exact-head CI | [run 31106890948](https://github.com/69755354/newme-platform/actions/runs/31106890948), head `133002cc064eca54b128a010046061b5d165375b`, success |
| Current staging commercial acceptance release | `83c4b6f3a14bb248db263ba8d727e00f6c0b70fe` |
| SAM-78 staging UAT | `sam78-staging-tenant-closure`, `ok=true`, project `bfsiibofuzoglziltgyd`, exact release `83c4b6f3a14bb248db263ba8d727e00f6c0b70fe`, cleanup verified |
| Product/SaaS staging UAT | `product-saas-final`, `ok=true`, project `bfsiibofuzoglziltgyd`, exact release `83c4b6f3a14bb248db263ba8d727e00f6c0b70fe`, cleanup verified |
| V4 staging UAT | `v4-staging-acceptance`, `ok=true`, project `bfsiibofuzoglziltgyd`, exact release `83c4b6f3a14bb248db263ba8d727e00f6c0b70fe`, cleanup verified |
| Staging acceptance and production decision | `docs/v4/V4_STAGING_COMMERCIAL_ACCEPTANCE.md`; `docs/v4/V4_PRODUCTION_GO_NO_GO.md` |

The immutable rows above bind each completed audit to the commit actually reviewed. The live PR head is intentionally not self-referenced from the commit that would create that head; auditors must read the current head from [PR #256](https://github.com/69755354/newme-platform/pull/256) and bind any later verdict to that exact SHA and its CI run.

## 5. Source-input custody boundary

The Axon and International City archives are owner-supplied source inputs, not repository implementation evidence. Their recorded SHA-256 values and source IDs are in `docs/v4/V4_REQUIREMENTS_TRACEABILITY.md`. The private Axon repository remains unverified until an auditor can bind its exact commit/tree and ownership/license evidence. Raw archives, credentials, customer PII and production data must not be added to this repository or an audit report.

## 6. Audit verdict format

For every finding record: audit object ID, exact Git SHA or Linear query time, requirement/gate, direct evidence, severity, affected release claim, minimum correction and retest evidence. Separate source claims, repository implementation, staging validation and production validation.
