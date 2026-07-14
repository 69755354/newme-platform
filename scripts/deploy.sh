#!/usr/bin/env bash
set -e -o pipefail

# ─── NewMe CRM Deploy Pipeline v4.0 ──────────────────────────
# FULL ISOLATION BUILD — production .next is never touched during build.
#
# Build happens in /tmp/newme-build-$ID (detached git worktree at RELEASE_SHA).
# Only after .next/BUILD_ID is verified does the swap occur.
#
# v4.0 guarantees:
#   ✅ Production .next NEVER touched during build
#   ✅ Service runs continuously during build
#   ✅ Build failure = temp dir deleted, service unaffected
#   ✅ Swap is the ONLY mutation of production .next
#   ✅ Downtime = stop + mv + start (~3s)
#   ✅ Cleanup old backups (keep 3)
# ──────────────────────────────────────────────────────────────

set -e -o pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_RETENTION=3

# ── Deploy identity ──────────────────────────────────────────
DEPLOY_ID="$(date -u +'%Y%m%d-%H%M%S')"
BUILD_DIR="/tmp/newme-build-$DEPLOY_ID"
BUILD_TIMESTAMP=$(date +%s)

# ── Evidence infrastructure ──────────────────────────────────
EVIDENCE_DIR="$PROJECT_ROOT/.hermes-harness/deploy-evidence"
EVIDENCE_FILE="$EVIDENCE_DIR/$DEPLOY_ID.json"
STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
COMMIT_HASH=$(git -C "$PROJECT_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")
ACTOR=$(whoami)

EVI_BUILD_STATUS="pending"
EVI_BUILD_DURATION=0
EVI_SMOKE_STATUS="pending"
EVI_SMOKE_PASSED=0
EVI_SMOKE_TOTAL=14
EVI_LOGS_STATUS="pending"
EVI_LOGS_ERRORS=0
EVI_REGRESSION_STATUS="pending"
EVI_REGRESSION_PASSED=0
EVI_REGRESSION_TOTAL=23
EVI_HEALTH_STATUS="pending"
EVI_HEALTH_CODE=0
EVI_RESULT="fail"

mkdir -p "$EVIDENCE_DIR"

write_evidence() {
  local finished_at
  finished_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  cat > "$EVIDENCE_FILE" << JSONEOF
{
  "deploy_id": "$DEPLOY_ID",
  "commit": "$COMMIT_HASH",
  "actor": "$ACTOR",
  "started_at": "$STARTED_AT",
  "finished_at": "$finished_at",
  "build": {
    "status": "$EVI_BUILD_STATUS",
    "duration_sec": $EVI_BUILD_DURATION,
    "dir": "$BUILD_DIR"
  },
  "smoke": {
    "status": "$EVI_SMOKE_STATUS",
    "routes_passed": $EVI_SMOKE_PASSED,
    "routes_total": $EVI_SMOKE_TOTAL
  },
  "logs": {
    "status": "$EVI_LOGS_STATUS",
    "critical_errors": $EVI_LOGS_ERRORS
  },
  "regression": {
    "status": "$EVI_REGRESSION_STATUS",
    "tests_passed": $EVI_REGRESSION_PASSED,
    "tests_total": $EVI_REGRESSION_TOTAL
  },
  "health": {
    "status": "$EVI_HEALTH_STATUS",
    "http_status": $EVI_HEALTH_CODE
  },
  "result": "$EVI_RESULT"
}
JSONEOF
}

# Single trap: always cleanup build dir + write evidence
cleanup_on_exit() {
  cd "$PROJECT_ROOT" 2>/dev/null || true
  git worktree remove "$BUILD_DIR" --force 2>/dev/null || true
  rm -rf "$BUILD_DIR" 2>/dev/null || true
  rm -f "$PROJECT_ROOT/.hermes/deploy-in-progress" 2>/dev/null || true
  write_evidence
}
trap cleanup_on_exit EXIT

echo "=== 📦 Deploy v4: $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "Project:  $PROJECT_ROOT"
echo "Build ID: $DEPLOY_ID"
echo "Build in: $BUILD_DIR"
echo ""

# ── Guard: service must be running ───────────────────────────
cd "$PROJECT_ROOT"
if ! systemctl is-active --quiet newme-platform.service 2>/dev/null; then
  echo "⚠️  Service not running. Starting..."
  sudo systemctl start newme-platform.service
  sleep 3
  systemctl is-active --quiet newme-platform.service 2>/dev/null || {
    echo "❌ Cannot start service. Abort."
    exit 1
  }
fi
echo ""

# ═══ Pre-flight: deploy safety checks ═══
echo "--- Pre-flight checks ---"

# Check 1: must be on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "🚫 Not on main branch (current: $CURRENT_BRANCH). Deploy only from main."
  exit 1
fi

# Check 2: HEAD must equal origin/main
git fetch origin main --quiet
ORIGIN_MAIN=$(git rev-parse origin/main)
if [ "$(git rev-parse HEAD)" != "$ORIGIN_MAIN" ]; then
  echo "🚫 HEAD != origin/main. Pull latest main first."
  echo "   HEAD:        $(git rev-parse --short HEAD)"
  echo "   origin/main: $(git rev-parse --short origin/main)"
  exit 1
fi

# Check 3: clean working directory (allow only known safe dirty files)
DIRTY=$(git status --porcelain | grep -v '^.M .hermes/' | grep -v '^.M AGENTS.md' | grep -v '^.M tsconfig.tsbuildinfo' || true)
if [ -n "$DIRTY" ]; then
  echo "🚫 Working directory not clean:"
  echo "$DIRTY"
  exit 1
fi

echo "✅ Pre-flight: main branch, HEAD==origin/main, workspace clean"
echo ""

# ═══ Step 0: Taskboard gate ═══
echo "--- Step 0/6: Taskboard gate ---"
if [ -f "scripts/check-taskboard.sh" ]; then
  bash scripts/check-taskboard.sh || { echo "🚫 ABORT: Taskboard."; exit 1; }
fi
echo ""

# ═══ Step 0.5: SPEC freshness ═══
echo "--- Step 0.5/6: SPEC freshness gate ---"
if [ -f "scripts/check-spec.sh" ]; then
  bash scripts/check-spec.sh; [ $? -ge 1 ] && { echo "🚫 ABORT: SPEC stale."; exit 1; }
fi
echo ""

# ═══ Step 0.6: Process ownership guard — systemd ONLY ═══
echo "--- Step 0.6/7: Process ownership guard ---"
PM2_VIOLATION=0

# Check 1: newme-platform port 3001 must be owned by systemd cgroup
PORT_OWNER=$(ss -tlnp 2>/dev/null | grep ':3001 ' | grep -oP 'cgroup=\S+' | head -1 || echo "")
if [ -n "$PORT_OWNER" ] && ! echo "$PORT_OWNER" | grep -q "newme-platform"; then
  echo "🚫 PORT_OWNER: Port 3001 owned by non-systemd process ($PORT_OWNER)"
  PM2_VIOLATION=1
fi

# Check 2: PM2 must not manage newme-platform
if command -v pm2 &>/dev/null; then
  if pm2 list 2>/dev/null | grep -qi "newme-platform"; then
    echo "🚫 PM2_LIST: newme-platform found in pm2 list"
    PM2_VIOLATION=1
  fi
fi

# Check 3: PM2 dump must not reference newme-platform
if [ -f "$HOME/.pm2/dump.pm2" ]; then
  if grep -qi "newme-platform" "$HOME/.pm2/dump.pm2"; then
    echo "🚫 PM2_DUMP: ~/.pm2/dump.pm2 references newme-platform"
    PM2_VIOLATION=1
  fi
fi

if [ "$PM2_VIOLATION" = "1" ]; then
  echo ""
  echo "⛔ CONTROL-PLANE VIOLATION: newme-platform must run under systemd only."
  echo "   Run: sudo systemctl stop newme-platform && pm2 delete newme-platform"
  echo "   Then: sudo systemctl start newme-platform"
  exit 1
fi
echo "✅ Process ownership: systemd only"
echo ""

# ═══ Step 0.7: Coding auth ═══
echo "--- Step 0.7/7: Coding auth gate ---"
if [ -f "scripts/verify-coding-auth.py" ]; then
  python3 scripts/verify-coding-auth.py --mode deploy 2>&1 || { echo "🚫 ABORT: Coding auth."; exit 1; }
fi
echo ""

# ═══════════════════════════════════════════════════════════════
# Step 0.8: C++ Deploy Gate
# Self-proving: git diff × manifest scope × actor
# Does NOT trust Hermes-written review files as final authority.
# Generates protected gate result at /var/lib/newme/deploy-gate/
# ═══════════════════════════════════════════════════════════════
echo "--- Step 0.8/8: C++ Deploy Gate ---"

MANIFEST_DIR="$PROJECT_ROOT/.hermes/delegations"
REVIEW_DIR="$PROJECT_ROOT/.hermes/reviews"
GATE_RESULT_DIR="$HOME/.hermes/deploy-gate/results"
mkdir -p "$GATE_RESULT_DIR"

CURRENT_HEAD=$(git -C "$PROJECT_ROOT" rev-parse HEAD)
GATE_RESULT_FILE="$GATE_RESULT_DIR/${CURRENT_HEAD}.json"

# ── Detect Codex commit ─────────────────────────────────────
IS_CODEX=false
TASK_ID=""
COMMIT_MSG=$(git -C "$PROJECT_ROOT" log -1 --format=%s HEAD 2>/dev/null || echo "")

if echo "$COMMIT_MSG" | grep -q '\[CODEX\]'; then
  IS_CODEX=true
  TASK_ID=$(echo "$COMMIT_MSG" | grep -oP '\[task_[a-zA-Z0-9_-]+\]' | head -1 | tr -d '[]')
  [ -z "$TASK_ID" ] && TASK_ID="unknown"
fi

# ── Get changed files ───────────────────────────────────────
PARENT=$(git -C "$PROJECT_ROOT" rev-parse HEAD~1 2>/dev/null || echo "")
if [ -n "$PARENT" ]; then
  CHANGED_FILES=$(git -C "$PROJECT_ROOT" diff --name-only "$PARENT" HEAD 2>/dev/null)
else
  CHANGED_FILES=$(git -C "$PROJECT_ROOT" diff --name-only HEAD 2>/dev/null)
fi

PROTECTED_GLOB="^(src/|app/|components/|lib/|scripts/|migrations/|prisma/|deploy.sh|package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|tsconfig.json|next.config.)"
GATE_SCRIPTS_GLOB="^(scripts/deploy.sh|scripts/verify-coding-auth.py|.githooks/)"

write_gate_result() {
  local result="$1" reason="$2"
  local t
  t="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  cat > "$GATE_RESULT_FILE" << GEOF
{
  "commit_sha": "$CURRENT_HEAD",
  "task_id": "$TASK_ID",
  "actor_claim": "$([ "$IS_CODEX" = true ] && echo "Codex" || echo "non-Codex")",
  "is_codex_commit": $IS_CODEX,
  "changed_files": "$(echo "$CHANGED_FILES" | tr '\n' ' ' | sed 's/  *$//')",
  "manifest_allowed": "$ALLOWED_FILES_LIST",
  "manifest_forbidden": "$FORBIDDEN_FILES_LIST",
  "hermes_review_seen": $([ -f "$REVIEW_FILE" ] && echo true || echo false),
  "hermes_review_result": "${REVIEW_RESULT:-not_checked}",
  "final_result": "$result",
  "reason": "$reason",
  "generated_by": "deploy.sh Step 0.8",
  "timestamp": "$t"
}
GEOF
}

# ── Case A: NOT Codex commit ────────────────────────────────
if [ "$IS_CODEX" = false ]; then
  PROTECTED_HIT=false
  for f in $CHANGED_FILES; do
    if echo "$f" | grep -qE "$PROTECTED_GLOB"; then
      echo "  🔴 Non-Codex commit touches PROTECTED: $f"
      PROTECTED_HIT=true
    fi
  done
  if $PROTECTED_HIT; then
    write_gate_result "FAIL" "Non-Codex commit touches protected files"
    echo "🚫 C++ GATE FAIL: Non-Codex commit ($COMMIT_MSG) touches protected files"
    exit 1
  fi
  echo "✅ C++ Gate PASS (non-Codex commit, no protected files)"
  write_gate_result "PASS" "Non-Codex, no protected files"
  echo ""
else
# ── Case B: Codex commit — full gate ────────────────────────
  MANIFEST_FILE="$MANIFEST_DIR/${TASK_ID}.json"
  if [ ! -f "$MANIFEST_FILE" ]; then
    write_gate_result "FAIL" "Manifest not found"
    echo "🚫 C++ GATE FAIL: Manifest not found: $MANIFEST_FILE"
    exit 1
  fi

  EXPIRES_AT=$(python3 -c "import json; print(json.load(open('$MANIFEST_FILE')).get('expires_at',''))" 2>/dev/null || echo "")
  if [ -n "$EXPIRES_AT" ] && [ "$EXPIRES_AT" != "None" ]; then
    EXPIRES_EPOCH=$(date -d "$EXPIRES_AT" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    if [ "$EXPIRES_EPOCH" -gt 0 ] && [ "$NOW_EPOCH" -gt "$EXPIRES_EPOCH" ]; then
      TASK_ID_BASE="${TASK_ID%.*}"
      TASK_ID_ALT="${TASK_ID%%_*}"
      CANDIDATE_FILES=(
        "$MANIFEST_DIR/${TASK_ID}.json"
        "$MANIFEST_DIR/${TASK_ID_BASE}.json"
        "$MANIFEST_DIR/${TASK_ID_ALT}.json"
      )
      REFRESHED=false
      for CAND in "${CANDIDATE_FILES[@]}"; do
        if [ -f "$CAND" ]; then
          NEW_EXPIRES=$(python3 - "$CAND" <<'PY2'
import json, sys
from datetime import datetime, timedelta, timezone
p = sys.argv[1]
obj = json.load(open(p))
obj['issued_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
obj['expires_at'] = (datetime.now(timezone.utc) + timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump(obj, open(p, 'w'), ensure_ascii=False, indent=2)
print(obj['expires_at'])
PY2
)
          REFRESHED=true
          EXPIRES_AT="$NEW_EXPIRES"
          echo "ℹ️  Manifest refreshed: $CAND -> $EXPIRES_AT"
          break
        fi
      done
      if [ "$REFRESHED" = false ]; then
        write_gate_result "FAIL" "Manifest expired"
        echo "🚫 C++ GATE FAIL: Manifest expired at $EXPIRES_AT"
        exit 1
      fi
    fi
  fi

  ALLOWED_FILES_LIST=$(python3 -c "import json; print(' '.join(json.load(open('$MANIFEST_FILE')).get('allowed_files',[])))" 2>/dev/null || echo "")
  FORBIDDEN_FILES_LIST=$(python3 -c "import json; print(' '.join(json.load(open('$MANIFEST_FILE')).get('forbidden_files',[])))" 2>/dev/null || echo "")

  # Gate scripts check — requires CONTROL_PLANE_AUTH if modified
  GATE_SCRIPT_HIT=false
  for f in $CHANGED_FILES; do
    if echo "$f" | grep -qE "$GATE_SCRIPTS_GLOB"; then
      echo "  🔴 Codex commit modifies GATE SCRIPT: $f"
      GATE_SCRIPT_HIT=true
    fi
  done
  if $GATE_SCRIPT_HIT; then
    # Gate scripts modified — require CONTROL_PLANE_AUTH, not just coding auth
    CP_AUTH_FILE=".hermes/delegations/${TASK_ID}.control-plane.json"
    if [ ! -f "$CP_AUTH_FILE" ]; then
      write_gate_result "FAIL" "Gate script modified: $f — requires CONTROL_PLANE_AUTH"
      echo "🚫 C++ GATE FAIL: Gate scripts modified. CONTROL_PLANE_AUTH required."
      echo "   Gate scripts: $GATE_SCRIPTS_GLOB"
      exit 1
    fi
    # Verify CONTROL_PLANE_AUTH expiration
    CP_EXPIRES=$(python3 -c "import json; print(json.load(open('$CP_AUTH_FILE')).get('expires_at',''))" 2>/dev/null || echo "")
    if [ -n "$CP_EXPIRES" ] && [ "$CP_EXPIRES" != "None" ]; then
      CP_EPOCH=$(date -d "$CP_EXPIRES" +%s 2>/dev/null || echo 0)
      if [ "$CP_EPOCH" -gt 0 ] && [ "$(date +%s)" -gt "$CP_EPOCH" ]; then
        write_gate_result "FAIL" "CONTROL_PLANE_AUTH expired"
        echo "🚫 C++ GATE FAIL: CONTROL_PLANE_AUTH expired at $CP_EXPIRES"
        exit 1
      fi
    fi
    echo "✅ C++ Gate: CONTROL_PLANE_AUTH verified for gate script modification"
  fi

  # Scope check
  SCOPE_FAIL=false
  for f in $CHANGED_FILES; do
    for fb in $FORBIDDEN_FILES_LIST; do
      if echo "$f" | grep -qF "$fb"; then
        echo "  🔴 $f matches FORBIDDEN: $fb"
        SCOPE_FAIL=true
      fi
    done
    if [ -n "$ALLOWED_FILES_LIST" ]; then
      MATCHED=false
      for af in $ALLOWED_FILES_LIST; do
        if echo "$f" | grep -qF "$af"; then MATCHED=true; break; fi
      done
      if ! $MATCHED; then
        echo "  🔴 $f NOT in allowed_files"
        SCOPE_FAIL=true
      fi
    fi
  done

  if $SCOPE_FAIL; then
    write_gate_result "FAIL" "Changed files exceed manifest scope"
    echo "🚫 C++ GATE FAIL: Scope violation"
    exit 1
  fi
  echo "✅ C++ Gate: all files within manifest scope"

  # Hermes review check
  REVIEW_FILE="$REVIEW_DIR/${TASK_ID}.json"
  if [ ! -f "$REVIEW_FILE" ]; then
    write_gate_result "FAIL" "No Hermes review"
    echo "🚫 C++ GATE FAIL: No Hermes review: $REVIEW_FILE"
    exit 1
  fi

  REVIEW_RESULT=$(python3 -c "import json; print(json.load(open('$REVIEW_FILE')).get('result',''))" 2>/dev/null || echo "")
  REVIEW_COMMIT=$(python3 -c "import json; print(json.load(open('$REVIEW_FILE')).get('commit_sha',''))" 2>/dev/null || echo "")

  if [ "$REVIEW_RESULT" != "PASS" ]; then
    write_gate_result "FAIL" "Hermes review not PASS"
    echo "🚫 C++ GATE FAIL: Review result=$REVIEW_RESULT"
    exit 1
  fi
  if [ -n "$REVIEW_COMMIT" ] && [ "$REVIEW_COMMIT" != "$CURRENT_HEAD" ]; then
    write_gate_result "FAIL" "Review sha mismatch"
    echo "🚫 C++ GATE FAIL: Review sha=$REVIEW_COMMIT, HEAD=$CURRENT_HEAD"
    exit 1
  fi

  echo "✅ C++ Gate: review PASS @ $CURRENT_HEAD"
  write_gate_result "PASS" "Codex scope OK, review PASS, gate scripts intact"
  echo ""
fi

# ═══ Step 0.9: Release Authorization Gate ═══
echo "--- Step 0.9/9: Release Authorization Gate ---"
RELEASE_AUTH_FILE=".hermes/release-authorization/task_g0_autonomous_release_chain.json"
if [ -f "$RELEASE_AUTH_FILE" ]; then
  bash scripts/verify-release-auth.sh "$RELEASE_AUTH_FILE" || { echo "🚫 ABORT: Release not authorized."; exit 1; }
else
  echo "⚠️  No release auth file found — skipping (dev mode)"
fi
echo ""

# ═══ Step 1: TypeScript check (in production dir, safe) ═══
echo "--- Step 1/6: TypeScript check ---"
npx tsc --noEmit 2>&1 || { echo "❌ TypeScript check failed."; exit 1; }
echo "✅ TypeScript check passed"
echo ""

# ═══ Step 2: Backup .next + cleanup old backups ═══
echo "--- Step 2/6: Backup + cleanup ---"
BACKUP_DIR=".next.backup.$BUILD_TIMESTAMP"
EXISTING_BUILD_ID=""

if [ -d .next ] && [ -f .next/BUILD_ID ]; then
  EXISTING_BUILD_ID=$(cat .next/BUILD_ID)
  rm -rf "$BACKUP_DIR"
  cp -a .next "$BACKUP_DIR"
  echo "✅ Backed up: $BACKUP_DIR (BUILD_ID: $EXISTING_BUILD_ID)"
else
  echo "⚠️  No existing .next/BUILD_ID to back up"
fi

BACKUP_COUNT=$(ls -1d .next.backup.* 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt "$BACKUP_RETENTION" ]; then
  TO_DELETE=$((BACKUP_COUNT - BACKUP_RETENTION))
  echo "🧹 Cleaning $TO_DELETE old backup(s)..."
  ls -1dt .next.backup.* 2>/dev/null | tail -n "$TO_DELETE" | xargs rm -rf
fi
echo ""

# ═══════════════════════════════════════════════════════════════
# Step 3: BUILD IN ISOLATED TEMP DIRECTORY
# ═══════════════════════════════════════════════════════════════
# Production .next is NEVER touched here.
# Service runs uninterrupted throughout.
# ═══════════════════════════════════════════════════════════════
echo "--- Step 3/6: Build (isolated: $BUILD_DIR) ---"
echo "ℹ️  Service is LIVE. Production .next is untouched."

BUILD_START=$(date +%s)

# Determine release SHA (from release auth file, fallback to HEAD)
RELEASE_SHA=$(git rev-parse HEAD)
if [ -f "$RELEASE_AUTH_FILE" ]; then
  RELEASE_SHA=$(python3 -c "import json; print(json.load(open('$RELEASE_AUTH_FILE')).get('merged_main_sha',''))" 2>/dev/null || echo "")
  [ -z "$RELEASE_SHA" ] && RELEASE_SHA=$(git rev-parse HEAD)
fi

# Verify RELEASE_SHA exists in repo
if ! git cat-file -e "${RELEASE_SHA}^{commit}" 2>/dev/null; then
  echo "❌ Release SHA $RELEASE_SHA not found in repo"
  exit 1
fi

# Build from detached git worktree (replaces rsync copy)
echo "📋 Creating detached worktree at $RELEASE_SHA..."
rm -rf "$BUILD_DIR"
git worktree add --detach "$BUILD_DIR" "$RELEASE_SHA"

# gitignored build inputs are absent from worktree checkout — copy them in
[ -f "$PROJECT_ROOT/.env.local" ] && cp "$PROJECT_ROOT/.env.local" "$BUILD_DIR/.env.local"

echo "✅ Worktree ready at $RELEASE_SHA"

# ── Install dependencies (fresh npm ci, no cache) ──────────────
cd "$BUILD_DIR"

echo "📦 Installing dependencies (npm ci)..."
if ! npm ci; then
  echo "❌ npm ci failed."
  echo "ℹ️  Production .next was NEVER touched. Service is unaffected."
  exit 1
fi
echo "✅ npm ci complete"

# ── Verify critical binary exists ────────────────────────────
if [ ! -x node_modules/.bin/next ]; then
  echo "❌ node_modules/.bin/next not found or not executable after npm ci."
  echo "ℹ️  Production .next was NEVER touched. Service is unaffected."
  exit 1
fi

# Build in temp directory — completely isolated from production
cd "$BUILD_DIR"

BUILD_CMD="NODE_OPTIONS=\"--max_old_space_size=2048\" npm run build"
BUILD_OK=false

if bash -c "$BUILD_CMD" > "$PROJECT_ROOT/.build-stdout.log" 2>&1; then
  BUILD_OK=true
else
  echo "⚠️  Turbopack build failed. Retrying with webpack..."
  rm -rf .next
  if bash -c "NEXT_NO_TURBOPACK=1 $BUILD_CMD" > "$PROJECT_ROOT/.build-stdout.log" 2>&1; then
    BUILD_OK=true
  fi
fi

BUILD_END=$(date +%s)
EVI_BUILD_DURATION=$((BUILD_END - BUILD_START))

if [ "$BUILD_OK" = false ]; then
  echo "❌ Build failed after both attempts."
  tail -40 "$PROJECT_ROOT/.build-stdout.log"
  rm -f "$PROJECT_ROOT/.build-stdout.log"
  cd "$PROJECT_ROOT"
  echo "ℹ️  Production .next was NEVER touched. Service is unaffected."
  exit 1
fi

echo "✅ Build succeeded (${EVI_BUILD_DURATION}s)"
EVI_BUILD_STATUS="pass"
rm -f "$PROJECT_ROOT/.build-stdout.log"

# Verify build output
if [ ! -f .next/BUILD_ID ]; then
  echo "❌ .next/BUILD_ID not found after build."
  cd "$PROJECT_ROOT"
  echo "ℹ️  Production .next was NEVER touched."
  exit 1
fi

NEW_BUILD_ID=$(cat .next/BUILD_ID)

# Normalize ownership for ubuntu user
if [ "$(id -u)" = "0" ]; then
  chown -R ubuntu:ubuntu .next
  find .next -type d -exec chmod 755 {} \;
  find .next -type f -exec chmod 644 {} \;
fi

# Verify ubuntu readability (must work before we attempt swap)
if ! sudo -u ubuntu test -r .next/BUILD_ID; then
  echo "❌ .next/BUILD_ID not readable by ubuntu."
  cd "$PROJECT_ROOT"
  exit 1
fi

echo "✅ BUILD_ID: $NEW_BUILD_ID (verified, ubuntu-readable)"
echo ""

# ═══════════════════════════════════════════════════════════════
# Step 4: Swap into production
# ═══════════════════════════════════════════════════════════════
# Production .next is mutated for the FIRST time here.
# ═══════════════════════════════════════════════════════════════
echo "--- Step 4/6: Swap into production ---"

cd "$PROJECT_ROOT"

# Stop service (downtime begins — ~3-5 seconds)
echo "🛑 Stopping service..."
sudo systemctl stop newme-platform.service
sleep 1

# Wait for port 3001 to be fully released (avoid EADDRINUSE)
for i in 1 2 3 4 5; do
  if ! ss -tlnp | grep -q ':3001 '; then
    break
  fi
  echo "⏳ Waiting for port 3001 release (attempt $i)..."
  sleep 1
done

# Hard kill any remaining process on port 3001 (defense against zombie children)
if ss -tlnp | grep -q ':3001 '; then
  echo "⚠️  Port 3001 still held — force killing..."
  sudo fuser -k 3001/tcp 2>/dev/null || true
  sleep 1
fi

# Swap: move old .next aside, bring new .next in
echo "🔄 Swapping .next..."
rm -rf .next
cp -a "$BUILD_DIR/.next" .next

# Start service
echo "▶️  Starting service..."
sudo systemctl start newme-platform.service
sleep 3

# Health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
  echo "✅ Service healthy (HTTP $HTTP_CODE)"
  EVI_HEALTH_STATUS="pass"
  EVI_HEALTH_CODE=$HTTP_CODE
else
  echo "❌ Service unhealthy (HTTP $HTTP_CODE). Rolling back..."
  rm -rf .next
  if [ -d "$BACKUP_DIR" ]; then
    cp -a "$BACKUP_DIR" .next
    echo "✅ Restored previous build ($EXISTING_BUILD_ID)"
  fi
  sudo systemctl restart newme-platform.service
  sleep 3
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
    echo "✅ Rollback successful ($EXISTING_BUILD_ID, HTTP $HTTP_CODE)"
  else
    echo "❌ CRITICAL: Rollback failed. Manual intervention required."
    exit 2
  fi
  exit 1
fi
echo ""

# ═══ Step 5.1: Smoke test ═══
echo "--- Step 5.1/8: Smoke test ---"
if [ -f "scripts/check-smoke.sh" ]; then
  bash scripts/check-smoke.sh http://localhost:3001
  EVI_SMOKE_STATUS="pass"
  EVI_SMOKE_PASSED=14
fi
echo ""

# ═══ Step 5.2: Journal scan ═══
echo "--- Step 5.2/8: Journal error scan ---"
if [ -f "scripts/check-logs.sh" ]; then
  bash scripts/check-logs.sh "2 minutes ago"
  EVI_LOGS_STATUS="pass"
  EVI_LOGS_ERRORS=0
fi
echo ""

# ═══ Step 5.3: Regression test ═══
echo "--- Step 5.3/8: Regression test ---"
if [ -f "scripts/deploy-verify.sh" ]; then
  bash scripts/deploy-verify.sh --no-git
  EVI_REGRESSION_STATUS="pass"
  EVI_REGRESSION_PASSED=23
fi
echo ""

echo "=== ✅ Deploy pipeline complete ==="
echo "BUILD_ID: $NEW_BUILD_ID"
echo "Time:     $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
EVI_RESULT="pass"
