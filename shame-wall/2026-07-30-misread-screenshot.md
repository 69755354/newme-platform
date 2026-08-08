# [deepseek-v4-pro] 2026-07-30 — 认错用量截图

**LLM:** deepseek-v4-pro（session 20260730_073509，telegram）

## 失败

把用户发的用量截图猜成 GitHub/Cursor，实际是 GitHub Copilot 用量页。

## 根因

在可靠识别前就输出视觉猜测。

## 整改控制

先识别图片或声明不确定；未经证实的视觉猜测不得变成结论。
