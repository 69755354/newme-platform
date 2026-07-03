#!/bin/bash
# 🔴 PRODUCTION BUILD GUARD v2.0
# Prevents direct `npm run build` from overwriting production .next directory.
# deploy.sh (v4+) now builds in /tmp/newme-build-* — this guard allows that.
#
# ALLOW conditions (any one is sufficient):
#   A. CWD is NOT /home/ubuntu/newme-platform AND no IS_PRODUCTION marker in CWD
#   B. CWD matches /tmp/newme-build-* (isolated deploy build)
#   C. NEWME_ISOLATED_BUILD=1 env var set
#   D. Deploy lock .hermes/deploy-in-progress exists in CWD
#
# BLOCK conditions:
#   1. Production service active + CWD is /home/ubuntu/newme-platform
#   2. FORCE_BUILD or ANALYZE in production CWD
#
# ⚠️  FORCE_BUILD cannot bypass production safety.
# ⚠️  Only deploy.sh (v4+) is the authorized production build entry point.
# ──────────────────────────────────────────────────────────────────
set -e

PROD_DIR="/home/ubuntu/newme-platform"
PROD_MARKER="$PROD_DIR/.hermes/IS_PRODUCTION"
SERVICE="newme-platform.service"
RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
NC='\033[0m'

# Resolve CWD independently of where this script lives
CURRENT_DIR="$(pwd)"

# ── ALLOW: NEWME_ISOLATED_BUILD env var ──
if [ "${NEWME_ISOLATED_BUILD:-0}" = "1" ]; then
  echo -e "${GREEN}✅ Isolated build (NEWME_ISOLATED_BUILD=1)${NC}"
  exit 0
fi

# ── ALLOW: deploy lock in CWD ──
if [ -f ".hermes/deploy-in-progress" ]; then
  echo -e "${GREEN}✅ Deploy lock present — authorized build${NC}"
  exit 0
fi

# ── PRODUCTION CHECK: are we in the production directory? ──
IS_PROD=0
if [ "$CURRENT_DIR" = "$PROD_DIR" ]; then
  IS_PROD=1
elif [ -f "$PROD_MARKER" ] && [ "$(pwd)" = "$PROD_DIR" ]; then
  IS_PROD=1
fi

# ── ALLOW: Isolated build directory (/tmp/newme-build-*) ──
case "$CURRENT_DIR" in
  /tmp/newme-build-*)
    echo -e "${GREEN}✅ Isolated build directory: $CURRENT_DIR${NC}"
    exit 0
    ;;
esac

# ── If not production AND not matched above → safe to build ──
if [ "$IS_PROD" -eq 0 ]; then
  # Development, CI, or other non-production context
  exit 0
fi

# ── BLOCK: Production directory — check service status ──
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo -e "${RED}🚫 PRODUCTION BUILD BLOCKED${NC}"
  echo ""
  echo "  Production service '$SERVICE' is RUNNING."
  echo "  Direct build would overwrite the live .next directory"
  echo "  and cause 500 errors on all JS/CSS chunks."
  echo ""
  echo "  ✅ Correct:  sudo /opt/newme/deploy/deploy.sh"
  echo "  ❌ Forbidden: npm run build"
  echo "  ❌ Forbidden: FORCE_BUILD=1 npm run build"
  echo "  ❌ Forbidden: ANALYZE=true npm run build"
  echo ""
  exit 1
fi

# ── Production directory but service NOT running ──
echo -e "${YELLOW}⚠️  Production directory but service is NOT running.${NC}"
echo -e "${YELLOW}   Proceeding (disaster recovery mode).${NC}"
exit 0
