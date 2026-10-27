#!/usr/bin/env bash
# hermes-alert-notifier-v1.sh — strict adapter for the versioned production provider.
# Contract: <alert|recovery> <source> <detail>. Postdeploy context is inherited
# only from the versioned state machine; a direct five-argument path is refused.
set -euo pipefail

EVENT="${1:?event is required}"
SOURCE="${2:?source is required}"
DETAIL="${3:-}"
LEVEL="${HERMES_ALERT_LEVEL:-critical}"
PROVIDER="/opt/hermes-scripts/observability/newme-alert-provider-v1.mjs"
DRILL_MODE="${NEWME_ALERT_DRILL_MODE:-}"
DRILL_RELEASE_SHA="${NEWME_ALERT_DRILL_RELEASE_SHA:-}"
DRILL_TRIGGER_SHA256="${NEWME_ALERT_DRILL_TRIGGER_SHA256:-}"

case "$EVENT" in
  alert|recovery) ;;
  *) echo "hermes-alert-notifier-v1: invalid event" >&2; exit 2 ;;
esac
[ "$#" -eq 3 ] || exit 2
[[ "$SOURCE" =~ ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$ ]] || exit 2
[[ "$LEVEL" =~ ^(critical|warning|info)$ ]] || exit 2
[[ "$DETAIL" != *$'\n'* && "$DETAIL" != *$'\r'* ]] || exit 2
[ -x "$PROVIDER" ] && [ ! -L "$PROVIDER" ] || exit 1
if [ -n "$DRILL_MODE$DRILL_RELEASE_SHA$DRILL_TRIGGER_SHA256" ]; then
  case "$EVENT:$DRILL_MODE" in alert:failure|recovery:recovery) ;; *) exit 2 ;; esac
  [[ "$DRILL_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 2
  [[ "$DRILL_TRIGGER_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 2
  [ "$SOURCE" = "postdeploy-acceptance-$DRILL_RELEASE_SHA" ] || exit 2
  [ "$DETAIL" = "canonical postdeploy $DRILL_MODE; receipt_challenge=$DRILL_TRIGGER_SHA256" ] || exit 2
  PROVIDER_RESULT="$({ "$PROVIDER" "$DRILL_MODE" "$DRILL_RELEASE_SHA"; } 2>&1)" || exit 1
  [[ "$PROVIDER_RESULT" != *$'\n'* ]] || exit 1
  IFS=' ' read -r ACK_VERSION ACK_KIND ACK_EVENT ACK_RELEASE ACK_TRIGGER ACK_DELIVERY ACK_EXTRA <<< "$PROVIDER_RESULT"
  [ "$ACK_VERSION" = newme-alert-provider-v1 ] && [ "$ACK_KIND" = receipt ] &&
    [ "$ACK_EVENT" = "$DRILL_MODE" ] && [ "$ACK_RELEASE" = "$DRILL_RELEASE_SHA" ] &&
    [ "$ACK_TRIGGER" = "$DRILL_TRIGGER_SHA256" ] && [ -z "${ACK_EXTRA:-}" ] &&
    [[ "$ACK_DELIVERY" =~ ^telegram:message:[1-9][0-9]*$ ]] || exit 1
  exit 0
fi
PROVIDER_RESULT="$({ "$PROVIDER" notify "$EVENT" "$SOURCE" "$DETAIL" "$LEVEL"; } 2>&1)" || exit 1
[[ "$PROVIDER_RESULT" != *$'\n'* ]] || exit 1
IFS=' ' read -r ACK_VERSION ACK_KIND ACK_EVENT ACK_SOURCE ACK_DELIVERY ACK_EXTRA <<< "$PROVIDER_RESULT"
[ "$ACK_VERSION" = newme-alert-provider-v1 ] && [ "$ACK_KIND" = notify ] &&
  [ "$ACK_EVENT" = "$EVENT" ] && [ "$ACK_SOURCE" = "$SOURCE" ] && [ -z "${ACK_EXTRA:-}" ] &&
  [[ "$ACK_DELIVERY" =~ ^telegram:message:[1-9][0-9]*$ ]] || exit 1
