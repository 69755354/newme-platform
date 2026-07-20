#!/usr/bin/env bash
set -euo pipefail

# --- Init ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP=$(date -u +'%Y%m%d-%H%M%S')
GIT_SHA=$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)
RELEASE_ID="${TIMESTAMP}-${GIT_SHA}"
RELEASES_ROOT="/opt/newme/releases"
SHARED_ROOT="/opt/newme/shared"
CURRENT_LINK="/opt/newme/current"
RELEASE_DIR="${RELEASES_ROOT}/${RELEASE_ID}"
BOOTSTRAP_MODE=false

# Check if current exists
if [ -L "$CURRENT_LINK" ] && [ -d "$(readlink -f "$CURRENT_LINK" 2>/dev/null)" ]; then
  PREVIOUS_RELEASE=$(readlink -f "$CURRENT_LINK")
else
  BOOTSTRAP_MODE=true
  PREVIOUS_RELEASE=""
fi

echo "=== Deploy: $RELEASE_ID ==="
echo "Bootstrap: $BOOTSTRAP_MODE"
echo "Previous:  ${PREVIOUS_RELEASE:-none}"

# --- Step 0: Deploy lock ---
LOCKFILE="$PROJECT_ROOT/.hermes/deploy-in-progress"
if [ -f "$LOCKFILE" ]; then
  LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCKFILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -gt 1800 ]; then
    echo "⚠️  Stale lock ($LOCK_AGE s) — overriding"
  else
    echo "❌ Deploy already in progress (lock age: ${LOCK_AGE}s)"
    exit 1
  fi
fi
echo "$RELEASE_ID" > "$LOCKFILE"

# --- Step 0.5: Disk check ---
AVAIL_KB=$(df --output=avail /opt 2>/dev/null | tail -1 | tr -d ' ')
if [ "${AVAIL_KB:-0}" -lt 8388608 ]; then
  echo "❌ Disk < 8GB available on /opt (${AVAIL_KB}KB). NO-GO."
  rm -f "$LOCKFILE"
  exit 1
fi
echo "✅ Disk: $(( AVAIL_KB / 1024 / 1024 ))GB available"

# --- Step 1: Build in isolated worktree ---
echo "--- Build ---"
BUILD_WORKTREE="/tmp/newme-build-${RELEASE_ID}"
git -C "$PROJECT_ROOT" worktree add --detach "$BUILD_WORKTREE" "$GIT_SHA" 2>/dev/null || {
  # Retry: remove stale worktree
  git -C "$PROJECT_ROOT" worktree remove --force "$BUILD_WORKTREE" 2>/dev/null || true
  git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
  git -C "$PROJECT_ROOT" worktree add --detach "$BUILD_WORKTREE" "$GIT_SHA"
}

# Copy env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  cp "$PROJECT_ROOT/.env.local" "$BUILD_WORKTREE/.env.local"
fi

# Build
cd "$BUILD_WORKTREE"
if [ ! -d node_modules ]; then
  npm install --ignore-scripts 2>&1 | tail -3
fi

if ! NODE_OPTIONS="--max_old_space_size=2048" npm run build 2>&1 | tail -10; then
  echo "❌ Build failed"
  cd "$PROJECT_ROOT"
  rm -rf "$BUILD_WORKTREE" 2>/dev/null
  git -C "$PROJECT_ROOT" worktree prune 2>/dev/null
  rm -f "$LOCKFILE"
  exit 1
fi

BUILD_ID=$(cat .next/BUILD_ID 2>/dev/null || echo "unknown")
echo "✅ Build: BUILD_ID=$BUILD_ID"

# --- Step 2: Create release directory ---
echo "--- Release ---"
mkdir -p "$RELEASE_DIR"
cp -a .next "$RELEASE_DIR/"
cp package.json package-lock.json next.config.ts "$RELEASE_DIR/" 2>/dev/null || true
cp -a public "$RELEASE_DIR/" 2>/dev/null || true
cp "$BUILD_WORKTREE/.env.local" "$RELEASE_DIR/.env.local" 2>/dev/null || true

# Cleanup worktree
cd "$PROJECT_ROOT"
rm -rf "$BUILD_WORKTREE"
git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true

# --- Step 3: Dependency hash ---
LOCK_HASH=$(sha256sum "$RELEASE_DIR/package-lock.json" 2>/dev/null | awk '{print $1}' || echo "none")
DEP_DIR="${SHARED_ROOT}/node_modules/${LOCK_HASH}"

if [ -d "$DEP_DIR" ]; then
  echo "✅ Dependencies cached: $LOCK_HASH"
else
  echo "📦 Installing dependencies..."
  TEMP_DIR=$(mktemp -d)
  cp "$RELEASE_DIR/package.json" "$RELEASE_DIR/package-lock.json" "$TEMP_DIR/"
  (cd "$TEMP_DIR" && npm ci --ignore-scripts 2>&1 | tail -3) || {
    echo "❌ npm ci failed"
    rm -rf "$TEMP_DIR" "$RELEASE_DIR" "$LOCKFILE"
    exit 1
  }
  mkdir -p "$(dirname "$DEP_DIR")"
  mv "$TEMP_DIR/node_modules" "$DEP_DIR"
  rm -rf "$TEMP_DIR"
  echo "✅ Dependencies installed: $LOCK_HASH"
fi

ln -sfn "$DEP_DIR" "$RELEASE_DIR/node_modules"

# --- Step 4: Write manifest ---
cat > "$RELEASE_DIR/manifest.json" << MANIFESTEOF
{
  "release_id": "$RELEASE_ID",
  "git_sha": "$GIT_SHA",
  "build_id": "$BUILD_ID",
  "created_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "package_lock_hash": "$LOCK_HASH",
  "dependency_path": "$DEP_DIR",
  "status": "built",
  "source": "deploy-immutable.sh"
}
MANIFESTEOF

# --- Step 5: Pre-switch smoke on 3002 ---
echo "--- 3002 Smoke ---"
cd "$RELEASE_DIR"
PORT=3002 npm run start &
PID_3002=$!
sleep 1

# Wait for readiness
READY=false
for i in $(seq 1 15); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/health 2>/dev/null | grep -q "200"; then
    READY=true
    break
  fi
  sleep 1
done

SMOKE_PASS=true
if [ "$READY" = true ]; then
  # Smoke key routes
  for route in "/" "/api/health" "/dashboard" "/leads" "/contracts" "/quotations" "/payments"; do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3002${route}" 2>/dev/null || echo "000")
    if [ "$CODE" = "000" ]; then
      SMOKE_PASS=false
      echo "❌ Smoke failed: $route (connection refused)"
      break
    fi
    echo "  $route → $CODE"
  done
else
  SMOKE_PASS=false
  echo "❌ 3002 never became ready"
fi

kill $PID_3002 2>/dev/null || true
wait $PID_3002 2>/dev/null || true

if [ "$SMOKE_PASS" = false ]; then
  echo "❌ Pre-switch smoke failed. Release NOT deployed. Current unchanged."
  rm -f "$LOCKFILE"
  exit 1
fi
echo "✅ 3002 smoke passed"

# --- Step 6: Atomic switch ---
echo "--- Switch ---"
sudo ln -sfn "$RELEASE_DIR" /opt/newme/current.new
sudo mv -Tf /opt/newme/current.new "$CURRENT_LINK"
echo "✅ Current → $RELEASE_ID"

# --- Step 7: Restart service ---
echo "--- Restart ---"
sudo /usr/bin/systemctl restart newme-platform.service
sleep 5

# --- Step 8: Production validation ---
echo "--- Production Smoke ---"
HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"down"}')
HEALTH_BUILD=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null || echo "unknown")
HEALTH_STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")

if [ "$HEALTH_STATUS" != "healthy" ]; then
  echo "❌ Production health check failed: $HEALTH_STATUS"
  PROD_PASS=false
elif [ "$HEALTH_BUILD" != "$BUILD_ID" ]; then
  echo "❌ BUILD_ID mismatch: health=$HEALTH_BUILD expected=$BUILD_ID"
  PROD_PASS=false
else
  echo "✅ Health: $HEALTH_BUILD"
  PROD_PASS=true
fi

# --- Step 9: Rollback on failure ---
if [ "$PROD_PASS" = false ]; then
  echo "--- ROLLBACK ---"
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    sudo ln -sfn "$PREVIOUS_RELEASE" /opt/newme/current.new
    sudo mv -Tf /opt/newme/current.new "$CURRENT_LINK"
    sudo /usr/bin/systemctl restart newme-platform.service
    sleep 5

    ROLLBACK_HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"down"}')
    ROLLBACK_BUILD=$(echo "$ROLLBACK_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version','unknown'))" 2>/dev/null)

    if [ "$ROLLBACK_BUILD" != "unknown" ]; then
      echo "✅ Rollback successful: $ROLLBACK_BUILD"
    else
      echo "❌ P0: ROLLBACK FAILED. Manual intervention required."
      rm -f "$LOCKFILE"
      exit 2
    fi
  else
    echo "❌ P0: BOOTSTRAP FAILED — no previous release to rollback to"
    rm -f "$LOCKFILE"
    exit 2
  fi
  rm -f "$LOCKFILE"
  exit 1
fi

# --- Step 10: GC ---
echo "--- GC ---"
KEEP=5
cd "$RELEASES_ROOT" 2>/dev/null || true
ls -1dt */ 2>/dev/null | awk -v keep="$KEEP" -v current="$RELEASE_ID" -v prev="${PREVIOUS_RELEASE##*/}" '
NR > keep && $1 != current"/" && $1 != prev"/" { print $1 }
' | while read -r dir; do
  echo "  Removing old release: $dir"
  rm -rf "${RELEASES_ROOT}/${dir}"
done

# GC orphan dependency hashes
echo "  Checking orphan dependencies..."
find "$SHARED_ROOT/node_modules" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | while read -r dep; do
  HASH=$(basename "$dep")
  # Check if any manifest references this hash
  if ! grep -rql "\"package_lock_hash\": \"$HASH\"" "$RELEASES_ROOT"/*/manifest.json 2>/dev/null; then
    echo "  Removing orphan dep: $HASH"
    rm -rf "$dep"
  fi
done

# --- Evidence ---
EVIDENCE_DIR="$PROJECT_ROOT/.hermes-harness/deploy-evidence"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/${TIMESTAMP}.json"

cat > "$EVIDENCE_FILE" << EVIEOF
{
  "deploy_id": "$RELEASE_ID",
  "git_sha": "$GIT_SHA",
  "build_id": "$BUILD_ID",
  "release_dir": "$RELEASE_DIR",
  "previous_release": "${PREVIOUS_RELEASE:-none}",
  "bootstrap": $BOOTSTRAP_MODE,
  "package_lock_hash": "$LOCK_HASH",
  "result": "pass",
  "finished_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EVIEOF

echo "✅ Evidence: $EVIDENCE_FILE"

# --- Cleanup ---
rm -f "$LOCKFILE"
echo "=== Deploy Complete: $RELEASE_ID ==="
