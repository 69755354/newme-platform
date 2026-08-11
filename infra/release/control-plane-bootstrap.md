# Control-plane bootstrap: the `f37c203` wrapper → this release

Status: **NOT EXECUTED.** No deployment has been performed and production's
control plane is unchanged. This document is the guarded path and the reasoning;
it is not evidence that anything was installed.

Round-3 finding P1-10, verbatim:

> production `/usr/local/sbin/newme-deploy` is the old `f37c203` wrapper… does not
> pass `CI_EVENT` or execute the new taskboard/remote-history/job gates… it
> installs the candidate forward-only control plane first; that backup set does not
> include the deploy wrapper… Provide an explicit, guarded, reversible bootstrap
> path and a behavior/contract test for `f37 wrapper -> candidate`, proving no
> unguarded production mutation occurs before all applicable preconditions.

Artifacts:

| what | where |
| --- | --- |
| the precondition | `scripts/verify-deploy-gate-record.mjs` |
| the installer that demands it | `scripts/install-systemd-assets.sh` |
| the wrapper that satisfies it | `infra/systemd/newme-deploy.sh` |
| the restore path | `scripts/rollback-systemd-assets.sh` |
| the behaviour and contract test | `tests/release/control-plane-bootstrap-contract.test.mjs` |

## 1 · The two defects, precisely

Production runs the wrapper from `f37c203`. Read it out of git rather than trusting
this description:

```bash
git show f37c203:infra/systemd/newme-deploy.sh
```

**It cannot check this release's preconditions.** Its line 480 is the whole of its
contract with the installer:

```bash
NEWME_ASSET_BACKUP_RECORD="$ASSET_BACKUP_RECORD" bash "$WORKTREE/scripts/install-systemd-assets.sh"
```

It never sets `CI_EVENT`, so `scripts/deploy-immutable.sh` cannot distinguish a
release-final dispatch from any other run; it does not run
`scripts/check-taskboard.mjs --require-complete` against the tree it is about to
deploy; it does not run `scripts/verify-remote-migration-history.mjs` at all; and it
does not check the run's individual jobs against
`infra/release/required-jobs.json`. Those gates exist only in the candidate wrapper
— which is a file the candidate release installs. A gate that first runs *after*
the deployment that installs it has not gated that deployment.

**It could not be undone.** The control plane — both libexec scripts,
`newme-service-control`, `newme-production-rollback`, `newme-deploy` itself and the
sudoers fragments — was installed *before* the backup existed and was never in the
remembered set. So the first candidate deployment replaced production's deploy
wrapper with no way back to the previous one. "Forward-only" was a description of a
missing rollback, not a property anybody chose.

## 2 · The guard: the installer refuses, not the wrapper

The gate cannot live in the wrapper, because the wrapper that runs the bootstrap is
the old one. So the installer demands the evidence itself, as the first thing it
does after validating `$STATE_ROOT` — `scripts/install-systemd-assets.sh` lines
37–73, before the unresolved-transaction recovery (which restarts the service) and
before any mutation of any kind.

The candidate wrapper writes a gate record into
`/var/lib/newme/deploy-state/deploy-gates.XXXXXX` (root:root 0600, inside the
root-owned 0700 directory) only after all four gates have passed, and passes its
path in `NEWME_DEPLOY_GATE_RECORD`. `scripts/verify-deploy-gate-record.mjs` accepts
it only when it:

- is bound to the **exact SHA** the installer computed from the tree it is
  installing (`git -C "$ROOT" rev-parse HEAD`), so a record from another release or
  another attempt is not usable;
- records `event=workflow_dispatch` and a numeric run id;
- accounts for **every** name in `REQUIRED_GATES` — `canonical-main-verified`,
  `github-required-jobs-green`, `taskboard-complete`, `remote-migration-history` —
  with no duplicates and no gate name the installer does not know;
- is **fresh** (900 s), so a record left behind by an earlier deployment of the same
  SHA cannot be replayed;
- is a regular file, not a symlink, root:root 0600, in the protected directory.

Absence is the ordinary case and it is a refusal, exit **78**:

```
no deploy gate record was passed: this release's control plane may only be
installed by a wrapper that has run its gates
```

That is exactly what the `f37c203` wrapper produces. It sets no such variable, so
under this release's installer **it cannot mutate the host at all** — not the
control plane, not a unit file, not a sudoers fragment. The bootstrap is therefore
not "the old wrapper installs the new gates and we hope"; it is "the old wrapper
cannot install anything, and a human performs the first transition deliberately."

The record contains a SHA, a run id, an event name and gate names. No secret, no
credential, no identity.

## 3 · Reversibility

Two changes make the transition undoable:

1. `CONTROL_PLANE[]` (`scripts/install-systemd-assets.sh`) is remembered together
   with `MANAGED[]` before anything is written, so `rootfs`, `managed.list`,
   `present.list`, `manifest.sha256` and `symlink.sha256` in
   `/var/backups/newme-systemd-assets/<stamp>.XXXXXX` include the previous
   `newme-deploy`, both libexec scripts, both sbin controllers and both sudoers
   fragments. `scripts/rollback-systemd-assets.sh` iterates `managed.list`
   generically, so it restores them with no change of its own — including restoring
   `/etc/sudoers.d/ubuntu-nopasswd`, which the installer removes unconditionally and
   which was previously a one-way removal.
2. The control-plane installs were moved to *after* `trap rollback_on_error EXIT`
   and after both recovery pointers (`NEWME_ASSET_BACKUP_RECORD` and the fixed
   `systemd-assets.pending` hard link) are durable. Any failure from that point on —
   including a failure inside the control-plane install itself — restores the
   backup, and an interruption leaves the pending pointer for the next run to
   recover.

Ordering is asserted by the contract test, not by reading.

## 4 · The bootstrap procedure

Every step below touches production. **None of it has been performed, and none of it
may be performed from a code round.** It requires the separately authorised
production release action.

Preconditions, all of which must already be true:

- the exact-head `workflow_dispatch` run for the release SHA is green, and every job
  in `infra/release/required-jobs.json` ran and succeeded;
- `TASKBOARD.md` at that tree is complete;
- the production migration-history reconciliation in
  `supabase/preflight/migration-history-reconciliation.md` has been completed, so
  the remote-history gate can pass;
- `/opt/newme/repository.git` has the release SHA on canonical `main`.

1. **[AUTHORISED ACTION] Snapshot the current control plane first.** `snapshot`
   mode remembers every managed and control-plane path and exits before the
   gate-record check and before any mutation, so it is safe to run from the release
   that is live right now — and it must be, so that the snapshot is of what is
   actually running. The source root has to be an immutable release directory and
   the record file has to exist already (root:root 0600 in the protected
   directory); this is the same call
   `infra/systemd/newme-production-rollback.sh` makes:

   ```bash
   current="$(readlink -f /opt/newme/current)"
   record="$(sudo mktemp /var/lib/newme/deploy-state/asset-snapshot.XXXXXX)"
   sudo chmod 0600 "$record"
   sudo env NEWME_ASSET_SNAPSHOT_RECORD="$record" NEWME_ASSET_SOURCE_ROOT="$current" \
     bash /usr/local/libexec/newme/newme-install-systemd-assets snapshot
   ```

   Record the printed `snapshot=<path>` (it is also written to `$record`): that
   directory is the restore point for step 3.

2. **[AUTHORISED ACTION] Install the candidate control plane once, by hand.** The
   old wrapper cannot do it — that is the point of §2 — so the first transition is
   performed directly, as root, with the gate record written by the operator who has
   just confirmed the preconditions above.

   Install mode derives the SHA it binds the record to from the tree itself
   (`git -C "$ROOT" rev-parse HEAD`), so it must run from a git worktree of the
   root-owned mirror, exactly as the wrapper runs it. `/opt/newme/releases/<sha>` is
   a `git archive` extraction with no repository in it and cannot be used here.

   ```bash
   sha=<release sha>            # the SHA of the green exact-head dispatch run
   run=<the green run id>

   sudo mkdir -p -m 0700 /var/lib/newme/deploy-worktrees
   wt="$(sudo mktemp -d /var/lib/newme/deploy-worktrees/bootstrap.XXXXXX)"
   sudo rmdir "$wt"
   sudo git --git-dir=/opt/newme/repository.git worktree add --force "$wt" "$sha"
   sudo chown -R root:root "$wt"
   test "$(sudo git -C "$wt" rev-parse HEAD)" = "$sha" || echo REFUSE

   sudo install -d -o root -g root -m 0700 /var/lib/newme/deploy-state
   record="$(sudo mktemp /var/lib/newme/deploy-state/deploy-gates.XXXXXX)"
   sudo chmod 0600 "$record"
   sudo tee "$record" >/dev/null <<EOF
   sha=$sha
   event=workflow_dispatch
   run=$run
   gate=canonical-main-verified
   gate=github-required-jobs-green
   gate=taskboard-complete
   gate=remote-migration-history
   EOF

   sudo env NEWME_DEPLOY_GATE_RECORD="$record" bash "$wt/scripts/install-systemd-assets.sh"

   sudo rm -f -- "$record"
   sudo git --git-dir=/opt/newme/repository.git worktree remove --force "$wt"
   ```

   Writing that record by hand is an assertion under the operator's own name that
   the four gates were checked. It is fresh for 900 s and bound to the SHA, so it
   cannot be prepared in advance or reused, and the `rev-parse` check above is the
   operator's own confirmation that the tree the installer will hash is the release.
   From the next deployment onward nobody writes it by hand:
   `/usr/local/sbin/newme-deploy` is the candidate wrapper and produces the record
   itself, after running the gates.

3. **Verify, or restore.** Confirm the wrapper was replaced and the service is
   healthy:

   ```bash
   sudo /usr/local/sbin/newme-deploy            # expect exit 64 and the new usage line
   systemctl is-active newme-platform
   curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null && echo ok
   ```

   If anything is wrong, restore the snapshot from step 1:

   ```bash
   sudo /usr/local/libexec/newme/newme-rollback-systemd-assets <snapshot path>
   ```

   That puts the `f37c203` wrapper, both libexec scripts, both controllers and both
   sudoers fragments back, because they are now in the remembered set.

4. **Then, and only then, deploy through the wrapper.** Subsequent deployments run
   the candidate path with all four gates enforced, and the installer's gate-record
   check is satisfied automatically.

## 5 · What is still open

- The bootstrap has not been executed. Production still runs the `f37c203` wrapper,
  which under this release's installer can no longer install anything.
- Step 2 depends on the migration-history reconciliation, which has also not been
  performed (`supabase/preflight/migration-history-reconciliation.md`).
- No migration has been applied and no deployment has been performed.

None of these may be marked ✅ from a code round. What the code round closes is that
an ungated wrapper can no longer mutate the control plane, and that the transition
is reversible when it is performed.
