#!/bin/bash
# day-end-health-check.sh — Master health check aggregating all audit scripts
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' BOLD='\033[1m' NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=""

echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║   Day-End Health Check — $(date '+%Y-%m-%d %H:%M:%S')   ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Section 1: Client Supabase Audit ──
echo -e "${BOLD}[1/6] Client Supabase Residual Audit${NC}"
echo "────────────────────────────────────────"
if [[ -x "$SCRIPT_DIR/audit-client-supabase.sh" ]]; then
  if "$SCRIPT_DIR/audit-client-supabase.sh"; then
    echo -e "${GREEN}PASS${NC}"
    RESULTS="${RESULTS}  ${GREEN}✓${NC} Client Supabase Audit: PASS\n"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}FAIL${NC}"
    RESULTS="${RESULTS}  ${RED}✗${NC} Client Supabase Audit: FAIL\n"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo -e "${RED}SKIP — audit-client-supabase.sh not found or not executable${NC}"
  RESULTS="${RESULTS}  ${YELLOW}⊘${NC} Client Supabase Audit: SKIP\n"
fi
echo ""

# ── Section 2: Service Role Audit ──
echo -e "${BOLD}[2/6] Service Role Exposure Audit${NC}"
echo "────────────────────────────────────────"
if [[ -x "$SCRIPT_DIR/audit-service-role.sh" ]]; then
  if "$SCRIPT_DIR/audit-service-role.sh"; then
    echo -e "${GREEN}PASS${NC}"
    RESULTS="${RESULTS}  ${GREEN}✓${NC} Service Role Audit: PASS\n"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}FAIL${NC}"
    RESULTS="${RESULTS}  ${RED}✗${NC} Service Role Audit: FAIL\n"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo -e "${RED}SKIP — audit-service-role.sh not found or not executable${NC}"
  RESULTS="${RESULTS}  ${YELLOW}⊘${NC} Service Role Audit: SKIP\n"
fi
echo ""

# ── Section 3: BUILD_ID Check ──
echo -e "${BOLD}[3/6] BUILD_ID Consistency Check${NC}"
echo "────────────────────────────────────────"
if [[ -x "$SCRIPT_DIR/check-build-id.sh" ]]; then
  if "$SCRIPT_DIR/check-build-id.sh"; then
    echo -e "${GREEN}PASS${NC}"
    RESULTS="${RESULTS}  ${GREEN}✓${NC} BUILD_ID Check: PASS\n"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}FAIL${NC}"
    RESULTS="${RESULTS}  ${RED}✗${NC} BUILD_ID Check: FAIL\n"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo -e "${RED}SKIP — check-build-id.sh not found or not executable${NC}"
  RESULTS="${RESULTS}  ${YELLOW}⊘${NC} BUILD_ID Check: SKIP\n"
fi
echo ""

# ── Section 4: Smoke Test ──
echo -e "${BOLD}[4/6] Smoke Test${NC}"
echo "────────────────────────────────────────"
if [[ -x "$SCRIPT_DIR/check-smoke.sh" ]]; then
  if "$SCRIPT_DIR/check-smoke.sh"; then
    echo -e "${GREEN}PASS${NC}"
    RESULTS="${RESULTS}  ${GREEN}✓${NC} Smoke Test: PASS\n"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${RED}FAIL${NC}"
    RESULTS="${RESULTS}  ${RED}✗${NC} Smoke Test: FAIL\n"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo -e "${RED}SKIP — check-smoke.sh not found or not executable${NC}"
  RESULTS="${RESULTS}  ${YELLOW}⊘${NC} Smoke Test: SKIP\n"
fi
echo ""

# ── Section 5: Journal Errors ──
echo -e "${BOLD}[5/6] Journal Errors (last 2 hours)${NC}"
echo "────────────────────────────────────────"
JOURNAL_OUTPUT=$(journalctl -u newme-platform --since "2 hours ago" --no-pager 2>/dev/null | grep -iE "error|exception|500|crash" | head -5 || true)
if [[ -z "$JOURNAL_OUTPUT" ]]; then
  echo -e "${GREEN}PASS — No errors in journal${NC}"
  RESULTS="${RESULTS}  ${GREEN}✓${NC} Journal Errors: PASS (0 errors)\n"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo -e "${RED}Journal errors found:${NC}"
  echo "$JOURNAL_OUTPUT"
  RESULTS="${RESULTS}  ${RED}✗${NC} Journal Errors: FAIL (errors found)\n"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
echo ""

# ── Section 6: Disk & Process Health ──
echo -e "${BOLD}[6/6] Disk & Process Health${NC}"
echo "────────────────────────────────────────"
# Check disk usage
DISK_USAGE=$(df -h "$PROJECT_ROOT" | tail -1 | awk '{print $5 " used (" $3 "/" $2 ")"}' 2>/dev/null || echo "unknown")
echo -e "  Disk: $DISK_USAGE"

# Check load average
LOAD_AVG=$(uptime 2>/dev/null | awk -F'load average:' '{print $2}' | xargs || echo "unknown")
echo -e "  Load: $LOAD_AVG"

# Check memory
MEM_INFO=$(free -h 2>/dev/null | grep Mem | awk '{print $3 "/" $2 " (" $3/$2*100 "% used)"}' || echo "unknown")
echo -e "  Memory: $MEM_INFO"

echo -e "${GREEN}  Info collected${NC}"
RESULTS="${RESULTS}  ${GREEN}✓${NC} System Health: INFO\n"
PASS_COUNT=$((PASS_COUNT + 1))
echo ""

# ── Grand Summary ──
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${CYAN}║            HEALTH CHECK SUMMARY          ║${NC}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}"
echo -e "$RESULTS"

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo -e "${BOLD}Results:${NC} ${GREEN}$PASS_COUNT PASS${NC} / ${RED}$FAIL_COUNT FAIL${NC} / $TOTAL TOTAL"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo -e "${RED}${BOLD}✗ HEALTH CHECK FAILED — $FAIL_COUNT section(s) failed${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}✓ ALL CHECKS PASSED${NC}"
  exit 0
fi
