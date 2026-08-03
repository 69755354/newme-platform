# Tenant Data and Migrations

## Tenant ownership

For every tenant-owned record require an immutable `organization_id` or an equally strong composite ownership path. Enforce organization consistency with foreign keys, constraints and policies rather than application convention.

Authorize server-side using active profile, active membership, capability, organization ownership, vertical entitlement, quota and lifecycle state. Cover direct-ID reads/writes, search, export, imports, workers, cron, storage and RPCs. Deny client-supplied tenant or actor authority.

## Required negative matrix

Test unauthenticated, inactive profile, inactive membership, wrong capability, wrong organization/direct ID, disabled vertical, quota exceeded, invalid state transition, duplicate idempotency key, malformed/oversized/prototype-polluted input, worker context spoofing and cleanup failure where applicable.

## Migration package

Keep forward SQL, verification, generated types and executable rollback or approved restore-only boundary in the same work package. Apply the complete migration chain to a disposable supported PostgreSQL instance.

Before staging mutation:

1. read exact migration history and target schema;
2. identify only missing exact versions;
3. verify object owners, grants, policies, indexes, functions and compatibility;
4. set bounded lock and statement timeouts;
5. execute in version order with fail-fast behavior;
6. verify schema, grants, policies, types and application compatibility;
7. record exact versions and evidence.

Do not use conflict-ignore behavior to hide partial schema. Do not delete migration history without the matching object rollback. Do not execute a migration file's top-level transaction inside another transaction without deliberately and safely handling its boundary.

## Rollback

Document whether the previous application can run on the new schema and whether the new application can run on the previous schema. Roll back objects and migration history in one controlled unit, in reverse dependency order. If data loss is possible, use an approved restore/corrective-forward boundary instead of an invented reverse migration.

## Production-data rehearsal

Never copy raw production data to shared staging. Use an isolated ephemeral clone with named approval, clone-only credentials, outbound integrations disabled, masking/tokenization before application access, bounded retention, aggregate reconciliation and verified destruction. Record no customer PII or credentials in Git, CI or audit reports.
