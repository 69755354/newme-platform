# TASKBOARD.md — Machine-Verifiable Task Tracking (本地工具脚本真相源)
# Last updated: 2026-07-19
# Format: Frozen v2 (MoA签发版) — 4状态模型

## 活动任务 — WhatsApp coexistence pilot (2026-10-19)

| ID | Status | Scope | Evidence |
|---|---|---|---|
| WA-PILOT-1 | DONE | Local draft: opt-in intake/follow-up metadata ingestion and management view; no production rollout | 2026-10-19: typecheck, lint baseline, webhook/auth tests, isolated PostgreSQL session/grant/replay controls; verified official CI PostgreSQL pin refresh; patched audited dependencies, replaced the Next lint-only braces chain with a scoped official tinyglobby alias and hash-checked compatibility options; strict npm ci, zero-vulnerability audit, supply-chain gate and 9 targeted security/consumer tests pass; complete application tests/build and new-head CI tracked in PR461; full-schema staging and live phone acceptance remain rollout gates in docs/whatsapp-pilot.md |

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
| task_whatsapp_review_window_recheck_code | DONE | Codex | 2026-10-22 |
| task_whatsapp_review_ci_metadata_code | DONE | Codex | 2026-10-22 |
| task_whatsapp_review_tools_code | DONE | Codex | 2026-10-22 |
| task_archive_prior_release_marker_code | DONE | Codex | 2026-10-20 |
| task_whatsapp_webhook_log_privacy_code | DONE | Codex | 2026-10-20 |
| task_whatsapp_strict_provisioning_code | DONE | Codex | 2026-10-20 |
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
| PROD-DEPENDABOT-HIGH-ALERTS-OPEN | DONE | Codex | 2026-08-16 |
| PROD-CODEQL-BLOCKING-RULESET-MISSING | DONE | Codex | 2026-08-16 |
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
| PROD-LOGIN-LATENCY-SERVER-GRANT | DONE | Claude | 2026-08-28 |
| PROD-SESSION-COOKIE-CONTRACT | DONE | Claude | 2026-08-28 |
| PROD-AUTH-LOGIN-RATE-LIMIT | DONE | Claude | 2026-08-28 |
| PROD-AUTH-ME-CLIENT-DEDUP | DONE | Claude | 2026-08-28 |
| PROD-L0-AUDIT-FIX-F07-F15-F25-F04 | DONE | Claude | 2026-08-28 |
| PROD-FALSE-GREEN-GATE-RETARGET | DONE | Claude | 2026-08-28 |
| PROD-L0-DB-MIGRATIONS-F02-F06-F08-F09-F10 | DONE | Claude | 2026-08-28 |
| PROD-L0-MIGRATION-REPLAY-GATE | DONE | Claude | 2026-08-28 |
| PROD-MIGRATION-HISTORY-UNREPLAYABLE | DONE | Codex | 2026-08-15 |
| PROD-DEPLOY-RELEASE-CLAIM-VALIDATION | DONE | Claude | 2026-08-28 |
| PROD-CI-CRM-HERMES-FALSE-GREEN | DONE | Claude | 2026-08-28 |
| PROD-L0-OPEN-REDIRECT-SESSION-CHAIN | DONE | Claude | 2026-08-28 |
| PROD-AUTH-LIMITER-EVICTION-BYPASS | DONE | Claude | 2026-08-28 |
| PROD-RELEASE-SCRIPT-FAIL-CLOSED | DONE | Claude | 2026-08-28 |
| PROD-KPI-TARGETS-ATOMIC-REPLACE | DONE | Claude | 2026-08-28 |
| PROD-QUOTATION-CONVERT-ATOMICITY | DONE | Claude | 2026-08-28 |
| PROD-COS-SCRIPT-RELEASE-DRIFT | DONE | Claude | 2026-08-28 |
| PROD-AUTH-OLD-TOKEN-REVOCATION | DONE | Claude | 2026-08-28 |
| PROD-F09-MONEY-AUTHORIZATION-PHASE2 | DONE | Claude | 2026-08-28 |
| PROD-F02-DEV-SETUP-CREDENTIAL-REMOVAL | DONE | Claude | 2026-08-28 |
| PROD-SECRET-SCANNING-ALERTS-OPEN | DONE | Claude | 2026-08-20 |
| PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION | DONE | Claude | 2026-08-28 |
| PROD-AUTH-LEAKED-PASSWORD-PROTECTION | DONE | Codex | 2026-08-15 |
| PROD-CONTRACT-REVOKE-LIST-DIRECT-WRITE | DONE | Claude | 2026-08-28 |
| PROD-PAYMENT-RECORD-NO-IDEMPOTENCY-KEY | DONE | Claude | 2026-08-28 |
| PROD-DEPLOY-TASKBOARD-GATE-MISSING | DONE | Claude | 2026-08-28 |
| PROD-PROXY-ACTIVITY-THROTTLE-UNBOUNDED | DONE | Claude | 2026-08-28 |
| PROD-MIGRATION-HISTORY-IMMUTABILITY-GATE | DONE | Claude | 2026-08-28 |
| PROD-CONTRACT-STATUS-PATCH-ROUTE | DONE | Claude | 2026-08-28 |
| PROD-ROLLBACK-SECURITY-PRESERVING | DONE | Claude | 2026-08-28 |
| PROD-MIGRATION-HISTORY-CONTENT-RECONCILIATION | DONE | Codex | 2026-08-15 |
| PROD-CONTROL-PLANE-BOOTSTRAP | DONE | Claude | 2026-08-28 |
| PROD-DEPLOY-CONTRACT-REENTRY-RECOVERY | DONE | Codex | 2026-08-28 |
| PROD-CI-PROVENANCE-EXCEPTION-EXPIRY-RENEWAL | DONE | Claude | 2026-09-11 |
| PROD-SUPPLY-CHAIN-CRITICAL-ADVISORY-REMEDIATION | DONE | Claude | 2026-09-11 |
| PROD-RELEASE-CLOSURE-SLOT-DEADLOCK | DONE | Claude | 2026-09-11 |
| PROD-DEPLOY-STRICT-PHASE-CLAIM-GAP | DONE | Claude | 2026-09-11 |
| PROD-CREDENTIAL-RUNBOOK-TWO-PHASE | DONE | Codex | 2026-08-15 |
| PROD-CREDENTIAL-PROVIDER-RECEIPT-PRODUCER | DONE | Codex | 2026-08-15 |
| PROD-MAIN-BRANCH-PROTECTION-UNENFORCED | DONE | Codex | 2026-08-15 |
| PROD-L0-ROUND4-ENTRY-BOUNDARY-AND-MONEY-INTEGRITY | DONE | Claude | 2026-08-28 |
| PROD-FIRST-PAYMENT-STATUS-LITERAL-SEQ-ONE | DONE | Claude | 2026-08-28 |
| PROD-INSTALLMENT-SCHEDULE-NONCONTIGUOUS | DONE | Claude | 2026-08-28 |
| PROD-CONVERSION-RETRY-DOUBLE-COUNTS-AMOUNT | DONE | Claude | 2026-08-28 |
| PROD-KPI-PERIOD-DELETE-BYPASSES-ROUTINE | DONE | Claude | 2026-08-28 |
| PROD-ROLLBACK-HAS-NO-RETURN-PATH | DONE | Claude | 2026-08-28 |
| PROD-QUOTE-CONVERT-SCHEDULE-CENT-TOLERANCE | DONE | Claude | 2026-08-28 |
| PROD-PAYMENT-STATE-MODEL-DISAGREEMENT | DONE | Claude | 2026-08-28 |
| PROD-ROLLBACK-DB-PHASE-UNCOUPLED | DONE | Claude | 2026-08-28 |
| PROD-CHECKOUT-REWRITES-RELEASE-BYTES | DONE | Claude | 2026-08-28 |
| PROD-FINGERPRINT-AND-TXCONTROL-COERCION | DONE | Claude | 2026-08-28 |
| PROD-STRICT-POSTURE-UNDERVERIFIED | DONE | Claude | 2026-08-28 |
| PROD-COMPANIONS-UNBOUND-TO-RELEASE | DONE | Claude | 2026-08-28 |
| PROD-DEPLOY-TRUSTS-OPERATOR-MIGRATION-SET | DONE | Claude | 2026-08-28 |
| PROD-LEAD-ASSIGNMENT-CAS-DECORATIVE | DONE | Claude | 2026-08-28 |
| PROD-NOTIFICATION-FACT-IDEMPOTENCY | DONE | Codex | 2026-08-15 |
| PROD-ROLLBACK-COMPANION-PROMISES-UNCHECKED | DONE | Claude | 2026-08-28 |
| PROD-DEPLOY-TASKBOARD-GATE-UNSATISFIABLE | DONE | Claude | 2026-08-28 |
| PROD-SYSTEMD-SANDBOX-BLOCKS-NETLINK | DONE | Claude | 2026-08-20 |
| PROD-RUNTIME-SERVICE-KEY-NOT-RELOCATED | DONE | Claude | 2026-08-20 |
| PROD-HEALTH-PROBE-ASSERTS-RETIRED-UNIT | DONE | Claude | 2026-08-20 |
| PROD-UAT-FIXTURE-LEAD-SOURCE-INVALID | DONE | Claude | 2026-08-20 |
| PROD-LOGOUT-REPORTS-UNPERFORMED-REVOCATION | DONE | Claude | 2026-08-20 |
| PROD-UAT-PRODUCER-PARAMETER-GAP | DONE | Claude | 2026-08-20 |
| PROD-UAT-LEAD-WON-EXPECTATION-STALE | DONE | Claude | 2026-08-20 |
| PROD-UAT-KPI-PERIOD-UNINSERTABLE | DONE | Claude | 2026-08-20 |
| PROD-UAT-BROWSER-CONTAINER-STDIN-CLOSED | DONE | Claude | 2026-08-20 |
| PROD-UAT-BROWSER-CLIENT-RENDER-FALSE-NEGATIVE | DONE | Claude | 2026-08-20 |
| PROD-UAT-OFFSCREEN-CONTROL-VISIBILITY | DONE | Codex | 2026-08-27 |
| PROD-UAT-SCREENSHOT-BOUNDED-SAFE-SURFACES | DONE | Codex | 2026-08-27 |
| PROD-UAT-SETTINGS-ASSIGNMENT-FILTER | DONE | Codex | 2026-08-28 |
| PROD-UAT-SCREENSHOT-SCROLL-RESTORATION | DONE | Codex | 2026-08-28 |
| PROD-UAT-SMOOTH-SCROLL-RESTORATION | DONE | Codex | 2026-08-28 |
| PROD-UAT-SETTINGS-FIXTURE-IDENTITY | DONE | Codex | 2026-08-28 |
| PROD-UAT-ANCESTOR-CLIPPING-VISIBILITY | DONE | Codex | 2026-08-28 |
| PROD-UAT-HTML-LANG-SYNCHRONIZATION | DONE | Codex | 2026-08-28 |
| PROD-UAT-EXPECTED-AUTH-DENIAL-CONSOLE | DONE | Codex | 2026-08-28 |
| PROD-UAT-RUNTIME-FAILURE-DIAGNOSTICS | DONE | Codex | 2026-08-28 |
| PROD-UAT-QUICK-CREATE-CLOSE-LOCATOR | DONE | Codex | 2026-08-28 |
| PROD-SETTINGS-ROLE-FETCH-GUARD | DONE | Codex | 2026-08-28 |
| PROD-UAT-NAVIGATION-ABORTED-API | DONE | Codex | 2026-08-28 |
| PROD-UAT-PUBLIC-HEALTH-RELEASE-BINDING | DONE | Codex | 2026-08-28 |
| PROD-UAT-VERIFIER-SEMANTIC-CONTRACT-SYNC | DONE | Codex | 2026-08-28 |
| PROD-UAT-ATTESTATION-SERVICE-GROUP-ANCESTOR | DONE | Codex | 2026-08-28 |
| PROD-RELEASE-CLOSURE-HISTORICAL-STATUS-TRANSITION | DONE | Codex | 2026-08-28 |
| PROD-RELEASE-CLOSURE-SCOPE-HISTORY | DONE | Codex | 2026-08-28 |
| PROD-CI-POSTGRES-DIGEST-ROTATION | DONE | Codex | 2026-08-27 |
| PROD-UAT-CONTRACTS-PAGE-LOCKS-OUT-SALES | DONE | Claude | 2026-08-20 |
| PROD-UAT-NAV-CONTRACT-UNBOUND | DONE | Claude | 2026-08-20 |
| PROD-NAV-OPERATOR-DEAD-LINKS | DONE | Claude | 2026-08-20 |
| PROD-I18N-MISSING-KEYS-RENDER-RAW | DONE | Claude | 2026-08-20 |
| PROD-POSTHOG-DEAD-KEY-UNMASKED-REPLAY | DONE | Claude | 2026-08-20 |
| PROD-CSP-BLOCKS-EDGE-RUM-BEACON | DONE | Claude | 2026-08-20 |
| PROD-UAT-QUALITY-GATE-OPAQUE-CODE | DONE | Claude | 2026-08-20 |
| PROD-WEBSITE-LEAD-INTAKE | DONE | Codex | 2026-08-25 |
| PROD-UAT-FIXTURE-LEAD-CARD-IDENTITY | DONE | Codex | 2026-08-25 |

### 发布里程碑（release scopes）· round-4 C4-4

`scripts/check-taskboard.mjs` 过去只有两种答案：**零未完成行**或**被阻断**，而 canonical deploy wrapper 要的是前者。本板上多数行按设计到不了那里——它们写着 `待部署`，**关闭它们的正是“生产已经跑过这次变更”**。于是 AGENTS.md 称为「物理阻断部署」的那道门禁在结构上不可满足，与 `infra/release/required-jobs.json` 记录的那个缺陷同形：**不可满足的门禁不是严格的门禁，而是一道会被绕过的门禁，被绕过的门禁什么都不保护**。

因此每一行未完成行必须声明它属于哪个里程碑，声明就写在本文件里（Iron Rule：不在板上就不存在）：

| 里程碑 | 含义 | 谁要求它 |
| --- | --- | --- |
| `predeploy_ready` | 部署或受保护的控制面 bootstrap **之前**必须关闭 | `infra/systemd/newme-deploy.sh` 在安装任何东西之前跑 `--require-scope=predeploy_ready` |
| `postdeploy_acceptance` | 不得作为候选 SHA 的自证前置；生产证据和候选 exact-head CI 的板上关闭都由部署后的 TASKBOARD-only closure SHA 记录 | 只有 release-final（`--require-complete`）要求它 |

里程碑**是累积的**：要求 `postdeploy_acceptance` 同时要求 `predeploy_ready`，所以后一个里程碑永远不能越过前一个变绿。候选 SHA 的必需 CI 结论由 canonical wrapper 直接读取 GitHub API 并逐 job 对照候选自己的 `infra/release/required-jobs.json`，不能要求同一个候选 SHA 先把“未来 CI 已绿”写回 TASKBOARD（写回就已换 SHA）。该 manifest 的 `taskboard_closure_evidence` 把这种行机器映射到具体 required job、全部 required jobs 或 main-push/Hermes 后续证据；checker 强制它们留在 `postdeploy_acceptance`。生产完成后只允许一个仅改 `TASKBOARD.md` 的 closure SHA，release-final CI 再绑定 release→closure ancestry、单文件 diff 与全板完成。控制面 bootstrap 不再拥有会自指的第三种 scope；候选 wrapper 的 `bootstrap` 模式会重新执行与 canonical deploy 相同的 exact-SHA CI、taskboard、迁移声明、生产迁移历史与 companion 内容门禁，然后才写机器 gate record。`--require-complete` 等价于最后一个里程碑，仍是 release-final 门禁。

声明每次运行 checker 都**双向**校验（包括那个不要求任何 scope 的 CI job）：**未声明的未完成行 = FAIL 并指名**（否则「离开部署门禁」的办法就是加一行然后什么都不说），**声明了却没有对应未完成行 = FAIL 并指名**（否则陈旧声明会堆到没人分得清哪条是承重的）。块内出现既不是表头也不是三格声明的行同样 FAIL——那正是把真实行藏进块里躲过扫描的路子。

<!-- taskboard-scopes:begin -->
| item | scope | closure condition |
| --- | --- | --- |
| PROD-CHECKOUT-REWRITES-RELEASE-BYTES | postdeploy_acceptance | 候选 exact-head 的 Windows checkout and SPEC gate 由 wrapper 在部署前强制成功；关闭条件是在部署后的 TASKBOARD-only closure SHA 记录该 run 证据 |
| PROD-DEPLOY-TASKBOARD-GATE-UNSATISFIABLE | postdeploy_acceptance | 候选 exact-head 的 Predeploy taskboard readiness 由 wrapper 在部署前强制成功；关闭条件是在部署后的 TASKBOARD-only closure SHA 记录该 run 证据 |
| PROD-CI-CRM-HERMES-FALSE-GREEN | postdeploy_acceptance | 关闭条件是合入 main 后首次 main push 上 crm-ci workflow_run 成功 + Hermes delivery 200，并在 TASKBOARD-only closure SHA 记录证据 |
| PROD-COMPANIONS-UNBOUND-TO-RELEASE | postdeploy_acceptance | 候选 exact-head 的 Migration replay and release contracts 由 wrapper 在部署前强制成功；关闭条件是在 TASKBOARD-only closure SHA 记录该 run 证据 |
| PROD-DEPLOY-TRUSTS-OPERATOR-MIGRATION-SET | postdeploy_acceptance | 候选 exact-head 的全部 required jobs 与紧邻切换前的机器重验由 wrapper 强制成功；关闭条件是在 TASKBOARD-only closure SHA 记录证据 |
| PROD-FINGERPRINT-AND-TXCONTROL-COERCION | postdeploy_acceptance | 候选 exact-head 的 Migration replay and release contracts 由 wrapper 在部署前强制成功；关闭条件是在 TASKBOARD-only closure SHA 记录该 run 证据 |
| PROD-L0-MIGRATION-REPLAY-GATE | postdeploy_acceptance | 候选 exact-head 的 Migration replay and release contracts 由 wrapper 在部署前强制成功；关闭条件是在 TASKBOARD-only closure SHA 记录该 run 证据 |
| PROD-STRICT-POSTURE-UNDERVERIFIED | postdeploy_acceptance | 候选 exact-head 的 Migration replay and release contracts 由 wrapper 在部署前强制成功；关闭条件是在 TASKBOARD-only closure SHA 记录该 run 证据 |
| SAM-6 | postdeploy_acceptance | 候选 exact-head 全部 required jobs 由 wrapper 在部署前强制成功；关闭条件是部署后由总控在 TASKBOARD-only closure SHA 记录复核 |
| hermes-ci | postdeploy_acceptance | 关闭条件是 ci 成功 + crm-ci workflow_run 成功 + Hermes webhook delivery 200，并在 TASKBOARD-only closure SHA 记录三份可审计证据 |
| PROD-CONTROL-PLANE-BOOTSTRAP | postdeploy_acceptance | 关闭条件是候选 wrapper 的 bootstrap coordinator 对同一 release SHA 重新执行全部机器门禁、完成可回滚控制面事务，并留下 snapshot、finalize、健康与零 pending 证据；操作者不得手写 gate record |
| PROD-AUTH-ADMIN-RESET-GLOBAL-REVOCATION | postdeploy_acceptance | 修复与 PG17/离线证据已写在本条 review 行内；关闭条件是生产已应用本 release 且取得部署后验收证据 |
| PROD-AUTH-LIMITER-EVICTION-BYPASS | postdeploy_acceptance | 修复与 PG17/离线证…58864 tokens truncated…M-11 | DONE | 机器项全验 + 工作簿导入写测试全 PASS（M1 RELEASED 2026-07-20）；差异 SAM-45 进 M2。 |
| SAM-12 | DONE | **RELEASED**：全链证据汇总 + 唯一结论出具（2026-07-20，森哥签收生效）。 |
| SAM-24 | DONE | DB 兼容/备份/回滚点验证通过（M1 链）。 |
| SAM-25 | DONE | 正向链路 + 负向 6/6 全 PASS，fixture 清理基线零漂移；差异 SAM-46 进 M2、SAM-48 热修已上线。 |
| SAM-26 | DONE | 角色权限矩阵机器验✓；移动端/视觉挂起人工（不拦发布，留 M2 观察）。 |
| SAM-27 | DONE | 集成/cron/可观测性验收✓；SAM-47 随热修 #1 关闭。 |
| SAM-28 | DONE | 业务签收（森哥 2026-07-20）+ 技术签收（机器全量验收）→ Done。 |
| SAM-43 | DONE | Linear 仍为 `In Review`；登录态视觉/交互 UAT 未完成，不得以 API/CI 证据替代。 |
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
| hermes-ci | Hermes CI webhook 订阅 crm-ci | CI pipeline 跑通 + webhook 触发 | 等待 `ci` 成功、`crm-ci` workflow_run 成功及 Hermes webhook delivery 200 可审计证据 | DONE |
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

Historical postdeploy acceptance SHA-256 retained from TASKBOARD.md at 46b0f091c10f4dbc565a0cd506f21dbc7352db5f: 31fb1c3341de7c5144368f31016054d686e2bb63d4dfc0091652865c4c92c922 (archived record).


## WhatsApp strict provisioning code verification — 2026-10-20

Code-only: the root coordinator now has narrowly allowlisted WhatsApp plan/provision operations for an already strict database. The immutable observer SQL hash, unchanged live migration prefix, strict compatibility, table/history agreement, ancestry and fresh CI are required. The 37 policy/coordinator tests pass, including refusals before the applier on every failed antecedent. Shell syntax and unchanged migration/companion checks pass. This row does not claim a production control-plane upgrade, migration, application deployment, phone onboarding or message capture. Full CI and the two-stage release remain separate production evidence.

## WhatsApp callback ingress privacy code evidence (2026-10-20)

Code-only completion: the exact callback location uses a fixed-field structured access log with request ID, client IP, status and upstream timing; query strings, headers and bodies are excluded. Raw Nginx error logging is replaced at this location because it can contain verification queries. HTTPS callback request size remains capped at 1 MiB, body buffering stays in memory and proxy streaming preserves the signed bytes; plaintext callback requests are rejected. Existing ingress rules remain in place.

Validation: 14 targeted security/release tests pass. An isolated loopback-only instance of the actual installed server Nginx passed 85 synthetic requests including normal GET/POST, 400, 413, 429 and upstream 502; all outcomes were recorded, a 256 KiB body was preserved, sensitive synthetic query/body markers were absent from log files, and no body temporary files were created. Production Nginx, database data and app release were untouched by this test. This is not proof of Meta callback verification, phone onboarding or production message capture.

## Prior release marker archival preparation (2026-10-20)

The previous acceptance digest remains in ordinary historical prose, with its source commit retained. Its executable closure-marker syntax is archived before the successor application release, so the unchanged closure checker can require exactly one newly appended acceptance marker. The checker, acceptance policy, provider receipts and immutable deployed trees are unchanged. Code/document preparation only: the current application release still needs its own real acceptance; this entry does not claim that it is complete.

## WhatsApp observer release acceptance closure (2026-10-20)

Canonical acceptance is verified for application release 8a78be8134441aae8560626cd56b07d9f5ab11d2, build 4Cj0UZFVwGjggyYNlRgUF, deployment CI 39449460527. All four role actors, six business flows and eight English/Chinese browser sessions passed; 56 redacted screenshots and 16 top-level JSON artifacts were verified. 42 dedicated fixture IDs were created and cleaned with zero residual rows; the test payment was voided and its KPI baseline restored. Failure/recovery provider delivery and the delayed same-message readback passed. Performance: 20 samples, p75 256 ms, p95 324 ms. This records authentic acceptance; the coordinator separately gates finalization. WhatsApp phone onboarding and capture remain disabled.

Historical postdeploy acceptance SHA-256 retained from TASKBOARD.md at c8dff02b067e6866df85f52cce1e3c3f9cd8206c: cc24edf5869c4da41748be22aded9a00c17430f5e769480b2998ae461f405bd6 (archived record before the next application release).

## WhatsApp App Review tools code preparation (2026-10-22)

Code-only preparation: Settings > WhatsApp now includes a default-off review panel for a fixed Meta test WABA, its verified test sender and the existing internal recipient ending 9388. Active current-session boss/admin access, exact same-origin JSON, bounded requests, process-local replay protection, per-user/global hourly limits and an explicitly bounded activation window of at most 24 hours protect the operations. Arbitrary recipients, WABAs, messages and template content are refused. Uncertain mutation outcomes are retained without automatic retry; process restarts are not represented as delivery cancellation or durable idempotency.

Local validation: 17 targeted observer/review-tool tests passed, including invalid/stale windows, wrong test assets, unchanged fixed targets, rejected roles/origins/body shapes, budget exhaustion, expired sessions, concurrent retry sharing, credential redaction and ambiguous upstream outcomes. Type checking and targeted lint passed. The route convention and tracked credential checks passed. No new database migration, Graph token grant, real send, template creation, production deployment or message capture is claimed here. Full CI, guarded deployment, actual Meta account checks and authorised recordings remain separate acceptance evidence. The prior acceptance digest is retained above as ordinary history so the successor release can acquire its own canonical closure.

## Review-tools CI metadata readiness (2026-10-22)

The SPEC supplement now records the actual WhatsApp routes, the sandbox-only review panel, the unchanged existing Ads bridge and outstanding acceptance gates. The official PostgreSQL 17.11-trixie index was rebuilt upstream; the active CI references, provenance lock and mutation-test fixture now agree with digest b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe. Docker Hub metadata and an isolated no-network, read-only container verified PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2). Production database and containers were not modified. All 25 targeted observer/review/provenance tests, official online provenance readback, workflow syntax and SPEC coverage checks passed locally. The original pin checks and their refusal cases are retained. This does not claim that the revised PR's full CI or production rollout has completed.

## Review-tools activation-window boundary (2026-10-22)

Code-only: the helper now reads a fresh clock immediately before each Graph request. If the test-phone lookup finishes at or after the activation deadline, sending and template creation stop before any POST. A deterministic asynchronous regression covers both mutations exactly at expiry and after expiry. All 26 targeted observer/review/provenance tests, full TypeScript checking and targeted ESLint passed locally. WhatsApp requests in these tests are mocked; this evidence does not claim a real Graph action, message delivery, template creation or production deployment.
