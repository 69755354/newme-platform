#!/bin/bash
# CRM 部署前/后自动验证 — git hook + 手动
# 放在 .git/hooks/pre-push 或手动: bash deploy-verify.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGRESSION_SCRIPT="/home/ubuntu/.hermes/scripts/crm-regression.py"

echo "=== CRM Pre-Deploy Verification ==="
python3 "$REGRESSION_SCRIPT" --pre-deploy
if [ $? -ne 0 ]; then
    echo "FAIL: Pre-deploy regression failed. Aborting."
    exit 1
fi

echo ""
echo "Pushing changes..."
if [ "$1" != "--no-git" ]; then
    git push
    if [ $? -ne 0 ]; then
        echo "WARN: git push failed"
    fi
fi

# Wait for deploy to take effect
sleep 3

echo ""
echo "=== CRM Post-Deploy Verification ==="
python3 "$REGRESSION_SCRIPT" --post-deploy

echo ""
echo "=== Done ==="
