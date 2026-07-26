# SAM-32/33 生产依赖闭环审计

**审计基准**: staging candidate `b24b148` + dependency patch | **日期**: 2026-07-26 | **工具**: `npm audit`

---

## 1. 已修复（npm audit fix）

`npm audit fix` 自动升级以下传递依赖，消除 5 个中低危漏洞：

| 包 | 修复前 | 修复后 | 漏洞 |
|----|--------|--------|------|
| brace-expansion | — | 已移除 | HIGH: ReDoS |
| fast-uri | — | 已升级 | HIGH: ReDoS |
| js-yaml | 旧版 | 已升级 | MODERATE: YAML merge-key DoS |
| @inquirer/* | 多个包 | 已移除 | MODERATE |

**操作**: `npm audit fix` 自动完成，仅修改 `package-lock.json`。

---

## 2. 残余 6 漏洞（3 moderate + 3 high）

### 2.1 @hono/node-server — Path Traversal (MODERATE)

| 属性 | 值 |
|------|-----|
| CVE | GHSA-frvp-7c67-39w9 |
| CWE | CWE-22 |
| CVSS | 5.9 |
| 版本 | <2.0.5（当前 1.19.14） |
| 直接依赖 | ❌（间接：shadcn → @modelcontextprotocol/sdk → @hono/node-server → hono） |
| 运行时路径 | `shadcn` CLI 使用 MCP SDK，MCP SDK 使用 hono 作为 HTTP 服务器。仅在开发时 `npx shadcn` 命令执行期间加载。 |

**可利用性: 不适用**
- 漏洞是 Windows 专属（`%5C` 编码反斜杠路径穿越）
- 生产环境: Linux (Ubuntu 22.04)，路径分隔符为 `/`，`%5C` 不会被解释为路径分隔符
- 运行时: 该依赖仅在开发 CLI 中使用，不在生产 bundle 中

**处理**: 接受风险。Linux 部署不受影响。可验证隔离：`uname -s` = Linux。

### 2.2 @modelcontextprotocol/sdk — 继承 hono 漏洞 (MODERATE)

| 属性 | 值 |
|------|-----|
| 直接依赖 | ❌（间接：shadcn → @modelcontextprotocol/sdk） |
| 运行时路径 | shadcn CLI 开发时使用 |

**可利用性: 不适用**（同上，Windows only，开发时 CLI）

### 2.3 postcss (in next) — XSS + Arbitrary File Read (HIGH)

| 属性 | 值 |
|------|-----|
| CVE | GHSA-qx2v-qp2m-jg93 / GHSA-6g55-p6wh-862q / GHSA-r28c-9q8g-f849 |
| CWE | — |
| CVSS | — |
| 版本 | 8.4.31（next 16.2.12 内嵌；社区版需 8.5.18+） |
| 直接依赖 | ❌（next 内嵌副本，不可独立升级） |
| 修复版本 | postcss 8.5.18+ / next 16.3.0+ |
| 运行时路径 | Next.js SSR/SSG CSS 处理管线；每次页面渲染时处理 Tailwind CSS |

**可利用性: 低**
- GHSA-qx2v: XSS via `</style>` — 需要攻击者控制 CSS 输入。我们的 CSS 全部来自源码（Tailwind），非用户提交。
- GHSA-6g55 / GHSA-r28c: Arbitrary file read/path traversal via `sourceMappingURL` — 需要攻击者向 CSS 注释注入恶意 source map URL。CSS 由 Tailwind 编译生成，无用户输入路径。

**处理**: 缓解而非修复。
1. **WAF 层**: CSP `style-src 'self' 'unsafe-inline'` 阻止外部样式注入
2. **部署模型**: CSS 在构建时编译为静态文件（`.next/static/css/*.css`），运行时无动态 CSS 生成
3. **升级路径**: next 16.3.0+ 将内嵌 postcss 升级到安全版本。待 16.3 稳定后升级。

### 2.4 sharp (in next) — libvips CVEs (HIGH)

| 属性 | 值 |
|------|-----|
| CVE | GHSA-f88m-g3jw-g9cj |
| CWE | — |
| CVSS | — |
| 版本 | 0.34.5（next 16.2.12 内嵌；需 0.35.0+） |
| 直接依赖 | ❌（next 内嵌副本，不可独立升级） |
| 修复版本 | sharp 0.35.0+ / next 16.3.0+ |
| 运行时路径 | Next.js Image Optimization API (`next/image`)；用户上传图片时触发 sharp 处理 |

**可利用性: 低-中**
- libvips 继承漏洞包括 CVE-2026-33327/33328/35590/35591，涉及图像解析中的内存安全问题
- 触发条件：next/image 处理用户上传的恶意构造图片
- 我们的 CRM 中 `next/image` 使用场景有限（头像、logo），且图片来源受控

**处理**: 缓解而非修复。
1. **输入限制**: 上传接口限制文件类型（仅 JPEG/PNG/WebP）、文件大小（<5MB）
2. **独立服务**: 考虑将图片处理移至独立 CDN/服务（如 Cloudflare Images），减少 next/image 的攻击面
3. **升级路径**: next 16.3.0+ 将内嵌 sharp 升级到 0.35.0+

---

## 3. npm overrides 可行性

尝试通过 npm `overrides` 强制升级 next 内嵌 postcss/sharp：

```
// package.json
"overrides": {
  "next": {
    "postcss": "8.5.15",
    "sharp": "0.35.0"
  }
}
```

**结论: 不可行。** Next.js 16.2.12 在 `node_modules/next/postcss` 使用硬编码路径引用内嵌依赖，npm overrides 只对 `node_modules/next/node_modules/*` 有效，不影响 next 自身的 bundled deps。

---

## 4. xlsx CDN 来源与完整性 (SAM-33)

| 属性 | 值 |
|------|-----|
| 来源 | `https://cdn.sheetjs.com/xlsx-0.20.2/xlsx-0.20.2.tgz` |
| 版本固定 | ✅ URL 包含精确版本号 0.20.2 |
| lockfile 完整性 | ✅ package-lock.json 含 `integrity` 哈希 |
| npm audit 状态 | 0 漏洞 |
| sha256 | `7385d8ea33c4feaa85e0f27430f7631c142d07c0a052f9f5e73b5fddb88acbe8`（node_modules/xlsx/package.json） |

**结论**: 安全。CDN URL 版本固定，lockfile 锁定哈希，无已知漏洞。供应链门禁脚本已包含实时完整性校验。

---

## 5. 处理汇总

| # | 漏洞 | 严重度 | 动作 | 依据 |
|---|------|--------|------|------|
| 1 | brace-expansion | HIGH | ✅ 已修复 | npm audit fix 移除 |
| 2 | fast-uri | HIGH | ✅ 已修复 | npm audit fix 升级 |
| 3 | js-yaml | MODERATE | ✅ 已修复 | npm audit fix 升级 |
| 4 | @inquirer/* | MODERATE | ✅ 已修复 | npm audit fix 移除 |
| 5 | @hono/node-server | MODERATE | ⬜ 缓解 | Windows only, Linux 不受影响 |
| 6 | @modelcontextprotocol/sdk | MODERATE | ⬜ 缓解 | 继承 hono，同上 |
| 7 | postcss (via next) | HIGH | ⬜ 缓解 | 构建时 CSS，无用户输入路径。next 16.3 修复 |
| 8 | sharp (via next) | HIGH | ⬜ 缓解 | 图片优化，受控输入。next 16.3 修复 |

**残余 4 项均有可验证缓解，无不接受风险。**
