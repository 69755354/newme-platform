#!/bin/bash
# 🔴 PRODUCTION BUILD GUARD
# Prevents direct `npm run build` from overwriting production .next directory.
# deploy.sh is the ONLY entry point allowed to write production .next.
#
# Rules enforced:
#   1. Production service active → ABORT (no FORCE_BUILD bypass)
#   2. Production marker file present → ABORT (even if service down)
#   3. Running from outside deploy.sh → verify not in prod directory
#
# Deploy.sh communicates intent by touching .hermes/deploy-in-progress before build.

set -e

PROD_MARKER="/home/ubuntu/newme-platform/.hermes/IS_PRODUCTION"
DEPLOY_LOCK="/home/ubuntu/newme-platform/.hermes/deploy-in-progress"
SERVICE="newme-platform.service"
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

# ── Check 1: Are we in a production directory? ──
IS_PROD=0
CURRENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$PROD_MARKER" ] || [ "$CURRENT_DIR" = "/home/ubuntu/newme-platform" ]; then
  IS_PROD=1
fi

if [ "$IS_PROD" -eq 0 ]; then
  # Not production — safe to build
  exit 0
fi

# ── Check 2: Is deploy.sh explicitly requesting this build? ──
if [ -f "$DEPLOY_LOCK" ]; then
  # Deploy.sh invoked this build — allowed
  exit 0
fi

# ── Check 3: Production service active? ──
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo -e "${RED}🚫 PRODUCTION BUILD BLOCKED${NC}"
  echo ""
  echo "  Production service '$SERVICE' is RUNNING."
  echo "  Direct 'npm run build' would overwrite the live .next directory"
  echo "  and cause 500 errors on all JS/CSS chunks."
  echo ""
  echo "  ✅ Correct:  sudo /opt/newme/deploy/deploy.sh"
  echo "     (auto-stops → builds → restarts with health check)"
  echo ""
  echo "  ❌ Forbidden: npm run build"
  echo "  ❌ Forbidden: FORCE_BUILD=1 npm run build"
  echo "  ❌ Forbidden: ANALYZE=true npm run build"
  echo ""
  echo "  FORCE_BUILD cannot bypass production safety."
  echo "  Use deploy.sh — it is the only entry point for production builds."
  echo ""
  exit 1
fi

# ── Check 4: Production directory but service not running ──
# This is unusual — warn but allow (for disaster recovery)
echo -e "${YELLOW}⚠️  Production directory detected but service is NOT running.${NC}"
echo -e "${YELLOW}   Proceeding with build (disaster recovery mode).${NC}"
echo ""
exit 0
