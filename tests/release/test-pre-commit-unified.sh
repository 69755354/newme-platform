#!/bin/bash
# Test: pre-commit-scope unified marker detection
# Verifies [CODEX] and [OPENCODE] both trigger scope check; [HERMES] skips.
#
# Hook contract (must NOT change):
#   - COMMIT_MSG read from `git log -1 --format=%s HEAD`  (last commit)
#   - CHANGED     read from `git diff --cached --name-only` (staged files)
#   - Marker [CODEX] or [OPENCODE] => enforce scope
#   - Any other commit (e.g. [HERMES]) => skip
#
# Exit: 0 = all pass, 1 = at least one fail.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../../.githooks/pre-commit-scope"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
FAIL=0

# ── Setup temp git repo with a task_test manifest ──
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

git -C "$TMPDIR" init -q
git -C "$TMPDIR" config user.email "test@test.local"
git -C "$TMPDIR" config user.name "Test"
git -C "$TMPDIR" config commit.gpgsign false

mkdir -p "$TMPDIR/.hermes/delegations"
cat > "$TMPDIR/.hermes/delegations/task_test.json" <<'EOF'
{
  "task_id": "task_test",
  "allowed_files": ["foo.txt"],
  "forbidden_files": ["bar.txt"]
}
EOF

# Helper: run the hook inside the temp repo, capture stdout+stderr + exit code
run_hook() {
  local out rc
  out=$(cd "$TMPDIR" && bash "$HOOK" 2>&1) ; rc=$?
  echo "$out"
  return $rc
}

# Seed an initial baseline commit so HEAD exists
echo "seed" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
git -C "$TMPDIR" commit -q -m "baseline seed"

# ─────────────────────────────────────────────────────────────
# Test 1: [CODEX][task_test] commit → gate triggers (PASS, allowed file)
# ─────────────────────────────────────────────────────────────
echo "codex" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
git -C "$TMPDIR" commit -q -m "[CODEX][task_test] codex baseline"
echo "change" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
OUT=$(run_hook); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "Pre-commit scope OK" && echo "$OUT" | grep -q "marker: CODEX"; then
  echo -e "${GREEN}PASS${NC}: [CODEX][task_test] triggered gate (exit 0, marker CODEX shown)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: [CODEX][task_test] should pass gate (rc=$RC, out=$OUT)"
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────
# Test 2: [OPENCODE][task_test] commit → gate triggers (PASS, allowed file)
# ─────────────────────────────────────────────────────────────
echo "opencode" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
git -C "$TMPDIR" commit -q -m "[OPENCODE][task_test] opencode baseline"
echo "change2" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
OUT=$(run_hook); RC=$?
if [ $RC -eq 0 ] && echo "$OUT" | grep -q "Pre-commit scope OK" && echo "$OUT" | grep -q "marker: OPENCODE"; then
  echo -e "${GREEN}PASS${NC}: [OPENCODE][task_test] triggered gate (exit 0, marker OPENCODE shown)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: [OPENCODE][task_test] should pass gate (rc=$RC, out=$OUT)"
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────
# Test 3: [HERMES] commit (no task marker) → gate SKIPS
# ─────────────────────────────────────────────────────────────
echo "hermes" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
git -C "$TMPDIR" commit -q -m "[HERMES] hermes manual work"
echo "hermes2" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
OUT=$(run_hook); RC=$?
# Skip = exit 0 AND no "Pre-commit scope OK" line
if [ $RC -eq 0 ] && ! echo "$OUT" | grep -q "Pre-commit scope OK"; then
  echo -e "${GREEN}PASS${NC}: [HERMES] skipped gate (exit 0, no scope check)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: [HERMES] should skip gate (rc=$RC, out=$OUT)"
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────
# Test 4: [OPENCODE] commit WITHOUT task marker → BLOCKED (exit 1)
# ─────────────────────────────────────────────────────────────
echo "notask" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
git -C "$TMPDIR" commit -q -m "[OPENCODE] opencode no task marker"
echo "notask2" > "$TMPDIR/foo.txt"
git -C "$TMPDIR" add foo.txt
OUT=$(run_hook); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "requires \[task_"; then
  echo -e "${GREEN}PASS${NC}: [OPENCODE] without task marker blocked (exit 1)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: [OPENCODE] without task marker should block (rc=$RC, out=$OUT)"
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────
# Test 5: [OPENCODE][task_test] commit with FORBIDDEN file → BLOCKED (exit 1)
# ─────────────────────────────────────────────────────────────
echo "fb" > "$TMPDIR/bar.txt"
git -C "$TMPDIR" add bar.txt
git -C "$TMPDIR" commit -q -m "[OPENCODE][task_test] opencode forbidden baseline"
echo "fb2" > "$TMPDIR/bar.txt"
git -C "$TMPDIR" add bar.txt
OUT=$(run_hook); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "FORBIDDEN"; then
  echo -e "${GREEN}PASS${NC}: [OPENCODE] blocked by forbidden file (exit 1)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: [OPENCODE] should block forbidden file (rc=$RC, out=$OUT)"
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────
# Test 6: [CODEX][task_test] commit with file NOT in allowed_files → BLOCKED
# ─────────────────────────────────────────────────────────────
echo "other" > "$TMPDIR/baz.txt"
git -C "$TMPDIR" add baz.txt
git -C "$TMPDIR" commit -q -m "[CODEX][task_test] codex out-of-scope baseline"
echo "other2" > "$TMPDIR/baz.txt"
git -C "$TMPDIR" add baz.txt
OUT=$(run_hook); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -q "not in manifest allowed_files"; then
  echo -e "${GREEN}PASS${NC}: [CODEX] blocked out-of-scope file (exit 1)"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: [CODEX] should block out-of-scope file (rc=$RC, out=$OUT)"
  FAIL=$((FAIL+1))
fi

# ─────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  PASS: $PASS  FAIL: $FAIL"
echo "═══════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
