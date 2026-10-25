# Guarded Meta CRM lead-stage schema provisioning

Adds the schema used by the Meta Conversion Leads feedback (PR #483):
`leads.meta_leadgen_id` (nullable, unique when set) and the service-only outbox
`meta_crm_stage_events` (RLS on, no client table rights, current-session
statement trigger). Nothing here has been applied to production.

## Gate

`meta-crm-plan` / `meta-crm-provision` follow the existing additive-suffix
pattern (`meta-ads-*`, `meta-capi-*`). `scripts/check-meta-crm-provisioning.mjs`
refuses unless:

- the live database is in `strict` mode and both releases declare `strict`;
- the required prefix and every prior manifest declaration are unchanged;
- the only change is one deferred entry (this exact SQL hash) plus one posture
  predicate (`meta-crm-lead-stage-schema-present`);
- the database is either untouched (unrecorded, no column, no table) or fully
  provisioned and recorded. A partial or unrecorded schema is refused.

The wrapper additionally re-verifies the live deferred phase, the canonical main
SHA and a fresh CI gate, exactly as for CAPI.

## Order

1. Provision CAPI first (`meta-capi-plan`/`meta-capi-provision`) from the release
   that adds only the CAPI suffix; that gate accepts exactly that transition.
2. Deploy that release; it becomes the live release.
3. From the release containing this change run `meta-crm-plan`, then
   `meta-crm-provision`. Re-run release acceptance.
4. Only then merge/deploy the application code in PR #483.

## Evidence (local, not production)

PostgreSQL 17.11 throwaway cluster: `MODE=branch` replay — 32 migrations,
350/350 release assertions, 54 post-rollback, 19 post-recontract; `MODE=control`
OK. The posture predicate reads `true` after apply and the prior predicate
`false`; on a database without the schema the values invert.
