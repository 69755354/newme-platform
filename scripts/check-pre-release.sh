#!/usr/bin/env bash
# check-pre-release.sh — SAM-67 统一发布前门禁
# fail-closed: 任何一项失败即退出 1
# 用法: npm run check:pre-release  或   bash scripts/check-pre-release.sh
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0; SKIP=0

_pass()  { echo -e "  ${GREEN}PASS${NC} $*"; ((PASS+=1)); }
_fail()  { echo -e "  ${RED}FAIL${NC} $*"; ((FAIL+=1)); }
_skip()  { echo -e "  ${YELLOW}SKIP${NC} $*"; ((SKIP+=1)); }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GATE="${1:-full}"  # "full" or "quick" (skip slow checks)

echo "════════════════════════════════════════════"
echo "  SAM-67 发布前门禁 — main=$(git rev-parse --short HEAD)"
echo "  mode=$GATE"
echo "════════════════════════════════════════════"

# ─── 0. 类型检查 ───────────────────────────────────────────
echo ""
echo "── 0. TypeScript ──"
if npx tsc --noEmit 2>&1; then
    _pass "tsc --noEmit"
else
    _fail "tsc --noEmit 有类型错误"
fi

# ─── 1. 测试 ────────────────────────────────────────────────
echo ""
echo "── 1. 测试 ──"
if npm test 2>&1 | tail -3; then
    _pass "npm test"
else
    _fail "npm test 失败"
fi

# ─── 2. 供应链门禁 ──────────────────────────────────────────
echo ""
echo "── 2. 供应链 ──"
if bash scripts/check-supply-chain.sh --accept-known; then
    _pass "supply-chain"
else
    _fail "supply-chain"
fi

# ─── 3. Release 检查 ─────────────────────────────────────────
echo ""
echo "── 3. Release ──"
RELEASE_OK=true
for check in schema-refs route-files smoke logs; do
    script="scripts/check-${check}.sh"
    if [[ "$check" == "schema-refs" ]]; then
        script="scripts/check-schema-refs.py"
    fi
    if [[ -f "$script" ]]; then
        if bash "$script" 2>&1 || python3 "$script" 2>&1; then
            _pass "check:${check}"
        else
            _fail "check:${check}"
            RELEASE_OK=false
        fi
    else
        _skip "check:${check} (脚本不存在)"
    fi
done

# ─── 4. 安全检查 ────────────────────────────────────────────
echo ""
echo "── 4. 安全 ──"
for check in supabase-boundaries db-static e2e-secrets; do
    script="scripts/check-${check}.mjs"
    if [[ -f "$script" ]]; then
        if node "$script" 2>&1; then
            _pass "check:${check}"
        else
            _fail "check:${check}"
        fi
    else
        _skip "check:${check} (脚本不存在)"
    fi
done

# ─── 5. Workflow / DB types ──────────────────────────────────
if [[ "$GATE" != "quick" ]]; then
    echo ""
    echo "── 5. 基础设施 ──"
    if [[ -f scripts/check-workflows-yaml.sh ]]; then
        if bash scripts/check-workflows-yaml.sh 2>&1; then
            _pass "check:workflows"
        else
            _fail "check:workflows"
        fi
    else
        _skip "check:workflows"
    fi
    if [[ -f scripts/check-database-types.mjs ]]; then
        if node scripts/check-database-types.mjs 2>&1; then
            _pass "check:database-types"
        else
            _fail "check:database-types"
        fi
    else
        _skip "check:database-types"
    fi
fi

# ─── 结果 ───────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo -e "  通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}  跳过: ${YELLOW}${SKIP}${NC}"
echo "════════════════════════════════════════════"

if [[ "$FAIL" -gt 0 ]]; then
    echo -e "${RED}⛔ 门禁未通过 — ${FAIL} 项失败${NC}"
    exit 1
else
    echo -e "${GREEN}✅ 门禁通过${NC}"
    exit 0
fi
