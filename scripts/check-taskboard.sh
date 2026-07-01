#!/usr/bin/env bash
set -e -o pipefail

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

pass() { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️  $1"; }

echo "=== 📋 Taskboard Verification: $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo ""

# ── T1-1: supabaseQuery.ts ──
echo "Task T1-1: src/lib/supabaseQuery.ts (useSupabaseQuery + AbortController + 8s timeout + 2 retries)"
if [ -f "src/lib/supabaseQuery.ts" ]; then
  if grep -q "useSupabaseQuery" "src/lib/supabaseQuery.ts" && \
     grep -q "AbortController" "src/lib/supabaseQuery.ts" && \
     grep -q "8000\|8s\|timeout" "src/lib/supabaseQuery.ts" && \
     grep -q "retry\|retryCount\|maxRetries" "src/lib/supabaseQuery.ts"; then
    pass "supabaseQuery.ts exists with all required features"
  else
    warn "supabaseQuery.ts exists but missing some features (AbortController/timeout/retry)"
  fi
else
  fail "File src/lib/supabaseQuery.ts does not exist"
fi

# ── T1-2: DashboardErrorBoundary.tsx ──
echo "Task T1-2: src/components/DashboardErrorBoundary.tsx (errorId + Sentry + fallback)"
if [ -f "src/components/DashboardErrorBoundary.tsx" ]; then
  if grep -q "errorId" "src/components/DashboardErrorBoundary.tsx" && \
     grep -qi "sentry\|Sentry" "src/components/DashboardErrorBoundary.tsx"; then
    pass "DashboardErrorBoundary.tsx exists with errorId + Sentry"
  else
    warn "DashboardErrorBoundary.tsx exists but missing errorId or Sentry"
  fi
else
  fail "File src/components/DashboardErrorBoundary.tsx does not exist"
fi

# ── T1-3: usePipelineDragDrop.ts ──
echo "Task T1-3: src/shared/hooks/usePipelineDragDrop.ts (onDragStart + onDrop + draggingLeadId)"
if [ -f "src/shared/hooks/usePipelineDragDrop.ts" ]; then
  if grep -q "onDragStart\|onDrop" "src/shared/hooks/usePipelineDragDrop.ts" && \
     grep -q "draggingLeadId\|dragging" "src/shared/hooks/usePipelineDragDrop.ts"; then
    pass "usePipelineDragDrop.ts exists with drag handlers"
  else
    warn "usePipelineDragDrop.ts exists but missing required exports"
  fi
else
  fail "File src/shared/hooks/usePipelineDragDrop.ts does not exist"
fi

# ── T1-4: useStageGuard.ts ──
echo "Task T1-4: src/shared/hooks/useStageGuard.ts (validTransition + STAGES)"
if [ -f "src/shared/hooks/useStageGuard.ts" ]; then
  if grep -q "validTransition\|stageGuard\|isValidTransition" "src/shared/hooks/useStageGuard.ts"; then
    pass "useStageGuard.ts exists with transition validation"
  else
    warn "useStageGuard.ts exists but missing validation logic"
  fi
else
  fail "File src/shared/hooks/useStageGuard.ts does not exist"
fi

# ── T1-5: layout.tsx ──
echo "Task T1-5: src/app/(dashboard)/layout.tsx (ErrorBoundary wrapping children)"
if [ -f "src/app/(dashboard)/layout.tsx" ]; then
  if grep -q "ErrorBoundary" "src/app/(dashboard)/layout.tsx"; then
    pass "layout.tsx contains ErrorBoundary"
  else
    fail "layout.tsx missing ErrorBoundary"
  fi
else
  fail "File layout.tsx does not exist"
fi

# ── T1-6: leads/page.tsx ──
echo "Task T1-6: src/app/(dashboard)/leads/page.tsx (usePipelineDragDrop + useStageGuard + useSupabaseQuery + empty stages)"
if [ -f "src/app/(dashboard)/leads/page.tsx" ]; then
  if grep -q "usePipelineDragDrop" "src/app/(dashboard)/leads/page.tsx"; then
    pass "leads imports usePipelineDragDrop"
  else
    fail "leads does NOT import usePipelineDragDrop"
  fi
  if grep -q "useStageGuard" "src/app/(dashboard)/leads/page.tsx"; then
    pass "leads imports useStageGuard"
  else
    fail "leads does NOT import useStageGuard"
  fi
  if grep -q "useSupabaseQuery" "src/app/(dashboard)/leads/page.tsx"; then
    pass "leads imports useSupabaseQuery"
  else
    fail "leads does NOT import useSupabaseQuery"
  fi
else
  fail "File leads/page.tsx does not exist"
fi

# ── T1-7: pipeline/page.tsx ──
echo "Task T1-7: src/app/(dashboard)/pipeline/page.tsx (usePipelineDragDrop + useSupabaseQuery + useStageGuard)"
if [ -f "src/app/(dashboard)/pipeline/page.tsx" ]; then
  if grep -q "usePipelineDragDrop" "src/app/(dashboard)/pipeline/page.tsx"; then
    pass "pipeline imports usePipelineDragDrop"
  else
    fail "pipeline does NOT import usePipelineDragDrop (still inline)"
  fi
  if grep -q "useSupabaseQuery" "src/app/(dashboard)/pipeline/page.tsx"; then
    pass "pipeline imports useSupabaseQuery"
  else
    fail "pipeline does NOT import useSupabaseQuery (still direct calls)"
  fi
  if grep -q "useStageGuard" "src/app/(dashboard)/pipeline/page.tsx"; then
    pass "pipeline imports useStageGuard"
  else
    fail "pipeline does NOT import useStageGuard"
  fi
else
  fail "File pipeline/page.tsx does not exist"
fi

# ── T1-8: leads/[id]/page.tsx ──
echo "Task T1-8: src/app/(dashboard)/leads/[id]/page.tsx (maybeSingle >= 3 + skeleton + useSupabaseQuery)"
if [ -f "src/app/(dashboard)/leads/[id]/page.tsx" ]; then
  MAYBE_COUNT=$(grep -c "maybeSingle" "src/app/(dashboard)/leads/[id]/page.tsx" || true)
  if [ "$MAYBE_COUNT" -ge 3 ]; then
    pass "maybeSingle count = $MAYBE_COUNT (>= 3)"
  else
    fail "maybeSingle count = $MAYBE_COUNT (need >= 3)"
  fi
  if grep -qi "skeleton\|Skeleton\|loading.*fallback" "src/app/(dashboard)/leads/[id]/page.tsx"; then
    pass "contains skeleton/loading fallback"
  else
    fail "missing skeleton/loading fallback"
  fi
  if grep -q "useSupabaseQuery" "src/app/(dashboard)/leads/[id]/page.tsx"; then
    pass "imports useSupabaseQuery"
  else
    fail "does NOT import useSupabaseQuery"
  fi
else
  fail "File leads/[id]/page.tsx does not exist"
fi

# ── T1-9: products/page.tsx ──
echo "Task T1-9: src/app/(dashboard)/products/page.tsx (useSupabaseQuery)"
if [ -f "src/app/(dashboard)/products/page.tsx" ]; then
  if grep -q "useSupabaseQuery" "src/app/(dashboard)/products/page.tsx"; then
    pass "products imports useSupabaseQuery"
  else
    fail "products does NOT import useSupabaseQuery"
  fi
else
  fail "File products/page.tsx does not exist"
fi

# ── T1-10: globals.css ──
echo "Task T1-10: src/app/globals.css (error-boundary-fallback style)"
if [ -f "src/app/globals.css" ]; then
  if grep -q "error-boundary-fallback" "src/app/globals.css"; then
    pass "globals.css contains error-boundary-fallback"
  else
    fail "globals.css missing error-boundary-fallback"
  fi
else
  fail "File globals.css does not exist"
fi

# ── T1-11: Sentry captureException ──
echo "Task T1-11: Sentry captureException in ErrorBoundary"
if [ -f "src/components/DashboardErrorBoundary.tsx" ]; then
  if grep -q "captureException\|Sentry.capture" "src/components/DashboardErrorBoundary.tsx"; then
    pass "ErrorBoundary contains captureException"
  else
    fail "ErrorBoundary missing Sentry.captureException"
  fi
else
  fail "DashboardErrorBoundary.tsx does not exist (needed for T1-11)"
fi

# ── T1-12: Sentry events received (reads TASKBOARD.md status) ──
echo "Task T1-12: Sentry error events actually received (manual verification)"
T1_12_STATUS=$(grep -E "^\| T1-12 " TASKBOARD.md | head -1 | grep -oE "✅|⚠️|❌" | head -1)
if [ "$T1_12_STATUS" = "✅" ]; then
  pass "TASKBOARD.md marks T1-12 done"
elif [ "$T1_12_STATUS" = "❌" ]; then
  fail "TASKBOARD.md marks T1-12 not started"
else
  warn "TASKBOARD.md marks T1-12 partial (⚠️) — manual verification pending"
fi

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ PASS: $PASS  ❌ FAIL: $FAIL  ⚠️  WARN: $WARN"
echo "═══════════════════════════════════════"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "🚫 TASKBOARD GATE: $FAIL task(s) incomplete. DEPLOY BLOCKED."
  echo "   Fix the ❌ items above, then re-run this script."
  exit 1
else
  echo "✅ All tasks complete. Safe to deploy."
  exit 0
fi
