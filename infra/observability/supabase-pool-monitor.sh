#!/bin/bash
# supabase-pool-monitor.sh — Supabase 健康检查
# 路径: /opt/hermes-scripts/observability/supabase-pool-monitor.sh
# crontab: */5 * * * * /bin/bash /opt/hermes-scripts/observability/supabase-pool-monitor.sh
# 依赖: curl

set -euo pipefail

SUPABASE_URL="https://vfopmpxlhwzpxqegayew.supabase.co"
ANON_KEY="sb_publishable_0UiLli4lUNE_pwhZ13bRfw_xH4TduY_"
TIMEOUT=10
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ─── 1. REST API 可达性 ───
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" \
  "${SUPABASE_URL}/rest/v1/" \
  -H "apikey: ${ANON_KEY}" \
  -H "Authorization: Bearer ${ANON_KEY}" 2>/dev/null || echo "000")

case "$HTTP_CODE" in
  000)
    echo "[$TIMESTAMP] 🔔 SUPABASE_UNREACHABLE: $SUPABASE_URL 连接超时"
    /opt/hermes-scripts/observability/incident-capture.sh "supabase-monitor" "Supabase不可达" &
    exit 1
    ;;
  5??)
    echo "[$TIMESTAMP] 🔔 SUPABASE_5XX: 返回 HTTP $HTTP_CODE"
    /opt/hermes-scripts/observability/incident-capture.sh "supabase-monitor" "Supabase返回HTTP ${HTTP_CODE}" &
    exit 1
    ;;
  *)
    echo "[$TIMESTAMP] 💓 Supabase OK (HTTP $HTTP_CODE)"
    exit 0
    ;;
esac
