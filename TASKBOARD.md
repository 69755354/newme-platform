# TASKBOARD.md — Machine-Verifiable Task Tracking (本地工具脚本真相源)
# Last updated: 2026-07-19
# Format: Frozen v2 (MoA签发版) — 4状态模型

## ⚠️ STATE MACHINE (唯一状态流)
```
TODO → IN_PROGRESS → REVIEW → DONE
                         ↓
                      BLOCKED
```

## ⚠️ RULE
- 每次状态变化 → 在【活动任务】区追加一行
- Items NOT in this file = do not exist
- Before every deploy: `scripts/check-taskboard.sh`. Any ❌ = abort
- Every session start: Hermes reads this file first

---

## 活动任务

| TASK_ID | STATUS | OWNER | UPDATED_AT |
|---------|--------|-------|------------|
|| task_P1-C | DONE | Hermes | 2026-07-04 |
|| task_P1-D | DONE | Codex→Hermes | 2026-07-04 |
|| task_P1-E | DONE | Codex→Hermes | 2026-07-04 |
|| task_P1-F | DONE | Codex→Hermes | 2026-07-04 |
|| task_P1-G | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_reads_all | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_mutations_low | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_mutations_core | DONE | Codex→Hermes | 2026-07-04 |
|| task_P2_mutations_settings | DONE | Codex→Hermes | 2026-07-04 |
| task_true_codex_reaudit | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_true_codex_fail_fix | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_true_codex_reaudit_delta | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_true_codex_deploy | DONE | Hermes | 2026-07-05 |
| task_P3_0_spec_sync | DONE | Hermes | 2026-07-05 |
| task_INFRA_codex_sandbox_diagnosis | DONE | Hermes | 2026-07-06 |
| task_P3_1_won_at | DONE | Codex (GPT-5.5) via codex exec → Hermes apply | 2026-07-05 |
| task_P3_1b_alertpanel | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_2_first_contact_trigger | DONE | Codex (GPT-5.5) via codex exec → Hermes apply | 2026-07-05 |
| task_P3_3_quality_api | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_5_dashboard_summary_api | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_6_dashboard_month_filter | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_7_leads_contact_quality_ui | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_8_weekly_review | DONE | Codex (GPT-5.5) via codex exec | 2026-07-05 |
| task_P3_4_deprecate_redirect | DONE | Hermes (manual) | 2026-07-05 |
| task_P3_9_smoke_acceptance | DONE | Hermes (manual safe subset) | 2026-07-05 |
|| task_P0_schema_alias_fix_combo | DONE | Codex (GPT-5.5) via codex exec → Hermes review | 2026-07-06 |
| task_P0_hotfix_audit_trail | DONE | Codex→Hermes | 2026-07-06 |
|| task_kanban_unify | DONE | Codex (GPT-5.5) | 2026-07-06 |
|| task_M1_freeze_sam6 | DONE | Hermes (K3 总控) | 2026-07-19 |
|| task_M1_sam7_preflight | DONE | Hermes | 2026-07-19 |
|| task_M1_sam8_deploy | DONE | Hermes | 2026-07-19 |
|| task_M1_sam9_smoke | DONE | Hermes | 2026-07-19 |
|| task_M1_sam43_api_uat | DONE | Hermes | 2026-07-19 |
| task_L0_auth_me_proxy_fix | DONE | Hermes (OC) | 2026-07-20 |
| PROD-CONTACT-QUALITY-AUTH | DONE | Codex | 2026-08-05 |
| PROD-AUTH-SESSION-HARDENING | DONE | Codex | 2026-08-06 |
| PROD-AUTH-CACHE-HEADERS | DONE | Codex | 2026-08-06 |
| PROD-AUTH-ME-RLS-HOTFIX | DONE | Codex | 2026-08-08 |
| PROD-SUPPLY-CHAIN-ADVISORIES | DONE | Codex | 2026-08-08 |
| PROD-READINESS-ANON-KEY | DONE | Codex | 2026-08-08 |
| PROD-INVALID-SERVICE-KEY-RECOVERY | DONE | Codex | 2026-08-08 |
| PROD-DEPLOY-LOG-INVOCATION-SCOPE | DONE | Codex | 2026-08-08 |
| PROD-SERVICE-KEY-ROTATION | DONE | Codex | 2026-08-08 |
| PROD-KPI-TARGETS-FK-EMBED | DONE | Codex | 2026-08-08 |
| PROD-AUTH-5XX-LOGIN-PROBE | DONE | Codex | 2026-08-08 |
| PROD-L0-ROOT-CAUSE-PREVENTION | DONE | Codex | 2026-08-09 |
| PROD-L0-FULL-STACK-TEST-GATES | DONE | Codex | 2026-08-09 |
| PROD-DEPLOY-EVIDENCE-PERSISTENCE | DONE | Codex | 2026-08-06 |
| task_SAM51_proxy_service_role_hardening | DONE | Hermes (OC) | 2026-07-20 |
| PROD-LOGIN-LATENCY-SERVER-GRANT | REVIEW | Claude | 2026-08-11 |
| PROD-SESSION-COOKIE-CONTRACT | REVIEW | Claude | 2026-08-11 |
| PROD-AUTH-LOGIN-RATE-LIMIT | REVIEW | Claude | 2026-08-11 |
| PROD-AUTH-ME-CLIENT-DEDUP | REVIEW | Claude | 2026-08-11 |
| PROD-L0-AUDIT-FIX-F07-F15-F25-F04 | REVIEW | Claude | 2026-08-11 |
| PROD-FALSE-GREEN-GATE-RETARGET | REVIEW | Claude | 2026-08-11 |
| PROD-L0-DB-MIGRATIONS-F02-F06-F08-F09-F10 | BLOCKED | Claude | 2026-08-11 |
| PROD-L0-MIGRATION-REPLAY-GATE | REVIEW | Claude | 2026-08-11 |
| PROD-MIGRATION-HISTORY-UNREPLAYABLE | BLOCKED | Claude | 2026-08-11 |
| PROD-DEPLOY-RELEASE-CLAIM-VALIDATION | REVIEW | Claude | 2026-08-11 |
| PROD-CI-CRM-HERMES-FALSE-GREEN | REVIEW | Claude | 2026-08-11 |
| PROD-L0-OPEN-REDIRECT-SESSION-CHAIN | REVIEW | Claude | 2026-08-11 |
| PROD-AUTH-LIMITER-EVICTION-BYPASS | REVIEW | Claude | 2026-08-11 |
| PROD-RELEASE-SCRIPT-FAIL-CLOSED | REVIEW | Claude | 2026-08-11 |
| PROD-KPI-TARGETS-ATOMIC-REPLACE | REVIEW | Claude | 2026-08-11 |
| PROD-QUOTATION-CONVERT-ATOMICITY | REVIEW | Claude | 2026-08-11 |
| PROD-COS-SCRIPT-RELEASE-DRIFT | REVIEW | Claude | 2026-08-11 |
| PROD-AUTH-OLD-TOKEN-REVOCATION | REVIEW | Claude | 2026-08-11 |
| PROD-F09-MONEY-AUTHORIZATION-PHASE2 | TODO | Claude | 2026-08-11 |
| PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL | TODO | Claude | 2026-08-11 |
| PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION | TODO | Claude | 2026-08-11 |
| PROD-DEPLOY-TASKBOARD-GATE-MISSING | TODO | Claude | 2026-08-11 |
| PROD-PROXY-ACTIVITY-THROTTLE-UNBOUNDED | TODO | Claude | 2026-08-11 |

> M1 发布链（Linear 为真源）：**RELEASED 2026-07-20**。发布 SHA `49bbb26` → BUILD_ID `MDw2VC9TYmm1SsgcR2Lv-`（evidence 20260719-193837.json，smoke 14/14 + regression 22/22）。SAM-6~12 全链 Done：SAM-28 业务签收（森哥 2026-07-20）+ 技术签收（机器全量验收），SAM-12 发布记录出具。SAM-26 视觉/移动端留人工不拦发布；SAM-45/46 进 M2 backlog。
>
> 热修 #1（2026-07-20）：SAM-48+SAM-47 → SHA `ac416ba` → BUILD_ID `opQHvVVbt_cF_G80h-7is`（CI 29703674152/crm-ci 29703752341 双绿，smoke 14/14，生产 API 验收 8/8：未知设备 400、零总价双端 400、正常链回归 4536 AED 全通、health 无 memory；fixture 清理基线零漂移）。两票 Done。

> `task_P0_hotfix_audit_trail`: `20260706000005_add_leads_archived.sql` adds `leads_archived` as the 20th allowed event type, closing the archive audit gap.
>
> `task_L0_auth_me_proxy_fix` (热修 #2, 2026-07-20): CRM 全员无法登录。根因：`login/page.tsx:82-84` 用 Bearer 头调 `/api/auth/me`（cookies 尚未写入）；`proxy.ts` 的 Bearer fallback 鉴权了 user 但未传播给 supabase client，导致下游 profiles RLS（proxy.ts:77）以未鉴权 client 跑 → 返回 `inactive_account` → 登录页撤销刚创建的 session。修复：把 `/api/auth/me` 加入 `PUBLIC_API_PATHS`（一行）。安全性已复核：route handler `src/app/api/auth/me/route.ts` 用 service_role admin client 自查 profiles（L35-37）+ 主动拒绝未鉴权（L25-26）+ 主动拒绝 inactive（L45-47），proxy 的 RLS 复核对本端点冗余。tsc + eslint 双绿。待部署后用 Bearer curl 验收 200 + isActive:true。

---

## L0 登录延迟 + 安全审计修复 — 2026-08-11（Claude）

> 事实源：代码看 git（工作区 diff），事实看线上。所有行为 REVIEW 而非 DONE：本地门禁已全绿，但**尚未部署到生产**，未取得生产实测证据。部署 + 浏览器实测登录耗时后才可改 DONE。
>
> 本地门禁快照（全绿）：`typecheck` clean；`lint:baseline` PASS（407 errors，无新增）；`npm test` 376 tests / 373 pass / 0 fail / 3 skipped；`check:release` PASS（smoke 14/14）；`check:security` PASS（107 findings，无规则/文件超基线）；`check:workflows` PASS 3/3；`npm run build` exit=0。

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| PROD-LOGIN-LATENCY-SERVER-GRANT | src/app/api/auth/login/route.ts | CREATE | file exists + 含 `grant_type=password` + `isActiveProfile(profile)` 出现在 `applySessionCookies(` 之前（由 tests/security/session-revocation.test.mjs 断言）+ tests/security/auth-login-endpoint.test.mjs 17/17 pass | ⚠️ | 待部署 |
| PROD-LOGIN-LATENCY-SERVER-GRANT | src/app/login/page.tsx | MODIFY | 含 `fetch("/api/auth/login"` 且 **不含** `auth/v1/`、`access_token`、`NEXT_PUBLIC_SUPABASE`、`document.cookie =`（tests/security/sam15-boundaries.test.mjs）—— 3 次浏览器串行往返 → 1 次 | ⚠️ | 待部署 |
| PROD-LOGIN-LATENCY-SERVER-GRANT | src/proxy.ts | MODIFY | `PUBLIC_API_PATHS` 精确等于 `["/api/auth/login","/api/auth/logout","/api/auth/me"]`（解析式断言，非正则；tests/security/session-revocation.test.mjs） | ⚠️ | 待部署 |
| PROD-SESSION-COOKIE-CONTRACT | src/lib/session-cookies.ts | CREATE | file exists + `httpOnly: false` 仅用于 auth-token、`httpOnly: true` 用于 refresh-token、两者 `sameSite: "strict"` + `secure: true`；login 与 session 两个 route 均调 `applySessionCookies(` 且均不直接调 `cookies.set(`（sam15-boundaries.test.mjs 循环断言） | ⚠️ | 待部署 |
| PROD-AUTH-LOGIN-RATE-LIMIT | src/lib/rate-limit.ts | CREATE | file exists + `clientIdentifier` 优先读 `cf-connecting-ip`；验收：每账号 8/15min（大小写不绕过）+ 每 IP 20/5min + 429 带 `Retry-After` + 被限流请求**不转发上游**（auth-login-endpoint.test.mjs） | ⚠️ | 待部署 |
| PROD-AUTH-ME-CLIENT-DEDUP | src/lib/session-identity.ts | CREATE | `readSessionIdentity` 函数体**不含** `lastActive`（鉴权永不读缓存）；useAuthRedirect.ts 只用 `readSessionIdentity()` 且不用 `peekSessionIdentity`；PostHogProviderInner.tsx 不含 `fetch(`—— 挂载时 2 次 `/api/auth/me` → 1 次 | ⚠️ | 待部署 |
| PROD-L0-AUDIT-FIX-F07-F15-F25-F04 | src/app/api/users/[id]/password/route.ts | MODIFY | F-07：自改密码路径无 `updateUserById`（返 400 指向 change-password）；验证端 `signInWithPassword` 位置早于 `updateUserById`；无裸 `createClient(`（tests/security/password-change-session.test.mjs 4/4） | ⚠️ | 待部署 |
| PROD-L0-AUDIT-FIX-F07-F15-F25-F04 | src/app/api/kpi/targets/route.ts, src/app/api/cos/download-url/route.ts, src/app/(dashboard)/settings/page.tsx | MODIFY | F-15 / F-25 / F-07 客户端半边；`npm test` 0 fail + `check:security` 无超基线 | ⚠️ | 待部署 |
| PROD-L0-AUDIT-FIX-F07-F15-F25-F04 | .github/workflows/crm-ci.yml, .github/workflows/test-ci.yml | MODIFY | F-04：`npm run check:workflows` PASS 3/3 | ⚠️ | 待部署 |
| PROD-FALSE-GREEN-GATE-RETARGET | tests/security/{password-change-session,sam15-boundaries,sam15-cookie-only-session,session-revocation}.test.mjs | MODIFY | F-05 子项：原断言把**漏洞实现**和**3 次往返客户端舞步**钉成了必要条件。验收：断言已迁至属性新位置且**未被削弱**（新增：解析式精确 allowlist、gate-before-cookie 顺序、鉴权不读缓存） | ⚠️ | 待部署 |
| PROD-L0-DB-MIGRATIONS-F02-F06-F08-F09-F10 | supabase/migrations/20260811100*.sql | CREATE | 5 个迁移文件已写入但**未应用**。阻塞原因（2026-08-11 更新）：`supabase-prod` MCP 已断开且需交互式 OAuth，本会话无任何线上库通道；此前记录的 `--read-only` 只是同一阻塞的更早形态。已可离线证明的部分：`MODE=branch` 在一次性 `postgres:17` 上应用 → 幂等重入 → 52 条行为/目录断言 → rollback 全通，`MODE=control` 证明其中 17 条断言在未修复姿态下必失败。解阻：运维授权 MCP 或由运维本人应用迁移 | ❌ | — |

> **PROD-LOGIN-LATENCY-SERVER-GRANT 根因**（用户报告"登录特别慢"）：旧 `src/app/login/page.tsx:67` 由**浏览器直连 GoTrue** 做 password grant —— 离开 Cloudflare 边缘、向 Auth 区付一次冷 TLS 握手，随后再串行 `/api/auth/session` 与 `/api/auth/me`，共 3 次串行往返。已测分层：Node 1.8ms / nginx+TLS 6ms / 过 Cloudflare 60-65ms / 生产→Supabase 45-48ms。现为 1 次浏览器往返（走已建立的边缘连接），grant + profile 鉴权在服务器侧走热连接。
>
> **安全是加强而非交换**：浏览器再也不接触裸 token；inactive profile 根本不会拿到 cookie，其刚签发的 token 在响应返回前已向上游 `/auth/v1/logout` 注销；上游失败文本（可能回引提交的密码）既不转发也不入日志，已由测试断言。
>
> **新增攻面已限定**：把鉴权收到服务端会把所有用户汇入单一 origin IP，把 GoTrue 的 per-IP 爆破保护塌缩成一个桶 —— 因此必须自带 PROD-AUTH-LOGIN-RATE-LIMIT 作为替代边界。**已知作用域限制**：计数器在单 Node 进程内存里；多进程部署必须改为共享存储。
>
> **本地实测（运行中构建）**：415 错误 content-type、403 外域 origin、403 伪造 `X-Forwarded-Host`、503 未配置 fail-closed、405 GET，且**任何被拒请求零 `Set-Cookie`**。
>
> **本次未做（用户明确暂缓，需本人点头）**：仓库转 private、git 历史清除 `deploy-backup-*.json`/`.next.backup/`、origin 防火墙限定 Cloudflare 段、凭证轮换。

---

## L0 独立复审收口（PR #397 maintainer comment）— 2026-08-11（Claude）

> 事实源：代码看 git，事实看线上。**本轮无任何线上库证据**：`supabase-prod` MCP 已断开且需交互式 OAuth。所有复现均基于源码 + `src/types/database.ts`（由生产生成）+ `docs/rls-explorer.md`。生产未被修改：未应用迁移、未部署、未重启/reload、未改生产数据或控制面。
>
> 复审意见按“原始证据”对待而非结论：逐条复现后分为 confirmed / refuted / insufficient-evidence，见本节末尾。

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| PROD-L0-MIGRATION-REPLAY-GATE | scripts/replay-migrations.sh, supabase/replay/*.sql, .github/workflows/ci.yml | CREATE | `migration-replay` job（`postgres:17` service container，trust 认证，无任何 secret）先跑 `MODE=control` 再跑 `MODE=branch`，两者均为门禁；`MODE=history` 为 `continue-on-error: true` 的信息性最后一步。`MODE=branch` = floor → 7 个迁移 → fixtures → 再次应用（幂等）→ 52 条断言（文件自校验 `ASSERT_TOTAL: 52`）→ rollback 伴随文件。`MODE=control` 要求 `CONTROL_MUST_FAIL` 17 条断言全部失败（本地实测 23 OK / 29 fail，证明断言文件跑完而非首条即中止）。契约由 tests/release/ci-full-stack-gates-contract.test.mjs 断言（control 早于 branch、job 内仅一处 `continue-on-error`、无 secrets/`PGPASSWORD`/`supabase link`/`--linked`） | ⚠️ | 待 CI 绿 |
| PROD-MIGRATION-HISTORY-UNREPLAYABLE | supabase/migrations/（110 个文件） | AUDIT | 新发现，**未修**。`MODE=history` 从空库在第 9 个文件 `20260604000002_auto_lead_status.sql` 停止（`column "metadata" does not exist`）。四类已确证成因：`1780601210_workflow_stages.sql` 10 位 epoch 前缀不匹配 CLI 的 `^[0-9]{14}_` 故从未被看见（本轮改名 `20260604192650_`，并加 `_wf_stages_pre_existing` 首次创建判定，确保改名不回写生产行）；`20260603000000_add_crm_fields.sql` 含 `ALTER TABLE TABLE`，CLI 单文件单事务故从未在任何环境应用（改为墓碑）；`20260604000002` 从不存在的 `leads.metadata` 回填；`meta_tokens` / `profiles.password_changed_at` / `profiles.force_password_change` / `leads.rep_name` 无迁移声明（新增 `20260601010000_baseline_undeclared_production_objects.sql` 全 `IF NOT EXISTS`）。另：`supabase/seed.sql` 首条为 `UPDATE ... LIMIT`（PostgreSQL 不支持），故该文件从未生效，本轮改为 `WHERE id IN (SELECT ... LIMIT 20)` | ❌ | — |
| PROD-DEPLOY-RELEASE-CLAIM-VALIDATION | scripts/deploy-immutable.sh, infra/systemd/newme-deploy.sh | MODIFY | `validate_release_claims()` 在任何 mkdir/symlink/服务动作之前 `exit 64`：要求 6 个声明变量全部非空、`CI_RUN_ID` 为数字、`CI_RUN_URL` 必须指向同一 run id 的 github.com 路径、`CI_HEAD_SHA == $SHA`、`CI_CONCLUSION == success`、`CI_EVENT ∈ {push, workflow_dispatch}`、`applied_verified` 必带合法 `MIGRATION_IDS` 而 `not_required` 必不带。canonical wrapper 的 GitHub API 校验加入 `event=push` 与 `head_branch=main`（原先任一分支的绿色 `pull_request` run 都被当作 main 证据，而 release-final 作业以 `github.event_name` 为条件 → 更小的门禁集被记成完整门禁）。验收：tests/release/deploy-release-claim-validation.test.mjs 11/11，**直接执行**被抽出的 shell 函数与 wrapper 内联校验块（含 manual_verified 旁路被拒） | ⚠️ | 待部署 |
| PROD-CI-CRM-HERMES-FALSE-GREEN | .github/workflows/crm-ci.yml | MODIFY | `hermes-contract` job 与 Telegram 失败告警均以 `workflow_run` 为条件，而该 workflow 的触发器只有 workflow_dispatch/pull_request/push —— 于是每次 PR 与 main push 都跳过唯一 job 并报 success，失败告警永不可能执行。触发器改为 `workflow_dispatch` + `workflow_run(workflows: [ci], types: [completed])`，`pull_request`/`push` 删除而非保留。验收：`npm run check:workflows` 3/3。**观测边界（本轮无法闭环）**：GitHub 只从默认分支读取 `workflow_run` 触发器定义，且本 job 另有 `head_branch == 'main'` 条件 —— 故本 PR 的 `ci` 成功（run 31457465666）不会、也不应触发 `crm-ci`；本轮 `gh run list --workflow crm-ci.yml` 对 SHA `c59d687` 无任何 run，即为预期结果而非回归。真实证据只能在合入 main 后的首次 main push 上取得（`crm-ci` workflow_run 成功 + Hermes delivery 200），见 line 270 | ⚠️ | 待合入 main 后观测 |
| PROD-L0-OPEN-REDIRECT-SESSION-CHAIN | src/lib/safe-redirect.ts, src/app/login/page.tsx | CREATE+MODIFY | `?redirect=` 未净化即为开放重定向，且 `sb-<ref>-auth-token` 为脚本可读，跳转目标能取得刚建立的会话上下文。验收：tests/unit/l0-auth-hardening.test.mjs 中 `safeRedirectPath` 断言拒绝任意 scheme 绝对 URL（含 `javascript:`/`data:`/`vbscript:`/`file:`）、`//evil`、`///evil`、`/\evil`、`\\evil`、控制字符、非字符串、空白、超长（>512），保留同源 path+query+hash，兜底 `/dashboard` | ⚠️ | 待部署 |
| PROD-AUTH-LIMITER-EVICTION-BYPASS | src/lib/rate-limit.ts | MODIFY | 原实现用 `Map` + `MAX_TRACKED_KEYS=10000` 上限，攻击者只要发足量不同 key 就能把自己的计数条目挤掉从而清零限流。改为固定 `SLOT_COUNT=16384` 的 `Int32Array`/`Float64Array` + sha256 分槽 + 饱和自增，不再有可被冲刷的条目。验收：tests/unit/l0-auth-hardening.test.mjs 断言 40000 个不同 key 之后原 key **仍被拒**、1MB key 不崩、窗口边界精确（`windowMs - 1` 拒 / `windowMs` 放）、持续洪泛不回绕 | ⚠️ | 待部署 |
| PROD-RELEASE-SCRIPT-FAIL-CLOSED | src/lib/release-script.ts | CREATE | 上一版对空输入 fail-open 返回 `process.cwd()`，且用前缀包含判断而非 `path.relative` 归一。现拒绝空串/纯空白/非字符串/绝对路径/含 `..` 段/逃出仓库根/目录（`statSync().isFile()`）。验收：tests/unit/l0-auth-hardening.test.mjs 断言 `""`、`"   "`、`"."`、`"./"`、`"scripts"`、`"scripts/"`、`/home/ubuntu/newme-platform/scripts/cos-presign.py`、traversal 全部返回 `null`，`scripts/replay-migrations.sh` 正常解析 | ⚠️ | 待部署 |
| PROD-KPI-TARGETS-ATOMIC-REPLACE | src/app/api/kpi/targets/route.ts, supabase/migrations/20260811100500_kpi_targets_atomic_replace.sql | MODIFY+CREATE | 原为两次 PostgREST 调用即两个事务：先 `delete().eq("period")` 再 `insert(rows)`。第二步任意失败（`target_type` CHECK、`NUMERIC(12,2)` 溢出、未知 `assigned_to`、连接中断）都会留下**已提交的删除**与空白周期，且无副本无恢复路径 —— settings UI 一行畸形数据即可清空整月目标。改为单事务 SECURITY DEFINER `replace_kpi_targets(p_period, p_rows, p_set_by)`（`search_path` 固定、仅 `service_role` 可 EXECUTE）。验收：replay 断言 `kpi-fixture-period-seeded` / `kpi-failed-replace-preserves-period`（坏 `target_type` 回滚后既有 2 行仍在）/ `kpi-empty-replace-preserves-period` / `kpi-successful-replace-replaces-period` / `kpi-authenticated-cannot-execute` / `kpi-anon-cannot-execute` | ⚠️ | 待部署 |
| PROD-QUOTATION-CONVERT-ATOMICITY | src/app/api/quotations/[id]/convert/route.ts | MODIFY | 两个缺陷。**并发**：`quote.contract_id` 只是读，写在请求最末，两个并发 POST 都读到 null → 同一报价生成两份合同、两份审批、两个项目、lead 被判定 won 两次。现改为先做条件更新抢占（`.eq("status","accepted").is("contract_id", null)`），以匹配行数为互锁，输者返 409；后续任一步失败则 `releaseClaim()` 把状态放回 `accepted`，避免永久卡在 `contract_created` 而无合同。**确定性失败**：合同号序号原先用调用者 RLS client 计数，`policy_contracts_select_sales` 只让销售看到自己的行，因此 count 漏掉同事当天的合同 → 生成已存在的号 → `contract_no` UNIQUE 触发 23505 → 500；非 admin 只要当天有他人签约就必然失败。现用 `supabaseAdmin` 计数并对 23505 重试（`MAX_CONTRACT_NO_ATTEMPTS=10`）。验收：`npm test` 0 fail + check:security 无超基线 | ⚠️ | 待部署 |
| PROD-COS-SCRIPT-RELEASE-DRIFT | src/app/api/cos/download-url/route.ts, src/app/api/contracts/[id]/upload-url/route.ts, src/app/api/dashboard/ads-roi/import/route.ts | MODIFY | 三处外部脚本调用原先按绝对/固定路径找 `scripts/cos-presign.py`、`scripts/parse-ad-spend.py`，与 immutable release 树漂移（回滚后仍指向新脚本，或指向 release 之外的路径）。改为经 `resolveReleaseScript()` 在**当前运行 release 内**解析，解析失败即 fail-closed；子进程环境只传脚本实际读取的变量，不再整体 spread `process.env` | ⚠️ | 待部署 |
| PROD-AUTH-OLD-TOKEN-REVOCATION | src/app/api/auth/change-password/route.ts, src/app/api/auth/logout/route.ts, src/app/api/auth/me/route.ts | MODIFY | `password_changed_at` 只由请求 token 的 `iat` 判定，改密前签发的 **refresh token 仍能换出 iat=now 的新 access token** 从而通过 proxy 门禁。change-password 现调 `supabaseAdmin.auth.admin.signOut(..., "global")`；logout 原先丢弃 `signOut()` 结果并一律返 `{ok:true}`，现用 `scope:"global"` 并以 502 + `revoked:false` 区分未真正吊销；`/api/auth/me` 的 refresh 路径补上 `password_changed_at` 比对 | ⚠️ | 待部署 |
| PROD-F09-MONEY-AUTHORIZATION-PHASE2 | supabase/migrations/（未来）, src/app/api/** | TODO | Phase 1 只把三个 SECURITY DEFINER 资金例程的 EXECUTE 从 PUBLIC 收到 `authenticated`（`anon` 不再可调）。真正的授权边界仍是表级 DML 直授 `authenticated` + RLS —— 收紧表级 grant 必须先把资金写入全部迁到 service_role 或 definer 例程，否则即 42501 停摆（这正是被否掉的 leg-2）。tests/security/money-grant-coupling.test.mjs 内置 tripwire：一旦调用者作用域的资金写入清零，必须同一 commit 内改测试与 replay 断言 | ⏳ | — |
| PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL | src/app/api/dev/setup/route.ts | TODO | `DEV_EMAIL`/`DEV_PASSWORD` 硬编码在公开仓库中。该路由在 `NODE_ENV === "production"` 或 `NEXT_PUBLIC_DEV_MODE !== "true"` 时返 403，故无法在生产重建账号；但凭证仍在源码与 git 历史里。属源码改动，不属迁移。与用户暂缓的“git 历史清除/凭证轮换”相关，需本人点头 | ⏳ | — |
| PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION | src/app/api/users/[id]/password/route.ts | TODO | 管理员为他人重置密码时无法做全局吊销：`auth.admin.signOut` 需要目标用户自己的 JWT。目前只靠 `password_changed_at` + proxy 门禁，refresh token 在 access token 过期前仍可用一次。需改用 GoTrue admin API 的 session 撤销端点或等价方案 | ⏳ | — |
| PROD-DEPLOY-TASKBOARD-GATE-MISSING | scripts/deploy.sh, scripts/deploy-immutable.sh | TODO | AGENTS.md 声称 “`scripts/deploy.sh` Step 0 运行 `check-taskboard.sh`，任一 ❌ 即中止部署”。实测 `scripts/deploy.sh` 只有 4 行 `exec`，`deploy-immutable.sh` 与 canonical wrapper 均**不调用**该门禁 —— 文档与实现不一致（与本轮修的 false-green 同类）。未擅自在生产部署路径新增硬门禁：一行补丁即可（`bash "$ROOT/scripts/check-taskboard.sh" || exit 64` 置于 claim 校验之后），但会立刻按设计阻断当前带 ❌ 的部署，须运维决定 | ⏳ | — |
| PROD-PROXY-ACTIVITY-THROTTLE-UNBOUNDED | src/proxy.ts | TODO | 信息性：`activityThrottle` 是以 user id 为键、永不淘汰的 `Map`，随累计活跃用户数单调增长（每条目约几十字节，非攻击者可控放大，故非 P0/P1）。与限流器同类问题，应改为固定槽位或带 TTL 的结构 | ⏳ | — |

> **复审逐条结论（confirmed / refuted / insufficient）**：F-09 资金授权 leg-2 会造成停摆 → **confirmed**（已删除该 leg）；F-02 删除不可逆且毁证据 → **confirmed**（改停用 + 互锁 + 可回滚）；F-06 profile-email/改密接管链 → **confirmed**（列级 grant + 改密只用 `user.email`）；F-08 审计/会话可伪造插入 → **confirmed**（三表 `with check (false)` + 移除 proxy 的 PAGE_VISIT 调用者写入）；F-10 Meta token 明文可读 → **confirmed**（drop policy + revoke `anon`/`authenticated`，`service_role` 保留）；限流器可被冲刷 → **confirmed**；开放重定向 + 脚本可读 token → **confirmed**；旧 token 吊销缺口 → **confirmed**；KPI delete-then-insert 数据丢失 → **confirmed**；COS 脚本 release 漂移 → **confirmed**；Hermes CI 不可达 → **confirmed**；迁移未被 CI 演练 → **confirmed**（且更严重：整个历史不可重放）；canonical deploy 接受不完整/错误 event 的声明 → **partially refuted**：`infra/systemd/newme-deploy.sh` 确实查了 GitHub API（复审说“完全不查”不成立），但它漏了 `event`/`head_branch`，且 `scripts/deploy.sh` → `deploy-immutable.sh` 这条路径当时确实零校验 —— 两处均已修。
>
> **insufficient evidence（无线上通道，未确认也未否认）**：五个 L0 迁移是否已被他人手工应用于生产；生产 `pg_policies`/`information_schema.role_table_grants` 的当前真实姿态是否与 `docs/rls-explorer.md` 一致；`20260723130000_lock_definer_boundaries.sql` 是否已在生产生效（源码显示它应已关闭三表 INSERT，但 rls-explorer 显示宽松 policy 仍在——二者矛盾，需线上核对）。

---

## M1 当前版本发布项 — 2026-07-19（SAM-6）
> 事实源：Linear milestone `M1 当前版本生产交付` 与 GitHub `main@43ec83432588909db1a064da4de2b4b029ff8f76`。STATUS 遵循本文件 Frozen v2：`REVIEW` 对应 Linear `In Review`，`TODO` 对应 Linear `Todo`。候选基线不等于最终生产放行；没有完整证据不得写成 `DONE`。

| TASK_ID | STATUS | M1 发布门禁 / 当前事实 |
|---|---|---|
| SAM-6 | REVIEW | 候选基线 `main@43ec83432588909db1a064da4de2b4b029ff8f76`；CI run `29664871138` 为同 SHA `success`；文档一致性由 SAM-41 收口；合并后的 main 仍待总控复核。 |
| SAM-7 | DONE | 部署前只读检查通过（M1 链）。 |
| SAM-8 | DONE | 冻结版本部署 + 健康验证（evidence 20260719-193837.json）。 |
| SAM-9 | DONE | 生产 P0 Smoke 14/14 + regression 22/22。 |
| SAM-11 | DONE | 机器项全验 + 工作簿导入写测试全 PASS（M1 RELEASED 2026-07-20）；差异 SAM-45 进 M2。 |
| SAM-12 | DONE | **RELEASED**：全链证据汇总 + 唯一结论出具（2026-07-20，森哥签收生效）。 |
| SAM-24 | DONE | DB 兼容/备份/回滚点验证通过（M1 链）。 |
| SAM-25 | DONE | 正向链路 + 负向 6/6 全 PASS，fixture 清理基线零漂移；差异 SAM-46 进 M2、SAM-48 热修已上线。 |
| SAM-26 | IN_PROGRESS | 角色权限矩阵机器验✓；移动端/视觉挂起人工（不拦发布，留 M2 观察）。 |
| SAM-27 | DONE | 集成/cron/可观测性验收✓；SAM-47 随热修 #1 关闭。 |
| SAM-28 | DONE | 业务签收（森哥 2026-07-20）+ 技术签收（机器全量验收）→ Done。 |
| SAM-43 | REVIEW | Linear 仍为 `In Review`；登录态视觉/交互 UAT 未完成，不得以 API/CI 证据替代。 |
| SAM-47 | DONE | 热修 #1：health 响应 memory 字段删除，生产实测无 memory（BUILD_ID `opQHvVVbt_cF_G80h-7is`）。 |
| SAM-48 | DONE | 热修 #1：报价引擎校验（未知设备 400 + 零总价双端 400），生产 API 验收 8/8（BUILD_ID `opQHvVVbt_cF_G80h-7is`）。 |

> SAM-41 只补文档事实，不改变发布、部署或 UAT 工作流；合并后仍需总控复核 `main`，再决定 SAM-6 是否推进。

---

## MoA Tier 1 — Technical Debt (IMMEDIATE, 1-2 weeks)
Source: MoA 4-round audit, 3-model unanimous sign-off, lines 478-500 + 559-600 + 643-675

### 1A. New Files (infrastructure)

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| T1-1 | src/lib/supabaseQuery.ts | CREATE | file exists + contains `useSupabaseQuery` + `AbortController` + retry logic (>=2 retries) + timeout (8s default) | ✅ | 2026-06-30 |
| T1-2 | src/components/DashboardErrorBoundary.tsx | CREATE | file exists + contains `errorId` + `Sentry` (or `sentry`) + fallback UI | ✅ | 2026-06-30 |
| T1-3 | src/shared/hooks/usePipelineDragDrop.ts | CREATE | file exists + contains `onDragStart` + `onDrop` + `draggingLeadId` | ✅ | 2026-06-30 |
| T1-4 | src/shared/hooks/useStageGuard.ts | CREATE | file exists + contains `stageGuard` or `validTransition` + STAGES definition | ✅ | 2026-06-30 |

### 1B. Modified Files (integration)

| # | File | Operation | Verification | Status | Done Date |
|---|------|-----------|-------------|--------|-----------|
| T1-5 | src/app/(dashboard)/layout.tsx | MODIFY | contains `ErrorBoundary` wrapping children | ✅ | 2026-06-30 |
| T1-6 | src/app/(dashboard)/leads/page.tsx | MODIFY | contains `usePipelineDragDrop` + `useStageGuard` + `useSupabaseQuery` + empty stages visible by default | ✅ | 2026-07-01 |
| T1-7 | src/app/(dashboard)/pipeline/page.tsx | MODIFY | contains `usePipelineDragDrop` (replaces inline drag) + `useSupabaseQuery` (replaces direct supabase calls) + `useStageGuard` | ✅ | 2026-07-01 |
| T1-8 | src/app/(dashboard)/leads/[id]/page.tsx | MODIFY | `maybeSingle` count >= 3 + contains `skeleton` or `Skeleton` or `loading` fallback + `useSupabaseQuery` | ✅ | 2026-07-01 |
| T1-9 | src/app/(dashboard)/products/page.tsx | MODIFY | uses `fetch('/api/products')` via API route (replaced client-side `useSupabaseQuery` + `createClient`, see P1-B Supabase removal) | ✅ | 2026-07-04 |
| T1-10 | src/app/globals.css | MODIFY | contains `error-boundary-fallback` class | ✅ | 2026-07-01 |

### 1C. Sentry Integration

| # | Requirement | Verification | Status | Done Date |
|---|-------------|-------------|--------|-----------|
| T1-11 | Sentry captureException in ErrorBoundary | DashboardErrorBoundary.tsx contains `Sentry.captureException` or `captureException` | ✅ | 2026-07-01 |
| T1-12 | Sentry error events actually received | Manual: trigger error → Sentry dashboard shows event | ✅ | 2026-07-01 |

**Tier 1 Progress: 12/12 (100%) ✅**

---

## P0 紧急性能修复（2026-07-01 立）

| # | Problem | Requirement | Verification | Status | Done Date |
|---|---------|-------------|-------------|--------|-----------|
| P0-1 | leads/[id] 加载 2.1 分钟 / 431 请求 | fetchData 的 8 个串行查询改并行 + 关键路径用 PostgREST JOIN | 详情页加载 < 5s，请求数 < 50 | ✅ | 2026-07-01 (编码 + migration + 161ms 验证) |

---

### MoA Tier 2 — UI Consistency (SHORT-TERM, 2-4 weeks)
Blocked by Tier 1 completion. Do NOT start until all Tier 1 = ✅.

|| # | Problem | Requirement | Verification | Status | Done Date |
||---|---------|-------------|-------------|--------|-----------|
|| T2-1 | P-2: Scroll behavior inconsistency | Unified scroll strategy across all dashboard pages | All pages use consistent overflow/scroll container | ✅ | 2026-07-01 |
|| T2-2 | P-3: Kanban stats scattered | Merge progress bar + numbers + percentage into single visual unit | Single stats component, not 3 separate elements | ✅ | 2026-07-01 |
|| T2-3 | P-5: Empty stage visibility | Default show empty stages + collapse toggle button | `showEmptyStages` default = true, toggle button exists | ✅ | 2026-07-01 |
|| T2-4 | 锚定功能卡片 (sticky headers/filter/action bar) — 2026-07-01 新立 | 长页面滚动时 filter/标题/搜索/操作栏跟随屏幕 | leads/page.tsx (DashboardScrollContainer 内 3 件套) + leads/[id] + payments + quotations + tasks (4 页 viewport 滚动模式) 全部锚定 | ✅ | 2026-07-01 (commits 1ac84ca + a606d9b + 0fe9543 + aa54565 + 7c7d74c) |

**Tier 2 Progress: 4/4 (100%) ✅**

---

### MoA Tier 3 — Architecture (LONG-TERM, 1-2 months)
Tier 2 unlocked (T2-1/2/3 ✅ 2026-07-01).

| # | Problem | Requirement | Verification | Status | Done Date |
|---|---------|-------------|-------------|--------|-----------|
| T3-1 | DashboardLayout unification | Full DashboardLayout refactor (方案A) | Single layout component, all pages conform | ✅ 2026-07-03 (24/24 pages) | |
| T3-2 | Performance monitoring + alerts | Lighthouse/Web Vitals baseline + alerting | Baseline recorded, alerts configured | ✅ | 2026-07-03 (web-vitals.ts + WebVitalsReporter.tsx + lighthouse-baseline.md) |
| T3-3 | Code debt elimination | Refactor large files (leads 1108行, leads/[id] 946行, pipeline 566→146行) | No single file > 500 lines, shared components extracted | ✅ | 2026-07-03 (pipeline: 5afce2f + ea791b1; leads: 15/15 steps done, page.tsx 351行) |
| T3-4 | Docs drift: coding_standards §4 contracts/payments stale | Refresh table schema section to match actual DB (contract_amount / sales_id / confirmed) | coding_standards.md §4 列与 DB service_role 查询结果一致 | ✅ | 2026-07-01 |

**Tier 3 Progress: 4/4 (100%) ✅**

---

### Pending Tasks (未启动)

| # | Task | Requirement | Verification | Status |
|---|------|-------------|-------------|--------|
| kanban-unify | 统一 kanban stage 定义 + fmtAED 到 shared/ | pipeline/leads 共享 KanbanShell + 共享 stage 常量 | shared/kanban/types.ts 存在 + leads/pipeline import from shared | ✅ 2026-07-06 |
| perf-1 | 全站性能优化 | 108 请求 → <50, 3.3MB → <1.5MB, 33.73s → <5s | Lighthouse + bundle analyzer report | 🔒 第一批完成，剩余冻结（见 SPEC.md §十一） |\n|  | ├─ xlsx lazy-load | `/leads` 首屏 -234KB | `import("xlsx")` 动态加载 | ✅ `c54d83b` |\n|  | ├─ Meta Pixel 条件加载 | 15 后台路径不加载 fbevents.js | 路由匹配验证 | ✅ `6dca992` `e7363fa` |\n|  | ├─ Bundle Analyzer 基线 | 全站客户端 JS map | ANALYZE=true 报告 | ✅ `e50a9c4` |\n|  | ├─ deploy.sh v4.0 隔离构建 | 生产 .next 零触碰 | swap 停机 <5s | ✅ `77563c8` 等 6 commits |\n|  | ├─ P0 防复发 guard | 阻止直接 build 覆盖生产 | guard-prod-build.sh | ✅ `d25faf3` |\n|  | └─ PostHog/Recharts/base-ui | 下一轮优化（解冻后） | — | 🔒 冻结 |
| hermes-ci | Hermes CI webhook 订阅 crm-ci | CI pipeline 跑通 + webhook 触发 | 等待 `ci` 成功、`crm-ci` workflow_run 成功及 Hermes webhook delivery 200 可审计证据 | ⚠️ REVIEW |
| moa-tier2-detail | MoA Tier 2 决策点 3+4 方案细化 | 10-12 人天方案文档 | `crm-v3/v3.1/moa-tier2-detail-20260701.md` 已细化决策点 3+4，2026-07-10 复核签收 | ✅ 2026-07-10 |

---

### MoA Tier 4 — Process Governance (新建 2026-07-01)
Tier 3 + P0 完成度不是前提——运维治理独立于产品进度。事由：2026-07-01 Sentry 131348591 流程违规补审。

| # | Problem | Requirement | Verification | Status | Done Date |
|---|---------|-------------|-------------|--------|-----------|
| T4-1 | hermes-rules.md §十 缺运维操作边界 | 立 §十 运维操作三档分级（🟢/🟡/🔴）+ OEEC 紧急例外 + 速查表 10 类 | 章节落地、3 档表完整、OEEC 条款存在、速查表覆盖 Sentry/服务/数据库/Secrets | ✅ | 2026-07-01 |
| T4-2 | Sentry issue 131348591 archived_forever 后未登记 ops-log + ChunkLoadError 紧急重建 | 在 HANDOFF-20260701.md 加 ## Ops Log 条目 + commit 留痕 | HANDOFF 含完整 6 字段（时间/命令/操作者/资源ID/缘由/审计报告路径） | ✅ | 2026-07-01 |
| T4-3 | deploy.sh Step 3 build guard 与服务启停冲突 | 重构 deploy.sh 让 build 步骤先自动停服务再 build 再起，或分离 build/deploy 步骤 | deploy.sh 完整跑通（5/5 步），build 不再被 guard 拦 | ✅ | 2026-07-01 (commit 5d7b60b, deploy.sh + package.json, nginx CSP 也改) |
| T4-4 | PostHog `eu-assets.i.posthog.com` 域名未白名单 CSP | CSP script-src/connect-src 加 eu-assets.i.posthog.com | 浏览器 console 不再报 CSP violation | ✅ | 2026-07-01 (nginx 改完 + reload, 生产 200 + CSP 头返回) |

**Tier 4 Progress: 4/4 (100%) ✅**

---

## Phase 1 — Business Features (25/25 ✅ COMPLETE)

All 25 items from Phase 1 business delivery are DONE. No action needed.
Includes: P0-1~P0-7, Sentry fix, RLS matrix (35 tables, 250 policies, 0 FOR ALL),
log_activity prefix, AI gateway v2.0-2.1, profiles.email migration, 3.3-3.7 dev,
integration tests, Codex review fixes, decision points 3-4, public→authenticated RLS fix.

---

## Freeze Rules (from MoA sign-off)

1. **禁止** 在任何页面直接调用 `supabase.from().select()` — 必须通过 `useSupabaseQuery`
2. **禁止** 在 leads/pipeline 实现新拖拽逻辑 — 必须复用 `usePipelineDragDrop`
3. **禁止** 移除或绕过全局 ErrorBoundary
4. **禁止** 在 Tier 1 完成前启动 Tier 2/Tier 3 工作
5. **禁止** 在 leads 详情页假设外键数据必然存在
6. **禁止** 引用未经 `supabase.from("table").select().limit(1)` 验证过的数据库列名。CC 子代理生成的任何 supabase 查询，必须在 commit 前用 service_role key 验证实际表结构

---

## How to Add New Tasks

1. Run an audit / plan
2. Add each file/action as a row in the table above
3. Define the **verification condition** (grep pattern, file existence, test pass)
4. Status: ❌ pending → ⚠️ partial → ✅ done
5. Fill in Done Date when ✅

## How to Remove Completed Tasks

After deployment + production verification, move completed rows to archive section below.

---

## Archive

### P1-B: Client Supabase Removal (analytics/ads/products) — 2026-07-04
| # | File | Change | Result |
|---|------|--------|--------|
| P1-B | src/app/(dashboard)/analytics, /ads, /products | 移除 client Supabase → server actions + API routes | analytics 995→771KB (-224KB), ads 961→738KB (-223KB), products 1066→842KB (-224KB) |

### P1-C: Dashboard Summary API Aggregation — 2026-07-04
| # | File | Change | Result |
|---|------|--------|--------|
| P1-C | src/app/api/dashboard/summary/route.ts | NEW — 聚合 14 条 server Supabase 查询，30s cache | dashboard 18 client Supabase REST calls → 1 fetch (573ms) |
| P1-C | src/app/(dashboard)/dashboard/page.tsx | −355 lines client Supabase reads, +30 lines fetch | 0 Supabase REST data calls on /dashboard Network panel |

验收: `/api/dashboard/summary` 573ms。Network 面板 0 `supabase.co/rest/v1/` 调用（仅 1 auth token）。BUILD_ID `arpeAWPUml4dotHYJ10KK`。

### P1-D: Leads List API Aggregation — 2026-07-04
|| # | File | Change | Result |
||---|------|--------|--------|
|| P1-D | src/app/api/leads/list/route.ts | NEW — 聚合 auth+profile+leads+salesUsers 4 queries | leads 4 client Supabase reads → 1 fetch |
|| P1-D | src/app/(dashboard)/leads/_hooks/useLeadsData.ts | Supabase reads → fetch('/api/leads/list') | 0 Supabase REST data calls on /leads Network panel |
|| P1-D | src/app/(dashboard)/leads/page.tsx | −createClient import, −supabase const | bulkTransfer → useLeadMutations integration |

验收: BUILD_ID `34myA0cSpjO3BQHGA3DTc`。smoke 14/14。

### P1-E: Analytics Summary API Aggregation — 2026-07-04
|| # | File | Change | Result |
||---|------|--------|--------|
|| P1-E | src/app/api/analytics/summary/route.ts | NEW — 聚合 7 条 server Supabase 查询，Promise.all 并行，30s cache | analytics 6 条分散 fetch → 1 条 /api/analytics/summary |
|| P1-E | src/app/(dashboard)/analytics/page.tsx | +AnalyticsContext, 单次 fetch 替代 6 条分散请求 | 0 client Supabase reads，AnalyticsContext 可供子组件未来迁移 |

验收: BUILD_ID `SKwOrxKMZl2AoWmEzyXS0`。smoke 14/14。5/5 页面 client Supabase reads 清零。

### P1-F: Workbench Query Parallelization — 2026-07-04
|| # | File | Change | Result |
||---|------|--------|--------|
|| P1-F | src/app/api/workbench/route.ts | 9 次串行 Supabase → 4 步（auth→profile→6并行→leadNames）+ 30s cache | -5 round-trips，缓存命中=0查询 |
|| P1-F | scripts/deploy.sh | GATE_RESULT_DIR /var/lib→~/.hermes | ubuntu 可写，不再 Permission denied |

验收: BUILD_ID `w_RxXx-k8y8aJ2dcuze9`。smoke PASS。Sentry ChunkLoadError 告警已上线(#696330)。

### 下一步摘要
- P2 reads all: ✅ 已上线 (6 页 reads → BFF API routes)
- P2 mutations low: ✅ 已上线 (team/payments/tasks server actions)
- P2 mutations core: ✅ 已上线 (pipeline/contracts server actions)
- P2 mutations settings: ✅ 已上线 (settings lead-assignment server actions)
- Post-audit patch: ✅ 已上线 (de3b52f: tasks + pipeline ownership + useSalesKpiData BFF)
- TRUE_CODEX_REAUDIT 全链: ✅ 已上线 (49cd03f: 一审→修复→二审→部署, BUILD_ID o1toe2b6XmKR_8Jdfx8oP)
- P2.5 Infra Hardening: ✅ 已上线 (11e3805 + 583ba89: 4 audit scripts + 2 release docs)
- P1/P2 Archive: FULL PASS 恢复 ✅

---

## ✅ Done — User-Reported Bugs (Lead Detail Page, 2026-07-06)

| ID | Symptom | Root Cause | Fix | Status |
|---|---|---|---|---|
| BUG-LD-1 | 修改区域 · 酋长国 (emirate) 字段不保存 | `renderInlineEdit` 无 onBlur → 点空白不退出 → 误以为"没保存"（实际 BUG-LD-3 体现） | page.tsx 加 `onBlur={() => setEditField(null)}` + Enter 也清空 + span 包住防止 click 冒泡 | ✅ 2026-07-06 02:57 (BUILD_ID kwrsLUQgv_irKkyEXa7d_) |
| BUG-LD-2 | 点击区域 · 左侧内容被遮盖 | sticky header `bg-background/95 backdrop-blur-sm` 不透明遮盖主内容 | page.tsx 改 `bg-background/70` 去掉 backdrop-blur | ✅ 2026-07-06 02:57 (BUILD_ID kwrsLUQgv_irKkyEXa7d_) |
| BUG-LD-3 | 点击区域进入输入状态，再次点击空白处不还原 | `renderInlineEdit` input 无 onBlur handler | page.tsx 加 `onBlur={() => setEditField(null)}` | ✅ 2026-07-06 02:57 (BUILD_ID kwrsLUQgv_irKkyEXa7d_) |
| BUG-LD-4 | admin 视角 · 转移销售下拉框被遮盖 | `LeadFoldingPanel.tsx:76` Card `overflow-hidden` 裁切 dropdown | 改 `overflow-visible` | ✅ 2026-07-06 02:57 (BUILD_ID kwrsLUQgv_irKkyEXa7d_) |

**部署链路**: commit 8057b80 → BUILD kwrsLUQgv_irKkyEXa7d_ → 14/14 smoke PASS → 0 journal errors → API /health version=kwrsLUQgv_ir.

Note: All four are independent of P3 PRD G1/G2/G3 (quality API, weekly-review, workbench). Batch into one fix after P3 PRD ships.

## 🔴 Open — Production (2026-07-05 23:55 CST)

| ID | Symptom | Root Cause | Fix | Status |
|---|---|---|---|---|
| ROOT_WHITEPAGE_FIX | `https://app.newme.ae/` 打开后白屏 1-3s 后跳转 | Next.js 16 App Router `page.tsx` 的 `redirect()` 被编译为 client-side navigation，触发 `BAILOUT_TO_CLIENT_SIDE_RENDERING`，body 内只有空模板 | 在 `src/proxy.ts` 顶部加 `if (pathname === "/") return NextResponse.redirect(/dashboard, 307)`，edge 层强制 HTTP 307，无需客户端 JS | ✅ | 2026-07-05 16:47 (BUILD_ID NCzYkIdYimkjk9_-xmx75) |

**Fix 链条 (3 commits)：**
- `62cf163` proxy.ts 加 pathname==="/" 307 → /dashboard
- `c6afe98` page.tsx force-dynamic + force-no-store 防止 prerender 缓存
- `d085078` proxy.ts config.matcher 加 "/"（**根因**：matcher 缺 / 导致 proxy 完全没注册到 middleware-manifest.json）
HOTFIX-2 | DEPLOYED | hermes | 2026-07-20 | SAM-45+SAM-46 closed; ca4cfdc(删quotes fallback+导入原始数据面板)+fd2b35e(insert schema对齐); BUILD_ID odB7DlnFp-Er6a5NbVmv0; CI 29705110814 green; K3审计 PASS_WITH_WARNINGS(Ship); 生产API验收通过+基线零漂移; SAM-49登记(hermes路由静默零总价姊妹项+K3 P2)
