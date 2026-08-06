# NewMe V4 — project brief and delivery status

## What this project is

NewMe V4 is the next-generation NewMe operating-system foundation: a
UAE-focused, multi-organization SaaS for two initial verticals:

- **real estate**: owner/listing, lead and matching, viewing, offer, deal,
  commission and publication-readiness workflows; and
- **retail**: catalog/SKU, inventory, pricing/VAT, quotation, order,
  procurement, delivery and finance workflows.

It replaces single-tenant or customer-specific delivery patterns with one
shared platform, organization isolation, explicit roles and entitlements,
auditable workflows, and vertical capability packs. The supplied Axon and
International City materials informed the domain requirements; their runtime
implementations were not copied into V4.

## What has been delivered

The repository has a verified **bounded staging commercial slice**:

1. tenant identity, membership, role/capability and customer-exit controls;
2. plan, subscription, paid-seat, entitlement, quota, lifecycle and manual
   invoice-reference controls;
3. tenant-safe shared workflow, import/export, storage, outbox and operational
   primitives;
4. real-estate and retail business slices, including controlled agent and
   integration boundaries; and
5. exact-SHA staging build/deploy/UAT evidence with fixture cleanup and a
   direct application rollback release.

The current repository handoff baseline is
`agent/saas-staging-isolation@94f0b4018e6f2d41a288db5d3c10edbdfbea9b47`.
The verified deployed staging release is
`83c4b6f3a14bb248db263ba8d727e00f6c0b70fe`; its direct staging rollback
release is `683e841e7b5c684b5cebdb05dbc17b7ae35c6929`.

## Current stage

**Stage: staging-commercial acceptance complete; operational rehearsal and
design-partner validation remain.**

This is not a production approval. A successful staging UAT proves only the
scoped release, project, test fixtures and cleanup described in the acceptance
record. It does not prove production data migration, live billing, operational
alert ownership, backup recovery, capacity under customer load, or commercial
operation with real customers.

## Remaining work before a commercial claim

| Linear item | Outcome still required |
| --- | --- |
| SAM-85 | separately approved isolated non-production clone; masked import, migration/rollback, reconciliation and destruction evidence |
| SAM-86 | alert ownership/delivery, backup/PITR restore RPO/RTO, load/noisy-neighbor evidence, credential and incident rehearsal |
| SAM-88 | authorized real-estate and retail design-partner operations with provision, support, billing boundary, exit and restore evidence |

No item above may be closed with a static test, a document, a demo, or a shared
staging run alone.

## Evidence and operating instructions

- [Full V4 PRD](V4_SAAS_PRD.md): product scope, principles, roles and gates.
- [Requirements traceability](V4_REQUIREMENTS_TRACEABILITY.md): source-to-
  requirement-to-delivery mapping.
- [Staging commercial acceptance](V4_STAGING_COMMERCIAL_ACCEPTANCE.md):
  exact deployment, migration and UAT boundary.
- [Production Go/No-Go](V4_PRODUCTION_GO_NO_GO.md): separate production
  decision and remaining blockers.
- [Operator handoff](V4_HANDOFF_2026-08-06.md): precise Git/Linear/staging
  continuation and safety instructions.

## External statement that is accurate today

> NewMe V4 has a verified staging-commercial SaaS foundation for real estate
> and retail. It is ready for controlled operational rehearsal and
> design-partner validation. It is not yet approved for production deployment
> or general commercial availability.

