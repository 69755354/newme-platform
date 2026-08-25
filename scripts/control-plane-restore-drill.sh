#!/usr/bin/env bash
# ============================================================================
# Round-4 review C1–C3 · the control-plane bootstrap, exercised for real
# ============================================================================
# infra/release/control-plane-bootstrap.md is a guarded coordinator procedure
# against production. Three of its properties were claims about shell scripts that nobody
# had ever run in that order:
#
#   C1  the snapshot taken in step 1 is a restore point for the control plane
#   C2  a successful hand-run install leaves no unresolved transaction behind
#   C3  an interrupted restore leaves every path either old or new
#
# This drill builds a throwaway host root inside a container — a git repository
# standing in for the release, /opt/newme, /var/lib/newme/deploy-state, the managed
# observability assets, a fake pre-existing ("f37") control plane — and then runs
# the real scripts against it: snapshot mode, the verifier, install mode, the
# rollback helper, finalize mode. It asserts what actually happens to the files.
#
# systemd, Nginx, sudo and curl do not exist in a container, so stubs for
# systemctl / nginx / visudo / curl / logrotate are put first on PATH; every
# invocation is appended to a log the assertions read. Nothing else is faked: the
# scripts under test are the repository's own bytes, and every file assertion is a
# sha256 comparison of real files.
#
# It refuses to run anywhere that could be a real host. It never reads production
# data and never prints file contents; the one generated secret in the fixture (a
# readiness token the installer creates from /dev/urandom) is never read back.
#
#   docker run --rm -v "$PWD:/repo:ro" -e NEWME_DRILL_CONFIRM=throwaway-container \
#     <image> bash /repo/scripts/control-plane-restore-drill.sh
# ============================================================================
set -uo pipefail

[ "${NEWME_DRILL_CONFIRM:-}" = throwaway-container ] || {
  echo "refusing: this drill rewrites /etc, /usr/local and /opt and only runs with NEWME_DRILL_CONFIRM=throwaway-container" >&2
  exit 64
}
[ -f /.dockerenv ] || [ -f /run/.containerenv ] || {
  echo "refusing: no container marker, so this may be a real host" >&2
  exit 64
}
[ "$(id -u)" -eq 0 ] || { echo "refusing: the drill needs root inside its container" >&2; exit 77; }
for forbidden in /opt/newme/current /etc/newme/newme-runtime.env /var/lib/newme/deploy-state/deploy.lock; do
  [ ! -e "$forbidden" ] || {
    echo "refusing: $forbidden already exists, so this host is not throwaway" >&2
    exit 64
  }
done
REPO="${NEWME_DRILL_REPO:-/repo}"
[ -f "$REPO/scripts/install-systemd-assets.sh" ] || { echo "refusing: $REPO is not the repository" >&2; exit 64; }

WORK=/var/tmp/newme-drill
TREE="$WORK/release"          # the "release" git worktree the bootstrap runs from
LEGACY="$WORK/legacy"         # the f37c203 installer, for the C1 negative
STUBS="$WORK/stubs"
STUB_LOG="$WORK/stub.log"
OUT="$WORK/out"
FAILURES=0
CHECKS=0

pass() { CHECKS=$((CHECKS + 1)); printf '    ok    %s\n' "$1"; }
fail() { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf '    FAIL  %s\n' "$1"; }
check() { if [ "$1" = "$2" ]; then pass "$3 ($1)"; else fail "$3: expected [$2], got [$1]"; fi; }
phase() { printf '\n== %s ==\n' "$1"; }
step() { printf '  -- %s\n' "$1"; }

diagnose() {
  # $1 = label, $2 = file with the failing run's stderr
  if [ -s "$2" ]; then
    printf '    stderr(%s):\n' "$1"
    tail -n 6 "$2" | sed 's/^/      /'
  else
    printf '    stderr(%s): empty\n' "$1"
  fi
}
trace() {
  # Re-run a failing invocation under bash -x, for the drill's own development.
  [ "${NEWME_DRILL_TRACE:-}" = 1 ] || return 0
  printf '    trace(%s):\n' "$1"
  shift
  ( "$@" ) >"$OUT.trace" 2>&1
  tail -n 100 "$OUT.trace" | sed 's/^/      /'
}

digest() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
# Present, and a regular file, and exactly these bytes.
same() { [ -f "$2" ] && [ ! -L "$2" ] && [ "$(digest "$1")" = "$(digest "$2")" ]; }

write_fixture_release_env() {
  # Structurally valid, deliberately non-production placeholders. The installer
  # validates credential types even in no-network mode; this drill must exercise
  # the asset transaction rather than stop at a missing config file. Nothing here
  # is a usable credential and these values are never printed.
  local release_dir="$1"
  cat >"$release_dir/.env.local" <<'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://vfopmpxlhwzpxqegayew.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_newme_control_plane_drill_only
SUPABASE_SERVICE_ROLE_KEY=sb_secret_newme_control_plane_drill_only
SENTRY_DSN=https://00000000000000000000000000000000@fixture.ingest.sentry.io/1
EOF
  chmod 0600 "$release_dir/.env.local"
}

# ---------------------------------------------------------------------------
# 0 · the throwaway host
# ---------------------------------------------------------------------------
CONTROL_DESTS=(
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
)
CONTROL_SOURCES=(
  scripts/install-systemd-assets.sh
  scripts/rollback-systemd-assets.sh
  infra/systemd/newme-service-control.sh
  infra/systemd/newme-production-rollback.sh
  scripts/validate-production-config.py
  scripts/credential-transition.mjs
  scripts/credential-live-attestation.mjs
  infra/release/credential-live-attestation-policy-v1.json
  infra/systemd/newme-deploy.sh
  infra/sudoers/newme-platform
)
CONTROL_COUNT="${#CONTROL_DESTS[@]}"
CONTROL_WITH_NOPASSWD="$((CONTROL_COUNT + 1))"
NOPASSWD=/etc/sudoers.d/ubuntu-nopasswd
UNIT_DEST=/etc/systemd/system/newme-platform.service
CRON_DEST=/etc/cron.d/newme-observability
NGINX_AVAILABLE=/etc/nginx/sites-available/newme-platform
NGINX_ENABLED=/etc/nginx/sites-enabled/newme-platform
STATE_ROOT=/var/lib/newme/deploy-state
ROLLBACK_SHA="$(printf 'a%.0s' $(seq 1 40))"   # the release /opt/newme/current.rollback names

build_stubs() {
  mkdir -p "$STUBS"
  for tool in systemctl systemd-analyze nginx visudo curl logrotate logger; do
    cat >"$STUBS/$tool" <<EOF
#!/bin/sh
printf '%s %s\n' "$tool" "\$*" >> "$STUB_LOG"
if [ "$tool" = logger ]; then
  cat >> "$STUB_LOG"
  exit 0
fi
case "$tool:\$*" in
  "systemctl:show newme-platform.service -p FragmentPath --value") echo /etc/systemd/system/newme-platform.service ;;
  "systemctl:show newme-platform.service -p DropInPaths --value") : ;;
esac
case "$tool:\$1" in
  systemctl:is-active) echo active ;;
  nginx:-V) echo 'configure arguments: --with-http_realip_module' >&2 ;;
esac
exit 0
EOF
    chmod 0755 "$STUBS/$tool"
  done
  # The installed service controller deliberately uses absolute /usr/bin paths.
  # Replace those two commands only inside this already-guarded disposable
  # container so the recovery path is exercised without a systemd PID 1.
  install -m 0755 "$STUBS/systemctl" /usr/bin/systemctl
  install -m 0755 "$STUBS/logger" /usr/bin/logger
  cat >"$STUBS/systemd-tmpfiles" <<'EOF'
#!/bin/sh
for directory in /run/newme-credential-inbox /run/newme-credential-live-input; do
  mkdir -p "$directory"
  chown root:root "$directory"
  chmod 0700 "$directory"
done
EOF
  chmod 0755 "$STUBS/systemd-tmpfiles"
  : >"$STUB_LOG"
}

# The release under test, as a git repository, so install/finalize can derive a SHA
# from it the way they do on the host.
build_tree() {
  rm -rf "$TREE"
  mkdir -p "$TREE"
  (cd "$REPO" && tar -cf - scripts infra newme-platform.service 2>/dev/null || tar -cf - scripts infra) | (cd "$TREE" && tar -xf -)
  [ -f "$TREE/newme-platform.service" ] || cp -a "$TREE/infra/systemd/newme-platform.service" "$TREE/newme-platform.service"
  # The installer verifies the already-provisioned provider identity. This
  # network-none control-plane drill is not a provider drill, so replace only
  # that fixture-tree executable with a closed validate-config stub.
  cat >"$TREE/infra/observability/newme-alert-provider-v1.mjs" <<'EOF'
#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = validate-config ] || exit 64
exit 0
EOF
  chmod 0755 "$TREE/infra/observability/newme-alert-provider-v1.mjs"
  git -C "$TREE" init -q
  git -C "$TREE" add -A
  git -C "$TREE" -c user.email=drill@example.invalid -c user.name=drill commit -qm release
  TREE_SHA="$(git -C "$TREE" rev-parse HEAD)"
}

# The f37c203 installer: same file, before CONTROL_PLANE[] existed.
build_legacy() {
  rm -rf "$LEGACY"
  mkdir -p "$LEGACY/scripts" "$LEGACY/infra"
  if [ -n "${NEWME_DRILL_F37:-}" ] && [ -f "${NEWME_DRILL_F37:-}" ]; then
    sed 's/\r$//' "$NEWME_DRILL_F37" >"$LEGACY/scripts/install-systemd-assets.sh"
  else
    git -c safe.directory="$REPO" -C "$REPO" show f37c203:scripts/install-systemd-assets.sh >"$LEGACY/scripts/install-systemd-assets.sh" 2>/dev/null || return 1
  fi
  [ -s "$LEGACY/scripts/install-systemd-assets.sh" ] || return 1
  cp -a "$TREE/infra" "$LEGACY/"
  cp -a "$TREE/newme-platform.service" "$LEGACY/newme-platform.service"
  cp -a "$TREE/scripts/rollback-systemd-assets.sh" "$LEGACY/scripts/"
}

# The same release, with the installer as it was before this round's fixes, so a
# defect can be shown happening and then not happening.
build_before_tree() {
  BEFORE_TREE="$WORK/before"
  rm -rf "$BEFORE_TREE"
  cp -a "$TREE" "$BEFORE_TREE"
  if [ -n "${NEWME_DRILL_INSTALL_BEFORE:-}" ] && [ -f "${NEWME_DRILL_INSTALL_BEFORE:-}" ]; then
    sed 's/\r$//' "$NEWME_DRILL_INSTALL_BEFORE" >"$BEFORE_TREE/scripts/install-systemd-assets.sh"
  else
    git -c safe.directory="$REPO" -C "$REPO" show 03f53ab08c61dcfff830e3e6d219f7c374c914f9:scripts/install-systemd-assets.sh >"$BEFORE_TREE/scripts/install-systemd-assets.sh" 2>/dev/null || return 1
  fi
  [ -s "$BEFORE_TREE/scripts/install-systemd-assets.sh" ] || return 1
}

# Every managed path in a known state, with the control plane holding recognisable
# "previous release" bytes rather than the candidate's.
reset_host() {
  local fixture_bot_token=""
  rm -rf /opt/newme /etc/newme /etc/hermes /opt/hermes-scripts /etc/systemd/system/newme-platform.service.d \
    /etc/nginx /etc/cron.d/newme-observability /etc/logrotate.d/newme-forensic /usr/local/libexec/newme \
    /var/lib/newme /var/backups/newme-systemd-assets
  rm -f "${CONTROL_DESTS[@]}" "$NOPASSWD" "$UNIT_DEST"
  mkdir -p /usr/local/libexec/newme /usr/local/sbin /etc/sudoers.d /etc/systemd/system \
    /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/cron.d /etc/logrotate.d /run/lock \
    "$STATE_ROOT" /var/backups/newme-systemd-assets /etc/systemd/system/newme-platform.service.d \
    /etc/newme /etc/hermes/observability /opt/hermes-scripts/observability
  chown root:root "$STATE_ROOT"; chmod 0700 "$STATE_ROOT"
  chown root:root /var/backups/newme-systemd-assets; chmod 0700 /var/backups/newme-systemd-assets
  fixture_bot_token="123456:$(printf 'A%.0s' $(seq 1 20))"
  printf '{"provider_version":"newme-alert-provider-telegram/v1","bot_token":"%s","chat_id":"-12345","bot_user_id":"12345"}\n' \
    "$fixture_bot_token" >/etc/newme/postdeploy-alert-provider-v1.json
  chown root:root /etc/newme/postdeploy-alert-provider-v1.json
  chmod 0600 /etc/newme/postdeploy-alert-provider-v1.json

  # The previous release's control plane. Distinct bytes per path, and the modes the
  # installer sets, so a restore can be checked for exactly.
  local index=0
  for dest in "${CONTROL_DESTS[@]}"; do
    mkdir -p "$(dirname "$dest")"
    if [ "$dest" = /usr/local/sbin/newme-service-control ]; then
      # The recovery deliberately restores and then invokes the previous
      # controller. Preserve the f37 byte marker while making that invocation
      # observable to this drill.
      cat >"$dest" <<EOF
#!/usr/bin/env bash
# f37c203 $dest
printf 'f37-service-control %s\n' "\$*" >> "$STUB_LOG"
exit 0
EOF
    else
      printf '#!/usr/bin/env bash\n# f37c203 %s\nexit 0\n' "$dest" >"$dest"
    fi
    case "$dest" in
      /etc/sudoers.d/*) chmod 0440 "$dest" ;;
      /usr/local/share/newme/*) chmod 0644 "$dest" ;;
      *) chmod 0755 "$dest" ;;
    esac
    chown root:root "$dest"
    index=$((index + 1))
  done
  printf 'ubuntu ALL=(ALL) NOPASSWD:ALL\n' >"$NOPASSWD"; chmod 0440 "$NOPASSWD"; chown root:root "$NOPASSWD"

  # Versioned managed assets, present so the restore has something to put back that
  # is not the control plane.
  printf '[Unit]\n# f37c203 unit\n' >"$UNIT_DEST"; chmod 0644 "$UNIT_DEST"
  printf '# f37c203 cron\n' >"$CRON_DEST"; chmod 0644 "$CRON_DEST"
  printf '# f37c203 nginx\n' >"$NGINX_AVAILABLE"; chmod 0644 "$NGINX_AVAILABLE"
  ln -sfn ../sites-available/newme-platform "$NGINX_ENABLED"
  printf '# f37c203 forensic drop-in\n' >/etc/systemd/system/newme-platform.service.d/forensic.conf
  printf 'NEWME_READINESS_TOKEN=%s\nMETA_PIXEL_ID=4476894535908766\nMETA_CAPI_ACCESS_TOKEN=EAA%s\nMETA_GRAPH_API_VERSION=v25.0\n' \
    "$(printf 'f%.0s' $(seq 1 64))" "$(printf 'm%.0s' $(seq 1 40))" \
    >/etc/newme/newme-runtime.env
  chmod 0600 /etc/newme/newme-runtime.env

  # The release pointers snapshot and install both require.
  mkdir -p "/opt/newme/releases/$TREE_SHA" /opt/newme/releases
  cp -a "$TREE/infra" "/opt/newme/releases/$TREE_SHA/"
  cp -a "$TREE/newme-platform.service" "/opt/newme/releases/$TREE_SHA/newme-platform.service"
  write_fixture_release_env "/opt/newme/releases/$TREE_SHA"
  : >"/opt/newme/releases/$TREE_SHA/.newme-protect"
  ln -sfn "/opt/newme/releases/$TREE_SHA" /opt/newme/current
  # A host that has deployed at least once also has a rollback pointer. Phases that
  # need the other case remove it deliberately.
  mkdir -p "/opt/newme/releases/$ROLLBACK_SHA"
  : >"/opt/newme/releases/$ROLLBACK_SHA/.newme-protect"
  ln -sfn "/opt/newme/releases/$ROLLBACK_SHA" /opt/newme/current.rollback
  : >"$STUB_LOG"
}

snapshot_with() {
  # $1 = tree to run the installer from; prints the snapshot directory
  local tree="$1" record
  record="$(mktemp "$STATE_ROOT/asset-snapshot.XXXXXX")"
  chmod 0600 "$record"; chown root:root "$record"
  PATH="$STUBS:$PATH" NEWME_ASSET_SNAPSHOT_RECORD="$record" \
    NEWME_ASSET_SOURCE_ROOT="$(readlink -f /opt/newme/current)" \
    bash "$tree/scripts/install-systemd-assets.sh" snapshot >"$OUT.snapshot" 2>"$OUT.snapshot.err"
  local rc=$?
  SNAPSHOT_RC="$rc"
  SNAPSHOT_DIR="$(sed -n 's/^snapshot=//p' "$OUT.snapshot")"
  if [ "$rc" -ne 0 ]; then
    diagnose "snapshot rc=$rc" "$OUT.snapshot.err"
    trace snapshot env PATH="$STUBS:$PATH" NEWME_ASSET_SNAPSHOT_RECORD="$record" \
      NEWME_ASSET_SOURCE_ROOT="$(readlink -f /opt/newme/current)" \
      bash -x "$tree/scripts/install-systemd-assets.sh" snapshot
  fi
}

# What step 2 does to the control plane, without the rest of install mode: every
# file replaced by the candidate's, and the nopasswd fragment removed.
simulate_control_plane_install() {
  local index=0 dest source
  while [ "$index" -lt "${#CONTROL_DESTS[@]}" ]; do
    dest="${CONTROL_DESTS[$index]}"
    source="$TREE/${CONTROL_SOURCES[$index]}"
    install -o root -g root -m "$(case "$dest" in /etc/sudoers.d/*) echo 0440 ;; /usr/local/share/newme/*) echo 0644 ;; *) echo 0755 ;; esac)" "$source" "$dest"
    index=$((index + 1))
  done
  rm -f "$NOPASSWD"
  printf '[Unit]\n# candidate unit\n' >"$UNIT_DEST"
}

run_rollback() {
  # $1 = rollback script, $2 = backup directory, $3 = output file
  PATH="$STUBS:$PATH" bash "$1" "$2" >"$3" 2>&1
  ROLLBACK_RC=$?
  [ "$ROLLBACK_RC" -eq 0 ] || diagnose "rollback rc=$ROLLBACK_RC" "$3"
  return "$ROLLBACK_RC"
}

count_control_plane_matching() {
  # $1 = tree whose bytes to compare against; counts exact candidate matches
  local tree="$1" index=0 matched=0
  while [ "$index" -lt "${#CONTROL_DESTS[@]}" ]; do
    same "$tree/${CONTROL_SOURCES[$index]}" "${CONTROL_DESTS[$index]}" && matched=$((matched + 1))
    index=$((index + 1))
  done
  echo "$matched"
}

count_control_plane_f37() {
  local index=0 matched=0 dest
  while [ "$index" -lt "${#CONTROL_DESTS[@]}" ]; do
    dest="${CONTROL_DESTS[$index]}"
    if [ -f "$dest" ] && grep -q "f37c203 $dest" "$dest" 2>/dev/null; then matched=$((matched + 1)); fi
    index=$((index + 1))
  done
  echo "$matched"
}

leftover_temps() {
  find /etc /usr/local /opt -name '.newme-asset-rollback.*' -o -name '.newme-asset-restore.*' 2>/dev/null | wc -l | tr -d ' '
}

mkdir -p "$WORK"
build_stubs
build_tree
build_legacy || { echo "the f37c203 installer could not be obtained; mount it and pass NEWME_DRILL_F37=<path>" >&2; exit 65; }
echo "drill release sha: $TREE_SHA"
echo "legacy installer:  $(digest "$LEGACY/scripts/install-systemd-assets.sh")"
echo "candidate installer: $(digest "$TREE/scripts/install-systemd-assets.sh")"
echo "candidate rollback:  $(digest "$TREE/scripts/rollback-systemd-assets.sh")"

# ---------------------------------------------------------------------------
# C1 negative · the snapshot the procedure used to take
# ---------------------------------------------------------------------------
phase "C1 negative: snapshot taken with the installed (f37c203) helper"
reset_host
step "run f37c203 snapshot mode against the live host"
snapshot_with "$LEGACY"
check "$SNAPSHOT_RC" 0 "the f37 helper reports success, so the operator sees a restore point"
[ -n "$SNAPSHOT_DIR" ] && pass "it printed snapshot=$SNAPSHOT_DIR" || fail "it printed no snapshot path"
LEGACY_SNAPSHOT="$SNAPSHOT_DIR"
missing=0
for dest in "${CONTROL_DESTS[@]}" "$NOPASSWD"; do
  grep -Fqx "$dest" "$LEGACY_SNAPSHOT/managed.list" || missing=$((missing + 1))
done
check "$missing" "$CONTROL_WITH_NOPASSWD" "control-plane paths absent from its managed.list"
check "$(grep -Fqx "$UNIT_DEST" "$LEGACY_SNAPSHOT/managed.list" && echo yes || echo no)" yes "the versioned unit file IS in its managed.list"

step "the verifier must refuse it"
PATH="$STUBS:$PATH" node "$TREE/scripts/verify-asset-snapshot.mjs" --snapshot "$LEGACY_SNAPSHOT" \
  --installer "$TREE/scripts/install-systemd-assets.sh" >"$OUT.verify" 2>"$OUT.verify.err"
check "$?" 65 "verify-asset-snapshot.mjs exit code"
legacy_refusal_complete=1
grep -Eq "does not manage [1-9][0-9]* of this release's paths" "$OUT.verify.err" || legacy_refusal_complete=0
for dest in "${CONTROL_DESTS[@]}" "$NOPASSWD"; do
  grep -Fq "$dest" "$OUT.verify.err" || legacy_refusal_complete=0
done
[ "$legacy_refusal_complete" -eq 1 ] \
  && pass "it names every control-plane path a restore would not put back" \
  || fail "its refusal does not name every missing control-plane path"

step "install the candidate control plane, then restore that snapshot"
simulate_control_plane_install
check "$(count_control_plane_matching "$TREE")" "$CONTROL_COUNT" "the candidate control plane is live before the restore"
run_rollback "$TREE/scripts/rollback-systemd-assets.sh" "$LEGACY_SNAPSHOT" "$OUT.rollback"
check "$ROLLBACK_RC" 0 "the restore reports success"
grep -q "restored systemd and observability assets from" "$OUT.rollback" \
  && pass "and prints its success line" || fail "no success line: $(tail -c 200 "$OUT.rollback")"
check "$(count_control_plane_f37)" 0 "control-plane paths actually restored to f37c203 bytes"
check "$(count_control_plane_matching "$TREE")" "$CONTROL_COUNT" "control-plane paths still the candidate's after a successful restore"
check "$([ -e "$NOPASSWD" ] && echo present || echo absent)" absent "/etc/sudoers.d/ubuntu-nopasswd after the restore"
check "$(grep -c 'f37c203 unit' "$UNIT_DEST")" 1 "the versioned unit file WAS restored, so the mechanism ran"

# ---------------------------------------------------------------------------
# C1 positive · the snapshot the procedure takes now
# ---------------------------------------------------------------------------
phase "C1 positive: snapshot taken with the release's own helper, then verified"
reset_host
step "run the candidate's snapshot mode"
snapshot_with "$TREE"
check "$SNAPSHOT_RC" 0 "snapshot mode exit code"
CANDIDATE_SNAPSHOT="$SNAPSHOT_DIR"
present=0
for dest in "${CONTROL_DESTS[@]}" "$NOPASSWD"; do
  grep -Fqx "$dest" "$CANDIDATE_SNAPSHOT/managed.list" && present=$((present + 1))
done
check "$present" "$CONTROL_WITH_NOPASSWD" "control-plane paths in managed.list"

step "the verifier must accept it, having compared it against the live host"
PATH="$STUBS:$PATH" node "$TREE/scripts/verify-asset-snapshot.mjs" --snapshot "$CANDIDATE_SNAPSHOT" \
  --installer "$TREE/scripts/install-systemd-assets.sh" >"$OUT.verify2" 2>"$OUT.verify2.err"
check "$?" 0 "verify-asset-snapshot.mjs exit code"
grep -q "control_plane_managed=$CONTROL_WITH_NOPASSWD control_plane_captured=$CONTROL_WITH_NOPASSWD" "$OUT.verify2" \
  && pass "it reports $CONTROL_WITH_NOPASSWD of $CONTROL_WITH_NOPASSWD captured" \
  || fail "unexpected report: $(grep control_plane "$OUT.verify2" | tr '\n' ' ')"
grep -q "compared_against_live_host=true" "$OUT.verify2" && pass "and says so" || fail "it did not compare against the host"

step "tamper with one live byte: the snapshot must stop being a restore point"
printf '# drift\n' >>/usr/local/sbin/newme-deploy
PATH="$STUBS:$PATH" node "$TREE/scripts/verify-asset-snapshot.mjs" --snapshot "$CANDIDATE_SNAPSHOT" \
  --installer "$TREE/scripts/install-systemd-assets.sh" >"$OUT.verify3" 2>"$OUT.verify3.err"
check "$?" 65 "the verifier refuses a snapshot that no longer matches the host"
grep -q "is not the byte sequence the snapshot holds" "$OUT.verify3.err" \
  && pass "and says which path drifted" || fail "unexpected refusal: $(head -c 200 "$OUT.verify3.err")"
reset_host
snapshot_with "$TREE"
CANDIDATE_SNAPSHOT="$SNAPSHOT_DIR"

step "install the candidate control plane, then restore"
simulate_control_plane_install
run_rollback "$TREE/scripts/rollback-systemd-assets.sh" "$CANDIDATE_SNAPSHOT" "$OUT.rollback2"
check "$ROLLBACK_RC" 0 "the restore exit code"
check "$(count_control_plane_f37)" "$CONTROL_COUNT" "control-plane paths restored to f37c203 bytes"
check "$([ -e "$NOPASSWD" ] && echo present || echo absent)" present "/etc/sudoers.d/ubuntu-nopasswd is back"
check "$(stat -c '%a' "$NOPASSWD")" 440 "and with its mode"
check "$(stat -c '%a' /etc/sudoers.d/newme-platform)" 440 "the sudoers fragment's mode survived the restore"
check "$(stat -c '%a' /usr/local/sbin/newme-deploy)" 755 "the wrapper's mode survived the restore"
check "$(readlink "$NGINX_ENABLED")" ../sites-available/newme-platform "the sites-enabled symlink is a symlink, restored as one"
check "$(leftover_temps)" 0 "temporary files left behind"

step "restore again (reentry): the same backup applied twice"
before_digests="$(for dest in "${CONTROL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')"
run_rollback "$TREE/scripts/rollback-systemd-assets.sh" "$CANDIDATE_SNAPSHOT" "$OUT.rollback3"
check "$ROLLBACK_RC" 0 "the second restore exit code"
after_digests="$(for dest in "${CONTROL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')"
check "$after_digests" "$before_digests" "the control plane after a repeated restore"
check "$(leftover_temps)" 0 "temporary files after the repeated restore"

# ---------------------------------------------------------------------------
# C1b · the host the bootstrap actually runs on
# ---------------------------------------------------------------------------
# Found by this drill: /opt/newme/current.rollback does not exist until something has
# rolled back, and `readlink -f` on a missing last component prints the path it was
# given. So PREVIOUS_ROLLBACK became the literal "/opt/newme/current.rollback",
# failed the immutable-release-path check, and every mode of the installer exited 65
# with nothing on stderr — on the one host state the procedure in
# infra/release/control-plane-bootstrap.md is written for.
phase "C1b: no rollback pointer yet"
if build_before_tree; then
  reset_host
  rm -f /opt/newme/current.rollback
  step "the code before this fix"
  snapshot_with "$BEFORE_TREE"
  if grep -q '^PREVIOUS_ROLLBACK=""$' "$BEFORE_TREE/scripts/install-systemd-assets.sh"; then
    check "$SNAPSHOT_RC" 0 "HEAD already contains the no-rollback-pointer fix"
    [ -n "$SNAPSHOT_DIR" ] && pass "the fixed HEAD fixture produced a snapshot" || fail "the fixed HEAD fixture produced no snapshot"
  else
    check "$SNAPSHOT_RC" 65 "the pre-fix installer's exit code with no rollback pointer"
    check "$([ -s "$OUT.snapshot.err" ] && echo nonempty || echo empty)" empty "and what it said about why"
    check "$([ -n "$SNAPSHOT_DIR" ] && echo yes || echo no)" no "and whether it produced a snapshot"
  fi

  step "the code with this fix"
  snapshot_with "$TREE"
  check "$SNAPSHOT_RC" 0 "the fixed installer's exit code with no rollback pointer"
  present=0
  for dest in "${CONTROL_DESTS[@]}" "$NOPASSWD"; do
    grep -Fqx "$dest" "$SNAPSHOT_DIR/managed.list" && present=$((present + 1))
  done
  check "$present" "$CONTROL_WITH_NOPASSWD" "control-plane paths captured on that host"

  step "and a dangling rollback pointer is still refused, with a reason"
  ln -sfn /opt/newme/releases/not-a-release /opt/newme/current.rollback
  snapshot_with "$TREE"
  check "$SNAPSHOT_RC" 65 "the exit code for a rollback pointer outside the release root"
  grep -q "rollback release pointer" "$OUT.snapshot.err" && pass "and it names the pointer"     || fail "it still says nothing: $(head -c 160 "$OUT.snapshot.err")"
else
  echo "    note  the pre-fix installer could not be obtained; C1b before-state skipped" >&2
fi

# ---------------------------------------------------------------------------
# C3 · an interrupted restore
# ---------------------------------------------------------------------------
phase "C3: a restore that fails partway through"
reset_host
snapshot_with "$TREE"
check "$SNAPSHOT_RC" 0 "a fresh verified snapshot for this phase"
CANDIDATE_SNAPSHOT="$SNAPSHOT_DIR"
# A backup whose copy of one control-plane path is gone — a truncated snapshot
# directory, which is what a power loss during step 1 leaves. Its manifest line goes
# with it, so the pre-flight sha256sum -c still passes and the failure happens where
# the real risk is: inside the restore loop, on a path late in managed.list.
BROKEN="$WORK/broken"
rm -rf "$BROKEN"; cp -a "$CANDIDATE_SNAPSHOT" "$BROKEN"
rm -f "$BROKEN/rootfs/etc/sudoers.d/newme-platform"
grep -v 'etc/sudoers.d/newme-platform' "$BROKEN/manifest.sha256" >"$BROKEN/manifest.sha256.new"
mv "$BROKEN/manifest.sha256.new" "$BROKEN/manifest.sha256"
grep -Fqx /etc/sudoers.d/newme-platform "$BROKEN/present.list" \
  && pass "the broken backup still claims to hold /etc/sudoers.d/newme-platform" \
  || fail "fixture error: the path is no longer recorded as present"

step "the code before this fix"
reset_host
simulate_control_plane_install
if [ -n "${NEWME_DRILL_ROLLBACK_BEFORE:-}" ] && [ -f "${NEWME_DRILL_ROLLBACK_BEFORE:-}" ]; then
  sed 's/\r$//' "$NEWME_DRILL_ROLLBACK_BEFORE" >"$WORK/rollback-before.sh"
else
  git -C "$REPO" show HEAD:scripts/rollback-systemd-assets.sh >"$WORK/rollback-before.sh" 2>/dev/null \
    || cp -a "$TREE/scripts/rollback-systemd-assets.sh" "$WORK/rollback-before.sh"
fi
if grep -q 'rm -f -- "\$dest"$' "$WORK/rollback-before.sh" && ! grep -q restore_managed_path "$WORK/rollback-before.sh"; then
  PATH="$STUBS:$PATH" bash "$WORK/rollback-before.sh" "$BROKEN" >"$OUT.old" 2>&1
  old_rc=$?
  check "$([ "$old_rc" -ne 0 ] && echo nonzero || echo zero)" nonzero "the old code fails (rc=$old_rc)"
  check "$([ -e /etc/sudoers.d/newme-platform ] && echo present || echo MISSING)" MISSING \
    "/etc/sudoers.d/newme-platform after the old code's interrupted restore"
else
  echo "    note  HEAD already contains the fix; the before-state could not be reconstructed" >&2
fi

step "the code with this fix"
reset_host
simulate_control_plane_install
sudoers_before="$(digest /etc/sudoers.d/newme-platform)"
PATH="$STUBS:$PATH" bash "$TREE/scripts/rollback-systemd-assets.sh" "$BROKEN" >"$OUT.new" 2>&1
new_rc=$?
check "$([ "$new_rc" -ne 0 ] && echo nonzero || echo zero)" nonzero "the new code fails too (rc=$new_rc), because the backup is broken"
check "$([ -f /etc/sudoers.d/newme-platform ] && echo present || echo MISSING)" present \
  "/etc/sudoers.d/newme-platform after the new code's interrupted restore"
check "$(digest /etc/sudoers.d/newme-platform)" "$sudoers_before" "and it is byte-identical to before the attempt"
check "$(stat -c '%a' /etc/sudoers.d/newme-platform)" 440 "with its mode intact"
check "$(leftover_temps)" 0 "temporary files left by the failed restore"

step "and the same broken backup, applied twice, still leaves the path intact"
PATH="$STUBS:$PATH" bash "$TREE/scripts/rollback-systemd-assets.sh" "$BROKEN" >"$OUT.new2" 2>&1
check "$([ -f /etc/sudoers.d/newme-platform ] && echo present || echo MISSING)" present "after a repeated failed restore"
check "$(leftover_temps)" 0 "temporary files after the repeated failure"

# ---------------------------------------------------------------------------
# C3b · SIGTERM during the copy, then deterministic reentry
# ---------------------------------------------------------------------------
phase "C3b: SIGTERM during atomic restore, then reentry"
reset_host
snapshot_with "$TREE"
check "$SNAPSHOT_RC" 0 "a fresh snapshot for the signal phase"
CANDIDATE_SNAPSHOT="$SNAPSHOT_DIR"
simulate_control_plane_install
candidate_wrapper_digest="$(digest /usr/local/sbin/newme-deploy)"

# Block the copy that is preparing the wrapper's temp file. At this point rename
# has not run, so the destination must still be the complete candidate byte
# sequence. `setsid` gives the rollback and its cp child a private process group;
# TERM reaches both, allowing the shell's TERM/EXIT cleanup to remove the temp.
SIG_STUBS="$WORK/sig-stubs"
SIG_MARKER="$WORK/sig-copy-started"
rm -rf "$SIG_STUBS"; mkdir -p "$SIG_STUBS"; rm -f "$SIG_MARKER"
cat >"$SIG_STUBS/cp" <<'EOF'
#!/bin/sh
if [ "${3:-}" = "${NEWME_DRILL_BLOCK_SOURCE:-}" ]; then
  : >"$NEWME_DRILL_INTERRUPT_MARKER"
  trap 'exit 143' HUP INT TERM
  while :; do /bin/sleep 1; done
fi
exec /bin/cp "$@"
EOF
chmod 0755 "$SIG_STUBS/cp"

step "interrupt the rollback while its wrapper copy is still a temp file"
setsid env \
  PATH="$SIG_STUBS:$STUBS:$PATH" \
  NEWME_DRILL_BLOCK_SOURCE="$CANDIDATE_SNAPSHOT/rootfs/usr/local/sbin/newme-deploy" \
  NEWME_DRILL_INTERRUPT_MARKER="$SIG_MARKER" \
  bash "$TREE/scripts/rollback-systemd-assets.sh" "$CANDIDATE_SNAPSHOT" >"$OUT.sigterm" 2>&1 &
signal_pid=$!
marker_seen=0
for _ in $(seq 1 100); do
  if [ -f "$SIG_MARKER" ]; then marker_seen=1; break; fi
  /bin/sleep 0.05
done
if [ "$marker_seen" -eq 1 ]; then
  pass "the rollback reached the controlled interruption point"
  kill -TERM -- "-$signal_pid" 2>/dev/null || true
else
  fail "the rollback never reached the controlled interruption point"
  kill -KILL -- "-$signal_pid" 2>/dev/null || true
fi
wait "$signal_pid"
signal_rc=$?
check "$([ "$signal_rc" -ne 0 ] && echo nonzero || echo zero)" nonzero "the signalled rollback exit status (rc=$signal_rc)"
check "$([ -f /usr/local/sbin/newme-deploy ] && echo present || echo MISSING)" present \
  "the wrapper remains present after SIGTERM"
check "$(digest /usr/local/sbin/newme-deploy)" "$candidate_wrapper_digest" \
  "the wrapper remains the complete pre-rename byte sequence"
check "$(leftover_temps)" 0 "temporary files after SIGTERM cleanup"

step "re-run the same rollback to convergence"
run_rollback "$TREE/scripts/rollback-systemd-assets.sh" "$CANDIDATE_SNAPSHOT" "$OUT.sigterm-reentry"
check "$ROLLBACK_RC" 0 "the post-SIGTERM reentry exit code"
check "$(count_control_plane_f37)" "$CONTROL_COUNT" "all control-plane paths after post-SIGTERM reentry"
check "$([ -e "$NOPASSWD" ] && echo present || echo absent)" present "ubuntu-nopasswd after post-SIGTERM reentry"
check "$(leftover_temps)" 0 "temporary files after post-SIGTERM reentry"

step "re-enter once more to prove the converged state is idempotent"
reentry_before="$(for dest in "${CONTROL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')"
run_rollback "$TREE/scripts/rollback-systemd-assets.sh" "$CANDIDATE_SNAPSHOT" "$OUT.sigterm-reentry2"
check "$ROLLBACK_RC" 0 "the repeated post-SIGTERM restore exit code"
reentry_after="$(for dest in "${CONTROL_DESTS[@]}"; do digest "$dest"; done | sha256sum | awk '{print $1}')"
check "$reentry_after" "$reentry_before" "the repeated post-SIGTERM control-plane state"

# ---------------------------------------------------------------------------
# C2 · the coordinator-issued installer transaction, and closing it
# ---------------------------------------------------------------------------
phase "C2: the transaction an installer invocation leaves open"
gate_record() {
  # This is input-fixture construction for the installer's verifier, inside a
  # container that the drill has already proved is throwaway. It is not the
  # production bootstrap procedure: only newme-deploy's bootstrap coordinator may
  # create the production record, after it has rerun every named machine gate.
  local record
  record="$(mktemp "$STATE_ROOT/deploy-gates.XXXXXX")"
  chmod 0600 "$record"; chown root:root "$record"
  {
    printf 'sha=%s\n' "$TREE_SHA"
    printf 'event=workflow_dispatch\n'
    printf 'run=99999999\n'
    printf 'gate=canonical-main-verified\n'
    printf 'gate=github-required-jobs-green\n'
    printf 'gate=taskboard-predeploy-ready\n'
    printf 'gate=release-claim-derived\n'
    printf 'gate=remote-migration-history\n'
    printf 'gate=release-companions-verified\n'
  } >"$record"
  echo "$record"
}
prepare_mirror() {
  rm -rf /opt/newme/repository.git
  git init -q --bare /opt/newme/repository.git
  git --git-dir=/opt/newme/repository.git remote add origin https://github.com/69755354/newme-platform.git
  chown -R root:root /opt/newme/repository.git; chmod 0700 /opt/newme/repository.git
}
run_install() {
  local record rc
  record="$(gate_record)"
  # install mode refuses if the candidate release directory already exists, and the
  # fixture's /opt/newme/current is that directory. Point current at a second
  # release so the run has somewhere to come from, as it does on the host.
  PATH="$STUBS:$PATH" NEWME_DEPLOY_GATE_RECORD="$record" \
    bash "$TREE/scripts/install-systemd-assets.sh" >"$OUT.install" 2>"$OUT.install.err"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    diagnose "install rc=$rc" "$OUT.install.err"
    rm -f "$record"
    record="$(gate_record)"
    trace install env PATH="$STUBS:$PATH" NEWME_DEPLOY_GATE_RECORD="$record"       bash -x "$TREE/scripts/install-systemd-assets.sh"
  fi
  rm -f "$record"
  return "$rc"
}

reset_host
prepare_mirror
# The release install mode is about to create must not already exist, so the live
# release is a different SHA — exactly the host's situation during a bootstrap.
PREVIOUS_SHA="$(printf 'e%.0s' $(seq 1 40))"
mkdir -p "/opt/newme/releases/$PREVIOUS_SHA"
cp -a "$TREE/infra" "/opt/newme/releases/$PREVIOUS_SHA/"
cp -a "$TREE/newme-platform.service" "/opt/newme/releases/$PREVIOUS_SHA/newme-platform.service"
write_fixture_release_env "/opt/newme/releases/$PREVIOUS_SHA"
: >"/opt/newme/releases/$PREVIOUS_SHA/.newme-protect"
ln -sfn "/opt/newme/releases/$PREVIOUS_SHA" /opt/newme/current
rm -rf "/opt/newme/releases/$TREE_SHA"
# The bootstrap host in the runbook has never rolled back (C1b), so the transaction
# has to be able to record that and the recovery has to be able to reproduce it.
rm -f /opt/newme/current.rollback

step "run install mode with a verifier fixture after the coordinator contract"
if run_install; then
  pass "install mode succeeded"
  INSTALL_OK=1
else
  INSTALL_RC=$?
  fail "install mode exited $INSTALL_RC: $(tail -c 400 "$OUT.install.err")"
  INSTALL_OK=0
fi
if [ "$INSTALL_OK" = 1 ]; then
  check "$(count_control_plane_matching "$TREE")" "$CONTROL_COUNT" "control-plane files installed from the tree"
  check "$([ -e "$NOPASSWD" ] && echo present || echo absent)" absent "ubuntu-nopasswd after the install"
  check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" present \
    "the pending record a successful installer invocation leaves behind"
  PENDING_SHA_LINE="$(sed -n 's/^sha=//p' "$STATE_ROOT/systemd-assets.pending")"
  check "$PENDING_SHA_LINE" "$TREE_SHA" "and it names this release"
  check "$(grep -c '^previous_rollback=$' "$STATE_ROOT/systemd-assets.pending")" 1     "and it records the absent rollback pointer as absent"
  check "$(sed -n 's/^previous=//p' "$STATE_ROOT/systemd-assets.pending")" "/opt/newme/releases/$PREVIOUS_SHA" \
    "and its recovery point is the release still live"
  cp -a "$STATE_ROOT/systemd-assets.pending" "$WORK/pending.keep"
  PENDING_BACKUP="$(sed -n 's/^backup=//p' "$STATE_ROOT/systemd-assets.pending")"

  step "what the next install does with that unresolved bootstrap record"
  : >"$STUB_LOG"
  run_install
  second_rc=$?
  grep -q "recovering unresolved versioned assets from" "$OUT.install.err" \
    && pass "the next install treats the bootstrap as an interrupted transaction" \
    || fail "no recovery attempt: $(tail -c 300 "$OUT.install.err")"
  check "$second_rc" 66 "the unresolved protected recovery fails closed"
  check "$(count_control_plane_matching "$TREE")" "$CONTROL_COUNT" \
    "the candidate control plane remains intact after refused recovery"
  check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" present \
    "the recovery pointer is retained after refusal"
  check "$(grep -c 'deploy:pending-recovery' "$STUB_LOG")" 0 \
    "the service is not restarted after refused recovery"

  step "with the finalizer, the same second run finds nothing to recover"
  reset_host
  prepare_mirror
  mkdir -p "/opt/newme/releases/$PREVIOUS_SHA"
  cp -a "$TREE/infra" "/opt/newme/releases/$PREVIOUS_SHA/"
  cp -a "$TREE/newme-platform.service" "/opt/newme/releases/$PREVIOUS_SHA/newme-platform.service"
  write_fixture_release_env "/opt/newme/releases/$PREVIOUS_SHA"
  : >"/opt/newme/releases/$PREVIOUS_SHA/.newme-protect"
  ln -sfn "/opt/newme/releases/$PREVIOUS_SHA" /opt/newme/current
  rm -rf "/opt/newme/releases/$TREE_SHA"
  rm -f /opt/newme/current.rollback
  run_install || fail "install mode failed on the second fixture: $(tail -c 300 "$OUT.install.err")"

  step "finalize refuses without its confirmation"
  PATH="$STUBS:$PATH" bash "$TREE/scripts/install-systemd-assets.sh" finalize >"$OUT.fin0" 2>&1
  check "$?" 64 "finalize without NEWME_ASSET_FINALIZE_CONFIRM"
  check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" present "the record is retained"

  step "finalize refuses from a tree that is not the release"
  OTHER="$WORK/other"; rm -rf "$OTHER"; mkdir -p "$OTHER"
  cp -a "$TREE/scripts" "$TREE/infra" "$OTHER/"
  printf '\n# not the release\n' >>"$OTHER/scripts/install-systemd-assets.sh"
  git -C "$OTHER" init -q; git -C "$OTHER" add -A
  git -C "$OTHER" -c user.email=drill@example.invalid -c user.name=drill commit -qm other
  PATH="$STUBS:$PATH" NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$OTHER/scripts/install-systemd-assets.sh" finalize >"$OUT.fin1" 2>&1
  check "$?" 65 "finalize from a different tree"
  grep -q "not the release the unresolved asset transaction installed" "$OUT.fin1" \
    && pass "and says why" || fail "unexpected refusal: $(tail -c 200 "$OUT.fin1")"
  check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" present "the record is retained"

  step "finalize refuses while the live control plane is not this release's"
  cp -a /usr/local/sbin/newme-deploy "$WORK/deploy.keep"
  printf '# drift\n' >>/usr/local/sbin/newme-deploy
  PATH="$STUBS:$PATH" NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$TREE/scripts/install-systemd-assets.sh" finalize >"$OUT.fin2" 2>&1
  check "$?" 65 "finalize with a drifted control plane"
  grep -q "differs from the tree being finalized" "$OUT.fin2" && pass "and names the file" || fail "unexpected: $(tail -c 200 "$OUT.fin2")"
  check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" present "the record is retained"
  cp -a "$WORK/deploy.keep" /usr/local/sbin/newme-deploy
  chmod 0755 /usr/local/sbin/newme-deploy

  step "finalize refuses while ubuntu-nopasswd is back"
  printf 'ubuntu ALL=(ALL) NOPASSWD:ALL\n' >"$NOPASSWD"; chmod 0440 "$NOPASSWD"
  PATH="$STUBS:$PATH" NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$TREE/scripts/install-systemd-assets.sh" finalize >"$OUT.fin3" 2>&1
  check "$?" 65 "finalize with the nopasswd fragment present"
  grep -q "ubuntu-nopasswd is still present" "$OUT.fin3" && pass "and says so" || fail "unexpected: $(tail -c 200 "$OUT.fin3")"
  rm -f "$NOPASSWD"

  step "finalize refuses when the backup it would roll back to is gone"
  PENDING_BACKUP="$(sed -n 's/^backup=//p' "$STATE_ROOT/systemd-assets.pending")"
  mv "$PENDING_BACKUP" "$PENDING_BACKUP.moved"
  PATH="$STUBS:$PATH" NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$TREE/scripts/install-systemd-assets.sh" finalize >"$OUT.fin4" 2>&1
  check "$?" 65 "finalize with a vanished backup"
  grep -q "would roll back to is incomplete" "$OUT.fin4" && pass "and says so" || fail "unexpected: $(tail -c 200 "$OUT.fin4")"
  check "$([ -f "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" present "the record is retained"
  mv "$PENDING_BACKUP.moved" "$PENDING_BACKUP"

  step "finalize closes it"
  PATH="$STUBS:$PATH" NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$TREE/scripts/install-systemd-assets.sh" finalize >"$OUT.fin5" 2>&1
  check "$?" 0 "finalize exit code"
  grep -q "systemd_asset_transaction=none" "$OUT.fin5" && pass "it reports the transaction closed" || fail "no report: $(tail -c 200 "$OUT.fin5")"
  grep -q "state=control_plane_only" "$OUT.fin5" && pass "and that the release was not switched" || fail "unexpected state line"
  check "$([ -e "$STATE_ROOT/systemd-assets.pending" ] && echo present || echo absent)" absent "the pending record"

  step "finalize again (reentry)"
  PATH="$STUBS:$PATH" NEWME_ASSET_FINALIZE_CONFIRM=bootstrap \
    bash "$TREE/scripts/install-systemd-assets.sh" finalize >"$OUT.fin6" 2>&1
  check "$?" 0 "a second finalize is success"
  grep -q "systemd_asset_transaction=none" "$OUT.fin6" && pass "and reports the same thing" || fail "no report"

  step "and now the next install has nothing to recover"
  rm -rf "/opt/newme/releases/$TREE_SHA"
  : >"$STUB_LOG"
  run_install
  grep -q "recovering unresolved versioned assets from" "$OUT.install.err" \
    && fail "it still recovered a transaction that was closed" \
    || pass "no recovery branch, so the bootstrap survives the next deployment"
  grep -q "deploy:pending-recovery" "$STUB_LOG" && fail "it still restarted for recovery" || pass "and no recovery restart"
fi

printf '\n== drill complete: %d checks, %d failures ==\n' "$CHECKS" "$FAILURES"
[ "$FAILURES" -eq 0 ]
