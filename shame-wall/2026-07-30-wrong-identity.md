# 2026-07-30 — LLM 身份三连错

**LLM:** deepseek-v4-pro（session 20260730_073509，telegram；同批另有 glm-5.2 会话 20260730_040016）

## 失败

被问"你是什么 LLM"时回答不一致，在 DeepSeek 与 GLM-5.2 之间改口三次，最后查配置才对。

## 根因

凭记忆/config 假设回答身份，未查当前 agent 日志。

## 整改控制

报告身份前必须运行 `~/.hermes/scripts/identity-check.py`。
