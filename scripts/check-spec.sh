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

# ── Content coverage check ──────────────────────────────────
# Check which files changed since last SPEC update are NOT referenced in SPEC.md
echo "Checking SPEC content coverage..."
UNCOVERED_FILES=()
while IFS= read -r changed_file; do
  [[ -z "$changed_file" ]] && continue
  # Check if the file path or its directory is mentioned in SPEC.md
  if ! grep -qF "$changed_file" "$SPEC_FILE"; then
    UNCOVERED_FILES+=("$changed_file")
  fi
done < <(git diff --name-only "$LAST_SPEC_COMMIT..HEAD" -- '*.ts' '*.tsx' '*.py' '*.sh' 2>/dev/null || true)

UNCOVERED_COUNT=${#UNCOVERED_FILES[@]}

if [ "$UNCOVERED_COUNT" -le "$MAX_STALE_COMMITS" ]; then
  echo "✅ SPEC.md $COUNT commit(s) behind HEAD, $UNCOVERED_COUNT uncovered file(s) (threshold: $MAX_STALE_COMMITS) — still fresh"
  exit 0
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ⚠️  SPEC.md is $COUNT commits behind HEAD"
echo "  $UNCOVERED_COUNT changed files NOT referenced in SPEC.md"
echo "  Max before warning: $MAX_STALE_COMMITS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$UNCOVERED_COUNT" -le "$HARD_LIMIT" ]; then
  echo ""
  echo "  🟡 ACTION REQUIRED: These files changed but are NOT in SPEC.md:"
  for f in "${UNCOVERED_FILES[@]}"; do
    echo "     • $f"
  done
  echo "  Run: git log --oneline $LAST_SPEC_COMMIT..HEAD"
  echo "  Then update crm-v3/SPEC.md with recent changes"
  echo ""
  exit 0
fi

echo ""
echo "  🚫 SPEC.md content coverage gap: $UNCOVERED_COUNT uncovered files (hard limit: $HARD_LIMIT)"
echo "  These files changed but are NOT in SPEC.md:"
for f in "${UNCOVERED_FILES[@]}"; do
  echo "     • $f"
done
echo ""
echo "  DEPLOY BLOCKED — update SPEC.md first"
echo "  Run: git log --oneline $LAST_SPEC_COMMIT..HEAD"
echo "  Then update crm-v3/SPEC.md with recent changes"
echo ""
exit 1
