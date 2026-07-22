#!/usr/bin/env bash
set -u

umask 027
LOG_DIR=/var/log/newme-forensic
LOG_FILE="$LOG_DIR/newme-forensic.log"
mkdir -p "$LOG_DIR"
chown root:adm "$LOG_DIR" 2>/dev/null || true
chmod 0750 "$LOG_DIR" 2>/dev/null || true
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 0640 "$LOG_FILE"
exec >>"$LOG_FILE" 2>&1

timestamp=$(date -Iseconds)
current_release=$(readlink -f /opt/newme/current 2>/dev/null || echo unavailable)
build_id=$(cat /opt/newme/current/.next/BUILD_ID 2>/dev/null || echo unavailable)
manifest=/opt/newme/current/manifest.json
manifest_sha256=$(sha256sum "$manifest" 2>/dev/null | awk '{print $1}' || echo unavailable)

echo "=== NEWME FORENSIC $timestamp ==="
printf 'SERVICE_RESULT=%s\n' "${SERVICE_RESULT:-UNSET}"
printf 'EXIT_CODE=%s\n' "${EXIT_CODE:-UNSET}"
printf 'EXIT_STATUS=%s\n' "${EXIT_STATUS:-UNSET}"
printf 'INVOCATION_ID=%s\n' "${INVOCATION_ID:-UNSET}"
printf 'CURRENT_RELEASE=%s\n' "$current_release"
printf 'BUILD_ID=%s\n' "$build_id"
printf 'MANIFEST_SHA256=%s\n' "$manifest_sha256"
echo 'STOP_SENDER=not_available_from_exec_stop_post'

echo '--- systemd state ---'
systemctl show newme-platform.service \
  -p ActiveState -p SubState -p Result -p MainPID -p ControlPID \
  -p ExecMainCode -p ExecMainStatus -p NRestarts -p Restart \
  -p InvocationID -p FragmentPath -p DropInPaths 2>&1 || true

echo '--- cgroup ---'
for file in cgroup.procs cgroup.events memory.events; do
  echo "[$file]"
  cat "/sys/fs/cgroup/system.slice/newme-platform.service/$file" 2>&1 || true
done

echo '--- port 3001 ---'
ss -ltnp '( sport = :3001 )' 2>&1 || true

echo '--- invocation journal ---'
if [ -n "${INVOCATION_ID:-}" ]; then
  journalctl "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" -n 80 --no-pager 2>&1 || true
else
  journalctl -u newme-platform.service -n 80 --no-pager 2>&1 || true
fi

echo "=== END NEWME FORENSIC $(date -Iseconds) ==="
