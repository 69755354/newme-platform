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
| PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL | REVIEW | Claude | 2026-08-12 |
| PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION | REVIEW | Claude | 2026-08-11 |
| PROD-CONTRACT-REVOKE-LIST-DIRECT-WRITE | REVIEW | Claude | 2026-08-13 |
| PROD-PAYMENT-RECORD-NO-IDEMPOTENCY-KEY | REVIEW | Claude | 2026-08-13 |
| PROD-DEPLOY-TASKBOARD-GATE-MISSING | REVIEW | Claude | 2026-08-11 |
| PROD-PROXY-ACTIVITY-THROTTLE-UNBOUNDED | TODO | Claude | 2026-08-11 |
| PROD-MIGRATION-HISTORY-IMMUTABILITY-GATE | REVIEW | Claude | 2026-08-11 |
| PROD-CONTRACT-STATUS-PATCH-ROUTE | REVIEW | Claude | 2026-08-11 |
| PROD-ROLLBACK-SECURITY-PRESERVING | REVIEW | Claude | 2026-08-11 |
| PROD-MIGRATION-HISTORY-CONTENT-RECONCILIATION | BLOCKED | Claude | 2026-08-11 |
| PROD-CONTROL-PLANE-BOOTSTRAP | BLOCKED | Claude | 2026-08-11 |
| PROD-MAIN-BRANCH-PROTECTION-UNENFORCED | BLOCKED | Claude | 2026-08-12 |
| PROD-L0-ROUND4-ENTRY-BOUNDARY-AND-MONEY-INTEGRITY | REVIEW | Claude | 2026-08-13 |
| PROD-FIRST-PAYMENT-STATUS-LITERAL-SEQ-ONE | REVIEW | Claude | 2026-08-13 |
| PROD-INSTALLMENT-SCHEDULE-NONCONTIGUOUS | REVIEW | Claude | 2026-08-13 |
| PROD-CONVERSION-RETRY-DOUBLE-COUNTS-AMOUNT | REVIEW | Claude | 2026-08-13 |
| PROD-KPI-PERIOD-DELETE-BYPASSES-ROUTINE | REVIEW | Claude | 2026-08-13 |

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
| PROD-L0-DB-MIGRATIONS-F02-F06-F08-F09-F10 | supabase/migrations/20260811100*.sql, 20260806000000, 20260812000000, 20260813000000 | CREATE | 共 9 个迁移文件已写入但**未应用**。阻塞原因（2026-08-11 更新）：`supabase-prod` MCP 已断开且需交互式 OAuth，本会话无任何线上库通道；此前记录的 `--read-only` 只是同一阻塞的更早形态。已可离线证明的部分（三审后重跑）：`MODE=branch` 在一次性 `postgres:17.10` 上应用 → 幂等重入 → **131 条**行为/目录断言 → rollback 伴随文件 → **30 条 post-rollback 安全断言**全通；`MODE=control` 证明其中 **100 条**在未修复姿态下必失败，且 `100 + 31 = 131` 闭合（无游离断言、无"零断言通过"）。解阻：运维授权 MCP 或由运维本人应用迁移；`20260813000000` 另需执行角色对 `auth.users` 有 SELECT | ❌ | — |

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
| PROD-L0-MIGRATION-REPLAY-GATE | scripts/replay-migrations.sh, supabase/replay/*.sql, .github/workflows/ci.yml | CREATE | **三审否决了上一版**：`MODE=history` 以 `continue-on-error: true` 运行 —— 一个不可能让 job 变红的步骤不是检查，job 因此在自己的日志里报告"迁移目录不可重放"的同时报 success。现三种模式**全部为门禁**：`MODE=control` → `MODE=branch` → `MODE=history`（后者以 `supabase/replay/history-replay-expectation.txt` 的 `EXPECTED_APPLIED=2` / `EXPECTED_STOPPED_AT=20260602010000_crm_mvp_final.sql` 精确钉死，更好与更坏同样红）。`MODE=branch` = floor → 9 个迁移 → fixtures → 幂等重入 → 131 条断言（文件自校验 `ASSERT_TOTAL: 131`）→ rollback 伴随 → 30 条 post-rollback 断言。`MODE=control` 要求 `CONTROL_MUST_FAIL` 100 条全部失败，并强制 `100 + 31 = ASSERT_TOTAL` 闭合，杜绝"零断言/部分断言/首条即中止"也算绿。契约由 tests/release/ci-full-stack-gates-contract.test.mjs 断言（control 早于 branch、job 内**零** `continue-on-error`（正则锚定行首 `^\s*continue-on-error\s*:`）、无 secrets/`PGPASSWORD`/`supabase link`/`--linked`）。另：`validate` job 曾以默认 depth-1 检出运行 `npm test`，历史不可变门禁因此报 `manifest vs git: NOT VERIFIED` 并**变红**（run 31478631894 / job `Repository validation` / step `Repository tests`）—— 门禁 fail-closed 是正确行为，修法是给该 job 加 `fetch-depth: 0`，并由同一契约测试要求"任何运行该门禁（或包含其测试的套件）的 job 必须全历史检出"；该断言对修复前的 ci.yml 为红，故非装饰 | ⚠️ | 待 CI 绿 |
| PROD-MIGRATION-HISTORY-UNREPLAYABLE | supabase/migrations/（103 个既有文件） | AUDIT | 新发现，**未修**，且上一版的"修"已被三审否决并**逐字节还原**。`MODE=history` 从空库在第 **2** 个文件后停在 `20260602010000_crm_mvp_final.sql`（`lead_alerts` 视图选 `l.rep_name`，无任何迁移创建该列）。已确证成因不变且仍未修：`1780601210_workflow_stages.sql` 的 10 位前缀不匹配 CLI 的 `^[0-9]{14}_` 故从未被看见；`20260603000000_add_crm_fields.sql` 含 `ALTER TABLE TABLE` 且 CLI 单文件单事务，故从未在任何环境应用；`20260604000002` 从不存在的 `leads.metadata` 回填；`meta_tokens` / `profiles.password_changed_at` / `profiles.force_password_change` / `leads.rep_name` 无迁移声明。**上一版做过而本轮已撤销的动作**：改名 `1780601210_`→`20260604192650_`、把 `20260603000000` 改为墓碑、新增回填日期 `20260601010000` 的 baseline、改写 `supabase/seed.sql` —— 全部属于对已应用迁移历史的重写。还原证据：`node scripts/check-migration-history.mjs` → `103 listed, 103 verified unchanged`、`manifest vs git: verified against 81956f2ff3bf`。真正的修复需线上 schema 真相（`supabase db dump` 压平 baseline）且若干死文件含会改写生产行的 backfill，属运维任务 | ❌ | — |
| PROD-DEPLOY-RELEASE-CLAIM-VALIDATION | scripts/deploy-immutable.sh, infra/systemd/newme-deploy.sh | MODIFY | `validate_release_claims()` 在任何 mkdir/symlink/服务动作之前 `exit 64`：要求 6 个声明变量全部非空、`CI_RUN_ID` 为数字、`CI_RUN_URL` 必须指向同一 run id 的 github.com 路径、`CI_HEAD_SHA == $SHA`、`CI_CONCLUSION == success`、`CI_EVENT ∈ {push, workflow_dispatch}`、`applied_verified` 必带合法 `MIGRATION_IDS` 而 `not_required` 必不带。canonical wrapper 的 GitHub API 校验加入 `event=push` 与 `head_branch=main`（原先任一分支的绿色 `pull_request` run 都被当作 main 证据，而 release-final 作业以 `github.event_name` 为条件 → 更小的门禁集被记成完整门禁）。验收：tests/release/deploy-release-claim-validation.test.mjs 11/11，**直接执行**被抽出的 shell 函数与 wrapper 内联校验块（含 manual_verified 旁路被拒） | ⚠️ | 待部署 |
| PROD-CI-CRM-HERMES-FALSE-GREEN | .github/workflows/crm-ci.yml | MODIFY | `hermes-contract` job 与 Telegram 失败告警均以 `workflow_run` 为条件，而该 workflow 的触发器只有 workflow_dispatch/pull_request/push —— 于是每次 PR 与 main push 都跳过唯一 job 并报 success，失败告警永不可能执行。触发器改为 `workflow_dispatch` + `workflow_run(workflows: [ci], types: [completed])`，`pull_request`/`push` 删除而非保留。验收：`npm run check:workflows` 3/3。**观测边界（本轮无法闭环）**：GitHub 只从默认分支读取 `workflow_run` 触发器定义，且本 job 另有 `head_branch == 'main'` 条件 —— 故本 PR 的 `ci` 成功（run 31457465666）不会、也不应触发 `crm-ci`；本轮 `gh run list --workflow crm-ci.yml` 对 SHA `c59d687` 无任何 run，即为预期结果而非回归。真实证据只能在合入 main 后的首次 main push 上取得（`crm-ci` workflow_run 成功 + Hermes delivery 200），见 line 270 | ⚠️ | 待合入 main 后观测 |
| PROD-L0-OPEN-REDIRECT-SESSION-CHAIN | src/lib/safe-redirect.ts, src/app/login/page.tsx | CREATE+MODIFY | `?redirect=` 未净化即为开放重定向，且 `sb-<ref>-auth-token` 为脚本可读，跳转目标能取得刚建立的会话上下文。验收：tests/unit/l0-auth-hardening.test.mjs 中 `safeRedirectPath` 断言拒绝任意 scheme 绝对 URL（含 `javascript:`/`data:`/`vbscript:`/`file:`）、`//evil`、`///evil`、`/\evil`、`\\evil`、控制字符、非字符串、空白、超长（>512），保留同源 path+query+hash，兜底 `/dashboard` | ⚠️ | 待部署 |
| PROD-AUTH-LIMITER-EVICTION-BYPASS | src/lib/rate-limit.ts | MODIFY | 原实现用 `Map` + `MAX_TRACKED_KEYS=10000` 上限，攻击者只要发足量不同 key 就能把自己的计数条目挤掉从而清零限流。改为固定 `SLOT_COUNT=16384` 的 `Int32Array`/`Float64Array` + sha256 分槽 + 饱和自增，不再有可被冲刷的条目。验收：tests/unit/l0-auth-hardening.test.mjs 断言 40000 个不同 key 之后原 key **仍被拒**、1MB key 不崩、窗口边界精确（`windowMs - 1` 拒 / `windowMs` 放）、持续洪泛不回绕 | ⚠️ | 待部署 |
| PROD-RELEASE-SCRIPT-FAIL-CLOSED | src/lib/release-script.ts | CREATE | 上一版对空输入 fail-open 返回 `process.cwd()`，且用前缀包含判断而非 `path.relative` 归一。现拒绝空串/纯空白/非字符串/绝对路径/含 `..` 段/逃出仓库根/目录（`statSync().isFile()`）。验收：tests/unit/l0-auth-hardening.test.mjs 断言 `""`、`"   "`、`"."`、`"./"`、`"scripts"`、`"scripts/"`、`/home/ubuntu/newme-platform/scripts/cos-presign.py`、traversal 全部返回 `null`，`scripts/replay-migrations.sh` 正常解析 | ⚠️ | 待部署 |
| PROD-KPI-TARGETS-ATOMIC-REPLACE | src/app/api/kpi/targets/route.ts, supabase/migrations/20260811100500_kpi_targets_atomic_replace.sql | MODIFY+CREATE | 原为两次 PostgREST 调用即两个事务：先 `delete().eq("period")` 再 `insert(rows)`。第二步任意失败（`target_type` CHECK、`NUMERIC(12,2)` 溢出、未知 `assigned_to`、连接中断）都会留下**已提交的删除**与空白周期，且无副本无恢复路径 —— settings UI 一行畸形数据即可清空整月目标。改为单事务 SECURITY DEFINER `replace_kpi_targets(p_period, p_rows, p_set_by)`（`search_path` 固定、仅 `service_role` 可 EXECUTE）。验收：replay 断言 `kpi-fixture-period-seeded` / `kpi-failed-replace-preserves-period`（坏 `target_type` 回滚后既有 2 行仍在）/ `kpi-empty-replace-preserves-period` / `kpi-successful-replace-replaces-period` / `kpi-authenticated-cannot-execute` / `kpi-anon-cannot-execute` | ⚠️ | 待部署 |
| PROD-QUOTATION-CONVERT-ATOMICITY | src/app/api/quotations/[id]/convert/route.ts | MODIFY | 两个缺陷。**并发**：`quote.contract_id` 只是读，写在请求最末，两个并发 POST 都读到 null → 同一报价生成两份合同、两份审批、两个项目、lead 被判定 won 两次。现改为先做条件更新抢占（`.eq("status","accepted").is("contract_id", null)`），以匹配行数为互锁，输者返 409；后续任一步失败则 `releaseClaim()` 把状态放回 `accepted`，避免永久卡在 `contract_created` 而无合同。**确定性失败**：合同号序号原先用调用者 RLS client 计数，`policy_contracts_select_sales` 只让销售看到自己的行，因此 count 漏掉同事当天的合同 → 生成已存在的号 → `contract_no` UNIQUE 触发 23505 → 500；非 admin 只要当天有他人签约就必然失败。现用 `supabaseAdmin` 计数并对 23505 重试（`MAX_CONTRACT_NO_ATTEMPTS=10`）。验收：`npm test` 0 fail + check:security 无超基线 | ⚠️ | 待部署 |
| PROD-COS-SCRIPT-RELEASE-DRIFT | src/app/api/cos/download-url/route.ts, src/app/api/contracts/[id]/upload-url/route.ts, src/app/api/dashboard/ads-roi/import/route.ts | MODIFY | 三处外部脚本调用原先按绝对/固定路径找 `scripts/cos-presign.py`、`scripts/parse-ad-spend.py`，与 immutable release 树漂移（回滚后仍指向新脚本，或指向 release 之外的路径）。改为经 `resolveReleaseScript()` 在**当前运行 release 内**解析，解析失败即 fail-closed；子进程环境只传脚本实际读取的变量，不再整体 spread `process.env` | ⚠️ | 待部署 |
| PROD-AUTH-OLD-TOKEN-REVOCATION | src/app/api/auth/change-password/route.ts, src/app/api/auth/logout/route.ts, src/app/api/auth/me/route.ts | MODIFY | `password_changed_at` 只由请求 token 的 `iat` 判定，改密前签发的 **refresh token 仍能换出 iat=now 的新 access token** 从而通过 proxy 门禁。change-password 现调 `supabaseAdmin.auth.admin.signOut(..., "global")`；logout 原先丢弃 `signOut()` 结果并一律返 `{ok:true}`，现用 `scope:"global"` 并以 502 + `revoked:false` 区分未真正吊销；`/api/auth/me` 的 refresh 路径补上 `password_changed_at` 比对 | ⚠️ | 待部署 |
| PROD-F09-MONEY-AUTHORIZATION-PHASE2 | supabase/migrations/20260812000000_money_actor_identity_and_atomicity.sql, src/app/api/contracts/**, src/app/api/quotations/[id]/convert/route.ts, src/lib/money-rpc.mjs | CREATE+MODIFY | 三审确认的缺陷：例程相信调用方传来的 approver/confirmer/allocator id，而 EXECUTE 已授予全部 `authenticated`。本轮 `money_actor(p_claimed, p_allowed_roles)` 以 **JWT subject 为唯一 actor**（参数不符即 42501）并校验 profile 存在/`is_active`/角色；五个 `trg_guard_*`（**故意 SECURITY INVOKER** —— 判别式 `money_write_is_direct()` 读 `current_user`，改 DEFINER 会让它对所有人放行）拒绝以 `authenticated`/`anon` 到达的直写；新增 `create_contract`/`convert_quotation_to_contract`/`set_contract_status`/`revoke_contract` 单事务例程；`allocate_payment` 绑定分期到该付款自己的合同。五个 route 改为只调例程，SQLSTATE→HTTP 由 `src/lib/money-rpc.mjs` 单点映射（未映射码一律 500 且不回引数据库消息）。验收：`tests/security/money-route-rpc-coupling.test.mjs` 23/23（含实参↔形参核对、UI 转移表与 `set_contract_status` 双向相等、未映射码不泄消息）+ replay 的 `money-*` 断言。**四审 P1-1 / P1-9（本轮新增，两条均先复现后修）**：(1) P1-1 —— `profiles.role` 可为 NULL（`profiles_role_check` 对 NULL 恒真，生产已可持有此行），而角色判别若写成 `not (v_role = any (array[...]))`，在 NULL 下整式求值为 NULL 而非 true，`if` 不进入分支即**放行**（fail-open）。真实 Postgres 17 容器、已应用迁移的库、事务回滚，逐一复现：把 round-2 的成员判别函数体装回 → `sqlstate=00000 accepted=t message_names_the_null_role_boundary=f`；本轮 `money_actor` → `sqlstate=42501 accepted=f message_names_the_null_role_boundary=t`。(2) P1-9 —— 结算权限在四处互相矛盾：route 与 RBAC 文档写 admin/boss/finance，payments 页把 Confirm/Allocate 按钮开给 `operator`，而 `20260812000000_money_actor_identity_and_atomicity.sql:606` 与 `:709` 的 `confirm_payment`/`allocate_payment` role list 实为 `array['admin','boss','finance','operator']` —— 于是"按钮点了像没反应"的 operator 只要直接调 RPC 就能结算真钱。现以数据库为权威收敛到 admin/boss/finance，UI 用 `SETTLEMENT_ROLES` + `canSettle` 对齐（`isPrivileged` **保留**，它是"录入付款/查看全部付款"的正确规则，本轮只把两个结算动作移出它）。复现：把该迁移 585–683 行的 round-2 `confirm_payment` 原样装回已迁移库并以 operator 探测 → `ROUND-2 sqlstate=00000 confirmed=t`；本轮 → `SHIPPED sqlstate=42501 confirmed=f message_names_the_operator_role=t`。验收（可执行，非源码断言）：replay 新增 K7 段共 **18 条**断言，`ASSERT_TOTAL: 221 → 239`（声明处与库内 ledger 自检四处同步）；两个新 fixture 身份（`0a0a…` operator、`0b0b…` role=NULL 且 `is_active=true` —— 刻意让拒绝只能归因于缺角色而非停用）+ 两个专用 lead（`0c0c…`/`0d0d…`：探测须经 `create_contract()` 现造一份 pending_admin 合同，因为 fixture 里的 `c1c1…` 早已被前面章节推进到 `approved`，借用旧 lead 又会撞 `idx_contracts_one_active_per_lead` 变成 23505 空断言；另有两条 setup 非空断言把这种空转判红）；无角色身份被 `confirm_payment`/`allocate_payment`/`void_payment`/`create_contract`/`approve_contract`/`convert_quotation_to_contract`/`set_contract_status`/`revoke_contract` **八条路径**分别以 42501 且消息**指名该边界**拒绝，operator 被结算三例程拒绝、同时仍能 `approve_contract` 把 pending_admin 推到 `pending_ceo`（正控制：证明"被拒"不等于"operator 什么都做不了"）；每组拒绝前后比对 `contracts/payments/confirmed/allocations/approvals/plans` 六项计数签名逐字相同，且读回一律在 `reset role` 之后（否则 RLS 会把读回变成空断言）。三模式实测：`MODE=branch` → 11 migrations / 239 release assertions / 47 post-rollback，`ASSERT_LEDGER total=239 passed=239 failed=0`，18 个 K7 marker 全 `ASSERT_OK`；`MODE=control`（未打本轮迁移的 floor）→ `239 assertions, 190 load-bearing, 49 floor-passing, 0 unclassified SQL errors`，K7 中 14 条在 floor 上如实判红（含 operator 正控制 —— 旧 `approve_contract` 对不存在的合同 id 也返回成功，故该断言额外要求 `v_moved='pending_ceo'` 才不假绿）；`MODE=history` → `APPLIED=2 / TOTAL=113 / STOPPED_AT=20260602010000_crm_mvp_final.sql`（既有钉住点未动）。UI↔DB 耦合另由 `tests/security/money-grant-coupling.test.mjs` 第 4 例守住（`SETTLEMENT_ROLES` 必须等于三个结算例程**最后一次定义**的 role list —— 按文件名序取末次定义，因为那才是按序应用后库里装着的那份；两个结算按钮上方的 guard 必须含 `canSettle` 且不含 `isPrivileged`），两半均经变异验证（分别改 `SETTLEMENT_ROLES` 与把按钮改回 `isPrivileged`，各自判红后已还原，`git status` 确认页面无改动）。**未关闭**：迁移未应用；应用后任何仍以调用者 client 直写资金表的路径会立刻 42501；`on_lead_won()` 由 active 改 draft 需登录态 UAT | ❌ | — |
| PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL | src/lib/dev-identity.mjs, src/app/api/dev/setup/route.ts, src/app/api/auth/dev-login/route.ts, scripts/check-published-credentials.mjs, supabase/preflight/f02-credential-cutover.md, docs/employee-readiness-20260624.md, docs/onboarding-guide.md, docs/onboarding-guide-en.md, docs/context-pack/flight-recorder-phase0.md, docs/context-pack/11-tanya-feedback-raw.md, migration-output/company-profile.md, crm-v3/ops/HANDOFF-20260701.md, OC-MIGRATION-BRIEF.md, test-matrix.md, test-matrix-runner.mjs, test_matrix.py, .gitignore, tests/security/dev-identity-bootstrap.test.mjs, tests/security/published-credentials.test.mjs | CREATE+MODIFY | 四审 A0。**上一轮把范围写小了，特此更正**：审计只记了 `src/app/api/dev/setup/route.ts` 一处硬编码口令；按同一形状把全仓翻一遍，实际是**八个身份 + 生产数据库口令 + 一条 Supabase PAT 提权配方、十二个文件、二十处**明文发布（其中十五处是逐个文件读出来的，另五处只有把门禁范围改成“恰好等于 git ls-files、不排除任何东西”之后才暴露 —— 范围才是缺陷，正则不是）。 最严重的一处与应用完全无关：`crm-v3/ops/HANDOFF-20260701.md` 与 `crm-v3/v3.1/v3.1 P1P1计划0629.txt`（两处）把**生产 Supabase 数据库口令**贴在一条能跑的命令行里（`supabase migration list --linked --password <值>`）。它不是应用身份，`is_active`、`force_password_change`、`20260813000000` 的 RLS 会话边界、GoTrue 封禁**对它一概无效**，直连 SQL 绕过 §2.2 的全部 policy。因此轮换它是 §3 的第 0 步，排在封禁之前。 另六个身份（boss/operator/admin/sales×3）散在 `docs/employee-readiness-20260624.md`（六行表格 + 一行中文“今天临时密码：”）、`docs/context-pack/flight-recorder-phase0.md`（`| Password | … |` 的 Field/Value 行）、`docs/context-pack/11-tanya-feedback-raw.md`、`migration-output/company-profile.md`、两份 `docs/onboarding-guide*.md`；其中**五个身份共用同一个值**，泄一个等于泄五个。 **本轮只动代码与文档，不碰生产**：(1) 两条 bootstrap route 改由 `src/lib/dev-identity.mjs` 统一解析身份，**没有任何默认值** —— 生产、未显式 opt-in（`ALLOW_DEV_IDENTITY_BOOTSTRAP`，刻意**不用** `NEXT_PUBLIC_*`：那类变量在 build 期被内联进浏览器包，原 `/api/dev/setup` 的 `NEXT_PUBLIC_DEV_MODE` 门禁其实是个发给所有浏览器的构建产物）、未配置、地址不合法、口令短于 16 位，逐一返回**理由码**（不是值）+ 403/503；原 `process.env.DEV_PASSWORD || "<字面量>"` 这种“看着像配置、其实每个没配的环境都在用 git 历史里那个口令”的写法已删除。(2) `/api/dev/setup` 不再对已存在的身份重设口令 —— 那让一个 bootstrap 端点变成了没有鉴权检查的改密端点。(3) 二十处全部就地打码，每处都写明“打码不等于修复”并指向 preflight §7。(4) 新增 `scripts/check-published-credentials.mjs` 作为**必跑门禁**（`git ls-files` 全量范围、九条规则、只报路径与规则名**从不报值** —— 会打印命中的门禁等于把密钥重新发布到每一次 CI 日志里）。 **顺带纠正一处失实文档**：两份 onboarding guide 写着 Tanya/Ayana 能在“团队”页**看到**所有销售的密码。核对 `src/app/(dashboard)/team/page.tsx`（只有 `type="password"` 输入框与 reset 动作）与 `src/app/api/users/route.ts`，页面既不显示也不存明文，已改为“**重置**”。 验收：`tests/security/dev-identity-bootstrap.test.mjs` 13/13 —— 五种拒绝逐一断言、拒绝理由码里不含 `DEV_PASSWORD`/`DEV_EMAIL` 的值、未配置时两条 route **完全没有触达 Supabase**（记录式 double 清点调用为空）、已存在身份的 update 参数里没有 password 键、Supabase 未配置返 503 而不是把 `!` 断言抛成堆栈；`tests/security/published-credentials.test.mjs` 19/19 —— 用**形状**（无一个真实值）重建每一处真实存在过的发布site并要求判红，其中四条是本门禁早期版本真的漏过的缺陷（CJK 标签无 ASCII 词边界、反引号包裹的值被当占位符、只看标签后**第一个 token** 否则 `Password: <值>（首次登录后修改）` 会被当成句子、命令行 `--password <值>` 根本没有标签），另一半要求 `| Check | PASS |`、`| Key | Value |`、路由清单里写着 `password` 的单元格保持干净（第一版就是被这些淹了 39 条噪声）；CI 契约由 `tests/release/ci-full-stack-gates-contract.test.mjs` 守住门禁 + 反向回归两步都在 `validate` job 内，并断言 finding 对象**没有能装值的字段**。 **Batch 0（管理层复审后的第二轮）**：复审指出这道门禁是假绿的。核对成立，而且比复审说的更宽 —— 假绿有三个彼此独立的成因。(a) 门禁的 `SKIP_PREFIX` 把 `.next.backup/` 整个目录排除在扫描之外，而那里躺着 **1634 个被 git 跟踪的构建产物**，其中两份 `.js.map` 的 `sourcesContent` 里仍带着 `/api/dev/setup` 早就删掉的那个明文口令 —— 源码改了，快照没改，生成物是一份更旧的源码的切片。(b) sourcemap 里每个引号都是 JSON 转义的，任何面向源码的正则都匹配不过转义，因此 `.map`/`.json` 现在先解转义、再按真实行号判定。(c) `OC-MIGRATION-BRIEF.md` 是**带行号栏**保存的（每行以自己的行号加一个竖线开头），于是没有任何一行以竖线开头，这个文件在门禁眼里既没有表格行、也没有表头，更没有口令列。(a) 的根因在 `.gitignore`：它写的是 `.next.backup.*`（带点），永远匹配不到目录 `.next.backup/` —— 少一个斜杠，就把一次构建备份提交进了仓库。已修：扫描范围改成**恰好等于 `git ls-files`，不再排除任何东西**（978 个跟踪文件、17.9MB，其中 9 个含 NUL 的按二进制跳过并计数；`logs/pm2-*.log` 这 5.5MB 生产日志也是第一次被扫到），1634 个产物 `git rm --cached` 移出索引并补上 `.gitignore` 的斜杠，“**跟踪了构建产物**”本身成为一条结构性 finding（不读一个字节就能报），规则五条增到九条（新增 `credential-pair`、`credential-in-url`、`credential-property`、`tracked-build-output`），测试 11 条增到 19 条，并给行号栏与 JSON 转义各配**一个变异对照** —— 把被替换掉的那个旧判定原地重写一份，断言它在同一夹具上返回 `[]`；否则哪天夹具失效，测试会静默变成永真。范围一改，又多出四处**非生成物**的发布：`test-matrix-runner.mjs:10-12`、`test-matrix.md:4-6`、`test_matrix.py:29,49-52`、`OC-MIGRATION-BRIEF.md:53-54`。它们带出**第八个身份 `admin@newme.ae`**，并且 tanya/faheem/mohamed 三个身份**各有不止一个已发布的值**，所以轮换要按身份算、不按值算。`test_matrix.py` 另外把一条完整的 Supabase PAT 提权配方写在可执行位置上，**PAT 轮换因此成为一项新增的未授权生产动作**。另有一条只有对着 commit 跑才暴露的事：门禁读的是 `git ls-files`，而新写的 `tests/security/dev-identity-bootstrap.test.mjs` 当时还没被跟踪，所以工作区里那个 OK **根本没扫到它** —— 对着提交后的树再跑，它自己的两处夹具立刻判红。方向是对的（CI 读的是提交，提交才是“已发布”），但**本地一次 OK 只覆盖 git 已经跟踪的东西**。两处夹具按标识符加进 ALLOWLIST 并写明理由，同时新增一条测试：ALLOWLIST 里每个路径都必须仍被 git 跟踪、每条都必须有理由 —— 豁免活得比文件久，是门禁悄悄失效的典型方式。最后一句必须写清楚：`git rm --cached` 只是让它停止被跟踪，**不是抹除**，这 1634 个文件仍然在 git 历史里。 **未关闭（生产动作，均需单独授权）**：§7.2 生产数据库口令轮换（第一优先，验证方式是拿轮换后的凭据跑 §2.5 的 `verify-remote-migration-history.mjs` 要 `OK` —— 只读迁移元数据，任何日志里都不会出现密钥）、§7.1 六个员工口令轮换（经应用重置路径即可连带吊销会话，见 `PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION`）、§4 Auth 封禁与会话吊销、Supabase PAT 轮换（`test_matrix.py` 已把提权配方发布出去）、仓库转 private、git 历史清除。**这二十处已发布的值必须一律视为“任何 clone 过本仓、或读过本仓任一次构建产物的人都已知”，把它从工作区删掉与让它停止生效是两件事，本次发布不得把前者说成后者。** | ⚠️ | 待轮换+封禁（生产动作未授权） |
| PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION | src/app/api/users/[id]/password/route.ts, src/app/actions/team.ts, supabase/migrations/20260817120000_admin_reset_session_revocation.sql, supabase/replay/00_platform_bootstrap.sql, scripts/gotrue-revocation-drill.sh, tests/security/admin-reset-session-revocation.test.mjs | CREATE+MODIFY | 四审 A3。**本行原先的说法“refresh token 只能由 GoTrue 吊销、数据库层无法关闭”已被实测推翻，特此撤回**：`auth.sessions` 与 `auth.refresh_tokens` 就是普通表，删掉某身份的 session 行会连带带走它的 refresh token。本轮把这件事做成**可验证的后置条件**而不是继承来的副作用：新增 `public.revoke_user_sessions(uuid, text)`（SECURITY DEFINER、pinned search_path、definer 入口断言、`revoke all … from public, anon, authenticated` 后只 `grant execute … to service_role`），它先删两张表的目标行、**再回查确认为 0**，写服务端自有审计行，否则 raise；两条管理员重置路径（route PATCH 与 server action `resetUserPassword`）按 password → `password_changed_at`+`force_password_change` → RPC 顺序调用，且**只有 `verified: true` 才算成功**（未装/无权/返回 null/形状不符 → 502 或 throw，profiles 写失败则根本不调 RPC 并回报“对方仍处于登录状态”）。证据：replay 17 条 `a3-*` 断言在 branch 模式全 `ASSERT_OK`、在 control 模式对未修复地板全部 `ASSERT_FAIL`（`control marker accounting OK: 323 assertions, 265 load-bearing, 0 unclassified SQL errors`）；`tests/security/admin-reset-session-revocation.test.mjs` 13/13，含两条 mutation 测试（删掉 fail-closed 守卫或删掉 RPC 调用后结果必须翻转）；GoTrue 侧行为由 `scripts/gotrue-revocation-drill.sh`（v2.195.0 + supabase/postgres 17.6.1.158，一次性容器、每次运行独立随机口令、身份全为 `@drill.invalid`）实测：admin 改密本身已使 sessions 1→0，重置前的 refresh token 返回 400 `refresh_token_not_found` 且换不出新 access token；单独删 session 行同样使 refresh token 1→0 并杀掉三个并发会话的全部 token；新口令登录 200、旧口令 400。**残留（已在制品中写明）**：已签发的 access token 对 GoTrue 是 403，但对 PostgREST 仍在有效期内可用 —— 由 `20260813000000` 的 `session_token_is_current()` 限制性策略以 `iat` 对比 `profiles.password_changed_at` 覆盖；生产 GoTrue 版本刻意未读取；生产 DELETE 权限无法在离线夹具中证明，故在迁移 apply 时断言 | ⚠️ | 待部署 |
| PROD-FORCED-PASSWORD-CHANGE-SERVER-ENFORCEMENT | src/lib/forced-password-change.mjs, src/proxy.ts, src/lib/request-auth-context.ts, tests/security/forced-password-change-boundary.test.mjs | CREATE+MODIFY | 四审 A2：`profiles.force_password_change` 此前只是**客户端约定** —— 由 admin 重置路径写入、由 `/api/auth/login` 返回、由浏览器自行跳 `/change-password`；服务端无任何一处读它。忽略跳转（或根本不跑页面、只持 token）的调用方可达全部已认证路由，**包括 service-role 的重置密码路径**。本轮把该标志变成服务端边界：唯一豁免清单放在 `src/lib/forced-password-change.mjs`（3 个 API + 2 个页面：改密、看自己、走人），由两处强制点共同消费 —— 边缘 `src/proxy.ts`（API 返 403 `password_change_required`，页面跳 `/change-password?reason=…`，cookie 与 Bearer 两条 profile 读取均补 `force_password_change` 列）与 `getRequestAuthContext()`（新增 403 码；只有显式 `{ allowForcedPasswordChange: true }` 的调用方能退出，当前**无任何 route 使用**）。**顺带修掉一个既有洞**：`/payments`、`/tasks`、`/tasks/[id]`、`/workbench` 四个 `(dashboard)` 页面从不在 `config.matcher` 里，故边缘检查（本轮的强制改密、以及**更早的 `is_active` 吊销边界**）对它们从未运行；server action 以 POST 打到页面自身路径，未列出的页面同时是未检查的 action 入口。验收（行为测试，非源码断言）：`tests/security/forced-password-change-boundary.test.mjs` 9/9 —— 27 条 service-role route 全量清点后**逐条**以 GET+POST 过 proxy 判 403（豁免清单里只允许 `/api/auth/change-password` 一条重叠，且断言 `/api/users/[id]/password` 仍在清点结果内）、cron/webhook 外部入口带 forced cookie 同样被拒、Bearer 路径断言 REST select **确实含**该列、`(dashboard)` 全部页面必须被 matcher 覆盖（此断言即发现上述四页）、`inactive_account` 优先级不被新码掩盖、豁免页面仍可渲染。变异验证四项（禁用 proxy 门禁 / 禁用 context 门禁 / Bearer select 去掉该列 / matcher 去掉 `/tasks/:path*`）各自判红后还原，CRLF 与字节经 `sha256sum` 复核。本地门禁：`typecheck` clean、`lint:baseline` PASS（406，无新增）、`check:supabase-boundaries` PASS（107 findings 未超基线）、`npm test` 590 tests / 587 pass / 0 fail / 3 skipped | ⚠️ | 待部署 |
| PROD-CONTRACT-REVOKE-LIST-DIRECT-WRITE | src/app/(dashboard)/contracts/page.tsx, src/app/actions/contracts.ts, tests/security/contract-revoke-boundary.test.mjs | MODIFY+CREATE | 四审 B1：合同列表页的 Revoke 按钮走 `revokeContract` server action —— 先从 profiles 读角色，再以调用者自己的 client 直写 `update contracts set status='revoking'`；合同详情页走的却是 `POST /api/contracts/[id]/revoke` → `revoke_contract()`。两个入口做的是两件事。隔离 PG17 复现（仅**已提交**迁移 10 个 + `01_floor_schema.sql` + `05_seed_behaviour_fixtures.sql`，以 `authenticated` 并注入 GoTrue 同形 claim，每个子例各用专属 lead/合同以免继承上一例状态）：直写以 **boss** 身份 compat `sqlstate=00000 status→revoking`、strict `42501 未变`；**同一条直写以 sales 身份 compat 下同样 `00000` 且 `status→revoking`** —— admin/boss 规则只活在该 action 的那次 profiles SELECT 里，数据库从未持有它，且直写同时绕过 `revoke_contract()` 的 `for update` 与 `contract_transition_is_allowed()`；`revoke_contract()` 则两模式一致：boss `00000`（`previous_status` active→revoking）、sales `42501`。即该 action 在 strict 下按钮**完全失效**、在 compat 下**授权不足**，同一个根因。修法（最小）：删除 `revokeContract`，列表页改 POST 同一 canonical route，两个入口收敛到同一例程；`approveContract` 本已走 RPC，未动。验收：`tests/security/contract-revoke-boundary.test.mjs` 9/9，检测器先经变异对照（先证它认得被删掉的那条直写、再证它不误伤 5 种合法写法：contracts 只读、leads 状态改写、`contracts.update({sales_id})`、`revoke_contract` RPC、无关 payload 上的 `status:`），然后扫 `src/app/actions` 与 `src/app/(dashboard)` 全量、断言 `revokeContract` 标识符在四个目录中彻底消失（注释经 `code()` 剥离，好让解释性注释仍能保留那条语句原文）、钉住列表页 `res.ok` 分支与 `err.error` 落到 toast、并从迁移正文校验 `guard_contracts_write()` 仍拒绝状态直改、`revoke_contract()` 仍持有 `money_actor(null, array['admin','boss'])`、`for update`、transition 检查与 `previous_status` 回读。**未关闭**：例程随 `20260812000000` 一起等待应用，未应用前两个入口都没有 `revoke_contract` 可调（此依赖非本轮引入，详情页早已如此）；`contracts.sales_id` 的服务角色改派（`src/app/actions/team.ts`）是**另一条**未关闭项，本轮测试刻意不覆盖 | ⚠️ | 待部署 |
| PROD-PAYMENT-RECORD-NO-IDEMPOTENCY-KEY | supabase/migrations/20260813100000_payment_request_key_idempotency.sql, src/lib/payment-idempotency.mjs, src/app/api/payments/route.ts, src/app/(dashboard)/payments/page.tsx, src/app/actions/payments.ts, tests/security/payment-idempotency-boundary.test.mjs | CREATE+MODIFY | 四审 B3：付款页 Record Payment 走 `createPayment` server action，直接 insert `payments`，不带任何幂等键。隔离 PG17 复现（本分支磁盘上 14 个迁移 + `01_floor_schema.sql` + `05_seed_behaviour_fixtures.sql`，以 `authenticated` 注入 GoTrue 同形 claim（缺 `iat` 则 class-28 入口直接失败），sales 身份持有 fixture 合同）：compat 下同一表单提交两次 `sqlstate=00000 rows=2` —— 一次意图两笔钱；strict 下同一条 insert 直接 `22023 a payment must carry request_key`，按钮完全失效。同一枚键重复提交**相同**载荷 `23505 idx_payments_request_key rows=1`；同一枚键改成 99999 金额**同样是 23505**、库内金额仍 4321.00 —— 数据库对「诚实重试」与「键被复用」给出同一个 sqlstate，因此这个判断只能在应用层做，而写错的实现照样能通过任何只读源码的检查。修法（最小）：新增 forward-only 迁移只加 `request_key uuid` 与 `(created_by, request_key)` 部分唯一索引（按 creator 收敛，避免跨用户探测；不含任何 `create or replace function`，以免半份覆盖尚未提交的 round-4 守卫；声明 `NO_ROLLBACK` 并说明理由）；删除 `createPayment`，付款页改 POST `/api/payments`；幂等键在 `openRecordDialog()` **一次意图铸一枚**（铸在提交函数里则每次重试都是新键，等于没修）；路由在 23505 分支回读已存行的全部业务字段与本次请求比对：相同→200 返回首次那一行，不同→409 `IDEMPOTENCY_KEY_REUSED`，读不到→409 `DUPLICATE_REQUEST`。判定逻辑抽进 `src/lib/payment-idempotency.mjs`（沿用 `forced-password-change.mjs` 的 `.mjs`+`.d.mts` 先例），以便被真正执行而不是只被 grep。验收 21/21：检测器先过变异对照（先证它认得被删掉的那条直插、再证它不误伤 5 种合法写法），并断言全 `src/` 仅 canonical route 一处插入 payments、`createPayment` 标识符彻底消失、键在 `openRecordDialog` 铸造且 `handleRecordPayment` 内不含 randomUUID、金额以最小货币单位整数比对（0.1+0.2 视同 0.3，避免把诚实重试判成复用）、`""` 与 null 视同、非有限金额永不相等、只有 request_key 冲突才算键已用尽、录入角色与结算角色仍是两张互不混用的表。**未关闭**：strict 下「每笔付款都必须带键」的守卫在尚未提交的 round-4 迁移里，本轮只让真实 UI 提前合规并关闭重复入账；`created_by` 伪造在 compat 下仍返回 `00000`（strict 为 `42501`），属另一条；付款读模型与 void 状态（B8）本轮刻意未动 | ⚠️ | 待部署 |
| PROD-DEPLOY-TASKBOARD-GATE-MISSING | infra/systemd/newme-deploy.sh, infra/release/required-jobs.json, scripts/verify-remote-migration-history.mjs | MODIFY+CREATE | AGENTS.md 声称 “`scripts/deploy.sh` Step 0 运行 `check-taskboard.sh`，任一 ❌ 即中止部署”，而三审前无任何部署路径调用它。canonical wrapper 现按序硬门禁三件事：(1) 逐 job 读 `/actions/runs/{id}/jobs` 的 `conclusion`（run 级 `success` 会把被 skip 的必需 job 记成绿），要求 `infra/release/required-jobs.json` 每个 job 都 `success` —— 其中 `Release-final taskboard completion` 只可能出现在 `release_final=true` 的 dispatch run 里（`workflow_dispatch` 的 inputs 不由 runs API 暴露，该 job 存在与否是唯一可得的证明，也正是"被接受的 push run 结构上不可能包含 release-final"这一缺陷的修法）；(2) `check-taskboard.mjs --require-complete`（newme-deploy.sh:597）；(3) `verify-remote-migration-history.mjs`（newme-deploy.sh:623）。验收：tests/release/deploy-release-claim-validation.test.mjs 16/16 + remote-migration-history.test.mjs 12/12，**直接执行**被抽出的 shell 函数与内联校验块。**按设计**：本分支当前必然在 (2) 处 exit —— 生产专属门禁未关闭即不得部署。**新增运维前置条件**：root 拥有的 `/etc/newme/migration-db.url`（0400/0600）与 root PATH 上的 `node`，缺失即 exit 65 | ⚠️ | 待部署 |
| PROD-MIGRATION-HISTORY-IMMUTABILITY-GATE | scripts/check-migration-history.mjs, supabase/migration-history-baseline.sha256, scripts/regenerate-history-baseline.sh, tests/release/migration-history-gate.test.mjs | CREATE | 三审否决"重写已应用迁移"后新增的防复发门禁：以 sha256 清单核对 103 个既有迁移文件字节未变，并与 PR base `81956f2ff3bf` 的 git blob 逐一比对；改名、改字节、删除任一即红。新增迁移只能排在历史末尾（forward-only）。基线只能由 `regenerate-history-baseline.sh` 在显式说明理由的 commit 里重生成。验收：`node scripts/check-migration-history.mjs` → `103 listed, 103 verified unchanged` / `8 new` / `manifest vs git: verified against 81956f2ff3bf` / `OK` | ⚠️ | 待部署 |
| PROD-CONTRACT-STATUS-PATCH-ROUTE | src/app/api/contracts/[id]/route.ts, src/app/(dashboard)/contracts/[id]/page.tsx, src/lib/i18n/translations.ts | MODIFY | 合同详情页自诞生起就在 `PATCH /api/contracts/[id]`，而该模块只导出 `GET` —— **该页每个状态按钮一直是 405，状态变更从未生效过**。修法不是补一个写 `body.status` 的 handler：那会把九宫格变成审批链旁路（`approved`/`pending_ceo` 曾在按钮里）。现由 `set_contract_status()` 按转移表决定，越界 400；页面改为按当前状态渲染 `STATUS_TRANSITIONS[status]`，`terminated` 强制填原因。验收：money-route-rpc-coupling.test.mjs 断言 PATCH 导出存在、handler 不把请求状态写进行更新、UI 转移表与例程转移表**双向相等**、审批链状态不在网格里 | ⚠️ | 待部署 + 待 UAT |
| PROD-ROLLBACK-SECURITY-PRESERVING | supabase/migrations/rollback_l0_20260811.sql, supabase/replay/20_assert_post_rollback.sql | MODIFY+CREATE | 三审确认上一版的回滚测试"只证明 SQL 能执行"，且回滚会把安全边界一并撤掉。现回滚只撤业务姿态、不撤安全边界，并由 30 条 post-rollback 断言在 `MODE=branch` 里**执行**验证：回滚后伪造 `audit_logs`/`user_sessions` 插入仍被拒、`meta_tokens` 不回到 `authenticated` 可读、资金 definer 例程的 `anon` EXECUTE 不回来。验收：tests/release/production-rollback-controller.test.mjs + replay 30/30 | ⚠️ | 待部署 |
| PROD-MIGRATION-HISTORY-CONTENT-RECONCILIATION | scripts/verify-remote-migration-history.mjs, scripts/capture-remote-migration-history.mjs, supabase/migration-history-reconciliation.json, supabase/preflight/migration-history-reconciliation.md | MODIFY+CREATE | 四审 P1-11：远端历史门禁只读 `version,name`，而生产表是 `supabase_migrations.schema_migrations(version, statements text[], name)` —— 同名同版本、SQL 被换掉的行照样通过，且复审实测**七行 `statements` 为空**（历史里根本没有记录执行过什么）。`103/103` 只证明本仓库的既有迁移与 PR base 字节相同，那是关于仓库的陈述，不是关于生产的。现门禁改为每行读四项（`version` / `name` / `coalesce(array_length(statements,1),0)` / **服务端** `encode(sha256(convert_to(count \|\| ' ' \|\| array_to_string(statements,' '))),'hex')`），语句正文不过网、不落盘、不入日志；`HISTORY_QUERY` 由采集与比对**共用同一导出常量**，二者不可能漂移。fail-closed 面：不可读的 `statements` 列、0 语句行、基线缺行、生产缺基线行、count/指纹漂移、基线被采集后手改（digest）、有 rows 无 capture、以及**任何没人写下来的差异**与**任何已不再匹配的 acceptance**，均为拒绝而非告警；只有五类可被 `accepted[]` 显式解释（`non_cli_version` / `remote_only` / `name_mismatch` / `local_absent_remote_before_newest` / `no_statements`），claim 类失败（`applied_verified`、"本次无需迁移"）、重复版本、基线篡改、内容漂移一律不可被解释。验收（真实 Postgres 17，非 mock）：按复审实测形状播种后门禁报 **25 个问题**（复审的 18 个结构差异 + 7 个未记录内容行）；修掉仓库侧差异并写入 11 条带 `why`/`evidence` 的 acceptance 后 exit 0 并逐条打印；五次真实篡改各自被拒（同名同 count 改写内容、采集后手改基线行、过期 acceptance、试图解释假的 `applied_verified`、`drop column statements`）；JS 与 SQL 双侧指纹对 7 个向量（unicode / 内嵌引号 / 空数组 / 空元素 / 换行 / 制表符）逐字节一致；采集产物经检查不含任何语句正文。tests/release/remote-migration-history-reconciliation.test.mjs 16/16 + remote-migration-history.test.mjs 12/12。**仓库内提交的 fixture 是未采集的空基线且测试断言它不改变任何判定** —— 因此部署门禁在生产只读采集完成前一直拒绝。关闭条件：单独授权的生产只读采集 + 差异逐条落地 + 门禁 exit 0 的现场证据 | ❌ | — |
| PROD-CONTROL-PLANE-BOOTSTRAP | scripts/verify-deploy-gate-record.mjs, scripts/install-systemd-assets.sh, infra/systemd/newme-deploy.sh, infra/release/control-plane-bootstrap.md | CREATE+MODIFY | 四审 P1-10：生产 `/usr/local/sbin/newme-deploy` 仍是 `f37c203` 那版（`git show f37c203:infra/systemd/newme-deploy.sh` 第 480 行只传 `NEWME_ASSET_BACKUP_RECORD`），它不设 `CI_EVENT`、不跑 taskboard/远端历史/逐 job 门禁，却会调用候选 release 的 `install-systemd-assets.sh` 去替换**整个控制面**——即"第一次部署把新门禁装上去"这件事本身没有被任何新门禁把关；且控制面当时在备份存在**之前**安装、又不在备份集里，装完无法回退（"forward-only"是缺回滚的描述，不是可取的性质）。两侧同时修：(1) 门禁不能只写在 wrapper 里（跑 bootstrap 的正是旧 wrapper），因此**由 installer 自己索要证据**——`install-systemd-assets.sh` 在校验 `$STATE_ROOT` 之后、在会重启服务的未决事务恢复之前、在任何写动作之前，要求 `NEWME_DEPLOY_GATE_RECORD` 并交由 `verify-deploy-gate-record.mjs` 判定：必须绑定 installer 自己算出的 `SOURCE_SHA`、`event=workflow_dispatch`、数字 run id、四个 gate 名一个不少一个不多不重复、900 秒新鲜、root:root 0600 且位于 root 拥有的 0700 目录内的正规文件（非符号链接）。缺失即 exit 78。(2) `CONTROL_PLANE[]`（两个 libexec 脚本、`newme-service-control`、`newme-production-rollback`、`newme-deploy`、`/etc/sudoers.d/newme-platform`、`/etc/sudoers.d/ubuntu-nopasswd`）并入 `remember` 集合，且六处 `install_control_*` 与 `rm -f -- /etc/sudoers.d/ubuntu-nopasswd` 全部移到失败 trap 与两个恢复指针**之后**——`rollback-systemd-assets.sh` 按 `managed.list` 泛型遍历，故它无需任何改动即可还原旧控制面。验收（真实 Linux 容器 root 下**执行** installer，非源码断言）：`f37c203` 的确切环境契约（只有 `NEWME_ASSET_BACKUP_RECORD`）→ exit 78 且 `/etc`+`/usr/local`+`/opt`+`/var/backups`+`/var/lib/newme` 的清单哈希在四次拒绝前后**逐字节相同**；异 SHA 记录 → 78；缺一个 gate → 78；记录在保护目录外 → 64；过期 20 分钟 → 78；符号链接 → 78；0644 → 78；同时摆好 `production-rollback.pending` + `systemd-assets.pending` 再以无记录运行 → 得到 **78（门禁）而非 75（未决事务）**，即门禁在运行时确实早于会重启服务的恢复分支；正控制：合法新鲜 0600 记录 → 门禁打印 `4 required gate(s) accounted for at <sha>` 后继续（证明拒绝不是无条件的）。tests/release/control-plane-bootstrap-contract.test.mjs 21/21（其中 12 条以进程方式执行门禁）。**本轮自查到一个假绿并已修**：首版测试的"接受路径"断言在 Windows 上 20/20 通过，只是因为 Windows 下 Node 对任何文件都报 `uid/gid=0` 与合成 mode，该断言在本机是空断言；exact-head CI（Linux、非 root `runner`、umask 0022）如实判红。修法不是放宽门禁，而是把归属/权限判定提成纯函数 `checkOwnership()` 并把测试拆成两半：内容半边以进程方式跑门禁并要求**除主机权限三条之外没有任何其它拒绝理由**（`assert.deepEqual` 精确比对，门禁若被削弱则该断言反向失败），权限半边用真实部署主机会产生的 stat 结构直接断言 root:root 0600 in 0700 通过、1001:1001 0644 给出三条、0640 给出 mode 一条、目录缺失给出 missing 一条。端到端接受路径仍以容器内 root 身份执行验证。重构后重跑全部控制矩阵：root 下 0600-in-0700 → exit 0；0640 → 1 条 mode 拒绝；目录 0755 → 1 条目录拒绝；记录属 1001 → 1 条归属拒绝；无记录 → "there is no gate record"；installer 层 78/78/64 且主机清单前后同哈希。同一文件以非 root Linux 用户重跑，先前失败的两条现为 `ok 1` 与 `ok 5`。关闭条件：单独授权的生产 bootstrap 执行（按 `infra/release/control-plane-bootstrap.md`：先对当前 live release 取 snapshot，再由操作者手写一次性 gate record 从镜像 worktree 安装候选控制面，随后验证或还原），且它本身依赖 PROD-MIGRATION-HISTORY-CONTENT-RECONCILIATION 先完成 | ❌ | — |
| PROD-MAIN-BRANCH-PROTECTION-UNENFORCED | infra/release/branch-protection.json, tests/release/branch-protection-contract.test.mjs | CREATE | 四审 P1-13：`main` 实测**没有** required status checks、没有 required PR reviews、也没有 ruleset —— PR 处于 Draft 只挡住 merge 按钮，不挡 push，故本轮所有 CI 证据在合入路径上都不是强制的。本轮只能交付代码侧：把缺失的保护逐字段写成 `infra/release/branch-protection.json`（四个 pull_request 可达 job 作为 contexts、`strict`、`enforce_admins`、1 个 approving review + dismiss stale、linear history、禁 force push/删除、要求会话解决），并写明三个**故意不要求**的 context 及理由（`test` 是 `echo ok` 的空绿；`Release-final taskboard completion` 只可能出现在 dispatch run，列入 contexts 会永久死锁每个 PR；`Hermes CI webhook contract` 由 `workflow_run` 产生默认分支的 check run，永远无法满足 PR 规则）。与 `required-jobs.json` 的关系被断言为**真子集**关系（部署侧多一个 release-final job，PR 侧不可有）。`tests/release/branch-protection-contract.test.mjs` 另断言仓库内**没有任何脚本会去写这个保护** —— 写分支保护是 GitHub 控制面变更，需管理员 token，超出本代码轮的授权。关闭条件：单独授权的操作者应用该文件，并以 `gh api /repos/{owner}/{repo}/branches/main/protection` 的实际输出（同四个 context、`strict=true`、`enforce_admins=true`、`required_approving_review_count=1`）为现场证据 | ❌ | — |
| PROD-PROXY-ACTIVITY-THROTTLE-UNBOUNDED | src/proxy.ts | TODO | 信息性：`activityThrottle` 是以 user id 为键、永不淘汰的 `Map`，随累计活跃用户数单调增长（每条目约几十字节，非攻击者可控放大，故非 P0/P1）。与限流器同类问题，应改为固定槽位或带 TTL 的结构 | ⏳ | — |
| PROD-L0-ROUND4-ENTRY-BOUNDARY-AND-MONEY-INTEGRITY | supabase/migrations/20260816000000_l0_round4_definer_entry_boundary.sql, supabase/migrations/20260817000000_l0_round4_money_and_business_integrity.sql, supabase/migrations/20260818000000_money_direct_write_contract_phase.sql, infra/release/release-manifest.json, scripts/db-phase-push.mjs, scripts/check-release-manifest.mjs, scripts/phase-tool-drill.sh, tests/release/release-phase-manifest.test.mjs | CREATE+MODIFY | 四审 A1 + B2–B7 + B10 的数据库侧，已提交 `78d13f4364b`。`20260816000000` 把会话断言放到每个 authenticated SECURITY DEFINER 例程的**入口**（停用/封禁/强制改密/过期 token 在第一条语句前即被拒），并从 end-user 角色收回触发器函数的 EXECUTE；`20260817000000` 拒掉会腐蚀账本的写入（负数与重复付款、与合同金额不符的分期、会把报价挂到别人合同上的转换重试、无客户无业务事件的 won lead、被目标编辑删掉或记到错人头上的 KPI 实收）；`20260818000000` 由 `20260815000000` 改名而来，仍排在最后，是 contract 相位与回滚边界（唯一保留回滚伴随文件的一个）。相位工具：`infra/release/release-manifest.json` 为逐文件内容哈希（sha256，CRLF 归一）的精确迁移集，`scripts/db-phase-push.mjs` 只应用一个具名相位，`scripts/check-release-manifest.mjs` 维持清单 == 目录（现 required_for_app 17 / deferred_contract 1 / 目录待应用 18）。`scripts/phase-tool-drill.sh` 九步实测（PG 17.10、两个一次性库、5 次拒绝、18 个迁移分两相位应用）—— **本轮修掉该 drill 自身的两处失真**：中断步骤把"第 12 个迁移 / 11 个已应用"写成常量，`20260813100000` 进入发布集后即已过期（该 drill 在 `78d13f4364b` 未重跑，提交信息也未声称它绿）；证物列 `payments.request_key` 由更早的 `20260813100000` 合法创建，它存在与否证明不了回滚。现改为从清单派生（`BREAK_FILE` 的位次与前一版本号）并以只有该文件创建的 `payments.credited_to` + `payments_amount_positive` 作证物，实测 `12 applied through 20260816000000` → 绿 | ⚠️ | 待部署 |
| PROD-FIRST-PAYMENT-STATUS-LITERAL-SEQ-ONE | supabase/migrations/20260817000000_l0_round4_money_and_business_integrity.sql, supabase/replay/10_assert_release_contracts.sql, tests/security/first-payment-derivation-boundary.test.mjs | MODIFY | 四审 B2 复审残留（独立复审在 `78d13f4364b` 的同一文件里找到、当时**未修**、本轮修）：`contract_first_payment_status()` 用字面量 `seq = 1` 取首期，而校验函数只要求 seq 正整数且不重复 —— 于是编号为 2,3 的分期（`20260817140000` 之前被接受、且生产已可持有此形状的行）在首期已确认并全额分配后仍读 `unpaid`，计划行读 `paid`，此后任何确认或作废都无法把它推回来；存储列与派生逻辑给出同一个错答案，表级对账不变式因此也看不见。改为 `order by seq asc, created_at asc, id asc limit 1`（取**存在的最小 seq**，不是字面 1）。验收：replay `b2-first-payment-status-reads-the-lowest-seq-not-literally-one`（以迁移角色把夹具计划改为 seq 2 —— `20260817140000` 之后 `create_contract()` 已造不出这形状 —— 再确认并分配 40000，断言 `first_payment_status='paid'`；control 模式对未修复地板判红，非空断言）+ `tests/security/first-payment-derivation-boundary.test.mjs` 8/8 | ⚠️ | 待部署 |
| PROD-INSTALLMENT-SCHEDULE-NONCONTIGUOUS | supabase/migrations/20260817140000_l0_round4_installment_sequence_contiguity.sql, src/app/api/contracts/route.ts, supabase/replay/10_assert_release_contracts.sql, tests/security/installment-schedule-contiguity.test.mjs | CREATE+MODIFY | 四审 B4 复审残留（同上，本轮修）：`assert_installment_schedule()` 只查"总额相等 + seq 为正 + 不重复"，`[{seq:1,30000},{seq:3,70000}]` 对一份 100000.00 的合同在**两种 release 模式下都被接受** —— 金额恰好对上、每个 seq 都正且只用一次 —— 产出的合同第二期并不存在，而下游没有任何读者能把它和一份两期合同区分开；单独一条 seq=2 的分期同样被接受，那份合同对每个要"首期"的读者都报告没有首期，即 B2 的隐患从正门进来。本轮把连续性做成校验的一部分：`max(seq) = count(*)` 不成立即 22023，消息给出实际编号（`the installment schedule must be numbered 1..2 with no gaps, but it is numbered 1,3`）。route 侧在 `src/app/api/contracts/route.ts` 同步一份镜像规则，使 400 与数据库的 22023 一致而不是把它变成 500。文件版本号 `20260817140000` 刻意排在 contract 相位 `20260818000000` 之前（expand 相位必须是待应用集的连续前缀，由 `tests/release/expand-contract-rollback-contract.test.mjs` 强制）。验收：replay `b4-a-schedule-with-a-gap-is-refused` / `b4-a-schedule-that-does-not-start-at-one-is-refused`（两条都额外断言 `contracts` 计数为 0，避免"拒绝了但半条写入还在"）+ `tests/security/installment-schedule-contiguity.test.mjs` 8/8 | ⚠️ | 待部署 |
| PROD-CONVERSION-RETRY-DOUBLE-COUNTS-AMOUNT | supabase/migrations/20260817130000_b5_conversion_retry_idempotence.sql, supabase/replay/10_assert_release_contracts.sql, tests/security/quotation-conversion-retry-idempotence.test.mjs | CREATE | 四审 B5 复审残留（同上，本轮修）：`convert_quotation_to_contract()` 的幂等分支认出"这份报价已经转过"并返回既有合同，但**在返回前又跑了一遍记账副作用** —— `customers.total_contract_amount` 因此按重试次数累加，客户额度与看板金额随网络重试而虚增；同一分支对"重试时带了另一套分期"不作声，静默按首次的结果返回。本轮把幂等分支收敛为真正的幂等：既有合同直接返回、不再加金额，且重试携带的分期若与既存合同不一致则以 22023 拒绝（而不是假装成功）。`NO_ROLLBACK` 已声明并写明回退后会恢复的状态。验收：replay `b5-a-conversion-retry-does-not-add-the-amount-again` / `b5-a-retry-asking-for-a-different-schedule-is-refused`（control 模式两条均对未修复地板判红）+ `tests/security/quotation-conversion-retry-idempotence.test.mjs` 5/5。**残留（未关闭，已写入制品注释）**：记账现在是"每个 lead-won 一次"，而 `customers.total_contract_amount` 没有任何对账作业能从 `contracts` 重算 —— 生产库里此前由重试累加出的偏差不会被本迁移修正，需一次性核对（属生产授权动作，本轮不做） | ⚠️ | 待部署 |
| PROD-KPI-PERIOD-DELETE-BYPASSES-ROUTINE | supabase/migrations/20260817150000_kpi_period_clear_owns_the_delete.sql, src/app/api/kpi/targets/route.ts, src/types/database.ts, supabase/replay/10_assert_release_contracts.sql, tests/security/kpi-actuals-boundary.test.mjs | CREATE+MODIFY | 四审 B7 复审残留（同上，本轮修）：`20260817000000` §14 只关了 **SAVE** 路径（`replace_kpi_targets()` 结转 actual_amount，丢弃仍持实收的配对即 22023），而 `src/app/api/kpi/targets/route.ts` 的 DELETE 仍以 service-role 客户端直打表：`delete().eq("period", period)`。PG 17.10 + 地板 + 全部分支迁移 + 夹具，两种模式实测同一条语句的三重后果 ——（1）删掉 2 行并带走 700.00 已收金额，无任何守卫（`actual sum 700.00 -> 0`），而没有任何作业能从 `payments` 重算回来；（2）不取周期锁：在一个未提交的 service-role DELETE 进行中，第二连接对同一 `hashtextextended('public.kpi_targets:'||period,0)` 键的 `pg_try_advisory_xact_lock` 返回 TRUE、`pg_locks` 上该键零条 advisory 锁，即 `replace_kpi_targets()` 声称的串行化根本不覆盖删除路径；（3）绕过 RLS，于是 route 自己的角色表就是全部授权 —— 当时是 admin/boss/operator，而生产 DELETE 策略（`20260701000000_non_core_tables_rls_fix.sql:227`）是 admin/boss，operator 的同一条语句被数据库拒绝、被 route 接受（与 B1 同形）。本轮新增 `public.clear_kpi_targets(p_period text, p_actor uuid) returns bigint`（SECURITY DEFINER、pinned search_path、首条语句 `assert_current_session_at_entry()`、取与保存路径**同一把** advisory 锁、锁内读计数后若有非零 actual_amount 即 22023 并给出与保存路径同形的消息、写 `KPI_PERIOD_CLEARED` 审计行且 `actor_id` 留空而把 claimed actor 放进 details、`revoke all … from public, anon, authenticated` 后只 `grant execute … to service_role`），route 改为 `rpc("clear_kpi_targets")` 并把角色表收敛到 admin/boss。验收：replay `b7-clearing-a-period-that-holds-collections-is-refused`（断言 2 行仍在、实收仍为 777.00）/ `b7-clearing-a-period-that-holds-nothing-is-still-allowed`（正控制：否则"拒绝一切"的例程也能满足上一条）/ `b7-the-period-clear-routine-is-service-role-only`（走 `pg_proc` + `has_function_privilege` 目录判定，并刻意写成"函数不存在时判红"而非空过）+ `tests/security/kpi-actuals-boundary.test.mjs` 12/12。**残留（未关闭）**：没有任何作业能从 `payments` 重算 `kpi_targets.actual_amount`，历史上被直接 DELETE 清掉的实收无法自动恢复；`supabase/replay/01_floor_schema.sql:728` 的地板 `kpi_targets` 上没有任何 RLS 策略，故"策略级"断言在 replay 中会空过 —— 上述第三条断言因此改用目录授权判定 | ⚠️ | 待部署 |

> **复审逐条结论（confirmed / refuted / insufficient）**：F-09 资金授权 leg-2 会造成停摆 → **confirmed**（已删除该 leg）；F-02 删除不可逆且毁证据 → **confirmed**（改停用 + 互锁 + 可回滚）；F-06 profile-email/改密接管链 → **confirmed**（列级 grant + 改密只用 `user.email`）；F-08 审计/会话可伪造插入 → **confirmed**（三表 `with check (false)` + 移除 proxy 的 PAGE_VISIT 调用者写入）；F-10 Meta token 明文可读 → **confirmed**（drop policy + revoke `anon`/`authenticated`，`service_role` 保留）；限流器可被冲刷 → **confirmed**；开放重定向 + 脚本可读 token → **confirmed**；旧 token 吊销缺口 → **confirmed**；KPI delete-then-insert 数据丢失 → **confirmed**；COS 脚本 release 漂移 → **confirmed**；Hermes CI 不可达 → **confirmed**；迁移未被 CI 演练 → **confirmed**（且更严重：整个历史不可重放）；canonical deploy 接受不完整/错误 event 的声明 → **partially refuted**：`infra/systemd/newme-deploy.sh` 确实查了 GitHub API（复审说“完全不查”不成立），但它漏了 `event`/`head_branch`，且 `scripts/deploy.sh` → `deploy-immutable.sh` 这条路径当时确实零校验 —— 两处均已修。
>
> **insufficient evidence（无线上通道，未确认也未否认）**：五个 L0 迁移是否已被他人手工应用于生产；生产 `pg_policies`/`information_schema.role_table_grants` 的当前真实姿态是否与 `docs/rls-explorer.md` 一致；`20260723130000_lock_definer_boundaries.sql` 是否已在生产生效（源码显示它应已关闭三表 INSERT，但 rls-explorer 显示宽松 policy 仍在——二者矛盾，需线上核对）。

> **三审（2026-08-11）逐条处置**：迁移历史重写 → **已撤销**（逐字节还原 + 新增不可变门禁）；replay job false-green → **已修**（三模式全门禁，history 以期望文件钉死）；资金例程信任调用方 id → **已修**（`money_actor` 取 JWT subject + 五个 INVOKER 触发器）；报价转换/合同创建多事务 → **已修**（单事务 definer 例程）；审批链读最早 pending 行 → **已修**（步骤由合同状态推导）；UI 调用缺失的 PATCH 路由 → **已修**（新增 PATCH + 转移表双向相等断言）；付款分配未绑定合同 → **已修**（跨合同 42501）；KPI 缺周期串行化 → **已修**；直连 JWT 吊销边界 → **部分**（数据库侧已做，refresh token 只能由 GoTrue 吊销）；canonical deploy 只看 run 不看 job → **已修**（逐 job + taskboard + 远端迁移历史）；回滚只证明 SQL 可执行 → **已修**（30 条 post-rollback 安全断言）；Hermes 投递 `continue-on-error` → **已修**；F-02 声称凭据已死 → **已撤回该说法**，F-02 保持未关闭。
>
> **仍需生产授权的动作（本轮一律未执行）**：应用 9 个待应用迁移（`20260813000000` 另需对 `auth.users` 的 SELECT；按 `supabase/preflight/expand-contract-rollback.md` 的 expand/contract 分期）；封禁 `dev@newme.ae` 的 Auth 身份并吊销会话；凭证轮换；仓库转 private；git 历史清除；origin 防火墙限定 Cloudflare 段；`/etc/newme/migration-db.url` 落地；**生产迁移历史的只读采集与逐条对账**（`supabase/preflight/migration-history-reconciliation.md`，未做则部署门禁按设计拒绝）；**控制面 bootstrap 的一次性执行**（`infra/release/control-plane-bootstrap.md`，依赖前一项先完成）。

> **四审（e40 round 3）本轮代码侧处置**：P1-11 远端历史只读 `version,name` 且七行无 statements → **已修**（服务端指纹 + 只读基线 + 显式对账表 + 未采集即拒绝，真实 Postgres 25 问题 / 5 次篡改各自被拒）；P1-10 生产仍是 `f37c203` wrapper 且控制面不可回退 → **已修代码侧**（installer 自索 gate record，真实容器里 `f37` 契约 exit 78 且主机清单零变化；控制面并入备份集并移入事务内）。两项的**生产动作均未执行**，见上一段。
>
> **仍需登录态 UAT**：`on_lead_won()` 由 active 改 draft 后的 lead→合同链；合同详情页状态按钮（此前一直 405）；报价转换 + 两步审批；付款分配；KPI 周期替换（遗留重复键的前置检查会按设计中止部署）。

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
