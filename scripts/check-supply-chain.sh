#!/usr/bin/env bash
# check-supply-chain.sh — 供应链门禁 (SAM-67/SAM-70)
# fail-closed: 网络失败、解析失败、审计失败、任何 HIGH/CRITICAL 漏洞均阻断
# 已知且已文档化的漏洞可通过 --accept-known 或 ACCEPT_KNOWN=1 豁免
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

report()  { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS+=1)); }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()   { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL+=1)); }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ACCEPT_KNOWN="${ACCEPT_KNOWN:-}"
if [[ "${1:-}" == "--accept-known" ]]; then
    ACCEPT_KNOWN=1
fi

# ─── 0. 环境自检 ───────────────────────────────────────────────
echo "=== 0. 环境自检 ==="
if ! command -v npm &>/dev/null; then
    fail "npm 不可用"
fi
if ! command -v node &>/dev/null; then
    fail "node 不可用"
fi
if ! command -v sha256sum &>/dev/null; then
    fail "sha256sum 不可用"
fi
if [[ "$FAIL" -gt 0 ]]; then
    echo "基础环境不完整，阻断。"
    exit 1
fi
report "npm $(npm --version), node $(node --version)"

# ─── 1. 关键依赖精确版本 ──────────────────────────────────────
echo ""
echo "=== 1. 关键依赖精确版本 ==="
CRITICAL_DEPS=("next" "react" "react-dom")
for dep in "${CRITICAL_DEPS[@]}"; do
    ver=$(node -e "const p=require('./package.json'); console.log(p.dependencies['${dep}'] || p.devDependencies['${dep}'] || '')")
    if [[ "$ver" =~ ^[~^] ]]; then
        fail "${dep}: ${ver} — 不允许使用 ^/~ 范围版本，必须精确锁定"
    elif [[ -z "$ver" ]]; then
        fail "${dep}: 未在 dependencies 中找到"
    else
        report "${dep}: ${ver} (精确)"
    fi
done

# ─── 2. xlsx 完整性校验 ────────────────────────────────────────
echo ""
echo "=== 2. xlsx CDN 完整性 ==="
XLSX_HASH_EXPECTED="7385d8ea33c4feaa85e0f27430f7631c142d07c0a052f9f5e73b5fddb88acbe8"
if [[ -f node_modules/xlsx/package.json ]]; then
    XLSX_HASH_ACTUAL=$(sha256sum node_modules/xlsx/package.json | awk '{print $1}')
    if [[ "$XLSX_HASH_ACTUAL" == "$XLSX_HASH_EXPECTED" ]]; then
        report "xlsx package.json hash 匹配"
    else
        fail "xlsx 完整性校验失败: 期望 ${XLSX_HASH_EXPECTED:0:16}... 实际 ${XLSX_HASH_ACTUAL:0:16}..."
    fi
else
    fail "xlsx 未安装 (node_modules/xlsx 不存在)"
fi

# ─── 3. lockfile 存在性与完整性 ────────────────────────────────
echo ""
echo "=== 3. lockfile ==="
if [[ -f package-lock.json ]]; then
    report "package-lock.json 存在"
    # Verify lockfile is in sync with package.json
    if npm ls --package-lock-only 2>&1 | grep -qE 'UNMET|INVALID|ERR!'; then
        fail "package-lock.json 与 package.json 不同步，请运行 npm install"
    else
        report "package-lock.json 同步"
    fi
else
    fail "package-lock.json 缺失 — 依赖未锁定"
fi

# ─── 4. npm audit 高危检查 (fail-closed) ────────────────────────
echo ""
echo "=== 4. npm audit (HIGH/CRITICAL) ==="

AUDIT_TMP=$(mktemp)
AUDIT_RC=0
npm audit --json > "$AUDIT_TMP" 2>/dev/null || AUDIT_RC=$?

if [[ ! -s "$AUDIT_TMP" ]]; then
    fail "npm audit 未返回可审计数据 (exit=$AUDIT_RC) — registry 或网络不可用"
else
    AUDIT_SUMMARY_RC=0
    AUDIT_SUMMARY=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
vulns = d.get('vulnerabilities')
metadata = d.get('metadata')
counts = metadata.get('vulnerabilities') if isinstance(metadata, dict) else None
if not isinstance(vulns, dict) or not isinstance(counts, dict):
    raise ValueError('npm audit response is missing vulnerability data')
high = {k:v for k,v in vulns.items() if isinstance(v, dict) and v.get('severity') in ('high', 'critical')}
print('TOTAL_HIGH=' + str(len(high)))
" "$AUDIT_TMP" 2>/dev/null) || AUDIT_SUMMARY_RC=$?

    if [[ "$AUDIT_SUMMARY_RC" -ne 0 ]]; then
        fail "npm audit 返回无效或不完整 JSON — 拒绝按零漏洞处理"
    else
        HIGH_COUNT=$(echo "$AUDIT_SUMMARY" | grep '^TOTAL_HIGH=' | cut -d= -f2 || true)
        if [[ ! "$HIGH_COUNT" =~ ^[0-9]+$ ]]; then
            fail "npm audit 高危计数无效"
        elif [[ -n "$ACCEPT_KNOWN" ]]; then
            ACCEPT_FILE="$ROOT/.supply-chain-accept.json"
            if [[ ! -f "$ACCEPT_FILE" ]]; then
                fail "--accept-known 已启用但豁免清单不存在"
            else
                XREF_OUTPUT=""
                XREF_RC=0
                XREF_OUTPUT=$(python3 "$ROOT/scripts/_supply_chain_xref.py" "$AUDIT_TMP" "$ACCEPT_FILE" 2>&1) || XREF_RC=$?
                echo "$XREF_OUTPUT" | { grep -v '^COUNT=' || true; }
                if [[ "$XREF_RC" -ne 0 ]]; then
                    fail "供应链豁免清单或交叉引用无效"
                else
                    UNACCEPTED_COUNT=$(echo "$XREF_OUTPUT" | grep '^COUNT=' | cut -d= -f2 || true)
                    if [[ ! "$UNACCEPTED_COUNT" =~ ^[0-9]+$ ]] || [[ "$UNACCEPTED_COUNT" -gt "$HIGH_COUNT" ]]; then
                        fail "供应链交叉引用计数无效"
                    else
                        ACCEPTED_COUNT=$((HIGH_COUNT - UNACCEPTED_COUNT))
                        if [[ "$ACCEPTED_COUNT" -gt 0 ]]; then
                            warn "$ACCEPTED_COUNT 个高危漏洞已按精确 advisory 和有效期文档化豁免"
                        fi
                        if [[ "$UNACCEPTED_COUNT" -gt 0 ]]; then
                            fail "$UNACCEPTED_COUNT 个未豁免 HIGH/CRITICAL 漏洞"
                        else
                            report "全部 $HIGH_COUNT 个高危漏洞已处理（$ACCEPTED_COUNT 豁免）"
                        fi
                    fi
                fi
            fi
        elif [[ "$HIGH_COUNT" -gt 0 ]]; then
            fail "$HIGH_COUNT 个 HIGH/CRITICAL 漏洞（未启用经过审查的豁免清单）"
        else
            report "无 HIGH/CRITICAL 漏洞"
        fi
    fi
fi
rm -f "$AUDIT_TMP"
# ─── 5. Node 版本校验 ──────────────────────────────────────────
echo ""
echo "=== 5. Node 版本 ==="
if [[ -f .nvmrc ]]; then
    NVM_EXPECTED=$(cat .nvmrc | tr -d '[:space:]')
    NODE_ACTUAL=$(node --version | sed 's/^v//')
    if [[ "$NODE_ACTUAL" == "$NVM_EXPECTED"* ]]; then
        report "Node v${NODE_ACTUAL} 匹配 .nvmrc (${NVM_EXPECTED})"
    else
        fail "Node 版本不匹配: 实际 v${NODE_ACTUAL}, .nvmrc 要求 ${NVM_EXPECTED}"
    fi
else
    fail ".nvmrc 不存在"
fi

# ─── 结果 ──────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────"
echo -e "通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}"
if [[ "$FAIL" -gt 0 ]]; then
    echo -e "${RED}⛔ 供应链门禁未通过 — ${FAIL} 项失败${NC}"
    exit 1
else
    echo -e "${GREEN}✅ 供应链门禁通过${NC}"
    exit 0
fi
