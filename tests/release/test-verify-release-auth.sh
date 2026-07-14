#!/bin/bash
# Test: verify-release-auth.sh — Codex GO binding gate
#
# Validates that a release authorization is accepted only when ALL of:
#   codex_go == true, not expired, merged_main_sha == HEAD, ci success,
#   scope.deploy_required present.
# Any single violation must FAIL. Uses temp files + dummy SHAs; does not
# create branches/commits, so git is not polluted.
#
# Exit: 0 = all pass, 1 = at least one fail.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="$SCRIPT_DIR/../../scripts/verify-release-auth.sh"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
FAIL=0

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Real HEAD of this repo at test time. verify-release-auth.sh also resolves
# HEAD from the same repo, so the "valid" case must use this exact SHA.
HEAD_SHA="$(git -C "$SCRIPT_DIR/../.." rev-parse HEAD)"
BOGUS_SHA="0123456789abcdef0123456789abcdef01234567"

FUTURE_EXPIRES="2099-01-01T00:00:00Z"
PAST_EXPIRES="2020-01-01T00:00:00Z"

# emit_auth <outfile> <codex_go true|false> <expires_at> <merged_main_sha> <ci_conclusion> <deploy_required true|false|omit>
emit_auth() {
  local out="$1" codex_go="$2" expires="$3" sha="$4" ci="$5" deploy_req="$6"
  local scope_block
  if [ "$deploy_req" = "omit" ]; then
    scope_block='{ "migrations": [], "uat_required": true }'
  else
    scope_block="{ \"migrations\": [], \"deploy_required\": $deploy_req, \"uat_required\": true }"
  fi
  cat > "$out" <<EOF
{
  "release_id": "REL-G0-DEMO-TEST",
  "task_id": "task_g0_autonomous_release_chain",
  "pr_number": 25,
  "pr_head_sha": "abc123def4567890abcdef1234567890abcdef12",
  "merged_main_sha": "$sha",
  "ci_run_id": 123456789,
  "ci_run_url": "https://github.com/newme/newme-platform/actions/runs/123456789",
  "ci_conclusion": "$ci",
  "codex_go": $codex_go,
  "codex_reviewer": "Codex (GPT-5.5)",
  "issued_at": "2026-07-14T18:00:00Z",
  "expires_at": "$expires",
  "scope": $scope_block
}
EOF
}

# run_verify <auth_file_or_arg>; prints captured output, returns exit code.
run_verify() {
  local out rc
  out=$(bash "$VERIFY" "$1" 2>&1); rc=$?
  echo "$out"
  return $rc
}

assert_pass() {
  local name="$1" file="$2"
  local out rc
  out=$(run_verify "$file"); rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "Release authorized"; then
    echo -e "${GREEN}PASS${NC}: $name"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC}: $name (expected PASS, rc=$rc, out=$out)"
    FAIL=$((FAIL+1))
  fi
}

assert_fail() {
  local name="$1" file="$2" reason="$3"
  local out rc
  out=$(run_verify "$file"); rc=$?
  if [ $rc -ne 0 ] && echo "$out" | grep -qi "$reason"; then
    echo -e "${GREEN}PASS${NC}: $name"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC}: $name (expected FAIL with '$reason', rc=$rc, out=$out)"
    FAIL=$((FAIL+1))
  fi
}

# ─────────────────────────────────────────────────────────────
# Test 1: fully valid authorization → PASS
# ─────────────────────────────────────────────────────────────
emit_auth "$TMPDIR/valid.json" true "$FUTURE_EXPIRES" "$HEAD_SHA" success true
assert_pass "valid authorization → PASS" "$TMPDIR/valid.json"

# ─────────────────────────────────────────────────────────────
# Test 2: expired expires_at → FAIL
# ─────────────────────────────────────────────────────────────
emit_auth "$TMPDIR/expired.json" true "$PAST_EXPIRES" "$HEAD_SHA" success true
assert_fail "expired authorization → FAIL" "$TMPDIR/expired.json" "EXPIRED"

# ─────────────────────────────────────────────────────────────
# Test 3: codex_go=false → FAIL
# ─────────────────────────────────────────────────────────────
emit_auth "$TMPDIR/no-go.json" false "$FUTURE_EXPIRES" "$HEAD_SHA" success true
assert_fail "codex_go=false → FAIL" "$TMPDIR/no-go.json" "codex_go"

# ─────────────────────────────────────────────────────────────
# Test 4: merged_main_sha does not match HEAD → FAIL
# ─────────────────────────────────────────────────────────────
emit_auth "$TMPDIR/sha-mismatch.json" true "$FUTURE_EXPIRES" "$BOGUS_SHA" success true
assert_fail "SHA mismatch → FAIL" "$TMPDIR/sha-mismatch.json" "mismatch"

# ─────────────────────────────────────────────────────────────
# Test 5: ci_conclusion != success → FAIL
# ─────────────────────────────────────────────────────────────
emit_auth "$TMPDIR/ci-failed.json" true "$FUTURE_EXPIRES" "$HEAD_SHA" failure true
assert_fail "ci_conclusion != success → FAIL" "$TMPDIR/ci-failed.json" "ci_conclusion"

# ─────────────────────────────────────────────────────────────
# Test 6: authorization file does not exist → FAIL
# ─────────────────────────────────────────────────────────────
OUT=$(bash "$VERIFY" "$TMPDIR/does-not-exist.json" 2>&1); RC=$?
if [ $RC -ne 0 ] && echo "$OUT" | grep -qi "not found"; then
  echo -e "${GREEN}PASS${NC}: missing authorization file → FAIL"
  PASS=$((PASS+1))
else
  echo -e "${RED}FAIL${NC}: missing authorization file should FAIL (rc=$RC, out=$OUT)"
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
