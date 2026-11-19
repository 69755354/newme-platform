@AGENTS.md

# Compact instructions

压缩（自动或 /compact）生成摘要时，必须保留：

- 审计规范、风险等级定义、发版门禁规则、开关策略（含"合并≠授权启用"类约束）
- 每个漏洞/风险条目：ID、等级、文件路径+行号、复现步骤、证据索引（指向 .audit/ 下的文件，不内联原文）、状态标记（已复现 / 存疑 / 已修复）
- 严重/安全项的二次复核结论和复核人（子 Agent 标识）
- PR 和分支状态、TASKBOARD.md 中未完成项
- 用户已批准的计划范围和尚未执行的项

可以丢弃：原始 shell 输出、调试试错过程、子 Agent 的探索记录（需要时去 .audit/compact-archive/ 查）。

摘要末尾输出结构化清单：当前待办、未修复风险、门禁约束。

台账以 TASKBOARD.md 为唯一事实来源。新发现的风险先写进 TASKBOARD.md 或 .audit/，再在对话里引用，不要只存在于对话中。压缩阈值和归档/对账 hook 配置在 .claude/settings.json。
