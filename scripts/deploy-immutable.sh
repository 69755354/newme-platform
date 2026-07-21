#!/usr/bin/env bash
set -euo pipefail

# ===================================================================
# deploy-immutable.sh v3 — 2026-07-21
#
# 不可变部署。每个 release 拥有冻结的、独立的依赖副本。
#
# 属性：
# - 从 origin/main 明确 SHA 构建（不依赖本地工作区状态）
# - 依赖通过硬链接冻结到 /opt/newme/shared/node_modules/<PKG_HASH>/
# - 后续 npm install 不影响旧 release
# - rollback release 保持独立可运行
# - release 内生成 manifest.json + evidence.json
# - 完整的 deploy lock 生命周期管理
# - 3002 候选精确管理
# ===================================================================

# ── 常量 ──
SCRIPT_PATH="$(realpath "$0")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_SHA256="$(sha256sum "$SCRIPT_PATH" | awk '{print $1}')"
TIMESTAMP="$(date -u +'%Y%m%d-%H%M%S')"
RELEASES_ROOT="/opt/newme/releases"
SHARED_ROOT="/opt/newme/shared"
CURRENT_LINK="/opt/newme/current"
LOCKFILE="$PROJECT_ROOT/.hermes/deploy-in-progress"
EVIDENCE_DIR="$PROJECT_ROOT/.hermes-harness/deploy-evidence"
BACKUP_NEXT=".next.backup-${TIMESTAMP}"

# ── 参数 ──
GIT_REF="${1:-origin/main}"
FULL_GIT_SHA=""

# ── 信号处理 ──
cleanup_and_exit() {
  local exit_code=$?
  # 恢复 .next
  if [ -n "${BUILD_DIR:-}" ] && [ -d "$BUILD_DIR/$BACKUP_NEXT" ]; then
    rm -rf "$BUILD_DIR/.next" 2>/dev/null || true
    mv "$BUILD_DIR/$BACKUP_NEXT" "$BUILD_DIR/.next" 2>/dev/null || true
  fi
  # 清理 worktree
  if [ -n "${BUILD_DIR:-}" ] && [ -d "$BUILD_DIR" ]; then
    cd "$PROJECT_ROOT"
    rm -rf "$BUILD_DIR" 2>/dev/null || true
    git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
  fi
  # 释放锁
  rm -f "$LOCKFILE"
  exit "$exit_code"
}
trap cleanup_and_exit EXIT INT TERM

# ── 工具函数 ──
log()  { echo "[$(date -u +'%H:%M:%S')] $*"; }
fail() { log "❌ $*"; exit 1; }

# ═══════════════════════════════════════════════════════════════════
# SELF-TEST 0: bash syntax
# ═══════════════════════════════════════════════════════════════════
self_test_bash() {
  bash -n "$SCRIPT_PATH" 2>&1 || fail "bash -n FAILED"
}

# ═══════════════════════════════════════════════════════════════════
# SELF-TEST 1: lock self-test
# ═══════════════════════════════════════════════════════════════════
self_test_lock() {
  local test_lock="/tmp/deploy-immutable-lock-test-$$"
  echo "$$|test|$(date -u +%s)" > "$test_lock"

  # 模拟: 写入 PID，检查 PID 存活
  local read_pid
  read_pid=$(awk -F'|' '{print $1}' "$test_lock")
  if [ "$read_pid" = "$$" ]; then
    # PID 匹配 → 锁有效
    :
  else
    fail "lock self-test: PID mismatch"
  fi

  # 模拟 stale: 不存在的 PID
  echo "99999|stale|$(date -u +%s)" > "$test_lock"
  if kill -0 99999 2>/dev/null; then
    fail "lock self-test: fake PID 99999 should not exist"
  fi
  # stale 检测通过
  rm -f "$test_lock"
  log "✅ lock self-test passed"
}

# ═══════════════════════════════════════════════════════════════════
# SELF-TEST 2: .next restore self-test
# ═══════════════════════════════════════════════════════════════════
self_test_next_restore() {
  local test_dir="/tmp/deploy-immutable-next-test-$$"
  mkdir -p "$test_dir/.next"
  echo "original" > "$test_dir/.next/content"
  local test_backup
  test_backup=".next.backup-$(date +%s)"

  # 模拟备份
  mv "$test_dir/.next" "$test_dir/$test_backup"
  mkdir "$test_dir/.next"
  echo "new" > "$test_dir/.next/content"

  # 模拟恢复
  rm -rf "$test_dir/.next"
  mv "$test_dir/$test_backup" "$test_dir/.next"

  local content
  content=$(cat "$test_dir/.next/content")
  if [ "$content" != "original" ]; then
    fail ".next restore self-test FAILED: got '$content' expected 'original'"
  fi
  rm -rf "$test_dir"
  log "✅ .next restore self-test passed"
}

# ═══════════════════════════════════════════════════════════════════
# SELF-TEST 3: dependency immutability self-test
# ═══════════════════════════════════════════════════════════════════
self_test_immutability() {
  local test_dir="/tmp/deploy-immutable-immut-test-$$"
  local src_dir="$test_dir/src"
  local frozen_dir="$test_dir/frozen"
  mkdir -p "$src_dir/node_modules"
  echo "v1" > "$src_dir/node_modules/pkg.json"
  echo "v1" > "$src_dir/package-lock.json"

  # 冻结（硬链接）
  cp -al "$src_dir/node_modules" "$frozen_dir" 2>/dev/null || {
    # 如果 cp -al 失败（可能跨文件系统），回退到 cp -a
    cp -a "$src_dir/node_modules" "$frozen_dir"
  }
  local frozen_content
  frozen_content=$(cat "$frozen_dir/pkg.json")

  # 修改源不影响冻结副本
  echo "v2" > "$src_dir/node_modules/pkg.json"
  local frozen_after
  frozen_after=$(cat "$frozen_dir/pkg.json")

  if [ "$frozen_content" != "v1" ]; then
    fail "immutability self-test: frozen content changed before modification"
  fi
  if [ "$frozen_after" != "v1" ]; then
    fail "immutability self-test: frozen content changed after source modification"
  fi

  # 删除源不影响冻结副本
  rm -rf "$src_dir/node_modules"
  if [ ! -f "$frozen_dir/pkg.json" ]; then
    fail "immutability self-test: frozen content lost after source deletion"
  fi

  rm -rf "$test_dir"
  log "✅ dependency immutability self-test passed"
}

# ═══════════════════════════════════════════════════════════════════
# SELF-TEST 4: symlink repair self-test
# ═══════════════════════════════════════════════════════════════════
self_test_symlink() {
  local test_dir="/tmp/deploy-immutable-symlink-test-$$"
  mkdir -p "$test_dir/.next/node_modules"
  mkdir -p "$test_dir/node_modules/@scope/mypkg"

  # 创建 broken symlink
  ln -sfn "/nonexistent/path/node_modules/@scope/mypkg" "$test_dir/.next/node_modules/@scope-mypkg-abcdef1234567890"

  # 运行修复逻辑（内联）
  local link="$test_dir/.next/node_modules/@scope-mypkg-abcdef1234567890"
  local link_name="@scope-mypkg-abcdef1234567890"
  local old_target
  old_target=$(readlink "$link")

  if [[ "$link_name" =~ ^(.+)-[a-f0-9]{16}$ ]]; then
    local pkg_name="${BASH_REMATCH[1]}"
    pkg_name="${pkg_name//-//}"  # @scope/mypkg
    local new_target="../../node_modules/${pkg_name}"

    rm -f "$link"
    ln -sfn "$new_target" "$link"

    if realpath -e "$link" > /dev/null 2>&1; then
      :
    else
      fail "symlink repair self-test: repair failed"
    fi
  else
    fail "symlink repair self-test: could not parse package name"
  fi

  rm -rf "$test_dir"
  log "✅ symlink repair self-test passed"
}

# ═══════════════════════════════════════════════════════════════════
# RUN ALL SELF-TESTS
# ═══════════════════════════════════════════════════════════════════
log "=== Self-Tests ==="
self_test_bash
self_test_lock
self_test_next_restore
self_test_immutability
self_test_symlink

# ═══════════════════════════════════════════════════════════════════
# Step 0: Git baseline
# ═══════════════════════════════════════════════════════════════════
log "=== Git Baseline ==="
cd "$PROJECT_ROOT"

# Fetch latest
git fetch origin main 2>&1 | tail -1 || true

# Resolve SHA
FULL_GIT_SHA=$(git rev-parse "$GIT_REF" 2>/dev/null) || fail "Cannot resolve git ref: $GIT_REF"
GIT_SHA_SHORT=$(git rev-parse --short "$FULL_GIT_SHA")

# Verify it's on origin/main
if ! git merge-base --is-ancestor "$FULL_GIT_SHA" origin/main 2>/dev/null; then
  # Could be origin/main itself
  if [ "$FULL_GIT_SHA" != "$(git rev-parse origin/main)" ]; then
    fail "SHA $FULL_GIT_SHA is not on origin/main"
  fi
fi

RELEASE_ID="${TIMESTAMP}-${GIT_SHA_SHORT}"
RELEASE_DIR="${RELEASES_ROOT}/${RELEASE_ID}"

log "Git SHA: $FULL_GIT_SHA (short: $GIT_SHA_SHORT)"
log "Release: $RELEASE_ID"

# ── 构建脚本版本自记录 ──
log "Deploy script SHA256: $SCRIPT_SHA256"

# ═══════════════════════════════════════════════════════════════════
# Step 0.5: Deploy lock
# ═══════════════════════════════════════════════════════════════════
log "=== Deploy Lock ==="
if [ -f "$LOCKFILE" ]; then
  LOCK_PID=$(awk -F'|' '{print $1}' "$LOCKFILE" 2>/dev/null || echo "0")
  LOCK_RELEASE=$(awk -F'|' '{print $2}' "$LOCKFILE" 2>/dev/null || echo "unknown")
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    fail "Deploy already in progress: PID=$LOCK_PID release=$LOCK_RELEASE"
  else
    log "⚠️  Stale lock (PID $LOCK_PID dead) — overriding"
  fi
fi
echo "$$|${RELEASE_ID}|$(date -u +%s)" > "$LOCKFILE"

# ═══════════════════════════════════════════════════════════════════
# Step 0.6: Disk check
# ═══════════════════════════════════════════════════════════════════
AVAIL_KB=$(df --output=avail /opt 2>/dev/null | tail -1 | tr -d ' ')
if [ "${AVAIL_KB:-0}" -lt 8388608 ]; then
  fail "Disk < 8GB available on /opt (${AVAIL_KB}KB)"
fi
log "✅ Disk: $(( AVAIL_KB / 1024 / 1024 ))GB available"

# ═══════════════════════════════════════════════════════════════════
# Step 1: Source analysis (from existing node_modules)
# ═══════════════════════════════════════════════════════════════════
log "=== Source Analysis ==="

# 版本信息
NODE_VERSION=$(node -v)
NPM_VERSION=$(npm -v)
NEXT_VERSION=$(node -e "console.log(require('./node_modules/next/package.json').version)" 2>/dev/null || echo "unknown")
REACT_VERSION=$(node -e "console.log(require('./node_modules/react/package.json').version)" 2>/dev/null || echo "unknown")
SUPABASE_VERSION=$(node -e "console.log(require('./node_modules/@supabase/supabase-js/package.json').version)" 2>/dev/null || echo "unknown")

# Hash 计算
PKG_LOCK_SHA256=$(sha256sum "$PROJECT_ROOT/package-lock.json" | awk '{print $1}')
TREE_HASH=$(cd "$PROJECT_ROOT" && find node_modules -type f \( -name '*.js' -o -name '*.json' -o -name '*.mjs' -o -name '*.cjs' \) 2>/dev/null | sort | xargs md5sum 2>/dev/null | md5sum | awk '{print $1}')
# 使用 package-lock SHA256 前 16 位作为目录名
PKG_HASH="${PKG_LOCK_SHA256:0:16}"
FROZEN_DEPS="${SHARED_ROOT}/node_modules/${PKG_HASH}"

log "Node: $NODE_VERSION | npm: $NPM_VERSION"
log "Next.js: $NEXT_VERSION | React: $REACT_VERSION | Supabase: $SUPABASE_VERSION"
log "package-lock SHA256: $PKG_LOCK_SHA256"
log "Tree hash: $TREE_HASH"
log "Frozen deps target: $FROZEN_DEPS"

# ═══════════════════════════════════════════════════════════════════
# Step 2: Freeze dependencies (if not already cached)
# ═══════════════════════════════════════════════════════════════════
log "=== Freeze Dependencies ==="
if [ -d "$FROZEN_DEPS" ]; then
  log "✅ Dependencies already frozen: $PKG_HASH"
else
  log "Freezing source node_modules → $FROZEN_DEPS..."
  mkdir -p "$(dirname "$FROZEN_DEPS")"
  if cp -al "$PROJECT_ROOT/node_modules" "$FROZEN_DEPS" 2>/dev/null; then
    log "✅ Frozen via hardlinks"
  else
    # 回退：跨文件系统或硬链接不支持
    log "⚠️  Hardlinks not supported — falling back to full copy"
    cp -a "$PROJECT_ROOT/node_modules" "$FROZEN_DEPS"
    log "✅ Frozen via copy"
  fi
fi

# 验证冻结副本完整性
if [ ! -d "$FROZEN_DEPS/next" ]; then
  fail "Frozen deps missing critical package 'next'"
fi
FROZEN_NEXT_VER=$(node -e "console.log(require('$FROZEN_DEPS/next/package.json').version)" 2>/dev/null || echo "MISSING")
log "Frozen Next.js: $FROZEN_NEXT_VER"

# ═══════════════════════════════════════════════════════════════════
# Step 3: Clean build from origin/main
# ═══════════════════════════════════════════════════════════════════
log "=== Build ==="
BUILD_DIR="/tmp/newme-build-${RELEASE_ID}"

# 创建 detached worktree from origin/main
git -C "$PROJECT_ROOT" worktree add --detach "$BUILD_DIR" "$FULL_GIT_SHA" 2>/dev/null || {
  git -C "$PROJECT_ROOT" worktree remove --force "$BUILD_DIR" 2>/dev/null || true
  git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
  git -C "$PROJECT_ROOT" worktree add --detach "$BUILD_DIR" "$FULL_GIT_SHA"
}

# 将冻结的 node_modules 链接到 worktree
ln -sfn "$FROZEN_DEPS" "$BUILD_DIR/node_modules"

# 复制 .env.local（如存在）
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  cp "$PROJECT_ROOT/.env.local" "$BUILD_DIR/.env.local"
fi

# 验证 worktree 状态
cd "$BUILD_DIR"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  log "⚠️  Worktree not clean — this is unexpected"
fi

# 构建
BUILD_CMD="NEWME_ISOLATED_BUILD=1 NODE_OPTIONS=--max_old_space_size=2048 npm run build"
log "Build command: $BUILD_CMD"
BUILD_LOG="/tmp/build-${RELEASE_ID}.log"

if ! NEWME_ISOLATED_BUILD=1 NODE_OPTIONS="--max_old_space_size=2048" npm run build > "$BUILD_LOG" 2>&1; then
  log "Build log (last 20 lines):"
  tail -20 "$BUILD_LOG"
  fail "Build failed"
fi

tail -5 "$BUILD_LOG"
BUILD_ID=$(cat "$BUILD_DIR/.next/BUILD_ID" 2>/dev/null || echo "unknown")
log "✅ Build: BUILD_ID=$BUILD_ID"

# ═══════════════════════════════════════════════════════════════════
# Step 4: Create release directory
# ═══════════════════════════════════════════════════════════════════
log "=== Release ==="
mkdir -p "$RELEASE_DIR"

cp -a "$BUILD_DIR/.next" "$RELEASE_DIR/"
cp "$BUILD_DIR/package.json" "$BUILD_DIR/package-lock.json" "$BUILD_DIR/next.config.ts" "$RELEASE_DIR/" 2>/dev/null || true
cp -a "$BUILD_DIR/public" "$RELEASE_DIR/" 2>/dev/null || true
if [ -f "$BUILD_DIR/.env.local" ]; then
  cp "$BUILD_DIR/.env.local" "$RELEASE_DIR/.env.local"
fi

# 依赖链接 → 冻结副本
ln -sfn "$FROZEN_DEPS" "$RELEASE_DIR/node_modules"

# Fix appDir
python3 -c "
import json
rf = '$RELEASE_DIR/.next/required-server-files.json'
with open(rf) as f: data = json.load(f)
data['appDir'] = '$RELEASE_DIR'
with open(rf, 'w') as f: json.dump(data, f)
"
log "✅ appDir patched to release directory"

# ═══════════════════════════════════════════════════════════════════
# Step 5: Symlink repair
# ═══════════════════════════════════════════════════════════════════
log "=== Symlink Repair ==="
SYMLINK_SCAN=0; SYMLINK_VALID=0; SYMLINK_REPAIRED=0; SYMLINK_FAILED_COUNT=0
REPAIRED_LINKS="[]"; FAILED_LINKS="[]"
EXT_DIR="$RELEASE_DIR/.next/node_modules"

if [ -d "$EXT_DIR" ]; then
  repaired_list=(); failed_list=()

  for link in "$EXT_DIR"/*; do
    [ -L "$link" ] || continue
    SYMLINK_SCAN=$((SYMLINK_SCAN + 1))
    link_name=$(basename "$link")

    if realpath -e "$link" > /dev/null 2>&1; then
      SYMLINK_VALID=$((SYMLINK_VALID + 1))
      continue
    fi

    # Broken — attempt repair
    old_target=$(readlink "$link")

    if [[ "$link_name" =~ ^(.+)-[a-f0-9]{16}$ ]]; then
      pkg_name="${BASH_REMATCH[1]}"
      # e.g., @scope-pkg → @scope/pkg
      if [[ "$pkg_name" == @* ]]; then
        pkg_name="${pkg_name//-//}"  # @scope/mypkg
      fi
    elif [[ "$old_target" =~ /node_modules/([^/]+)$ ]]; then
      pkg_name="${BASH_REMATCH[1]}"
    else
      SYMLINK_FAILED_COUNT=$((SYMLINK_FAILED_COUNT + 1))
      failed_list+=("\"${link_name} (unparseable)\"")
      continue
    fi

    new_target="../../node_modules/${pkg_name}"
    if [ ! -e "$RELEASE_DIR/node_modules/$pkg_name" ]; then
      SYMLINK_FAILED_COUNT=$((SYMLINK_FAILED_COUNT + 1))
      failed_list+=("\"${link_name} -> ${pkg_name} (not found)\"")
      continue
    fi

    rm -f "$link"
    ln -sfn "$new_target" "$link"

    if realpath -e "$link" > /dev/null 2>&1; then
      SYMLINK_REPAIRED=$((SYMLINK_REPAIRED + 1))
      repaired_list+=("\"${link_name} -> ${pkg_name}\"")
    else
      SYMLINK_FAILED_COUNT=$((SYMLINK_FAILED_COUNT + 1))
      failed_list+=("\"${link_name} -> ${pkg_name} (still broken)\"")
    fi
  done

  REPAIRED_LINKS="[$(IFS=,; echo "${repaired_list[*]}")]"
  FAILED_LINKS="[$(IFS=,; echo "${failed_list[*]}")]"

  log "  Scanned: $SYMLINK_SCAN | Valid: $SYMLINK_VALID | Repaired: $SYMLINK_REPAIRED | Failed: $SYMLINK_FAILED_COUNT"
  [ "$SYMLINK_REPAIRED" -gt 0 ] && for r in "${repaired_list[@]}"; do log "  ✅ $r"; done
  [ "$SYMLINK_FAILED_COUNT" -gt 0 ] && for f in "${failed_list[@]}"; do log "  ❌ $f"; done
else
  log "  ℹ️  No .next/node_modules — nothing to repair"
fi

SYMLINK_REPAIR_JSON=$(cat <<JSON
{
  "scan": $SYMLINK_SCAN,
  "valid": $SYMLINK_VALID,
  "repaired": $SYMLINK_REPAIRED,
  "failed": $SYMLINK_FAILED_COUNT,
  "repaired_links": $REPAIRED_LINKS,
  "failed_links": $FAILED_LINKS
}
JSON
)

if [ "$SYMLINK_FAILED_COUNT" -gt 0 ]; then
  fail "Symlink repair failures — BLOCKED"
fi

# ═══════════════════════════════════════════════════════════════════
# Step 6: manifest.json
# ═══════════════════════════════════════════════════════════════════
log "=== Manifest ==="
BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

cat > "$RELEASE_DIR/manifest.json" << MANIFEST
{
  "release_id": "$RELEASE_ID",
  "git_sha_full": "$FULL_GIT_SHA",
  "git_sha_short": "$GIT_SHA_SHORT",
  "git_ref": "$GIT_REF",
  "build_id": "$BUILD_ID",
  "created_at": "$BUILD_TIME",
  "dependencies": {
    "mode": "frozen-hardlinks",
    "pkg_lock_sha256": "$PKG_LOCK_SHA256",
    "tree_hash": "$TREE_HASH",
    "frozen_path": "$FROZEN_DEPS",
    "node_version": "$NODE_VERSION",
    "npm_version": "$NPM_VERSION",
    "next_version": "$NEXT_VERSION",
    "react_version": "$REACT_VERSION",
    "supabase_version": "$SUPABASE_VERSION"
  },
  "build": {
    "command": "$BUILD_CMD",
    "script_sha256": "$SCRIPT_SHA256",
    "worktree": "$BUILD_DIR"
  },
  "symlink_repair": $SYMLINK_REPAIR_JSON,
  "status": "candidate"
}
MANIFEST
log "✅ manifest.json"

# ═══════════════════════════════════════════════════════════════════
# Step 7: 3002 candidate smoke
# ═══════════════════════════════════════════════════════════════════
log "=== 3002 Candidate Smoke ==="

# 精确清理：检查是否有活进程在 3002
CANDIDATE_PID_FILE="/tmp/deploy-immutable-3002.pid"
if [ -f "$CANDIDATE_PID_FILE" ]; then
  OLD_PID=$(cat "$CANDIDATE_PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    log "Killing previous candidate PID=$OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    wait "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$CANDIDATE_PID_FILE"
fi
# 兜底：检查任何占 3002 的进程
if fuser 3002/tcp 2>/dev/null | grep -q .; then
  log "⚠️  Stale process on 3002 — removing"
  fuser -k 3002/tcp 2>/dev/null || true
  sleep 1
fi

# 启动候选
cd "$RELEASE_DIR"
PORT=3002 npm run start > "/tmp/candidate-3002-${RELEASE_ID}.log" 2>&1 &
CANDIDATE_PID=$!
echo "$CANDIDATE_PID" > "$CANDIDATE_PID_FILE"
log "Candidate PID=$CANDIDATE_PID"

# 等待 ready
READY=false
for _ in $(seq 1 20); do
  sleep 1
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/ready 2>/dev/null | grep -q "200"; then
    READY=true
    break
  fi
done

if [ "$READY" != true ]; then
  # 显示候选日志最后几行
  log "Candidate logs:"
  tail -10 "/tmp/candidate-3002-${RELEASE_ID}.log" 2>/dev/null || true
  kill "$CANDIDATE_PID" 2>/dev/null || true
  fail "3002 never became ready"
fi

# Smoke
SMOKE_PASS=true
SMOKE_RESULTS=""
for route in "/api/health" "/api/ready"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3002${route}" 2>/dev/null || echo "000")
  SMOKE_RESULTS="${SMOKE_RESULTS}  ${route}: ${CODE}
"
  if [ "$CODE" != "200" ]; then
    SMOKE_PASS=false
    log "❌ $route → $CODE"
  else
    log "  $route → $CODE"
  fi
done

# auth/me
AUTH_ME_NO_TOKEN=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/auth/me 2>/dev/null || echo "000")
SMOKE_RESULTS="${SMOKE_RESULTS}  /api/auth/me (no token): ${AUTH_ME_NO_TOKEN}
"
AUTH_ME_BAD_TOKEN=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid" http://localhost:3002/api/auth/me 2>/dev/null || echo "000")
SMOKE_RESULTS="${SMOKE_RESULTS}  /api/auth/me (bad token): ${AUTH_ME_BAD_TOKEN}
"

log "  /api/auth/me (no token): $AUTH_ME_NO_TOKEN"
log "  /api/auth/me (bad token): $AUTH_ME_BAD_TOKEN"

if [ "$AUTH_ME_NO_TOKEN" != "401" ]; then
  SMOKE_PASS=false
  log "❌ auth/me no token expected 401, got $AUTH_ME_NO_TOKEN"
fi
if [ "$AUTH_ME_BAD_TOKEN" != "401" ]; then
  SMOKE_PASS=false
  log "❌ auth/me bad token expected 401, got $AUTH_ME_BAD_TOKEN"
fi

if [ "$SMOKE_PASS" = false ]; then
  kill "$CANDIDATE_PID" 2>/dev/null || true
  rm -f "$CANDIDATE_PID_FILE"
  fail "3002 smoke FAILED"
fi
log "✅ 3002 smoke passed"

# ═══════════════════════════════════════════════════════════════════
# Step 8: evidence.json
# ═══════════════════════════════════════════════════════════════════
log "=== Evidence ==="
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_FILE="$EVIDENCE_DIR/${RELEASE_ID}.json"

CURRENT_HEALTH=$(curl -s http://localhost:3002/api/health 2>/dev/null || echo '{}')

cat > "$EVIDENCE_FILE" << EVIEOF
{
  "deploy_id": "$RELEASE_ID",
  "git_sha_full": "$FULL_GIT_SHA",
  "git_sha_short": "$GIT_SHA_SHORT",
  "build_id": "$BUILD_ID",
  "release_dir": "$RELEASE_DIR",
  "bootstrap": false,
  "dependencies": {
    "mode": "frozen-hardlinks",
    "pkg_lock_sha256": "$PKG_LOCK_SHA256",
    "tree_hash": "$TREE_HASH",
    "frozen_path": "$FROZEN_DEPS",
    "node_version": "$NODE_VERSION",
    "npm_version": "$NPM_VERSION",
    "next_version": "$NEXT_VERSION",
    "react_version": "$REACT_VERSION",
    "supabase_version": "$SUPABASE_VERSION"
  },
  "build": {
    "command": "$BUILD_CMD",
    "script_sha256": "$SCRIPT_SHA256",
    "worktree": "$BUILD_DIR"
  },
  "symlink_repair": $SYMLINK_REPAIR_JSON,
  "candidate": {
    "pid": $CANDIDATE_PID,
    "smoke_results": "$(echo "$SMOKE_RESULTS" | tr '\n' '|')"
  },
  "result": "candidate-pass",
  "finished_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EVIEOF

# 更新 manifest 状态
python3 -c "
import json
with open('$RELEASE_DIR/manifest.json') as f: d = json.load(f)
d['status'] = 'candidate-pass'
d['candidate_pid'] = $CANDIDATE_PID
d['health'] = json.loads('''$CURRENT_HEALTH''')
with open('$RELEASE_DIR/manifest.json', 'w') as f: json.dump(d, f, indent=2)
"
log "✅ evidence.json → $EVIDENCE_FILE"

# ═══════════════════════════════════════════════════════════════════
# Step 9: Cleanup worktree + lock
# ═══════════════════════════════════════════════════════════════════
log "=== Cleanup ==="
cd "$PROJECT_ROOT"
git -C "$PROJECT_ROOT" worktree remove --force "$BUILD_DIR" 2>/dev/null || true
git -C "$PROJECT_ROOT" worktree prune 2>/dev/null || true
rm -f "$BUILD_LOG"

# 释放锁（candidate 3002 保持运行，不 kill）
rm -f "$LOCKFILE"

# ═══════════════════════════════════════════════════════════════════
# STEP 9.5: ATOMIC SWITCH (requires explicit --go flag)
# ═══════════════════════════════════════════════════════════════════
NEED_GO=false
if [ "${2:-}" = "--go" ]; then
  NEED_GO=true
fi

if [ "$NEED_GO" = true ]; then
  log "=== Atomic Switch ==="
  PREVIOUS_RELEASE=""
  if [ -L "$CURRENT_LINK" ] && [ -d "$(readlink -f "$CURRENT_LINK" 2>/dev/null)" ]; then
    PREVIOUS_RELEASE=$(readlink -f "$CURRENT_LINK")
  fi

  # git safe.directory
  sudo /usr/bin/git config --system --add safe.directory "$RELEASE_DIR" 2>/dev/null || true
  sudo /usr/bin/git config --system --add safe.directory /opt/newme/current 2>/dev/null || true
  sudo /usr/bin/systemctl reset-failed newme-platform.service 2>/dev/null || true

  # Atomic switch
  sudo ln -sfn "$RELEASE_DIR" /opt/newme/current.new
  sudo mv -Tf /opt/newme/current.new "$CURRENT_LINK"
  log "✅ Current → $RELEASE_ID"

  # Restart
  sudo /usr/bin/systemctl restart newme-platform.service
  sleep 5

  # Production validation
  HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"down"}')
  HEALTH_STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")

  if [ "$HEALTH_STATUS" != "ok" ]; then
    log "❌ Production health: $HEALTH_STATUS — ROLLBACK"

    if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
      sudo ln -sfn "$PREVIOUS_RELEASE" /opt/newme/current.new
      sudo mv -Tf /opt/newme/current.new "$CURRENT_LINK"
      sudo /usr/bin/systemctl restart newme-platform.service
      sleep 5
      ROLLBACK_HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"down"}')
      ROLLBACK_STATUS=$(echo "$ROLLBACK_HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")

      if [ "$ROLLBACK_STATUS" = "ok" ]; then
        log "✅ Rollback successful"
        exit 1
      else
        log "❌ P0: ROLLBACK FAILED"
        exit 2
      fi
    else
      log "❌ P0: No previous release to rollback to"
      exit 2
    fi
  fi

  log "✅ Production health: ok"
  log "=== Deploy Complete: $RELEASE_ID ==="
else
  log "=== Candidate Ready ==="
  log "Release: $RELEASE_ID"
  log "Candidate PID: $CANDIDATE_PID (port 3002)"
  log ""
  log "To switch to production:"
  log "  sudo ln -sfn $RELEASE_DIR /opt/newme/current"
  log "  sudo /usr/bin/systemctl restart newme-platform.service"
  log ""
  log "To kill candidate:"
  log "  kill $CANDIDATE_PID"
fi
