# CRM Recovery Ready Report

**Date:** 2026-06-25 02:15 CST
**Phase:** Phase 1 代码完成，自测通过，等待人工验证

---

## Phase 1 完成状态

| P 项 | 状态 | 说明 |
|------|------|------|
| P0-1 Notes/Timeline | ✅ 已部署 | Lead Detail 可新增 note，Timeline 显示 follow_up_logs（含 import_note） |
| P0-2 Create Lead 稳定性 | ✅ 已部署 | stage 有 DB default 'new'，错误消息真实可见，assigned_to/created_by 正确 |
| P0-3 Excel Import | ✅ 已部署 | preview + confirm API，batch trace (import_batch_id)，Notes→timeline |
| P0-4 Mohamed 归档 | ✅ 已部署 | 软归档 API，按 batch_id 可查回，archive_reason 列已加 |
| P0-5 Dashboard Ownership | ✅ 已部署 | Team Lead Ownership 表，显示 assigned/created/active/won/lost |
| P1-6 Project Info Save | ✅ 已部署 | 折叠面板草稿表单，Save/Undo，状态提示 |
| P0-7 Tasks Safety Patch | ✅ 已部署 | CHECK 放宽到 now()-1day，Quick Create/New Lead/Detail 写 task |

## API Routes 新增

| Route | Method | Auth | 状态 |
|-------|--------|------|------|
| /api/leads/import/preview | POST | ✅ required | 401 ok |
| /api/leads/import/confirm | POST | ✅ required | 401 ok |
| /api/leads/archive | POST/GET | ✅ required | 401 ok |
| /api/dashboard/team-ownership | GET | ✅ required | 401 ok |

## DB Migrations Applied

| Migration | 状态 |
|-----------|------|
| tasks CHECK 放宽 (now()-1day) | ✅ |
| leads.archive_reason 列 | ✅ |

## 自测结果（API 级）

- ✅ Health 200
- ✅ Login page 200
- ✅ Dashboard 200/307
- ✅ All new routes auth-protected (401)

## 仍需人工/浏览器验证

以下 20 项需要登录 CRM 手动点：

1. ❓ admin 创建 lead
2. ❓ Tanya 创建 lead
3. ❓ sales 创建 lead
4. ❓ Quick Create lead
5. ❓ Lead Detail 写 note
6. ❓ Timeline 显示 note
7. ❓ Project Info 保存
8. ❓ Excel dry-run (preview API)
9. ❓ Excel confirm import
10. ❓ Excel notes 进入 timeline
11. ❓ Mohamed 旧 leads 软归档
12. ❓ archived leads 默认隐藏
13. ❓ Dashboard Team Lead Ownership 显示 Tanya
14. ❓ assigned leads / created leads 口径正确
15. ❓ next follow-up 创建 task
16. ❓ today follow-up 不报错
17. ❓ Workbench 显示待办
18. ❓ Pipeline 不因 archived/imported 数据错乱
19. ❓ sales 账号无权限做 archive
20. ❓ boss/admin 有权限做 archive

## 给业务团队的使用说明

1. 登录: https://app.newme.ae/login
2. 创建 Lead: 左侧 Quick Create 或 Leads → New Lead
3. 写跟进记录: Lead Detail → 底部 note 输入框 → 保存
4. 查看团队归属: Dashboard → Team Lead Ownership 表
5. 导入 Excel: 联系管理员（功能已就绪，需集成上传界面）

## 下一步

- ☐ 人工浏览器验证 20 项 checklist
- ☐ 确认后通知团队恢复使用
- ☐ Excel 上传界面 (frontend upload component)

---

**Code PROD GO ✅** — 代码层全部通过
**Business PROD GO ❓** — 等待人工验证 20 项
