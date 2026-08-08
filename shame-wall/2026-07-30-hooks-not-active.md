# [deepseek-v4-pro] 2026-07-30 — hook 未激活却报已生效

**LLM:** deepseek-v4-pro（session 20260730_073509，telegram）

## 失败

写好并测试了 pre-execution 与 claim-evidence 两个 hook，然后报告"已保护"——但 gateway 未重启，hook 并未加载生效。

## 根因

把文件级测试成功当成运行时激活成功。

## 整改控制

声称某个控制生效前，验证进程实际加载与运行行为。
