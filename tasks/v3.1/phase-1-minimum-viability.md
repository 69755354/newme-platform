# Phase 1 — Minimum Business Viability

**Status:** ⏸️ BLOCKED (等 Phase 0 确认)
**Rule:** 最小改动，让 Tanya 明天能继续用
**Depends on:** Phase 0 完成 + 用户 GO

---

## P0-1: Note / Timeline

> Excel Notes 是本次导入最高价值字段。必须进 timeline，不能只塞 leads.notes。

- [ ] Lead Detail 可新增 note
- [ ] Note 有 created_by / created_at / type
- [ ] Excel Notes 导入后生成 follow_up_logs（type=import_note）
- [ ] Timeline 显示 import_note
- [ ] Notes 空 → 不生成 timeline note
- [ ] 保留 raw_note

**验收：** 导入的 Excel Notes 在 Lead Detail Timeline 可见

## P0-2: Create Lead 稳定性

> Tanya 真实阻断：建不了 lead、建了数据不可信。

- [ ] New Lead 创建正常
- [ ] Quick Create 创建正常
- [ ] 错误消息真实可见（route.ts:138 已修 ✅）
- [ ] 创建后 assigned_to 正确
- [ ] 创建后 created_by 正确
- [ ] 创建后 leads list 可见
- [ ] 创建 next follow-up 时写 task

**验收：** Tanya/Admin/Sales 都能建 lead，建完立即可见

## P0-3: Excel Import（轻量但可审计）

> 60行不建复杂系统，但必须有 batch trace。

- [ ] dry-run 模式
- [ ] preview 展示
- [ ] confirm 后执行
- [ ] import_batch_id 追溯
- [ ] raw row trace（row_number, raw_status, raw_source, raw_note）
- [ ] failed/warning report
- [ ] Notes → timeline（见 P0-1）
- [ ] 空 status → new / quality=pending
- [ ] 空 source → other 或 unknown_import
- [ ] instgram → instagram（不进 meta_ads）
- [ ] Client Quality 映射（0-0.2→poor, 0.4-0.6→normal, 0.7-0.9→good, 空→pending）
- [ ] 不导入失败（异常值如 0& → warning + pending）

**验收：** 60行导完，Leads list 可见，Timeline 有 Notes，可查 import_batch_id

## P0-4: Mohamed 旧 leads 归档

- [ ] 软归档（不物理删除）
- [ ] dry-run → confirm
- [ ] 可按 archive_batch_id 查回
- [ ] 不影响活跃 lead 统计

**验收：** Mohamed 旧数据归档后 Dashboard 不受影响

## P0-5: Dashboard Ownership

> Tanya 要看到自己创建/负责的 leads。

- [ ] 新增 Team Lead Ownership（不是改 Sales Leaderboard）
- [ ] 显示 assigned leads / created leads / active / won / lost
- [ ] boss/admin 有业务数据就出现
- [ ] Tanya 的 created/assigned leads 必须出现

**验收：** Tanya 登录 Dashboard 能看到自己的 leads

## P1-6: Project Info Save

- [ ] Save 按钮可用
- [ ] Saving / Saved / Error 状态
- [ ] 刷新后保留

**验收：** 编辑 Project Info → Save → 刷新 → 数据还在

## P0-7: Tasks Minimum Safety Patch

> 双审计 P0，不能推到明天。

- [ ] due_at 今天可选（不被 CHECK 卡死）
- [ ] Quick Create / New Lead 创建 next follow-up 时 → 必须创建 task
- [ ] Lead Detail 设置 next follow-up → 必须写 task
- [ ] Workbench / Dashboard 今日待办不因缺 task 失真

**验收：** 建 lead → 设 follow-up → task 表有记录 → Workbench 可见

---

## Explicitly NOT in Phase 1

- ❌ Tasks full unification（Phase 2）
- ❌ follow-up-overdue API 统一（Phase 2）
- ❌ sales-load 统一（Phase 2）
- ❌ cron 统一（Phase 2）
- ❌ grep next_followup_date 残留清理（Phase 2）
- ❌ 新 Analytics 组件
- ❌ Dashboard 美化
- ❌ UI 大改

---

## Acceptance for Phase 1

- [ ] Tanya 能建 lead
- [ ] Excel 60行导入完成 + Notes 在 Timeline
- [ ] Mohamed 旧数据归档
- [ ] Dashboard 显示 Tanya 的 leads
- [ ] Project Info 可保存
- [ ] Tasks 不再被 CHECK 卡死
- [ ] tsc PASS + build PASS + smoke PASS
