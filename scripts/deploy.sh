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
# ──────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)

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

# ── Step 1: Pre-flight type check ──────────────────────────
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
# Guard in package.json still protects against accidental `npm run build`
# while the server is up; deploy.sh passes FORCE_BUILD=1 to bypass it.
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
echo "✅ BUILD_ID: $BUILD_ID"

# ── Step 5: Restart + Health check ─────────────────────────
echo "--- Step 5/6: Restart service ---"
sudo systemctl restart newme-platform.service
sleep 3

# Health check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "000" ]; then
  echo "❌ Service did not start. Restoring previous build..."
  if [ -n "$BACKUP_TIMESTAMP" ] && [ -d ".next.backup.$BACKUP_TIMESTAMP" ]; then
    rm -rf .next
    mv ".next.backup.$BACKUP_TIMESTAMP" .next
    sudo systemctl restart newme-platform.service
    sleep 3
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" != "000" ]; then
      echo "✅ Previous build restored and running"
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
echo ""  
echo "=== ✅ Deploy complete ==="
echo "BUILD_ID: $BUILD_ID"
echo "Time: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
