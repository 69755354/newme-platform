#!/usr/bin/env bash
# check-logs.sh — Scan journald for runtime errors that build can't catch
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' NC='\033[0m'
SINCE="${1:-5 minutes ago}"

echo -e "${YELLOW}=== Journald Error Scan (since: $SINCE) ===${NC}"

# Patterns that indicate real production errors
PATTERNS=(
  "Error"
  "Unhandled"
  "ChunkLoadError"
  "manifest.*does not exist"
  "relation.*does not exist"
  "audit_log"
  "TypeError"
  "ReferenceError"
  "500"
  "Internal Server Error"
  "Cannot find module"
  "ENOENT"
)

# Build grep pattern
PATTERN=$(IFS='|'; echo "${PATTERNS[*]}")

# Scan for the newme-platform service (stdout/stderr from systemd unit)
LOG_LINES=$(journalctl _SYSTEMD_UNIT=newme-platform.service --since "$SINCE" --no-pager 2>/dev/null | grep -iE "$PATTERN" || true)

if [[ -z "$LOG_LINES" ]]; then
  echo -e "${GREEN}✓ No suspicious errors in journald${NC}"
  exit 0
fi

# Filter out known false positives
FILTERED=$(echo "$LOG_LINES" | grep -vE \
  -e 'Warning:.*useSearchParams' \
  -e 'Sentry.*error' \
  -e '/api/monitoring/report' \
  -e 'monitoring/report' \
  -e 'reported.*error' \
  || true)

if [[ -z "$FILTERED" ]]; then
  echo -e "${GREEN}✓ No suspicious errors (false positives filtered)${NC}"
  exit 0
fi

# Count and report
COUNT=$(echo "$FILTERED" | wc -l)
echo -e "${RED}✗ Found $COUNT potential error(s):${NC}"
echo "$FILTERED" | head -20
echo ""
echo -e "${RED}✗ Journald scan FAILED${NC}"
exit 1
