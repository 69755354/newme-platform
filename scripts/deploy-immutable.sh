#!/usr/bin/env bash
set -euo pipefail

# ────────────────────────────────────────────
# Self-test: --selftest runs ONLY the cleanup test, no deploy.
# Must appear BEFORE any deploy logic.
if [ "${1:-}" = "--selftest" ]; then
  echo "=== SELFTEST: candidate cleanup ==="
  cleanup_candidate() {
    if [ -n "${CANDIDATE_PGID:-}" ]; then
      kill -TERM -- -"$CANDIDATE_PGID" 2>/dev/null || true
      wait $CANDIDATE_PID 2>/dev/null || true
      sleep 0.5
      kill -KILL -- -"$CANDIDATE_PGID" 2>/dev/null || true
      wait $CANDIDATE_PID 2>/dev/null || true
      for i in $(seq 1 10); do
        if ! fuser 3002/tcp 2>/dev/null; then break; fi
        sleep 0.5
      done
      if fuser 3002/tcp 2>/dev/null; then
        echo "❌ FATAL: 3002 still occupied"
        return 1
      fi
      echo "✅ 3002 port released"
    fi
  }
  python3 -c "import http.server; http.server.HTTPServer(('',3002),http.server.SimpleHTTPRequestHandler).serve_forever()" &
  CANDIDATE_PID=$!
  CANDIDATE_PGID=$CANDIDATE_PID
  sleep 1
  if ! fuser 3002/tcp 2>/dev/null; then
    echo "❌ SELFTEST FAIL: dummy didn't bind 3002"
    exit 1
  fi
  echo "Started dummy PID=$CANDIDATE_PID PGID=$CANDIDATE_PGID"
  cleanup_candidate
  if fuser 3002/tcp 2>/dev/null; then
    echo "❌ SELFTEST FAIL: 3002 still occupied"
    fuser -k 3002/tcp 2>/dev/null || true
    exit 1
  fi
  echo "✅ SELFTEST PASS"
  exit 0
fi

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

# ==== Symlink Repair ====

verify_and_repair_next_external_symlinks() {
  local release_dir="$1"
  local ext_dir="${release_dir}/.next/node_modules"
  local scan_count=0 valid_count=0 repaired_count=0 failed_count=0
  local repaired_links=() failed_links=()

  if [ ! -d "$ext_dir" ]; then
    echo "  ℹ️  No .next/node_modules — nothing to repair"
    echo '{"scan":0,"valid":0,"repaired":0,"failed":0,"repaired_links":[],"failed_links":[]}' > /tmp/symlink-repair.json
    return 0
  fi

  for link in "$ext_dir"/*; do
    [ -L "$link" ] || continue
    scan_count=$((scan_count + 1))
    local link_name
    link_name=$(basename "$link")

    # Already valid — keep
    if realpath -e "$link" > /dev/null 2>&1; then
      valid_count=$((valid_count + 1))
      continue
    fi

    # === Broken symlink — repair ===
    local old_target pkg_name
    old_target=$(readlink "$link")

    # Strategy 1: extract package name from original target (most reliable)
    if [[ "$old_target" =~ /node_modules/([^/]+)$ ]]; then
      pkg_name="${BASH_REMATCH[1]}"
    # Strategy 2: strip 16-char hex hash suffix from symlink name
    elif [[ "$link_name" =~ ^(.+)-[a-f0-9]{16}$ ]]; then
      pkg_name="${BASH_REMATCH[1]}"
    else
      failed_count=$((failed_count + 1))
      failed_links+=("${link_name} (cannot parse package name from '${old_target}')")
      continue
    fi

    # Verify package exists in release node_modules
    local new_target="${release_dir}/node_modules/${pkg_name}"
    if [ ! -e "$new_target" ]; then
      failed_count=$((failed_count + 1))
      failed_links+=("${link_name} -> ${pkg_name} (not found in node_modules)")
      continue
    fi

    # Rebuild relative symlink
    rm -f "$link"
    ln -sfn "../../node_modules/${pkg_name}" "$link"

    # Verify repair
    if realpath -e "$link" > /dev/null 2>&1; then
      repaired_count=$((repaired_count + 1))
      repaired_links+=("${link_name} -> ${pkg_name}")
    else
      failed_count=$((failed_count + 1))
      failed_links+=("${link_name} -> ${pkg_name} (repair symlink still broken)")
    fi
  done

  # Write structured result
  python3 -c "
import json
data = {
    'scan': $scan_count,
    'valid': $valid_count,
    'repaired': $repaired_count,
    'failed': $failed_count,
    'repaired_links': $(python3 -c "import json; print(json.dumps([x for x in '''${repaired_links[*]}'''.split('\n') if x]))" 2>/dev/null || echo '[]'),
    'failed_links': $(python3 -c "import json; print(json.dumps([x for x in '''${failed_links[*]}'''.split('\n') if x]))" 2>/dev/null || echo '[]')
}
json.dump(data, open('/tmp/symlink-repair.json','w'), indent=2)
" 2>/dev/null || {
    printf '{"scan":%d,"valid":%d,"repaired":%d,"failed":%d,"repaired_links":[],"failed_links":[]}' \
      "$scan_count" "$valid_count" "$repaired_count" "$failed_count" > /tmp/symlink-repair.json
  }

  # Echo summary
  echo "  Scanned:  $scan_count"
  echo "  Valid:    $valid_count"
  echo "  Repaired: $repaired_count"
  echo "  Failed:   $failed_count"

  if [ "$repaired_count" -gt 0 ]; then
    for r in "${repaired_links[@]}"; do echo "  ✅ $r"; done
  fi
  if [ "$failed_count" -gt 0 ]; then
    for f in "${failed_links[@]}"; do echo "  ❌ $f"; done
  fi

  return "$failed_count"
}

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

# --- Step 1: Build in source repo (not isolated worktree) ---
# Building in /tmp worktree requires npm install which produces different
# node_modules, breaking Next.js request context (cookies() → auth/me 500).
# Build in source repo where proven node_modules already exist.
echo "--- Build ---"
cd "$PROJECT_ROOT"

# Preserve existing .next if any
if [ -d .next ]; then
  mv .next .next.bak.$(date +%s) 2>/dev/null || true
fi

if ! NEWME_ISOLATED_BUILD=1 NODE_OPTIONS="--max_old_space_size=2048" npm run build 2>&1 | tail -10; then
  echo "❌ Build failed"
  # Restore backup
  LATEST_BAK=$(ls -td .next.bak.* 2>/dev/null | head -1)
  [ -n "$LATEST_BAK" ] && mv "$LATEST_BAK" .next 2>/dev/null
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
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  cp "$PROJECT_ROOT/.env.local" "$RELEASE_DIR/.env.local"
fi

# Restore original .next if it existed
LATEST_BAK=$(ls -td .next.bak.* 2>/dev/null | head -1)
if [ -n "$LATEST_BAK" ]; then
  mv .next .next.prev 2>/dev/null || true
  mv "$LATEST_BAK" .next 2>/dev/null
  mv .next.prev .next.bak.$(date +%s) 2>/dev/null || true
fi

# Fix appDir in required-server-files.json (worktree path → release path)
python3 -c "
import json
rf = '$RELEASE_DIR/.next/required-server-files.json'
with open(rf) as f: data = json.load(f)
data['appDir'] = '$RELEASE_DIR'
with open(rf, 'w') as f: json.dump(data, f)
"
echo '✅ appDir patched to release directory'

# --- Step 3: Dependencies ---
# Use source repo's proven node_modules. Fresh npm ci output differs from the
# installed tree and can break Next.js request context (e.g., cookies() outside
# request scope → auth/me 500). The source repo's node_modules is the known-good
# baseline that production release 0bcf1a8 was built with.
ln -sfn "../../shared/node_modules" "$RELEASE_DIR/node_modules"

# --- Step 3.5: Repair Turbopack external module symlinks ---
echo "--- Symlink Repair ---"
verify_and_repair_next_external_symlinks "$RELEASE_DIR"
SYMLINK_FAILED=$?

# Load repair results
SYMLINK_REPAIR_JSON=$(cat /tmp/symlink-repair.json 2>/dev/null || echo '{"scan":0,"valid":0,"repaired":0,"failed":0}')
SYMLINK_SCAN=$(echo "$SYMLINK_REPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('scan',0))" 2>/dev/null || echo 0)
SYMLINK_VALID=$(echo "$SYMLINK_REPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('valid',0))" 2>/dev/null || echo 0)
SYMLINK_REPAIRED=$(echo "$SYMLINK_REPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('repaired',0))" 2>/dev/null || echo 0)
SYMLINK_FAILED_COUNT=$(echo "$SYMLINK_REPAIR_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('failed',0))" 2>/dev/null || echo 0)

if [ "$SYMLINK_FAILED_COUNT" -gt 0 ]; then
  echo "❌ symlink repair failures ($SYMLINK_FAILED_COUNT) — BLOCKED"
  rm -f "$LOCKFILE"
  exit 1
fi

# --- Step 4: Write manifest ---
cat > "$RELEASE_DIR/manifest.json" << MANIFESTEOF
{
  "release_id": "$RELEASE_ID",
  "git_sha": "$GIT_SHA",
  "build_id": "$BUILD_ID",
  "created_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "dependencies": "source-repo (shared/node_modules)",
  "symlink_repair": {
    "scan": $SYMLINK_SCAN,
    "valid": $SYMLINK_VALID,
    "repaired": $SYMLINK_REPAIRED,
    "failed": $SYMLINK_FAILED_COUNT
  },
  "status": "built",
  "source": "deploy-immutable.sh"
}
MANIFESTEOF

# --- Step 5: Pre-switch smoke on 3002 ---
echo "--- 3002 Smoke ---"

# cleanup_candidate: kills candidate process group, verifies port release
# MUST be called on every exit path (trap EXIT). Kill by process group, not PID.
cleanup_candidate() {
  if [ -n "${CANDIDATE_PGID:-}" ]; then
    # Kill entire process group (leader + all children)
    kill -TERM -- -"$CANDIDATE_PGID" 2>/dev/null || true
    wait $CANDIDATE_PID 2>/dev/null || true
    sleep 0.5
    # Force-kill survivors
    kill -KILL -- -"$CANDIDATE_PGID" 2>/dev/null || true
    wait $CANDIDATE_PID 2>/dev/null || true
    # Verify port released
    for i in $(seq 1 10); do
      if ! fuser 3002/tcp 2>/dev/null; then
        echo "✅ 3002 port released (cleanup)"
        break
      fi
      sleep 0.5
    done
    if fuser 3002/tcp 2>/dev/null; then
      echo "❌ FATAL: 3002 port still occupied after cleanup"
      fuser -v 3002/tcp 2>/dev/null
      return 1
    fi
  fi
}
trap 'cleanup_candidate || true' EXIT

# Clean any stale 3002 process (before starting new candidate)
STALE_3002=$(fuser 3002/tcp 2>/dev/null || true)
if [ -n "$STALE_3002" ]; then
  echo "⚠️  Killing stale 3002 process: $STALE_3002"
  fuser -k 3002/tcp 2>/dev/null || true
  sleep 2
fi

cd "$RELEASE_DIR"

# Start candidate in independent process group via setsid
# setsid ensures the process group survives the parent shell, and
# kill -- -PGID can target the entire tree regardless of re-parenting
setsid -w bash -c "PORT=3002 npm run start" </dev/null >/dev/null 2>&1 &
CANDIDATE_PID=$!
# PGID = PID for setsid leader
CANDIDATE_PGID=$CANDIDATE_PID

sleep 1

# Wait for readiness
READY=false
for i in $(seq 1 15); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:3002/api/ready 2>/dev/null | grep -q "200"; then
    READY=true
    break
  fi
  sleep 1
done

SMOKE_PASS=true
if [ "$READY" = true ]; then
  # Smoke key routes
  for route in "/" "/api/ready" "/dashboard" "/leads" "/contracts" "/quotations" "/payments"; do
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

# Trigger cleanup via trap (kills candidate group + verifies port)
cleanup_candidate

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
# git safe.directory: release dir owned by deploy (sudo → root) but run by systemd (root);
# next.config.ts calls `git rev-parse` at startup
sudo /usr/bin/git config --system --add safe.directory "$RELEASE_DIR" 2>/dev/null || true
sudo /usr/bin/git config --system --add safe.directory /opt/newme/current 2>/dev/null || true
# Reset StartLimitBurst counter — earlier restart loops may have exhausted it
sudo /usr/bin/systemctl reset-failed newme-platform.service 2>/dev/null || true
sudo /usr/bin/systemctl restart newme-platform.service
sleep 5

# --- Step 8: Production validation ---
echo "--- Production Smoke ---"
HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"down"}')
HEALTH_BUILD=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('release','unknown'))" 2>/dev/null || echo "unknown")
HEALTH_STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','down'))" 2>/dev/null || echo "down")

if [ "$HEALTH_STATUS" != "ok" ]; then
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

# GC orphan dependency hashes — deprecated. Dependencies now come from source repo.
# The shared/node_modules symlink points to the project's node_modules.
echo "  Dependency GC: skipped (using source repo node_modules)"

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
  "dependencies": "source-repo (shared/node_modules)",
  "symlink_repair": $SYMLINK_REPAIR_JSON,
  "result": "pass",
  "finished_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EVIEOF

echo "✅ Evidence: $EVIDENCE_FILE"

# --- Cleanup ---
rm -f "$LOCKFILE"
echo "=== Deploy Complete: $RELEASE_ID ==="
