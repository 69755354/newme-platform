#!/bin/bash
# audit-client-supabase.sh — Scan for client-side Supabase residuals in (dashboard) pages & hooks
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RESIDUALS_FOUND=0
DASHBOARD_DIR="$PROJECT_ROOT/src/app/(dashboard)"

echo -e "${CYAN}=== Client Supabase Residual Audit ===${NC}"
echo -e "${YELLOW}Target: src/app/(dashboard)/**/*.tsx + **/_hooks/*.ts${NC}"
echo ""

# ── 1. Files importing createClient from @/lib/supabase (client-side) ──
echo -e "${CYAN}[1] Files with createClient from @/lib/supabase (client-side)${NC}"
CLIENT_IMPORTS=$(grep -rn "from ['\"]@/lib/supabase['\"]" \
  "$DASHBOARD_DIR" \
  --include='*.tsx' --include='*.ts' \
  2>/dev/null | grep -v "node_modules" | grep -v ".next" | grep -v ".hermes" || true)

if [[ -n "$CLIENT_IMPORTS" ]]; then
  echo -e "${RED}FOUND — client-side @/lib/supabase imports:${NC}"
  echo "$CLIENT_IMPORTS" | while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    lineno=$(echo "$line" | cut -d: -f2)
    relative="${file#$PROJECT_ROOT/}"
    category="page"
    if [[ "$relative" == *"/_hooks/"* ]]; then
      category="hook"
    fi
    echo -e "  ${RED}✗${NC} [$category] $relative:$lineno"
  done
  RESIDUALS_FOUND=1
else
  echo -e "${GREEN}✓ None found${NC}"
fi
echo ""

# ── 2. Client reads: supabase.from().select ──
echo -e "${CYAN}[2] Files with supabase.from().select (client reads)${NC}"
CLIENT_SELECTS=$(grep -rn "supabase\.from(.*)\.select(" \
  "$DASHBOARD_DIR" \
  --include='*.tsx' --include='*.ts' \
  2>/dev/null | grep -v "node_modules" | grep -v ".next" | grep -v ".hermes" || true)

if [[ -n "$CLIENT_SELECTS" ]]; then
  echo -e "${RED}FOUND — client supabase.from().select() calls:${NC}"
  echo "$CLIENT_SELECTS" | while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    lineno=$(echo "$line" | cut -d: -f2)
    relative="${file#$PROJECT_ROOT/}"
    category="page"
    if [[ "$relative" == *"/_hooks/"* ]]; then
      category="hook"
    fi
    echo -e "  ${RED}✗${NC} [$category] $relative:$lineno"
  done
  RESIDUALS_FOUND=1
else
  echo -e "${GREEN}✓ None found${NC}"
fi
echo ""

# ── 3. Client mutations: .insert/.update/.delete/.upsert/.rpc ──
echo -e "${CYAN}[3] Files with .insert/.update/.delete/.upsert/.rpc (client mutations)${NC}"
CLIENT_MUTATIONS=$(grep -rn "\.\(insert\|update\|delete\|upsert\|rpc\)(" \
  "$DASHBOARD_DIR" \
  --include='*.tsx' --include='*.ts' \
  2>/dev/null | grep -v "node_modules" | grep -v ".next" | grep -v ".hermes" || true)

# Filter to only show lines that look like supabase mutations (not regular function calls)
MUTATION_HITS=$(echo "$CLIENT_MUTATIONS" | grep -iE "supabase|\.from\(|\.rpc\(" | grep -v "^$" || true)

if [[ -n "$MUTATION_HITS" ]]; then
  echo -e "${RED}FOUND — client mutation calls:${NC}"
  echo "$MUTATION_HITS" | while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    lineno=$(echo "$line" | cut -d: -f2)
    relative="${file#$PROJECT_ROOT/}"
    category="page"
    if [[ "$relative" == *"/_hooks/"* ]]; then
      category="hook"
    fi
    echo -e "  ${RED}✗${NC} [$category] $relative:$lineno"
  done
  RESIDUALS_FOUND=1
else
  echo -e "${GREEN}✓ None found${NC}"
fi
echo ""

# ── Summary ──
echo -e "${CYAN}=== Summary ===${NC}"
if [[ $RESIDUALS_FOUND -eq 0 ]]; then
  echo -e "${GREEN}✓ CLEAN — No client-side Supabase residuals found in (dashboard) scope${NC}"
  exit 0
else
  echo -e "${RED}✗ RESIDUALS FOUND — Client-side Supabase usage detected in (dashboard) scope${NC}"
  exit 1
fi
