#!/usr/bin/env bash
# Run the NEWME OS regression suite and write a Chinese Markdown report.
#   bash e2e/regression/run.sh                      # full suite against staging
#   E2E_SUITE=smoke bash e2e/regression/run.sh      # staging, smoke subset only
#   E2E_BASE_URL=https://app.newme.ae E2E_ALLOW_PRODUCTION=1 \
#     E2E_ACCOUNTS_FILE=$HOME/.config/newme/qa-accounts.txt bash e2e/regression/run.sh   # production smoke (read-only: nothing is written there)
# Extra arguments are passed to Playwright (for example a spec file or -g "@bug-4a-1").
set -u
cd "$(dirname "$0")/../.."
LOCK="${E2E_BUILD_LOCK:-$HOME/newme-ops/fixes/.build.lock}"
export E2E_RUN_ID="${E2E_RUN_ID:-$(date -u +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
RUN_DIR="e2e/regression/.runs/$E2E_RUN_ID"
umask 077
mkdir -p -m 700 e2e/regression/.runs
mkdir -p -m 700 "$RUN_DIR"
if [ "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" -lt 2500 ]; then
  echo "可用内存低于 2500 MB，先等一等再跑（见 COMMON-RULES）" >&2
  exit 3
fi
flock "$LOCK" env NODE_OPTIONS=--max-old-space-size=2048 \
  node node_modules/@playwright/test/cli.js test -c e2e/regression/playwright.regression.config.ts "$@"
STATUS=$?
if [ -f "$RUN_DIR/results.json" ]; then
  node e2e/regression/lib/report.mjs "$RUN_DIR/results.json" "$RUN_DIR/report.md" "$RUN_DIR/meta.json"
  echo "报告：$RUN_DIR/report.md"
else
  echo "没有生成 results.json（套件在开始前就失败了，见上面的输出）" >&2
fi
exit $STATUS
