#!/bin/bash
# check-build-id.sh — Verify BUILD_ID consistency between disk and deployment
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "${CYAN}=== BUILD_ID Consistency Check ===${NC}"
echo ""

# ── 1. Disk BUILD_ID ──
BUILD_ID_FILE="$PROJECT_ROOT/.next/BUILD_ID"
if [[ -f "$BUILD_ID_FILE" ]]; then
  DISK_BUILD_ID=$(cat "$BUILD_ID_FILE" | tr -d '\n')
  echo -e "${CYAN}[1] Disk BUILD_ID:${NC} $DISK_BUILD_ID"
else
  echo -e "${RED}[1] Disk BUILD_ID:${NC} MISSING — no .next/BUILD_ID file"
  exit 1
fi

# ── 2. Online BUILD_ID ──
ONLINE_URL="${ONLINE_URL:-https://app.newme.ae/dashboard}"
echo -e "${CYAN}[2] Fetching online BUILD_ID from:${NC} $ONLINE_URL"

HTML_BODY=$(curl -sS --max-time 15 "$ONLINE_URL" 2>/dev/null || echo "")

if [[ -z "$HTML_BODY" ]]; then
  echo -e "${RED}  ✗ Failed to fetch HTML from $ONLINE_URL${NC}"
  echo -e "${YELLOW}  (Deployment may not be reachable or server is down)${NC}"
  echo ""
  echo -e "${YELLOW}=== Summary ===${NC}"
  echo -e "${YELLOW}? UNKNOWN — Could not check online BUILD_ID${NC}"
  exit 1
fi

# Try multiple patterns to extract buildId
ONLINE_BUILD_ID=""

# Pattern 1: RSC payload \"b\":\"BUILD_ID\" (Next.js 15+)
ONLINE_BUILD_ID=$(echo "$HTML_BODY" | grep -oP '\\\\?"b\\\\?"\s*:\s*\\\\?"\K[^"\\\\]+' 2>/dev/null | head -1 || true)

# Pattern 2: __next_f.push with buildId field
if [[ -z "$ONLINE_BUILD_ID" ]]; then
  ONLINE_BUILD_ID=$(echo "$HTML_BODY" | grep -oP '"buildId"\s*:\s*"\K[^"]+' 2>/dev/null | head -1 || true)
fi

# Pattern 3: In __NEXT_DATA__ JSON
if [[ -z "$ONLINE_BUILD_ID" ]]; then
  ONLINE_BUILD_ID=$(echo "$HTML_BODY" | grep -oP '__NEXT_DATA__\s*=\s*[^;]*"buildId"\s*:\s*"\K[^"]+' 2>/dev/null | head -1 || true)
fi

# Pattern 4: In script src with buildId hash path
if [[ -z "$ONLINE_BUILD_ID" ]]; then
  ONLINE_BUILD_ID=$(echo "$HTML_BODY" | grep -oP '/_next/static/\K[^/]+(?=/)' 2>/dev/null | head -1 || true)
fi

if [[ -z "$ONLINE_BUILD_ID" ]]; then
  echo -e "${RED}  ✗ Could not extract buildId from HTML${NC}"
  echo -e "${YELLOW}  Partial HTML (first 500 chars):${NC}"
  echo "$HTML_BODY" | head -c 500
  echo ""
  echo ""
  echo -e "${YELLOW}=== Summary ===${NC}"
  echo -e "${YELLOW}? UNKNOWN — Could not extract online BUILD_ID${NC}"
  exit 1
fi

echo -e "${CYAN}[2] Online BUILD_ID:${NC} $ONLINE_BUILD_ID"

# ── 3. Check next-server process ──
echo -e "${CYAN}[3] next-server process:${NC}"
NEXT_PROCESS=$(ps aux | grep "[n]ext-server" 2>/dev/null || true)
if [[ -n "$NEXT_PROCESS" ]]; then
  echo -e "${GREEN}  Running:${NC}"
  echo "$NEXT_PROCESS" | awk '{print "    PID="$2" CMD="$11" "$12" "$13" "$14}'
else
  echo -e "${YELLOW}  No next-server process found (may be running as 'next start' or under PM2)${NC}"
  NODE_NEXT=$(ps aux | grep "[n]ode.*next" 2>/dev/null | head -3 || true)
  if [[ -n "$NODE_NEXT" ]]; then
    echo -e "${YELLOW}  Found node+next processes:${NC}"
    echo "$NODE_NEXT" | awk '{print "    PID="$2" CMD="$11" "$12" "$13}'
  fi
fi

# ── 4. Compare ──
echo ""
echo -e "${CYAN}=== Result ===${NC}"

if [[ "$DISK_BUILD_ID" == "$ONLINE_BUILD_ID" ]]; then
  echo -e "${GREEN}✓ MATCH — Disk BUILD_ID ($DISK_BUILD_ID) == Online BUILD_ID ($ONLINE_BUILD_ID)${NC}"
  exit 0
else
  echo -e "${RED}✗ MISMATCH — Disk: $DISK_BUILD_ID != Online: $ONLINE_BUILD_ID${NC}"
  exit 1
fi
