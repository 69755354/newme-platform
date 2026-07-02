#!/usr/bin/env bash
set -e -o pipefail

# ─── SPEC Freshness Gate ────────────────────────────
# Checks SPEC.md is within N commits of HEAD.
# Exit 0 = fresh enough, safe to deploy.
# Exit 1 = stale, update SPEC.md first.
# ────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

SPEC_FILE="crm-v3/SPEC.md"
MAX_STALE_COMMITS=3       # warn at this threshold
HARD_LIMIT=5              # block deploy at this threshold

if [ ! -f "$SPEC_FILE" ]; then
  echo "⚠️  SPEC.md not found — run SPEC gate only if SPEC.md exists"
  exit 0
fi

# Find last commit that touched SPEC.md
LAST_SPEC_COMMIT=$(git log -1 --format="%H" -- "$SPEC_FILE" 2>/dev/null || echo "")
HEAD_COMMIT=$(git log -1 --format="%H" HEAD)

if [ -z "$LAST_SPEC_COMMIT" ]; then
  echo "⚠️  SPEC.md exists but no git history found for it — skipping check"
  exit 0
fi

if [ "$LAST_SPEC_COMMIT" = "$HEAD_COMMIT" ]; then
  echo "✅ SPEC.md is up-to-date (latest commit)"
  exit 0
fi

# Count commits between LAST_SPEC_COMMIT and HEAD (exclusive of LAST_SPEC_COMMIT, inclusive of HEAD)
COUNT=$(git rev-list --count "$LAST_SPEC_COMMIT..HEAD" 2>/dev/null || echo "0")

if [ "$COUNT" -le "$MAX_STALE_COMMITS" ]; then
  echo "✅ SPEC.md is $COUNT commit(s) behind HEAD (threshold: $MAX_STALE_COMMITS) — still fresh"
  exit 0
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ⚠️  SPEC.md is $COUNT commits behind HEAD"
echo "  Max before warning: $MAX_STALE_COMMITS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$COUNT" -le "$HARD_LIMIT" ]; then
  echo ""
  echo "  🟡 ACTION REQUIRED: Consider updating crm-v3/SPEC.md"
  echo "  Run: git log --oneline $LAST_SPEC_COMMIT..HEAD"
  echo "  Then update SPEC.md with recent changes"
  echo ""
  exit 0
fi

echo ""
echo "  🚫 SPEC.md is $COUNT commits stale (hard limit: $HARD_LIMIT)"
echo "  DEPLOY BLOCKED — update SPEC.md first"
echo "  Run: git log --oneline $LAST_SPEC_COMMIT..HEAD"
echo "  Then update crm-v3/SPEC.md with recent changes"
echo ""
exit 1
