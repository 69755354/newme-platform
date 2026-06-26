#!/usr/bin/env bash
# check-smoke.sh — Smoke test: hit core routes and check for runtime errors
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
BASE="${1:-http://localhost:3001}"
FAILED=0

echo -e "${YELLOW}=== Smoke Test: $BASE ===${NC}"

smoke() {
  local path="$1"
  local url="${BASE}${path}"
  local status body
  
  body=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null) && status="$body" || status="000"
  
  # Fetch body separately for content check
  body=$(curl -sS --max-time 10 "$url" 2>/dev/null || echo "")
  
  local fail_reason=""
  
  if [[ "$status" == "000" || "$status" =~ ^5 ]]; then
    fail_reason="HTTP $status"
  elif echo "$body" | grep -qiE "ChunkLoadError|manifest.*does not exist|Something went wrong|Application error|Internal Server Error|TypeError|ReferenceError|Cannot find module|ENOENT"; then
    fail_reason="error in response body"
  fi
  
  if [[ -n "$fail_reason" ]]; then
    echo -e "${RED}✗ $path — $fail_reason${NC}"
    FAILED=$((FAILED + 1))
  else
    echo -e "${GREEN}✓ $path — HTTP $status${NC}"
  fi
}

smoke "/login"
smoke "/dashboard"
smoke "/workbench"
smoke "/leads"
smoke "/pipeline"
smoke "/analytics"
smoke "/ads"

echo ""
if [[ $FAILED -gt 0 ]]; then
  echo -e "${RED}✗ Smoke test FAILED ($FAILED routes)${NC}"
  exit 1
else
  echo -e "${GREEN}✓ All routes pass smoke test${NC}"
fi
