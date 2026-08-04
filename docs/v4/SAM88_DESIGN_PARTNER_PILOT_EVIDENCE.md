# SAM-88 design-partner pilot evidence contract

This is a staging-only readiness contract. It is not a customer roster, a source of credentials, or proof that a pilot has run.

## Controlled input

The only accepted input is the root-owned file
`/var/lib/newme-staging-control/sam88-design-partner-pilot-manifest.json`, mode
`0600`, consumed through:

```text
newme-staging-control validate-sam88-pilot <exact-release-sha>
```

The input is intentionally not committed. It must contain exactly two distinct
organizations: one `real_estate`, one `retail`. Each record requires a real
staging organization UUID, a non-PII alias, a distinct commercial approval
decision, a role rather than a person's name, UTC approval time, and a redacted
approval evidence reference plus digest.

The evidence for both organizations is mandatory for all seven phases:

1. provisioning;
2. paid-seat and entitlement;
3. vertical E2E (`listing → lead → contract` for real estate, `catalog → order → fulfillment` for retail);
4. tenant isolation;
5. bounded support session and audit;
6. billing lifecycle and authorized export;
7. backup, restore and exit.

Each phase must carry a redacted record, SHA-256 digest, evidence reference,
exact release SHA, UTC observation time and the contract-specific assertion.
References allow only `linear://`, `ticket://`, `vault://` or `s3-redacted://`.
Emails, telephone-like strings, tokens, Basic/Bearer credentials, JWTs and PEM
material are rejected. The evidence output persists only references, digests,
UUIDs and role identifiers.

## Status semantics

The manifest must state `execution.status = "not-executed"`. A passing command
means only **authorized cohort evidence is submitted and structurally bound to
the current staging release**. It does not say that a pilot was executed,
commercially approved, or eligible for production.

The controller verifies the currently deployed immutable staging release before
reading the manifest, uses the SHA-bound runner from that release commit, writes
only root-owned `last-validate-sam88-pilot.json`, and prints no manifest values.
Any missing approval, missing phase, wrong release, non-redacted record,
duplicate organization, unsupported reference, secret-like text or unsafe file
metadata fails closed.

## Completion evidence still required

To close SAM-88, a separately authorized staging run must preserve the
root-owned input and its generated output together with the actual vertical UAT,
support/audit, billing/export and isolated backup/restore references for each
partner. A real production launch decision remains outside this runner.
