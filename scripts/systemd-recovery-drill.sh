#!/usr/bin/env bash
set -euo pipefail

mode=${1:---plan}
case "$mode" in
  --plan)
    cat <<'EOF'
SAM-63 maintenance-window drill (no actions executed):
1. baseline: verify MainPID is node/next, cgroup owns every child, and release metadata is recorded
2. intentional stop: use newme-service-control; require inactive unit, empty cgroup, and port 3001 released
3. abnormal exit: signal only the MainPID; require restart within SLO and a new InvocationID
4. orphan containment: stop a fixture with a spawned child; require KillMode=control-group to remove the full fixture cgroup
5. StartLimit: use a failing fixture unit; require 5 starts/60s then failed state, followed by explicit reset-failed
6. reboot: after an approved reboot, require enabled unit, direct MainPID, healthy route, release match, and journal provenance

Use --readonly to collect the non-destructive baseline. Destructive production scenarios remain manual,
require an approved maintenance window, and must use the versioned runbook.
EOF
    ;;
  --readonly)
    systemctl show newme-platform.service \
      -p ActiveState -p SubState -p MainPID -p ControlGroup -p InvocationID \
      -p NRestarts -p Restart -p KillMode -p StartLimitIntervalUSec -p StartLimitBurst
    main_pid=$(systemctl show newme-platform.service -p MainPID --value)
    control_group=$(systemctl show newme-platform.service -p ControlGroup --value)
    if [ "$main_pid" -gt 0 ]; then
      ps -o pid=,ppid=,sid=,pgid=,stat=,comm=,args= -p "$main_pid"
    fi
    if [ -n "$control_group" ] && [ -r "/sys/fs/cgroup$control_group/cgroup.procs" ]; then
      while read -r pid; do
        ps -o pid=,ppid=,sid=,pgid=,stat=,comm=,args= -p "$pid"
      done < "/sys/fs/cgroup$control_group/cgroup.procs"
    fi
    ss -ltnp '( sport = :3001 )' || true
    ;;
  *)
    echo "usage: $0 [--plan|--readonly]" >&2
    exit 64
    ;;
esac
