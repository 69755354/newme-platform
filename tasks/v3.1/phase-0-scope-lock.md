# Phase 0 — Scope Lock

**Status:** ⏳ IN PROGRESS
**Rule:** 只读，不改代码、不改DB、不跑migration、不deploy
**Started:** 2026-06-25 00:16 CST

---

## 0. Flight Recorder

- [ ] 输出 Flight Recorder（环境/模型/操作员/时间戳）

## 1. PRD 落盘

- [ ] `docs/prd/NewMe-CRM-Stabilization-Data-Migration-v3.1.md` 已存在 ✅
- [ ] 更新 PRD 引用真实 task 文件路径

## 2. Scope Lock Report — 28 files KEEP / REMOVE / REVIEW

- [ ] 审计所有 28 modified files
- [ ] 每个文件标记 KEEP / REMOVE / REVIEW
- [ ] KEEP 标注对应 PRD 项
- [ ] REMOVE 标注是否可安全剥离
- [ ] REVIEW 标注需要什么决策

## 3. Excel 事实 value_counts

- [ ] 读 Book2.xlsx
- [ ] 输出：总行数、电话数、status分布、source分布、quality分布、日期范围
- [ ] Notes 列抽样确认有内容

## 4. Phase 1 最小修改文件列表

- [ ] 列出 Phase 1 涉及的代码文件
- [ ] 标注是否涉及 migration
- [ ] 标注是否涉及 auth/proxy/RLS/account
- [ ] 标注是否需要 森哥 GO

## 5. 当前 28 files working tree 审计

- [ ] 28 files 逐个审计完成
- [ ] 输出 KEEP/REMOVE/REVIEW 清单

---

## Output

完成后停在 Phase 0。不允许进入 Phase 1。等确认。

---

## Acceptance

- [ ] Flight Recorder 落盘
- [ ] PRD 路径确认
- [ ] Scope Lock Report 可读
- [ ] Excel value_counts 原始输出
- [ ] Phase 1 文件列表
- [ ] 森哥 GO 标注
