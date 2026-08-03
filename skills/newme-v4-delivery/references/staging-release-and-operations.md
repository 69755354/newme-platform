# Staging Release and Operations

## Serialized release path

Execute only on an approved exact candidate SHA:

1. verify canonical branch/ref, controller/build-script provenance, previous immutable release, lock state and staging/production health;
2. build an immutable artifact and verify checksum, manifest SHA and toolchain;
3. read migration history and apply only the approved ordered delta;
4. deploy the candidate in isolation and verify readiness before switching;
5. atomically switch the staging release pointer;
6. run serialized smoke/UAT bound to the manifest SHA;
7. verify exact marker/ID cleanup and zero residue;
8. observe logs, alerts and health for the approved period;
9. record the rollback state.

Stop on any SHA, environment, project, permission, migration, health, log, alert or residue mismatch.

## Evidence

Use `assets/release-evidence.template.json` and validate it with `scripts/validate-release-evidence.mjs`. Never include tokens, cookies, passwords, service keys, DSNs or customer PII.

## Rollback

Rollback accepts only the recorded direct predecessor. Check application/database compatibility first. If an incompatible migration is active, execute the approved database rollback or corrective-forward plan before switching application code. Verify staging health after rollback and ensure production health remains unchanged.

## Host safety

Read root-owned wrappers and service units before invoking them. Resolve exact target paths and hashes before root writes. Use atomic replacement and a verified backup for installed control assets. Do not guess what a wrapper controls from its name.

Before release or cache cleanup:

- resolve the active release symlink and protect its target;
- protect the direct rollback release and current candidate;
- prove no running container or process references a candidate cleanup target;
- prefer retention by immutable reference, not modification time;
- record disk before/after and health after cleanup;
- never combine cleanup with service restart unless the approved operation requires it.

## Incident rule

Stabilize service and preserve evidence before cleanup or refactoring. Record direct journal/process/file facts, not inferred causes. Restore a verified immutable release layout before resuming deployment work.
