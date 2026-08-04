# V4-09 Migration, Import and Reconciliation Rehearsal

Status: versioned execution contract; rehearsal not executed
Linear: SAM-85
Requirement: V4-MIG-001
Release gates: G2 and G7

## 1. Claim boundary

This runbook and `scripts/v4-rehearsal-kit/` prepare and validate an authorized rehearsal. They do not prove that a clone was created, data was masked, migrations ran, reconciliation passed or resources were destroyed. Only a `newme.v4.sam85-migration-rehearsal.v1` evidence document accepted by the validator may support those claims.

Raw production data is prohibited in shared staging, developer worktrees, Git, CI artifacts and ticket comments. The only permitted production-derived rehearsal target is a separately approved, isolated and time-bounded clone. Supabase preview branches are data-less by design; use synthetic seed data unless the isolated-clone approval below exists.

## 2. Named approval manifest

Before any snapshot is restored, record only references and digests, never credential values or customer records:

- snapshot reference, SHA-256 and encryption status;
- purpose code `v4-migration-rehearsal` and exact table/object scope;
- accountable owner, operator and independent reviewer role references;
- approved time, expiry and identical destroy-by time;
- isolated clone reference and network boundary;
- clone-only credential references and explicit production-credential denial;
- database, storage, logs and export retention locations;
- the exact Git release SHA, tree and ordered forward/rollback asset hashes.

STOP if approval is pending, expired, broader than the declared scope, contains credential values, names shared staging, or allows a production write route.

## 3. Outbound kill switches

Before application access, block all five channel families at three layers:

| Channel | Configuration | Network | Runtime verification |
|---|---|---|---|
| email | no SMTP/provider credential or endpoint | deny egress to provider | synthetic send is blocked |
| messaging | no WhatsApp/SMS credential or endpoint | deny provider egress | synthetic send is blocked |
| webhook | no production webhook target or signing secret | deny arbitrary egress | synthetic delivery is blocked |
| portal | no publishing credential or production endpoint | deny portal egress | publish attempt is blocked |
| payment | no gateway credential or production endpoint | deny gateway egress | charge/refund attempt is blocked |

Each check records only a UTC time and SHA-256 evidence digest. Any enabled channel, production endpoint, credential value or check after application access is a STOP.

## 4. Masking and tokenization

1. Keep application access disabled.
2. Validate the mapping manifest and its stable digest.
3. Use at least 32 bytes of run-scoped token key material from the approved clone secret store; never put it in arguments, logs, evidence or Git.
4. Tokenize identifiers and join keys with a namespace-bound keyed digest.
5. Tokenize/hash/redact/drop names, email, phone, address, documents and free text; copying these classes is rejected.
6. Preserve financial and audit semantics; dropping, redacting or replacing them with a constant is rejected.
7. Reject prototype keys, unknown table sets, missing mapped fields and unsupported transformations.
8. Retain only masked target rows inside the clone and token-only quarantine references. Retain only aggregate counts and digests outside it.

Synthetic offline verification:

```text
npm run check:v4-migration-rehearsal
node scripts/v4-rehearsal-kit/cli.mjs validate-sam85-template scripts/v4-rehearsal-kit/examples/synthetic-sam85-template.json
```

These commands exercise tooling only and must retain `claimsExecuted: false`.

## 5. Migration, backfill and quarantine

1. Verify the exact ordered migration list and SHA-256 of every forward and rollback asset.
2. Apply forward assets once in declared order with bounded lock/statement timeouts.
3. Run backfills in bounded batches with resumable checkpoints and idempotency keys.
4. Quarantine every unmapped owner, duplicate global identifier, missing required field or invalid relationship. Do not silently coerce ownership.
5. The aggregate equation for every job is `sourceCount = migratedCount + quarantinedCount`.
6. Roll back in the exact reverse order in the same isolated clone, then reapply to prove repeatability.

STOP on migration-history drift, partial apply, missing rollback asset, count mismatch, raw quarantine export, uncontrolled lock wait or non-idempotent repeat.

## 6. Reconciliation and UAT contract

For every migrated entity, record:

- source, target and quarantined counts with `source = target + quarantined`;
- a named stable projection whose before/after SHA-256 digests match;
- aggregate quarantine reason counts and a token-only ledger digest;
- exact release/run/mapping bindings;
- forward, rollback and backfill statuses;
- the five outbound channel proofs;
- clone chronology showing masking and outbound denial before application access.

Validate the aggregate document:

```text
node scripts/v4-rehearsal-kit/cli.mjs validate-sam85-evidence /approved/evidence/sam85-aggregate.json
```

The validator rejects synthetic evidence by default, shared staging, production, placeholder digests, secret/PII material, incomplete rollback, count/hash drift, late outbound checks and incomplete destruction.

## 7. Destruction and independent verification

Before the approval expiry, destroy database, storage, logs and exports; revoke clone credentials and all access. Record one non-sensitive reference, status, UTC completion time and digest for each of the six resource kinds. An independent reviewer then records only its role reference, verification time and aggregate evidence digest.

STOP if any resource remains, evidence contains raw rows or PII, access is still valid, destruction occurs after `destroyBy`, or bundle generation precedes independent verification.

## 8. Retention and Linear close rule

Retain only the approved aggregate evidence bundle, review decision, code/CI references and exception counts for the approved period. Destroy raw clone material, token key material, database/storage copies, execution logs containing records and temporary exports.

SAM-85 remains In Progress after this repository delivery. It may move to Done only after an authorized isolated rehearsal on a stable target schema produces a valid aggregate evidence document, exact-release CI/UAT references and verified destruction. A synthetic test, green PR or template alone is not completion evidence.

## 9. Rollback

The rehearsal rollback is data-plane work inside the disposable clone only: stop access, roll back schema in exact reverse order, verify pre-rehearsal counts/hashes, then destroy the clone. This repository package can be rolled back by reverting its single merge commit; it has no database or runtime rollback because it performs no external operation.
