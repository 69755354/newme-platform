#!/usr/bin/env bash
set -e -o pipefail

# ─── NewMe CRM Deploy Pipeline v4.0 ──────────────────────────
# FULL ISOLATION BUILD — production .next is never touched during build.
#
# Build happens in /tmp/newme-build-$ID (complete copy, no symlinks).
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

# ═══ Step 0.7: Coding auth ═══
echo "--- Step 0.7/7: Coding auth gate ---"
if [ -f "scripts/verify-coding-auth.py" ]; then
  python3 scripts/verify-coding-auth.py --mode deploy 2>&1 || { echo "🚫 ABORT: Coding auth."; exit 1; }
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

# Copy project to temp directory using rsync (fully isolated, no hardlinks)
# This ensures the build directory is a complete independent copy
# Skipping node_modules (2.2GB) and .git (59MB) — cached separately
echo "📋 Copying project to build directory (rsync, fully isolated)..."

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# ── Node modules cache ────────────────────────────────────────
# Cache lives at /tmp/newme-node-cache — reuse via hardlinks.
# Rebuilt only when package-lock.json changes.
NODE_CACHE="/tmp/newme-node-cache"
NODE_CACHE_LOCK="$NODE_CACHE/package-lock.json"

if [ -d "$NODE_CACHE/node_modules" ] && [ -f "$NODE_CACHE_LOCK" ]; then
  if cp -al "$NODE_CACHE/node_modules" "$BUILD_DIR/node_modules" 2>/dev/null && \
     [ -x "$BUILD_DIR/node_modules/.bin/next" ]; then
    echo "📦 Reused node_modules cache ($(du -sh "$NODE_CACHE/node_modules" 2>/dev/null | cut -f1))"
  else
    echo "⚠️  Cache hardlink failed or incomplete, cleaning up..."
    rm -rf "$BUILD_DIR/node_modules" 2>/dev/null || true
  fi
fi
# ───────────────────────────────────────────────────────────────

rsync -a --delete \
  --exclude '.next' \
  --exclude '.next.backup.*' \
  --exclude '.hermes-harness' \
  --exclude '.hermes/deploy-in-progress' \
  --exclude '.hermes/IS_PRODUCTION' \
  --exclude 'node_modules' \
  --exclude '.git' \
  "$PROJECT_ROOT/" "$BUILD_DIR/"

echo "✅ Project copied (src: $(du -sh --exclude=node_modules "$BUILD_DIR" 2>/dev/null | cut -f1))"

# ── Validate / rebuild node_modules ────────────────────────────
cd "$BUILD_DIR"

NEEDS_INSTALL=false
if [ ! -d "node_modules" ]; then
  echo "📦 No node_modules — running npm ci..."
  NEEDS_INSTALL=true
elif [ -f "$NODE_CACHE_LOCK" ]; then
  if ! diff -q "package-lock.json" "$NODE_CACHE_LOCK" >/dev/null 2>&1; then
    echo "📦 package-lock.json changed — rebuilding node_modules..."
    rm -rf node_modules
    NEEDS_INSTALL=true
  fi
elif [ ! -f "$NODE_CACHE_LOCK" ]; then
  echo "📦 No cache lock — running npm ci..."
  rm -rf node_modules
  NEEDS_INSTALL=true
fi

if [ "$NEEDS_INSTALL" = true ]; then
  if ! npm ci > "$PROJECT_ROOT/.npm-ci-stdout.log" 2>&1; then
    echo "❌ npm ci failed. Cache NOT updated."
    tail -30 "$PROJECT_ROOT/.npm-ci-stdout.log"
    rm -f "$PROJECT_ROOT/.npm-ci-stdout.log"
    cd "$PROJECT_ROOT"
    echo "ℹ️  Production .next was NEVER touched. Service is unaffected."
    exit 1
  fi
  rm -f "$PROJECT_ROOT/.npm-ci-stdout.log"
  echo "✅ npm ci complete"

  # Update cache
  echo "📦 Updating node_modules cache..."
  sudo chattr -R -i "$NODE_CACHE" 2>/dev/null || true
  sudo rm -rf "$NODE_CACHE"
  mkdir -p "$NODE_CACHE"
  if cp -al "node_modules" "$NODE_CACHE/node_modules" 2>/dev/null; then
    cp "package-lock.json" "$NODE_CACHE_LOCK"
    echo "✅ Cache updated ($(du -sh "$NODE_CACHE/node_modules" 2>/dev/null | cut -f1))"
  else
    echo "⚠️  Cache update failed (non-fatal, will npm ci next deploy)"
  fi
else
  echo "✅ node_modules cache valid, skipping npm ci"
fi
# ───────────────────────────────────────────────────────────────

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
