# Production upgrade plan from `YD7pCg9kXDHSVb1nW_OEf`

This document records a read-only production audit and an executable upgrade
plan. It does not approve or perform a production deployment, database write,
secret rotation, DNS change, or service restart.

## Observed production state

The following facts were read from the production host on 2026-08-02:

- `/opt/newme/current` resolves to
  `/opt/newme/releases/recovery-hardened-20260729T215403Z-YD7pCg9kXDHSVb1nW_OEf`.
- The release is owned by `ubuntu:ubuntu`, mode `0555`, and contains
  `.next/BUILD_ID=YD7pCg9kXDHSVb1nW_OEf`.
- The release has no release manifest.
- Its Git HEAD is `24848e626074a1ceeadecbfa4f1f66e0d594a729`, with tree
  `20bf2210de966fb5638c6aaf065d71fe107d46ba`, but the tracked worktree has
  1,636 differences. That Git SHA therefore cannot prove the source used to
  create the running `.next` artifact.
- `newme-platform.service` is active and running as `ubuntu`, with
  `WorkingDirectory=/opt/newme/current`, a direct Node/Next start command on
  port 3001, `Restart=always`, and `KillMode=control-group`.
- The production health endpoint returned HTTP 200 with runtime, database,
  logger, and disk checks all `OK`.
- `/opt/newme/current.rollback` resolves to
  `recovery-20260729T212155Z-YD7pCg9kXDHSVb1nW_OEf`. Both protected recovery
  directories have the same BUILD_ID.
- The installed production rollback controller exists and its read-only
  status check returned an active service and HTTP 200 health.

These facts establish current availability, but not reproducible release
provenance or a distinct tested rollback build.

## Staging reference and target selection

- The fully exercised commercial SaaS application baseline is
  `784a0c888e8a8f6ac78301a756187375cff40aa8`; its evidence is recorded in
  `docs/releases/2026-08-02-staging-commercial-saas-evidence.md`.
- The staging branch later advanced to
  `352d19b9badd3f0dd3030968cab55102775c14f8` only to add that evidence
  document. The deployed staging application remains bound to `784a0c88...`.
- GitHub `main` was `7f6284409820c1cc2c8b4163f9646f89bf75d888`
  during the audit. `24848e62...` is 300 commits behind that main; main is 25
  commits behind `784a0c88...`.
- A production candidate must be an immutable SHA, never the moving staging
  branch name.

`784a0c88...` is not yet deployable through the installed production wrapper:
it lacks the versioned rollback-controller source required by the wrapper and
its sudoers source does not authorize that controller. The production target
must therefore be a later exact SHA that contains the reviewed production
delivery prerequisite while retaining the `784a0c88...` application baseline.

## Mandatory pre-deployment gates

### 1. Version the production control plane

Before selecting the final target SHA:

1. Version the installed rollback controller at
   `infra/systemd/newme-production-rollback.sh`.
2. Synchronize `infra/sudoers/newme-platform`,
   `infra/systemd/newme-deploy.sh`, and `scripts/install-systemd-assets.sh`.
3. Add fail-closed contract tests for source provenance, exact installation,
   rollback target validation, immutable release switching, and health
   recovery.
4. Require a same-head full CI run and preserve its URL and conclusion.

No host-installed file may be replaced until its current owner, mode, hash,
backup path, expected new Git blob, and rollback operation are recorded.

### 2. Establish database provenance without exposing secrets

The production release contains 103 migration files and the staging baseline
contains 133, but file counts do not identify pending migrations. Before any
write, an authorized operator must capture, without printing credentials:

- the exact `supabase_migrations.schema_migrations` rows;
- schema fingerprints for every migration-touched table, function, policy,
  trigger, index, grant, and type;
- auth-user, profile, organization, membership, role, support-session, and
  core business-table counts;
- stable ID sets and monetary aggregates for Lead, Quotation, Contract,
  Payment, allocation, installment, and Project records;
- records lacking an organization assignment and all organization-key
  uniqueness conflicts.

Pending migrations are the exact version/name difference between the audited
history and the immutable candidate. A history version whose repository SQL
has changed is a stop condition and must not be replayed. No migration may be
inferred from directory counts or applied with conflict suppression.

### 3. Prove the upgrade on an isolated restore

Restore a production backup into an approved, isolated, disposable project.
Record the backup/PITR identifier, restore start/end times, operator, source
project, target project, and destruction authorization. Then:

1. Re-run the production baseline queries and compare their digests.
2. Apply only the exact pending migrations in timestamp order.
3. Verify that all pre-existing users, IDs, organizations, memberships, roles,
   business rows, and monetary aggregates remain present and unchanged.
4. Resolve any legacy organization assignment through a reviewed deterministic
   mapping; do not silently create competing memberships or renumber business
   identifiers.
5. Run organization isolation, six-role access, seat lifecycle, customer
   export/closure, backup/restore, and cleanup gates against the upgraded
   restore.
6. Exercise the approved database rollback path in reverse order and verify the
   original baseline again. A migration without a versioned inverse requires a
   tested backup/PITR restore, not ad-hoc reverse SQL.

The upgrade is NO-GO if any count, stable ID set, amount aggregate, ownership
boundary, or audit trail differs without a signed disposition.

## Production execution sequence

Production remains frozen until all pre-deployment gates are complete.

1. Announce a write-freeze window and verify no background import, webhook,
   cron, queue, or operator write remains active.
2. Capture production health, current and rollback symlink targets, BUILD_ID,
   protected-release markers, systemd state, installed-controller hashes,
   environment-file hash, database history, and data-baseline digests.
3. Create and verify a fresh backup/PITR point. Record a tested restore target.
4. Fetch the approved exact main SHA and verify its full CI run, source tree,
   release-control assets, migration set, and artifact checksum.
5. Apply only the rehearsed pending migrations. Re-run history, schema, row-ID,
   organization, and monetary-aggregate checks before continuing.
6. Build the immutable release and verify its manifest, Git SHA, BUILD_ID,
   environment binding, file ownership, and protected rollback predecessor.
7. Atomically switch `/opt/newme/current`, restart only the production service,
   and require health 200 plus authenticated admin, boss, sales, operator,
   finance, and designer checks.
8. Verify organization counts, memberships, seat state, business aggregates,
   customer export/closure behavior, audit events, and background processing.
9. Keep the write freeze until the evidence package is complete. Then either
   approve the release or execute the rehearsed rollback.

## Rollback decision tree

- If the database was not changed, use the versioned production rollback
  controller to atomically restore the protected immutable predecessor and
  require health 200 plus an unauthenticated denial check.
- If migrations were applied and their tested inverses preserve the baseline,
  execute those inverses in strict reverse order before switching the
  application release.
- If any applied migration lacks a proven inverse, keep the write freeze and
  restore the pre-window backup/PITR point. Do not improvise SQL in production.
- If application rollback health fails, restore the new release pointer and
  keep the service frozen for incident response; do not alternate symlinks
  repeatedly.

The current recovery release and `current.rollback` share the same BUILD_ID,
so they do not provide an independently proven code rollback. The first
commercial production release must create a new immutable, manifest-bound
predecessor relationship before it can be called complete.

## Required release evidence

The final production evidence package must contain:

- approved exact target SHA, tree, PRs, and full CI run;
- artifact and manifest hashes plus BUILD_ID;
- pre/post systemd, symlink, and health evidence;
- production migration-history diff and applied versions;
- pre/post data digests, stable ID sets, organization/seat counts, and monetary
  aggregates;
- backup/PITR and isolated restore evidence;
- authenticated post-deploy UAT and synthetic-fixture cleanup with zero
  residue;
- explicit application and database rollback targets;
- operator, approver, timestamps, and the decision to release or roll back.

Until those items exist, this document is a reviewed execution plan, not a
production release approval.
