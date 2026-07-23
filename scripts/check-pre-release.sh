#!/usr/bin/env bash
# check-pre-release.sh — SAM-67 统一发布前门禁
# fail-closed: 任何必需检查缺失或失败即退出 1
# 用法: npm run check:pre-release
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
PASS=0; FAIL=0

# Use assignments, not arithmetic command status, so set -e cannot terminate on a zero counter.
_pass() { echo -e "  ${GREEN}PASS${NC} $*"; PASS=$((PASS + 1)); }
_fail() { echo -e "  ${RED}FAIL${NC} $*"; FAIL=$((FAIL + 1)); }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-full}" != "full" ]]; then
    echo -e "${RED}⛔ 发布门禁只支持 full 模式；快速模式不能用于发布。${NC}"
    exit 2
fi

echo "════════════════════════════════════════════"
echo "  SAM-67 发布前门禁 — main=$(git rev-parse --short HEAD)"
echo "  mode=full"
echo "════════════════════════════════════════════"

echo ""
echo "── 0. TypeScript ──"
if npx tsc --noEmit 2>&1; then _pass "tsc --noEmit"; else _fail "tsc --noEmit 有类型错误"; fi

echo ""
echo "── 1. 测试 ──"
if npm test 2>&1 | tail -3; then _pass "npm test"; else _fail "npm test 失败"; fi

echo ""
echo "── 2. 供应链 ──"
SUPPLY_CHAIN_ARGS=()
if [[ "${ALLOW_KNOWN_SUPPLY_CHAIN_EXCEPTIONS:-0}" == "1" ]]; then
    SUPPLY_CHAIN_ARGS+=(--accept-known)
    echo "已显式启用已知供应链例外清单。"
fi
if bash scripts/check-supply-chain.sh "${SUPPLY_CHAIN_ARGS[@]}"; then
    _pass "supply-chain"
else
    _fail "supply-chain"
fi

echo ""
echo "── 3. Release ──"
for check in schema-refs route-files smoke logs; do
    script="scripts/check-${check}.sh"
    runner=(bash)
    if [[ "$check" == "schema-refs" ]]; then
        script="scripts/check-schema-refs.py"
        runner=(python3)
    fi
    if [[ ! -f "$script" ]]; then
        _fail "check:${check} (必需脚本不存在)"
    elif "${runner[@]}" "$script" 2>&1; then
        _pass "check:${check}"
    else
        _fail "check:${check}"
    fi
done

echo ""
echo "── 4. 安全 ──"
for check in supabase-boundaries db-static e2e-secrets; do
    script="scripts/check-${check}.mjs"
    if [[ ! -f "$script" ]]; then
        _fail "check:${check} (必需脚本不存在)"
    elif node "$script" 2>&1; then
        _pass "check:${check}"
    else
        _fail "check:${check}"
    fi
done

echo ""
echo "── 5. 基础设施 ──"
for entry in "check-workflows-yaml:bash:scripts/check-workflows-yaml.sh" "check-database-types:node:scripts/check-database-types.mjs"; do
    IFS=: read -r check runner script <<< "$entry"
    if [[ ! -f "$script" ]]; then
        _fail "${check} (必需脚本不存在)"
    elif "$runner" "$script" 2>&1; then
        _pass "${check}"
    else
        _fail "${check}"
    fi
done

echo ""
echo "════════════════════════════════════════════"
echo -e "  通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}"
echo "════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
    echo -e "${RED}⛔ 门禁未通过 — ${FAIL} 项失败${NC}"
    exit 1
fi
echo -e "${GREEN}✅ 门禁通过${NC}"
