#!/usr/bin/env bash
set -o pipefail

# ─── Taskboard Verification Script ──────────────────────────
# Checks every MoA Tier 1 task against the codebase.
# Exit code 0 = all PASS → safe to deploy
# Exit code 1 = any FAIL → abort deploy
# ─────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

PASS=0
FAIL=0
WARN=0

pass() { PASS=$((PASS + 1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ❌ $1"; }
warn() { WARN=$((WARN + 1)); echo "  ⚠️  $1"; }

echo "=== 📋 Taskboard Verification: $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo ""

# ── Task 1: src/lib/supabaseQuery.ts ──────────────────────
echo "Task 1: supabaseQuery.ts (useSupabaseQuery + AbortController + withTimeout)"
if [ -f "src/lib/supabaseQuery.ts" ]; then
  pass "File exists"
  if grep -q "AbortController" "src/lib/supabaseQuery.ts"; then
    pass "Contains AbortController"
  else
    fail "Missing AbortController"
  fi
  if grep -q "withTimeout\|timeout" "src/lib/supabaseQuery.ts"; then
    pass "Contains timeout logic"
  else
    fail "Missing timeout logic"
  fi
else
  fail "File src/lib/supabaseQuery.ts does not exist"
fi
echo ""

# ── Task 2: src/components/DashboardErrorBoundary.tsx ────
echo "Task 2: DashboardErrorBoundary.tsx (errorId + fallback)"
if [ -f "src/components/DashboardErrorBoundary.tsx" ]; then
  pass "File exists"
  if grep -q "errorId\|error.id\|error_id" "src/components/DashboardErrorBoundary.tsx"; then
    pass "Contains errorId"
  else
    fail "Missing errorId"
  fi
else
  fail "File src/components/DashboardErrorBoundary.tsx does not exist"
fi
echo ""

# ── Task 3: layout.tsx ErrorBoundary ─────────────────────
echo "Task 3: layout.tsx (ErrorBoundary wrapping children)"
if grep -q "ErrorBoundary" "src/app/(dashboard)/layout.tsx" 2>/dev/null; then
  pass "layout.tsx contains ErrorBoundary"
else
  fail "layout.tsx missing ErrorBoundary"
fi
echo ""

# ── Task 4: usePipelineDragDrop.ts shared hook ───────────
echo "Task 4: usePipelineDragDrop.ts (shared drag-drop hook)"
if [ -f "src/shared/hooks/usePipelineDragDrop.ts" ]; then
  pass "File exists"
  if grep -q "dragDrop\|DragDrop\|drag.*drop" "src/shared/hooks/usePipelineDragDrop.ts"; then
    pass "Contains drag-drop logic"
  else
    fail "No drag-drop logic found"
  fi
else
  fail "File src/shared/hooks/usePipelineDragDrop.ts does not exist"
fi
echo ""

# ── Task 5: leads/page.tsx integrates hook ───────────────
echo "Task 5: leads/page.tsx (uses usePipelineDragDrop)"
if grep -q "usePipelineDragDrop" "src/app/(dashboard)/leads/page.tsx" 2>/dev/null; then
  pass "leads imports usePipelineDragDrop"
else
  fail "leads does NOT import usePipelineDragDrop"
fi
echo ""

# ── Task 6: pipeline/page.tsx uses shared hook ────────────
echo "Task 6: pipeline/page.tsx (uses usePipelineDragDrop)"
if grep -q "usePipelineDragDrop" "src/app/(dashboard)/pipeline/page.tsx" 2>/dev/null; then
  pass "pipeline imports usePipelineDragDrop"
else
  fail "pipeline does NOT import usePipelineDragDrop (still inline)"
fi
echo ""

# ── Task 7: leads/[id]/page.tsx maybeSingle count ────────
echo "Task 7: leads/[id]/page.tsx (maybeSingle >= 3)"
if [ -f "src/app/(dashboard)/leads/[id]/page.tsx" ]; then
  COUNT=$(grep -c "maybeSingle" "src/app/(dashboard)/leads/[id]/page.tsx" 2>/dev/null || echo "0")
  if [ "$COUNT" -ge 3 ]; then
    pass "maybeSingle count = $COUNT (>= 3)"
  else
    warn "maybeSingle count = $COUNT (need >= 3)"
  fi
else
  fail "File src/app/(dashboard)/leads/[id]/page.tsx does not exist"
fi
echo ""

# ── Task 8: globals.css error-boundary-fallback ──────────
echo "Task 8: globals.css (error-boundary-fallback style)"
if grep -q "error-boundary-fallback" "src/app/globals.css" 2>/dev/null; then
  pass "globals.css contains error-boundary-fallback"
else
  fail "globals.css missing error-boundary-fallback"
fi
echo ""

# ── Summary ──────────────────────────────────────────────
echo "═══════════════════════════════════════"
echo "  ✅ PASS: $PASS  ❌ FAIL: $FAIL  ⚠️  WARN: $WARN"
echo "═══════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "🚫 TASKBOARD GATE: $FAIL task(s) incomplete. DEPLOY BLOCKED."
  echo "   Fix the ❌ items above, then re-run this script."
  exit 1
fi

echo ""
echo "🟢 TASKBOARD GATE: All checks passed. Safe to deploy."
exit 0
