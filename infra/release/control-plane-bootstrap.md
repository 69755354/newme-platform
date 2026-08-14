# Control-plane bootstrap: the `f37c203` wrapper → this release

Status: **NOT EXECUTED.** No production change is claimed by this document.
Bootstrap is a separately authorised production release action.

## Why a bootstrap is required

Production's old `f37c203` wrapper cannot prove this release's exact-head CI job
set, taskboard predeploy milestone, manifest-derived migration claim, production
migration history, or rollback/recontract companion binding. The candidate
installer therefore refuses an invocation without a fresh, root-owned, one-use
gate record bound to the candidate SHA and CI run. The old wrapper cannot produce
that record and cannot install this release's control plane.

The first transition must still use the candidate release's own coordinator. An
operator must never synthesize `gate=` labels: a hand-written list is a claim, not
evidence that the gates ran.

## Reversible boundary

`scripts/install-systemd-assets.sh` opens a durable asset transaction before the
first mutation. Its snapshot includes the deploy wrapper, both libexec helpers,
both service/rollback controllers, the sudoers policy, and every other managed
systemd/Nginx/cron/observability asset. `scripts/rollback-systemd-assets.sh`
restores each path by temp-file plus rename, so an interruption leaves the prior
or candidate byte sequence and a re-run converges.

The pending record remains until the coordinator verifies application service and
health and invokes the candidate helper's `finalize` mode. A failure or signal
before finalization reaches the coordinator's cleanup path and restores the
recorded snapshot. `finalize` itself checks that the installed control-plane bytes,
ownership and modes equal the candidate tree and that the backup remains complete
before durably removing the pending record.

## Authorised procedure

Preconditions:

- the release SHA is canonical `main`;
- the named `workflow_dispatch` run is exact-head and every job in
  `infra/release/required-jobs.json` succeeded;
- the release's `predeploy_ready` taskboard milestone is complete;
- the production migration URL file satisfies the root-only file contract;
- the command-line migration status/IDs exactly match the candidate manifest;
- production history permits the candidate's required/deferred set;
- the current immutable production SHA is the named rollback SHA.

Fetch only the candidate coordinator from the root-owned canonical mirror. This
temporary file is not installed directly; it merely starts the candidate's
root-owned worktree and executes the same verifier used for every later release.

```bash
set -Eeuo pipefail

sha='<40-lowercase-hex release SHA>'
run='<positive successful exact-head workflow_dispatch run id>'
migration_status='<not_required|applied_verified>'
migration_ids='<exact comma-separated 14-digit manifest-derived required list, or empty>'
rollback_sha='<40-lowercase-hex current immutable production SHA>'

[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid release SHA" >&2; exit 64; }
[[ "$run" =~ ^[1-9][0-9]*$ ]] || { echo "invalid workflow run id" >&2; exit 64; }
[[ "$rollback_sha" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid rollback SHA" >&2; exit 64; }
case "$migration_status" in
  not_required)
    [ -z "$migration_ids" ] || { echo "not_required must carry no migration ids" >&2; exit 64; }
    ;;
  applied_verified)
    [[ "$migration_ids" =~ ^[0-9]{14}(,[0-9]{14})*$ ]] || {
      echo "applied_verified requires comma-separated 14-digit migration ids" >&2
      exit 64
    }
    ;;
  *) echo "invalid migration status" >&2; exit 64 ;;
esac

coordinator=''
cleanup() {
  rc=$?
  cleanup_rc=0
  trap - EXIT
  set +e
  if [ -n "$coordinator" ]; then
    sudo rm -f -- "$coordinator"
    cleanup_rc=$?
  fi
  if [ "$rc" -eq 0 ] && [ "$cleanup_rc" -ne 0 ]; then
    rc=$cleanup_rc
  fi
  exit "$rc"
}
trap cleanup EXIT

coordinator="$(sudo mktemp /run/newme-bootstrap.XXXXXX)"
sudo chmod 0700 "$coordinator"
sudo git --git-dir=/opt/newme/repository.git show \
  "${sha}:infra/systemd/newme-deploy.sh" | sudo tee "$coordinator" >/dev/null
sudo test -s "$coordinator"
sudo bash "$coordinator" bootstrap \
  "$sha" "$run" "$migration_status" "$migration_ids" "$rollback_sha"
sudo cmp -s "$coordinator" /usr/local/sbin/newme-deploy
```

The strict shell options make a failed `git show` fail the pipeline even if
`tee` itself succeeds. The non-empty check prevents an empty coordinator from
being executed, and the `EXIT` trap removes the root-owned temporary file while
preserving the original failure status. The final byte comparison proves that a
reported bootstrap installed the exact coordinator fetched from the candidate
SHA; any mismatch is a failed bootstrap invocation, not success evidence.

The `bootstrap` entry point performs, in order:

1. canonical-main and current rollback-SHA verification;
2. exact run metadata plus the complete required-job manifest;
3. candidate-tree `predeploy_ready` taskboard verification;
4. candidate-manifest claim derivation and exact operator-claim comparison;
5. production history verification for the derived required and deferred
   migration sets;
6. candidate rollback/recontract companion verification;
7. machine generation of the one-use installer gate record;
8. transactional asset snapshot and candidate control-plane installation;
9. application service and `/api/health` verification;
10. candidate-byte verification and durable transaction finalization.

It does **not** stage or switch the application release. A successful result ends
with `systemd_asset_transaction=none`; a failed/interrupted result is not success
until the old assets have been restored or the durable pending state has been
recovered.

Verify the result without exposing configuration values:

```bash
sudo /usr/local/sbin/newme-production-rollback status
# require: systemd_asset_transaction=none
systemctl is-active --quiet newme-platform
curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null
```

Only machine output from this coordinator, the exact CI run, the asset transaction
record/status, the health checks and their timestamps are bootstrap evidence. A
TASKBOARD edit records that evidence after the production action; it does not
retroactively satisfy a bootstrap gate.

## Still open

- The bootstrap has not been executed.
- No migration or application deployment is authorised or performed by this
  runbook.
- Postdeploy acceptance remains a separate milestone after canonical deployment.
