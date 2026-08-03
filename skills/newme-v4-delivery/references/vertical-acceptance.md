# Vertical Acceptance

## Shared versus vertical contracts

Share organization, membership, capability, plan, entitlement, usage, approval, audit, files, tasks, notifications, idempotency, integrations and outbox primitives.

Keep separate state machines and records for:

- real estate: party/landlord, property/listing, lead/matching, viewing, property offer, deal, commission/payroll and publish readiness;
- retail: topology, product/SKU/variant, inventory movement, transfer/stocktake, price/discount/VAT, quotation, order, procurement, delivery/COD, AR/refund and reporting.

## Common acceptance dimensions

For each commercial slice require:

- two organizations and all applicable active/inactive role/capability cases;
- positive end-to-end state transitions and terminal-state denials;
- wrong-organization/direct-ID/search/export/storage negatives;
- deterministic totals, idempotency and reconciliation;
- actor separation for approvals, money, inventory and handover;
- immutable audit and tenant-aware telemetry;
- exact fixture IDs/markers, dependency-aware cleanup and zero residue;
- exact release SHA and environment binding.

## Real-estate slice

Prove owner/listing readiness→lead/match→viewing→offer/counter/accept/reject/expiry→single deal conversion→commission approval/settlement. Verify listing ownership, document/media readiness, cancellation, expiry, terminal edits, split totals and payroll settlement.

## Retail slice

Prove organization/store/warehouse topology→SKU resolver→inventory movements/transfers/stocktake→deterministic price/VAT/discount→quotation→single order conversion→procurement/receipt→delivery/COD→finance confirmation/refund. Verify unknown/ambiguous SKU, zero/negative inputs, stock conservation, approval limits and warehouse/driver/finance separation.

## External adapters

Keep portal, WhatsApp, DLD, POS, ERP, accounting and payment adapters disabled until credentials, consent, policy, sandbox behavior, retries, replay protection, reconciliation, observability and rollback pass.
