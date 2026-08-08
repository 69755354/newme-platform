#!/usr/bin/env bash
# Production dependency and release-integrity probe. It performs only bounded
# reads and never creates users or business data.
set -u -o pipefail

EXPECTED_SUPABASE_URL=https://vfopmpxlhwzpxqegayew.supabase.co
RELEASE_ENV="${NEWME_RELEASE_ENV:-/opt/newme/current/.env.local}"
CURRENT_LINK="${NEWME_CURRENT_LINK:-/opt/newme/current}"
ALERT_SCRIPT="${HERMES_ALERT_STATE_SCRIPT:-/opt/hermes-scripts/observability/hermes-alert-state-v1.sh}"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
ALERTS=""
CURL_CONFIG=""

cleanup() {
  [ -z "$CURL_CONFIG" ] || rm -f -- "$CURL_CONFIG"
}
trap cleanup EXIT INT TERM

add_alert() {
  ALERTS="${ALERTS}[$1] $2\n"
}

read_release_value() {
  local key="$1"
  [ -r "$RELEASE_ENV" ] || return 1
  awk -F= -v wanted="$key" '
    $1 == wanted { value = substr($0, index($0, "=") + 1) }
    END { if (value != "") print value }
  ' "$RELEASE_ENV" | tr -d '\r' | sed 's/^"//; s/"$//'
}

record_alert() {
  local event="$1" summary="$2" transition="" status=0
  transition="$(bash "$ALERT_SCRIPT" dependency-probe "$event" "$summary" 2>&1)" || status=$?
  printf '%s\n' "$transition"
  if printf '%s' "$transition" | grep -q 'capture=1'; then
    /opt/hermes-scripts/observability/incident-capture.sh dependency-probe "$summary" &
  fi
  [ "$status" -eq 0 ] || echo "[$TIMESTAMP] ALERT_STATE_FAILED: retry pending" >&2
  return "$status"
}

if ! systemctl is-active --quiet newme-platform.service 2>/dev/null; then
  add_alert SERVICE_INACTIVE "newme-platform.service is not active"
fi

RELEASE_PATH="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
if ! python3 - "$RELEASE_PATH" <<'PY'
import json
import pathlib
import re
import sys

release = pathlib.Path(sys.argv[1])
if not re.fullmatch(r"/opt/newme/releases/[0-9a-f]{40}", str(release)):
    raise SystemExit(1)
sha = release.name
manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
build_id = (release / ".next" / "BUILD_ID").read_text(encoding="utf-8").strip()
if manifest.get("git_sha") != sha or manifest.get("build_id") != build_id or not build_id:
    raise SystemExit(1)
PY
then
  add_alert RELEASE_INTEGRITY "current immutable release metadata is invalid"
fi

SUPABASE_URL="$(read_release_value NEXT_PUBLIC_SUPABASE_URL || true)"
ANON_KEY="$(read_release_value NEXT_PUBLIC_SUPABASE_ANON_KEY || true)"
SERVICE_KEY="$(read_release_value SUPABASE_SERVICE_ROLE_KEY || true)"

if [ "$SUPABASE_URL" != "$EXPECTED_SUPABASE_URL" ]; then
  add_alert SUPABASE_PROJECT "production project URL is missing or unexpected"
fi
for key_name in ANON_KEY SERVICE_KEY; do
  key_value="${!key_name:-}"
  if ! [[ "$key_value" =~ ^[A-Za-z0-9._-]{20,2048}$ ]]; then
    add_alert SUPABASE_KEY "${key_name} is missing or malformed"
  fi
done
if [ -n "$ANON_KEY" ] && [ "$ANON_KEY" = "$SERVICE_KEY" ]; then
  add_alert SUPABASE_KEY "publishable and service credentials are identical"
fi

probe_rest_key() {
  local label="$1" key="$2" http_code="" curl_status=0
  if ! CURL_CONFIG="$(mktemp "${TMPDIR:-/tmp}/newme-dependency-curl.XXXXXX")"; then
    add_alert SUPABASE_DEPENDENCY "${label} probe could not create a protected curl config"
    return 1
  fi
  chmod 600 "$CURL_CONFIG"
  printf 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\n' "$key" "$key" > "$CURL_CONFIG"
  http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    --config "$CURL_CONFIG" \
    "${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1" 2>/dev/null)" || curl_status=$?
  rm -f -- "$CURL_CONFIG"
  CURL_CONFIG=""
  if [ "$curl_status" -ne 0 ] || [ "$http_code" != 200 ]; then
    add_alert SUPABASE_DEPENDENCY "${label} read returned HTTP ${http_code:-000}"
    return 1
  fi
}

if [ "$SUPABASE_URL" = "$EXPECTED_SUPABASE_URL" ]; then
  [[ "$ANON_KEY" =~ ^[A-Za-z0-9._-]{20,2048}$ ]] && probe_rest_key publishable "$ANON_KEY"
  [[ "$SERVICE_KEY" =~ ^[A-Za-z0-9._-]{20,2048}$ ]] && probe_rest_key service "$SERVICE_KEY"
fi

probe_status=0
[ -z "$ALERTS" ] || probe_status=1

alert_status=0
if [ "$probe_status" -eq 0 ]; then
  record_alert recovery "dependency probe recovered" || alert_status=$?
  echo "[$TIMESTAMP] dependency boundary OK (release, service, publishable key, service key)"
else
  summary="$(printf '%b' "$ALERTS" | sed -n '1p')"
  printf '[$TIMESTAMP] dependency probe ALERTS:\n%b' "$ALERTS"
  record_alert failure "$summary" || alert_status=$?
fi

[ "$alert_status" -eq 0 ] || exit "$alert_status"
exit "$probe_status"
