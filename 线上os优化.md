# 线上 OS 优化：NewMe 生产发布交接

> 最后整理日期：2026-08-16（Asia/Shanghai）
> 用途：换电脑后，仅依靠 GitHub 恢复本轮 NewMe 全量审计、控制面加固、凭据整改和生产发布的事实状态。
> 仓库：`69755354/newme-platform`
> 本交接写入前已审计的代码候选：`868394cdf1ba34f03d5d92dc5b1926c93ef3a7be`
> 注意：交接文件合并后 `main` 会产生新的文档提交；当前权威 `main` 必须用 `git rev-parse origin/main` 回读，不能把上面的候选 SHA 当作交接合并后的 `main` SHA。

## 1. 先看结论

本轮代码审计、修复、CI、控制面恢复演练和发布合同已经完成大部分；生产应用与数据库没有因本轮工作而部署或变更。

当前不能直接发布，原因是以下事实仍成立：

1. GitHub Secret Scanning 仍有两条开放告警：
   - `#1 supabase_personal_access_token`
   - `#2 supabase_secret_key`
2. 凭据 live attestation policy 仍未完成生产信任根落印；在已审计候选上运行 `node scripts/credential-live-attestation.mjs check-policy` 会以 `policy_receipt_trust_root_unstamped` 失败关闭。
3. 生产仍运行旧控制面 `f37c203fa61ad795ecc3c65bc2e8a23b86697cbe`；当前 SSH 用户没有通用免密 root 权限，无法自行执行首次 root-only `credential-trust-bootstrap`。
4. 真实部署后的数据库 contract 阶段、8 个 role×locale 浏览器 UAT、fixture 清理、告警 failure/recovery、延迟复核和最终独立验收均尚未完成。

下一台电脑的第一任务不是重新审计，也不是直接部署；应先按本文第 9 节只读回读 GitHub、TASKBOARD、生产状态和 policy gate，然后取得一次授权 root 会话或由管理员安装受保护 bootstrap 入口。

## 2. 证据状态定义

后续接手必须区分以下状态，不得互相替代：

| 状态 | 含义 |
| --- | --- |
| 代码闭合 | 修复已在仓库中，定向测试或独立审查通过 |
| CI 通过 | 指定 SHA 的 GitHub Actions 作业成功 |
| 控制面就绪 | 受保护 wrapper、policy、attestor 已由生产 root 安装并回读 |
| 凭据整改完成 | 旧凭据已由 provider 侧撤销，告警真实关闭，signed completion/readback/consume 完成 |
| 已部署 | 指定 canonical `main` SHA 已通过受保护 wrapper 切换生产 |
| UAT 通过 | 已部署页面完成真实 8 role×locale 浏览器验收和清理 |
| 最终完成 | TASKBOARD release-final、延迟验证、独立终审全部完成 |

当前事实是“代码候选和专项 CI 已通过”，不是“生产发布完成”。

## 3. 为什么要做这轮优化

本轮源于 NewMe 生产发布前的全量盲审与安全整改，范围包括：

- 认证、会话、权限、审计写入和 trusted proxy 边界；
- CRM CI 对上游非成功状态的 fail-closed 处理；
- PostgreSQL 17 权限、迁移重放、expand/contract/rollback 状态机；
- 生产 systemd 控制面资产的事务安装、回滚、中断恢复和 provenance；
- 泄露的 Supabase PAT/service key 的两阶段替换、provider 撤销证明、GitHub Secret Scanning 真实关闭；
- 告警 failure/recovery 状态机及 root-owned 状态目录；
- 浏览器 UAT 的真实 fixture、双语语义、截图脱敏、网络 fail-closed 和证据签名；
- 供应链、CodeQL、Dependabot、branch protection 和 required checks。

审计过程中多次发现“测试绿但真实路径不可达”“中断恢复假绿”“凭据或状态未绑定 exact SHA/run/attempt”“截图可能泄露非 subject 数据”等问题。已合并候选将这些确认问题逐项修正；任何后续改动都必须继续以真实行为、硬杀恢复和 exact-head CI 为证据。

## 4. 已完成的关键工作

### 4.1 应用与数据库合同

- PR #397 的 22 条 review thread 在合并前全部解决。
- money DML、审计表 server-owned、登录失败不全局 logout、auth unavailable、rate-limit、rebalance plan、quote retry、通知生命周期等 review finding 已由代码和定向测试闭合。
- PG17 ACL 检查覆盖 `SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN`；匿名和已认证角色无表权限，service role 仅保留预期读取权限。
- expand/contract/rollback 现按 exact release SHA 和 migration history/fingerprint 绑定；`contract-reenter` 在执行前只读校验 deferred migration history，避免 `strict` 假完成。
- post-switch `contract-apply`、`contract-verify`、`contract-rollback`、受约束的 `contract-reenter` 可在同一 exact SHA 的 `awaiting_uat`/`acceptance_verified` 状态进入；其他 DB 操作仍 fail closed。

### 4.2 浏览器验收代码侧

- browser fixture 在 8 个 role×locale session 结束前保留，并以 exact lead/contract/marker ID 贯穿 producer、runner、trace、receipt 和 cleanup。
- UAT 现覆盖卡片、列表、详情、批量、Settings、角色 allow/deny 和中英文具体语义。
- 截图只保留证据 copy，遮罩非 subject 动态业务数据、PII、输入、聚合数字和通知计数；真实 Chromium DOM/PNG 对抗探针已通过。
- 外域 HTTP/WebSocket、storageState、非固定镜像等路径 fail closed。
- 代码侧审查通过不等于真实生产 UAT；部署后仍必须执行 8 个 session 并回读 PNG、trace、receipt 和零残留 cleanup。

### 4.3 控制面、凭据与告警

- systemd 资产事务已覆盖安装、finalize、rollback、reentry、旧 11 项 marker 到新 13 项 marker 的迁移，以及 14 个恢复 checkpoint。
- 凭据 transition 已拆为两阶段：本地 cutover 只到 `awaiting_provider_revocation`；只有 signed provider proof、completion、fresh readback 和 consume 后才允许清理旧材料并完成 transition。
- live attestation helper 与 policy 已纳入受保护资产 marker、installer、rollback 和 drill。
- provider identity materialization 现在使用 exact provider object `reveal=true` 响应中的 ID/type/raw bytes，结合 transaction/nonce/kind 分域 HMAC 和签名 receipt，避免把 inventory ID 自述当作 key-to-object 证明。
- intent、sealed escrow、claim、receipt、replacement 投影的即时和延迟中断恢复已进入固定 Node 24.18.0、`--network none` 演练。
- 告警状态目录迁移为 root-owned `0700`，安装器在任何写入前拒绝不可信目录、文件和 symlink；持久负测验证失败前目标树、lock 和 deploy-state 零写入。

### 4.4 安全和仓库控制面

- Dependabot 当前开放 high 数量为 `0`。
- final-main CodeQL analysis `1623883213` 对候选 `868394cdf...` 的结果为 `0`，规则数 `87`。
- active ruleset `20891786`：`main-codeql-high-or-higher`，`enforcement=active`，无 bypass actor，只匹配 `refs/heads/main`，security threshold 为 `high_or_higher`。
- `main` branch protection：strict、enforce_admins，且无 bypass allowance。
- required checks 共 5 项：
  1. Repository validation
  2. Windows checkout and SPEC gate
  3. Narrow task follow-up database contract
  4. Migration replay and release contracts
  5. CodeQL analysis
- 人工 approval 数量为 `0`；此前要求的独立审查由只读 Claude Code Opus 5 完成并未发现确认的 P0/P1。该设置没有绕过 required checks、ruleset 或 admin enforcement。

### 4.5 Supabase HIBP 单字段变更

用户只授权修改生产 Supabase project `vfopmpxlhwzpxqegayew` 的一个 Auth 字段：

- `password_hibp_enabled: false -> true`
- Management API PATCH 返回 `200`；响应 body 被直接丢弃，未读取或输出完整 Auth 配置、SMTP、provider 或密钥。
- 独立 Supabase security Advisor 回读：`auth_leaked_password_protection` occurrences=`0`，`query_error=false`。
- TASKBOARD 的 `PROD-AUTH-LEAKED-PASSWORD-PROTECTION` 已标为 `DONE`。

该单字段完成不代表 predeploy ready；Secret Scanning 仍阻断发布。

## 5. PR 与 CI 时间线

| PR / Run | 结果 | 事实 |
| --- | --- | --- |
| [PR #397](https://github.com/69755354/newme-platform/pull/397) | merged | 全量代码修复主 PR；22/22 threads resolved；head `8d4bf689...`，merge `56f3a22f...` |
| PR #398 | merged | TASKBOARD 记录 Dependabot High 与 CodeQL ruleset 已关闭；Secret Scanning 保持 BLOCKED |
| PR #399 | merged | 修复 root Docker 只读 Git trust；控制面恢复 drill 91/91 |
| PR #400 | merged | 修复 credential asset fixture 中 systemd unit owner；14 checkpoint drill 95/95 |
| PR #401 | merged | 修复 alert-state fixture root owner；alert preflight 15/15；产生候选 `868394cdf...` |
| Run `31898542783` | failed | 首个 control-plane restore fixture 暴露 Git safe.directory，后由 #399 修复 |
| Run `31899266827` | failed | 第二个 fixture 暴露 unit owner，后由 #400 修复 |
| Run `31899784989` | failed | 第三个 fixture 暴露 alert fixture owner，后由 #401 修复 |
| [Run `31900177715`](https://github.com/69755354/newme-platform/actions/runs/31900177715) | success | exact head `868394cdf...` 的 credential-remediation dispatch；7 个要求作业成功 |

最终成功 run 的 7 个作业：

- Narrow task follow-up database contract
- Credential remediation readiness
- Control-plane restore interruption drill
- Windows checkout and SPEC gate
- Repository validation
- Migration replay and release contracts
- CodeQL analysis

`Predeploy taskboard readiness` 与 `Release-final taskboard completion` 在该专用 dispatch 中按设计 skipped；不能把该 run 当成部署或 release-final 证据。

## 6. 当前 TASKBOARD 状态

在候选 `868394cdf...` 上运行 `scripts/check-taskboard.sh` 的结果：

- PASS `20`
- FAIL `0`
- WARN `0`
- UNFINISHED `50`
- `predeploy_ready=1`
- `postdeploy_acceptance=49`

关键行：

- `PROD-DEPENDABOT-HIGH-ALERTS-OPEN | DONE | Codex | 2026-08-16`
- `PROD-CODEQL-BLOCKING-RULESET-MISSING | DONE | Codex | 2026-08-16`
- `PROD-SECRET-SCANNING-ALERTS-OPEN | DONE | Claude | 2026-08-20`（两个泄露值经实测在供应商侧已失效，告警以 `revoked` 关闭，live API 回读 `open=0`）
- `PROD-AUTH-LEAKED-PASSWORD-PROTECTION | DONE | Codex | 2026-08-15`
- `PROD-CREDENTIAL-RUNBOOK-TWO-PHASE | DONE`
- `PROD-CREDENTIAL-PROVIDER-RECEIPT-PRODUCER | DONE`
- `PROD-MAIN-BRANCH-PROTECTION-UNENFORCED | DONE`
- `PROD-CONTROL-PLANE-BOOTSTRAP | BLOCKED`，其 scope 为 postdeploy acceptance。

TASKBOARD 是证据清单，不是事实来源的替代品；状态变更必须附 exact SHA、CI、API/readback 或生产回读证据。

## 7. 当前生产只读基线

最近一次受保护只读 status 回读：

| 项目 | 值 |
| --- | --- |
| current release | `f37c203fa61ad795ecc3c65bc2e8a23b86697cbe` |
| rollback release | `afd373480fe7778db13872e9d915b3f104c7a93a` |
| service | `active` |
| health_http | `200` |
| rollback_transaction | `none` |
| systemd_asset_transaction | `none` |
| credential_asset_transaction | `unknown / not_reported` |
| credential_transition_transaction | `unknown / not_reported` |
| rollback_db_phase | `unknown / not_reported` |

旧 production status wrapper 没有输出后三项；缺少字段不能推定为 `none`。

生产权限事实：

- 当前 SSH 账户的 `sudo -n -l` 只有特定 service/status/journal、rollback status/execute、`newme-deploy *` 和 staging-control 等白名单。
- `sudo -n /usr/bin/true` 返回 `sudo: a password is required`。
- 已安装的旧 `newme-deploy` 不认识新的 `credential-trust-bootstrap`、credential live 和 recover modes。
- 旧 ordinary deploy 也不能作为 bootstrap：候选 installer 在任何写入前要求新 gate record，而旧 wrapper 不生成该 record。

结论：在“不使用 sudo 密码、不绕门禁、不手工覆盖生产文件”的边界下，当前账户没有首次 control-plane / credential trust-bootstrap 的 canonical 可执行路径。

此前通过 Supabase 只读入口核对的 migration 摘要为：count=`100`、oldest=`1780601210`、newest=`20260805202917`。该摘要应在部署前重新回读；它不是本轮生产 DB 写入证据。

## 8. 当前硬阻断与所需外部授权

### 8.1 Secret Scanning

必须在 provider 侧完成 exact 旧 PAT 和旧 service identity 的撤销/失效证明后，才能把 GitHub #1/#2 真实标记为 `resolved` + `revoked`。当前两条仍是 `open`，不得 dismiss、不得先改 TASKBOARD 为 DONE。

### 8.2 首次 trust bootstrap

需要以下二选一的外部授权：

1. 一次真实 authorized root 会话，严格执行 `infra/release/credential-transition.md` 的首次 bootstrap；或
2. 由现有 root 管理员先安装一个经过审计、参数固定的受保护 bootstrap wrapper / NOPASSWD 入口。

不得通过旧 wrapper、rollback execute、service restart、临时 sudo 绕过或手工写 `/usr/local`、`/etc/newme`、`/var/lib/newme`。

### 8.3 Policy 信任根落印

首次 bootstrap 仅安装可检查的控制面。随后必须通过受保护 `receipt-key-inspect` 只输出非秘密 raw-file SHA256 和 SPKI-DER SHA256，经过 review 提交到 successor policy，并将四组非秘密 provider object identity/scope 一并 pin。全零或 `UNSTAMPED` 不能放行。

## 9. 换电脑后的只读恢复步骤

以下命令只用于恢复事实上下文，不读取 secret value，不写生产：

```powershell
git clone https://github.com/69755354/newme-platform.git
Set-Location newme-platform
git fetch origin main
git rev-parse origin/main
git log -10 --oneline --decorate origin/main
gh auth status
```

打开本文件并先读仓库规范：

```powershell
Get-Content -Raw AGENTS.md
Get-Content -Raw '线上os优化.md'
Get-Content -Raw TASKBOARD.md
```

在 Windows 使用 Git Bash 执行 TASKBOARD gate：

```powershell
& 'C:\Program Files\Git\bin\bash.exe' scripts/check-taskboard.sh
```

回读专用 CI：

```powershell
gh run view 31900177715 --repo 69755354/newme-platform
gh api repos/69755354/newme-platform/actions/runs/31900177715
```

只读回读 Secret Scanning，必须保留 `hide_secret=true`，不得输出 `secret` 字段：

```powershell
gh api --method GET `
  'repos/69755354/newme-platform/secret-scanning/alerts?state=open&hide_secret=true&per_page=100'
```

回读 Dependabot high：

```powershell
gh api --method GET `
  'repos/69755354/newme-platform/dependabot/alerts?state=open&severity=high&per_page=100'
```

回读 branch protection / ruleset：

```powershell
gh api repos/69755354/newme-platform/branches/main/protection
gh api repos/69755354/newme-platform/rulesets/20891786
```

检查本地候选 policy 是否仍 fail closed：

```powershell
node scripts/credential-live-attestation.mjs check-policy
```

若新电脑已配置生产 SSH，只运行受保护 status：

```powershell
ssh newme-production 'sudo -n /usr/local/sbin/newme-production-rollback status'
```

若 status 不输出某个 transaction 字段，记录为 `unknown/not_reported`，不要推定为 `none`。

## 10. 唯一安全的后续顺序

准确命令和参数以 `infra/release/credential-transition.md` 为唯一权威；下面只列状态顺序：

1. 取得 authorized root 或管理员提供的受保护 bootstrap 入口。
2. 在 canonical `main` 和 exact successful credential-remediation CI 上执行首次 `credential-trust-bootstrap`；不切应用、不改数据库。
3. 用受保护 `receipt-key-inspect` 输出非秘密 raw/SPKI digest。
4. 将 raw/SPKI digest 和四组 provider identity/scope pin 入 successor policy，review、合并、跑 successor exact-head CI。
5. 再 bootstrap stamped successor，确认 installed helper/policy 与 candidate marker exact 绑定。
6. 执行 `credential-transition`，只允许到 `awaiting_provider_revocation`。
7. provider 侧撤销 exact old PAT/service identity；此时 GitHub alerts 保持 open。
8. 执行 `credential-prove-revocation`，机器证明 old invalid、新 credential positive、inventory/consumer/CI/control-plane 均绑定。
9. 真实把 GitHub #1/#2 关闭为 `resolved` + `revoked`。
10. 执行 `credential-complete`。
11. 创建 direct-child、TASKBOARD-only closure commit，并跑 dedicated credential-remediation CI。
12. 在同一 canonical lock 内执行 fresh `credential-live-readback` 和 `credential-live-consume`；不得把旧 readback 当消费授权。
13. 回读 transition last、tombstone、零残留和 Secret Scanning open count=0，才能把对应 TASKBOARD 行改为 DONE。
14. 重新跑全量 predeploy gates；只有全部通过才允许受保护 ordinary deploy。
15. 部署后按 runbook执行 DB contract phase、真实 8 role×locale browser UAT、exact fixture cleanup、alert failure/recovery、延迟验证和独立终审。
16. release-final gate 通过后，才能称本轮完成。

## 11. 禁止事项

- 不得把成功 CI 称为已部署、已 UAT 或已完成。
- 不得在 Secret Scanning 仍 open 时宣称 predeploy ready。
- 不得提前 dismiss、关闭或伪造 #1/#2；只有 provider 侧撤销证明成立后才能 truthful close。
- 不得读取、输出、提交或通过 argv/env/stdin 传递 PAT、service key、SMTP、Auth provider 或完整配置。
- 不得手工覆盖生产控制面文件、systemd unit、runtime env、marker、pending、backup、journal 或 tombstone。
- 不得用旧 production wrapper 冒充新 bootstrap 入口。
- 不得因 status 缺字段而推定 transaction 为 `none`。
- 不得把代码侧 browser review 代替真实部署后的 8 session UAT。
- 不得在未回读 exact canonical SHA、successful CI、rollback point 和 DB phase 前部署。

## 12. 新 GPT Desktop 的立即工作项

1. 从 GitHub `main` 读取本文件、`AGENTS.md`、`TASKBOARD.md`、`infra/release/credential-transition.md`。
2. 执行第 9 节只读复核，记录当前 main SHA、open alerts、ruleset、CI 和生产 status；任何漂移都以新回读为准。
3. 不重复已经闭合的全仓盲审；只处理新出现的 confirmed P0/P1、当前硬阻断和发布证据。
4. 先解决首次 authorized root bootstrap 的外部权限问题；没有该权限时明确报告 blocker，不尝试旁路。
5. 权限到位后严格按第 10 节和权威 runbook继续；每个状态都保留 exact SHA/run/receipt/readback 证据。

## 13. 关键链接

- 仓库：<https://github.com/69755354/newme-platform>
- 主修复 PR：<https://github.com/69755354/newme-platform/pull/397>
- 成功 credential-remediation run：<https://github.com/69755354/newme-platform/actions/runs/31900177715>
- GitHub Secret Scanning：<https://github.com/69755354/newme-platform/security/secret-scanning>
- GitHub Dependabot：<https://github.com/69755354/newme-platform/security/dependabot>
- GitHub Code Scanning：<https://github.com/69755354/newme-platform/security/code-scanning>

本文件只记录可回读事实、状态边界和安全继续路径。任何生产动作前，都必须用当前 GitHub、provider 和生产受保护 status 重新验证。
