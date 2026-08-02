# NewMe V4 Requirements Traceability

Status: Proposed traceability baseline  
Date: 2026-08-03  
Companion documents: `V4_SAAS_PRD.md`, `V4_DELIVERY_OPERATIONS_PLAN.md`

## 1. Traceability contract

Each implementation issue and pull request must reference:

1. one or more V4 requirement IDs from this file;
2. the source IDs that motivated the requirement;
3. the exact acceptance evidence expected;
4. its migration, security, operations and rollback impact;
5. the release gate it advances.

Evidence states are `verified-current`, `source-claim`, `target`, `validated-staging`, `validated-production`, `deferred` and `rejected`. Only executed evidence may advance a state.

## 2. Source registry

### AX — Axon real-estate delivery package

Package SHA-256: `3ABE9E8280FD88CD150477E71A9E70A790CAD128798F492639AB17D0EC812B08`.

| Source ID | File or evidence | Evidence class |
|---|---|---|
| AX-00 | `00 - START HERE - Executive Summary and Index.md` | source claim and package index |
| AX-01 | `01 - PRD and Business Requirements/01_PRD_and_Business_Requirements.md` | real-estate requirements |
| AX-02 | `02 - Feature Matrix and Workflow Status/02_Feature_Matrix_and_Workflow_Status.md` | claimed workflow status; requires repository/runtime verification |
| AX-03 | `03 - Technical Architecture/03_Technical_Architecture.md` | architecture claim |
| AX-04 | `04 - Source Code and Deployment/04_Source_Code_and_Deployment.md` | implementation/deployment claim and self-reported gaps |
| AX-05 | `04 - Source Code and Deployment/schema.prisma` | verified supplied schema snapshot; SHA-256 `2D8174F27BE9019DE12AEC11F7998D2F8010A3C140E19006A272EFBDB7E32193` |
| AX-06 | `04 - Source Code and Deployment/repo_README.md` | stale/conflicting repository description |
| AX-07 | `06 - Operations Runbook/06_Operations_Runbook.md` | operations requirements and claims |
| AX-08 | `07 - Known Issues and Next Steps/07_Known_Issues_and_Next_Steps.md` | acknowledged gaps and roadmap |
| AX-09 | `08 - Security Checklist/08_Security_Checklist.md` | security expectations |
| AX-10 | `09 - Handover Acceptance Checklist/09_Handover_Acceptance_Checklist.md` | acceptance expectations |
| AX-11 | `10 - Stakeholder Training Script/10_Stakeholder_Training_Script.md` | persona and operational language |
| AX-12 | `11 - Final Test Report/11_Final_Test_Report.md` | source-claimed test evidence; lacks immutable repository binding |
| AX-13 | private GitHub repository reference | unavailable to current connector; exact HEAD/tree/CI unverified |

AX fact boundary:

- the supplied schema has 38 models and no tenant/organization/company/workspace model or scope field;
- the package self-reports no committed automated tests/CI, unversioned `db push`, local uploads and no off-host recovery proof;
- README SQLite claims conflict with the newer source/deployment document's PostgreSQL claims;
- the package has no immutable source commit SHA;
- therefore only its domain vocabulary, workflow intent and acceptance examples are reused.

### IC — International City OS handoff

Package SHA-256: `58D5A9ACB194CEA3CB1ABE1800653F53448BAAD4FA7409F754C2FB6B2AD5978C`.

| Source ID | File | Main requirement clusters |
|---|---|---|
| IC-01 | `01_EXECUTIVE_OVERVIEW_CN.md` | product outcome and business users |
| IC-02 | `02_CURRENT_SYSTEM_INVENTORY_CN.md` | stated current surface; requires evidence qualification |
| IC-03 | `03_TARGET_OPERATING_MODEL_CN.md` | target company/region/store/warehouse operations |
| IC-04 | `04_ROLE_PERMISSION_MATRIX_CN.md` | retail roles and permissions |
| IC-05 | `05_DOMAIN_DATA_MODEL_CN.md` | retail/trading domain model |
| IC-06 | `06_INVENTORY_LEDGER_CN.md` | inventory balances and movements |
| IC-07 | `07_PRICING_QUOTATION_CN.md` | resolver, pricing, quotation and approval |
| IC-08 | `08_ORDER_FULFILLMENT_CN.md` | order, fulfilment and return |
| IC-09 | `09_PROCUREMENT_CN.md` | supplier, PR, PO, receiving and replenishment |
| IC-10 | `10_DELIVERY_COD_FINANCE_CN.md` | delivery, COD, handover and finance separation |
| IC-11 | `11_REPORTING_ANALYTICS_CN.md` | deterministic reporting |
| IC-12 | `12_AGENT_TOOL_GATEWAY_CN.md` | controlled tool gateway and actor context |
| IC-13 | `13_SECURITY_AUDIT_CN.md` | security and audit expectations |
| IC-14 | `14_INTEGRATIONS_CN.md` | external adapter boundary |
| IC-15 | `15_SAAS_MULTI_TENANT_REQUIREMENTS_CN.md` | tenant lifecycle, RLS, billing and operations targets |
| IC-16 | `16_IMPLEMENTATION_ROADMAP_CN.md` | source roadmap; reordered by V4 safety gates |
| IC-17 | `17_GAP_ANALYSIS_CURRENT_CLAWTEAMS_VS_REQUIRED_CN.md` | explicit current/target gaps |
| IC-18 | `18_TEST_STRATEGY_CN.md` | proposed test strategy |
| IC-19 | `19_ACCEPTANCE_TEST_SCENARIOS_CN.md` | 30 target scenarios, not an executed test report |
| IC-20 | `20_HANDOFF_CHECKLIST_CN.md` | handoff controls |
| IC-M | `MASTER_PRD_CN.md` | consolidated target PRD |
| IC-E | English executive summary | non-authoritative summary |

IC fact boundary:

- `CURRENT` in the package does not mean deployed or production-validated;
- business/branch/location are not substitutes for a tenant boundary;
- retail SaaS lifecycle, complete RLS, SSO/MFA, subscription/billing, backup/restore and several workflows are targets;
- the 30 acceptance scenarios are specifications, not run results;
- external POS/ERP/accounting/WhatsApp capabilities are not production-proven.

### NM — Existing NewMe decisions and evidence

| Source ID | Existing source | Reuse boundary |
|---|---|---|
| NM-18 | `docs/product-decisions/SAM-18-saas-product-boundary.md` | role, paid-seat, plan, lifecycle and vertical boundary decisions |
| NM-19 | `docs/product-decisions/SAM-19-organization-membership-data-model.md` | staged organization/membership design; implementation status must be checked per release |
| NM-23 | `docs/product-decisions/SAM-23-customer-readiness-delivery-boundary.md` | customer-readiness contract; synthetic slots are not real customers |
| NM-EV | `docs/releases/2026-08-02-staging-commercial-saas-evidence.md` | staging evidence for its exact release only |
| NM-GIT | `agent/saas-staging-isolation@0c75a141043f5eca828b7b50778bf1f071d65e33` | research-lock Git base, 33 commits ahead of `main@7f6284409820c1cc2c8b4163f9646f89bf75d888` at review time |

## 3. Requirement-to-delivery matrix

The source ranges below are stable group identifiers used by Linear issues and PRs. Detailed source ledgers AX-001…AX-100 and IC-001…IC-095 were produced during the research review; implementation PRs should cite this grouped matrix rather than copy unverifiable source claims.

| V4 ID | Requirement | Source | Milestone | Acceptance evidence | Gate |
|---|---|---|---|---|---|
| V4-PF-001 | Organization lifecycle and immutable tenant identity | IC-03, IC-15, NM-18, NM-19 | M1 | disposable DB + two-organization staging matrix | G1/G2 |
| V4-PF-002 | Multi-membership, role and capability model | AX-01, AX-09, IC-04, IC-15, NM-18/19 | M1 | active/inactive, multi-org and role negatives | G1 |
| V4-PF-003 | All tenant records carry enforced organization ownership | AX-05 gap, IC-05/15 | M1 | FK/RLS/API/RPC/worker scan and live negative tests | G1/G2 |
| V4-PF-004 | Time-bounded platform support access | IC-13/15, NM-19/23 | M1 | approval, expiry, revocation and audit rehearsal | G1/G5 |
| V4-PF-005 | Plan, subscription and organization entitlement | IC-15, NM-18 | M2 | lifecycle state-machine and entitlement denials | G3 |
| V4-PF-006 | Paid-seat ledger and quota enforcement | IC-15, NM-18 | M2 | concurrent activation/idempotency/overage tests | G3 |
| V4-PF-007 | Trial, grace, read-only, suspension, recovery and closure | IC-15, NM-18/23 | M2 | transition matrix, export and audit evidence | G3 |
| V4-PF-008 | Usage events and invoice references | IC-15, NM-18 | M2 | idempotent usage/invoice reconciliation | G3 |
| V4-PF-009 | Shared tasks, approvals, timeline and notifications | AX-01/02, IC-03/12 | M3 | tenant-safe E2E and idempotent repeat | G1/G4 |
| V4-PF-010 | Object storage and signed tenant paths | AX-04/08 gap, IC-13/15 | M3 | upload/download/cross-tenant/retention tests | G5 |
| V4-PF-011 | Import/export jobs with reconciliation | IC-15/19, NM-23 | M3 | scoped export, abuse inputs and exact counts | G1/G7 |
| V4-PF-012 | Outbox, retries, dead-letter and reconciliation | IC-12/14, AX-08 | M3 | failure/replay/recovery evidence | G5/G6 |
| V4-RE-001 | Party, landlord and compliance records | AX-01/02/05 | M4 | organization-scoped CRUD, dedupe and expiry | G4 |
| V4-RE-002 | Property and listing ownership/readiness | AX-01/02/05 | M4 | ownership, readiness and role matrix | G4 |
| V4-RE-003 | Real-estate lead, assignment, SLA and matching | AX-01/02 | M4 | deterministic pipeline and ownership negatives | G4 |
| V4-RE-004 | Viewing lifecycle | AX-01/02/05 | M4 | schedule/attend/feedback/idempotency | G4 |
| V4-RE-005 | Property offer negotiation | AX-01/02/05 | M4 | offer/counter/accept/reject/expiry history | G4 |
| V4-RE-006 | Deal conversion and checklist | AX-01/02/05 | M4 | accepted-offer single conversion and cancellation | G4 |
| V4-RE-007 | Commission approval and payroll settlement | AX-01/02/05 | M4 | split/approval/settlement/terminal negatives | G4 |
| V4-RE-008 | Media, documents and publish queue | AX-01/02/05/08 | M4/M6 | readiness, object storage and adapter reconciliation | G4/G5 |
| V4-RT-001 | Company/region/store/warehouse/location topology | IC-03/05/15 | M5 | organization/location integrity and isolation | G1/G4 |
| V4-RT-002 | Product/SKU/variant resolver | IC-05/06/07 | M5 | exact resolver, ambiguity and unknown negatives | G4 |
| V4-RT-003 | Inventory movement ledger and balances | IC-06/19 | M5 | stock movement/idempotency/reconciliation | G4 |
| V4-RT-004 | Store/warehouse transfer and stocktake | IC-06/09/19 | M5 | approval, in-transit, receipt and discrepancy | G4 |
| V4-RT-005 | Pricing, VAT, discount and quotation | IC-07/19 | M5 | deterministic calculation and approval matrix | G4 |
| V4-RT-006 | Order, reservation and fulfilment | IC-08/19 | M5 | accepted quote→order exactly once | G4 |
| V4-RT-007 | Supplier, PR, PO, receipt and replenishment | IC-09/19 | M5 | procurement approval and stock reconciliation | G4 |
| V4-RT-008 | Delivery, COD, handover and finance confirmation | IC-10/19 | M5 | actor separation, reconciliation and refund | G4 |
| V4-RT-009 | Deterministic operational reports | IC-11/19 | M5 | source-to-report totals and scope filters | G4 |
| V4-AI-001 | Tenant/actor-injecting tool gateway | IC-12/13/17 | M6 | spoofed context denied; audit complete | G1/G5 |
| V4-AI-002 | L0–L4 policy and human approval | IC-12/19 | M6 | prohibited/approval/reversible action matrix | G5 |
| V4-AI-003 | Signed events, short tokens and replay protection | IC-12/14 | M6 | signature/expiry/replay/idempotency tests | G5 |
| V4-INT-001 | Portal/WhatsApp/DLD adapters disabled by default | AX-08, IC-14/17 | M6 | capability flag, consent, sandbox and reconciliation | G4/G5 |
| V4-OPS-001 | SHA→artifact→manifest→runtime provenance | AX-04 gap, IC-15, NM-EV | M7 | build/deploy/runtime evidence chain | G6 |
| V4-OPS-002 | Tenant-aware logs, metrics, traces and alert ownership | AX-04 gap, IC-13/15 | M7 | alert delivery and tenant-safe observability | G6 |
| V4-OPS-003 | Backup/PITR and isolated restore rehearsal | AX-04/07 gap, IC-15/19 | M7 | timed restore, RPO/RTO and destruction | G6 |
| V4-OPS-004 | Performance and noisy-neighbor validation | IC-15/18 | M7 | reproducible load report with p95/p99 | G6 |
| V4-MIG-001 | Legacy mapping, backfill and reconciliation | AX-05, IC-05, NM-19 | M7 | masked clone, exception ledger and totals | G2/G7 |
| V4-PILOT-001 | Authorized real-estate design partner | AX-01, NM-23 | M8 | onboarding→support→billing→exit evidence | G8 |
| V4-PILOT-002 | Authorized retail design partner | IC-01/19, NM-23 | M8 | onboarding→support→billing→exit evidence | G8 |
| V4-PILOT-003 | Repeatability across 5–10 organizations | IC-15/16, NM-23 | M8 | organization-by-organization evidence register | G8 |

## 4. Explicit conflicts and decisions

| Conflict | Decision |
|---|---|
| Axon calls itself multi-tenant but the supplied schema has no tenant model/scope | Treat Axon as a tenant-internal domain reference only |
| Axon documentation conflicts on SQLite vs PostgreSQL and live data | No runtime claim is accepted without private-repository exact SHA and deployment evidence |
| Axon fixed roles vs IC location-heavy roles | Map both into organization capabilities; do not make source labels platform enums |
| Real-estate Offer vs retail Quotation/Offer | Separate vertical entities/state machines; share only approval/money/idempotency primitives |
| Real-estate commission/payroll vs retail COD/AR/procurement cost | Separate finance subdomains and reconciliation rules |
| IC roadmap delays SaaS foundations until after demos | V4 moves tenancy, migration, CI, storage, backup and observability before vertical commercial slices |
| Source claims of external integrations | Disabled adapters until authenticated, contracted and stage-tested |
| Source AI/agent interfaces | Replace with the V4 tool gateway; no direct database or actor-supplied tenant authority |

## 5. Existing Linear continuity

The V4 project relates to—not duplicates—the existing foundation issues:

- SAM-18: product boundary decisions;
- SAM-19: organization membership model;
- SAM-21: migration rehearsal;
- SAM-22: two-organization isolation;
- SAM-23: customer-readiness contract;
- SAM-27 and SAM-52: observability/alert delivery;
- SAM-63 and SAM-75: release and production provenance.

V4 issues should link those items as dependencies or prior evidence. They must not reopen completed work without a new acceptance gap.

## 6. Change control

Changing a requirement requires one pull request that updates this matrix, the PRD if product behavior changes, and the affected Linear issue. A source claim cannot be promoted to verified-current without an immutable repository/runtime reference. A target cannot be marked delivered without its listed evidence class and release binding.
