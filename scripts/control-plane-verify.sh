#!/usr/bin/env bash
# ─── CONTROL-PLANE-VERIFY ────────────────────────────────────
# Verifies control plane integrity: hooks, manifest, deploy wrapper,
# evidence, pre-push, health-check, sudoers.
# Does NOT modify anything. Reports PASS/FAIL/RISK.
# ─────────────────────────────────────────────────────────────
set -e -o pipefail

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' BLUE='\033[0;34m' NC='\033[0m'

PASS=0
FAIL=0
RISK=0
RESULTS=""

cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

section() { echo -e "\n${BLUE}━━━ $1 ━━━${NC}"; }

pass() {
  echo -e "  ${GREEN}✅ PASS${NC} — $1"
  PASS=$((PASS + 1))
  RESULTS="${RESULTS}PASS: $1\n"
}

fail() {
  echo -e "  ${RED}❌ FAIL${NC} — $1"
  FAIL=$((FAIL + 1))
  RESULTS="${RESULTS}FAIL: $1\n"
}

risk() {
  echo -e "  ${YELLOW}⚠️  RISK${NC} — $1"
  RISK=$((RISK + 1))
  RESULTS="${RESULTS}RISK: $1\n"
}

# ── 1. Git Hooks Active ──────────────────────────────────────
section "1. Git Hooks"

for hook in pre-commit commit-msg pre-push; do
  HOOK_PATH=".git/hooks/$hook"
  GITHOOK_PATH=".githooks/$hook"

  if [ -L "$HOOK_PATH" ]; then
    TARGET=$(readlink "$HOOK_PATH")
    if [ -f "$HOOK_PATH" ] && [ -x "$HOOK_PATH" ]; then
      if [ -f "$GITHOOK_PATH" ]; then
        pass "$hook: symlink → $GITHOOK_PATH (executable)"
      else
        fail "$hook: symlink target $GITHOOK_PATH not found"
      fi
    else
      fail "$hook: exists but not executable"
    fi
  else
    if [ -f "$HOOK_PATH" ]; then
      risk "$hook: exists but is not a symlink (expected: → $GITHOOK_PATH)"
    else
      fail "$hook: MISSING"
    fi
  fi
done

# ── 2. Manifest Integrity ────────────────────────────────────
section "2. Manifest Integrity"

MANIFEST=".githooks/manifest.json"
if [ -f "$MANIFEST" ]; then
  for hook in pre-commit commit-msg pre-push; do
    GITHOOK_PATH=".githooks/$hook"
    if [ -f "$GITHOOK_PATH" ]; then
      ACTUAL_HASH=$(sha256sum "$GITHOOK_PATH" | cut -d' ' -f1)
      STORED_HASH=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['hooks']['$hook'])" 2>/dev/null || echo "MISSING")
      if [ "$ACTUAL_HASH" = "$STORED_HASH" ]; then
        pass "$hook: hash matches manifest"
      else
        fail "$hook: HASH MISMATCH (actual=$ACTUAL_HASH, manifest=$STORED_HASH)"
      fi
    fi
  done
else
  fail "manifest.json MISSING at $MANIFEST"
fi

# ── 3. Deploy Wrapper Security ───────────────────────────────
section "3. Deploy Wrapper"

WRAPPER="/opt/newme/deploy/deploy.sh"
if [ -f "$WRAPPER" ]; then
  OWNER=$(stat -c '%U:%G' "$WRAPPER" 2>/dev/null || echo "unknown")
  MODE=$(stat -c '%a' "$WRAPPER" 2>/dev/null || echo "unknown")
  SHA=$(sha256sum "$WRAPPER" 2>/dev/null | cut -d' ' -f1 || echo "unknown")

  echo "  Path:  $WRAPPER"
  echo "  Owner: $OWNER"
  echo "  Mode:  $MODE"
  echo "  SHA256: $SHA"

  if [ "$OWNER" = "root:root" ]; then
    pass "wrapper owner = root:root"
  else
    fail "wrapper owner is $OWNER (expected root:root)"
  fi

  if [ "$MODE" = "755" ] || [ "$MODE" = "750" ]; then
    pass "wrapper mode = $MODE (not world-writable)"
  else
    fail "wrapper mode is $MODE (may be writable by others)"
  fi

  # Check if ubuntu can write
  if [ -w "$WRAPPER" ]; then
    WRITABLE_BY=$(stat -c '%U' "$WRAPPER")
    if [ "$WRITABLE_BY" = "ubuntu" ] || [ "$(whoami)" = "ubuntu" ]; then
      fail "wrapper is WRITABLE by ubuntu user"
    else
      risk "wrapper is writable by $WRITABLE_BY"
    fi
  else
    pass "wrapper is NOT writable by ubuntu"
  fi
else
  fail "wrapper MISSING at $WRAPPER"
fi

# ── 4. Deploy Evidence ───────────────────────────────────────
section "4. Deploy Evidence"

EVI_DIR=".hermes-harness/deploy-evidence"
if [ -d "$EVI_DIR" ]; then
  LATEST=$(ls -t "$EVI_DIR"/*.json 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    echo "  Latest: $LATEST"
    # Validate JSON
    if python3 -c "import json; json.load(open('$LATEST'))" 2>/dev/null; then
      pass "evidence JSON valid: $LATEST"
      # Check required fields
      for field in deploy_id commit actor started_at build smoke logs regression health result; do
        if python3 -c "import json; d=json.load(open('$LATEST')); d['$field']" 2>/dev/null; then
          :
        else
          fail "evidence missing field: $field"
        fi
      done
      # Show result
      RESULT=$(python3 -c "import json;print(json.load(open('$LATEST'))['result'])" 2>/dev/null || echo "unknown")
      echo "  Result: $RESULT"
    else
      fail "evidence JSON INVALID: $LATEST"
    fi
  else
    risk "no evidence files found in $EVI_DIR (expected after first deploy)"
  fi
else
  risk "evidence directory $EVI_DIR not found (will be created on first deploy)"
fi

# ── 5. Pre-push TASKBOARD Gate ───────────────────────────────
section "5. Pre-push TASKBOARD Gate"

PRE_PUSH=".githooks/pre-push"
if [ -f "$PRE_PUSH" ]; then
  if grep -q "check-taskboard.sh" "$PRE_PUSH"; then
    pass "pre-push calls check-taskboard.sh"
  else
    fail "pre-push does NOT call check-taskboard.sh"
  fi
else
  fail "pre-push hook not found"
fi

# ── 6. Health-check Cooldown ─────────────────────────────────
section "6. Health-check Cooldown"

HC_SCRIPT="$HOME/.hermes/scripts/health-check.py"
if [ -f "$HC_SCRIPT" ]; then
  COOLDOWN=$(grep "COOLDOWN_MIN\b" "$HC_SCRIPT" | head -1 | grep -oP '\d+')
  if [ -n "$COOLDOWN" ]; then
    echo "  COOLDOWN_MIN = $COOLDOWN"
    if [ "$COOLDOWN" -le 10 ]; then
      pass "cooldown = ${COOLDOWN}min (≤10)"
    else
      fail "cooldown = ${COOLDOWN}min (>10, too long)"
    fi
  else
    risk "could not parse COOLDOWN_MIN from $HC_SCRIPT"
  fi

  # Check if cooldown path is silent or alerts
  if grep -A2 "in_cooldown" "$HC_SCRIPT" | grep -q "send_tg"; then
    pass "cooldown path sends TG alert (not silent)"
  else
    fail "cooldown path appears SILENT (no send_tg)"
  fi
else
  fail "health-check script not found at $HC_SCRIPT"
fi

# ── 7. Sudoers Risk (report only, no change) ─────────────────
section "7. Sudoers Risk (REPORT ONLY)"

echo "  Current sudo -l for $(whoami):"
SUDO_LIST=$(sudo -n -l 2>&1 || echo "(sudo -l failed)")
echo "$SUDO_LIST" | while IFS= read -r line; do echo "    $line"; done

if echo "$SUDO_LIST" | grep -q "NOPASSWD:.*ALL" 2>/dev/null; then
  risk "ubuntu has NOPASSWD:ALL — Agent can sudo systemctl restart"
  risk "RUN: Step 2 (sudoers whitelist) to fix this"
else
  pass "ubuntu does NOT have unrestricted NOPASSWD:ALL"
fi

# Check specific systemctl risk
if sudo -n systemctl restart newme-platform.service 2>/dev/null; then
  risk "VERIFIED: ubuntu CAN sudo systemctl restart newme-platform"
else
  pass "ubuntu CANNOT sudo systemctl restart newme-platform"
fi

# ── 8. Coding Auth Manual Gate ────────────────────────────────
section "8. Coding Auth Manual Gate"

AUTH_SCRIPT="scripts/issue-coding-auth.py"
APPROVAL_DIR="/var/lib/newme/coding-auth"
APPROVAL_FILE="$APPROVAL_DIR/manual-approval"

# 8a — Script contains approval gate
if [ -f "$AUTH_SCRIPT" ]; then
  if grep -q "manual-approval" "$AUTH_SCRIPT" && grep -q "verify_approval" "$AUTH_SCRIPT"; then
    pass "issue-coding-auth.py has manual approval gate"
  else
    fail "issue-coding-auth.py MISSING manual approval gate (can self-sign without root)"
  fi
else
  fail "issue-coding-auth.py not found at $AUTH_SCRIPT"
fi

# 8b — Approval directory is not ubuntu-writable
if [ -d "$APPROVAL_DIR" ]; then
  if [ -w "$APPROVAL_DIR" ]; then
    fail "$APPROVAL_DIR is WRITABLE by ubuntu — Agent can plant fake approval"
  else
    pass "$APPROVAL_DIR is NOT writable by ubuntu"
  fi
else
  risk "$APPROVAL_DIR does not exist (will be created by root on first use)"
fi

# 8c — Approval file (if exists) must be root-owned + secure
if [ -f "$APPROVAL_FILE" ]; then
  OWNER=$(stat -c '%U:%G' "$APPROVAL_FILE" 2>/dev/null || echo "unknown")
  MODE=$(stat -c '%a' "$APPROVAL_FILE" 2>/dev/null || echo "unknown")

  if [ "$OWNER" = "root:root" ]; then
    pass "approval file owner = root:root"
  else
    fail "approval file owner is $OWNER (expected root:root)"
  fi

  # Check group/world writable
  if echo "$MODE" | grep -q '[2367]..$'; then
    fail "approval file mode $MODE has group-write bit"
  elif echo "$MODE" | grep -q '..[2367]$'; then
    fail "approval file mode $MODE has world-write bit"
  else
    pass "approval file mode $MODE (not group/world writable)"
  fi

  # Check it has task_id + expires_at
  if grep -q "task_id=" "$APPROVAL_FILE"; then
    pass "approval file contains task_id"
  else
    fail "approval file MISSING task_id"
  fi

  if grep -q "expires_at=" "$APPROVAL_FILE"; then
    pass "approval file contains expires_at"
  else
    risk "approval file missing expires_at (no time limit)"
  fi
else
  pass "no stale approval file present (clean state)"
fi

# 8d — Token file is not writable by others
TOKEN_FILE=".hermes/state/coding-auth.json"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN_OWNER=$(stat -c '%U' "$TOKEN_FILE" 2>/dev/null || echo "unknown")
  if [ "$TOKEN_OWNER" = "ubuntu" ] || [ "$TOKEN_OWNER" = "$(whoami)" ]; then
    pass "coding-auth.json owner = $TOKEN_OWNER"
  else
    risk "coding-auth.json owner is $TOKEN_OWNER"
  fi
fi

# ── Summary ──────────────────────────────────────────────────
section "Summary"
echo ""
echo -e "  ${GREEN}PASS: $PASS${NC}"
echo -e "  ${RED}FAIL: $FAIL${NC}"
echo -e "  ${YELLOW}RISK: $RISK${NC}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}❌ CONTROL PLANE VERIFICATION FAILED${NC}"
  echo "  Fix FAIL items above before next deploy."
  exit 1
elif [ "$RISK" -gt 0 ]; then
  echo -e "${YELLOW}⚠️  CONTROL PLANE: $RISK RISK(s) identified${NC}"
  echo "  RISK items are informational (Step 1 scope)."
  echo "  Fix in Step 2 (sudoers whitelist)."
  exit 0
else
  echo -e "${GREEN}✅ CONTROL PLANE VERIFICATION PASSED${NC}"
  exit 0
fi
