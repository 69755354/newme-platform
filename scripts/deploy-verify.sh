#!/usr/bin/env bash
# CRM deployment verification. The default harness is versioned with this repository.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGRESSION_SCRIPT="${CRM_REGRESSION_SCRIPT:-$SCRIPT_DIR/crm-regression.py}"

if ! test -r "$REGRESSION_SCRIPT"; then
  echo "FAIL: CRM regression harness is not readable: $REGRESSION_SCRIPT" >&2
  exit 1
fi

echo "=== CRM Pre-Deploy Verification ==="
if ! python3 "$REGRESSION_SCRIPT" --pre-deploy; then
  echo "FAIL: Pre-deploy regression failed. Aborting." >&2
  exit 1
fi

echo ""
echo "Pushing changes..."
if [ "${1:-}" != "--no-git" ]; then
  if ! git push; then
    echo "WARN: git push failed"
  fi
fi

# Wait for deploy to take effect.
sleep 3

echo ""
echo "=== CRM Post-Deploy Verification ==="
python3 "$REGRESSION_SCRIPT" --post-deploy

echo ""
echo "=== Done ==="
