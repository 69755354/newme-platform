# Employee Readiness GO — 2026-06-24

## 结论：🟢 GO

## 账号状态

> **2026-08-12 · 四审 A0 涉及的凭据已从本文件删除。** 本表原先以明文列出六个生产
> 身份的登录口令（其中五个共用同一个口令），角色覆盖 admin / boss / sales。删除只
> 是把它们从**工作树**移除；这些值仍在本仓库的公开 git 历史中，因此必须一律视为
> **已泄露且仍然有效**，直到轮换完成。轮换、身份封禁与会话吊销都是需要单独授权的
> 生产动作，关闭条件见 `supabase/preflight/f02-credential-cutover.md` §7；防复发门禁
> 见 `scripts/check-published-credentials.mjs`。

| Email | Name | Role | Password | Status |
|-------|------|------|----------|--------|
| dev@newme.ae | Dev User | admin | [REDACTED — 见上方说明] | ✅ |
| admin@newme.ae | SAM | admin | [REDACTED — 见上方说明] | ✅ |
| tanya@newme.ae | Tanya | boss | [REDACTED — 见上方说明] | ✅ |
| ayana@newme.ae | Ayana | admin | [REDACTED — 见上方说明] | ✅ |
| faheem@newme.ae | Faheem | sales | [REDACTED — 见上方说明] | ✅ |
| mohamed@newme.ae | Mohamed | sales | [REDACTED — 见上方说明] | ✅ |

## 验证结果

- 6/6 账号登录正常
- Profile / role / assigned leads 完整
- Dashboard, Leads, Pipeline, Analytics, Contracts 全部 200
- RLS 权限隔离正常 (Sales≠Admin lead count)
- Won 链路完整 (Contract + Installment + Project + Customer + Event)
- Lost 链路完整 (Follow-up + Reason + 持久化 + 不计 active)

## 已知问题（不阻塞）

- P1: Leads 页面 stage 计数器显示 0
- P2: req_confirmed stage 过渡 400

## 员工通知

今天临时密码：[REDACTED — 四审 A0，见上方说明]
登录后请立即修改密码
如无法修改，联系 admin

## 未测试

- 移动端 Safari（环境限制）
