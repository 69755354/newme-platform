#!/usr/bin/env bash
# Canonical local pre-release aggregate. Every entry delegates to the same npm
# command CI uses; this script contains no alternate implementations or skips.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "${1:-full}" != full ]; then
  echo "usage: bash scripts/check-pre-release.sh [full]" >&2
  exit 64
fi

run_gate() {
  local name="$1"
  shift
  printf '\n== %s ==\n' "$name"
  "$@"
}

run_gate taskboard npm run check:taskboard
run_gate typecheck npm run typecheck
run_gate tests npm test
run_gate lint-baseline npm run lint:baseline
run_gate supply-chain npm run check:supply-chain -- --accept-known
run_gate release npm run check:release
run_gate security npm run check:security
run_gate workflows npm run check:workflows
run_gate database-types npm run check:database-types
run_gate migration-history npm run check:migration-history
run_gate release-manifest npm run check:release-manifest
run_gate release-companions npm run check:release-companions

printf '\nPRE-RELEASE GATE PASSED\n'
