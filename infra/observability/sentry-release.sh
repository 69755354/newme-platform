#!/bin/bash
# sentry-release.sh — Sentry Release Tracking
# 在 deploy.sh 构建成功后调用: bash /opt/hermes-scripts/observability/sentry-release.sh $BUILD_ID
# 需要: SENTRY_AUTH_TOKEN (当前未设置，需要从 COS 或 CI 注入)

set -euo pipefail

BUILD_ID="${1:-$(date +%Y%m%d-%H%M%S)}"
SENTRY_ORG="${SENTRY_ORG:-newme-o4}"
SENTRY_PROJECT="${SENTRY_PROJECT:-javascript-nextjs}"
SENTRY_AUTH_TOKEN="${SENTRY_AUTH_TOKEN:-}"

if [ -z "$SENTRY_AUTH_TOKEN" ]; then
  echo "[sentry-release] ⚠️ SENTRY_AUTH_TOKEN 未设置 — 跳过 Release Tracking"
  echo "[sentry-release] 设置方法: coscmd download _cattle/hermes-config/credentials/sentry.json /tmp/sentry.json"
  exit 0
fi

echo "[sentry-release] 创建 Release: $BUILD_ID"

# 创建 release
curl -s -X POST "https://sentry.io/api/0/organizations/${SENTRY_ORG}/releases/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"version\":\"${BUILD_ID}\",\"projects\":[\"${SENTRY_PROJECT}\"]}" \
  -o /dev/null -w "  HTTP %{http_code}\n"

# 关联 commits
cd /home/ubuntu/newme-platform
curl -s -X POST "https://sentry.io/api/0/organizations/${SENTRY_ORG}/releases/${BUILD_ID}/deploys/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"environment\":\"production\"}" \
  -o /dev/null -w "  Deploy HTTP %{http_code}\n"

echo "[sentry-release] ✅ Release ${BUILD_ID} → ${SENTRY_ORG}/${SENTRY_PROJECT}"
