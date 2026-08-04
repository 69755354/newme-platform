# NewMe V4 rehearsal preparation kit

Status: local preparation only
Linear scope: SAM-85 / V4-MIG-001 and SAM-86 / V4-OPS-001..004
Candidate provenance: this package is base-independent. Each delivery PR must record its exact base, head and tree, and acceptance must use CI from that same head; executed evidence binds the release SHA and tree through the provenance contract.
V4 design source: PR 254 head `b7e42d728372cf2adb0e994c7026c06847004132`

This package defines aggregate-only evidence contracts and fail-closed validation. It does not create a clone, connect to a database, restore a backup, run load, contact an alert route, read credentials, inspect a server, deploy, or destroy resources.

## Package contents

- `schemas.mjs`: JSON-Schema-compatible wire contracts for clone, mapping/masking, outbound disable, migration/backfill/reconciliation, destruction, release provenance, service levels, restore, load, noisy-neighbor and alert evidence.
- `validators.mjs`: strict structural, sensitive-material, arithmetic, chronology and cross-contract validation.
- `cli.mjs`: read-only CLI for printing schemas and validating aggregate JSON files.
- `sam85-tools.mjs`: offline, pure masking/tokenization, token-only quarantine and aggregate reconciliation helpers; it has no database or network connector.
- `examples/synthetic-preparation-bundle.json`: a target-state template whose `claimsExecuted` value is `false` and whose evidence sections are all `not_executed`.
- `examples/synthetic-sam85-template.json`: the SAM-85-only G2/G7 UAT contract template.

The validators reject unknown properties. They recursively scan both object keys and string values, rejecting secret-bearing API/private/access/service keys, passphrases, credentials, bearer values, private keys, certificates, JWT-like values, known token prefixes, userinfo URIs, embedded secret assignments, connection strings and email-like PII. Raw rows, payloads, record bodies and exception records do not belong in this package.

## Contracts

| Schema name | Contract | Required proof boundary |
|---|---|---|
| `ephemeralClone` | `newme.v4.ephemeral-clone-manifest.v1` | approved source digest, purpose/scope/access/expiry, isolated network, clone-only credential references, masking before access |
| `mapping` | `newme.v4.mapping-and-masking.v1` | explicit field mappings, stable masking for identifiers, PII masking/drop, immutable financial/audit semantics |
| `outboundDisable` | `newme.v4.outbound-disable.v1` | email, messaging, webhook, portal and payment denied at configuration, network and runtime layers |
| `migration` | `newme.v4.migration-rehearsal-evidence.v1` | ordered forward/reverse assets, bounded backfill totals, aggregate quarantine, count equations and stable projection hashes |
| `destruction` | `newme.v4.destruction-proof.v1` | database/storage/log/export destruction plus credential/access revocation, each with digest and time |
| `provenance` | `newme.v4.release-provenance.v1` | exact Git SHA/tree → immutable artifact SHA-256 → manifest SHA-256 → observed runtime |
| `serviceLevel` | `newme.v4.service-level-evidence.v1` | measured availability/latency, exact error-budget arithmetic and declared RPO/RTO targets |
| `restore` | `newme.v4.restore-evidence.v1` | isolated restore timeline, computed RPO/RTO, aggregate counts and stable hashes |
| `load` | `newme.v4.load-evidence.v1` | aggregate dataset shape, duration/concurrency/requests, p50/p95/p99/max, throughput and errors |
| `noisyNeighbor` | `newme.v4.noisy-neighbor-evidence.v1` | stressed/collateral tenant references, computed p95/error-rate impact, leakage count and positive safe-concurrency decision |
| `alert` | `newme.v4.alert-evidence.v1` | owned rule/route, stimulus and delivery/ack chronology, computed latency, redacted tenant-safe payload boundary |
| `bundle` | `newme.v4.rehearsal-preparation-bundle.v1` | one run ID and one release SHA binding all contracts |

## Local validation

```text
node scripts/v4-rehearsal-kit/cli.mjs validate-template scripts/v4-rehearsal-kit/examples/synthetic-preparation-bundle.json
node scripts/v4-rehearsal-kit/cli.mjs schema provenance
node scripts/v4-rehearsal-kit/cli.mjs validate-document mapping <aggregate-json-file>
node scripts/v4-rehearsal-kit/cli.mjs validate-evidence <aggregate-evidence-bundle.json>
node scripts/v4-rehearsal-kit/cli.mjs validate-sam85-template scripts/v4-rehearsal-kit/examples/synthetic-sam85-template.json
node scripts/v4-rehearsal-kit/cli.mjs validate-sam85-evidence <aggregate-sam85-evidence.json>
```

`validate-template` accepts only `mode: "template"`, `evidenceState: "target"`, `environmentClass: "synthetic-local"`, `claimsExecuted: false` and `not_executed` sections.

`validate-evidence` accepts only `mode: "evidence"`, an executed evidence state and a non-synthetic environment. Unlike template mode, it rejects homogeneous 40/64-character hexadecimal SHA/digest placeholders and placeholder-style references. It requires strict calendar-valid UTC timestamps; approved clone chronology; outbound deny evidence after clone creation and before application access; destruction before the approved retention deadline; passed forward/reverse migration and reconciliation; a verified provenance chain; measured SLO, restore, load, p95/error-rate noisy-neighbor and alert facts; positive safe concurrency; and cross-contract SHA/run-ID agreement. A structurally valid rehearsal that misses a measured threshold returns `acceptanceStatus: "failed"`; it is not relabelled as passed.

`validate-sam85-evidence` narrows the same fail-closed rules to SAM-85: approved isolated clone, masking manifest, all five outbound denials, ordered forward/reverse assets, bounded backfill, aggregate quarantine, count/hash reconciliation and all six destruction/revocation proofs. It rejects synthetic execution evidence by default and cannot accept shared staging or production as an environment class.

## SAM-85 execution handoff

The separate, authorized rehearsal must provide all of the following before `validate-evidence` can pass:

1. approved snapshot reference and SHA-256, named role references, purpose, scope and expiry;
2. isolated clone with no shared-staging placement and no route to production writes;
3. clone-only credential references; never credential values;
4. masking/tokenization completed before application access;
5. all five outbound channel families blocked and verified before application access;
6. versioned forward and reverse migration hashes with exact reverse order;
7. bounded backfill counts where `source = migrated + quarantined`;
8. aggregate quarantine reasons and digest, without raw exception records;
9. reconciliation rows where `source = target + quarantined` and stable masked projections have equal before/after digests;
10. destruction/revocation evidence for database, storage, credentials, logs, exports and access.

## SAM-86 execution handoff

The separately authorized operations rehearsal must provide:

1. source Git SHA/tree, immutable artifact digest, manifest digest/content bindings and matching observed runtime metadata;
2. declared SLO window, availability and p95 targets, exact error budget and RPO/RTO targets;
3. isolated restore times from recovery point through restore completion, with RPO/RTO derived from those times;
4. aggregate restored counts and equal stable before/after hashes;
5. reproducible load dataset shape, concurrency, duration, request totals, p50/p95/p99/max, throughput and errors;
6. collateral-tenant observations, derived impact percentages, zero/recorded leakage and a consistent capacity decision;
7. an owned alert rule and route with stimulus, delivery, acknowledgement and derived delivery latency;
8. aggregate-only, redacted output with no secrets, tokens, customer PII or raw application payloads.

## Destruction and retention boundary

The package retains only schema files, validator code, tests and the synthetic template. Actual evidence belongs in the separately approved evidence location with its own retention and access controls. Do not commit production-derived evidence, raw clone logs, exports, credentials or customer records to Git.
