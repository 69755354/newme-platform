#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exit 77
MODE="${1:-install}"
case "$MODE:$#" in
  install:0|snapshot:1|finalize:1|credential-install:1|credential-finalize:1|credential-recover:1) ;;
  *)
    echo "usage: install-systemd-assets.sh [snapshot|finalize]" >&2
    echo "       install-systemd-assets.sh <credential-install|credential-finalize|credential-recover>" >&2
    exit 64
    ;;
esac
case "$MODE" in
  credential-install|credential-finalize|credential-recover)
    [ "$(readlink /proc/self/fd/9 2>/dev/null || true)" = /run/lock/newme-production-release.lock ] || {
      echo "credential asset operations require the canonical production release lock" >&2
      exit 75
    }
    flock -n 9 || { echo "the canonical production release lock is not held" >&2; exit 75; }
    ;;
esac

# Refuse a pre-seeded alert state tree before this installer opens its own lock
# file or performs any other filesystem mutation. Production alert probes run as
# root, so accepting an application-user-owned directory and fixing it up later
# would leave a window for forged state or symlink targets. Missing paths are
# safe: the trusted tree is created only after the release transaction is open.
preflight_alert_state_trust() {
  local state_path
  if [ -e /var/lib/newme ] || [ -L /var/lib/newme ]; then
    [ -d /var/lib/newme ] && [ ! -L /var/lib/newme ] || return 1
    [ "$(stat -c '%U:%G' /var/lib/newme)" = root:root ] || return 1
    [ $((8#$(stat -c '%a' /var/lib/newme) & 8#022)) -eq 0 ] || return 1
  fi
  for state_path in /var/lib/newme/hermes-alert-v1 /var/lib/newme/hermes-alert-v1/production /var/lib/newme/hermes-alert-v1/postdeploy; do
    if [ -e "$state_path" ] || [ -L "$state_path" ]; then
      [ -d "$state_path" ] && [ ! -L "$state_path" ] || return 1
      [ "$(stat -c '%U:%G' "$state_path")" = root:root ] || return 1
      [ "$(stat -c '%a' "$state_path")" = 700 ] || return 1
    fi
  done
  if [ -e /var/lib/newme/hermes-alert-v1 ] || [ -L /var/lib/newme/hermes-alert-v1 ]; then
    python3 - /var/lib/newme/hermes-alert-v1 <<'PY'
import os
import stat
import sys

root = sys.argv[1]
for current, directories, files in os.walk(root, topdown=True, followlinks=False):
    paths = [current]
    paths.extend(os.path.join(current, name) for name in directories)
    paths.extend(os.path.join(current, name) for name in files)
    for path in paths:
        metadata = os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_gid != 0:
            raise SystemExit(1)
        if stat.S_ISDIR(metadata.st_mode):
            if stat.S_IMODE(metadata.st_mode) != 0o700:
                raise SystemExit(1)
        elif stat.S_ISREG(metadata.st_mode):
            if stat.S_IMODE(metadata.st_mode) != 0o600:
                raise SystemExit(1)
        else:
            raise SystemExit(1)
PY
  fi
}
preflight_alert_state_trust || {
  echo "existing alert state contains untrusted metadata" >&2
  exit 65
}
exec 8>/run/lock/newme-systemd-assets.lock
flock -n 8 || { echo "another versioned asset installation is active" >&2; exit 75; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${NEWME_ASSET_SOURCE_ROOT:-}" ]; then
  [ "$MODE" = snapshot ] || { echo "asset source override is snapshot-only" >&2; exit 64; }
  [ "$(dirname -- "$NEWME_ASSET_SOURCE_ROOT")" = /opt/newme/releases ] &&
    [[ "$(basename -- "$NEWME_ASSET_SOURCE_ROOT")" =~ ^[0-9a-f]{40}$ ]] || {
    echo "asset snapshot source is outside the immutable release root" >&2
    exit 65
  }
  [ -d "$NEWME_ASSET_SOURCE_ROOT" ] && [ ! -L "$NEWME_ASSET_SOURCE_ROOT" ] &&
    [ -f "$NEWME_ASSET_SOURCE_ROOT/.newme-protect" ] || exit 65
  ROOT="$NEWME_ASSET_SOURCE_ROOT"
fi
SOURCE_SHA=""
if [ "$MODE" = install ] || [ "$MODE" = credential-install ] || [ "$MODE" = credential-finalize ]; then
  SOURCE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 65
fi
STATE_ROOT=/var/lib/newme/deploy-state
install -d -o root -g root -m 0700 "$STATE_ROOT"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || exit 65
[ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || exit 65
[ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || exit 65
PENDING_RECORD="$STATE_ROOT/systemd-assets.pending"
CREDENTIAL_ASSET_PENDING="$STATE_ROOT/credential-assets.pending"
CREDENTIAL_GATE_CONSUMED="$STATE_ROOT/credential-remediation-gate.consumed"
PRODUCTION_ROLLBACK_PENDING="$STATE_ROOT/production-rollback.pending"
CREDENTIAL_TRANSITION_PENDING="$STATE_ROOT/credential-transition.pending.json"
CREDENTIAL_PROTECTION_RECORD="$STATE_ROOT/credential-remediation.protected.json"

validate_systemd_pending_record() {
  local record="$1" line_count=""
  [ -f "$record" ] && [ ! -L "$record" ] || return 1
  [ "$(stat -c '%U:%G' "$record")" = root:root ] || return 1
  [ "$(stat -c '%a' "$record")" = 600 ] || return 1
  line_count="$(wc -l < "$record")"
  case "$line_count" in
    5) ;;
    8)
      [ "$(grep -Ec '^version=2$' "$record")" -eq 1 ] || return 1
      [ "$(grep -Ec '^protected_before_candidate_sha=[0-9a-f]{40}$' "$record")" -eq 1 ] || return 1
      [ "$(grep -Ec '^protected_before_marker_sha256=[0-9a-f]{64}$' "$record")" -eq 1 ] || return 1
      ;;
    *) return 1 ;;
  esac
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$record")" -eq 1 ] || return 1
  [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$record")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$record")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$record")" -eq 1 ] || return 1
  [ "$(grep -Ec '^candidate_preexisting=0$' "$record")" -eq 1 ] || return 1
}
if { [ -e "$CREDENTIAL_TRANSITION_PENDING" ] || [ -L "$CREDENTIAL_TRANSITION_PENDING" ]; } && [ "$MODE" != credential-recover ]; then
  echo "an unresolved credential transition must be recovered before versioned asset operations" >&2
  exit 75
fi
if { [ -e "$CREDENTIAL_ASSET_PENDING" ] || [ -L "$CREDENTIAL_ASSET_PENDING" ]; } &&
  [ "$MODE" != credential-finalize ] && [ "$MODE" != credential-recover ]; then
  echo "an unresolved credential-asset transaction must be recovered before versioned asset operations" >&2
  exit 75
fi
if [ "$MODE" = credential-install ] || [ "$MODE" = credential-finalize ]; then
  if [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
    echo "credential-only assets cannot overlap another release transaction" >&2
    exit 75
  fi
fi
if [ "$MODE" = credential-install ] && {
  [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ] ||
  [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ];
}; then
  echo "credential-only assets cannot start while a prior gate or asset transaction is unresolved" >&2
  exit 75
fi

# ---------------------------------------------------------------------------
# finalize — closing a hand-run asset transaction (round-4 review C2)
# ---------------------------------------------------------------------------
# The pending record deliberately outlives this script: install mode publishes it
# before the first mutation and never removes it on success, because the
# transaction it names is bigger than the install. /usr/local/sbin/newme-deploy
# owns the rest of that transaction and clears the record itself
# (clear_matching_pending_asset_record complete), which is correct for every
# deployment from the second one onward.
#
# The first one is not a deployment. infra/release/control-plane-bootstrap.md runs
# this installer by hand, because the wrapper that would clear the record is the
# file being replaced — so a bootstrap that succeeds in every respect still leaves
# /var/lib/newme/deploy-state/systemd-assets.pending behind, and that record is not
# inert:
#   * `newme-production-rollback status` reports
#     systemd_asset_transaction=pre_switch — a monitored host permanently claiming
#     an unresolved transaction, so the one signal that would show a real
#     interrupted deploy is already lit;
#   * the next `install` takes the unresolved-transaction branch below. A bootstrap
#     does not move /opt/newme/current, so LIVE_CURRENT equals the record's
#     `previous=` exactly, the branch's own consistency check passes, and it does
#     what it is designed to do: restores the backup — the f37c203 control plane —
#     and restarts the service. The bootstrap is silently undone by the first
#     deployment that follows it.
#
# So the transaction needs a close, and the close has to verify rather than assume:
# this mode refuses unless the control plane on disk really is this release's, byte
# for byte, and the backup it would roll back to is still intact. It is idempotent
# (no record is success, not failure), it requires an explicit confirmation so
# nothing automated can call it, and its last act before removing the record is to
# make the removal durable.
if [ "$MODE" = finalize ]; then
  [ "${NEWME_ASSET_FINALIZE_CONFIRM:-}" = bootstrap ] || {
    echo "finalizing a hand-run asset transaction requires NEWME_ASSET_FINALIZE_CONFIRM=bootstrap (see infra/release/control-plane-bootstrap.md)" >&2
    exit 64
  }
  if [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; then
    echo "an unresolved production rollback must be recovered before an asset transaction can be finalized" >&2
    exit 75
  fi
  if [ ! -e "$PENDING_RECORD" ] && [ ! -L "$PENDING_RECORD" ]; then
    # Nothing to close. Reported as success on purpose: an interruption between the
    # removal and the flush below must be recoverable by running this again.
    echo "systemd_asset_transaction=none"
    exit 0
  fi
  validate_systemd_pending_record "$PENDING_RECORD" || {
    echo "the unresolved versioned asset pointer is invalid" >&2
    exit 65
  }
  FINALIZE_SHA="$(sed -n 's/^sha=//p' "$PENDING_RECORD")"
  FINALIZE_BACKUP="$(sed -n 's/^backup=//p' "$PENDING_RECORD")"
  FINALIZE_PREVIOUS="$(sed -n 's/^previous=//p' "$PENDING_RECORD")"

  # The tree this runs from must be the release the transaction installed. Same
  # derivation install mode uses, so "finalize" cannot be run from a different
  # checkout than the one whose bytes are about to be declared live.
  FINALIZE_TREE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ "$FINALIZE_TREE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
    echo "finalize must run from the git worktree of the release it is closing" >&2
    exit 65
  }
  [ "$FINALIZE_TREE_SHA" = "$FINALIZE_SHA" ] || {
    echo "this worktree is not the release the unresolved asset transaction installed" >&2
    exit 65
  }

  # The transaction is closable only from a state a rollback would still leave
  # consistent: either the release was never switched (the bootstrap case, current
  # is still the record's previous) or the candidate is live (a completed switch).
  FINALIZE_CURRENT="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  FINALIZE_STATE=""
  if [ "$FINALIZE_CURRENT" = "/opt/newme/releases/$FINALIZE_SHA" ]; then
    FINALIZE_STATE=candidate_active
  elif [ "$FINALIZE_CURRENT" = "$FINALIZE_PREVIOUS" ]; then
    FINALIZE_STATE=control_plane_only
  else
    echo "the release pointer matches neither the transaction's candidate nor its recovery point; recover it before finalizing" >&2
    exit 65
  fi

  # A record that points at a vanished backup is the state `newme-production-rollback
  # status` calls invalid. Finalizing it would erase the evidence instead of the
  # transaction, so it is refused here and has to be looked at.
  [ -d "$FINALIZE_BACKUP/rootfs" ] &&
    [ -f "$FINALIZE_BACKUP/managed.list" ] &&
    [ -f "$FINALIZE_BACKUP/present.list" ] &&
    [ -f "$FINALIZE_BACKUP/manifest.sha256" ] &&
    [ -f "$FINALIZE_BACKUP/symlink.sha256" ] || {
    echo "the backup this transaction would roll back to is incomplete; it must not be closed" >&2
    exit 65
  }

  # What "installed" means, checked rather than assumed. Kept in step with the
  # install_control_* calls below by
  # tests/release/control-plane-bootstrap-contract.test.mjs, which requires this
  # list and those call lines to be the same set of (source, destination) pairs.
  FINALIZE_CONTROL_PLANE=(
    "scripts/install-systemd-assets.sh:/usr/local/libexec/newme/newme-install-systemd-assets:755"
    "scripts/rollback-systemd-assets.sh:/usr/local/libexec/newme/newme-rollback-systemd-assets:755"
    "infra/systemd/newme-service-control.sh:/usr/local/sbin/newme-service-control:755"
    "infra/systemd/newme-production-rollback.sh:/usr/local/sbin/newme-production-rollback:755"
    "scripts/validate-production-config.py:/usr/local/libexec/newme/newme-validate-production-config.py:755"
    "scripts/credential-transition.mjs:/usr/local/libexec/newme/newme-credential-transition.mjs:755"
    "scripts/credential-live-attestation.mjs:/usr/local/libexec/newme/newme-credential-live-attestation.mjs:755"
    "infra/release/credential-live-attestation-policy-v1.json:/usr/local/share/newme/credential-live-attestation-policy-v1.json:644"
    "infra/systemd/newme-deploy.sh:/usr/local/sbin/newme-deploy:755"
    "infra/sudoers/newme-platform:/etc/sudoers.d/newme-platform:440"
  )
  for entry in "${FINALIZE_CONTROL_PLANE[@]}"; do
    source="$ROOT/${entry%%:*}"
    rest="${entry#*:}"
    dest="${rest%%:*}"
    expected_mode="${rest#*:}"
    [ -f "$dest" ] && [ ! -L "$dest" ] || {
      echo "the control plane is not this release's: $dest is missing" >&2
      exit 65
    }
    cmp -s "$source" "$dest" || {
      echo "the control plane is not this release's: $dest differs from the tree being finalized" >&2
      exit 65
    }
    [ "$(stat -c '%U:%G' "$dest")" = root:root ] || { echo "control-plane ownership is invalid: $dest" >&2; exit 65; }
    [ "$(stat -c '%a' "$dest")" = "$expected_mode" ] || { echo "control-plane mode is invalid: $dest" >&2; exit 65; }
  done
  if [ -e /etc/sudoers.d/ubuntu-nopasswd ] || [ -L /etc/sudoers.d/ubuntu-nopasswd ]; then
    echo "the control plane is not this release's: /etc/sudoers.d/ubuntu-nopasswd is still present" >&2
    exit 65
  fi

  rm -f -- "$PENDING_RECORD"
  sync -f "$STATE_ROOT"
  if [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; then
    echo "CRITICAL: the unresolved versioned asset pointer survived its removal" >&2
    exit 66
  fi
  echo "finalized=$FINALIZE_SHA state=$FINALIZE_STATE backup=$FINALIZE_BACKUP"
  echo "systemd_asset_transaction=none"
  exit 0
fi

# ---------------------------------------------------------------------------
# The bootstrap precondition (round-3 P1-10)
# ---------------------------------------------------------------------------
# Production still runs the old f37c203 wrapper, which passes no CI_EVENT and runs
# none of the taskboard, remote-history or job-level gates — yet it calls this
# script, and this script replaces the whole control plane. So the gate cannot live
# only in the wrapper: the installer has to demand the evidence itself, before it
# does anything at all. Nothing below this point may mutate the host until the
# release's own wrapper has proved every gate ran for this exact SHA.
#
# This is deliberately the first thing after the state directory is validated: the
# unresolved-transaction recovery below restarts the service, and the control plane
# install after it is only reversible because of the backup taken for it. Neither
# may happen on the word of a wrapper that checked nothing.
if [ "$MODE" = install ]; then
  GATE_RECORD="${NEWME_DEPLOY_GATE_RECORD:-}"
  [ -n "$GATE_RECORD" ] || {
    echo "no deploy gate record was passed: this release's control plane may only be installed by a wrapper that has run its gates (see infra/release/control-plane-bootstrap.md)" >&2
    exit 78
  }
  case "$GATE_RECORD" in
    "$STATE_ROOT"/deploy-gates.*) ;;
    *) echo "the deploy gate record must be in the protected persistent deploy-state directory" >&2; exit 64 ;;
  esac
  GATE_NODE_BIN="${NEWME_NODE_BIN:-$(command -v node || true)}"
  [ -n "$GATE_NODE_BIN" ] && [ -x "$GATE_NODE_BIN" ] || {
    echo "node is required to verify the deploy gate record" >&2
    exit 65
  }
  "$GATE_NODE_BIN" "$ROOT/scripts/verify-deploy-gate-record.mjs" \
    --record "$GATE_RECORD" \
    --expect-sha "$SOURCE_SHA" \
    --state-root "$STATE_ROOT" || {
    echo "the deploy gate record does not prove this release's preconditions were checked" >&2
    exit 78
  }
fi
if [ "$MODE" = install ] && { [ -e "$PRODUCTION_ROLLBACK_PENDING" ] || [ -L "$PRODUCTION_ROLLBACK_PENDING" ]; }; then
  echo "an unresolved production rollback must be recovered before installing assets" >&2
  exit 75
fi
if [ "$MODE" = install ] && { [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; }; then
  validate_systemd_pending_record "$PENDING_RECORD" || {
    echo "the unresolved versioned asset pointer is invalid" >&2
    exit 65
  }
  PENDING_SHA="$(sed -n 's/^sha=//p' "$PENDING_RECORD")"
  PENDING_BACKUP="$(sed -n 's/^backup=//p' "$PENDING_RECORD")"
  PENDING_PREVIOUS="$(sed -n 's/^previous=//p' "$PENDING_RECORD")"
  PENDING_PREVIOUS_ROLLBACK="$(sed -n 's/^previous_rollback=//p' "$PENDING_RECORD")"
  [ -d "$PENDING_BACKUP/rootfs" ] &&
    [ -f "$PENDING_BACKUP/managed.list" ] &&
    [ -f "$PENDING_BACKUP/present.list" ] &&
    [ -f "$PENDING_BACKUP/manifest.sha256" ] &&
    [ -f "$PENDING_BACKUP/symlink.sha256" ] || exit 65
  LIVE_CURRENT="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  if [ "$LIVE_CURRENT" = "/opt/newme/releases/$PENDING_SHA" ]; then
    echo "an unresolved deployment still has its candidate release active; protected asset pointer retained" >&2
    exit 75
  fi
  [ "$LIVE_CURRENT" = "$PENDING_PREVIOUS" ] || {
    echo "the unresolved deployment current target does not match its protected recovery point" >&2
    exit 65
  }
  echo "recovering unresolved versioned assets from $PENDING_BACKUP" >&2
  if ! NEWME_VERSIONED_ASSET_RECOVERY=1 bash "$ROOT/scripts/rollback-systemd-assets.sh" "$PENDING_BACKUP"; then
    echo "CRITICAL: unresolved versioned asset recovery failed for $PENDING_BACKUP" >&2
    exit 66
  fi
  RECOVERY_ROLLBACK_NEXT="/opt/newme/current.rollback.recovery-$$"
  rm -f -- "$RECOVERY_ROLLBACK_NEXT"
  if [ -n "$PENDING_PREVIOUS_ROLLBACK" ]; then
    ln -s "$PENDING_PREVIOUS_ROLLBACK" "$RECOVERY_ROLLBACK_NEXT"
    mv -Tf "$RECOVERY_ROLLBACK_NEXT" /opt/newme/current.rollback
  else
    rm -f -- /opt/newme/current.rollback
  fi
  sync -f /opt/newme
  /usr/local/sbin/newme-service-control reset-failed "deploy:pending-recovery:reset" || true
  /usr/local/sbin/newme-service-control restart "deploy:pending-recovery"
  curl -fsS --max-time 10 http://127.0.0.1:3001/api/health >/dev/null
  RECOVERY_CANDIDATE="/opt/newme/releases/$PENDING_SHA"
  if [ -e "$RECOVERY_CANDIDATE" ] || [ -L "$RECOVERY_CANDIDATE" ]; then
    [ -d "$RECOVERY_CANDIDATE" ] && [ ! -L "$RECOVERY_CANDIDATE" ] || exit 65
    [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" != "$RECOVERY_CANDIDATE" ] || exit 65
    [ "$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)" != "$RECOVERY_CANDIDATE" ] || exit 65
    rm -rf --one-file-system -- "$RECOVERY_CANDIDATE"
    [ ! -e "$RECOVERY_CANDIDATE" ] && [ ! -L "$RECOVERY_CANDIDATE" ] || exit 65
  fi
  sync -f /opt/newme/releases
  rm -f -- "$PENDING_RECORD"
  sync -f "$STATE_ROOT"
fi
if [ "$MODE" = install ]; then
  CANDIDATE_RELEASE="/opt/newme/releases/$SOURCE_SHA"
  if [ -e "$CANDIDATE_RELEASE" ] || [ -L "$CANDIDATE_RELEASE" ]; then
    echo "candidate release already exists before asset installation" >&2
    exit 65
  fi
fi
PREVIOUS_CURRENT=""
# `readlink -f` prints the path it was given when only the last component is
# missing, so an absent rollback pointer canonicalises to the literal string
# "/opt/newme/current.rollback" rather than to nothing. The check below then failed
# and this script exited 65 with no message on any host that has no rollback pointer
# yet — which is exactly the host the bootstrap in
# infra/release/control-plane-bootstrap.md runs on. The pending record's grammar
# admits an empty previous_rollback and the recovery branch above handles it
# (`rm -f -- /opt/newme/current.rollback`), so absence has to reach it as absence.
PREVIOUS_ROLLBACK=""
BACKUP=""
ROOTFS=""

create_backup() {
  local STAMP
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -o root -g root -m 0700 /var/backups/newme-systemd-assets
  BACKUP="$(mktemp -d "/var/backups/newme-systemd-assets/${STAMP}.XXXXXX")"
  ROOTFS="$BACKUP/rootfs"
  mkdir -p "$ROOTFS"
  : > "$BACKUP/present.list"
  : > "$BACKUP/managed.list"
  : > "$BACKUP/manifest.sha256"
  : > "$BACKUP/symlink.sha256"
}

remember() {
  local dest="$1" rel="${1#/}"
  printf '%s\n' "$dest" >> "$BACKUP/managed.list"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf '%s\n' "$dest" >> "$BACKUP/present.list"
    mkdir -p "$ROOTFS/$(dirname "$rel")"
    cp -a -- "$dest" "$ROOTFS/$rel"
    if [ -L "$dest" ]; then
      link_hash="$(printf '%s' "$(readlink -- "$dest")" | sha256sum | awk '{print $1}')"
      printf '%s  %s\n' "$link_hash" "$dest" >> "$BACKUP/symlink.sha256"
    elif [ -f "$dest" ]; then
      # Keyed relative to rootfs, because that is where the restore verifies it:
      # scripts/rollback-systemd-assets.sh runs `cd "$BACKUP/rootfs" && sha256sum -c`.
      # An absolute key resolved to the directory the backup was *taken* in, so a
      # backup that had been copied or moved verified the original copy's bytes and
      # then restored the copy's — an integrity check that could pass for a file it
      # had not read.
      ( cd "$ROOTFS" && sha256sum -- "$rel" ) >> "$BACKUP/manifest.sha256"
    else
      echo "managed asset must be a regular file or symlink: $dest" >&2
      exit 65
    fi
  fi
}

capture_protected_backup_identity() {
  local identity=""
  PROTECTED_BEFORE_CANDIDATE_SHA=""
  PROTECTED_BEFORE_MARKER_SHA256=""
  if [ ! -e "$CREDENTIAL_PROTECTION_RECORD" ] && [ ! -L "$CREDENTIAL_PROTECTION_RECORD" ]; then
    return 0
  fi
  identity="$(python3 - "$BACKUP" "$CREDENTIAL_PROTECTION_RECORD" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

backup, live_marker = sys.argv[1:]
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
for path, mode in ((live_marker, 0o600), (backup + "/rootfs" + marker_path, 0o600)):
    metadata = os.lstat(path)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != mode:
        raise SystemExit(1)
with open(live_marker, "rb") as handle:
    live_bytes = handle.read()
with open(backup + "/rootfs" + marker_path, "rb") as handle:
    backup_bytes = handle.read()
if live_bytes != backup_bytes:
    raise SystemExit(1)
marker = json.loads(backup_bytes)
if (
    not isinstance(marker, dict)
    or set(marker) != {"version", "candidate_sha", "activated_at", "assets"}
    or marker.get("version") != 2
    or re.fullmatch(r"[0-9a-f]{40}", marker.get("candidate_sha", "")) is None
    or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", marker.get("activated_at", "")) is None
    or not isinstance(marker.get("assets"), dict)
    or set(marker["assets"]) not in (set(legacy_expected), set(current_expected))
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
    source = backup + "/rootfs" + path
    metadata = os.lstat(source)
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SystemExit(1)
    if metadata.st_uid != 0 or metadata.st_gid != 0 or stat.S_IMODE(metadata.st_mode) != mode:
        raise SystemExit(1)
    with open(source, "rb") as handle:
        actual = hashlib.sha256(handle.read()).hexdigest()
    if marker["assets"].get(path) != actual:
        raise SystemExit(1)
print(marker["candidate_sha"], hashlib.sha256(backup_bytes).hexdigest())
PY
)" || return 1
  read -r PROTECTED_BEFORE_CANDIDATE_SHA PROTECTED_BEFORE_MARKER_SHA256 <<<"$identity"
  [[ "$PROTECTED_BEFORE_CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$PROTECTED_BEFORE_MARKER_SHA256" =~ ^[0-9a-f]{64}$ ]] || return 1
}

# Round-4 review C3, same defect as scripts/rollback-systemd-assets.sh had: `rm -f`
# then `cp -a` leaves the destination missing and then half-written, and this runs
# when the candidate's Nginx configuration has already failed validation. Replace by
# rename instead, so a crash here leaves the old file or the new one.
RESTORE_TMP=""
restore_path() {
  local dest="$1" rel="${1#/}" directory=""
  directory="$(dirname "$dest")"
  if grep -Fqx "$dest" "$BACKUP/present.list"; then
    mkdir -p "$directory"
    RESTORE_TMP="$(mktemp "$directory/.newme-asset-restore.XXXXXX")"
    rm -f -- "$RESTORE_TMP"
    cp -a -- "$ROOTFS/$rel" "$RESTORE_TMP"
    if [ -L "$RESTORE_TMP" ]; then sync -f "$directory"; else sync -f "$RESTORE_TMP"; fi
    mv -Tf "$RESTORE_TMP" "$dest"
    RESTORE_TMP=""
    sync -f "$directory"
  else
    rm -f -- "$dest"
  fi
}

install_control_script() {
  local source="$1" dest="$2" directory="" temporary=""
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  directory="$(dirname "$dest")"
  install -d -o root -g root -m 0755 "$directory" || return 1
  case "$source" in
    *.mjs) temporary="$(mktemp "${dest}.new.XXXXXX.mjs")" || return 1 ;;
    *) temporary="$(mktemp "${dest}.new.XXXXXX")" || return 1 ;;
  esac
  if ! install -o root -g root -m 0755 "$source" "$temporary"; then
    rm -f -- "$temporary" 2>/dev/null || true
    return 1
  fi
  case "$source" in
    *.mjs) node --check "$temporary" >/dev/null || { rm -f -- "$temporary"; return 1; } ;;
    *.py) python3 - "$temporary" <<'PY' || { rm -f -- "$temporary"; return 1; }
import ast
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    ast.parse(handle.read(), filename=sys.argv[1])
PY
      ;;
    *) bash -n "$temporary" || { rm -f -- "$temporary"; return 1; } ;;
  esac
  if ! sync -f "$temporary" ||
    ! mv -Tf "$temporary" "$dest" ||
    ! sync -f "$directory"; then
    rm -f -- "$temporary" 2>/dev/null || true
    return 1
  fi
}

install_control_sudoers() {
  local source="$1" dest="$2" directory="" temporary=""
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  directory="$(dirname "$dest")"
  install -d -o root -g root -m 0755 "$directory" || return 1
  temporary="$(mktemp "${dest}.new.XXXXXX")" || return 1
  if ! install -o root -g root -m 0440 "$source" "$temporary" ||
    ! visudo -cf "$temporary" ||
    ! sync -f "$temporary" ||
    ! mv -Tf "$temporary" "$dest" ||
    ! sync -f "$directory"; then
    rm -f -- "$temporary" 2>/dev/null || true
    return 1
  fi
}

install_control_file() {
  local source="$1" dest="$2" mode="$3" directory="" temporary=""
  [ -f "$source" ] && [ ! -L "$source" ] || return 1
  case "$mode" in 0644|0755) ;; *) return 1 ;; esac
  directory="$(dirname "$dest")"
  install -d -o root -g root -m 0755 "$directory" || return 1
  temporary="$(mktemp "${dest}.new.XXXXXX")" || return 1
  if ! install -o root -g root -m "$mode" "$source" "$temporary" ||
    ! sync -f "$temporary" ||
    ! mv -Tf "$temporary" "$dest" ||
    ! sync -f "$directory"; then
    rm -f -- "$temporary" 2>/dev/null || true
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Protected credential-remediation subset
# ---------------------------------------------------------------------------
# This transaction deliberately excludes the application unit, Nginx, release
# pointer and database. It installs only the recovery/credential controller and
# the two non-application consumers that must follow the fixed runtime store.
CREDENTIAL_SUBSET=(
  "scripts/install-systemd-assets.sh:/usr/local/libexec/newme/newme-install-systemd-assets:755"
  "scripts/rollback-systemd-assets.sh:/usr/local/libexec/newme/newme-rollback-systemd-assets:755"
  "scripts/validate-production-config.py:/usr/local/libexec/newme/newme-validate-production-config.py:755"
  "scripts/credential-transition.mjs:/usr/local/libexec/newme/newme-credential-transition.mjs:755"
  "scripts/credential-live-attestation.mjs:/usr/local/libexec/newme/newme-credential-live-attestation.mjs:755"
  "infra/release/credential-live-attestation-policy-v1.json:/usr/local/share/newme/credential-live-attestation-policy-v1.json:644"
  "infra/systemd/newme-readiness.sh:/usr/local/libexec/newme/newme-readiness.sh:755"
  "infra/systemd/newme-production-rollback.sh:/usr/local/sbin/newme-production-rollback:755"
  "infra/observability/dependency-probe.sh:/opt/hermes-scripts/observability/dependency-probe.sh:755"
  "infra/tmpfiles/newme-credential-inbox.conf:/etc/tmpfiles.d/newme-credential-inbox.conf:644"
  "infra/observability/newme-observability.cron:/etc/cron.d/newme-observability:644"
  "infra/systemd/newme-deploy.sh:/usr/local/sbin/newme-deploy:755"
)

validate_consumed_credential_gate() {
  local expected_sha="$1" expected_run="$2" expected_attempt="$3" expected_digest="$4"
  [ -f "$CREDENTIAL_GATE_CONSUMED" ] && [ ! -L "$CREDENTIAL_GATE_CONSUMED" ] || return 1
  [ "$(stat -c '%U:%G' "$CREDENTIAL_GATE_CONSUMED")" = root:root ] || return 1
  [ "$(stat -c '%a' "$CREDENTIAL_GATE_CONSUMED")" = 600 ] || return 1
  [ "$(sha256sum "$CREDENTIAL_GATE_CONSUMED" | awk '{print $1}')" = "$expected_digest" ] || return 1
  [ "$(wc -l < "$CREDENTIAL_GATE_CONSUMED")" -eq 9 ] || return 1
  [ "$(grep -Ec "^sha=$expected_sha$" "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || return 1
  [ "$(grep -Ec "^run=$expected_run$" "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || return 1
  [ "$(grep -Ec "^run_attempt=$expected_attempt$" "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || return 1
  [ "$(grep -Ec '^event=workflow_dispatch$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || return 1
  [ "$(grep -Ec '^mode=credential_remediation$' "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || return 1
  for gate in canonical-main-verified github-credential-remediation-jobs-green taskboard-credential-remediation-ready credential-assets-only; do
    [ "$(grep -Ec "^gate=$gate$" "$CREDENTIAL_GATE_CONSUMED")" -eq 1 ] || return 1
  done
}

credential_drill_checkpoint() {
  local checkpoint="$1"
  [ -z "${NEWME_CREDENTIAL_DRILL_CHECKPOINT:-}" ] && return 0
  [ "${NEWME_DRILL_CONFIRM:-}" = throwaway-container ] &&
    { [ -f /.dockerenv ] || [ -f /run/.containerenv ]; } || {
      echo "credential crash checkpoints are restricted to a throwaway container" >&2
      return 64
    }
  [ "$NEWME_CREDENTIAL_DRILL_CHECKPOINT" = "$checkpoint" ] || return 0
  kill -KILL "$$"
}

load_consumed_credential_gate_identity() {
  [ -f "$CREDENTIAL_GATE_CONSUMED" ] && [ ! -L "$CREDENTIAL_GATE_CONSUMED" ] || return 1
  CREDENTIAL_RECORD_SHA="$(sed -n 's/^sha=//p' "$CREDENTIAL_GATE_CONSUMED")"
  CREDENTIAL_RECORD_RUN="$(sed -n 's/^run=//p' "$CREDENTIAL_GATE_CONSUMED")"
  CREDENTIAL_RECORD_ATTEMPT="$(sed -n 's/^run_attempt=//p' "$CREDENTIAL_GATE_CONSUMED")"
  CREDENTIAL_RECORD_GATE_SHA256="$(sha256sum "$CREDENTIAL_GATE_CONSUMED" | awk '{print $1}')"
  validate_consumed_credential_gate "$CREDENTIAL_RECORD_SHA" "$CREDENTIAL_RECORD_RUN" "$CREDENTIAL_RECORD_ATTEMPT" "$CREDENTIAL_RECORD_GATE_SHA256"
}

clear_credential_asset_records() {
  rm -f -- "$CREDENTIAL_ASSET_PENDING"
  sync -f "$STATE_ROOT"
  rm -f -- "$PENDING_RECORD"
  sync -f "$STATE_ROOT"
  rm -f -- "$CREDENTIAL_GATE_CONSUMED"
  sync -f "$STATE_ROOT"
  for cleared in "$CREDENTIAL_ASSET_PENDING" "$PENDING_RECORD" "$CREDENTIAL_GATE_CONSUMED"; do
    [ ! -e "$cleared" ] && [ ! -L "$cleared" ] || return 1
  done
}

validate_credential_compat_fence() {
  local expected_sha="$1" expected_backup="$2"
  [ -f "$PENDING_RECORD" ] && [ ! -L "$PENDING_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$PENDING_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$PENDING_RECORD")" = 600 ] || return 1
  [ "$(wc -l < "$PENDING_RECORD")" -eq 5 ] || return 1
  [ "$(grep -Ec "^sha=$expected_sha$" "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec "^backup=$expected_backup$" "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^candidate_preexisting=0$' "$PENDING_RECORD")" -eq 1 ] || return 1
}

validate_credential_asset_record() {
  [ -f "$CREDENTIAL_ASSET_PENDING" ] && [ ! -L "$CREDENTIAL_ASSET_PENDING" ] || return 1
  [ "$(stat -c '%U:%G' "$CREDENTIAL_ASSET_PENDING")" = root:root ] || return 1
  [ "$(stat -c '%a' "$CREDENTIAL_ASSET_PENDING")" = 600 ] || return 1
  [ "$(wc -l < "$CREDENTIAL_ASSET_PENDING")" -eq 8 ] || return 1
  [ "$(grep -Ec '^version=1$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^run=[1-9][0-9]*$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^run_attempt=[1-9][0-9]*$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^gate_sha256=[0-9a-f]{64}$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^phase=prepared$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  [ "$(grep -Ec '^mode=credential_remediation$' "$CREDENTIAL_ASSET_PENDING")" -eq 1 ] || return 1
  CREDENTIAL_RECORD_SHA="$(sed -n 's/^sha=//p' "$CREDENTIAL_ASSET_PENDING")"
  CREDENTIAL_RECORD_RUN="$(sed -n 's/^run=//p' "$CREDENTIAL_ASSET_PENDING")"
  CREDENTIAL_RECORD_ATTEMPT="$(sed -n 's/^run_attempt=//p' "$CREDENTIAL_ASSET_PENDING")"
  CREDENTIAL_RECORD_GATE_SHA256="$(sed -n 's/^gate_sha256=//p' "$CREDENTIAL_ASSET_PENDING")"
  CREDENTIAL_RECORD_BACKUP="$(sed -n 's/^backup=//p' "$CREDENTIAL_ASSET_PENDING")"
  validate_consumed_credential_gate "$CREDENTIAL_RECORD_SHA" "$CREDENTIAL_RECORD_RUN" "$CREDENTIAL_RECORD_ATTEMPT" "$CREDENTIAL_RECORD_GATE_SHA256" || return 1
  validate_credential_compat_fence "$CREDENTIAL_RECORD_SHA" "$CREDENTIAL_RECORD_BACKUP" || return 1
  [ -d "$CREDENTIAL_RECORD_BACKUP/rootfs" ] && [ ! -L "$CREDENTIAL_RECORD_BACKUP" ] || return 1
  for required in managed.list present.list manifest.sha256 symlink.sha256; do
    [ -f "$CREDENTIAL_RECORD_BACKUP/$required" ] && [ ! -L "$CREDENTIAL_RECORD_BACKUP/$required" ] || return 1
  done
  (cd "$CREDENTIAL_RECORD_BACKUP/rootfs" && sha256sum -c "$CREDENTIAL_RECORD_BACKUP/manifest.sha256" >/dev/null) || return 1
}

verify_credential_subset_exact() {
  local entry source rest dest expected_mode
  for entry in "${CREDENTIAL_SUBSET[@]}"; do
    source="$ROOT/${entry%%:*}"
    rest="${entry#*:}"
    dest="${rest%%:*}"
    expected_mode="${rest#*:}"
    [ -f "$dest" ] && [ ! -L "$dest" ] || return 1
    [ "$(stat -c '%U:%G' "$dest")" = root:root ] || return 1
    [ "$(stat -c '%a' "$dest")" = "$expected_mode" ] || return 1
    cmp -s "$source" "$dest" || return 1
  done
  [ -f /etc/newme/newme-runtime.env ] && [ ! -L /etc/newme/newme-runtime.env ] || return 1
  [ "$(stat -c '%U:%G' /etc/newme/newme-runtime.env)" = root:root ] || return 1
  [ "$(stat -c '%a' /etc/newme/newme-runtime.env)" = 600 ] || return 1
  [ -f /etc/systemd/system/newme-platform.service ] && [ ! -L /etc/systemd/system/newme-platform.service ] || return 1
  [ "$(grep -c '^EnvironmentFile=/etc/newme/newme-runtime.env$' /etc/systemd/system/newme-platform.service)" -eq 1 ] || return 1
  systemd-tmpfiles --create /etc/tmpfiles.d/newme-credential-inbox.conf || return 1
  [ -d /run/newme-credential-inbox ] && [ ! -L /run/newme-credential-inbox ] || return 1
  [ "$(stat -c '%U:%G' /run/newme-credential-inbox)" = root:root ] || return 1
  [ "$(stat -c '%a' /run/newme-credential-inbox)" = 700 ] || return 1
  [ -d /run/newme-credential-live-input ] && [ ! -L /run/newme-credential-live-input ] || return 1
  [ "$(stat -c '%U:%G' /run/newme-credential-live-input)" = root:root ] || return 1
  [ "$(stat -c '%a' /run/newme-credential-live-input)" = 700 ] || return 1
  grep -Fqx '*/2 * * * * root /usr/bin/flock -n /run/lock/newme-observability-l0.lock /opt/hermes-scripts/observability/l0-composite-probe.sh' /etc/cron.d/newme-observability || return 1
  grep -Fq 'readonly RUNTIME_ENV=/etc/newme/newme-runtime.env' /opt/hermes-scripts/observability/dependency-probe.sh || return 1
  ! grep -Fq 'read_env_value "$RELEASE_ENV" SUPABASE_SERVICE_ROLE_KEY' /opt/hermes-scripts/observability/dependency-probe.sh || return 1
  grep -Fq 'credential-assets.pending' /usr/local/sbin/newme-production-rollback || return 1
  grep -Fq 'credential-remediation.protected.json' /usr/local/libexec/newme/newme-rollback-systemd-assets || return 1
}

if [ "$MODE" = credential-finalize ]; then
  if [ ! -e "$CREDENTIAL_ASSET_PENDING" ] && [ ! -L "$CREDENTIAL_ASSET_PENDING" ]; then
    if [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ] ||
      [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ]; then
      echo "credential asset finalization found an incomplete pre-install state; run credential-recover" >&2
      exit 75
    fi
    verify_credential_subset_exact || exit 65
    echo "credential_asset_transaction=none"
    exit 0
  fi
  validate_credential_asset_record || { echo "credential-asset pending record is invalid" >&2; exit 65; }
  [ "$CREDENTIAL_RECORD_SHA" = "$SOURCE_SHA" ] || { echo "credential-asset finalizer tree does not match the pending SHA" >&2; exit 65; }
  verify_credential_subset_exact || { echo "credential-only installed assets do not match the exact remediation tree" >&2; exit 65; }
  systemctl is-active --quiet newme-platform.service || exit 65
  /usr/local/libexec/newme/newme-readiness.sh >/dev/null || exit 65
  clear_credential_asset_records || exit 66
  echo "credential_asset_transaction=none finalized=$SOURCE_SHA"
  exit 0
fi

if [ "$MODE" = credential-recover ]; then
  if [ ! -e "$CREDENTIAL_ASSET_PENDING" ] && [ ! -L "$CREDENTIAL_ASSET_PENDING" ]; then
    if [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; then
      load_consumed_credential_gate_identity || { echo "credential recovery cannot bind the compatibility fence to a consumed gate" >&2; exit 65; }
      CREDENTIAL_COMPAT_SHA="$(sed -n 's/^sha=//p' "$PENDING_RECORD")"
      CREDENTIAL_COMPAT_BACKUP="$(sed -n 's/^backup=//p' "$PENDING_RECORD")"
      validate_credential_compat_fence "$CREDENTIAL_COMPAT_SHA" "$CREDENTIAL_COMPAT_BACKUP" || exit 65
      [ "$CREDENTIAL_COMPAT_SHA" = "$CREDENTIAL_RECORD_SHA" ] || exit 65
      RECOVERY_TREE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
      [ "$RECOVERY_TREE_SHA" = "$CREDENTIAL_RECORD_SHA" ] || exit 65
      NEWME_CREDENTIAL_ASSET_RECOVERY=1 bash "$ROOT/scripts/rollback-systemd-assets.sh" "$CREDENTIAL_COMPAT_BACKUP" || exit 66
      systemctl is-active --quiet newme-platform.service || exit 66
      /usr/local/libexec/newme/newme-readiness.sh >/dev/null || exit 66
      clear_credential_asset_records || exit 66
      echo "credential_asset_transaction=none recovered=$CREDENTIAL_RECORD_SHA"
      exit 0
    fi
    if [ -e "$CREDENTIAL_GATE_CONSUMED" ] || [ -L "$CREDENTIAL_GATE_CONSUMED" ]; then
      load_consumed_credential_gate_identity || exit 65
      rm -f -- "$CREDENTIAL_GATE_CONSUMED"
      sync -f "$STATE_ROOT"
      [ ! -e "$CREDENTIAL_GATE_CONSUMED" ] && [ ! -L "$CREDENTIAL_GATE_CONSUMED" ] || exit 66
      echo "credential_asset_transaction=none consumed_gate_recovered=$CREDENTIAL_RECORD_SHA"
      exit 0
    fi
    echo "credential_asset_transaction=none"
    exit 0
  fi
  validate_credential_asset_record || { echo "credential-asset pending record is invalid" >&2; exit 65; }
  RECOVERY_TREE_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  [ "$RECOVERY_TREE_SHA" = "$CREDENTIAL_RECORD_SHA" ] || {
    echo "credential-asset recovery must run from the exact pending SHA" >&2
    exit 65
  }
  NEWME_CREDENTIAL_ASSET_RECOVERY=1 bash "$ROOT/scripts/rollback-systemd-assets.sh" "$CREDENTIAL_RECORD_BACKUP" || {
    echo "CRITICAL: credential-only asset recovery failed" >&2
    exit 66
  }
  systemctl is-active --quiet newme-platform.service || exit 66
  /usr/local/libexec/newme/newme-readiness.sh >/dev/null || exit 66
  clear_credential_asset_records || exit 66
  echo "credential_asset_transaction=none recovered=$CREDENTIAL_RECORD_SHA"
  exit 0
fi

if [ "$MODE" = credential-install ]; then
  CREDENTIAL_GATE_RECORD="${NEWME_CREDENTIAL_GATE_RECORD:-}"
  case "$CREDENTIAL_GATE_RECORD" in
    "$STATE_ROOT"/credential-remediation-gates.*) ;;
    *) echo "a protected credential-remediation gate record is required" >&2; exit 78 ;;
  esac
  CREDENTIAL_NODE_BIN="${NEWME_NODE_BIN:-$(command -v node || true)}"
  [ -n "$CREDENTIAL_NODE_BIN" ] && [ -x "$CREDENTIAL_NODE_BIN" ] || exit 65
  "$CREDENTIAL_NODE_BIN" "$ROOT/scripts/verify-credential-remediation-gate-record.mjs" \
    --record "$CREDENTIAL_GATE_RECORD" \
    --expect-sha "$SOURCE_SHA" \
    --expect-attempt "$(sed -n 's/^run_attempt=//p' "$CREDENTIAL_GATE_RECORD")" \
    --state-root "$STATE_ROOT" || {
      echo "credential-only installer gate record was refused" >&2
      exit 78
    }
  CREDENTIAL_GATE_RUN="$(sed -n 's/^run=//p' "$CREDENTIAL_GATE_RECORD")"
  CREDENTIAL_GATE_ATTEMPT="$(sed -n 's/^run_attempt=//p' "$CREDENTIAL_GATE_RECORD")"
  CREDENTIAL_GATE_SHA256="$(sha256sum "$CREDENTIAL_GATE_RECORD" | awk '{print $1}')"
  [ ! -e "$CREDENTIAL_GATE_CONSUMED" ] && [ ! -L "$CREDENTIAL_GATE_CONSUMED" ] || exit 75
  mv -T -- "$CREDENTIAL_GATE_RECORD" "$CREDENTIAL_GATE_CONSUMED"
  sync -f "$STATE_ROOT"
  validate_consumed_credential_gate "$SOURCE_SHA" "$CREDENTIAL_GATE_RUN" "$CREDENTIAL_GATE_ATTEMPT" "$CREDENTIAL_GATE_SHA256" || exit 65
  credential_drill_checkpoint after_gate_consumed
  create_backup
  for entry in "${CREDENTIAL_SUBSET[@]}"; do
    rest="${entry#*:}"
    remember "${rest%%:*}"
  done
  sync -f "$BACKUP"
  PREVIOUS_CURRENT="$(readlink -f /opt/newme/current 2>/dev/null || true)"
  [[ "$PREVIOUS_CURRENT" =~ ^/opt/newme/releases/[0-9a-f]{40}$ ]] || exit 65
  PREVIOUS_ROLLBACK=""
  if [ -L /opt/newme/current.rollback ]; then
    PREVIOUS_ROLLBACK="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
    [[ "$PREVIOUS_ROLLBACK" =~ ^/opt/newme/releases/[0-9a-f]{40}$ ]] || exit 65
  fi
  CREDENTIAL_COMPAT_TMP="$(mktemp "$STATE_ROOT/systemd-assets.pending.XXXXXX")"
  chmod 0600 "$CREDENTIAL_COMPAT_TMP"
  printf 'sha=%s\nbackup=%s\nprevious=%s\nprevious_rollback=%s\ncandidate_preexisting=0\n' \
    "$SOURCE_SHA" "$BACKUP" "$PREVIOUS_CURRENT" "$PREVIOUS_ROLLBACK" > "$CREDENTIAL_COMPAT_TMP"
  ln -- "$CREDENTIAL_COMPAT_TMP" "$PENDING_RECORD"
  rm -f -- "$CREDENTIAL_COMPAT_TMP"
  sync -f "$STATE_ROOT"
  validate_credential_compat_fence "$SOURCE_SHA" "$BACKUP" || exit 65
  credential_drill_checkpoint after_systemd_pending
  CREDENTIAL_PENDING_TMP="$(mktemp "$STATE_ROOT/credential-assets.pending.XXXXXX")"
  chmod 0600 "$CREDENTIAL_PENDING_TMP"
  printf 'version=1\nsha=%s\nrun=%s\nrun_attempt=%s\ngate_sha256=%s\nbackup=%s\nphase=prepared\nmode=credential_remediation\n' \
    "$SOURCE_SHA" "$CREDENTIAL_GATE_RUN" "$CREDENTIAL_GATE_ATTEMPT" "$CREDENTIAL_GATE_SHA256" "$BACKUP" > "$CREDENTIAL_PENDING_TMP"
  ln -- "$CREDENTIAL_PENDING_TMP" "$CREDENTIAL_ASSET_PENDING"
  rm -f -- "$CREDENTIAL_PENDING_TMP"
  sync -f "$STATE_ROOT"

  CREDENTIAL_INSTALL_COMMITTED=0
  credential_install_cleanup() {
    rc=$?
    trap - EXIT HUP INT TERM
    if [ "$rc" -ne 0 ] && [ "$CREDENTIAL_INSTALL_COMMITTED" -eq 0 ]; then
      if NEWME_CREDENTIAL_ASSET_RECOVERY=1 bash "$ROOT/scripts/rollback-systemd-assets.sh" "$BACKUP"; then
        clear_credential_asset_records || rc=2
      else
        echo "CRITICAL: credential-only asset rollback failed; pending record retained" >&2
        rc=2
      fi
    fi
    exit "$rc"
  }
  trap credential_install_cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  install_control_script "$ROOT/scripts/install-systemd-assets.sh" /usr/local/libexec/newme/newme-install-systemd-assets
  install_control_script "$ROOT/scripts/rollback-systemd-assets.sh" /usr/local/libexec/newme/newme-rollback-systemd-assets
  install_control_script "$ROOT/scripts/validate-production-config.py" /usr/local/libexec/newme/newme-validate-production-config.py
  install_control_script "$ROOT/scripts/credential-transition.mjs" /usr/local/libexec/newme/newme-credential-transition.mjs
  install_control_script "$ROOT/scripts/credential-live-attestation.mjs" /usr/local/libexec/newme/newme-credential-live-attestation.mjs
  install_control_file "$ROOT/infra/release/credential-live-attestation-policy-v1.json" /usr/local/share/newme/credential-live-attestation-policy-v1.json 0644
  install_control_script "$ROOT/infra/systemd/newme-readiness.sh" /usr/local/libexec/newme/newme-readiness.sh
  install_control_script "$ROOT/infra/systemd/newme-production-rollback.sh" /usr/local/sbin/newme-production-rollback
  install_control_script "$ROOT/infra/observability/dependency-probe.sh" /opt/hermes-scripts/observability/dependency-probe.sh
  install_control_file "$ROOT/infra/tmpfiles/newme-credential-inbox.conf" /etc/tmpfiles.d/newme-credential-inbox.conf 0644
  install_control_file "$ROOT/infra/observability/newme-observability.cron" /etc/cron.d/newme-observability 0644
  # Install the coordinator last. If a power loss happens earlier, the candidate
  # coordinator can be re-extracted from the root-owned mirror and recover the
  # durable record; once this rename lands, the normal installed entry point can.
  install_control_script "$ROOT/infra/systemd/newme-deploy.sh" /usr/local/sbin/newme-deploy
  verify_credential_subset_exact || exit 65
  for durable_path in /etc /usr/local /opt /var; do sync -f "$durable_path"; done
  CREDENTIAL_INSTALL_COMMITTED=1
  trap - EXIT HUP INT TERM
  echo "credential_asset_transaction=pending sha=$SOURCE_SHA backup=$BACKUP"
  exit 0
fi

PREVIOUS_CURRENT="$(readlink -f /opt/newme/current 2>/dev/null || true)"
[[ "$PREVIOUS_CURRENT" =~ ^/opt/newme/releases/[0-9a-f]{40}$ ]] || {
  echo "the live release pointer /opt/newme/current is not an immutable release path" >&2
  exit 65
}
if [ -e /opt/newme/current.rollback ] || [ -L /opt/newme/current.rollback ]; then
  PREVIOUS_ROLLBACK="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
  [[ "$PREVIOUS_ROLLBACK" =~ ^/opt/newme/releases/[0-9a-f]{40}$ ]] || {
    echo "the rollback release pointer /opt/newme/current.rollback is not an immutable release path" >&2
    exit 65
  }
fi
create_backup

UNIT="$ROOT/infra/systemd/newme-platform.service"
[ "$(grep -c '^ExecStopPost=' "$UNIT")" -eq 1 ] || exit 65
cmp -s "$UNIT" "$ROOT/newme-platform.service" || exit 65
systemd-analyze verify "$UNIT"

MANAGED=(
  /var/lib/newme/deploy-state/credential-remediation.protected.json
  /etc/systemd/system/newme-platform.service
  /usr/local/libexec/newme/newme-forensic.sh
  /usr/local/libexec/newme/newme-readiness.sh
  /etc/tmpfiles.d/newme-credential-inbox.conf
  /etc/logrotate.d/newme-forensic
  /etc/cron.d/newme-observability
  /etc/nginx/sites-available/newme-platform
  /etc/nginx/sites-enabled/newme-platform
  /etc/hermes/observability/hermes-alert-v1.env
  /opt/hermes-scripts/observability/health-check.sh
  /opt/hermes-scripts/observability/login-probe.sh
  /opt/hermes-scripts/observability/dependency-probe.sh
  /opt/hermes-scripts/observability/l0-composite-probe.sh
  /opt/hermes-scripts/observability/auth-log-probe.py
  /opt/hermes-scripts/observability/hermes-alert-notifier-v1.sh
  /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs
  /opt/hermes-scripts/observability/hermes-alert-state-v1.sh
  /opt/hermes-scripts/observability/incident-capture.sh
  /opt/hermes-scripts/observability/incident-review.sh
  /opt/hermes-scripts/observability/newme-service-health.py
  /opt/hermes-scripts/observability/sentry-cron-checkin.sh
  /opt/hermes-scripts/observability/sentry-release.sh
  /opt/hermes-scripts/observability/supabase-pool-monitor.sh
)
# The control plane itself. Round-3 P1-10: these were installed before the backup
# existed and were not in the backup set, so a deployment that replaced the deploy
# wrapper could not put the previous one back — "forward-only" was a description of
# a missing rollback, not a property worth having. They are remembered first and
# installed after the transaction is open, so the pre-deploy control plane is
# restorable by scripts/rollback-systemd-assets.sh like every other managed path.
CONTROL_PLANE=(
  /usr/local/libexec/newme/newme-install-systemd-assets
  /usr/local/libexec/newme/newme-rollback-systemd-assets
  /usr/local/sbin/newme-service-control
  /usr/local/sbin/newme-production-rollback
  /usr/local/libexec/newme/newme-validate-production-config.py
  /usr/local/libexec/newme/newme-credential-transition.mjs
  /usr/local/libexec/newme/newme-credential-live-attestation.mjs
  /usr/local/share/newme/credential-live-attestation-policy-v1.json
  /usr/local/sbin/newme-deploy
  /etc/sudoers.d/newme-platform
  # Removed unconditionally below; without it in the set the removal is one-way.
  /etc/sudoers.d/ubuntu-nopasswd
)
for p in "${MANAGED[@]}" "${CONTROL_PLANE[@]}" /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf; do remember "$p"; done
capture_protected_backup_identity || {
  echo "the prior credential-remediation protection snapshot is invalid" >&2
  exit 65
}

if [ "$MODE" = snapshot ]; then
  SNAPSHOT_RECORD="${NEWME_ASSET_SNAPSHOT_RECORD:-}"
  case "$SNAPSHOT_RECORD" in
    "$STATE_ROOT"/asset-snapshot.*) ;;
    *) echo "asset snapshot record must be in the protected persistent deploy-state directory" >&2; exit 64 ;;
  esac
  [ -f "$SNAPSHOT_RECORD" ] && [ ! -L "$SNAPSHOT_RECORD" ] || exit 65
  [ "$(stat -c '%U:%G' "$SNAPSHOT_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$SNAPSHOT_RECORD")" = 600 ] || exit 65
  printf '%s\n' "$BACKUP" > "$SNAPSHOT_RECORD"
  sync -f "$BACKUP"
  sync -f "$STATE_ROOT"
  echo "snapshot=$BACKUP"
  exit 0
fi

INSTALL_COMMITTED=0
PENDING_TMP=""
ROLLBACK_COMPLETED=0
rollback_on_error() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [ "$rc" -ne 0 ] && [ "$INSTALL_COMMITTED" -eq 0 ]; then
    echo "asset installation failed; restoring $BACKUP" >&2
    if NEWME_VERSIONED_ASSET_RECOVERY=1 bash "$ROOT/scripts/rollback-systemd-assets.sh" "$BACKUP"; then
      ROLLBACK_COMPLETED=1
    else
      echo "CRITICAL: automatic asset rollback failed for $BACKUP" >&2
    fi
  fi
  if [ "$ROLLBACK_COMPLETED" -eq 1 ] && [ -f "$PENDING_RECORD" ] && [ ! -L "$PENDING_RECORD" ]; then
    pending_backup="$(sed -n 's/^backup=//p' "$PENDING_RECORD" | head -n 1)"
    [ "$pending_backup" != "$BACKUP" ] || rm -f -- "$PENDING_RECORD"
  fi
  if [ "$ROLLBACK_COMPLETED" -eq 1 ] && ! sync -f "$STATE_ROOT"; then
    echo "CRITICAL: rolled-back asset transaction state could not be flushed" >&2
    ROLLBACK_COMPLETED=0
    rc=2
  fi
  if [ -n "$PENDING_TMP" ]; then
    case "$PENDING_TMP" in "$STATE_ROOT"/systemd-assets.pending.*) rm -f -- "$PENDING_TMP" ;; esac
  fi
  if [ -n "$RESTORE_TMP" ]; then
    case "$RESTORE_TMP" in */.newme-asset-restore.*) rm -f -- "$RESTORE_TMP" ;; esac
  fi
  if [ "$ROLLBACK_COMPLETED" -eq 1 ] && [ -n "${NEWME_ASSET_BACKUP_RECORD:-}" ]; then
    : > "$NEWME_ASSET_BACKUP_RECORD" 2>/dev/null || true
  fi
  exit "$rc"
}
trap rollback_on_error EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Publish both recovery pointers after the backup is complete and before the
# first live asset mutation. The fixed pointer is created without replacement,
# so an unresolved transaction can never lose its original rollback target.
if [ -n "${NEWME_ASSET_BACKUP_RECORD:-}" ]; then
  case "$NEWME_ASSET_BACKUP_RECORD" in
    "$STATE_ROOT"/systemd-assets-backup.*) ;;
    *) echo "asset backup record must be in the protected persistent deploy-state directory" >&2; exit 64 ;;
  esac
  [ -f "$NEWME_ASSET_BACKUP_RECORD" ] && [ ! -L "$NEWME_ASSET_BACKUP_RECORD" ] || exit 65
  [ "$(stat -c '%U:%G' "$NEWME_ASSET_BACKUP_RECORD")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$NEWME_ASSET_BACKUP_RECORD")" = 600 ] || exit 65
  printf '%s\n' "$BACKUP" > "$NEWME_ASSET_BACKUP_RECORD"
fi
PENDING_TMP="$(mktemp "$STATE_ROOT/systemd-assets.pending.XXXXXX")"
chmod 0600 "$PENDING_TMP"
if [ -n "$PROTECTED_BEFORE_CANDIDATE_SHA" ]; then
  printf 'version=2\nsha=%s\nbackup=%s\nprevious=%s\nprevious_rollback=%s\ncandidate_preexisting=0\nprotected_before_candidate_sha=%s\nprotected_before_marker_sha256=%s\n' \
    "$SOURCE_SHA" "$BACKUP" "$PREVIOUS_CURRENT" "$PREVIOUS_ROLLBACK" \
    "$PROTECTED_BEFORE_CANDIDATE_SHA" "$PROTECTED_BEFORE_MARKER_SHA256" > "$PENDING_TMP"
else
  printf 'sha=%s\nbackup=%s\nprevious=%s\nprevious_rollback=%s\ncandidate_preexisting=0\n' \
    "$SOURCE_SHA" "$BACKUP" "$PREVIOUS_CURRENT" "$PREVIOUS_ROLLBACK" > "$PENDING_TMP"
fi
ln -- "$PENDING_TMP" "$PENDING_RECORD"
rm -f -- "$PENDING_TMP"
PENDING_TMP=""
sync -f "$BACKUP"
sync -f "$STATE_ROOT"

# The recovery control plane is installed inside the open transaction — after the
# backup, the failure trap and both recovery pointers exist, and never before them.
# Install every dependency before the controller that consumes it, and atomically
# replace each executable. No versioned runtime asset is mutated until the complete
# recovery plane is live.
install_control_script "$ROOT/scripts/install-systemd-assets.sh" /usr/local/libexec/newme/newme-install-systemd-assets
install_control_script "$ROOT/scripts/rollback-systemd-assets.sh" /usr/local/libexec/newme/newme-rollback-systemd-assets
install_control_script "$ROOT/infra/systemd/newme-service-control.sh" /usr/local/sbin/newme-service-control
install_control_script "$ROOT/infra/systemd/newme-production-rollback.sh" /usr/local/sbin/newme-production-rollback
install_control_script "$ROOT/scripts/validate-production-config.py" /usr/local/libexec/newme/newme-validate-production-config.py
install_control_script "$ROOT/scripts/credential-transition.mjs" /usr/local/libexec/newme/newme-credential-transition.mjs
install_control_script "$ROOT/scripts/credential-live-attestation.mjs" /usr/local/libexec/newme/newme-credential-live-attestation.mjs
install_control_file "$ROOT/infra/release/credential-live-attestation-policy-v1.json" /usr/local/share/newme/credential-live-attestation-policy-v1.json 0644
install_control_script "$ROOT/infra/systemd/newme-deploy.sh" /usr/local/sbin/newme-deploy
install_control_sudoers "$ROOT/infra/sudoers/newme-platform" /etc/sudoers.d/newme-platform
rm -f -- /etc/sudoers.d/ubuntu-nopasswd
sync -f /etc/sudoers.d
visudo -c

install -D -o root -g root -m 0644 "$UNIT" /etc/systemd/system/newme-platform.service
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-forensic.sh" /usr/local/libexec/newme/newme-forensic.sh
install -D -o root -g root -m 0755 "$ROOT/infra/systemd/newme-readiness.sh" /usr/local/libexec/newme/newme-readiness.sh
install -D -o root -g root -m 0644 "$ROOT/infra/logrotate/newme-forensic" /etc/logrotate.d/newme-forensic
install -D -o root -g root -m 0644 "$ROOT/infra/tmpfiles/newme-credential-inbox.conf" /etc/tmpfiles.d/newme-credential-inbox.conf
systemd-tmpfiles --create /etc/tmpfiles.d/newme-credential-inbox.conf
[ -d /run/newme-credential-inbox ] && [ ! -L /run/newme-credential-inbox ] || exit 65
[ "$(stat -c '%U:%G' /run/newme-credential-inbox)" = root:root ] || exit 65
[ "$(stat -c '%a' /run/newme-credential-inbox)" = 700 ] || exit 65
[ -d /run/newme-credential-live-input ] && [ ! -L /run/newme-credential-live-input ] || exit 65
[ "$(stat -c '%U:%G' /run/newme-credential-live-input)" = root:root ] || exit 65
[ "$(stat -c '%a' /run/newme-credential-live-input)" = 700 ] || exit 65

install -d -o root -g root -m 0750 /etc/newme /etc/hermes/observability
install -d -o root -g root -m 0755 /opt/newme/releases /opt/hermes-scripts/observability
install -d -o root -g root -m 0700 \
  /var/lib/newme/hermes-alert-v1 \
  /var/lib/newme/hermes-alert-v1/production \
  /var/lib/newme/hermes-alert-v1/postdeploy
for state_path in /var/lib/newme/hermes-alert-v1 /var/lib/newme/hermes-alert-v1/production /var/lib/newme/hermes-alert-v1/postdeploy; do
  [ -d "$state_path" ] && [ ! -L "$state_path" ] || exit 65
  [ "$(stat -c '%U:%G' "$state_path")" = root:root ] || exit 65
  [ "$(stat -c '%a' "$state_path")" = 700 ] || exit 65
done

MIRROR=/opt/newme/repository.git
EXPECTED_MIRROR_ORIGIN=https://github.com/69755354/newme-platform.git
if [ -e "$MIRROR" ] || [ -L "$MIRROR" ]; then
  mirror_origin="$(git --git-dir="$MIRROR" remote get-url origin 2>/dev/null || true)"
  if [ "$mirror_origin" != "$EXPECTED_MIRROR_ORIGIN" ] && [ "$mirror_origin" != git@github.com:69755354/newme-platform.git ]; then
    mv -- "$MIRROR" "$BACKUP/repository.git.invalid"
  fi
fi
if [ ! -d "$MIRROR" ]; then
  git clone --bare "$EXPECTED_MIRROR_ORIGIN" "$MIRROR"
fi
chown -R root:root "$MIRROR"
chmod 0700 "$MIRROR"
if [ ! -e /opt/newme/current ]; then
  mkdir -p /opt/newme/releases/.bootstrap
  ln -s /opt/newme/releases/.bootstrap /opt/newme/current
fi
[ -L /opt/newme/current ] || { echo "current must be a symlink" >&2; exit 66; }
case "$(readlink -f /opt/newme/current)" in /opt/newme/releases/*) ;; *) echo "current must target /opt/newme/releases" >&2; exit 66;; esac
RUNTIME_ENV=/etc/newme/newme-runtime.env
if [ ! -e "$RUNTIME_ENV" ]; then
  umask 077
  printf 'NEWME_READINESS_TOKEN=%s\n' "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" > "$RUNTIME_ENV"
fi
[ ! -L "$RUNTIME_ENV" ] && [ -f "$RUNTIME_ENV" ] || exit 65
[ "$(grep -Ec '^NEWME_READINESS_TOKEN=' "$RUNTIME_ENV")" -eq 1 ] || exit 65
grep -Eq '^NEWME_READINESS_TOKEN=[0-9a-f]{64}$' "$RUNTIME_ENV" || exit 65
umask 077
RUNTIME_TMP="$(mktemp /etc/newme/newme-runtime.env.XXXXXX)"
awk '$0 !~ /^[[:space:]]*(export[[:space:]]+)?NEXT_PUBLIC_SITE_URL=/' "$RUNTIME_ENV" > "$RUNTIME_TMP"
printf 'NEXT_PUBLIC_SITE_URL=https://app.newme.ae\n' >> "$RUNTIME_TMP"
chown root:root "$RUNTIME_TMP"
chmod 0600 "$RUNTIME_TMP"
mv -f "$RUNTIME_TMP" "$RUNTIME_ENV"
[ "$(grep -Ec '^NEXT_PUBLIC_SITE_URL=https://app\.newme\.ae$' "$RUNTIME_ENV")" -eq 1 ] || exit 65
VALIDATOR_ARGS=(
  --release-env /opt/newme/current/.env.local
  --runtime-env "$RUNTIME_ENV"
)
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?SUPABASE_SERVICE_ROLE_KEY[[:space:]]*=' "$RUNTIME_ENV"; then
  VALIDATOR_ARGS+=(--require-runtime-service-key)
fi
python3 "$ROOT/scripts/validate-production-config.py" "${VALIDATOR_ARGS[@]}"

rm -f /etc/systemd/system/newme-platform.service.d/forensic.conf /etc/systemd/system/newme-platform.service.d/restart-always.conf
install -d -o root -g adm -m 0750 /var/log/newme-forensic
touch /var/log/newme-forensic/newme-forensic.log
chown root:adm /var/log/newme-forensic/newme-forensic.log
chmod 0640 /var/log/newme-forensic/newme-forensic.log

OBS=/opt/hermes-scripts/observability
for a in health-check.sh login-probe.sh dependency-probe.sh l0-composite-probe.sh auth-log-probe.py hermes-alert-notifier-v1.sh newme-alert-provider-v1.mjs hermes-alert-state-v1.sh incident-capture.sh incident-review.sh newme-service-health.py sentry-cron-checkin.sh sentry-release.sh supabase-pool-monitor.sh; do
  install -D -o root -g root -m 0755 "$ROOT/infra/observability/$a" "$OBS/$a"
done
PROVIDER_CONFIG=/etc/newme/postdeploy-alert-provider-v1.json
[ -f "$PROVIDER_CONFIG" ] && [ ! -L "$PROVIDER_CONFIG" ] &&
  [ "$(stat -c '%U:%G' "$PROVIDER_CONFIG")" = root:root ] || {
  echo "root-owned postdeploy alert provider configuration is required" >&2
  exit 65
}
case "$(stat -c '%a' "$PROVIDER_CONFIG")" in 400|600) ;; *) echo "postdeploy alert provider configuration mode must be 0400 or 0600" >&2; exit 65 ;; esac
"$OBS/newme-alert-provider-v1.mjs" validate-config >/dev/null || {
  echo "postdeploy alert provider identity configuration is invalid" >&2
  exit 65
}
ALERT_POLICY=/etc/hermes/observability/hermes-alert-v1.env
install -D -o root -g root -m 0640 "$ROOT/infra/observability/hermes-alert-v1.env.example" "$ALERT_POLICY"
[ -f "$ALERT_POLICY" ] && [ ! -L "$ALERT_POLICY" ] || exit 65
[ "$(stat -c '%U:%G' "$ALERT_POLICY")" = root:root ] || exit 65
[ "$(stat -c '%a' "$ALERT_POLICY")" = 640 ] || exit 65
cmp -s "$ROOT/infra/observability/hermes-alert-v1.env.example" "$ALERT_POLICY" || exit 65

NGINX_AVAILABLE=/etc/nginx/sites-available/newme-platform
NGINX_ENABLED=/etc/nginx/sites-enabled/newme-platform
nginx -V 2>&1 | grep -Fq -- '--with-http_realip_module' || {
  echo "nginx realip module is required" >&2
  exit 65
}
install -D -o root -g root -m 0644 "$ROOT/infra/nginx/newme-platform.conf" "$NGINX_AVAILABLE"
install -D -o root -g root -m 0644 "$ROOT/infra/nginx/newme-platform.conf" "$NGINX_ENABLED"
if ! nginx -t; then
  restore_path "$NGINX_AVAILABLE"
  restore_path "$NGINX_ENABLED"
  nginx -t || true
  echo "nginx configuration validation failed and was restored" >&2
  exit 65
fi
if ! systemctl reload nginx; then
  restore_path "$NGINX_AVAILABLE"
  restore_path "$NGINX_ENABLED"
  nginx -t && systemctl reload nginx || true
  echo "nginx reload failed and the prior configuration was restored" >&2
  exit 65
fi

# Publish the new schedule only after every script it references is installed
# and Nginx has accepted the versioned ingress configuration.
install -D -o root -g root -m 0644 "$ROOT/infra/observability/newme-observability.cron" /etc/cron.d/newme-observability

systemctl daemon-reload
systemd-analyze verify /etc/systemd/system/newme-platform.service
FRAGMENT="$(systemctl show newme-platform.service -p FragmentPath --value)"
DROP_INS="$(systemctl show newme-platform.service -p DropInPaths --value)"
[ "$FRAGMENT" = /etc/systemd/system/newme-platform.service ]
[ -z "$DROP_INS" ]
grep -Fqx '/var/log/newme-forensic/newme-forensic.log {' /etc/logrotate.d/newme-forensic
grep -Fqx '*/2 * * * * root /usr/bin/flock -n /run/lock/newme-observability-l0.lock /opt/hermes-scripts/observability/l0-composite-probe.sh' /etc/cron.d/newme-observability
test -x /opt/hermes-scripts/observability/auth-log-probe.py
test -x /opt/hermes-scripts/observability/dependency-probe.sh
test -x /opt/hermes-scripts/observability/l0-composite-probe.sh
test -x /opt/hermes-scripts/observability/newme-alert-provider-v1.mjs
cmp -s /etc/nginx/sites-available/newme-platform /etc/nginx/sites-enabled/newme-platform
grep -Fq 'real_ip_header CF-Connecting-IP;' /etc/nginx/sites-enabled/newme-platform
! grep -Eq '/codex_uat_key|/qr\.png|/tmp/codex_uat_key|/tmp/astrbot_qr' /etc/nginx/sites-enabled/newme-platform
systemctl is-active --quiet nginx
test -x /usr/local/sbin/newme-deploy
test -x /usr/local/sbin/newme-production-rollback
test -x /usr/local/libexec/newme/newme-install-systemd-assets
test -x /usr/local/libexec/newme/newme-rollback-systemd-assets
test -x /usr/local/libexec/newme/newme-validate-production-config.py
test -x /usr/local/libexec/newme/newme-credential-transition.mjs
test -x /usr/local/libexec/newme/newme-credential-live-attestation.mjs
test -f /usr/local/share/newme/credential-live-attestation-policy-v1.json
[ -d /run/newme-credential-inbox ] && [ ! -L /run/newme-credential-inbox ]
[ "$(stat -c '%U:%G' /run/newme-credential-inbox)" = root:root ]
[ "$(stat -c '%a' /run/newme-credential-inbox)" = 700 ]
case "$(git --git-dir=/opt/newme/repository.git remote get-url origin)" in
  https://github.com/69755354/newme-platform.git|git@github.com:69755354/newme-platform.git) ;;
  *) exit 65 ;;
esac
if [ -e "$CREDENTIAL_PROTECTION_RECORD" ] || [ -L "$CREDENTIAL_PROTECTION_RECORD" ]; then
  [ -f "$CREDENTIAL_PROTECTION_RECORD" ] && [ ! -L "$CREDENTIAL_PROTECTION_RECORD" ] || exit 65
  /usr/local/libexec/newme/newme-credential-transition.mjs refresh-protection "$SOURCE_SHA" >/dev/null
fi
for durable_path in /etc /usr/local /opt /var; do
  sync -f "$durable_path"
done
echo "backup=$BACKUP rollback=sudo bash $ROOT/scripts/rollback-systemd-assets.sh $BACKUP"
INSTALL_COMMITTED=1
trap - EXIT HUP INT TERM
