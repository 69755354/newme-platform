# NewMe 04 — UAE SaaS pricing and commercial model

**Decision status:** User-delegated commercial baseline; repository acceptance/merge and all implementation remain pending, and no production pricing is asserted by this document.
**Prepared:** 30 July 2026 (Asia/Shanghai). **Currency:** AED. All prices below are **before UAE VAT**; add VAT when legally chargeable.
**Audience:** NewMe product, commercial, finance and implementation leads.
**Scope:** UAE launch for (1) real-estate brokerages and (2) multi-store retail. This is a control-plane and quote policy, not a change to the deployed application.

## Executive decision

Adopt a **platform fee + active operating-seat + location + bounded usage** model. Charge organizations, not every viewer; bill people who can create, change, approve, export sensitive data, or trigger automations. Include one industry package per subscription, then meter only the scalable cost/value drivers: additional operating seats, locations, AI credits, and industry transactions above a generous included allowance.

This model fits the evidence better than pure per-seat pricing: the brokerage requirements use role-scoped controls, listings, leads and compliance gates; the retail requirements use company/branch/location scope, inventory, orders, COD and finance controls. It retains predictable budget ownership while avoiding unlimited AI and high-volume operational load being subsidized by small customers.

## Product facts that constrain the offer

| Fact category | Existing requirement / evidence | Commercial implication | Status |
|---|---|---|---|
| Brokerage workflow | Lead intake, 10-stage pipeline, listing readiness, documents/media, offers, deal approval, commissions/payroll and role-specific workspaces are described in the Axon PRD. | Monetize a brokerage operating package, not generic contact storage. | User-supplied requirement; not a NewMe production claim. |
| Retail workflow | Company/branch/location scope; catalog, inventory, pricing/discount approval, quotation, delivery/COD and finance controls are described in the International City handoff. | Location and transaction allowances belong in retail packaging. | User-supplied requirement; not a NewMe production claim. |
| Tenant controls | The handoff says Business, Branch, Location, Membership, Role/Permission and RLS baseline exist, but lifecycle, subscription/usage billing and admin control plane are TARGET. | Do not sell automated billing or enterprise SSO as live until acceptance proves them. | CURRENT/PARTIAL/TARGET labels from handoff. |
| SAM-18 product boundary | Canonical `81ac9fcf00696a6e1b6e026f69662e49ec2f6015` contains [`SAM-18-saas-product-boundary.md`](./SAM-18-saas-product-boundary.md), blob `94a45599582885507ad789d190f237230fc57a60`. It defines platform/organization roles, paid-seat eligibility and deterministic counting, organization/industry isolation, lifecycle controls, and a prior 5 / 20 / 50+ paid-seat package table. | Preserve its role, seat-counting, isolation and fail-closed principles; resolve its superseded commercial numbers explicitly below. | Product decision marked “已定案，待实施”; it is not implementation or live-service evidence. |
| SAM-19 data-model authority | The same canonical commit contains [`SAM-19-organization-membership-data-model.md`](./SAM-19-organization-membership-data-model.md), blob `f6d968456fa82034afca2679d012feaa9bec4560`. It defines the target `organizations`, `memberships`, role links, organization ownership/constraints, support access, audit, phased migration and rollback boundaries. | Product implementation must consume this organization/membership model; this pricing record does not redefine schema or authorization ownership. | Design marked “设计定案，待分阶段实施”; it is not a migration and does not prove a live database state. |

## Decision authority and conflict resolution

Under the user's delegated NewMe 04 decision, this record is the commercial baseline for product implementation, sales quoting, and the separate SAM-29 and SAM-30 acceptance mappings. It is a scoped follow-on decision to SAM-18 and SAM-19, not evidence that either design or this commercial policy has been implemented or deployed.

| Topic | Governing rule after this decision | Explicit relationship to SAM-18 / SAM-19 |
|---|---|---|
| Public plans and included paid seats | Starter / Growth / Scale use AED 499 / 1,299 / 2,999 monthly and include 3 / 10 / 25 operating seats. | These commercial values supersede SAM-18 §5.1's 5 / 20 / 50+ paid-seat values. |
| Organization and industry package allowance | A base subscription covers one organization with exactly one primary industry. A second-industry add-on provisions a second isolated organization; other additional organizations require a separate subscription or Enterprise order form. | This commercial allowance supersedes SAM-18 §5.1's package-level organization quantities, but preserves SAM-18 §2's account/organization ontology and one-industry-per-organization isolation. |
| Seat eligibility and counting | “Operating seat” is the commercial label for a SAM-18 paid seat: an accepted, active organization membership holding at least one billable organization role. One person with multiple paid roles in one organization counts once; the same person in two organizations counts once in each. Pending, inactive, suspended, platform and non-human identities do not count as human paid seats. | SAM-18 §§3–4 remain authoritative for role names, free `viewer` / `portal_user` boundaries, deterministic counting and service-account separation. |
| Extra seats and hard limits | A customer must explicitly purchase the listed one-seat add-on before a new paid membership is activated or restored above the included limit. No silent or retroactive seat overage is allowed. | The one-seat add-on prices in this record supersede SAM-18 §5.2's five-seat-pack granularity; its block-on-limit and no-silent-charge behavior remains binding. |
| Data ownership and authorization | `organization`, `membership`, role-link, support-session, audit and organization-key constraints follow SAM-19. | SAM-19 remains the data-model source of truth; this record changes no schema, RLS, API or migration fact. |

If a future document changes these commercial values, it must name both this record and the superseded field. Silence never overrides SAM-18's preserved product principles or SAM-19's data-model authority.

## Recommended public price card

Annual price is payable in advance and is exactly 20% below the equivalent monthly recurring charge. Prices exclude VAT. The base subscription covers **one organization with one primary industry package** (Brokerage or Retail). Adding the second package is a paid add-on that provisions a second isolated organization, never a feature toggle that mixes both industries inside one organization.

| Plan | Monthly | Annual effective monthly | Included operating seats | Included locations | Included AI credits/month | Best fit |
|---|---:|---:|---:|---:|---:|---|
| Starter | AED 499 | AED 399 | 3 | 1 | 300 | Single office / single store |
| Growth | AED 1,299 | AED 1,039 | 10 | 3 | 2,500 | Departmental team / small chain |
| Scale | AED 2,999 | AED 2,399 | 25 | 10 | 7,500 | Multi-team brokerage / regional retailer |
| Enterprise | Quote; floor AED 6,000/month on annual contract | Custom | Custom | Custom | Contracted | SSO, bespoke integration, residency/support needs |

### What is and is not a billable seat

An **operating seat** is this record's commercial label for the SAM-18 paid seat: a named human with an accepted, active organization membership and at least one of `org_owner`, `org_admin`, `manager`, `sales_agent`, `operations`, `finance`, or `specialist`. The same person holding several paid roles in one organization consumes one seat; the same person active in two organizations consumes one seat in each. Pending, inactive and suspended memberships, platform roles, and non-human identities do not count. Deactivation releases the entitlement seat immediately, while the paid current period is not automatically refunded and the financial reduction applies at the next renewal.

**Read-only seats:** included at no charge up to 5 / 20 / 75 on Starter/Growth/Scale; may view only authorized records and reports. They cannot export, approve, initiate a workflow, access restricted fields, run AI or create external messages. Extra read-only seats are AED 25/month each.
**External users:** customer, vendor, landlord, tenant, applicant and driver portal identities are not operating seats if they are limited to their own records and cannot access admin/report/export/AI functions. Their portal design must preserve tenant and role isolation.
**Service accounts:** one non-human integration identity per paid location is included; extra identities are AED 50/month and require scoped API credentials/audit. They are never a way to pool or evade named-user limits.

### Overage and add-on price book

| Meter | Starter | Growth | Scale | Rule |
|---|---:|---:|---:|---|
| Extra operating seat / month | AED 149 | AED 129 | AED 109 | Explicit purchase before activation/restoration; prorated on upgrade; no silent overage or shared accounts. |
| Extra location / month | AED 199 | AED 179 | AED 149 | A branch/store/warehouse that has separate stock, operational scope or reporting; a retail plan may add a warehouse as a location. |
| Extra AI credit | AED 0.12 | AED 0.10 | AED 0.08 | Credits do not roll over; default hard cap, customer must opt into auto-top-up. |
| Brokerage qualified lead above included allowance | AED 0.50 | AED 0.40 | AED 0.30 | Count once when an inbound/manual/imported lead becomes a non-archived qualified lead; duplicates and test records excluded by auditable rule. |
| Retail completed order above included allowance | AED 0.12 | AED 0.10 | AED 0.08 | Count once at completed/fulfilled order; cancelled, test and duplicate/idempotent replays excluded. No payment percentage. |
| Second industry package + isolated organization | AED 299 | AED 499 | AED 799 | Provisions one second organization at the contracted tier for the other primary industry; roles, seats and data are counted and isolated per organization. |
| Premier support | — | AED 500/month | AED 1,000/month | Named admin support, response target and quarterly review; contract terms govern. |

No percentage-of-GMV, commission, payment-processing, or COD fee is recommended for launch. NewMe should not take a transaction fee until it is the merchant/broker-of-record or provides a regulated payment service. This avoids an unclear tax/payment role and makes price predictable.

## Included limits and industry packages

Common platform layer in every paid plan: tenant/company separation; membership/roles/permissions; audit trail; CRM/contact activity; files/documents within fair-use storage; dashboards/reports; quotation drafts; approval workflow; import/export subject to authorization; Arabic/English readiness target; VAT-aware invoice fields; and API/webhook boundaries where the plan enables them. Each organization activates only its contracted primary-industry package. “Included” means product entitlement, **not proof that every item is implemented today**.

| Capability / allowance per month | Brokerage package: Starter / Growth / Scale | Retail package: Starter / Growth / Scale |
|---|---|---|
| Active operational records | 1,000 / 10,000 / 50,000 active leads + contacts; archive is retained but not operationally searchable at Scale policy limits | 2,500 / 15,000 / 75,000 active SKUs + customers; archived records retained under policy |
| Industry volume included | 150 / 1,000 / 5,000 qualified leads | 1,000 / 10,000 / 50,000 completed orders |
| Primary operating objects | 50 / 250 / 1,000 active listings | 1 / 3 / 10 locations already included in plan; stock locations count as locations |
| Automation | Core alerts / 25 workflows / 100 workflows | Core alerts / 25 workflows / 100 workflows |
| Industry workflows | Lead routing, listings, documents/media readiness, viewings/offers/deals, approval and commission/payroll controls | Catalog/inventory, price/discount approval, quotation drafts, transfer/replenishment, delivery/COD and finance controls |
| Advanced controls | Compliance checklist and audit export | Approval/audit controls and COD handover state |
| API / SSO | API not included / API included / API + sandbox target | API not included / API included / API + sandbox target |

### Capability gates by tier

Starter is deliberately usable but controlled: core workflow, audit and basic reports; no customer-specific integration commitment. Growth enables configurable workflows, multi-location management, API access and advanced reporting. Scale adds richer control boundaries, sandbox target, priority support option and high-volume limits. Enterprise is the only tier that may contract SSO, custom retention/residency, bespoke integrations, a named success plan or a support SLA.

## Commercial terms and lifecycle

### Trial, early adopter and price protection

* **Trial:** 14 days, one organization, restricted sample/import mode, no charge. A trial cannot send customer-facing messages or activate paid integrations without a verified administrator and accepted terms.
* **Early adopter:** first 20 UAE customers may receive 25% off the platform fee for 12 months on annual Growth or Scale contracts. Seat, location, AI and volume overages remain at list price. No stacking with partner/reseller discounts.
* **Price protection:** annual renewals may increase the platform fee by at most 10% after the initial term, with 60 days’ written notice; usage overages may change at renewal with the same notice. Enterprise has its signed order-form terms.
* **Refunds:** month-to-month charges are non-refundable after service activation except billing error or applicable law. Annual plans have a 14-day refund window only if no production data import, integration activation or implementation work has started; otherwise unused annual fees are not refunded on downgrade/cancellation, but remain usable through the paid term. This is a policy recommendation requiring legal review.

### Invoice, delinquency, suspension and recovery

1. Invoice monthly in advance (or annually in advance); usage closes on the calendar month and is billed in arrears. Show usage at 80%, 100% and cap reached.
2. Due date is 7 calendar days after invoice issue unless the signed enterprise agreement says otherwise. At day 1 overdue, notify billing admins; at day 7, freeze upgrades and paid add-ons.
3. At day 14 overdue, switch the tenant to **read-only**: preserve access to export authorized data and pay the invoice, but stop writes, AI, external sends, APIs/webhooks and scheduled automation. Never silently delete or expose data.
4. At day 30 overdue, **suspend sign-in and processing** except the billing/admin recovery route. Retain data for 90 days from suspension, then queue deletion according to the contract and data-protection/legal-hold policy. Do not promise deletion timing until counsel/retention policy approves it.
5. Restore read-write after all overdue amounts and any agreed reinstatement fee are paid, normally within one business day; restore does not erase audit evidence. Proposed reinstatement fee: AED 250 for Starter/Growth, AED 500 for Scale, Enterprise per contract. Any restored data requires integrity checks.

## Three indicative monthly bills (ex VAT)

These are calculation examples, not customer quotations. VAT at 5% is shown separately because the FTA says the general rate is 5% unless an exemption/zero rate applies.

| Customer profile | Calculation | Subtotal ex VAT | VAT (5%, illustrative) | Total incl. VAT |
|---|---|---:|---:|---:|
| 5-seat Dubai brokerage, one office, 200 qualified leads, 400 AI credits | Starter 499 + 2 seats × 149 + 50 leads × 0.50 + 100 credits × 0.12 | AED 834 | AED 41.70 | AED 875.70 |
| 12-seat retailer, 4 locations, 10,500 orders, 3,000 AI credits | Growth 1,299 + 2 seats × 129 + 1 location × 179 + 500 orders × 0.10 + 500 credits × 0.10 | AED 1,836 | AED 91.80 | AED 1,927.80 |
| 30-seat brokerage, 12 locations, 5,500 qualified leads, 8,000 AI credits | Scale 2,999 + 5 seats × 109 + 2 locations × 149 + 500 leads × 0.30 + 500 credits × 0.08 | AED 4,029 | AED 201.45 | AED 4,230.45 |

## Unit economics and sensitivity — provisional

No NewMe hosting, support, model, payment or implementation cost data was provided. The figures below are **assumptions, not measured margins**, and must be replaced by actual cost-to-serve before final approval.

| Variable | Base assumption | Sensitivity | Gross-margin / policy implication |
|---|---:|---:|---|
| AI variable cost per credit | AED 0.025–0.075; base 0.045 | At AED 0.075, Scale AI overage margin is 6.25% (0.08 minus 0.075) before support. | Keep a hard cap and review the Scale AI overage quarterly; do not offer unlimited AI. |
| Platform + storage + monitoring per active operating seat | AED 15–35/month; base 25 | A 3-seat Starter has AED 424 base fee after estimated AED 75 seat infrastructure; implementation/support can still erase margin. | Require paid onboarding except self-serve low-complexity imports. |
| Support/success time | 0.5–3 hours/month for Starter/Growth; 2–8 for Scale | At AED 150 fully loaded/hour, 3 hours costs AED 450. | Segment support and charge Premier/Enterprise for high-touch service. |
| One-time implementation labor | 4–16 / 16–40 / 40–120 hours for Starter/Growth/Scale | At AED 150/hour, cost ranges AED 600–18,000. | Quote onboarding by scope; never bury migration/integration labor in MRR. |

**Recommended margin gate:** do not approve a contract whose modeled recurring gross margin is below 70% at base cost or below 55% at the high AI/support case. For the two AI-heavy examples, the proposed overage is especially fragile at the high-cost assumption; a product owner should either raise Scale AI overage, reduce included credits, or negotiate enterprise committed usage before signing.

## Onboarding and implementation menu

| Package | Price ex VAT | Included outcome | Guardrail |
|---|---:|---|---|
| Self-serve Launch | AED 0 | Guided setup, templates, one administrator training | No migration, custom role design or integration. |
| Assisted Launch | AED 2,500 | Up to 10 operating seats, CSV migration up to 10k rows, role mapping and one training session | Starter/Growth only; excludes data remediation. |
| Growth Implementation | AED 7,500 | Up to 3 locations, 25 users, workflow/configuration workshop, migration up to 50k rows, two trainings | Written acceptance checklist required. |
| Scale Implementation | AED 18,000 from | Multi-location discovery, migration plan, integrations and role/approval design | Fixed scope only; change order for custom work. |
| Enterprise | Quote | SSO/integration/governance/rollout plan | Requires security and data-processing review. |

## Regulatory product requirements, not legal advice

* UAE VAT: show prices ex VAT in sales material; calculate, store and issue invoice tax fields correctly where taxable. The FTA’s published general rate is 5%.
* UAE eInvoicing: the MoF defines eInvoices as structured data, not PDFs/emails, and publishes the evolving programme. Build an invoice data model and export/integration boundary now; do **not** claim NewMe is an accredited service provider or compliant transmitter unless separately verified. The current MoF page says its portal is the official information source.
* PDPL: collect only necessary personal data; support role/field controls, audit, correction/restriction/deletion requests and cross-border-transfer assessment. The UAE official portal describes Federal Decree-Law No. 45 of 2021 as governing personal-data confidentiality, processing controls and cross-border transfers.
* Dubai brokerage: the DLD provides a Trakheesi permit/license verification service and DLD says advertisement QR verification through Madmoun is required for relevant advertisements. Keep permit, expiry, source validation result and QR/advertisement evidence fields; block publication on invalid/missing evidence according to the customer’s legal policy. Do not represent an internal checklist as DLD approval.

## Implementation acceptance backlog

Before this price card can be sold as a live subscription, product must demonstrate the following in a non-production acceptance environment:

1. Tenant lifecycle: provision, verified initial administrator, plan/entitlement change, suspend, restore, export and retention/deletion workflow.
2. Entitlement enforcement: operating/read-only/external identities; seat counts; location counts; plan gates; industry-package gate; no shared-account bypass.
3. Meter ledger: immutable tenant-scoped monthly counts for credits, qualified leads and completed orders; idempotency and exclusion rules; visible 80/100% alerts; invoice-ready export.
4. Billing safety: tax-exclusive price, VAT line, invoice status, dunning state machine, read-only/suspension behavior and reinstatement audit; no destructive suspension.
5. Vertical controls: brokerage publication compliance evidence and self-approval block; retail company/branch/location scoping, COD handover/finance separation and sensitive-field restrictions.
6. Security/privacy: RLS/negative tenant tests, role/field tests, audit retention, authorized export, support-access controls and data request workflow.

## SAM-29 — retail requirements and industry boundary: acceptance mapping

SAM-29 is owned by this decision record before SAM-30. Its acceptance is **not** satisfied by a generic “retail supported” assertion.

| SAM-29 acceptance item | Decision / implementation evidence required | Source basis | Acceptance boundary |
|---|---|---|---|
| Retail package is distinct from the brokerage package | Retail package names catalog/inventory, price/discount approval, quotation drafts, transfer/replenishment, delivery/COD and finance controls; the brokerage package retains its lead/listing/deal/compliance workflow. | International City workflow, sales/pricing, delivery/COD and multi-tenant handoff documents; Axon PRD/workflows. | An organization may activate only its contracted primary package; the second-package add-on must create a second isolated organization. |
| Location is a retail commercial and authorization boundary | Location definition includes branch/store/warehouse with separate stock, operational scope or reporting. Included 1/3/10 and priced additional locations are explicit. | International City multi-store model and SaaS multi-tenant requirements. | Company/tenant is never inferred from branch/location; cross-tenant access must fail. |
| Retail volume meter is safe and auditable | Count a completed/fulfilled order once; exclude cancelled, test, duplicate and idempotent replays; record tenant-scoped immutable monthly meter data. | International City acceptance scenarios require idempotency, tenant scoping and audited outcomes. | No percentage-of-GMV, payment or COD fee at launch. |
| Retail role/financial safety stays out of pricing shortcuts | Sales cannot see costs; over-limit discounts become approval; drivers cannot confirm COD receipts; finance confirms handover. | International City roles, quotation, COD/finance and acceptance scenarios. | No plan downgrade or read-only state may bypass approval, field restriction or audit requirements. |
| Retail launch claim is bounded | Package language is “entitlement target” until acceptance proves controlled data, permissions, audit and workflows. | Handoff explicitly distinguishes CURRENT/PARTIAL/TARGET. | Sales must not describe target functionality as already live. |

**SAM-29 acceptance evidence to attach:** tenant/branch/location negative tests; role/field fixtures; order-meter replay test; completed/cancelled-order classification test; retail package entitlement test; and a signed product review of the package-to-workflow matrix above.

## SAM-30 — provisioning, seats, suspension, exit and first-customer operations: acceptance mapping

SAM-30 follows SAM-29 and is separately testable. It is **not** satisfied merely by publishing a price list.

| SAM-30 acceptance item | Decision / implementation evidence required | Risk controlled | Rollback / recovery |
|---|---|---|---|
| Provisioning and first administrator | Create a tenant with verified initial administrator, chosen plan/industry package, billing owner and audit event. | Unowned tenant, wrong package or cross-tenant exposure. | Disable incomplete tenant before data import; preserve provisioning audit. |
| Seat and external-user rules | Enforce named operating-seat count, free scoped viewers/external users, deactivation, service-account limits and no shared-account bypass. | Revenue leakage and excess privilege. | Revert erroneous entitlement change from immutable change log; do not delete identities. |
| Usage, invoice and alerts | Immutable monthly meter ledger; 80/100% notices; default AI hard cap; invoice lines distinguish platform, seat, location, usage, VAT and implementation. | Surprise charges, un-auditable invoices and runaway AI cost. | Freeze auto-top-up; correct invoice with auditable credit/debit, not meter deletion. |
| Non-payment state machine | Day 1 notice, day 7 commercial freeze, day 14 read-only, day 30 suspension, 90-day proposed retention and documented exceptions. | Data loss, silent business interruption and unsafe processing. | Read-only is reversible; restore after payment/integrity checks; never purge before approved retention/legal-hold workflow. |
| Exit, export and deletion | Authorized export, retention/deletion request workflow, legal hold and cross-border/privacy review; no claim of a fixed deletion SLA until approved. | PDPL/data-contract non-compliance. | Pause deletion on legal hold or verified dispute; retain auditable decision. |
| First-customer launch operations | Trial guardrails, early-adopter eligibility, onboarding package scope, acceptance checklist, support escalation and margin gate are documented for sales and implementation. | Underpriced high-touch pilots and unsupported contractual promises. | Stop rollout/upgrade customer to paid implementation or Enterprise scope when the acceptance checklist fails. |

**SAM-30 acceptance evidence to attach:** lifecycle test run for provision → entitlement → usage → overdue read-only → suspend → pay → restore → authorized export; invoice fixture with VAT line; audit log for every transition; retention/deletion simulation without production data; and a pilot margin review using measured, not provisional, costs.

## Evidence and comparability notes

Research was captured 30 July 2026 from official vendor/government pages. Public vendor prices are displayed in USD or local currency, may be annual effective prices, promotional, region-specific, exclude tax, include different limits, or require onboarding. They are **model evidence only**, not a UAE price benchmark or a currency-converted competitor comparison.

| Vendor | Public model observed | What it supports | Comparability warning |
|---|---|---|---|
| HubSpot Sales Hub | Per-seat tiers; view-only seats at no cost; included credits and paid credit overage; onboarding on higher tiers. | Paid operator seats + free viewer tier + AI usage. | USD; plan/seat definitions vary. |
| Salesforce Sales Cloud | Per-user/month tiered Sales Cloud pricing. | Per-user vertical CRM is established. | USD; feature bundling differs. |
| Pipedrive | Per-seat tiers, annual savings, 14-day trial; company-billed add-ons; implementation condition. | Tier + seat + optional company add-on + trial. | USD and promotions; exact tiers can change. |
| Zoho CRM | Per-user editions, free tier, annual savings and local taxes added. | Tax-exclusive disclosure and edition gating. | Page can localize currency; product suite differs. |
| monday CRM | Plan + seats, quoted enterprise above 40 users, AI credits and annual discount. | Seat-based tier plus credits/enterprise custom. | Minimum seats and feature caps differ. |
| Shopify | Tiered subscription, included staff accounts, location/POS add-on and payment rates. | Location and transaction/payment models can coexist. | Merchant/payments model; NewMe is not a payment processor. |
| Buildium | Tiered property-management plan, per-document/screening/payment fees and mandatory onboarding on higher plans. | Vertical usage and implementation fees. | US property-management economics; not a Dubai brokerage equivalent. |
| Lightspeed Retail | Retail plan determines available features and price point. | Retail feature-tier gating. | Current public price is region-dependent; no price used. |

### Source register

* Repository product decision [`SAM-18-saas-product-boundary.md`](./SAM-18-saas-product-boundary.md) at canonical `81ac9fcf00696a6e1b6e026f69662e49ec2f6015`, blob `94a45599582885507ad789d190f237230fc57a60`; used for product boundary, roles, paid-seat calculation, organization/industry isolation, lifecycle and the explicitly superseded §5 commercial limits.
* Repository data-model decision [`SAM-19-organization-membership-data-model.md`](./SAM-19-organization-membership-data-model.md) at the same canonical commit, blob `f6d968456fa82034afca2679d012feaa9bec4560`; retained as the organization/membership/schema authority and explicitly marked unimplemented.
* User-provided `Axon_ClawTeams_Delivery_2026-07-27.zip`, SHA-256 `3ABE9E8280FD88CD150477E71A9E70A790CAD128798F492639AB17D0EC812B08`. Read: Executive Summary; PRD and Business Requirements; Feature Matrix and Current Status; Technical Architecture; Axon Broker OS Business Workflows; Known Issues and Next Steps. Video and `__MACOSX` metadata excluded.
* User-provided `International_City_OS_ClawTeams_Handoff_2026.zip`, SHA-256 `58D5A9ACB194CEA3CB1ABE1800653F53448BAAD4FA7409F754C2FB6B2AD5978C`. Read: Executive Overview; Scope/Positioning; Multi-Store Model; Roles/Permissions; End-to-End Workflows; Sales/Pricing/Quotation; Delivery/COD/Finance; SaaS Multi-Tenant; Implementation Roadmap; Acceptance Scenarios.
* Official pricing: HubSpot Sales Hub, Salesforce Sales Cloud, Pipedrive, Zoho CRM, monday CRM, Shopify, Buildium and Lightspeed Retail pages (links in the accompanying report artifact).
* Official UAE sources: FTA VAT FAQ; MoF eInvoicing portal; UAE Government PDPL page; Dubai Land Department Trakheesi verification service and Madmoun announcement (links in accompanying report artifact).
