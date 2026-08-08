# [deepseek-v4-pro] 2026-07-21 — 构建产物路径致健康检查失败

**LLM:** deepseek-v4-pro（session 20260721_040106，weixin）

## 失败

不可变构建保留的 `appDir` 指向已删除的临时 worktree，导致 release 健康检查端点报 request-scope 错误。

## 根因

worktree 删除后，构建产物元数据未被重写或验证。

## 整改控制

worktree 清理后测试实际 release 产物；健康与就绪检查分开验证。
