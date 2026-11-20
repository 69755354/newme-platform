# Release lite lane (`newme-deploy lite`)

Status: introduced 2026-11-20 after a day in which every single-PR release took
45 min on the happy path and 1–4 h with retries, and every retry was caused by
ceremony rather than by a broken release (host load during a single health
probe, a data-quality regression check, a closure-slot collision, an alert-drill
freeze). NewMe OS is an internal tool for a few dozen staff; the gate is sized
for that now.

## What one release looks like

```
tools/release_lite.sh <logdir> "<headline>" <pr> [<pr> ...] [--dbop sNN]
```

1. Each PR: ready → update-branch → required checks green → minor review
   threads resolved → squash merge. A PR that conflicts or fails is skipped and
   reported; the batch ships the others.
2. One `workflow_dispatch` of `ci.yml` on the resulting main SHA (≈7 min).
3. With `--dbop sNN`: encrypted backup (`newme-db-backup.service`), then
   `newme-deploy db-transition <sha> <run> sNN-db-plan` and `-provision`.
4. `sudo newme-deploy lite <sha>` (≈3–5 min): see below.
5. A one-line result (and the lane's warnings, if any) to the WhatsApp
   operations alert.

Happy path ≈ 15 min after the last merge; ≤ 30–40 min including the PRs'
own checks. There is no accept / attest / closure PR / release-final CI /
finalize step: the release is complete when step 4 returns.

## What `newme-deploy lite <main-sha> [run-id] [not_required|contract_verified]` does

A compat rollout (`applied_verified` / `reentry_verified`) is refused by the lite
lane: it writes the release complete, and completion requires the database to be
strict (the gate `finalize` used to run, `check-release-phase.mjs
--for-completion`, now runs inside the lite deploy before the evidence is written
and fails the release — with rollback — if the phase is not strict).

Kept from the full lane, unchanged (production-safety gates):

- the SHA must be canonical `origin/main` in the root-owned mirror, re-checked
  before the asset transaction, the switch and the evidence;
- a completed, successful `workflow_dispatch` run of `ci.yml` on exactly that
  SHA with every job in `infra/release/required-jobs.json` green (the run id is
  resolved from GitHub when omitted, then verified exactly like a typed one);
- the TASKBOARD `predeploy_ready` scope (AGENTS.md: an unfinished row aborts the
  deploy; seconds, never load-sensitive);
- release manifest ↔ migrations consistency, production migration-history
  reconciliation, database posture and hand-run companion hashes, pre-switch
  revalidation;
- release environment / runtime configuration validation (no server secret in
  the release, service key only in the runtime env);
- the control-plane asset transaction with its rollback snapshot, the installer
  gate record (`verify-deploy-gate-record.mjs`);
- immutable build, candidate readiness and auth-boundary probes on :3002;
- after the switch: health (now a bounded retry, 9 × 10 s, instead of one 10 s
  probe), the 14-route smoke test, service-identity check, journald error scan,
  the CRM regression's connectivity / auth / schema checks — any failure rolls
  back to the previous release automatically, as before.

Changed in the lite lane only:

| Full lane | Lite lane |
| --- | --- |
| run id, migration ids, rollback SHA typed by the operator | derived (GitHub API, release manifest, live release) and verified the same way |
| host load must settle within 120 s or the release fails | 600 s, then a warning; the retrying health probe is the judge |
| `l0-composite-probe.sh` (alert provider + host metrics) failure fails the release | warning |
| data-quality regression checks (`无空名称线索`, `通知未超过 5000 条`, …) roll back | warnings, forwarded to the WhatsApp alert |
| evidence `awaiting_uat` → accept (browser UAT, alert drill, 15 min delayed verification) → attest → closure PR + release-final CI → finalize | evidence `complete` with `release_lane: lite` and the warnings |
| a live release that is `awaiting_uat` cannot be superseded | may be superseded by a newer release that passes the same gates |

The full lane (`newme-deploy <sha> <run> <status> <ids> <rollback>`,
`accept`, `attest`, `finalize`) is untouched and remains available for a
release that wants the browser acceptance.

## Bootstrap: installing this change through the current gate

The installed wrapper replaces itself only through the installer of the tree
being released, and that installer verifies the gate record the *installed*
wrapper wrote. The sequence for the PR that introduces the lite lane is:

1. Merge the PR; dispatch `ci.yml` on main; the run must be green.
2. Release it once more through the full lane (`tools/release_pr.sh` /
   `release_batch.sh` → `release_chain.sh`). The **old** wrapper runs every old
   gate, writes its six-line gate record (`event=workflow_dispatch` and the six
   gate names) and calls the **new** tree's `install-systemd-assets.sh`, whose
   verifier requires exactly those six gates (unchanged). The installer then
   installs the new `/usr/local/sbin/newme-deploy`.
3. The old wrapper continues with the **new** `deploy-immutable.sh`, which is
   invoked without `NEWME_RELEASE_LANE` and therefore behaves exactly as
   before (`awaiting_uat`, single-lane semantics, same evidence shape).
4. Either finish that release through the old `accept → attest → close`
   flow (≈30 min, one last time), or leave it at `awaiting_uat`: the first
   `newme-deploy lite <next-sha>` supersedes an `awaiting_uat` live release
   whose post-switch gates passed.

Nothing is installed by hand; `/usr/local/sbin` changes only through the
installer, inside the asset transaction, with its rollback snapshot.

## Recovery

Unchanged: `newme-production-rollback status | execute <reason>`,
`newme-deploy accept-recover <sha>` for a stuck full-lane acceptance. A lite
release that fails after the switch is rolled back by `deploy-immutable.sh`
itself (application pointer, service restart, health check, versioned assets),
and the next `newme-deploy lite` starts from the restored release.
