# OpenCode Dry-Run — Handshake Test

**Date:** 2026-07-14
**Model:** zai-coding-plan/glm-5.2
**Mode:** Read-only dry-run (no files modified)
**Dispatched by:** Hermes (DeepSeek v4-pro)

---

## 任务理解

**任务目标（用自己的话）：**
修复 Lead 导入确认 API 的幂等性失败问题。当前对同一份 workbook 重复提交 `upsert(..., { onConflict: "import_fingerprint" })` 会报错，而不是被跳过。本任务要让重复 workbook 的第二次确认安全返回 `imported=0, skipped_duplicates=1`，且不重写任何 legacy 数据行。当前控制面状态：`status=READY_FOR_HERMES`、`codex_decision=GO`、`hermes_status=UNCLAIMED`—— 即 Codex 已放行，但 Hermes 尚未认领，我（OpenCode）作为代码执行者只能在被显式分派后才动手。

**根本原因（已复现的生产问题）：**
`leads_import_fingerprint_unique` 是一个**部分唯一索引**（`WHERE import_fingerprint IS NOT NULL`）。PostgREST 无法把部分索引推断为 `ON CONFLICT` 目标，因此 `onConflict: "import_fingerprint"` 在服务端解析失败，导入路径直接抛错。

## 允许修改的文件

Task 0 明确列出的三处：

- **Create:** `supabase/migrations/20260714000004_fix_import_fingerprint_conflict_target.sql`
- **Modify:** `tests/security/lead-import-idempotency.test.mjs`
- **Preserve（不得改）:** `src/app/api/leads/import/confirm/route.ts`

注意：Preserve 意味着源码一行都不动；修复完全落在 migration 层，因为新的非部分唯一索引天然允许多个 NULL，旧 `import_fingerprint IS NULL` 的 legacy 行不会被重写。

## 禁止项

**任务级禁止：**
- 不得修改 `src/app/api/leads/import/confirm/route.ts`（Preserve）
- migration 不得包含 `WHERE import_fingerprint IS NOT NULL`（否则又变回部分索引）
- 不得重写 legacy 行
- 不得扩大 PR 范围到 Task 0 文件清单之外

**全局禁止：**
- 不得绕过 hooks / CI / coding-auth / RLS / migration history / branch protection
- 不得 force push / reset hard / `--no-verify` / 广义 archive-delete / 名称匹配 archive
- 不得修改生产数据（除非 UAT fixture 且用唯一前缀，结束后按精确 ID archive）
- 不得 merge / deploy / apply migration 而无 Codex 书面 GO
- 本次握手为只读 dry-run：不得改控制面、不得写任何文件

## RED/GREEN 测试计划

**RED（应先失败）：**
向 `tests/security/lead-import-idempotency.test.mjs` 加入对 migration 文件内容的断言，此时 migration 文件不存在 → `node --test` 报错。

**GREEN（修复后应通过）：**
创建 migration（DROP partial index → CREATE full unique index），随后断言全绿，并跑：targeted test、`npm test`、`npm run typecheck`、`npm run lint:baseline`、`git diff --check`。

## 生产 Release 条件

**部署前必须满足：**
1. 全部 targeted + `npm test` + typecheck + lint:baseline + `git diff --check` 通过
2. PR 窄范围、CI green
3. 停在 **HANDSHAKE A0** 等待 Codex 评审
4. PR 文档须说明 PostgreSQL 唯一索引允许多 NULL、不重写 legacy 行
5. 部署走 `scripts/deploy.sh`，不做手动 build/restart
6. `check-taskboard.sh` 无 ❌

**UAT 验证：**
提交一条唯一命名的合成 workbook 行，source 用 legacy 值 `Meta Ads`，quality `0.8`，带历史 contact date 和 country，然后验证：
- preview 显示 `ins` / `good`
- 第一次确认 import 1 条
- 第二次确认返回 `imported=0, skipped_duplicates=1`
- `raw_import_data` 中 country 与首次 contact date 保留
- 导入的精确 ID 可被精确 owner 预览、archive、restore、最后再 archive 作为 fixture 清理

## 确认

- [x] 理解 OpenCode 是唯一代码执行者
- [x] 理解含源码/migration/test 的 commit 必须标记 `[OPENCODE]`
- [x] 理解未获 Codex GO 不得 merge/deploy/migration/写生产
- [x] 理解本次仅握手测试，不改控制面、不改生产 —— 全程只读
