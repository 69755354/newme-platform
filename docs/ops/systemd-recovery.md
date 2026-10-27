# NewMe systemd ownership and recovery

This runbook is the review and maintenance-window procedure for `newme-platform.service`.
It does not identify the sender of the 2026-07-22 13:00 stop; the available historical evidence is insufficient.

## Versioned ownership contract

- systemd directly starts the Next.js Node entrypoint from `/opt/newme/current`.
- `MainPID` must be that Node process. `npm` and `sh -c` are not accepted owners.
- `KillMode=control-group` applies TERM and the final KILL to the complete unit cgroup.
- `Restart=always`, `RestartSec=5`, and `StartLimitBurst=5` per 60 seconds bound recovery loops.
- Approved service mutations use `/usr/local/sbin/newme-service-control` with a reason. The wrapper writes actor, action, release, build, and manifest identity to the journal.
- `ExecStopPost` records exit/signal/result, cgroup, port, release, build, invocation, and recent invocation journal. It cannot by itself recover the original sender of an arbitrary D-Bus/systemd stop request.
- Health monitoring uses `infra/observability/newme-service-health.py`. It accepts the deployed API statuses `ok` and `healthy`, reports failure, and never kills or restarts a process.

## Install and rollback plan

Do not run these steps outside an approved maintenance window. Before changes, save the current unit, drop-ins, helper checksums, active release target, and `systemctl show` output in the change record.

0. From the release checkout, run `sudo bash scripts/install-systemd-assets.sh`; this idempotently installs the unit, root-owned helpers, and matching logrotate rule, and migrates `/var/log/newme-forensic.log` into `/var/log/newme-forensic/newme-forensic.log` before any new deploy runs.
1. Validate the reviewed files with `systemd-analyze verify infra/systemd/newme-platform.service` and the release tests.
2. Install the unit as root-owned mode `0644`, the readiness and forensic helpers under `/usr/local/libexec/newme/` as root-owned mode `0755`, and the control wrapper under `/usr/local/sbin/` as root-owned mode `0755`.
3. Disable the unversioned `/home/ubuntu/.hermes/scripts/health-check.py` as a NewMe process restarter and repoint its scheduler to the versioned read-only probe. Preserve its checksum and scheduler configuration as evidence. It currently treats only `healthy` as success and uses `pkill -f "next start -p 3001"`; leaving it active will continue to terminate healthy releases whose API reports `ok`.
4. Run `systemctl daemon-reload`, verify the loaded fragment and drop-ins, then restart only after rollback artifacts are confirmed.
5. Roll back by restoring the saved unit and helpers, restoring the prior scheduler configuration, running `systemctl daemon-reload`, resetting the failed counter if required, and restarting the prior `/opt/newme/current` release.

The existing accident-era `forensic.conf` and `restart-always.conf` drop-ins must be removed only after the reviewed base unit contains their intended settings and their backups are recorded. Conflicting drop-ins make the effective unit, not the versioned unit, authoritative.

## Maintenance-window evidence matrix

| Scenario | Controlled action | Required evidence |
|---|---|---|
| Baseline | `scripts/systemd-recovery-drill.sh --readonly` | MainPID is Node/Next; all children are in the unit cgroup; port 3001 owner is in that cgroup; release/build match `/opt/newme/current`. |
| Intentional stop | `newme-service-control stop "change:<id>:intentional-stop"` | Unit inactive; cgroup empty/removed; port 3001 closed; wrapper journal contains actor/reason/release; forensic log records `SERVICE_RESULT=success`. |
| Abnormal exit | signal only the recorded MainPID with an approved non-clean signal | New InvocationID and MainPID within the recovery SLO; `NRestarts` increments; old cgroup has no survivor; forensic log records exit code/status and release. |
| Orphan containment | run a transient fixture that spawns a child, using the same KillMode/timeout settings, then stop the fixture | Entire fixture cgroup disappears. Do not use `fuser -k` as the assertion or cleanup mechanism. |
| StartLimit | run a deliberately failing transient fixture with `RestartSec=5`, burst 5, interval 60 | Fixture reaches failed/start-limit-hit; no unbounded loop; `reset-failed` is explicit and audited. Do not exhaust the production unit for this test. |
| Reboot | approved host reboot after the other scenarios pass | Unit is enabled and starts once networking is available; direct MainPID/cgroup/port/release checks pass; boot journal and wrapper/change record identify the operation. |

If stop leaves port 3001 listening, deployment must fail closed and preserve `systemctl show`, cgroup, port, and journal evidence. Do not use a broad port kill to make the deployment appear healthy.
