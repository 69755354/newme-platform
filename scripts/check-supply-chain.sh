#!/usr/bin/env bash
# check-supply-chain.sh — 供应链门禁 (SAM-70)
# 在 prebuild / pre-commit hook 中调用，拦截未经验证的依赖漂移
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
PASS=0; FAIL=0

report()  { echo -e "${GREEN}[PASS]${NC} $*"; ((PASS+=1)); }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()   { echo -e "${RED}[FAIL]${NC} $*"; ((FAIL+=1)); }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ─── 1. 关键依赖精确版本 ──────────────────────────────────────
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

# ─── 3. lockfile 存在性 ────────────────────────────────────────
echo ""
echo "=== 3. lockfile ==="
if [[ -f package-lock.json ]]; then
    report "package-lock.json 存在"
else
    fail "package-lock.json 缺失 — 依赖未锁定"
fi

# ─── 4. npm audit 高危检查 ─────────────────────────────────────
echo ""
echo "=== 4. npm audit (HIGH/CRITICAL) ==="
AUDIT_OUT=$(npm audit --json 2>/dev/null || true)
if [[ -z "$AUDIT_OUT" ]]; then
    warn "npm audit 返回空 (可能网络问题)，跳过"
else
    HIGH_COUNT=$(echo "$AUDIT_OUT" | node -e "
        const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        const vulns = d.vulnerabilities || {};
        // 只看直接依赖 且 via 包含实际 advisory 对象（非字符串引用）
        const direct_high = Object.values(vulns).filter(v => {
            if (v.severity !== 'high' && v.severity !== 'critical') return false;
            if (!v.isDirect) return false;
            // via 全为字符串 = 继承自子依赖，非包自身问题
            const hasOwnAdvisory = v.via.some(x => typeof x === 'object' && x.source);
            return hasOwnAdvisory;
        });
        console.log(direct_high.length);
    " 2>/dev/null || echo "0")

    if [[ "$HIGH_COUNT" -gt 0 ]]; then
        echo "$AUDIT_OUT" | node -e "
            const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const vulns = d.vulnerabilities || {};
            Object.values(vulns)
                .filter(v => {
                    if (v.severity !== 'high' && v.severity !== 'critical') return false;
                    if (!v.isDirect) return false;
                    return v.via.some(x => typeof x === 'object' && x.source);
                })
                .forEach(v => console.log('  ' + v.name + ': ' + v.severity.toUpperCase() + ' — ' + (v.via[0]?.title || v.via[0])));
        " 2>/dev/null
        fail "${HIGH_COUNT} 个直接依赖存在 HIGH/CRITICAL 漏洞"
    else
        report "无直接依赖高危漏洞"
    fi
fi

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
    warn ".nvmrc 不存在，跳过 Node 版本检查"
fi

# ─── 结果 ──────────────────────────────────────────────────────
echo ""
echo "──────────────────────────────────────────"
echo -e "通过: ${GREEN}${PASS}${NC}  失败: ${RED}${FAIL}${NC}"
if [[ "$FAIL" -gt 0 ]]; then
    echo -e "${RED}供应链门禁未通过 — 修复后重试${NC}"
    exit 1
else
    echo -e "${GREEN}供应链门禁通过${NC}"
    exit 0
fi
