#!/usr/bin/env bash
# Real filesystem transaction drill for the credential-only asset subset. It is
# destructive by design and therefore refuses every non-container host.
set -uo pipefail

[ "${NEWME_DRILL_CONFIRM:-}" = throwaway-container ] || exit 64
[ -f /.dockerenv ] || [ -f /run/.containerenv ] || exit 64
[ "$(id -u)" -eq 0 ] || exit 77
REPO="${NEWME_DRILL_REPO:-/repo}"
[ -f "$REPO/scripts/install-systemd-assets.sh" ] || exit 64
for path in /opt/newme/current /etc/newme/newme-runtime.env /var/lib/newme/deploy-state; do
  [ ! -e "$path" ] && [ ! -L "$path" ] || exit 64
done

WORK=/var/tmp/newme-credential-assets-drill
TREE="$WORK/release"
STUBS="$WORK/stubs"
STATE_ROOT=/var/lib/newme/deploy-state
FAILURES=0
CHECKS=0
pass() { CHECKS=$((CHECKS + 1)); printf 'ok %s\n' "$1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf 'FAIL %s\n' "$1"; }
check() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 expected=$2 actual=$1"; fi; }
digest() { sha256sum "$1" | awk '{print $1}'; }

mkdir -p "$TREE" "$STUBS" /run/lock
(cd "$REPO" && tar -cf - scripts infra newme-platform.service) | (cd "$TREE" && tar -xf -)
git -C "$TREE" init -q
git -C "$TREE" add -A
git -C "$TREE" -c user.email=drill@example.invalid -c user.name=drill commit -qm release
TREE_SHA="$(git -C "$TREE" rev-parse HEAD)"
git clone -q --bare "$TREE" /opt/newme/repository.git
git --git-dir=/opt/newme/repository.git remote set-url origin https://github.com/69755354/newme-platform.git
chown -R root:root /opt/newme/repository.git

cat >"$STUBS/systemctl" <<'EOF'
#!/bin/sh
case "$1" in is-active) exit 0 ;; esac
exit 0
EOF
cat >"$STUBS/systemd-tmpfiles" <<'EOF'
#!/bin/sh
for directory in /run/newme-credential-inbox /run/newme-credential-live-input; do
  mkdir -p "$directory"
  chown root:root "$directory"
  chmod 0700 "$directory"
done
EOF
cat >"$STUBS/curl" <<'EOF'
#!/bin/sh
case "$*" in *api/auth/session*) printf 400 ;; *api/health*) printf 200 ;; esac
exit 0
EOF
cat >"$STUBS/nginx" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$STUBS/systemd-analyze" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 "$STUBS"/*

mkdir -p /etc/newme /etc/systemd/system /etc/tmpfiles.d /etc/cron.d \
  /usr/local/libexec/newme /usr/local/sbin /opt/hermes-scripts/observability \
  /opt/newme/releases/$TREE_SHA "$STATE_ROOT" /var/backups/newme-systemd-assets
chown root:root "$STATE_ROOT" /var/backups/newme-systemd-assets
chmod 0700 "$STATE_ROOT" /var/backups/newme-systemd-assets
cp -a "$TREE/infra/systemd/newme-platform.service" /etc/systemd/system/newme-platform.service
chmod 0644 /etc/systemd/system/newme-platform.service
SYNTHETIC_SERVICE_KEY="sb_${SYNTHETIC_SERVICE_KIND:-secret}_$(printf '0%.0s' $(seq 1 48))"
printf 'NEWME_READINESS_TOKEN=%s\nNEXT_PUBLIC_SITE_URL=https://app.newme.ae\nSUPABASE_SERVICE_ROLE_KEY=%s\n' \
  "$(printf 'f%.0s' $(seq 1 64))" "$SYNTHETIC_SERVICE_KEY" >/etc/newme/newme-runtime.env
chmod 0600 /etc/newme/newme-runtime.env
: >"/opt/newme/releases/$TREE_SHA/.newme-protect"
cp -a "$TREE"/. "/opt/newme/releases/$TREE_SHA/"
ln -s "/opt/newme/releases/$TREE_SHA" /opt/newme/current

CREDENTIAL_DESTS=(
  /usr/local/libexec/newme/newme-install-systemd-assets
  /usr/local/libexec/newme/newme-rollback-systemd-assets
  /usr/local/libexec/newme/newme-validate-production-config.py
  /usr/local/libexec/newme/newme-credential-transition.mjs
  /usr/local/libexec/newme/newme-credential-live-attestation.mjs
  /usr/local/share/newme/credential-live-attestation-policy-v1.json
  /usr/local/libexec/newme/newme-readiness.sh
  /usr/local/sbin/newme-production-rollback
  /opt/hermes-scripts/observability/dependency-probe.sh
  /etc/tmpfiles.d/newme-credential-inbox.conf
  /etc/cron.d/newme-observability
  /usr/local/sbin/newme-deploy
)
PROTECTED_ASSET_DESTS=(
  /etc/systemd/system/newme-platform.service
  "${CREDENTIAL_DESTS[@]}"
)
for dest in "${CREDENTIAL_DESTS[@]}"; do
  mkdir -p "$(dirname "$dest")"
  case "$dest" in
    /etc/*|*.json) printf '# pre-remediation %s\n' "$dest" >"$dest"; chmod 0644 "$dest" ;;
    *) printf '#!/usr/bin/env bash\n# pre-remediation %s\nexit 0\n' "$dest" >"$dest"; chmod 0755 "$dest" ;;
  esac
  chown root:root "$dest"
done

gate_record() {
  local record
  record="$(mktemp "$STATE_ROOT/credential-remediation-gates.XXXXXX")"
  chmod 0600 "$record"
  cat >"$record" <<EOF
sha=$TREE_SHA
event=workflow_dispatch
run=99999999
run_attempt=1
mode=credential_remediation
gate=canonical-main-verified
gate=github-credential-remediation-jobs-green
gate=taskboard-credential-remediation-ready
gate=credential-assets-only
EOF
  echo "$record"
}

run_mode() {
  local mode="$1" record="" rc
  [ "$mode" != credential-install ] || record="$(gate_record)"
  [ -z "$record" ] || printf '%s\n' "$record" >"$WORK/last-gate-record"
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    PATH="$STUBS:$PATH" NEWME_CREDENTIAL_GATE_RECORD="$record" \
      bash "$TREE/scripts/install-systemd-assets.sh" "$mode"
  ) >"$WORK/$mode.out" 2>"$WORK/$mode.err"
  rc=$?
  [ -z "$record" ] || rm -f -- "$record"
  return "$rc"
}

run_mode_with_record() {
  local mode="$1" record="$2"
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    PATH="$STUBS:$PATH" NEWME_CREDENTIAL_GATE_RECORD="$record" \
      bash "$TREE/scripts/install-systemd-assets.sh" "$mode"
  ) >"$WORK/$mode-replay.out" 2>"$WORK/$mode-replay.err"
}

run_crash_checkpoint() {
  local checkpoint="$1" record="" rc=0
  record="$(gate_record)"
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    PATH="$STUBS:$PATH" NEWME_CREDENTIAL_GATE_RECORD="$record" \
      NEWME_DRILL_CONFIRM=throwaway-container NEWME_CREDENTIAL_DRILL_CHECKPOINT="$checkpoint" \
      bash "$TREE/scripts/install-systemd-assets.sh" credential-install
  ) >"$WORK/$checkpoint.out" 2>"$WORK/$checkpoint.err"
  rc=$?
  rm -f -- "$record"
  [ "$rc" -ne 0 ]
}

run_candidate_credential_recover() {
  PATH="$STUBS:$PATH" bash "$TREE/infra/systemd/newme-deploy.sh" credential-recover
}

UNIT_BEFORE="$(digest /etc/systemd/system/newme-platform.service)"
CURRENT_BEFORE="$(readlink -f /opt/newme/current)"
run_crash_checkpoint after_gate_consumed \
  && pass "hard interruption after gate consumption" \
  || fail "gate-consumption interruption did not stop the installer"
check "$([ -f "$STATE_ROOT/credential-remediation-gate.consumed" ] && echo yes || echo no)" yes \
  "consumed gate survives the interruption"
run_candidate_credential_recover >"$WORK/after-gate-recover.out" 2>"$WORK/after-gate-recover.err" \
  && pass "candidate coordinator recovers consumed-only interruption" \
  || fail "consumed-only recovery: $(tail -c 300 "$WORK/after-gate-recover.err")"
check "$([ -e "$STATE_ROOT/credential-remediation-gate.consumed" ] && echo yes || echo no)" no \
  "consumed-only recovery clears the one-use gate"

run_crash_checkpoint after_systemd_pending \
  && pass "hard interruption after compatibility fence" \
  || fail "compatibility-fence interruption did not stop the installer"
check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo yes || echo no)" yes \
  "compatibility fence survives the interruption"
run_candidate_credential_recover >"$WORK/after-systemd-recover.out" 2>"$WORK/after-systemd-recover.err" \
  && pass "candidate coordinator recovers compatibility-fence interruption" \
  || fail "compatibility-fence recovery: $(tail -c 300 "$WORK/after-systemd-recover.err")"
for residue in credential-assets.pending systemd-assets.pending credential-remediation-gate.consumed; do
  check "$([ -e "$STATE_ROOT/$residue" ] && echo yes || echo no)" no "hard-interruption recovery clears $residue"
done

run_mode credential-install && pass "credential install" || fail "credential install: $(tail -c 300 "$WORK/credential-install.err")"
check "$([ -f "$STATE_ROOT/credential-assets.pending" ] && echo yes || echo no)" yes "pending record published"
check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo yes || echo no)" yes "legacy-compatible fence published before live subset mutation"
check "$([ -f "$STATE_ROOT/credential-remediation-gate.consumed" ] && echo yes || echo no)" yes "gate record consumed durably"
ORIGINAL_GATE_RECORD="$(cat "$WORK/last-gate-record")"
check "$([ -e "$ORIGINAL_GATE_RECORD" ] && echo yes || echo no)" no "original gate path cannot be replayed"
grep -Eq '^version=1$' "$STATE_ROOT/credential-assets.pending" &&
  grep -Eq '^run=[1-9][0-9]*$' "$STATE_ROOT/credential-assets.pending" &&
  grep -Eq '^gate_sha256=[0-9a-f]{64}$' "$STATE_ROOT/credential-assets.pending" \
  && pass "pending binds run and consumed gate digest" || fail "pending does not bind the consumed gate"
check "$(digest /etc/systemd/system/newme-platform.service)" "$UNIT_BEFORE" "application unit unchanged"
check "$(readlink -f /opt/newme/current)" "$CURRENT_BEFORE" "release pointer unchanged"
(
  PATH="$STUBS:$PATH" /usr/local/sbin/newme-deploy credential-recover
) >"$WORK/canonical-credential-recover.out" 2>"$WORK/canonical-credential-recover.err" \
  && pass "canonical wrapper credential asset recovery" \
  || fail "canonical wrapper credential asset recovery: $(tail -c 300 "$WORK/canonical-credential-recover.err")"
check "$([ -e "$STATE_ROOT/credential-assets.pending" ] && echo yes || echo no)" no "recovery clears pending"
check "$([ -e "$STATE_ROOT/systemd-assets.pending" ] && echo yes || echo no)" no "recovery clears compatibility fence"
check "$([ -e "$STATE_ROOT/credential-remediation-gate.consumed" ] && echo yes || echo no)" no "recovery clears consumed gate"
if run_mode_with_record credential-install "$ORIGINAL_GATE_RECORD"; then
  fail "the consumed gate record replayed after recovery"
else
  pass "the consumed gate record cannot replay after recovery"
fi
grep -q 'pre-remediation /usr/local/libexec/newme/newme-credential-transition.mjs' /usr/local/libexec/newme/newme-credential-transition.mjs \
  && pass "recovery restored previous helper" || fail "recovery did not restore previous helper"

run_mode credential-install && pass "credential reinstall" || fail "credential reinstall"
BACKUP="$(sed -n 's/^backup=//p' "$STATE_ROOT/credential-assets.pending")"
run_mode credential-finalize && pass "credential finalize" || fail "credential finalize: $(tail -c 300 "$WORK/credential-finalize.err")"
check "$([ -e "$STATE_ROOT/credential-assets.pending" ] && echo yes || echo no)" no "finalize clears pending"
HASH_BEFORE="$(for dest in "${CREDENTIAL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')"

cat >"$STATE_ROOT/credential-remediation.protected.json" <<EOF
{"version":1,"candidate_sha":"$TREE_SHA","activated_at":"2026-08-15T00:00:00.000Z"}
EOF
chmod 0600 "$STATE_ROOT/credential-remediation.protected.json"
(
  exec 9>/run/lock/newme-production-release.lock
  flock -n 9
  PATH="$STUBS:$PATH" /usr/local/libexec/newme/newme-credential-transition.mjs refresh-protection "$TREE_SHA"
) >/dev/null
python3 - "$STATE_ROOT/credential-remediation.protected.json" "$TREE_SHA" <<'PY' \
  && pass "protection marker binds exact candidate and asset hashes" \
  || fail "protection marker is not hash-bound"
import json
import re
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
raise SystemExit(0 if value.get("version") == 2 and value.get("candidate_sha") == sys.argv[2]
                 and len(value.get("assets", {})) == 13
                 and all(re.fullmatch(r"[0-9a-f]{64}", item) for item in value["assets"].values()) else 1)
PY
(
  exec 9>/run/lock/newme-production-release.lock
  flock -n 9
  PATH="$STUBS:$PATH" bash "$TREE/scripts/rollback-systemd-assets.sh" "$BACKUP"
) >"$WORK/protected-rollback.out" 2>&1
check "$?" 0 "ordinary rollback completes with protection"
HASH_AFTER="$(for dest in "${CREDENTIAL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')"
check "$HASH_AFTER" "$HASH_BEFORE" "ordinary rollback preserves remediated assets"
check "$(digest /etc/systemd/system/newme-platform.service)" "$UNIT_BEFORE" "ordinary rollback preserves fixed unit"

PROTECTED_BEFORE="$(digest "$STATE_ROOT/credential-remediation.protected.json")"
WRAPPER_BEFORE="$(digest /usr/local/sbin/newme-deploy)"
SNAPSHOT_RECORD="$STATE_ROOT/asset-snapshot.next-candidate"
: >"$SNAPSHOT_RECORD"
chmod 0600 "$SNAPSHOT_RECORD"
PATH="$STUBS:$PATH" NEWME_ASSET_SOURCE_ROOT="/opt/newme/releases/$TREE_SHA" \
  NEWME_ASSET_SNAPSHOT_RECORD="$SNAPSHOT_RECORD" \
  bash "$TREE/scripts/install-systemd-assets.sh" snapshot >/dev/null
NEXT_BACKUP="$(cat "$SNAPSHOT_RECORD")"
rm -f -- "$SNAPSHOT_RECORD"
NEXT_SHA="$(printf 'b%.0s' $(seq 1 40))"
PROTECTED_BACKUP_MARKER="$NEXT_BACKUP/rootfs/var/lib/newme/deploy-state/credential-remediation.protected.json"
PROTECTED_BACKUP_SHA256="$(digest "$PROTECTED_BACKUP_MARKER")"
cat >"$STATE_ROOT/systemd-assets.pending" <<EOF
version=2
sha=$NEXT_SHA
backup=$NEXT_BACKUP
previous=/opt/newme/releases/$TREE_SHA
previous_rollback=
candidate_preexisting=0
protected_before_candidate_sha=$TREE_SHA
protected_before_marker_sha256=$PROTECTED_BACKUP_SHA256
EOF
chmod 0600 "$STATE_ROOT/systemd-assets.pending"
mutate_next_candidate() {
  local dest
  for dest in "${PROTECTED_ASSET_DESTS[@]}"; do
    case "$dest" in
      *.mjs) printf '\n// simulated next-candidate byte\n' >>"$dest" ;;
      *) printf '\n# simulated next-candidate byte\n' >>"$dest" ;;
    esac
  done
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    PATH="$STUBS:$PATH" /usr/local/libexec/newme/newme-credential-transition.mjs refresh-protection "$NEXT_SHA" >/dev/null
  )
}
for checkpoint in $(seq 1 14); do
  mutate_next_candidate || { fail "could not materialize simulated next candidate for checkpoint $checkpoint"; break; }
  CANDIDATE_MARKER_SHA="$(digest "$STATE_ROOT/credential-remediation.protected.json")"
  [ "$CANDIDATE_MARKER_SHA" != "$PROTECTED_BEFORE" ] || fail "checkpoint $checkpoint did not bind the simulated candidate marker"
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    NEWME_DRILL_CONFIRM=throwaway-container NEWME_ASSET_ROLLBACK_DRILL_INTERRUPT_AFTER="$checkpoint" \
      NEWME_VERSIONED_ASSET_RECOVERY=1 PATH="$STUBS:$PATH" \
      bash "$TREE/scripts/rollback-systemd-assets.sh" "$NEXT_BACKUP"
  ) >"$WORK/next-candidate-interrupt-$checkpoint.out" 2>"$WORK/next-candidate-interrupt-$checkpoint.err"
  [ "$?" -ne 0 ] && pass "rollback interruption checkpoint $checkpoint" || fail "checkpoint $checkpoint did not interrupt"
  if [ "$checkpoint" -lt 14 ]; then
    check "$(digest "$STATE_ROOT/credential-remediation.protected.json")" "$CANDIDATE_MARKER_SHA" \
      "checkpoint $checkpoint keeps the prior live marker until every asset is restored"
  fi
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    NEWME_VERSIONED_ASSET_RECOVERY=1 PATH="$STUBS:$PATH" \
      bash "$TREE/scripts/rollback-systemd-assets.sh" "$NEXT_BACKUP"
  ) >"$WORK/next-candidate-reentry-$checkpoint.out" 2>"$WORK/next-candidate-reentry-$checkpoint.err" \
    || fail "checkpoint $checkpoint reentry failed: $(tail -c 300 "$WORK/next-candidate-reentry-$checkpoint.err")"
  check "$(for dest in "${CREDENTIAL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')" \
    "$HASH_BEFORE" "checkpoint $checkpoint reentry restores prior protected assets"
  check "$(digest "$STATE_ROOT/credential-remediation.protected.json")" "$PROTECTED_BEFORE" \
    "checkpoint $checkpoint reentry restores the prior marker"
done

protected_live_digest() {
  {
    for dest in "${PROTECTED_ASSET_DESTS[@]}"; do digest "$dest"; done
    digest "$STATE_ROOT/credential-remediation.protected.json"
  } | sha256sum | awk '{print $1}'
}
run_tampered_snapshot_case() {
  local name="$1" tamper="$2" candidate_override="${3:-$TREE_SHA}"
  local tampered="/var/backups/newme-systemd-assets/tamper-$name" before="" rc=0 marker_digest=""
  rm -rf -- "$tampered"
  cp -a -- "$NEXT_BACKUP" "$tampered"
  marker_digest="$(digest "$tampered/rootfs/var/lib/newme/deploy-state/credential-remediation.protected.json")"
  cat >"$STATE_ROOT/systemd-assets.pending" <<EOF
version=2
sha=$NEXT_SHA
backup=$tampered
previous=/opt/newme/releases/$TREE_SHA
previous_rollback=
candidate_preexisting=0
protected_before_candidate_sha=$candidate_override
protected_before_marker_sha256=$marker_digest
EOF
  chmod 0600 "$STATE_ROOT/systemd-assets.pending"
  case "$tamper" in
    marker_mode) chmod 0644 "$tampered/rootfs/var/lib/newme/deploy-state/credential-remediation.protected.json" ;;
    managed_missing) sed -i '\|^/usr/local/sbin/newme-deploy$|d' "$tampered/managed.list" ;;
    managed_duplicate) printf '%s\n' /usr/local/sbin/newme-deploy >>"$tampered/managed.list" ;;
    present_missing) sed -i '\|^/usr/local/sbin/newme-deploy$|d' "$tampered/present.list" ;;
    present_duplicate) printf '%s\n' /usr/local/sbin/newme-deploy >>"$tampered/present.list" ;;
    candidate_mismatch) ;;
    *) return 1 ;;
  esac
  before="$(protected_live_digest)"
  (
    exec 9>/run/lock/newme-production-release.lock
    flock -n 9
    NEWME_VERSIONED_ASSET_RECOVERY=1 PATH="$STUBS:$PATH" \
      bash "$TREE/scripts/rollback-systemd-assets.sh" "$tampered"
  ) >"$WORK/tamper-$name.out" 2>"$WORK/tamper-$name.err"
  rc=$?
  [ "$rc" -ne 0 ] && [ "$(protected_live_digest)" = "$before" ]
}

run_tampered_snapshot_case marker-mode marker_mode && pass "marker mode tamper refused before live mutation" || fail "marker mode tamper was not fail-before-write"
run_tampered_snapshot_case managed-missing managed_missing && pass "managed-list omission refused before live mutation" || fail "managed-list omission was not fail-before-write"
run_tampered_snapshot_case managed-duplicate managed_duplicate && pass "managed-list duplicate refused before live mutation" || fail "managed-list duplicate was not fail-before-write"
run_tampered_snapshot_case present-missing present_missing && pass "present-list omission refused before live mutation" || fail "present-list omission was not fail-before-write"
run_tampered_snapshot_case present-duplicate present_duplicate && pass "present-list duplicate refused before live mutation" || fail "present-list duplicate was not fail-before-write"
run_tampered_snapshot_case candidate-mismatch candidate_mismatch "$NEXT_SHA" && pass "prior marker identity mismatch refused before live mutation" || fail "prior marker identity mismatch was not fail-before-write"
cat >"$STATE_ROOT/systemd-assets.pending" <<EOF
version=2
sha=$NEXT_SHA
backup=$NEXT_BACKUP
previous=/opt/newme/releases/$TREE_SHA
previous_rollback=
candidate_preexisting=0
protected_before_candidate_sha=$TREE_SHA
protected_before_marker_sha256=$PROTECTED_BACKUP_SHA256
EOF
chmod 0600 "$STATE_ROOT/systemd-assets.pending"
(
  exec 9>/run/lock/newme-production-release.lock
  flock -n 9
  NEWME_VERSIONED_ASSET_RECOVERY=1 PATH="$STUBS:$PATH" \
    bash "$TREE/scripts/rollback-systemd-assets.sh" "$NEXT_BACKUP"
) >"$WORK/next-candidate-recovery.out" 2>"$WORK/next-candidate-recovery.err" \
  && pass "post-cutover next-candidate rollback reentry is idempotent" \
  || fail "post-cutover next-candidate rollback reentry: $(tail -c 300 "$WORK/next-candidate-recovery.err")"
check "$(digest /usr/local/sbin/newme-deploy)" "$WRAPPER_BEFORE" "failed next candidate restores prior protected wrapper"
check "$(digest "$STATE_ROOT/credential-remediation.protected.json")" "$PROTECTED_BEFORE" "failed next candidate restores prior hash-bound marker"
rm -f -- "$STATE_ROOT/systemd-assets.pending"
sync -f "$STATE_ROOT"

printf 'credential asset drill: checks=%s failures=%s\n' "$CHECKS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
