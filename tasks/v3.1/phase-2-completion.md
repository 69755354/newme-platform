# Phase 2 — Completion

**Status:** ⏸️ BLOCKED（等 Phase 1 完成）
**Depends on:** Phase 1 全部 P0 通过

---

## P0-8: Poor Lead + poor_reason

- [ ] Poor Lead 标记逻辑
- [ ] poor_reason 字段
- [ ] Leads list 可筛选 Poor

## P1-9: Assem 账号创建

> ⚠️ 必须先等 森哥 GO。Flight Recorder 在操作前。

- [ ] 输出 Flight Recorder
- [ ] 森哥明确 GO
- [ ] 创建 assem@newme.ae
- [ ] 不碰任何现有账号
- [ ] 输出 auth user id / profile id / role / active / temporary password

## P0-10: Tasks Full Unification

> Phase 1 做了 minimum safety patch。Phase 2 全部统一到 tasks。

- [ ] follow-up-overdue API → 读 tasks
- [ ] sales-load → 读 tasks
- [ ] leads list filter → 读 tasks
- [ ] cron → 读 tasks
- [ ] grep next_followup_date 残留 → 全部替换
- [ ] 确认 tasks 是唯一读源

## P1-11: Analytics React #310 最小修复

- [ ] React #310 错误修复
- [ ] 不影响其他功能

## P1-12: 阶段说明文案

- [ ] 各 milestone 阶段说明
- [ ] i18n 覆盖

---

## Acceptance

- [ ] Poor Lead 可标记和筛选
- [ ] Assem 账号可登录
- [ ] Tasks 是 follow-up 唯一读源
- [ ] Analytics 不再报 #310
