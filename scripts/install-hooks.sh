#!/bin/bash
# 安装 NewMe hook 链 — 一次性运行，后续自动校验
# 用法: ./scripts/install-hooks.sh [--force]

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GITHOOKS_DIR="$REPO_ROOT/.githooks"
GIT_HOOKS_DIR="$REPO_ROOT/.git/hooks"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo "═══════════════════════════════════════════"
echo "  NewMe Hook Chain Installer"
echo "═══════════════════════════════════════════"

# ── Check .githooks directory ──
if [ ! -d "$GITHOOKS_DIR" ]; then
    echo -e "${RED}❌ .githooks/ not found at $GITHOOKS_DIR${NC}"
    exit 1
fi

# ── Check required hooks exist ──
MISSING=false
for hook in pre-commit commit-msg pre-push; do
    if [ ! -f "$GITHOOKS_DIR/$hook" ]; then
        echo -e "${RED}❌ Missing hook: .githooks/$hook${NC}"
        MISSING=true
    fi
done
if [ "$MISSING" = true ]; then
    exit 1
fi

# ── If --force, remove existing hooks ──
if [ "${1:-}" = "--force" ]; then
    echo -e "${YELLOW}⚠️  --force: resetting hook chain...${NC}"
    rm -f "$GIT_HOOKS_DIR/pre-commit" "$GIT_HOOKS_DIR/commit-msg" "$GIT_HOOKS_DIR/pre-push"
fi

# ── Back up existing hooks (if real, not sample) ──
for hook in pre-commit commit-msg pre-push; do
    EXISTING="$GIT_HOOKS_DIR/$hook"
    if [ -f "$EXISTING" ] && [ ! "$EXISTING" -ef "$GITHOOKS_DIR/$hook" ]; then
        if echo "$EXISTING" | grep -qv '\.sample$'; then
            BACKUP="$EXISTING.backup.$(date +%s)"
            cp "$EXISTING" "$BACKUP"
            echo -e "${YELLOW}📦 Backed up existing $hook → $BACKUP${NC}"
        fi
    fi
done

# ── Symlink hooks ──
for hook in pre-commit commit-msg pre-push; do
    SRC="$GITHOOKS_DIR/$hook"
    DST="$GIT_HOOKS_DIR/$hook"
    if [ -f "$DST" ]; then
        rm "$DST"
    fi
    ln -sf "$SRC" "$DST"
    chmod +x "$SRC"
    echo -e "${GREEN}✅ Installed: $hook${NC}"
done

# ── Compute and store hashes in manifest ──
MANIFEST="$GITHOOKS_DIR/manifest.json"
python3 -c "
import json, hashlib, os, time

manifest_path = '$MANIFEST'
hooks_dir = '$GITHOOKS_DIR'

try:
    with open(manifest_path) as f:
        m = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    m = {'version': 1, 'hooks': {}, 'installed_at': '', 'installed_by': ''}

for hook in ['pre-commit', 'commit-msg', 'pre-push']:
    path = os.path.join(hooks_dir, hook)
    if os.path.exists(path):
        with open(path, 'rb') as f:
            h = hashlib.sha256(f.read()).hexdigest()
        m['hooks'][hook] = h

m['installed_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
m['installed_by'] = os.environ.get('USER', 'unknown')

with open(manifest_path, 'w') as f:
    json.dump(m, f, indent=2)
print('✅ Manifest updated')
"

# ── Set git hooksPath as backup ──
git config hooks.githooks "$GITHOOKS_DIR"

echo ""
echo -e "${GREEN}══════ Hook chain installed successfully ══════${NC}"
echo ""
echo "  Chain: pre-commit → commit-msg → pre-push"
echo "  Self-verification: ✓ (each hook checks the others)"
echo "  Integrity:         ✓ (sha256 in manifest.json)"
echo "  Tamper:            ✗ (modified hooks auto-block)"
echo ""
echo -e "${YELLOW}GLM CP 用户：在 GLM CP session 中执行以下操作：${NC}"
echo "  1. echo '{\"expires_at\":$(date -d \"+1 hour\" +%s)}' > .hermes/state/glm-cp-auth.json"
echo "  2. git commit -m \"[GLM-CP] feat: xxx\""
echo ""
echo -e "${YELLOW}v4：以上都不操作。直接 git commit 会被拦截。${NC}"
