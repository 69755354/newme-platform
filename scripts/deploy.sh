#!/usr/bin/env bash
set -e -o pipefail

# ─── NewMe CRM Deploy Pipeline ───────────────────────────────
# 0. Taskboard gate
# 0.5. SPEC freshness gate
# 1. tsc 类型检查（比build快~10x，提前暴露类型错误）
# 2. 备份当前 .next（build 失败自动回退）
# 3. Build（Turbopack 失败自动降级 webpack）
# 4. 校验 BUILD_ID
# 5. 重启服务 + 健康检查
# 5.1 Smoke test (14 routes)
# 5.2 Journal error scan
# 5.3 Regression test (23 items)
# ──────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

# ── Deploy Evidence Infrastructure ──────────────────────────
DEPLOY_ID="$(date -u +'%Y%m%d-%H%M%S')"
EVIDENCE_DIR=".hermes-harness/deploy-evidence"
EVIDENCE_FILE="$EVIDENCE_DIR/$DEPLOY_ID.json"
STARTED_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
COMMIT_HASH=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
ACTOR=$(whoami)

# Evidence accumulators
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
  # Write current evidence state to JSON file (called on exit)
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
    "duration_sec": $EVI_BUILD_DURATION
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

# Trap: write evidence on exit (success or failure)
trap write_evidence EXIT

echo "=== 📦 Deploy: $(date -u +'%Y-%m-%dT%H:%M:%SZ') ==="
echo "Project: $PROJECT_ROOT"

# ── Step 0: Taskboard gate ─────────────────────────────────
echo "--- Step 0/6: Taskboard gate ---"
if [ -f "scripts/check-taskboard.sh" ]; then
  bash scripts/check-taskboard.sh
  if [ $? -ne 0 ]; then
    echo ""
    echo "🚫 DEPLOY ABORTED: Taskboard verification failed."
    echo "   Complete all ❌ items in TASKBOARD.md, then retry."
    exit 1
  fi
  echo "✅ Taskboard gate passed"
else
  echo "⚠️  scripts/check-taskboard.sh not found, skipping gate"
fi
echo ""

# ── Step 0.5: SPEC freshness gate ─────────────────────────
echo "--- Step 0.5/6: SPEC freshness gate ---"
if [ -f "scripts/check-spec.sh" ]; then
  bash scripts/check-spec.sh
  CHECK_SPEC_EXIT=$?
  if [ "$CHECK_SPEC_EXIT" -ge 1 ]; then
    echo ""
    echo "🚫 DEPLOY ABORTED: SPEC.md is too stale."
    echo "   Update crm-v3/SPEC.md then retry."
    echo "   Quick check: git log --oneline $(git log -1 --format='%H' -- crm-v3/SPEC.md 2>/dev/null || echo 'INITIAL')..HEAD"
    exit 1
  fi
  echo "✅ SPEC freshness gate passed"
else
  echo "⚠️  scripts/check-spec.sh not found, skipping gate"
fi
echo ""

# ── Step 0.7/7: Coding Auth Gate (Ed25519 signature verification) ──
echo "--- Step 0.7/7: Coding auth gate ---"
if [ -f "scripts/verify-coding-auth.py" ]; then
  KEY_FILE="/var/lib/newme/coding-auth/ed25519.key"
  if [ ! -f "$KEY_FILE" ] && [ "$(id -u)" = "0" ]; then
    echo "🔑 Setting up Ed25519 signing key..."
    mkdir -p "$(dirname "$KEY_FILE")"
    chown root:root "$(dirname "$KEY_FILE")"
    chmod 755 "$(dirname "$KEY_FILE")"
    if [ -f "scripts/.ed25519.key.bootstrap" ]; then
      cp "scripts/.ed25519.key.bootstrap" "$KEY_FILE"
      chown root:root "$KEY_FILE"
      chmod 0400 "$KEY_FILE"
      echo "✅ Ed25519 key installed"
    fi
  fi
  if python3 scripts/verify-coding-auth.py --mode deploy 2>&1; then
    echo "✅ Coding auth gate passed"
  else
    echo "🚫 DEPLOY ABORTED: Coding auth verification failed."
    exit 1
  fi
else
  echo "⚠️  verify-coding-auth.py not found, skipping gate"
fi
echo ""

# ── Step 1/7: Pre-flight type check ─────────────────────────
echo "--- Step 1/6: TypeScript check ---"
npx tsc --noEmit 2>&1 || {
  echo "❌ TypeScript check failed. Abort. Run 'npx tsc --noEmit' to see errors."
  exit 1
}
echo "✅ TypeScript check passed"

# ── Step 2: Backup current build ───────────────────────────
echo "--- Step 2/6: Backup current .next ---"
if [ -d .next ] && [ -f .next/BUILD_ID ]; then
  BACKUP_TIMESTAMP=$(date +%s)
  rm -rf ".next.backup.$BACKUP_TIMESTAMP"
  cp -r .next ".next.backup.$BACKUP_TIMESTAMP"
  echo "✅ Backed up to .next.backup.$BACKUP_TIMESTAMP (BUILD_ID: $(cat .next/BUILD_ID))"
else
  echo "⚠️  No existing build to back up"
  BACKUP_TIMESTAMP=""
fi

# ── Step 3: Build ──────────────────────────────────────────
# Build conflicts with a running production server (port 3001 + .next dir).
# Auto-stop the service, build, then Step 5 restarts it.
# guard-prod-build.sh authorizes this via .hermes/deploy-in-progress lock.
echo "--- Step 3/6: Build ---"

# Auto-stop the production service so the build guard in package.json can pass
# and the build can write to .next/ without conflicting with the running process.
SERVICE_WAS_ACTIVE=false
if systemctl is-active --quiet newme-platform.service 2>/dev/null; then
  SERVICE_WAS_ACTIVE=true
  echo "🛑 Stopping newme-platform.service before build..."
  sudo systemctl stop newme-platform.service
  sleep 1
  if systemctl is-active --quiet newme-platform.service 2>/dev/null; then
    echo "❌ Failed to stop newme-platform.service. Abort."
    exit 1
  fi
  echo "✅ Service stopped"
else
  echo "ℹ️  Service was not running — skipping stop"
fi

rm -rf .next

# 🔒 Signal to guard-prod-build.sh that this build is authorized by deploy.sh
DEPLOY_LOCK=".hermes/deploy-in-progress"
trap "rm -f $DEPLOY_LOCK" EXIT
touch "$DEPLOY_LOCK"

FORCE_BUILD=1 NODE_OPTIONS="--max_old_space_size=2048" npm run build 2>&1 && BUILD_OK=true || BUILD_OK=false

if [ "$BUILD_OK" = false ]; then
  echo "⚠️  Turbopack build failed. Retrying with webpack (NEXT_NO_TURBOPACK=1)..."
  rm -rf .next
  FORCE_BUILD=1 NODE_OPTIONS="--max_old_space_size=2048" NEXT_NO_TURBOPACK=1 npm run build 2>&1 && BUILD_OK=true || BUILD_OK=false
fi

# If the build failed permanently, restart the service before bailing out so
# we don't leave the platform down.
if [ "$BUILD_OK" = false ] && [ "$SERVICE_WAS_ACTIVE" = true ]; then
  echo "↩️  Restarting service after failed build..."
  sudo systemctl start newme-platform.service
fi

if [ "$BUILD_OK" = false ]; then
  echo "❌ Build failed after both attempts."
  if [ -n "$BACKUP_TIMESTAMP" ] && [ -d ".next.backup.$BACKUP_TIMESTAMP" ]; then
    echo "↩️  Restoring previous build..."
    rm -rf .next
    mv ".next.backup.$BACKUP_TIMESTAMP" .next
    echo "✅ Previous build restored. Service continues on old binary."
  fi
  exit 1
fi
echo "✅ Build succeeded"
EVI_BUILD_STATUS="pass"

# ── Step 3.5: Normalize build ownership ──────────────────────
# deploy wrapper runs as root → .next is root-owned.
# systemd service runs as ubuntu → must be ubuntu-readable.
echo "--- Step 3.5/8: Normalize build ownership ---"
if [ "$(id -u)" = "0" ]; then
  chown -R ubuntu:ubuntu .next
  find .next -type d -exec chmod 755 {} \;
  find .next -type f -exec chmod 644 {} \;
  echo "✅ .next ownership normalized to ubuntu:ubuntu"
else
  echo "ℹ️  Not running as root — skipping ownership normalization"
fi
echo ""

# ── Step 4: Verify BUILD_ID ────────────────────────────────
echo "--- Step 4/6: Verify BUILD_ID ---"
if [ ! -f .next/BUILD_ID ]; then
  echo "❌ BUILD_ID not found after build. This is a Next.js bug."
  if [ -n "$BACKUP_TIMESTAMP" ] && [ -d ".next.backup.$BACKUP_TIMESTAMP" ]; then
    echo "↩️  Restoring previous build..."
    rm -rf .next
    mv ".next.backup.$BACKUP_TIMESTAMP" .next
    echo "✅ Previous build restored."
  fi
  exit 1
fi
BUILD_ID=$(cat .next/BUILD_ID)
# Verify service user can read BUILD_ID
if ! sudo -u ubuntu test -r .next/BUILD_ID; then
  echo "❌ BUILD_ID not readable by ubuntu user (systemd service user)."
  echo "   .next/ ownership: $(stat -c '%U:%G' .next/)"
  EVI_BUILD_STATUS="fail"
  EVI_RESULT="fail"
  exit 1
fi
echo "✅ BUILD_ID: $BUILD_ID (readable by ubuntu)"

# ── Step 5: Restart + Health check ─────────────────────────
echo "--- Step 5/6: Restart service ---"
sudo systemctl restart newme-platform.service
sleep 3

# Health check — only 200 (OK) or 307 (ISR redirect) are healthy
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
HEALTH_OK=false
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
  HEALTH_OK=true
elif [ "$HTTP_CODE" = "000" ]; then
  echo "❌ Service did not start (connection refused). Restoring previous build..."
  if [ -n "$BACKUP_TIMESTAMP" ] && [ -d ".next.backup.$BACKUP_TIMESTAMP" ]; then
    rm -rf .next
    mv ".next.backup.$BACKUP_TIMESTAMP" .next
    sudo systemctl restart newme-platform.service
    sleep 3
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
      echo "✅ Previous build restored and running (HTTP $HTTP_CODE)"
      echo "⚠️  Deploy failed but service is back on old version"
      exit 1
    else
      echo "❌ CRITICAL: Both new and old builds failed to start"
      exit 2
    fi
  fi
  exit 1
else
  echo "❌ Service returned unhealthy HTTP $HTTP_CODE (expected 200 or 307)."
  echo "   Restoring previous build..."
  if [ -n "$BACKUP_TIMESTAMP" ] && [ -d ".next.backup.$BACKUP_TIMESTAMP" ]; then
    rm -rf .next
    mv ".next.backup.$BACKUP_TIMESTAMP" .next
    sudo systemctl restart newme-platform.service
    sleep 3
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
      echo "✅ Previous build restored and running (HTTP $HTTP_CODE)"
      echo "⚠️  Deploy failed but service is back on old version"
      exit 1
    else
      echo "❌ CRITICAL: Both new and old builds failed to start"
      exit 2
    fi
  fi
  exit 1
fi

echo "✅ Service health check passed (HTTP $HTTP_CODE)"
EVI_HEALTH_STATUS="pass"
EVI_HEALTH_CODE=$HTTP_CODE
echo ""  
echo "=== ✅ Deploy pipeline complete ==="
echo "BUILD_ID: $BUILD_ID"
echo "Time: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
EVI_RESULT="pass"

# ── Step 5.1: Smoke test ──────────────────────────────────
echo "--- Step 5.1/8: Smoke test ---"
if [ -f "scripts/check-smoke.sh" ]; then
  bash scripts/check-smoke.sh http://localhost:3001
  EVI_SMOKE_STATUS="pass"
  EVI_SMOKE_PASSED=14
  echo "✅ Smoke test passed"
else
  echo "⚠️  scripts/check-smoke.sh not found, skipping"
fi
echo ""

# ── Step 5.2: Journal error scan ──────────────────────────
echo "--- Step 5.2/8: Journal error scan ---"
if [ -f "scripts/check-logs.sh" ]; then
  bash scripts/check-logs.sh "2 minutes ago"
  EVI_LOGS_STATUS="pass"
  EVI_LOGS_ERRORS=0
  echo "✅ Journal error scan passed"
else
  echo "⚠️  scripts/check-logs.sh not found, skipping"
fi
echo ""

# ── Step 5.3: Regression test ─────────────────────────────
echo "--- Step 5.3/8: Regression test ---"
if [ -f "scripts/deploy-verify.sh" ]; then
  bash scripts/deploy-verify.sh --no-git
  EVI_REGRESSION_STATUS="pass"
  EVI_REGRESSION_PASSED=23
  echo "✅ Regression test passed"
else
  echo "⚠️  scripts/deploy-verify.sh not found, skipping"
fi
echo ""

echo "=== ✅ Deploy pipeline complete ==="
echo "BUILD_ID: $BUILD_ID"
echo "Time: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
