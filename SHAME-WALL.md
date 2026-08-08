# AI Agent Shame Wall

> Public record. 每条事故独立成文件（shame-wall/ 目录），git 历史按 case 提交，commit message 带 LLM 署名（来源：Hermes session DB `sessions.model`）。
> Secrets, tokens, passwords, private keys, personal data, and private customer information are excluded.

## 索引

| 日期 | 事故 | LLM | 文件 |
|---|---|---|---|
| 2026-08-08 | Codex→COS→ThinkPad 迁移失败 | deepseek-v4-flash | [shame-wall/2026-08-08-codex-migration.md](shame-wall/2026-08-08-codex-migration.md) |
| 2026-07-30 | 清磁盘致生产宕机 6 分钟 | deepseek-v4-pro | [shame-wall/2026-07-30-prod-outage.md](shame-wall/2026-07-30-prod-outage.md) |
| 2026-07-30 | 误删 Hermes Python 运行时 | deepseek-v4-pro | [shame-wall/2026-07-30-deleted-python.md](shame-wall/2026-07-30-deleted-python.md) |
| 2026-07-30 | 编造 CI 失败根因 | deepseek-v4-pro | [shame-wall/2026-07-30-fabricated-ci.md](shame-wall/2026-07-30-fabricated-ci.md) |
| 2026-07-30 | 认错用量截图 | deepseek-v4-pro | [shame-wall/2026-07-30-misread-screenshot.md](shame-wall/2026-07-30-misread-screenshot.md) |
| 2026-07-30 | LLM 身份三连错 | deepseek-v4-pro / glm-5.2 | [shame-wall/2026-07-30-wrong-identity.md](shame-wall/2026-07-30-wrong-identity.md) |
| 2026-07-30 | hook 未激活报已生效 | deepseek-v4-pro | [shame-wall/2026-07-30-hooks-not-active.md](shame-wall/2026-07-30-hooks-not-active.md) |
| 2026-06-27 | 删库导入漂移 | deepseek-v4-pro | [shame-wall/2026-06-27-lead-import-drift.md](shame-wall/2026-06-27-lead-import-drift.md) |
| 2026-07-03 | 需求/UI 不一致晚发现 | deepseek-v4-pro | [shame-wall/2026-07-03-ui-mismatch.md](shame-wall/2026-07-03-ui-mismatch.md) |
| 2026-07-21 | 构建产物路径致健康检查失败 | deepseek-v4-pro | [shame-wall/2026-07-21-appdir-health.md](shame-wall/2026-07-21-appdir-health.md) |
| 2026-07-20 | 把方案说成已完成 | deepseek-v4-pro | [shame-wall/2026-07-20-overstated-observability.md](shame-wall/2026-07-20-overstated-observability.md) |

## Publication scope

每条 case 的署名取自 Hermes session DB `sessions.model`（合并整理时）；若某 session 的 model 字段为空，该条标记 unverified。不声称覆盖所有历史事故。
