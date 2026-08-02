# NewMe V4 SaaS PRD

Status: Proposed product and engineering baseline  
Decision date: 2026-08-03  
Target repository: `69755354/newme-platform`  
Target base at research lock: `agent/saas-staging-isolation@0c75a141043f5eca828b7b50778bf1f071d65e33`

## 1. Evidence boundary

This document separates four evidence states:

- **Verified current**: directly observed in the NewMe repository, its linked CI/release evidence, or a supplied source file.
- **Source claim**: stated by a supplied delivery package but not independently verified against its live repository or runtime.
- **Target**: required V4 behavior that is not claimed as implemented.
- **Deferred**: intentionally outside the first commercial release.

The two supplied archives are requirements inputs, not production evidence:

| Source | Immutable package evidence | Use in V4 |
|---|---|---|
| Axon real-estate delivery archive | SHA-256 `3ABE9E8280FD88CD150477E71A9E70A790CAD128798F492639AB17D0EC812B08` | Real-estate language, workflows, role expectations and acceptance examples |
| International City OS handoff archive | SHA-256 `58D5A9ACB194CEA3CB1ABE1800653F53448BAAD4FA7409F754C2FB6B2AD5978C` | Retail/trading domain, control model, tool policy and target acceptance scenarios |
| `AxonAIconsultancies/real-estate` | Not independently readable on 2026-08-03: the organization exposed no public repository and the connected GitHub account received 404 | Private-repository claims remain unverified until exact commit/tree and read authority are provided |

The Axon archive contains a Prisma schema snapshot (SHA-256 `2D8174F27BE9019DE12AEC11F7998D2F8010A3C140E19006A272EFBDB7E32193`) with 38 models but no tenant, organization, company or workspace model/foreign key. It is therefore a domain reference, not a reusable SaaS tenancy implementation. The archive also describes unversioned `db push`, local file storage, no committed automated tests/CI, and no off-host restore proof. Those implementation choices are explicitly excluded from V4.

## 2. Product outcome

NewMe V4 is a UAE-focused, multi-organization SaaS operating system with:

1. one shared commercial and security control plane;
2. independently entitled real-estate and retail vertical packs;
3. deterministic operational workflows and auditable human approvals;
4. tenant-aware operations, metering, support, backup, release and incident evidence;
5. a reversible upgrade path from the current NewMe staging foundation.

V4 is commercially releasable only when the release gates in section 15 are evidenced. A merged document, green static CI, or a successful demo is not commercial-release evidence by itself.

## 3. Product principles

1. **Tenant boundary precedes billing and vertical features.** Organization identity, membership, authorization and data ownership are the first implementation milestone.
2. **One platform, vertical packs, no customer forks.** Customer variation is configuration, entitlement, template or adapter data—not a forked application.
3. **Server-side enforcement.** UI visibility never substitutes for API/RPC/RLS/background-job/import/export enforcement.
4. **Financial and compliance facts are deterministic.** AI may draft, summarize or recommend; it may not silently mutate financial, authorization, tenant or audit facts.
5. **External capability is honest.** DLD/Trakheesi/Makani, property portals, WhatsApp, payment and e-invoicing support remain disabled capabilities until an authenticated adapter passes staging and contractual review.
6. **Every state-changing call is attributable and idempotent.** Actor, organization, request/correlation ID, policy decision, before/after state and result are recorded where appropriate.
7. **No raw production data in shared staging.** Production-data rehearsal uses a separate restricted clone, approved masking, expiry and destruction evidence.

## 4. Personas and roles

### 4.1 Platform roles

- `platform_owner`: commercial configuration and break-glass governance.
- `platform_ops`: release, availability and tenant operations without default access to customer content.
- `platform_support`: time-bounded, approved support sessions scoped to one organization.
- `platform_auditor`: read-only audit and compliance evidence.

### 4.2 Organization roles

Canonical V4 roles are capabilities, not hard-coded UI labels:

- `org_owner`, `org_admin`, `manager`
- `sales_agent`, `operations`, `finance`, `specialist`
- `viewer`, `portal_user`

Vertical templates map source roles into these capabilities. Examples:

- Axon Owner/Manager/Broker/Listing/Admin/Accounts/Photographer map to organization capabilities.
- Retail Owner/Manager/Sales/Cashier/Warehouse/Finance/Driver/Inventory Viewer/Auditor map to organization capabilities.

An individual may belong to multiple organizations with different roles. Platform roles never inherit organization data access without a separately approved support session.

## 5. Shared platform domain

### V4-PF-001 Organization identity and lifecycle

The platform shall provide `organizations`, `memberships`, role/capability assignments, platform staff, support sessions and immutable audit events. Organization lifecycle states are `provisioning`, `active`, `read_only`, `suspended`, `export_only`, `closed`. Transitions require explicit reason, actor and policy evidence.

Acceptance:

- every tenant-owned record has an organization key enforced by constraints and policies;
- a user with two memberships can select context without cross-organization leakage;
- inactive membership and inactive profile fail closed at session, API, RPC and background-job boundaries;
- support access expires automatically and remains auditable.

### V4-PF-002 Authorization and entitlement

Authorization is the intersection of authenticated actor, active membership, capability, record ownership when required, vertical entitlement and organization lifecycle state. Feature flags may change rollout, but cannot grant authority.

Acceptance includes negative tests for direct IDs, search, export, import, webhook, cron, queue worker, object storage and RPC paths.

### V4-PF-003 Commercial control plane

The platform shall model plan catalog, subscription, trial, active paid seats, entitlements, quotas, usage events, manual/automatic invoice references, grace period, dunning, suspension, recovery and closure.

Initial product decisions inherited from the existing SaaS boundary:

- Starter: 5 paid seats, 1 organization.
- Growth: 20 paid seats, up to 3 organizations.
- Scale: 50+ seats and negotiated multi-organization limits.
- active accepted write-enabled organization roles consume paid seats;
- `viewer` and `portal_user` are not paid seats in the initial policy;
- overage never occurs silently; activation is blocked or explicitly approved;
- unpaid lifecycle progresses through grace, read-only and suspension with export/restore rules.

These are product rules, not evidence of an implemented billing engine. Until a payment provider is integrated, V4 must label invoicing as manual and keep its status transitions auditable.

### V4-PF-004 Shared workflow services

Provide reusable tasks, approvals, notifications, files, comments, activity timeline, idempotency registry, outbox/events, import/export jobs and reporting primitives. Vertical state machines remain vertical-owned.

### V4-PF-005 Files and records

Files use object storage with organization-scoped paths, signed URLs, content-type/size controls, malware scanning boundary, retention, legal hold, export and deletion evidence. Local application-disk uploads are prohibited for commercial operation.

### V4-PF-006 Platform administration

Platform administration provides organization provisioning, plan/entitlement changes, usage and support-session management without a universal customer-data bypass. Dangerous actions require reason, step-up authorization, bounded scope and audit.

## 6. Real-estate vertical pack

The real-estate pack ports domain semantics from the Axon package into NewMe tenancy and release controls. It does not import the Axon runtime stack or schema wholesale.

### V4-RE-001 Parties and compliance records

- landlord/owner, buyer, tenant, broker and external contact;
- organization-scoped identity and deduplication;
- consent, document, expiry and verification status;
- UAE fields for permit, Trakheesi, Makani and related references as data attributes until official adapters are enabled.

### V4-RE-002 Property and listing lifecycle

- property/unit and listing are separate records;
- listing ownership, exclusive/non-exclusive status, readiness, price and availability;
- media/document checklist and publish-readiness gate;
- server-side ownership, role and entitlement checks for every mutation;
- portal publication is an adapter-driven queued action with retry, result and reconciliation evidence.

### V4-RE-003 Lead and matching

- organization-scoped lead intake, assignment, SLA and deduplication;
- configurable 10-stage real-estate pipeline informed by the source package;
- property/lead matching with deterministic filters and explainable ranking;
- contact, note, timeline, task and reminder facts remain auditable.

### V4-RE-004 Viewing, offer and negotiation

- viewing request, scheduling, attendance, feedback and follow-up;
- offer submission, counter, acceptance, rejection, expiry and withdrawal;
- actor/ownership checks, idempotency and immutable state-transition history.

### V4-RE-005 Deal, commission and payroll

- accepted offer creates a deal through a single idempotent transition;
- deal checklist, contract/payment references, commission split, approval and payroll settlement;
- finance confirmation is distinct from broker or manager intent;
- cancellation and terminal-state mutation are negative acceptance cases.

### V4-RE-006 Collaboration and command view

Team command views aggregate deterministic data within organization scope. Comments, handoffs and approvals have actor/time/record linkage. Dashboards are not the source of truth and cannot bypass record-level controls.

## 7. Retail and trading vertical pack

### V4-RT-001 Organization topology

Retail organizations may contain region, store, warehouse, location and department. Every inventory, pricing, order and finance fact is scoped to an organization and, where applicable, an operational location.

### V4-RT-002 Catalog and inventory ledger

- product, SKU, variant, unit and barcode resolver;
- `on_hand`, `reserved`, `blocked`, `damaged`, `in_transit` derived from an append-only movement ledger;
- store/warehouse transfer, receiving, adjustment and stocktake;
- no negative availability without an explicitly approved policy;
- idempotent movement keys and reconciliation reports.

### V4-RT-003 Pricing and quotation

The deterministic sequence is SKU resolution → inventory availability → price resolution → discount/policy evaluation → quotation draft. Unknown, zero or negative items fail closed. Discount approval, expiry, revision and customer send are explicit states; AI cannot auto-send.

### V4-RT-004 Orders and procurement

- accepted quotation converts once to an order;
- reservation, picking, packing, fulfilment, cancellation and return;
- supplier, purchase request, purchase order, receipt, supplier return and replenishment;
- location-aware availability and approval thresholds.

### V4-RT-005 Delivery, COD and finance

- delivery assignment/status/proof;
- driver cash collection, handover and finance confirmation are distinct events;
- reconciliation, allocation, accounts receivable, refund and close;
- payment or sign-off may not be forged or auto-confirmed by AI.

### V4-RT-006 Deterministic reporting

Stock, sales, margin, receivables, purchasing and operational reports are derived from committed facts with organization/location/date filters. AI may narrate a report but may not alter its numbers.

## 8. Agent and integration control plane

### V4-AI-001 Tool gateway

All agent/tool calls pass through a server-side gateway that injects tenant, actor, capability, channel, correlation ID and idempotency key. Clients cannot supply authoritative identity or tenant fields.

### V4-AI-002 Risk levels

- L0: read-only public or non-sensitive lookup.
- L1: tenant read and drafts.
- L2: reversible operational write with policy check.
- L3: approval-required financial, external-send or bulk action.
- L4: prohibited to AI—authorization changes, cross-tenant access, audit deletion, raw database writes, forged payment/sign-off or hidden customer communication.

### V4-AI-003 Event integrity

Integrations use short-lived credentials, signed events, replay protection, idempotency, retry/dead-letter handling and reconciliation. Each adapter has disabled-by-default capability flags and an explicit data-processing boundary.

## 9. Non-functional requirements

### Security and privacy

- organization isolation at database, API, RPC, worker, storage and export/import layers;
- least privilege, service-role boundary tests, secret rotation and dependency gates;
- UAE PDPL-aligned purpose, minimization, access, retention, export and deletion workflows;
- audit facts are append-only and excluded from broad customer deletion.

### Availability and recovery

- release-bound health and authenticated readiness;
- tenant-aware structured logs, metrics, traces and alert ownership;
- stated SLOs and error budgets before pilot;
- backup/PITR capability metadata and an isolated restore rehearsal;
- RPO/RTO measured from a timed rehearsal, not a document claim.

### Performance

Before commercial pilot, load tests shall cover organization onboarding, list/search, import/export, peak quotation/order writes and background jobs. Results must include dataset shape, concurrency, p50/p95/p99, errors and tenant-noisy-neighbor observations.

### Localization and UAE commercial compliance

- English/Arabic-ready content and RTL-safe UI foundations;
- AED, VAT fields and timezone-aware records;
- e-invoicing adapter design must use structured invoice data and must not represent PDFs/images/emails as UAE e-invoices;
- regulatory integrations remain capability-gated until official requirements and credentials are validated.

## 10. Data and migration architecture

1. Introduce organization/membership/capability foundations before adding vertical records.
2. Add organization foreign keys and composite integrity constraints to tenant-owned tables.
3. Use versioned forward and rollback migrations with disposable-database apply/verify/rollback gates.
4. Backfill legacy records only through an explicit mapping manifest and reconciliation totals.
5. Preserve immutable audit and financial facts; no destructive rewrite for convenience.
6. Import Axon or retail source data through mapping adapters, never direct table copies.
7. Treat any unknown ownership or duplicate global identifier as a quarantine exception requiring review.

## 11. Release increments

### M0 — Evidence and architecture lock

Source/ownership, exact Git references where available, PRD, domain glossary, ADRs, traceability and release gates approved.

### M1 — Tenant boundary foundation

Organization identity, membership, capability, tenant foreign keys, RLS/API/worker/storage isolation, support session and audit pass end-to-end negative tests.

### M2 — Commercial control plane

Plan, seat, entitlement, quota, trial, invoice reference, grace, suspension, recovery and platform admin pass state-machine and audit tests.

### M3 — Shared operational services

Files, tasks, approval, timeline, notification, outbox, import/export, idempotency and reporting primitives are tenant-safe and operationally observable.

### M4 — Real-estate commercial slice

One organization completes owner/listing → lead/match → viewing → offer → deal → commission, including role negatives, export, suspension/recovery and cleanup.

### M5 — Retail commercial slice

One organization completes catalog/SKU → inventory → quotation → order → procurement/delivery/COD → finance reconciliation with role negatives and cleanup.

### M6 — Controlled adapters and agents

Approved adapters and agent tools pass consent, capability, idempotency, replay, approval and audit gates. Unapproved adapters remain disabled.

### M7 — Operational release rehearsal

Performance, security, backup/restore, observability, migration rehearsal, canary, rollback and isolated masked production-clone tests meet measured acceptance thresholds.

### M8 — Pilot and commercial decision

At least one real-estate and one retail design partner complete onboarding, support, billing boundary and exit rehearsal. Evidence from 5–10 authorized organizations is required before claiming repeatable multi-customer operations.

Dates in Linear are planning targets, not release commitments. A milestone closes only against evidence.

## 12. Scope exclusions for first commercial release

- unrestricted custom workflow builder;
- direct AI/database access;
- automatic financial approval or customer send;
- country expansion beyond the approved UAE boundary;
- unverified DLD/Trakheesi/Makani, portal, WhatsApp, payment or e-invoicing claims;
- customer-specific source forks;
- raw production data in shared staging.

## 13. Commercial acceptance scenarios

Each vertical must demonstrate:

1. organization provisioning, owner invitation and exact paid-seat count;
2. plan/entitlement allow and deny behavior;
3. active/inactive and role/capability matrix;
4. normal business chain and idempotent repeat;
5. cross-organization direct-ID/search/export/import/worker denial;
6. audit and support-session evidence;
7. suspension, read-only, recovery and export;
8. backup/restore and reconciliation;
9. release SHA, migration history and rollback rehearsal;
10. exact fixture cleanup or approved retained pilot records.

## 14. Success measures

Before pilot, define and baseline:

- onboarding completion rate and time-to-first-value;
- active paid seats and entitlement-denial accuracy;
- workflow completion and exception rate per vertical;
- cross-tenant violation count (target zero);
- import/export reconciliation error rate;
- support-session expiry and audit completeness;
- availability, p95 latency, background-job delay and error budget;
- restore RPO/RTO;
- invoice/dunning/suspension state reconciliation.

Targets are set in the pilot plan after baseline measurement; this PRD does not invent numerical commitments without data.

## 15. Commercial release gates

- **G0 Source and ownership:** immutable sources, licenses/ownership and traceability complete.
- **G1 Tenant security:** database/API/RPC/worker/storage/import/export isolation and role matrices pass.
- **G2 Change safety:** versioned migrations, disposable apply/rollback, staging history and reconciliation pass.
- **G3 Commercial lifecycle:** plan/seat/entitlement/trial/dunning/suspend/restore and audit pass.
- **G4 Vertical acceptance:** the claimed real-estate or retail pack passes its own complete E2E matrix.
- **G5 Security and privacy:** dependency, secret, storage, retention/export/delete and advisor gates pass.
- **G6 Operations:** release provenance, health/readiness, monitoring/alerting, restore drill and rollback pass.
- **G7 Migration rehearsal:** restricted masked clone, reconciliation and destruction evidence pass.
- **G8 Pilot:** authorized design partners complete onboarding, support, billing boundary and exit evidence.

The product may release one vertical before the other. Marketing must name only the verticals whose G4 and G8 evidence is complete.

## 16. Standards used as design checks

- AWS SaaS Lens: tenant isolation across layers, tenant-aware operations, unified onboarding/management/versioning, metering and cost awareness.
- NIST SP 800-218 Secure Software Development Framework: secure development practices integrated into the lifecycle.
- UAE Ministry of Finance eInvoicing programme: structured invoice data and formal accreditation/integration requirements.

Primary references:

- https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/definitions.html
- https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/general-design-principles.html
- https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/operate.html
- https://csrc.nist.gov/pubs/sp/800/218/final
- https://mof.gov.ae/en/about-us/initiatives/einvoicing/
