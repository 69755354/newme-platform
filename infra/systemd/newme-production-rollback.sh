#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "newme-production-rollback must run as root" >&2
  exit 77
fi
exec 9>/run/lock/newme-production-release.lock
flock -n 9 || {
  echo "another production release operation is active" >&2
  exit 69
}

STATE_ROOT=/var/lib/newme/deploy-state
PENDING_RECORD="$STATE_ROOT/production-rollback.pending"
ROLLBACK_MAP="$STATE_ROOT/production-rollback.map"
SYSTEMD_PENDING_RECORD="$STATE_ROOT/systemd-assets.pending"
MIGRATION_DB_URL_FILE=/etc/newme/migration-db.url
ASSET_SNAPSHOT_HELPER=/usr/local/libexec/newme/newme-install-systemd-assets
ASSET_ROLLBACK_HELPER=/usr/local/libexec/newme/newme-rollback-systemd-assets
SNAPSHOT_RECORD=""
PENDING_ORIGINAL_CURRENT=""
PENDING_ORIGINAL_ROLLBACK=""
PENDING_TRANSACTION_KIND=""
PENDING_REMOVE_ORIGINAL_ON_COMPLETE=""
PENDING_TARGET_RELEASE=""
PENDING_TARGET_ROLLBACK=""
PENDING_TARGET_ASSET_BACKUP=""
PENDING_LIVE_ASSET_BACKUP=""
PENDING_DB_PHASE=""
PENDING_STATE=""
SYSTEMD_PENDING_SHA=""
SYSTEMD_PENDING_BACKUP=""
SYSTEMD_PENDING_PREVIOUS=""
SYSTEMD_PENDING_PREVIOUS_ROLLBACK=""
RESOLVED_TARGET_ASSET_BACKUP=""
RESOLVED_RELEASE_STATUS=""
RESOLVED_PREVIOUS_ROLLBACK=""
health=""
auth=""

install -d -o root -g root -m 0700 "$STATE_ROOT"
[ -d "$STATE_ROOT" ] && [ ! -L "$STATE_ROOT" ] || { echo "persistent rollback state directory is invalid" >&2; exit 65; }
[ "$(stat -c '%U:%G' "$STATE_ROOT")" = root:root ] || { echo "persistent rollback state ownership is invalid" >&2; exit 65; }
[ "$(stat -c '%a' "$STATE_ROOT")" = 700 ] || { echo "persistent rollback state mode is invalid" >&2; exit 65; }

validate_release() {
  local release="$1"
  case "$release" in
    /opt/newme/releases/*) ;;
    *) echo "release outside approved root: $release" >&2; return 1 ;;
  esac
  [[ "$(basename "$release")" =~ ^[0-9a-f]{40}$ ]] || return 1
  [ -d "$release" ] && [ ! -L "$release" ] &&
    [ -f "$release/.newme-protect" ] && [ -f "$release/.next/BUILD_ID" ] || {
    echo "release is not protected and complete: $release" >&2
    return 1
  }
}

validate_asset_backup() {
  local backup="$1"
  case "$backup" in
    /var/backups/newme-systemd-assets/*) ;;
    *) return 1 ;;
  esac
  [ -d "$backup" ] && [ ! -L "$backup" ] || return 1
  [ "$(stat -c '%U:%G' "$backup")" = root:root ] || return 1
  [ "$(stat -c '%a' "$backup")" = 700 ] || return 1
  [ -d "$backup/rootfs" ] &&
    [ -f "$backup/managed.list" ] &&
    [ -f "$backup/present.list" ] &&
    [ -f "$backup/manifest.sha256" ] &&
    [ -f "$backup/symlink.sha256" ]
}

validate_control_helper() {
  local helper="$1"
  [ -f "$helper" ] && [ ! -L "$helper" ] && [ -x "$helper" ] || return 1
  [ "$(stat -c '%U:%G' "$helper")" = root:root ] || return 1
  [ "$(stat -c '%a' "$helper")" = 755 ]
}

# Round-4 review C8: the application rollback was not coupled to the database
# phase. This release changes the database in two phases, and after the contract
# phase the previous release is not merely untested against it — every direct money
# write it makes is refused. A rollback that only moved the `current` symlink would
# therefore produce the outage it was run to prevent, and nothing in this script
# looked. So the mode is asked for before the switch, and the answer is recorded in
# the durable transaction record.
#
# The gate that is run is the LIVE release's copy, pointed at the target directory.
# That is the right way round: the target is normally the release that predates the
# mechanism, so it carries neither this script nor a declaration, and its missing
# declaration is exactly what has to be judged (a pre-mechanism release runs under
# `compat`, not under `strict`). The live release is a validated, protected,
# immutable directory, and `current` was validated by validate_release above.
#
# Fail-closed, with no override, because every refusal has the same operator
# remedy and the gate prints it: return the database to compat with
# supabase/migrations/rollback_money_direct_write_contract_phase.sql (runbook §5.1)
# and re-run. The two refusals that are not about the mode are honest too — a
# rollback that cannot reach the migration database is not a rollback that would
# have helped, since both releases need that database to serve a request.
read_target_database_phase() {
  local target="$1" live="$2" gate="" node_bin="" output=""
  gate="$live/scripts/check-release-phase.mjs"
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] && [ -x "$node_bin" ] || {
    echo "node is required to verify the database phase before switching releases" >&2
    return 1
  }
  [ -f "$gate" ] && [ ! -L "$gate" ] || {
    echo "the live release carries no scripts/check-release-phase.mjs, so the database phase cannot be verified" >&2
    return 1
  }
  [ -f "$MIGRATION_DB_URL_FILE" ] && [ ! -L "$MIGRATION_DB_URL_FILE" ] || {
    echo "root-owned migration database URL file is missing" >&2
    return 1
  }
  [ "$(stat -c '%U:%G' "$MIGRATION_DB_URL_FILE")" = root:root ] || {
    echo "migration database URL file ownership is invalid" >&2
    return 1
  }
  case "$(stat -c '%a' "$MIGRATION_DB_URL_FILE")" in
    400|600) ;;
    *) echo "migration database URL file mode must be 0400 or 0600" >&2; return 1 ;;
  esac
  # The URL is read by the gate from the file and never appears in an argument
  # list: a connection string is a credential. The gate's diagnostics go to stderr
  # and reach the operator; stdout is one line and is the only thing parsed here.
  output="$("$node_bin" "$gate" --for-switch \
    --release-dir "$target" \
    --url-file "$MIGRATION_DB_URL_FILE" \
    --modules-dir "$live/node_modules")" || return 1
  [[ "$output" =~ ^NEWME_DB_PHASE=(absent|compat|strict)$ ]] || {
    echo "the database phase gate exited 0 without reporting a mode" >&2
    return 1
  }
  PENDING_DB_PHASE="${BASH_REMATCH[1]}"
}

write_pending_state() {
  local state="$1" tmp="${PENDING_RECORD}.tmp.$$"
  case "$state" in prepared|app_switched|target_assets_restored|complete) ;; *) return 1 ;; esac
  umask 077
  # db_phase is the mode read_target_database_phase() observed before the switch was
  # authorised, so the record says which database this transaction was judged
  # against. A record written by the version of this script that predates the key
  # has nine lines and is refused by load_pending_state — which is safe rather than
  # a cliff, because newme-deploy.sh refuses to deploy at all while a rollback
  # transaction is unresolved, so this script can only be replaced between them.
  printf 'transaction_kind=%s\nremove_original_on_complete=%s\noriginal_current=%s\noriginal_rollback=%s\ntarget_release=%s\ntarget_rollback=%s\ntarget_asset_backup=%s\nlive_asset_backup=%s\ndb_phase=%s\nstate=%s\n' \
    "$PENDING_TRANSACTION_KIND" "$PENDING_REMOVE_ORIGINAL_ON_COMPLETE" "$PENDING_ORIGINAL_CURRENT" "$PENDING_ORIGINAL_ROLLBACK" \
    "$PENDING_TARGET_RELEASE" "$PENDING_TARGET_ROLLBACK" "$PENDING_TARGET_ASSET_BACKUP" \
    "$PENDING_LIVE_ASSET_BACKUP" "$PENDING_DB_PHASE" "$state" > "$tmp" || return 1
  chown root:root "$tmp" || return 1
  chmod 0600 "$tmp" || return 1
  mv -f "$tmp" "$PENDING_RECORD" || return 1
  sync -f "$STATE_ROOT" || return 1
  PENDING_STATE="$state"
}

load_pending_state() {
  [ -f "$PENDING_RECORD" ] && [ ! -L "$PENDING_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$PENDING_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$PENDING_RECORD")" = 600 ] || return 1
  [ "$(wc -l < "$PENDING_RECORD")" -eq 10 ] || return 1
  [ "$(grep -Ec '^transaction_kind=(rollback|deploy_recovery|release_recovery)$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^remove_original_on_complete=[01]$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^original_current=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^original_rollback=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^target_release=/opt/newme/releases/[0-9a-f]{40}$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^target_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^target_asset_backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^live_asset_backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^db_phase=(absent|compat|strict)$' "$PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^state=(prepared|app_switched|target_assets_restored|complete)$' "$PENDING_RECORD")" -eq 1 ] || return 1
  PENDING_TRANSACTION_KIND="$(sed -n 's/^transaction_kind=//p' "$PENDING_RECORD")"
  PENDING_REMOVE_ORIGINAL_ON_COMPLETE="$(sed -n 's/^remove_original_on_complete=//p' "$PENDING_RECORD")"
  PENDING_ORIGINAL_CURRENT="$(sed -n 's/^original_current=//p' "$PENDING_RECORD")"
  PENDING_ORIGINAL_ROLLBACK="$(sed -n 's/^original_rollback=//p' "$PENDING_RECORD")"
  PENDING_TARGET_RELEASE="$(sed -n 's/^target_release=//p' "$PENDING_RECORD")"
  PENDING_TARGET_ROLLBACK="$(sed -n 's/^target_rollback=//p' "$PENDING_RECORD")"
  PENDING_TARGET_ASSET_BACKUP="$(sed -n 's/^target_asset_backup=//p' "$PENDING_RECORD")"
  PENDING_LIVE_ASSET_BACKUP="$(sed -n 's/^live_asset_backup=//p' "$PENDING_RECORD")"
  PENDING_DB_PHASE="$(sed -n 's/^db_phase=//p' "$PENDING_RECORD")"
  PENDING_STATE="$(sed -n 's/^state=//p' "$PENDING_RECORD")"
  case "$PENDING_TRANSACTION_KIND:$PENDING_REMOVE_ORIGINAL_ON_COMPLETE" in
    rollback:0|deploy_recovery:1|release_recovery:1) ;;
    *) return 1 ;;
  esac
  if { [ "$PENDING_TRANSACTION_KIND" = deploy_recovery ] || [ "$PENDING_TRANSACTION_KIND" = release_recovery ]; } &&
    [ "$PENDING_REMOVE_ORIGINAL_ON_COMPLETE" = 1 ] && [ "$PENDING_STATE" = complete ]; then
    if [ ! -e "$PENDING_ORIGINAL_CURRENT" ] && [ ! -L "$PENDING_ORIGINAL_CURRENT" ]; then
      : # The failed candidate was already durably removed during idempotent finalization.
    elif [ -d "$PENDING_ORIGINAL_CURRENT" ] && [ ! -L "$PENDING_ORIGINAL_CURRENT" ]; then
      # A kill may interrupt recursive removal after the release markers disappear.
      # The still-durable fixed pointer proves this exact directory was absent before
      # the interrupted deployment, so finalization may safely resume its deletion.
      if [ "$PENDING_TRANSACTION_KIND" = deploy_recovery ]; then
        load_systemd_pending || return 1
        [ "$PENDING_ORIGINAL_CURRENT" = "/opt/newme/releases/$SYSTEMD_PENDING_SHA" ] || return 1
        [ "$PENDING_TARGET_RELEASE" = "$SYSTEMD_PENDING_PREVIOUS" ] || return 1
        [ "$PENDING_TARGET_ROLLBACK" = "$SYSTEMD_PENDING_PREVIOUS_ROLLBACK" ] || return 1
        [ "$PENDING_TARGET_ASSET_BACKUP" = "$SYSTEMD_PENDING_BACKUP" ] || return 1
      fi
    else
      return 1
    fi
  else
    validate_release "$PENDING_ORIGINAL_CURRENT" || return 1
  fi
  validate_release "$PENDING_ORIGINAL_ROLLBACK" || return 1
  validate_release "$PENDING_TARGET_RELEASE" || return 1
  if [ -n "$PENDING_TARGET_ROLLBACK" ]; then
    validate_release "$PENDING_TARGET_ROLLBACK" || return 1
  fi
  validate_asset_backup "$PENDING_TARGET_ASSET_BACKUP" || return 1
  validate_asset_backup "$PENDING_LIVE_ASSET_BACKUP" || return 1
}

load_systemd_pending() {
  [ -f "$SYSTEMD_PENDING_RECORD" ] && [ ! -L "$SYSTEMD_PENDING_RECORD" ] || return 1
  [ "$(stat -c '%U:%G' "$SYSTEMD_PENDING_RECORD")" = root:root ] || return 1
  [ "$(stat -c '%a' "$SYSTEMD_PENDING_RECORD")" = 600 ] || return 1
  [ "$(wc -l < "$SYSTEMD_PENDING_RECORD")" -eq 5 ] || return 1
  [ "$(grep -Ec '^sha=[0-9a-f]{40}$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous=/opt/newme/releases/[0-9a-f]{40}$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^previous_rollback=(/opt/newme/releases/[0-9a-f]{40})?$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || return 1
  [ "$(grep -Ec '^candidate_preexisting=0$' "$SYSTEMD_PENDING_RECORD")" -eq 1 ] || return 1
  SYSTEMD_PENDING_SHA="$(sed -n 's/^sha=//p' "$SYSTEMD_PENDING_RECORD")"
  SYSTEMD_PENDING_BACKUP="$(sed -n 's/^backup=//p' "$SYSTEMD_PENDING_RECORD")"
  SYSTEMD_PENDING_PREVIOUS="$(sed -n 's/^previous=//p' "$SYSTEMD_PENDING_RECORD")"
  SYSTEMD_PENDING_PREVIOUS_ROLLBACK="$(sed -n 's/^previous_rollback=//p' "$SYSTEMD_PENDING_RECORD")"
  validate_asset_backup "$SYSTEMD_PENDING_BACKUP" || return 1
  validate_release "$SYSTEMD_PENDING_PREVIOUS" || return 1
  if [ -n "$SYSTEMD_PENDING_PREVIOUS_ROLLBACK" ]; then
    validate_release "$SYSTEMD_PENDING_PREVIOUS_ROLLBACK" || return 1
  fi
}

load_unresolved_deploy_target() {
  local current="$1"
  load_systemd_pending || return 1
  [ "$current" = "/opt/newme/releases/$SYSTEMD_PENDING_SHA" ] || return 1
  [ "$SYSTEMD_PENDING_PREVIOUS" != "$current" ] || return 1
}

remove_interrupted_candidate_release() {
  local candidate="$1"
  case "$candidate" in /opt/newme/releases/*) ;; *) return 1 ;; esac
  [[ "$(basename "$candidate")" =~ ^[0-9a-f]{40}$ ]] || return 1
  if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
    sync -f /opt/newme/releases || return 1
    return 0
  fi
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" != "$candidate" ] || return 1
  [ "$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)" != "$candidate" ] || return 1
  rm -rf --one-file-system -- "$candidate" || return 1
  [ ! -e "$candidate" ] && [ ! -L "$candidate" ] || return 1
  sync -f /opt/newme/releases || return 1
}

clear_matching_systemd_pending() {
  if [ ! -e "$SYSTEMD_PENDING_RECORD" ] && [ ! -L "$SYSTEMD_PENDING_RECORD" ]; then
    return 0
  fi
  load_systemd_pending || return 1
  [ "$PENDING_TRANSACTION_KIND" = deploy_recovery ] || return 1
  [ "$PENDING_ORIGINAL_CURRENT" = "/opt/newme/releases/$SYSTEMD_PENDING_SHA" ] || return 1
  [ "$PENDING_TARGET_RELEASE" = "$SYSTEMD_PENDING_PREVIOUS" ] || return 1
  [ "$PENDING_TARGET_ROLLBACK" = "$SYSTEMD_PENDING_PREVIOUS_ROLLBACK" ] || return 1
  [ "$PENDING_TARGET_ASSET_BACKUP" = "$SYSTEMD_PENDING_BACKUP" ] || return 1
  remove_interrupted_candidate_release "$PENDING_ORIGINAL_CURRENT" || return 1
  rm -f -- "$SYSTEMD_PENDING_RECORD" || return 1
  sync -f "$STATE_ROOT" || return 1
}

recover_preswitch_deploy() {
  local expected_sha="$SYSTEMD_PENDING_SHA"
  local expected_backup="$SYSTEMD_PENDING_BACKUP"
  local expected_previous="$SYSTEMD_PENDING_PREVIOUS"
  local expected_previous_rollback="$SYSTEMD_PENDING_PREVIOUS_ROLLBACK"
  local rollback_next="/opt/newme/current.rollback.transaction-$$"
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$expected_previous" ] || return 1
  bash "$ASSET_ROLLBACK_HELPER" "$expected_backup" || return 1
  rm -f -- "$rollback_next" || return 1
  if [ -n "$expected_previous_rollback" ]; then
    ln -s "$expected_previous_rollback" "$rollback_next" || return 1
    mv -Tf "$rollback_next" /opt/newme/current.rollback || return 1
  else
    rm -f -- /opt/newme/current.rollback || return 1
  fi
  sync -f /opt/newme || return 1
  /usr/local/sbin/newme-service-control reset-failed \
    "production-rollback:pre-switch-recovery-reset" || true
  /usr/local/sbin/newme-service-control restart \
    "production-rollback:pre-switch-recovery" || return 1
  verify_current_release || return 1
  remove_interrupted_candidate_release "/opt/newme/releases/$expected_sha" || return 1
  load_systemd_pending || return 1
  [ "$SYSTEMD_PENDING_SHA" = "$expected_sha" ] || return 1
  [ "$SYSTEMD_PENDING_BACKUP" = "$expected_backup" ] || return 1
  [ "$SYSTEMD_PENDING_PREVIOUS" = "$expected_previous" ] || return 1
  [ "$SYSTEMD_PENDING_PREVIOUS_ROLLBACK" = "$expected_previous_rollback" ] || return 1
  rm -f -- "$SYSTEMD_PENDING_RECORD" || return 1
  sync -f "$STATE_ROOT" || return 1
}

switch_release_links() {
  local current_target="$1" rollback_target="$2"
  local current_next="/opt/newme/current.transaction-$$"
  local rollback_next="/opt/newme/current.rollback.transaction-$$"
  validate_release "$current_target" || return 1
  if [ -n "$rollback_target" ]; then
    validate_release "$rollback_target" || return 1
  fi
  rm -f -- "$current_next" "$rollback_next" || return 1
  ln -s "$current_target" "$current_next" || return 1
  mv -Tf "$current_next" /opt/newme/current || return 1
  if [ -n "$rollback_target" ]; then
    ln -s "$rollback_target" "$rollback_next" || return 1
    mv -Tf "$rollback_next" /opt/newme/current.rollback || return 1
  else
    rm -f -- /opt/newme/current.rollback || return 1
  fi
  sync -f /opt/newme || return 1
}

rollback_link_matches() {
  local expected="$1"
  if [ -n "$expected" ]; then
    [ "$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)" = "$expected" ]
  else
    [ ! -e /opt/newme/current.rollback ] && [ ! -L /opt/newme/current.rollback ]
  fi
}

verify_current_release() {
  health="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
    http://127.0.0.1:3001/api/health || true)"
  auth="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 \
    http://127.0.0.1:3001/api/auth/me || true)"
  [ "$health" = 200 ] && [ "$auth" = 401 ] &&
    [ "$(systemctl is-active newme-platform.service)" = active ]
}

resolve_target_asset_backup() {
  local current="$1" rollback="$2" candidate="" metadata=""
  local resolved_status="" resolved_previous="" extra=""
  local evidence_files=()
  RESOLVED_TARGET_ASSET_BACKUP=""
  RESOLVED_RELEASE_STATUS=""
  RESOLVED_PREVIOUS_ROLLBACK=""
  if [ -d "$current/.audit" ]; then
    mapfile -t evidence_files < <(find "$current/.audit" -maxdepth 1 -type f -name 'deploy-*.json' -print)
    [ "${#evidence_files[@]}" -le 1 ] || return 1
    if [ "${#evidence_files[@]}" -eq 1 ]; then
      if metadata="$(python3 - "${evidence_files[0]}" "$current" "$rollback" <<'PY'
import json
import re
import sys

path, current, rollback = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    evidence = json.load(handle)
target = evidence.get("rollback", {})
status = evidence.get("release_status")
previous_rollback = target.get("previous_rollback", {})
if (
    evidence.get("git_sha") != current.rsplit("/", 1)[-1]
    or status not in {"awaiting_uat", "uat_failed", "complete"}
    or target.get("git_sha") != rollback.rsplit("/", 1)[-1]
    or target.get("backup_dir") != rollback
):
    raise SystemExit(65)
asset_backup = target.get("asset_backup", "")
if not re.fullmatch(r"/var/backups/newme-systemd-assets/[^\s]+", asset_backup):
    raise SystemExit(65)
previous_dir = ""
if status in {"awaiting_uat", "uat_failed"}:
    if evidence.get("candidate_preexisting") is not False or not isinstance(previous_rollback, dict):
        raise SystemExit(65)
    previous_sha = previous_rollback.get("git_sha", "")
    previous_dir = previous_rollback.get("backup_dir", "")
    if previous_dir:
        if (
            not re.fullmatch(r"/opt/newme/releases/[0-9a-f]{40}", previous_dir)
            or previous_sha != previous_dir.rsplit("/", 1)[-1]
        ):
            raise SystemExit(65)
    elif previous_sha:
        raise SystemExit(65)
print(status, asset_backup, previous_dir or "-", sep="\t")
PY
)"; then
        IFS=$'\t' read -r resolved_status candidate resolved_previous extra <<< "$metadata"
        [ -n "$resolved_status" ] && [ -n "$candidate" ] && [ -n "$resolved_previous" ] && [ -z "$extra" ] || return 1
        validate_asset_backup "$candidate" || return 1
        if [ "$resolved_previous" != - ]; then
          validate_release "$resolved_previous" || return 1
          RESOLVED_PREVIOUS_ROLLBACK="$resolved_previous"
        fi
        RESOLVED_TARGET_ASSET_BACKUP="$candidate"
        RESOLVED_RELEASE_STATUS="$resolved_status"
        return 0
      fi
    fi
  fi
  [ -f "$ROLLBACK_MAP" ] && [ ! -L "$ROLLBACK_MAP" ] || return 1
  [ "$(stat -c '%U:%G' "$ROLLBACK_MAP")" = root:root ] || return 1
  [ "$(stat -c '%a' "$ROLLBACK_MAP")" = 600 ] || return 1
  [ "$(wc -l < "$ROLLBACK_MAP")" -eq 3 ] || return 1
  [ "$(grep -Ec '^current=/opt/newme/releases/[0-9a-f]{40}$' "$ROLLBACK_MAP")" -eq 1 ] || return 1
  [ "$(grep -Ec '^rollback=/opt/newme/releases/[0-9a-f]{40}$' "$ROLLBACK_MAP")" -eq 1 ] || return 1
  [ "$(grep -Ec '^asset_backup=/var/backups/newme-systemd-assets/[^[:space:]]+$' "$ROLLBACK_MAP")" -eq 1 ] || return 1
  [ "$(sed -n 's/^current=//p' "$ROLLBACK_MAP")" = "$current" ] || return 1
  [ "$(sed -n 's/^rollback=//p' "$ROLLBACK_MAP")" = "$rollback" ] || return 1
  candidate="$(sed -n 's/^asset_backup=//p' "$ROLLBACK_MAP")"
  validate_asset_backup "$candidate" || return 1
  RESOLVED_TARGET_ASSET_BACKUP="$candidate"
  RESOLVED_RELEASE_STATUS=complete
  RESOLVED_PREVIOUS_ROLLBACK=""
}

snapshot_live_assets() {
  local current="$1" snapshot=""
  SNAPSHOT_RECORD="$(mktemp "$STATE_ROOT/asset-snapshot.XXXXXX")"
  chmod 0600 "$SNAPSHOT_RECORD"
  if ! NEWME_ASSET_SNAPSHOT_RECORD="$SNAPSHOT_RECORD" \
    NEWME_ASSET_SOURCE_ROOT="$current" bash "$ASSET_SNAPSHOT_HELPER" snapshot >/dev/null; then
    rm -f -- "$SNAPSHOT_RECORD"
    SNAPSHOT_RECORD=""
    return 1
  fi
  if ! IFS= read -r snapshot < "$SNAPSHOT_RECORD" ||
    ! validate_asset_backup "$snapshot"; then
    rm -f -- "$SNAPSHOT_RECORD" 2>/dev/null || true
    SNAPSHOT_RECORD=""
    return 1
  fi
  rm -f -- "$SNAPSHOT_RECORD" || return 1
  SNAPSHOT_RECORD=""
  sync -f "$STATE_ROOT" || return 1
  printf '%s\n' "$snapshot"
}

write_reverse_map() {
  local tmp="${ROLLBACK_MAP}.tmp.$$"
  [ "$PENDING_TRANSACTION_KIND" = rollback ] || return 1
  umask 077
  printf 'current=%s\nrollback=%s\nasset_backup=%s\n' \
    "$PENDING_TARGET_RELEASE" "$PENDING_ORIGINAL_CURRENT" "$PENDING_LIVE_ASSET_BACKUP" > "$tmp" || return 1
  chown root:root "$tmp" || return 1
  chmod 0600 "$tmp" || return 1
  mv -f "$tmp" "$ROLLBACK_MAP" || return 1
  sync -f "$STATE_ROOT" || return 1
}

clear_pending_record() {
  rm -f -- "$PENDING_RECORD" || return 1
  sync -f "$STATE_ROOT" || return 1
}

restore_original_transaction() {
  load_pending_state || return 1
  switch_release_links "$PENDING_ORIGINAL_CURRENT" "$PENDING_ORIGINAL_ROLLBACK" || return 1
  bash "$ASSET_ROLLBACK_HELPER" "$PENDING_LIVE_ASSET_BACKUP" || return 1
  /usr/local/sbin/newme-service-control reset-failed \
    "automatic-rollback-recovery:reset-before-restart" || true
  /usr/local/sbin/newme-service-control restart \
    "automatic-rollback-recovery:candidate-verification-failed" || return 1
  verify_current_release || return 1
  clear_pending_record || return 1
}

finalize_completed_transaction() {
  load_pending_state || return 1
  [ "$PENDING_STATE" = complete ] || return 1
  [ "$(readlink -f /opt/newme/current 2>/dev/null || true)" = "$PENDING_TARGET_RELEASE" ] || return 1
  rollback_link_matches "$PENDING_TARGET_ROLLBACK" || return 1
  verify_current_release || return 1
  case "$PENDING_TRANSACTION_KIND" in
    rollback)
      [ ! -e "$SYSTEMD_PENDING_RECORD" ] && [ ! -L "$SYSTEMD_PENDING_RECORD" ] || return 1
      write_reverse_map || return 1
      ;;
    deploy_recovery)
      clear_matching_systemd_pending || return 1
      ;;
    release_recovery)
      [ ! -e "$SYSTEMD_PENDING_RECORD" ] && [ ! -L "$SYSTEMD_PENDING_RECORD" ] || return 1
      remove_interrupted_candidate_release "$PENDING_ORIGINAL_CURRENT" || return 1
      ;;
    *) return 1 ;;
  esac
  clear_pending_record || return 1
}

rollback_cleanup() {
  local rc=$?
  trap - EXIT HUP INT TERM
  [ -z "$SNAPSHOT_RECORD" ] || rm -f -- "$SNAPSHOT_RECORD" 2>/dev/null || true
  if [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; then
    if load_pending_state; then
      if [ "$PENDING_STATE" = complete ]; then
        finalize_completed_transaction || {
          echo "CRITICAL: completed production rollback could not be finalized; persistent state retained" >&2
          rc=2
        }
      elif ! restore_original_transaction; then
        echo "CRITICAL: failed production rollback could not restore the original app and assets; persistent state retained" >&2
        rc=2
      fi
    else
      echo "CRITICAL: production rollback transaction state is invalid; state retained" >&2
      rc=2
    fi
  fi
  exit "$rc"
}

action=${1:-}
case "$action" in
  status)
    [ "$#" -eq 1 ] || { echo "usage: newme-production-rollback status" >&2; exit 64; }
    current="$(readlink -f /opt/newme/current 2>/dev/null || true)"
    rollback="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
    transaction=none
    transaction_db_phase=none
    if [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; then
      if load_pending_state; then
        transaction="$PENDING_STATE"
        # The mode the in-flight transaction was judged against, from the durable
        # record. Read rather than measured: `status` is cheap on purpose, and
        # opening a database connection to answer it would make a monitoring probe
        # depend on the migration credential.
        transaction_db_phase="$PENDING_DB_PHASE"
      else
        transaction=invalid
      fi
    fi
    systemd_asset_transaction=none
    if [ -e "$SYSTEMD_PENDING_RECORD" ] || [ -L "$SYSTEMD_PENDING_RECORD" ]; then
      if ! load_systemd_pending; then
        systemd_asset_transaction=invalid
      elif [ "$current" = "/opt/newme/releases/$SYSTEMD_PENDING_SHA" ]; then
        systemd_asset_transaction=candidate_active
      elif [ "$current" = "$SYSTEMD_PENDING_PREVIOUS" ]; then
        systemd_asset_transaction=pre_switch
      else
        systemd_asset_transaction=mismatch
      fi
    fi
    printf 'current=%s\nrollback=%s\nservice=%s\nhealth_http=%s\nrollback_transaction=%s\nsystemd_asset_transaction=%s\nrollback_db_phase=%s\n' \
      "$current" "$rollback" "$(systemctl is-active newme-platform.service)" \
      "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3001/api/health || true)" \
      "$transaction" "$systemd_asset_transaction" "$transaction_db_phase"
    ;;
  execute)
    [ "$#" -eq 2 ] && [ -n "$2" ] || {
      echo "usage: newme-production-rollback execute <reason>" >&2
      exit 64
    }
    validate_control_helper "$ASSET_SNAPSHOT_HELPER" || {
      echo "protected asset snapshot helper is unavailable" >&2
      exit 65
    }
    validate_control_helper "$ASSET_ROLLBACK_HELPER" || {
      echo "protected asset rollback helper is unavailable" >&2
      exit 65
    }
    if [ -e "$PENDING_RECORD" ] || [ -L "$PENDING_RECORD" ]; then
      load_pending_state || { echo "pending production rollback state is invalid" >&2; exit 65; }
      if [ "$PENDING_STATE" = complete ]; then
        finalize_completed_transaction || exit 68
        echo "finalized previously completed production rollback"
      else
        restore_original_transaction || exit 68
        echo "recovered interrupted production rollback to its original release"
      fi
      exit 0
    fi
    reason=${2//$'\n'/ }
    reason=${reason//$'\r'/ }
    current="$(readlink -f /opt/newme/current 2>/dev/null || true)"
    rollback="$(readlink -f /opt/newme/current.rollback 2>/dev/null || true)"
    validate_release "$current" || exit 66
    transaction_kind=rollback
    remove_original_on_complete=0
    target_release="$rollback"
    target_rollback="$current"
    if [ -e "$SYSTEMD_PENDING_RECORD" ] || [ -L "$SYSTEMD_PENDING_RECORD" ]; then
      load_systemd_pending || {
        echo "unresolved deployment asset pointer is invalid or does not match current" >&2
        exit 65
      }
      if [ "$current" = "$SYSTEMD_PENDING_PREVIOUS" ]; then
        recover_preswitch_deploy || {
          echo "pre-switch deployment recovery failed; protected pointer retained" >&2
          exit 68
        }
        echo "recovered interrupted deployment before application switch"
        exit 0
      elif [ "$current" = "/opt/newme/releases/$SYSTEMD_PENDING_SHA" ]; then
        load_unresolved_deploy_target "$current" || exit 65
        transaction_kind=deploy_recovery
        remove_original_on_complete=1
        target_release="$SYSTEMD_PENDING_PREVIOUS"
        target_rollback="$SYSTEMD_PENDING_PREVIOUS_ROLLBACK"
        target_asset_backup="$SYSTEMD_PENDING_BACKUP"
      else
        echo "unresolved deployment does not match current or its recovery target" >&2
        exit 65
      fi
    else
      resolve_target_asset_backup "$current" "$target_release" || {
        echo "exact versioned asset rollback point is unavailable" >&2
        exit 65
      }
      target_asset_backup="$RESOLVED_TARGET_ASSET_BACKUP"
      case "$RESOLVED_RELEASE_STATUS" in
        awaiting_uat|uat_failed)
          transaction_kind=release_recovery
          remove_original_on_complete=1
          target_rollback="$RESOLVED_PREVIOUS_ROLLBACK"
          ;;
        complete) ;;
        *) exit 65 ;;
      esac
    fi
    validate_release "$rollback" || exit 66
    [ "$current" != "$rollback" ] || { echo "current and rollback are identical" >&2; exit 67; }
    validate_release "$target_release" || exit 66
    [ "$current" != "$target_release" ] || { echo "current and rollback target are identical" >&2; exit 67; }
    # Before anything is snapshotted or moved: may the target serve traffic against
    # the database as it now is? Every path that reaches this point is about to
    # switch — the two recovery paths that do not switch a new release in
    # (recover_preswitch_deploy, and restore_original_transaction, which puts back
    # the release that was live when this transaction was judged) deliberately do
    # not ask, because a refusal there could only strand a recovery.
    read_target_database_phase "$target_release" "$current" || {
      echo "refusing to switch to $target_release: the database phase does not permit it" >&2
      exit 70
    }
    live_asset_backup="$(snapshot_live_assets "$current")" || {
      echo "current live assets could not be snapshotted" >&2
      exit 65
    }
    PENDING_ORIGINAL_CURRENT="$current"
    PENDING_ORIGINAL_ROLLBACK="$rollback"
    PENDING_TRANSACTION_KIND="$transaction_kind"
    PENDING_REMOVE_ORIGINAL_ON_COMPLETE="$remove_original_on_complete"
    PENDING_TARGET_RELEASE="$target_release"
    PENDING_TARGET_ROLLBACK="$target_rollback"
    PENDING_TARGET_ASSET_BACKUP="$target_asset_backup"
    PENDING_LIVE_ASSET_BACKUP="$live_asset_backup"
    trap rollback_cleanup EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    write_pending_state prepared

    switch_release_links "$target_release" "$target_rollback"
    write_pending_state app_switched
    bash "$ASSET_ROLLBACK_HELPER" "$target_asset_backup"
    write_pending_state target_assets_restored
    safe_reason=${reason//[^A-Za-z0-9._:\/@+-]/-}
    safe_reason=${safe_reason:0:160}
    /usr/local/sbin/newme-service-control reset-failed \
      "production-rollback:reset-before-restart"
    /usr/local/sbin/newme-service-control restart "production-rollback:$safe_reason"
    verify_current_release || {
      echo "rollback target failed verification health=$health auth=$auth" >&2
      exit 68
    }
    write_pending_state complete
    finalize_completed_transaction
    trap - EXIT HUP INT TERM
    /usr/bin/logger --journald <<EOF
MESSAGE=newme production rollback completed
PRIORITY=5
SYSLOG_IDENTIFIER=newme-production-rollback
NEWME_ACTOR=${SUDO_USER:-$(id -un)}
NEWME_REASON=$reason
NEWME_CURRENT=$(readlink -f /opt/newme/current)
NEWME_ROLLBACK=$(readlink -f /opt/newme/current.rollback)
NEWME_DB_PHASE=$PENDING_DB_PHASE
EOF
    printf 'current=%s\nrollback=%s\nhealth_http=%s\nauth_http=%s\ndb_phase=%s\n' \
      "$(readlink -f /opt/newme/current)" \
      "$(readlink -f /opt/newme/current.rollback)" \
      "$health" "$auth" "$PENDING_DB_PHASE"
    ;;
  *)
    echo "usage: newme-production-rollback <status|execute> [reason]" >&2
    exit 64
    ;;
esac
