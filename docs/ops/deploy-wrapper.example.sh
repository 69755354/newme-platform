#!/usr/bin/env bash
# ─── NewMe CRM Deploy Wrapper ───────────────────────────────
# Root-owned gate. Agent cannot sudo systemctl restart directly.
# This is the ONLY allowed deployment entry point.
#
# Owner: root:root  Mode: 755
# ubuntu user CANNOT write to this file.
# ─────────────────────────────────────────────────────────────
set -e -o pipefail

PROJECT_ROOT="/home/ubuntu/newme-platform"

if [ ! -d "$PROJECT_ROOT" ]; then
    echo "❌ Project root not found: $PROJECT_ROOT"
    exit 1
fi

echo "=== 🚀 NewMe CRM Deploy (wrapper) ==="
echo "Project: $PROJECT_ROOT"
echo "Time:    $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
echo "User:    $(whoami)"
echo ""

cd "$PROJECT_ROOT"
exec bash scripts/deploy.sh "$@"
