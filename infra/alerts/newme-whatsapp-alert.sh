#!/bin/sh
# NewMe operational alert sender: WhatsApp Business Cloud API template messages (S17, B-3).
#
#   newme-whatsapp-alert.sh <key> <failure|recovery|info> <one-line summary>
#
# Same call contract as the old alert state machine (key, event, summary), so backup, freshness,
# watchdog, cron and probe scripts can call it unchanged.
#   failure   sent at once, then repeated at most every ALERT_REPEAT_HOURS while the key stays open
#   recovery  sent only if a failure for the same key was delivered before, then closes the key
#   info      always sent, no state (daily "still alive" notes)
#
# Config: /etc/newme/alerts.env (ALERT_ENV_FILE), owned by the running user, mode 600 or 400.
# Values already in the environment win over the file. Nothing secret lives in this repository.
#   ALERT_WHATSAPP_ACCESS_TOKEN     permanent system-user token of the WhatsApp Business account
#   ALERT_WHATSAPP_PHONE_NUMBER_ID  phone_number_id of the company's existing WhatsApp Business number
#   ALERT_WHATSAPP_RECIPIENTS       comma separated numbers, international format (Sam, Tanya)
#   ALERT_WHATSAPP_TEMPLATE         approved template name, default newme_ops_alert
#   ALERT_WHATSAPP_LANGUAGE         template language code, default zh_CN
#   ALERT_WHATSAPP_API_VERSION      Graph API version, default v26.0 (same as the review tools)
#   ALERT_STATE_DIR                 default /var/lib/newme-alerts (state files and alerts.log)
#   ALERT_REPEAT_HOURS              default 6
#   ALERT_CHANNEL                   whatsapp (default: WhatsApp first, Telegram as fallback) or telegram (Telegram only)
#   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional explicit Telegram bot; when unset, the bot of the release gate's
#                                   alert provider is used (ALERT_TELEGRAM_PROVIDER_CONFIG, default
#                                   /etc/newme/postdeploy-alert-provider-v1.json, keys bot_token and chat_id; the file
#                                   must be a regular file owned by the running user, mode 400 or 600)
#
# Fallback (audit 2026-11-20 F1): with the default channel, WhatsApp is tried first. If WhatsApp is not configured, or
# any recipient is not delivered, the same alert is sent through Telegram. The call fails only when no channel
# delivered it.
#
# Exit status: 0 delivered by at least one channel (or nothing to send), 1 no channel delivered it, 2 usage error or
# no channel is configured at all.
# Delivery is judged by the HTTP status AND the message id in the answer; every attempt leaves one
# line in $ALERT_STATE_DIR/alerts.log and a failure also goes to stderr (the systemd journal), even when the
# fallback then delivers.
set -u
umask 077

KEY="${1:-}"
EVENT="${2:-}"
SUMMARY="${3:-}"

ENV_FILE="${ALERT_ENV_FILE:-/etc/newme/alerts.env}"
if [ -e "$ENV_FILE" ]; then
  if command -v stat >/dev/null 2>&1; then
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "")"
    case "$mode" in
      400|600) ;;
      *) echo "newme-whatsapp-alert: $ENV_FILE must be mode 400 or 600 (is ${mode:-unknown})" >&2; exit 2 ;;
    esac
    if [ "$(stat -c '%u' "$ENV_FILE" 2>/dev/null || echo x)" != "$(id -u)" ]; then
      echo "newme-whatsapp-alert: $ENV_FILE must be owned by the running user" >&2; exit 2
    fi
  fi
  # Environment values already set win over the file.
  while IFS='=' read -r name value; do
    case "$name" in
      ALERT_WHATSAPP_ACCESS_TOKEN|ALERT_WHATSAPP_PHONE_NUMBER_ID|ALERT_WHATSAPP_RECIPIENTS|ALERT_WHATSAPP_TEMPLATE|ALERT_WHATSAPP_LANGUAGE|ALERT_WHATSAPP_API_VERSION|ALERT_STATE_DIR|ALERT_REPEAT_HOURS|ALERT_CHANNEL|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|ALERT_TELEGRAM_PROVIDER_CONFIG)
        eval "current=\${$name:-}"
        if [ -z "$current" ]; then
          value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
          export "$name=$value"
        fi
        ;;
    esac
  done < "$ENV_FILE"
fi

CHANNEL="${ALERT_CHANNEL:-whatsapp}"
STATE_DIR="${ALERT_STATE_DIR:-/var/lib/newme-alerts}"
REPEAT_HOURS="${ALERT_REPEAT_HOURS:-6}"
API_VERSION="${ALERT_WHATSAPP_API_VERSION:-v26.0}"
TEMPLATE="${ALERT_WHATSAPP_TEMPLATE:-newme_ops_alert}"
LANGUAGE="${ALERT_WHATSAPP_LANGUAGE:-zh_CN}"
NOW="${ALERT_NOW:-$(date +%s)}"

fail_usage() { echo "newme-whatsapp-alert: $1" >&2; exit 2; }

case "$EVENT" in failure|recovery|info) ;; *) fail_usage "event must be failure, recovery or info" ;; esac
case "$KEY" in ''|*[!A-Za-z0-9_.-]*) fail_usage "key must be 1-100 characters of letters, digits, dot, dash, underscore" ;; esac
[ "${#KEY}" -le 100 ] || fail_usage "key is too long"
case "$REPEAT_HOURS" in ''|*[!0-9]*) fail_usage "ALERT_REPEAT_HOURS must be a number" ;; esac
case "$CHANNEL" in whatsapp|telegram) ;; *) fail_usage "ALERT_CHANNEL must be whatsapp or telegram" ;; esac

api_base_ok() {
  case "$1" in
    https://*) return 0 ;;
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) return 0 ;;
    *) return 1 ;;
  esac
}

# Each channel's configuration is checked by a function that records the first problem instead of exiting, so a
# broken WhatsApp configuration still lets the Telegram fallback deliver.
WA_READY=0
WA_PROBLEM=""
TG_READY=0
TG_LOADED=0
TG_PROBLEM=""
TG_TOKEN=""
TG_CHAT=""

wa_bad() { WA_PROBLEM="$1"; return 1; }
whatsapp_config() {
  WA_API_BASE="${ALERT_WHATSAPP_API_BASE:-https://graph.facebook.com}"
  api_base_ok "$WA_API_BASE" || { wa_bad "ALERT_WHATSAPP_API_BASE must be https"; return 1; }
  [ -n "${ALERT_WHATSAPP_ACCESS_TOKEN:-}" ] || { wa_bad "ALERT_WHATSAPP_ACCESS_TOKEN is not set"; return 1; }
  [ -n "${ALERT_WHATSAPP_PHONE_NUMBER_ID:-}" ] || { wa_bad "ALERT_WHATSAPP_PHONE_NUMBER_ID is not set"; return 1; }
  case "$ALERT_WHATSAPP_PHONE_NUMBER_ID" in *[!0-9]*) wa_bad "ALERT_WHATSAPP_PHONE_NUMBER_ID must be digits"; return 1 ;; esac
  case "$ALERT_WHATSAPP_ACCESS_TOKEN" in *[!A-Za-z0-9_.~+/=-]*) wa_bad "ALERT_WHATSAPP_ACCESS_TOKEN has unexpected characters"; return 1 ;; esac
  [ -n "${ALERT_WHATSAPP_RECIPIENTS:-}" ] || { wa_bad "ALERT_WHATSAPP_RECIPIENTS is not set"; return 1; }
  case "$TEMPLATE" in ''|*[!a-z0-9_]*) wa_bad "ALERT_WHATSAPP_TEMPLATE must be lowercase letters, digits, underscore"; return 1 ;; esac
  case "$LANGUAGE" in ''|*[!A-Za-z_]*) wa_bad "ALERT_WHATSAPP_LANGUAGE is invalid"; return 1 ;; esac
  case "$API_VERSION" in v[0-9]*) ;; *) wa_bad "ALERT_WHATSAPP_API_VERSION is invalid"; return 1 ;; esac
  RECIPIENTS=""
  for raw in $(printf '%s' "$ALERT_WHATSAPP_RECIPIENTS" | tr ',;' '  '); do
    number="$(printf '%s' "$raw" | sed 's/^+//')"
    case "$number" in
      ''|*[!0-9]*) wa_bad "ALERT_WHATSAPP_RECIPIENTS has an entry that is not an international number"; return 1 ;;
    esac
    if [ "${#number}" -lt 7 ] || [ "${#number}" -gt 15 ]; then wa_bad "ALERT_WHATSAPP_RECIPIENTS has an entry with a wrong length"; return 1; fi
    RECIPIENTS="$RECIPIENTS $number"
  done
  [ -n "$RECIPIENTS" ] || { wa_bad "ALERT_WHATSAPP_RECIPIENTS is empty"; return 1; }
  return 0
}

tg_bad() { TG_PROBLEM="$1"; return 1; }
# Reads bot_token and chat_id from the provider file without ever printing them outside this process: python
# writes them to its stdout, which is captured into shell variables, never logged and never put in an argument.
read_provider_config() {
  python3 -I - "$1" <<'PY'
import json, os, re, stat, sys
path = sys.argv[1]
try:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
except OSError:
    sys.exit(3)
with os.fdopen(fd, "rb") as handle:
    meta = os.fstat(handle.fileno())
    if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or stat.S_IMODE(meta.st_mode) not in (0o400, 0o600) or meta.st_size > 65536:
        sys.exit(4)
    try:
        config = json.loads(handle.read().decode("utf-8"))
    except Exception:
        sys.exit(5)
if not isinstance(config, dict):
    sys.exit(5)
token, chat = config.get("bot_token"), str(config.get("chat_id", ""))
if config.get("provider_version") != "newme-alert-provider-telegram/v1" or not isinstance(token, str) \
        or not re.fullmatch(r"\d{6,16}:[A-Za-z0-9_-]{20,128}", token) or not re.fullmatch(r"-?[1-9]\d{4,20}", chat):
    sys.exit(6)
sys.stdout.write(token + "\n" + chat + "\n")
PY
}
telegram_config() {
  TG_LOADED=1
  TG_API_BASE="${ALERT_TELEGRAM_API_BASE:-https://api.telegram.org}"
  api_base_ok "$TG_API_BASE" || { tg_bad "ALERT_TELEGRAM_API_BASE must be https"; return 1; }
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then tg_bad "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set"; return 1; fi
    TG_TOKEN="$TELEGRAM_BOT_TOKEN"; TG_CHAT="$TELEGRAM_CHAT_ID"
  else
    provider="${ALERT_TELEGRAM_PROVIDER_CONFIG:-/etc/newme/postdeploy-alert-provider-v1.json}"
    [ -e "$provider" ] || { tg_bad "telegram is not configured (no TELEGRAM_BOT_TOKEN and no $provider)"; return 1; }
    command -v python3 >/dev/null 2>&1 || { tg_bad "python3 is needed to read $provider"; return 1; }
    pair="$(read_provider_config "$provider")"
    rc=$?
    case "$rc" in
      0) ;;
      4) tg_bad "$provider must be a regular file owned by the running user, mode 400 or 600"; return 1 ;;
      *) tg_bad "$provider is unreadable or invalid (check $rc)"; return 1 ;;
    esac
    TG_TOKEN="$(printf '%s\n' "$pair" | sed -n 1p)"
    TG_CHAT="$(printf '%s\n' "$pair" | sed -n 2p)"
    pair=""
  fi
  case "$TG_TOKEN" in ''|*[!A-Za-z0-9_:.-]*) tg_bad "the Telegram bot token has unexpected characters"; return 1 ;; esac
  case "$TG_CHAT" in ''|*[!0-9-]*) tg_bad "the Telegram chat id is invalid"; return 1 ;; esac
  TG_READY=1
  return 0
}

if [ "$CHANNEL" = whatsapp ]; then
  if whatsapp_config; then WA_READY=1; fi
fi
if [ "$CHANNEL" = telegram ] || [ "$WA_READY" = 0 ]; then
  telegram_config || true
  if [ "$TG_READY" = 0 ]; then
    if [ "$CHANNEL" = telegram ]; then fail_usage "$TG_PROBLEM"; fi
    fail_usage "$WA_PROBLEM; Telegram fallback unavailable: $TG_PROBLEM"
  fi
  if [ "$CHANNEL" = whatsapp ]; then echo "newme-whatsapp-alert: WhatsApp is not usable ($WA_PROBLEM); using the Telegram fallback" >&2; fi
fi

# State directory: the configured one, then fallbacks (default /run/newme-alerts, then /tmp). The
# state is what stops a watchdog that runs every minute from sending every minute, so an unwritable
# primary directory must not silently turn suppression off.
FALLBACK_DIRS="${ALERT_FALLBACK_DIRS:-/run/newme-alerts /tmp/newme-alerts-$(id -u)}"
STATE_OK=0
FIRST=1
for candidate in "$STATE_DIR" $FALLBACK_DIRS; do
  if mkdir -p "$candidate" 2>/dev/null && : > "$candidate/.probe.$$" 2>/dev/null; then
    rm -f "$candidate/.probe.$$"
    chmod 700 "$candidate" 2>/dev/null || true
    if [ "$FIRST" != 1 ]; then echo "newme-whatsapp-alert: $STATE_DIR is not writable; using fallback state directory $candidate" >&2; fi
    STATE_DIR="$candidate"
    STATE_OK=1
    break
  fi
  FIRST=0
done
if [ "$STATE_OK" = 0 ]; then
  echo "newme-whatsapp-alert: no writable state directory (tried $STATE_DIR and fallbacks); repeat suppression and the local log are off, this alert is sent once and the call exits 1" >&2
fi
LOG_FILE="$STATE_DIR/alerts.log"
STATE_FILE="$STATE_DIR/$KEY.state"

log_line() {
  [ "$STATE_OK" = 1 ] || return 0
  printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$KEY" "$EVENT" "$1" >> "$LOG_FILE" 2>/dev/null || true
}

# State: a failure that was delivered leaves "alerted_at=<epoch>".
alerted_at=""
if [ "$STATE_OK" = 1 ] && [ -r "$STATE_FILE" ]; then
  alerted_at="$(sed -n 's/^alerted_at=\([0-9]*\)$/\1/p' "$STATE_FILE" | head -n 1)"
fi
case "$EVENT" in
  failure)
    if [ -n "$alerted_at" ] && [ $((NOW - alerted_at)) -lt $((REPEAT_HOURS * 3600)) ]; then
      log_line "suppressed (alert already open, repeat every ${REPEAT_HOURS}h)"
      exit 0
    fi
    LABEL="故障" ;;
  recovery)
    if [ -z "$alerted_at" ]; then exit 0; fi
    LABEL="恢复" ;;
  info) LABEL="通知" ;;
esac

# One line, no tabs, no runs of spaces (WhatsApp template parameters reject them), at most 400 characters
# (not bytes: a Chinese character is 3 bytes and must never be cut in half). GNU sed in a UTF-8 locale counts
# characters; iconv -c then drops any incomplete trailing sequence a byte-oriented sed (busybox) may leave. Without
# iconv the text is reduced to ASCII, which is always valid JSON.
clean_text() {
  base="$(printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037' | sed 's/  */ /g; s/^ //; s/ $//' | head -c 1700)"
  if command -v iconv >/dev/null 2>&1; then
    # drop the half character head -c may have left, then cut by characters (GNU sed refuses to match on invalid input)
    printf '%s' "$base" | iconv -c -f UTF-8 -t UTF-8 2>/dev/null | LC_ALL=C.UTF-8 sed 's/^\(.\{1,400\}\).*$/\1/' | iconv -c -f UTF-8 -t UTF-8 2>/dev/null
  else
    printf '%s' "$base" | LC_ALL=C tr -cd '\40-\176' | cut -c1-400
  fi
}
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

TEXT="$(clean_text "$SUMMARY")"
[ -n "$TEXT" ] || TEXT="-"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/newme-alert.XXXXXX")" || { echo "newme-whatsapp-alert: cannot create a work directory" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT INT TERM HUP

mask() { n="$1"; printf '***%s' "$(printf '%s' "$n" | tail -c 4)"; }

WA_FAILED=0
DELIVERED=0
report_failure() {
  # $1 = what failed (no secrets)
  log_line "FAILED $1"
  echo "newme-whatsapp-alert: $KEY $EVENT delivery FAILED: $1" >&2
}

error_detail() {
  code="$(sed -n 's/.*"code":\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -n 1)"
  msg="$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1 | cut -c1-120)"
  printf '%s%s' "${code:+code $code }" "$msg"
}

send_whatsapp() {
  for number in $RECIPIENTS; do
    label_json="$(json_escape "$LABEL")"; key_json="$(json_escape "$KEY")"; text_json="$(json_escape "$TEXT")"
    cat > "$WORK/body.json" <<JSON
{"messaging_product":"whatsapp","to":"$number","type":"template","template":{"name":"$TEMPLATE","language":{"code":"$LANGUAGE"},"components":[{"type":"body","parameters":[{"type":"text","text":"$label_json"},{"type":"text","text":"$key_json"},{"type":"text","text":"$text_json"}]}]}}
JSON
    # The token travels in a curl config on stdin, never in the argument list.
    printf 'url = "%s/%s/%s/messages"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' \
      "$WA_API_BASE" "$API_VERSION" "$ALERT_WHATSAPP_PHONE_NUMBER_ID" "$ALERT_WHATSAPP_ACCESS_TOKEN" > "$WORK/curl.conf"
    http_code="$(curl -sS -m 20 -K "$WORK/curl.conf" -o "$WORK/resp.json" -w '%{http_code}' --data-binary "@$WORK/body.json" 2>"$WORK/curl.err")" || http_code="000"
    case "$http_code" in
      2??)
        if grep -q '"messages"' "$WORK/resp.json" 2>/dev/null && grep -q '"id"' "$WORK/resp.json" 2>/dev/null; then
          log_line "delivered to $(mask "$number") HTTP $http_code"
        else
          WA_FAILED=1; report_failure "HTTP $http_code without a message id for $(mask "$number")"
        fi ;;
      000) WA_FAILED=1; report_failure "no HTTP answer for $(mask "$number"): $(head -c 120 "$WORK/curl.err" | tr '\n' ' ')" ;;
      *) WA_FAILED=1; report_failure "HTTP $http_code for $(mask "$number") $(error_detail "$WORK/resp.json")" ;;
    esac
  done
  rm -f "$WORK/curl.conf"
}

send_telegram() {
  # $1 = "fallback" when WhatsApp did not deliver, so the reader knows that channel is broken.
  MESSAGE="[$LABEL] $KEY: $TEXT"
  [ "${1:-}" = fallback ] && MESSAGE="$MESSAGE (WhatsApp 未送达，本条走 Telegram 备用通道)"
  printf 'url = "%s/bot%s/sendMessage"\n' "$TG_API_BASE" "$TG_TOKEN" > "$WORK/curl.conf"
  http_code="$(curl -sS -m 20 -K "$WORK/curl.conf" -o "$WORK/resp.json" -w '%{http_code}' \
    --data-urlencode "chat_id=$TG_CHAT" --data-urlencode "text=$MESSAGE" 2>"$WORK/curl.err")" || http_code="000"
  rm -f "$WORK/curl.conf"
  if [ "$http_code" = 200 ] && grep -q '"ok":true' "$WORK/resp.json" 2>/dev/null; then
    log_line "delivered via telegram${1:+ ($1)} HTTP $http_code"
    DELIVERED=1
  else
    report_failure "telegram${1:+ ($1)} HTTP $http_code $(error_detail "$WORK/resp.json")"
  fi
}

if [ "$CHANNEL" = telegram ]; then
  send_telegram ""
else
  if [ "$WA_READY" = 1 ]; then
    send_whatsapp
    [ "$WA_FAILED" = 0 ] && DELIVERED=1
  else
    report_failure "whatsapp not configured: $WA_PROBLEM"
  fi
  if [ "$DELIVERED" = 0 ]; then
    [ "$TG_LOADED" = 1 ] || telegram_config || true
    if [ "$TG_READY" = 1 ]; then
      send_telegram fallback
    else
      report_failure "no Telegram fallback: $TG_PROBLEM"
    fi
  fi
fi

if [ "$DELIVERED" = 0 ]; then exit 1; fi
if [ "$STATE_OK" = 0 ]; then
  [ "$EVENT" = failure ] && exit 1
  exit 0
fi

if [ "$STATE_OK" = 1 ]; then
  case "$EVENT" in
    failure) printf 'alerted_at=%s\n' "$NOW" > "$STATE_FILE" || { echo "newme-whatsapp-alert: could not write $STATE_FILE; repeats will not be suppressed" >&2; exit 1; } ;;
    recovery) rm -f "$STATE_FILE" ;;
  esac
fi
exit 0
