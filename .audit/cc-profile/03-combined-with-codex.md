# CC & Codex Audit Comparison — NewMe CRM v3.1

**Date:** 2026-06-25

## Codex Status

Codex 本轮未成功执行（stdin 挂死，2次尝试均失败）。以下为 CC 独审结果。

## CC Findings Summary

### Same Findings (CC + earlier CC audit from proc_6d22499c3eb9 both found)

| Issue | Source | File |
|-------|--------|------|
| leads.archive_reason 列缺失 | CC-02 + earlier CC | archive/route.ts:27,62 |
| leads.created_by 列缺失 | CC-02 + earlier CC | import/confirm/route.ts:35 |

### CC-02 Migration Audit Findings
- P0-1: `leads.archive_reason` 列缺失
- P0-2: `leads.created_by` 列缺失
- P1-1: `archived` NOT NULL 与代码 `.is(null)` 冲突

### CC-03 Workflow/Stage Audit Findings
- P0-1: won/lost 双真相源（final_status OR stage）
- P0-2: 写入路径不一致（milestone双写 vs Kanban单写）
- P0-3: `final_status || stage` 回退遍布读侧
- P1-1: stage 仍被当流程标签写入
- P1-2: 三套独立状态系统（漏斗/里程碑/工作流）
- P1-3: milestone 顺序保护仅依赖 DB trigger

### CC-01 Diff Findings
- P1: xlsx@0.18.5 CVE（原型污染 + ReDoS）

## Final Audit Recommendation

**NO-GO** — CRM 归档 + workflow 状态机子系统冻结

### P0 (必须修): 5 个
1. `archive_reason` 列缺失
2. `created_by` 列缺失
3. 双真相源
4. 写入不一致
5. 读侧放大

### P1 (上线前修): 4 个
1. archived null 检查冲突
2. xlsx CVE
3. 三套状态系统
4. milestone 跳序风险

### 修复顺序
1. Migration: 补 `archive_reason` + `created_by` 列
2. Workflow 写: 统一终态写入路径
3. 双真相源: 废除 stage，独用 final_status
4. 读路径: 删所有 `final_status || stage` 回退
5. xlsx: 升级依赖

### 可继续的模块
不依赖以上字段和工作流状态的模块可继续开发。
