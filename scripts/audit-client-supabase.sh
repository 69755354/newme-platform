#!/bin/bash
# audit-client-supabase.sh — Scan for client-side Supabase residuals in (dashboard) pages & hooks
# Exit codes: 0 = CLEAN, 1 = WARN (known/documented residuals only), 2 = FAIL (new undocumented residuals)
set -euo pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RESIDUALS_FOUND=0
DASHBOARD_DIR="$PROJECT_ROOT/src/app/(dashboard)"
RESIDUALS_FILE="$PROJECT_ROOT/docs/releases/residuals.md"

# ── Load known exceptions from residuals.md ──
KNOWN_EXCEPTIONS=""
if [[ -f "$RESIDUALS_FILE" ]]; then
  # Extract file paths from residuals.md table rows
  KNOWN_EXCEPTIONS=$(grep -oP '\|[^|]*\|\s*([^\s|]+\.(tsx?|ts|js))\s*\|' "$RESIDUALS_FILE" 2>/dev/null | \
    grep -oP '([a-zA-Z0-9_/.-]+\.(tsx?|ts|js))' | sort -u || echo "")
fi

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
    # Check if this file is a known exception
    is_known=""
    if echo "$KNOWN_EXCEPTIONS" | grep -qF "$relative" 2>/dev/null; then
      is_known=" ${YELLOW}[KNOWN]${NC}"
    fi
    echo -e "  ${RED}✗${NC} [$category] $relative:$lineno$is_known"
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

UNDOCUMENTED_READS=0
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
    is_known=""
    if echo "$KNOWN_EXCEPTIONS" | grep -qF "$relative" 2>/dev/null; then
      is_known=" ${YELLOW}[KNOWN]${NC}"
    fi
    echo -e "  ${RED}✗${NC} [$category] $relative:$lineno$is_known"
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

NEW_MUTATIONS=0
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
    is_known=""
    if echo "$KNOWN_EXCEPTIONS" | grep -qF "$relative" 2>/dev/null; then
      is_known=" ${YELLOW}[KNOWN]${NC}"
    fi
    echo -e "  ${RED}✗${NC} [$category] $relative:$lineno$is_known"
  done
  RESIDUALS_FOUND=1
else
  echo -e "${GREEN}✓ None found${NC}"
fi
echo ""

# ── Summary ──
echo -e "${CYAN}=== Summary ===${NC}"
if [[ $RESIDUALS_FOUND -eq 0 ]]; then
  echo -e "${GREEN}✓ CLEAN — No client-side Supabase residuals in (dashboard) scope${NC}"
  exit 0
fi

# Check if ALL residuals are documented
ALL_DOCUMENTED=true
for line in $CLIENT_IMPORTS; do
  rel="${line#$PROJECT_ROOT/}"
  rel="${rel%%:*}"
  if [[ -n "$KNOWN_EXCEPTIONS" ]] && ! echo "$KNOWN_EXCEPTIONS" | grep -qF "$rel" 2>/dev/null; then
    ALL_DOCUMENTED=false
    break
  fi
done

if $ALL_DOCUMENTED; then
  echo -e "${YELLOW}⚠ WARN — Residuals found but ALL are documented in residuals.md${NC}"
  echo -e "${YELLOW}  Known exceptions: leads/*, quotations/*, projects/*, quotes/*, contracts/new, dashboard quick log, payments installment_plans${NC}"
  exit 1
else
  echo -e "${RED}✗ FAIL — Undocumented client Supabase residuals detected${NC}"
  exit 2
fi
