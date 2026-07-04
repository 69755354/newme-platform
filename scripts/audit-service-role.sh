#!/bin/bash
# audit-service-role.sh — Scan for service_role key exposure in source code
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HIGH_RISK=0
SRC_DIR="$PROJECT_ROOT/src"

echo -e "${CYAN}=== Service Role Key Exposure Audit ===${NC}"
echo ""

# ── 1. Files importing service_role or SUPABASE_SERVICE_ROLE_KEY ──
echo -e "${CYAN}[1] Files referencing service_role or SUPABASE_SERVICE_ROLE_KEY${NC}"
SERVICE_ROLE_IMPORTS=$(grep -rn "service_role\|SUPABASE_SERVICE_ROLE_KEY" \
  "$SRC_DIR" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  2>/dev/null | grep -v "node_modules" | grep -v ".next" | grep -v ".hermes" || true)

if [[ -n "$SERVICE_ROLE_IMPORTS" ]]; then
  echo -e "${YELLOW}FOUND:${NC}"
  echo "$SERVICE_ROLE_IMPORTS" | while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    lineno=$(echo "$line" | cut -d: -f2)
    relative="${file#$PROJECT_ROOT/}"
    echo "  - $relative:$lineno"
  done
else
  echo -e "${GREEN}✓ No references found${NC}"
fi
echo ""

# ── 2. Files where createClient(supabaseUrl, serviceKey) appears ──
echo -e "${CYAN}[2] Files with createClient(supabaseUrl, serviceKey) pattern${NC}"
SERVICE_KEY_CREATE=$(grep -rn "createClient.*supabaseUrl.*serviceKey\|createClient.*SERVICE_ROLE\|service_role.*key" \
  "$SRC_DIR" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  2>/dev/null | grep -v "node_modules" | grep -v ".next" | grep -v ".hermes" || true)

if [[ -n "$SERVICE_KEY_CREATE" ]]; then
  echo -e "${YELLOW}FOUND:${NC}"
  echo "$SERVICE_KEY_CREATE" | while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    lineno=$(echo "$line" | cut -d: -f2)
    relative="${file#$PROJECT_ROOT/}"
    echo "  - $relative:$lineno"
  done
else
  echo -e "${GREEN}✓ No service role createClient found${NC}"
fi
echo ""

# ── 3. Verify server-side only — check for "use client" in files with service_role ──
echo -e "${CYAN}[3] Checking 'use client' in service_role files (HIGH risk scan)${NC}"

# Collect all files that reference service_role
ALL_SERVICE_ROLE_FILES=$(grep -rln "service_role\|SUPABASE_SERVICE_ROLE_KEY\|serviceKey\|SERVICE_ROLE" \
  "$SRC_DIR" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  2>/dev/null | grep -v "node_modules" | grep -v ".next" | grep -v ".hermes" | sort -u || true)

if [[ -z "$ALL_SERVICE_ROLE_FILES" ]]; then
  echo -e "${GREEN}✓ No service_role files to check${NC}"
else
  HIGH_RISK_FILES=""
  for FILE in $ALL_SERVICE_ROLE_FILES; do
    relative="${FILE#$PROJECT_ROOT/}"
    # Check if the file has "use client"
    if grep -q "'use client'" "$FILE" 2>/dev/null || grep -q '"use client"' "$FILE" 2>/dev/null; then
      echo -e "  ${RED}✗ HIGH RISK:${NC} $relative — 'use client' file references service_role"
      HIGH_RISK_FILES="$HIGH_RISK_FILES $relative"
      HIGH_RISK=1
    else
      # Categorize server-side
      if [[ "$relative" == *"/api/"* ]]; then
        echo -e "  ${GREEN}✓ OK (API route):${NC} $relative"
      elif [[ "$relative" == *"actions/"* ]]; then
        echo -e "  ${GREEN}✓ OK (server action):${NC} $relative"
      elif [[ "$relative" == *"lib/"* && "$relative" != *"client"* ]]; then
        echo -e "  ${GREEN}✓ OK (server lib):${NC} $relative"
      else
        echo -e "  ${YELLOW}? REVIEW:${NC} $relative — verify server-side use"
      fi
    fi
  done
fi
echo ""

# ── Summary ──
echo -e "${CYAN}=== Summary ===${NC}"
if [[ $HIGH_RISK -eq 0 ]]; then
  echo -e "${GREEN}✓ PASS — No HIGH risk service_role exposure in client files${NC}"
  exit 0
else
  echo -e "${RED}✗ FAIL — HIGH risk service_role exposure detected in client files${NC}"
  exit 1
fi
