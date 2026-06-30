#!/usr/bin/env bash
set -o pipefail

# ─── Taskboard Watchdog ──────────────────────────────────────
# Verifies that taskboard gate infrastructure is intact.
# If anything is missing/tampered → restore from COS + alert.
# Run by systemd timer every 6 hours.
# ─────────────────────────────────────────────────────────────

PROJECT="/home/ubuntu/newme-platform"
COS_PREFIX="crm-v3/taskboard"
ALERT_FILE="/tmp/taskboard-watchdog-last-alert"
ALERT_COOLDOWN=3600  # Don't re-alert within 1 hour

PASS=0
FAIL=0
RESTORED=0
ALERTS=()

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $1"; }

check_and_restore() {
  local local_file="$1"
  local cos_key="$2"
  local description="$3"
  local grep_pattern="$4"  # optional: verify content, not just existence

  if [ -f "$PROJECT/$local_file" ]; then
    if [ -n "$grep_pattern" ]; then
      if grep -q "$grep_pattern" "$PROJECT/$local_file"; then
        PASS=$((PASS + 1))
        log "✅ $description: exists + content OK"
        return 0
      else
        FAIL=$((FAIL + 1))
        log "⚠️  $description: exists but content TAMPERED (missing: $grep_pattern)"
      fi
    else
      PASS=$((PASS + 1))
      log "✅ $description: exists"
      return 0
    fi
  else
    FAIL=$((FAIL + 1))
    log "❌ $description: MISSING ($local_file)"
  fi

  # Try restore from COS
  log "   → Attempting restore from COS: $cos_key"
  cd "$PROJECT"
  python3 - "$cos_key" "$local_file" << 'PYEOF'
import sys
from qcloud_cos import CosConfig, CosS3Client
import os

config = CosConfig(
    Region=os.environ['COS_REGION'],
    SecretId=os.environ['COS_SECRET_ID'],
    SecretKey=os.environ['COS_SECRET_KEY']
)
client = CosS3Client(config)
bucket = os.environ['COS_BUCKET']
cos_key = sys.argv[1]
local_file = sys.argv[2]

try:
    resp = client.get_object(Bucket=bucket, Key=cos_key)
    content = resp['Body'].read()
    os.makedirs(os.path.dirname(local_file) if os.path.dirname(local_file) else '.', exist_ok=True)
    with open(local_file, 'wb') as f:
        f.write(content)
    print(f"   ✅ Restored from COS ({len(content)} bytes)")
    sys.exit(0)
except Exception as e:
    print(f"   ❌ COS restore failed: {e}")
    sys.exit(1)
PYEOF

  if [ $? -eq 0 ]; then
    RESTORED=$((RESTORED + 1))
    # Re-verify after restore
    if [ -f "$PROJECT/$local_file" ]; then
      if [ -n "$grep_pattern" ] && grep -q "$grep_pattern" "$PROJECT/$local_file"; then
        log "   ✅ Restored + verified"
      else
        log "   ⚠️  Restored but content check still fails"
      fi
    fi
    # Make scripts executable
    if [[ "$local_file" == scripts/* ]]; then
      chmod +x "$PROJECT/$local_file"
    fi
  fi
}

log "=== 🐕 Taskboard Watchdog ==="

# ── Check 1: TASKBOARD.md exists ──
check_and_restore "TASKBOARD.md" "$COS_PREFIX/TASKBOARD.md" "TASKBOARD.md" ""

# ── Check 2: check-taskboard.sh exists + executable ──
check_and_restore "scripts/check-taskboard.sh" "$COS_PREFIX/check-taskboard.sh" "check-taskboard.sh" "TASKBOARD GATE"
if [ -f "$PROJECT/scripts/check-taskboard.sh" ] && [ ! -x "$PROJECT/scripts/check-taskboard.sh" ]; then
  chmod +x "$PROJECT/scripts/check-taskboard.sh"
  log "   🔧 Made check-taskboard.sh executable"
fi

# ── Check 3: deploy.sh has Step 0 gate ──
check_and_restore "scripts/deploy.sh" "$COS_PREFIX/deploy.sh" "deploy.sh gate" "Taskboard gate"

# ── Check 4: pre-push hook installed ──
check_and_restore ".git/hooks/pre-push" "$COS_PREFIX/pre-push-hook" "pre-push hook" "TASKBOARD"
if [ -f "$PROJECT/.git/hooks/pre-push" ] && [ ! -x "$PROJECT/.git/hooks/pre-push" ]; then
  chmod +x "$PROJECT/.git/hooks/pre-push"
  log "   🔧 Made pre-push hook executable"
fi

# ── Check 5: AGENTS.md has taskboard rule ──
check_and_restore "AGENTS.md" "$COS_PREFIX/AGENTS.md" "AGENTS.md taskboard rule" "TASKBOARD"

# ── Check 6: Run actual verification ──
log "--- Running taskboard verification ---"
if [ -f "$PROJECT/scripts/check-taskboard.sh" ]; then
  cd "$PROJECT"
  bash scripts/check-taskboard.sh 2>&1 | tail -5
fi

# ── Summary ──
log "=== Summary ==="
log "  ✅ Intact: $PASS  ❌ Missing/Tampered: $FAIL  🔄 Restored: $RESTORED"

if [ "$FAIL" -gt 0 ] && [ "$RESTORED" -eq "$FAIL" ]; then
  log "🟡 All issues auto-restored from COS"
elif [ "$FAIL" -gt 0 ]; then
  log "🔴 Some issues could not be auto-restored! Manual intervention needed."
fi

# ── Alert logic (write to file for Hermes cron to pick up) ──
if [ "$FAIL" -gt 0 ]; then
  NOW=$(date +%s)
  SHOULD_ALERT=true

  if [ -f "$ALERT_FILE" ]; then
    LAST=$(cat "$ALERT_FILE")
    DIFF=$((NOW - LAST))
    if [ "$DIFF" -lt "$ALERT_COOLDOWN" ]; then
      SHOULD_ALERT=false
      log "   (Alert suppressed — last alert ${DIFF}s ago, cooldown ${ALERT_COOLDOWN}s)"
    fi
  fi

  if [ "$SHOULD_ALERT" = true ]; then
    echo "$NOW" > "$ALERT_FILE"
    ALERT_MSG="🐕 Taskboard Watchdog: $FAIL issue(s) detected, $RESTORED auto-restored from COS. Run 'bash scripts/check-taskboard.sh' for details."
    log "$ALERT_MSG"
    # Write alert for Hermes to pick up
    echo "$ALERT_MSG" > /tmp/taskboard-watchdog-alert.txt
  fi
fi

log "=== Done ==="
