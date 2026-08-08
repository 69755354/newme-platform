#!/usr/bin/env bash
set -e -o pipefail

# ─── NewMe CRM Deploy Pipeline ───────────────────────────────
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
echo "--- Step 0/5: Taskboard gate ---"
if [ -f "scripts/check-taskboard.sh" ]; then
  bash scripts/check-taskboard.sh
  if [ $? -ne 0 ]; then
    echo ""
    ech