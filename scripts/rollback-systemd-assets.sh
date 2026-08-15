#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exit 77
STATE_ROOT=/var/lib/newme/deploy-state
CREDENTIAL_TRANSITION_PENDING="$STATE_ROOT/credential-transition.pending.json"
CREDENTIAL_ASSET_PENDING="$STATE_ROOT/credential-assets.pending"
CREDENTIAL_PROTECTION_RECORD="$STATE_ROOT/credential-remediation.protected.json"
SYSTEMD_PENDING_RECORD="$STATE_ROOT/systemd-assets.pending"
ROLLBACK_PROTECTED_RESTORE_COUNT=0
rollback_drill_checkpoint() {
  local restored_path="$1"
  [ -z "${NEWME_ASSET_ROLLBACK_DRILL_INTERRUPT_AFTER:-}" ] && return 0
  [ "${NEWME_DRILL_CONFIRM:-}" = throwaway-container ] &&
    { [ -f /.dockerenv ] || [ -f /run/.containerenv ]; } || {
      echo "asset rollback crash checkpoints are restricted to a throwaway container" >&2
      return 64
    }
  [[ "$NEWME_ASSET_ROLLBACK_DRILL_INTERRUPT_AFTER" =~ ^([1-9]|1[0-4])$ ]] || return 64
  case "$restored_path" in
    /var/lib/newme/deploy-state/credential-remediation.protected.json|\
    /etc/systemd/system/newme-platform.service|\
    /etc/tmpfiles.d/newme-credential-inbox.conf|\
    /etc/cron.d/newme-observability|\
    /usr/local/sbin/newme-deploy|\
    /usr/local/sbin/newme-production-rollback|\
    /usr/local/libexec/newme/newme-install-systemd-assets|\
    /usr/local/libexec/newme/newme-rollback-systemd-assets|\
    /usr/local/libexec/newme/newme-validate-production-config.py|\
    /usr/local/libexec/newme/newme-credential-transition.mjs|\
    /usr/local/libexec/newme/newme-credential-live-attestation.mjs|\
    /usr/local/share/newme/credential-live-attestation-policy-v1.json|\
    /usr/local/libexec/newme/newme-readiness.sh|\
    /opt/hermes-scripts/observability/dependency-probe.sh) ;;
    *) return 0 ;;
  esac
  ROLLBACK_PROTECTED_RESTORE_COUNT=$((ROLLBACK_PROTECTED_RESTORE_COUNT + 1))
  if [ "$ROLLBACK_PROTECTED_RESTORE_COUNT" -eq "$NEWME_ASSET_ROLLBACK_DRILL_INTERRUPT_AFTER" ]; then
    kill -KILL "$$"
  fi
}
if [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ]; then
  echo "an unresolved credential transition blocks versioned asset rollback; run: sudo /usr/local/sbin/newme-deploy credential-recover" >&2
  exit 75
fi
if [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ]; then
  if [ "${NEWME_CREDENTIAL_ASSET_RECOVERY:-}" != 1 ] ||
    [ "$(readlink /proc/self/fd/9 2>/dev/null || true)" != /run/lock/newme-production-release.lock ] ||
    ! flock -n 9; then
    echo "an unresolved credential-asset transaction blocks ordinary asset rollback; run: sudo /usr/local/sbin/newme-deploy credential-recover" >&2
    exit 75
  fi
fi
if { [ -e "$SYSTEMD_PENDING_RECORD" ] || [ -L "$SYSTEMD_PENDING_RECORD" ]; } &&
  [ "${NEWME_VERSIONED_ASSET_RECOVERY:-}" != 1 ] &&
  [ "${NEWME_CREDENTIAL_ASSET_RECOVERY:-}" != 1 ]; then
  echo "an unresolved versioned asset transaction requires its canonical recovery path" >&2
  exit 75
fi
BACKUP="${1:-}"
[ -d "$BACKUP/rootfs" ] && [ -f "$BACKUP/managed.list" ] && [ -f "$BACKUP/present.list" ] && [ -f "$BACKUP/manifest.sha256" ] && [ -f "$BACKUP/symlink.sha256" ] || exit 64
if [ -s "$BACKUP/manifest.sha256" ]; then
  (cd "$BACKUP/rootfs" && sha256sum -c "$BACKUP/manifest.sha256")
fi
while read -r expected dest extra; do
  [ -n "$expected" ] || continue
  [ -n "$dest" ] && [ -z "${extra:-}" ] || exit 65
  rel="${dest#/}"
  [ -L "$BACKUP/rootfs/$rel" ] || exit 65
  actual="$(printf '%s' "$(readlink -- "$BACKUP/rootfs/$rel")" | sha256sum | awk '{print $1}')"
  [ "$actual" = "$expected" ] || exit 65
done < "$BACKUP/symlink.sha256"

CREDENTIAL_PROTECTION_ACTIVE=0
if [ -e "$CREDENTIAL_PROTECTION_RECORD" ] || [ -L "$CREDENTIAL_PROTECTION_RECORD" ]; then
  [ -f "$CREDENTIAL_PROTECTION_RECORD" ] && [ ! -L "$CREDENTIAL_PROTECTION_RECORD" ] || exit 65
  [ "$(stat -c '%U:%G' "$CREDENTIAL_PROTECTION_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$CREDENTIAL_PROTECTION_RECORD")" = 600 ] || exit 65
  python3 - "$CREDENTIAL_PROTECTION_RECORD" <<'PY' || exit 65
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    record = json.load(handle)
common_valid = (
    isinstance(record, dict)
    and re.fullmatch(r"[0-9a-f]{40}", record.get("candidate_sha", "")) is not None
    and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", record.get("activated_at", "")) is not None
)
v1 = common_valid and record.get("version") == 1 and set(record) == {"version", "candidate_sha", "activated_at"}
v2 = (
    common_valid
    and record.get("version") == 2
    and set(record) == {"version", "candidate_sha", "activated_at", "assets"}
    and isinstance(record.get("assets"), dict)
    and all(re.fullmatch(r"[0-9a-f]{64}", value or "") for value in record["assets"].values())
)
if not (v1 or v2):
    raise SystemExit(65)
PY
  CREDENTIAL_PROTECTION_ACTIVE=1
fi
VERSIONED_ASSET_RECOVERY=0
RESTORE_PROTECTED_MARKER_LAST=0
if [ "${NEWME_VERSIONED_ASSET_RECOVERY:-}" = 1 ]; then
  [ "${NEWME_CREDENTIAL_ASSET_RECOVERY:-}" != 1 ] || exit 65
  [ "$(readlink /proc/self/fd/9 2>/dev/null || true)" = /run/lock/newme-production-release.lock ] || exit 75
  flock -n 9 || exit 75
  [ -f "$SYSTEMD_PENDING_RECORD" ] && [ ! -L "$SYSTEMD_PENDING_RECORD" ] || exit 65
  [ "$(stat -c '%U:%G' "$SYSTEMD_PENDING_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$SYSTEMD_PENDING_RECORD")" = 600 ] || exit 65
  VERSIONED_PENDING_LINES="$(wc -l < "$SYSTEMD_PENDING_RECORD")"
  [ "$(grep -Fxc "backup=$BACKUP" "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
  [ "$(grep -Ec '^candidate_preexisting=0$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
  if [ "$VERSIONED_PENDING_LINES" -eq 5 ]; then
    [ ! -e "$CREDENTIAL_PROTECTION_RECORD" ] && [ ! -L "$CREDENTIAL_PROTECTION_RECORD" ] || exit 65
    [ ! -e "$BACKUP/rootfs$CREDENTIAL_PROTECTION_RECORD" ] && [ ! -L "$BACKUP/rootfs$CREDENTIAL_PROTECTION_RECORD" ] || exit 65
  elif [ "$VERSIONED_PENDING_LINES" -eq 8 ]; then
    [ "$(grep -Ec '^version=2$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
    [ "$(grep -Ec '^protected_before_candidate_sha=[0-9a-f]{40}$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
    [ "$(grep -Ec '^protected_before_marker_sha256=[0-9a-f]{64}$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || exit 65
    python3 - "$BACKUP" "$SYSTEMD_PENDING_RECORD" <<'PY' || exit 65
import hashlib
import json
import os
import re
import stat
import sys

backup, pending_path = sys.argv[1:]
root = backup + "/rootfs"
marker_path = "/var/lib/newme/deploy-state/credential-remediation.protected.json"
legacy_expected = {
    "/etc/systemd/system/newme-platform.service": 0o644,
    "/etc/tmpfiles.d/newme-credential-inbox.conf": 0o644,
    "/etc/cron.d/newme-observability": 0o644,
    "/usr/local/sbin/newme-deploy": 0o755,
    "/usr/local/sbin/newme-production-rollback": 0o755,
    "/usr/local/libexec/newme/newme-install-systemd-assets": 0o755,
    "/usr/local/libexec/newme/newme-rollback-systemd-assets": 0o755,
    "/usr/local/libexec/newme/newme-validate-production-config.py": 0o755,
    "/usr/local/libexec/newme/newme-credential-transition.mjs": 0o755,
    "/usr/local/libexec/newme/newme-readiness.sh": 0o755,
    "/opt/hermes-scripts/observability/dependency-probe.sh": 0o755,
}
current_expected = {
    **legacy_expected,
    "/usr/local/libexec/newme/newme-credential-live-attestation.mjs": 0o755,
    "/usr/local/share/newme/credential-live-attestation-policy-v1.json": 0o644,
}
def read_pending(path):
    result = {}
    with open(path, encoding="utf-8") as handle:
        for raw in handle:
            key, separator, value = raw.rstrip("\n").partition("=")
            if not separator or not key or key in result:
                raise SystemExit(1)
            result[key] = value
    return result

pending = read_pending(pending_path)
if set(pending) != {
    "version", "sha", "backup", "previous", "previous_rollback",
    "candidate_preexisting", "protected_before_candidate_sha",
    "protected_before_marker_sha256",
} or pending.get("version") != "2" or pending.get("backup") != backup:
    raise SystemExit(1)
marker_source = root + marker_path
marker_metadata = os.lstat(marker_source)
if (
    not stat.S_ISREG(marker_metadata.st_mode)
    or stat.S_ISLNK(marker_metadata.st_mode)
    or marker_metadata.st_uid != 0
    or marker_metadata.st_gid != 0
    or stat.S_IMODE(marker_metadata.st_mode) != 0o600
):
    raise SystemExit(1)
with open(marker_source, "rb") as handle:
    marker_bytes = handle.read()
if hashlib.sha256(marker_bytes).hexdigest() != pending["protected_before_marker_sha256"]:
    raise SystemExit(1)
marker = json.loads(marker_bytes)
if (
    not isinstance(marker, dict)
    or set(marker) != {"version", "candidate_sha", "activated_at", "assets"}
    or marker.get("version") != 2
    or re.fullmatch(r"[0-9a-f]{40}", marker.get("candidate_sha", "")) is None
    or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", marker.get("activated_at", "")) is None
    or not isinstance(marker.get("assets"), dict)
    or set(marker["assets"]) not in (set(legacy_expected), set(current_expected))
    or marker.get("candidate_sha") != pending["protected_before_candidate_sha"]
):
    raise SystemExit(1)
marker_expected = current_expected if set(marker["assets"]) == set(current_expected) else legacy_expected
for list_name in ("managed.list", "present.list"):
    metadata = os.lstat(backup + "/" + list_name)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o644
    ):
        raise SystemExit(1)
    with open(backup + "/" + list_name, encoding="utf-8") as handle:
        entries = [line.rstrip("\n") for line in handle]
    expected_entries = {marker_path, *current_expected} if list_name == "managed.list" else {marker_path, *marker_expected}
    if any(entries.count(path) != 1 for path in expected_entries):
        raise SystemExit(1)
    if list_name == "present.list" and any(entries.count(path) != 0 for path in set(current_expected) - set(marker_expected)):
        raise SystemExit(1)
for path, mode in marker_expected.items():
    source = root + path
    metadata = os.lstat(source)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != mode:
        raise SystemExit(1)
    with open(source, "rb") as handle:
        actual = hashlib.sha256(handle.read()).hexdigest()
    if marker["assets"].get(path) != actual:
        raise SystemExit(1)
PY
    RESTORE_PROTECTED_MARKER_LAST=1
  else
    exit 65
  fi
  CREDENTIAL_PROTECTION_ACTIVE=0
  VERSIONED_ASSET_RECOVERY=1
elif [ "${NEWME_CREDENTIAL_ASSET_RECOVERY:-}" = 1 ]; then
  # The dedicated subset transaction owns its own exact backup and is the only
  # authorised path that may undo a partially installed credential control plane.
  # Ordinary application/control-plane rollbacks keep the protection active.
  CREDENTIAL_PROTECTION_ACTIVE=0
fi

is_credential_protected_asset() {
  [ "$1" = /etc/newme/newme-runtime.env ] && return 0
  [ "$CREDENTIAL_PROTECTION_ACTIVE" -eq 1 ] || return 1
  case "$1" in
    /var/lib/newme/deploy-state/credential-remediation.protected.json|\
    /etc/systemd/system/newme-platform.service|\
    /etc/tmpfiles.d/newme-credential-inbox.conf|\
    /etc/cron.d/newme-observability|\
    /usr/local/sbin/newme-deploy|\
    /usr/local/sbin/newme-production-rollback|\
    /usr/local/libexec/newme/newme-install-systemd-assets|\
    /usr/local/libexec/newme/newme-rollback-systemd-assets|\
    /usr/local/libexec/newme/newme-validate-production-config.py|\
    /usr/local/libexec/newme/newme-credential-transition.mjs|\
    /usr/local/libexec/newme/newme-credential-live-attestation.mjs|\
    /usr/local/share/newme/credential-live-attestation-policy-v1.json|\
    /usr/local/libexec/newme/newme-readiness.sh|\
    /opt/hermes-scripts/observability/dependency-probe.sh) return 0 ;;
    *) return 1 ;;
  esac
}

require_root_file_mode() {
  local path="$1" mode="$2"
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  [ "$(stat -c '%U:%G' "$path")" = root:root ] || return 1
  [ "$(stat -c '%a' "$path")" = "$mode" ] || return 1
}

verify_credential_protected_assets() {
  [ "$CREDENTIAL_PROTECTION_ACTIVE" -eq 1 ] || return 0
  local protected_generation=""
  protected_generation="$(python3 - "$CREDENTIAL_PROTECTION_RECORD" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

legacy_expected = {
    "/etc/systemd/system/newme-platform.service": 0o644,
    "/etc/tmpfiles.d/newme-credential-inbox.conf": 0o644,
    "/etc/cron.d/newme-observability": 0o644,
    "/usr/local/sbin/newme-deploy": 0o755,
    "/usr/local/sbin/newme-production-rollback": 0o755,
    "/usr/local/libexec/newme/newme-install-systemd-assets": 0o755,
    "/usr/local/libexec/newme/newme-rollback-systemd-assets": 0o755,
    "/usr/local/libexec/newme/newme-validate-production-config.py": 0o755,
    "/usr/local/libexec/newme/newme-credential-transition.mjs": 0o755,
    "/usr/local/libexec/newme/newme-readiness.sh": 0o755,
    "/opt/hermes-scripts/observability/dependency-probe.sh": 0o755,
}
current_expected = {
    **legacy_expected,
    "/usr/local/libexec/newme/newme-credential-live-attestation.mjs": 0o755,
    "/usr/local/share/newme/credential-live-attestation-policy-v1.json": 0o644,
}
with open(sys.argv[1], encoding="utf-8") as handle:
    record = json.load(handle)
if (
    not isinstance(record, dict)
    or set(record) != {"version", "candidate_sha", "activated_at", "assets"}
    or record.get("version") != 2
    or re.fullmatch(r"[0-9a-f]{40}", record.get("candidate_sha", "")) is None
    or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", record.get("activated_at", "")) is None
    or not isinstance(record.get("assets"), dict)
    or set(record["assets"]) not in (set(legacy_expected), set(current_expected))
):
    raise SystemExit(1)
expected = current_expected if set(record["assets"]) == set(current_expected) else legacy_expected
for path, mode in expected.items():
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != mode:
        raise SystemExit(1)
    with open(path, "rb") as handle:
        actual = hashlib.sha256(handle.read()).hexdigest()
    if record["assets"].get(path) != actual:
        raise SystemExit(1)
print("current" if expected is current_expected else "legacy")
PY
  )" || return 1
  [ "$protected_generation" = legacy ] || [ "$protected_generation" = current ] || return 1
  require_root_file_mode /etc/newme/newme-runtime.env 600 || return 1
  [ "$(grep -Ec '^[[:space:]]*(export[[:space:]]+)?SUPABASE_SERVICE_ROLE_KEY[[:space:]]*=' /etc/newme/newme-runtime.env)" -eq 1 ] || return 1
  require_root_file_mode /etc/systemd/system/newme-platform.service 644 || return 1
  [ "$(grep -c '^EnvironmentFile=/etc/newme/newme-runtime.env$' /etc/systemd/system/newme-platform.service)" -eq 1 ] || return 1
  require_root_file_mode /etc/tmpfiles.d/newme-credential-inbox.conf 644 || return 1
  grep -Fqx 'd /run/newme-credential-inbox 0700 root root -' /etc/tmpfiles.d/newme-credential-inbox.conf || return 1
  [ -d /run/newme-credential-inbox ] && [ ! -L /run/newme-credential-inbox ] || return 1
  [ "$(stat -c '%U:%G' /run/newme-credential-inbox)" = root:root ] || return 1
  [ "$(stat -c '%a' /run/newme-credential-inbox)" = 700 ] || return 1
  local executable
  for executable in \
    /usr/local/sbin/newme-deploy \
    /usr/local/sbin/newme-production-rollback \
    /usr/local/libexec/newme/newme-install-systemd-assets \
    /usr/local/libexec/newme/newme-rollback-systemd-assets \
    /usr/local/libexec/newme/newme-validate-production-config.py \
    /usr/local/libexec/newme/newme-credential-transition.mjs \
    /usr/local/libexec/newme/newme-readiness.sh \
    /opt/hermes-scripts/observability/dependency-probe.sh; do
    require_root_file_mode "$executable" 755 || return 1
  done
  bash -n /usr/local/sbin/newme-deploy || return 1
  bash -n /usr/local/sbin/newme-production-rollback || return 1
  bash -n /usr/local/libexec/newme/newme-install-systemd-assets || return 1
  bash -n /usr/local/libexec/newme/newme-rollback-systemd-assets || return 1
  bash -n /usr/local/libexec/newme/newme-readiness.sh || return 1
  bash -n /opt/hermes-scripts/observability/dependency-probe.sh || return 1
  node --check /usr/local/libexec/newme/newme-credential-transition.mjs >/dev/null || return 1
  if [ "$protected_generation" = current ]; then
    require_root_file_mode /usr/local/libexec/newme/newme-credential-live-attestation.mjs 755 || return 1
    node --check /usr/local/libexec/newme/newme-credential-live-attestation.mjs >/dev/null || return 1
    require_root_file_mode /usr/local/share/newme/credential-live-attestation-policy-v1.json 644 || return 1
  fi
  python3 - /usr/local/libexec/newme/newme-validate-production-config.py <<'PY' || return 1
import ast
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    ast.parse(handle.read(), filename=sys.argv[1])
PY
  require_root_file_mode /etc/cron.d/newme-observability 644 || return 1
  grep -Fqx '*/2 * * * * root /usr/bin/flock -n /run/lock/newme-observability-l0.lock /opt/hermes-scripts/observability/l0-composite-probe.sh' /etc/cron.d/newme-observability || return 1
  grep -Fq 'readonly RUNTIME_ENV=/etc/newme/newme-runtime.env' /opt/hermes-scripts/observability/dependency-probe.sh || return 1
  ! grep -Fq 'read_env_value "$RELEASE_ENV" SUPABASE_SERVICE_ROLE_KEY' /opt/hermes-scripts/observability/dependency-probe.sh || return 1
  grep -Fq 'credential-assets.pending' /usr/local/sbin/newme-production-rollback || return 1
  grep -Fq 'credential-remediation.protected.json' /usr/local/libexec/newme/newme-rollback-systemd-assets || return 1
  grep -Fq 'credential-transition' /usr/local/sbin/newme-deploy || return 1
}

NGINX_SNAPSHOT=""
NGINX_MANAGED=0
NGINX_TRANSACTION_COMMITTED=0
CRON_PATH=/etc/cron.d/newme-observability
CRON_MANAGED=0
RESTORE_TMP=""
if grep -Fqx /etc/nginx/sites-available/newme-platform "$BACKUP/managed.list" ||
  grep -Fqx /etc/nginx/sites-enabled/newme-platform "$BACKUP/managed.list"; then
  NGINX_MANAGED=1
  NGINX_SNAPSHOT="$(mktemp -d /run/newme-nginx-current.XXXXXX)"
  : > "$NGINX_SNAPSHOT/present.list"
  for nginx_path in /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform; do
    if [ -e "$nginx_path" ] || [ -L "$nginx_path" ]; then
      printf '%s\n' "$nginx_path" >> "$NGINX_SNAPSHOT/present.list"
      mkdir -p "$NGINX_SNAPSHOT/rootfs/$(dirname "${nginx_path#/}")"
      cp -a -- "$nginx_path" "$NGINX_SNAPSHOT/rootfs/${nginx_path#/}"
    fi
  done
fi
if grep -Fqx "$CRON_PATH" "$BACKUP/managed.list"; then
  CRON_MANAGED=1
fi

# Defined before restore_managed_path() and calling it: both are in place before
# anything calls either. This is the path taken when the BACKUP's own Nginx
# configuration turns out to be invalid, i.e. the second failure in a row, so it
# gets the same atomic replacement as everything else — including the
# sites-enabled symlink, which is why restore_managed_path() handles links.
restore_nginx_snapshot() {
  local nginx_path=""
  for nginx_path in /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform; do
    restore_managed_path "$nginx_path" "$NGINX_SNAPSHOT/rootfs" "$NGINX_SNAPSHOT/present.list" || return 1
  done
}

discard_nginx_snapshot() {
  if [ -n "$NGINX_SNAPSHOT" ]; then
    case "$NGINX_SNAPSHOT" in /run/newme-nginx-current.*) rm -rf -- "$NGINX_SNAPSHOT" ;; esac
  fi
}

cleanup() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ -n "$RESTORE_TMP" ]; then
    case "$RESTORE_TMP" in */.newme-asset-rollback.*) rm -f -- "$RESTORE_TMP" ;; esac
  fi
  if [ "$rc" -ne 0 ] && [ "$NGINX_MANAGED" -eq 1 ] && [ "$NGINX_TRANSACTION_COMMITTED" -eq 0 ]; then
    if restore_nginx_snapshot && nginx -t && systemctl reload nginx && systemctl is-active --quiet nginx; then
      NGINX_TRANSACTION_COMMITTED=1
      discard_nginx_snapshot
      echo "prior live Nginx configuration restored after interrupted asset rollback" >&2
    else
      echo "CRITICAL: interrupted asset rollback could not restore Nginx; snapshot retained at $NGINX_SNAPSHOT" >&2
    fi
  else
    discard_nginx_snapshot
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Put one managed path back, atomically (round-4 review C3).
#
# `rm -f` followed by `cp -a` — which every path except the cron file used to do —
# has a window in which the destination does not exist, and a second window in
# which it exists half-written. Both windows are real: this script is what runs
# when a deploy has already failed, so it runs on a host that is already having a
# bad day, and it is also called by the installer's own failure trap and by
# newme-production-rollback. Lose power inside the first window and the file is
# simply gone; inside the second and it is truncated. For
# /etc/sudoers.d/newme-platform that is the difference between a rollback and a
# host whose operator can no longer sudo the deploy wrapper; for the unit file it
# is a service that cannot start.
#
# The temp-and-rename idiom below was already here, applied to exactly one path
# (the cron file, whose window would have let cron fire a half-written schedule).
# It is the same fix for the same reason everywhere else, so it is now the only
# restore path, and rename replaces the destination in one step: a reader sees the
# old file or the new one, a crash leaves one or the other, and re-running this
# script from the same backup converges — which is what makes an interrupted
# rollback recoverable by repeating it.
#
# The temp is created in the destination's own directory (rename is only atomic
# within a filesystem) with a leading dot in its name, which is what keeps it inert
# while it exists: cron.d and sudoers.d both ignore names containing a dot, and
# nginx's include globs do not match a leading dot. cleanup() removes it if a
# signal arrives between mktemp and mv.
restore_managed_path() {
  local dest="$1" source_root="${2:-$BACKUP/rootfs}" present="${3:-$BACKUP/present.list}"
  local rel="${1#/}" directory=""
  directory="$(dirname "$dest")"
  if grep -Fqx "$dest" "$present"; then
    mkdir -p "$directory" || return 1
    RESTORE_TMP="$(mktemp "$directory/.newme-asset-rollback.XXXXXX")" || return 1
    # cp -a must create the copy itself, symlink or file, so the placeholder goes.
    rm -f -- "$RESTORE_TMP" || return 1
    cp -a -- "$source_root/$rel" "$RESTORE_TMP" || return 1
    if [ -L "$RESTORE_TMP" ]; then
      # sync -f follows the link, and a restored symlink may point at something
      # this run has not restored yet. Its filesystem is the directory's.
      sync -f "$directory" || return 1
    else
      sync -f "$RESTORE_TMP" || return 1
    fi
    mv -Tf "$RESTORE_TMP" "$dest" || return 1
    RESTORE_TMP=""
  else
    rm -f -- "$dest" || return 1
  fi
}

restore_managed_cron() {
  [ "$CRON_MANAGED" -eq 1 ] || return 0
  is_credential_protected_asset "$CRON_PATH" && return 0
  restore_managed_path "$CRON_PATH" || return 1
  sync -f /etc/cron.d || return 1
  rollback_drill_checkpoint "$CRON_PATH"
}

while IFS= read -r dest; do
  [ -n "$dest" ] || continue
  [ "$dest" != "$CRON_PATH" ] || continue
  if [ "$RESTORE_PROTECTED_MARKER_LAST" -eq 1 ] && [ "$dest" = "$CREDENTIAL_PROTECTION_RECORD" ]; then
    continue
  fi
  # The runtime environment is a host credential store, not a versioned release
  # asset. Older backups may still list it; preserving the live file prevents a
  # code/control-plane rollback from resurrecting an earlier server credential.
  is_credential_protected_asset "$dest" && continue
  restore_managed_path "$dest"
  rollback_drill_checkpoint "$dest"
done < "$BACKUP/managed.list"

for dropin in /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf; do
  restore_managed_path "$dropin"
done

systemctl daemon-reload
if [ "$NGINX_MANAGED" -eq 1 ]; then
  if ! nginx -t; then
    restore_nginx_snapshot
    nginx -t && systemctl reload nginx || {
      echo "CRITICAL: prior Nginx configuration could not be restored" >&2
      exit 66
    }
    NGINX_TRANSACTION_COMMITTED=1
    echo "asset backup Nginx configuration failed validation; prior live files restored" >&2
    exit 65
  fi
  if ! systemctl reload nginx; then
    restore_nginx_snapshot
    nginx -t && systemctl reload nginx || {
      echo "CRITICAL: prior Nginx configuration could not be reloaded" >&2
      exit 66
    }
    NGINX_TRANSACTION_COMMITTED=1
    echo "asset backup Nginx reload failed; prior live files restored" >&2
    exit 65
  fi
  systemctl is-active --quiet nginx
  NGINX_TRANSACTION_COMMITTED=1
fi
restore_managed_cron
if [ "$RESTORE_PROTECTED_MARKER_LAST" -eq 1 ]; then
  restore_managed_path "$CREDENTIAL_PROTECTION_RECORD"
  sync -f "$STATE_ROOT"
  rollback_drill_checkpoint "$CREDENTIAL_PROTECTION_RECORD"
  CREDENTIAL_PROTECTION_ACTIVE=1
elif [ "$VERSIONED_ASSET_RECOVERY" -eq 1 ] && {
  [ -e "$CREDENTIAL_PROTECTION_RECORD" ] || [ -L "$CREDENTIAL_PROTECTION_RECORD" ];
}; then
  exit 66
fi
verify_credential_protected_assets || {
  echo "credential-remediation protected assets failed rollback revalidation" >&2
  exit 66
}
for durable_path in /etc /usr/local /opt /var; do
  sync -f "$durable_path"
done
echo "restored systemd and observability assets from $BACKUP"
