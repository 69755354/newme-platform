#!/usr/bin/env bash
# check-route-files.sh — Gate: detect illegal files in Next.js app/ directory
#
# Next.js 16 App Router conventions — these are legal route files:
#   page|layout|loading|error|not-found|route|global-error|template|default
#
# Strategy: only flag NEW/STAGED files via git diff, plus known-bad patterns.
# Co-located components (*-client.tsx, *-panel.tsx etc) that already exist are fine.
# The gate catches what CC or a rushed batch might introduce.

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${YELLOW}=== Release Gate: Route File Check ===${NC}"

# Legal Next.js route file basenames
LEGAL_NAMES=("page.tsx" "page.ts" "layout.tsx" "layout.ts" "loading.tsx" "loading.ts"
  "error.tsx" "error.ts" "not-found.tsx" "not-found.ts" "route.ts" "route.tsx"
  "global-error.tsx" "global-error.ts" "template.tsx" "template.ts" "default.tsx" "default.ts")

# Known-bad patterns that should NEVER exist
BAD_PATTERNS=("500.tsx" "500.ts" "404.tsx" "404.ts" "500.jsx" "404.jsx"
  "_error.tsx" "_error.ts" "_app.tsx" "_app.ts" "_document.tsx" "_document.ts")

is_legal() {
  local basename="$1"
  for legal in "${LEGAL_NAMES[@]}"; do
    [[ "$basename" == "$legal" ]] && return 0
  done
  return 1
}

is_bad_pattern() {
  local basename="$1"
  for bad in "${BAD_PATTERNS[@]}"; do
    [[ "$basename" == "$bad" ]] && return 0
  done
  return 1
}

VIOLATIONS=0

# Check 1: Scan for known-bad patterns everywhere in app/
echo ""
echo "Scanning for known-bad file patterns..."
while IFS= read -r filepath; do
  basename=$(basename "$filepath")
  if is_bad_pattern "$basename"; then
    echo -e "${RED}❌ FORBIDDEN FILE: $filepath (will break Next.js 16)${NC}"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(find src/app -type f \( -name "*.tsx" -o -name "*.ts" -o -name "*.jsx" -o -name "*.js" \) 2>/dev/null || true)

# Check 2: Git diff — only flag NEW/ADDED files in app/ that aren't route conventions
echo ""
echo "Checking git diff for newly added route files..."

while IFS= read -r added_file; do
  [[ -z "$added_file" ]] && continue
  
  # Only check app directory
  if ! echo "$added_file" | grep -q '^src/app/'; then
    continue
  fi
  
  # Skip API routes
  if echo "$added_file" | grep -q '/api/'; then
    continue
  fi
  
  basename=$(basename "$added_file")
  
  # Flag if it's a known-bad pattern
  if is_bad_pattern "$basename"; then
    echo -e "${RED}❌ NEW FORBIDDEN FILE: $added_file${NC}"
    VIOLATIONS=$((VIOLATIONS + 1))
    continue
  fi
  
  # If it's a route convention file, it's fine
  if is_legal "$basename"; then
    continue
  fi
  
  # Unknown non-convention file being added — warn
  echo -e "${YELLOW}⚠ NEW non-convention file: $added_file (review required)${NC}"
  # Not a hard fail — co-located components are valid in Next.js 16
  
done < <(git diff --name-only --diff-filter=A HEAD 2>/dev/null || true)

# Also check staged files
while IFS= read -r staged_file; do
  [[ -z "$staged_file" ]] && continue
  if ! echo "$staged_file" | grep -q '^src/app/'; then continue; fi
  if echo "$staged_file" | grep -q '/api/'; then continue; fi
  
  basename=$(basename "$staged_file")
  if is_bad_pattern "$basename"; then
    echo -e "${RED}❌ STAGED FORBIDDEN FILE: $staged_file${NC}"
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done < <(git diff --name-only --cached 2>/dev/null || true)

echo ""
if [[ $VIOLATIONS -gt 0 ]]; then
  echo -e "${RED}✗ Found $VIOLATIONS illegal file(s)${NC}"
  exit 1
else
  echo -e "${GREEN}✓ No illegal route files detected${NC}"
  exit 0
fi
