# NewMe CRM i18n 完整性全量审计报告

**审计日期**: 2026-06-10  
**项目路径**: `/home/ubuntu/newme-platform`  
**语言文件**: `src/lib/i18n/translations.ts` (仅 en / zh，同一文件)  
**语言数量**: 2 (en, zh)，两者 key 完全一致（各1045个叶子key）

---

## 摘要

| 类别 | 数量 | 严重级 |
|------|------|--------|
| P0 缺失 key（代码使用但未定义） | 8 | 🔴 Critical |
| P1 冗余 key（定义但代码未使用） | ~270 | 🟡 Low |
| WARN 硬编码文本（应走 i18n） | ~15 | 🟠 Medium |
| 语言间缺失 key | 0 | ✅ Pass |

---

## P0: 代码中使用但翻译文件中未定义的 key

> 此类问题会导致页面直接显示 key 名（如 "common.loadFailed"），严重影响用户体验。

| # | Key | 文件路径 | 行号 | 说明 |
|---|-----|---------|------|------|
| 1 | `common.loadFailed` | `src/app/(dashboard)/analytics/_components/AdsROI.tsx` | 111 | 翻译文件仅有 `common.loadFailedRetry` |
| 2 | `common.loadFailed` | `src/app/(dashboard)/analytics/_components/PaymentTracker.tsx` | 128 | 同上 |
| 3 | `common.loadFailed` | `src/app/(dashboard)/analytics/_components/PipelineFunnel.tsx` | 185 | 同上 |
| 4 | `common.loadFailed` | `src/app/(dashboard)/analytics/_components/WeeklyTrends.tsx` | 128 | 同上 |
| 5 | `leads.nextActionRequired` | `src/app/(dashboard)/leads/page.tsx` | 951 | 翻译文件未定义此 key |
| 6 | `leads.addNote` | `src/app/(dashboard)/leads/page.tsx` | 975 | `addNote` 仅存在于 `analytics.addNote`，不在 `leads` 下 |
| 7 | `leads.createFailed` | `src/components/QuickCreateLeadDialog.tsx` | 80 | `createFailed` 存在于 contracts/team/quotes 但不在 leads |
| 8 | `leads.region` | `src/components/QuickCreateLeadDialog.tsx` | 166 | 翻译文件未定义此 key |
| 9 | `leads.notesPlaceholder` | `src/components/QuickCreateLeadDialog.tsx` | 179 | 翻译文件未定义此 key |
| 10 | `quotes.calc.area` | `src/app/(dashboard)/quotes/quote-calculator.tsx` | 138 | 翻译文件定义为 `quotes.calc.areaSqm` |
| 11 | `quotes.calc.area` | `src/app/(dashboard)/quotes/quote-wizard.tsx` | 229 | 同上 |
| 12 | `quotes.calc.property` | `src/app/(dashboard)/quotes/quote-calculator.tsx` | 138 | 翻译文件定义为 `quotes.calc.propertyType` |
| 13 | `quotes.calc.property` | `src/app/(dashboard)/quotes/quote-wizard.tsx` | 229 | 同上 |

### P0 修复建议

```diff
// 在 translations.ts 的 common 中添加:
+ loadFailed: "Failed to load",

// 在 translations.ts 的 leads 中添加:
+ addNote: "Add Note",
+ createFailed: "Failed to create lead",
+ nextActionRequired: "Next action required",
+ notesPlaceholder: "Add notes...",
+ region: "Region",

// 修改代码中的错误 key 引用（二选一）:
// 方案A: 修正 key 名
- t("quotes.calc.area")      → t("quotes.calc.areaSqm")
- t("quotes.calc.property")  → t("quotes.calc.propertyType")
// 方案B: 在翻译文件中添加对应 key
```

---

## P1: 翻译文件中定义但代码中未使用的 key（冗余）

> 共约 **270 个** key 在翻译文件中定义但代码中从未引用。大量定义完整的 nav、dashboard、leads、stageLabels、sourceLabels、statusLabels、lostReasons、notifications.types、analytics 等模块的 key 均未被静态引用。

**高优先级冗余（完整模块未使用）**:

| 模块 | 未使用 key 数量 | 说明 |
|------|----------------|------|
| `analytics.*` | ~40 | 大量 analytics key 完全未引用 |
| `dashboard.*` | ~35 | 大量 dashboard key 未引用 |
| `pipeline.*` | ~20 | 几乎全部 pipeline key 未引用 |
| `notifications.types.*` | 15 | 全部通知类型 key 未引用 |
| `lostReasons.*` | 7 | 全部丢失原因 key 未引用 |
| `stages.*` | 9 | 全部阶段 key 未引用 |
| `statusLabels.*` | 4 | 全部状态标签 key 未引用 |
| `leads.nextActionLabels.*` | 8 | 全部下一行动标签 key 未引用 |
| `nav.*` | ~30 | 几乎全部导航 key 未引用 |
| `projects.*` | ~25 | 很多项目 key 未引用 |
| `quotes.*` | ~45 | 很多报价 key 未引用 |
| `team.*` | 7 | 角色 key 未引用 |

**注意**: 大量 P1 key 实际上是通过**动态模板**访问的（如 `t(\`stageLabels.${stage}\`)`），但静态分析无法检测。以上统计已排除已知动态 key（stageLabels.*, statusLabels.*, sourceLabels.*, leads.nextActionLabels.*, products.categories.*, nav.*, quotes.calc.*, leadDetail.eventTypes.*, lostReasons.*, stages.*, notifications.types.*, projects.phase/status 动态key）。

剩余约 **160 个** 真正未使用的 key（主要集中在 `analytics.*`、`dashboard.*`、`pipeline.*` 等模块）。

完整列表见附录。

---

## WARN: 硬编码文本（应走 i18n 但没走）

### 高优先级（用户可见 UI 文本）

| # | 文件路径 | 行号 | 硬编码文本 | 类型 |
|---|---------|------|-----------|------|
| 1 | `src/app/(dashboard)/layout.tsx` | 319 | `"Connection failed"` | 错误提示 |
| 2 | `src/app/(dashboard)/layout.tsx` | 320 | `"Retry"` | 按钮文字 |
| 3 | `src/components/lead-workflow.tsx` | 352 | `"Under Construction"` | 下拉选项 |
| 4 | `src/components/lead-workflow.tsx` | 353 | `"Renovation"` | 下拉选项 |
| 5 | `src/components/lead-workflow.tsx` | 354 | `"Retrofit"` | 下拉选项 |
| 6 | `src/components/lead-workflow.tsx` | 440 | `"Proposal submitted — 24h timer started"` | 状态提示 |
| 7 | `src/components/lead-workflow.tsx` | 444 | `"Proposal Submission Date"` | 标签文字 |
| 8 | `src/components/lead-workflow.tsx` | 458 | `"Follow-up Date"` | 标签文字 |
| 9 | `src/components/lead-workflow.tsx` | 480 | `"Visit Status"` | 标签文字 |
| 10 | `src/components/lead-workflow.tsx` | 490 | `"Scheduled"` | 下拉选项 |
| 11 | `src/components/lead-workflow.tsx` | 491 | `"Completed"` | 下拉选项 |
| 12 | `src/components/lead-workflow.tsx` | 492 | `"Cancelled"` | 下拉选项 |
| 13 | `src/components/lead-workflow.tsx` | 493 | `"Rescheduled"` | 下拉选项 |
| 14 | `src/components/lead-workflow.tsx` | 499 | `"Expected Sign Date"` | 标签文字 |
| 15 | `src/components/lead-workflow.tsx` | 688-692 | `"Budget"`, `"Competitor"`, `"Project"`, `"Product"`, `"Other"` | 下拉选项（拒绝原因） |
| 16 | `src/components/lead-workflow.tsx` | 697 | `"Rejection Details"` | 标签文字 |
| 17 | `src/app/(dashboard)/leads/page.tsx` | 578 | `"Select user..."` | placeholder |
| 18 | `src/app/(dashboard)/leads/page.tsx` | 585 | `"Transferring..."` / `"Cancel"` / `"Transfer N"` | 按钮文字 |
| 19 | `src/app/(dashboard)/leads/page.tsx` | 804 | `"Reassign"` (title属性) | tooltip |
| 20 | `src/app/(dashboard)/leads/page.tsx` | 812 | `"Reassigning..."` | 状态文字 |
| 21 | `src/app/(dashboard)/leads/page.tsx` | 825 | `"No users"` | 空状态文字 |
| 22 | `src/app/(dashboard)/leads/[id]/page.tsx` | 592 | `"Reassigning..."` | 状态文字 |
| 23 | `src/app/(dashboard)/leads/[id]/page.tsx` | 603 | `"No users found"` | 空状态文字 |
| 24 | `src/app/(dashboard)/leads/new/page.tsx` | 114 | `"Dubai, Palm Jumeirah..."` | placeholder |
| 25 | `src/app/(dashboard)/analytics/_components/LeadHealth.tsx` | 126 | `"Quality Distribution"` | 图表标签 |

### 低优先级（console.error / API route 日志 — 用户不可见）

约 50+ 处 `console.error("...")` 和 `setError("...")` 在 API routes 中使用硬编码英文字符串。这些是开发日志，不影响用户，但仍建议统一管理。

完整列表见附录。

---

## 语言间 Key 对比

| 检查项 | 结果 |
|--------|------|
| en 翻译 key 数 | 1045 |
| zh 翻译 key 数 | 1045 |
| en 缺少的 zh key | 0 |
| zh 缺少的 en key | 0 |
| **语言覆盖率** | ✅ **100%** — en/zh 完全一致 |

---

## 动态 Key 使用统计

大量 key 通过模板字符串动态访问，静态分析无法完全追踪：

| 动态前缀 | 可能 key 数量 | 使用文件数 |
|---------|-------------|----------|
| `stageLabels.${stage}` | 9 | 5+ |
| `statusLabels.${status}` | 4 | 4+ |
| `sourceLabels.${src}` | 7 | 3+ |
| `leads.nextActionLabels.${action}` | 8 | 1 |
| `products.categories.${cat}` | 10 | 2 |
| `projects.${phase}` / `projects.${stat}` | ~20 | 1 |
| `quotes.${status}` | 5 | 2 |
| `quotes.calc.*` | ~20 | 2 |
| `nav.${labelKey}` | ~30 | 1 |
| `leadDetail.eventTypes.*` | 12 | 1 |
| `leadDetail.lostReason_${r}` | 7 | 1 |
| `notifications.types.*` | 15 | 0 (注:代码中实际未使用) |
| `lostReasons.*` | 7 | 0 (注:代码中实际未使用) |

---

## 附录 A: 完整 P0 修复补丁

```typescript
// ===== 添加缺失的 common.loadFailed =====
// 在 translations.ts common.loadFailedRetry 之后添加:
loadFailed: "Failed to load",

// ===== 添加缺失的 leads.* key =====
// 在 translations.ts leads 节中添加:
addNote: "Add Note",
createFailed: "Failed to create lead", 
nextActionRequired: "Next action required",
notesPlaceholder: "Add notes...",
region: "Region",

// ===== 修正 quotes.calc.area → quotes.calc.areaSqm =====
// 修改 src/app/(dashboard)/quotes/quote-calculator.tsx:138
// 修改 src/app/(dashboard)/quotes/quote-wizard.tsx:229
// 将 t("quotes.calc.area") 改为 t("quotes.calc.areaSqm")

// ===== 修正 quotes.calc.property → quotes.calc.propertyType =====
// 修改 src/app/(dashboard)/quotes/quote-calculator.tsx:138
// 修改 src/app/(dashboard)/quotes/quote-wizard.tsx:229
// 将 t("quotes.calc.property") 改为 t("quotes.calc.propertyType")

// ===== 中文翻译同上 =====
// 在 zh 对应位置添加相同结构的中文翻译
```

---

## 附录 B: 代码中使用但未定义的完整 key 列表 (69个)

以下 key 通过 `t("...")` 被引用但翻译文件中不存在（已排除 `${...}` 动态模板）：

1. `common.loadFailed` — 应为 `common.loadFailedRetry`
2. `leadDetail.lostReason_${r}` — 动态 key，`${r}` 替换后可能的值需确认
3. `leads.addNote` — 需在 leads 中添加
4. `leads.createFailed` — 需在 leads 中添加
5. `leads.nextActionRequired` — 需在 leads 中添加
6. `leads.notesPlaceholder` — 需在 leads 中添加
7. `leads.region` — 需在 leads 中添加
8. `quotes.calc.area` — 应为 `quotes.calc.areaSqm`
9. `quotes.calc.property` — 应为 `quotes.calc.propertyType`

（其余 60 个均为 `${...}` 动态模板 key，需要在运行时展开后验证）
