# CRM v3 — PRD Reality Reconciliation (Demand Register)
## Date: 2026-06-27
## Status: IN PROGRESS — 只对账，不写代码

### Methodology
- 需求来源：GPT 分析输出 + Book2 原始数据 + Tanya 反馈 + Task Contracts
- 验证方式：直接查 DB / 读源码 / curl API，不接受"应该有"的假设
- 缺口判定：不存在 → ❌ 缺失 | 存在但不对 → ⚠️ 偏差 | 完全对齐 → ✅

---

| 需求ID | 来源 | 原始需求 | PRD对应 | 当前线上入口 | 当前数据状态 | 真实验证 | 缺口 | 优先级 |
|--------|------|---------|---------|-------------|-------------|---------|------|--------|
| D01 | GPT+Tanya | Book2.xlsx 正式导入 | Epic 2? | ❌ 无 Import UI | 131条lead，phone全空，import_batch_id全空，imported_by全空，raw_import_data全空 | ❌ | 导入事故：用service_role裸写，字段丢失 | P0 |
| D02 | GPT+Tanya | Mohamed旧leads归档替换 | — | ❌ | 42条已物理删除，无归档 | ⚠️ | 应soft-delete/archive而非物理删除 | P0 |
| D03 | GPT+PRD | Import UI: upload→preview→confirm | Epic 2? | ❌ /leads/import/preview API存在但前端无入口 | API路由有，前端无 | ❌ | 缺前端上传/预览/确认流程 | P1 |
| D04 | GPT+PRD | import_batch_id/imported_by/imported_at/raw_import_data | — | — | 四字段全NULL（131条） | ❌ | 导入未写batch追踪 | P0 |
| D05 | GPT+PRD | phone/notes/first_contact_date/poor_lead_reason保留 | PRD 3.3 | ✅ lead详情有phone/notes字段 | phone: Book2导入的phone全空；first_touch_at: 部分有；notes: 部分有 | ⚠️ | phone丢失是P0，其他部分有 | P0 |
| D06 | GPT+Tanya | assigned_to分配规则：销售自建/老板分配，不自动 | PRD 3.2 | ⚠️ 已停auto-assign | 131条全未分配 | ⚠️ | 停了自动，但人工分配入口不清楚 | P1 |
| D07 | GPT+Tanya | Boss/Admin删除或归档leads入口 | PRD 6 | ⚠️ 刚加Trash2按钮 | 详情页+列表页有删除按钮 | ⚠️ | 是物理删除非soft-delete；缺archive原因；缺audit | P0 |
| D08 | GPT+Tanya | Sales不能误删 | PRD 6 | ✅ RLS已限制 | Sales只能删自己名下 | ⚠️ | RLS OK但sales不该有删除权限——应该只有archive | P0 |
| D09 | GPT+Tanya | Archive/delete reason + audit | PRD 6 | ❌ | 无原因字段，无audit | ❌ | 缺失 | P0 |
| D10 | GPT+Tanya | Assem销售账号/归属/leaderboard | — | ✅ Assem已加入 | profiles有，role=sales | ✅ | — | — |
| D11 | GPT+Tanya | Contacted定义：什么动作算contacted | PRD 4.2 | ❌ | 无文档/无约束 | ❌ | contacted可被任意标记，无业务规则 | P1 |
| D12 | GPT+原始数据 | Poor Lead标记+原因 | Book2 Status字段 | ⚠️ quality枚举有'poor' | leads.quality可设poor但无reason字段 | ⚠️ | 缺poor_lead_reason字段和UI | P1 |
| D13 | PRD 4.1 | Stage notes进入timeline | Epic 3 | ✅ Timeline已有 | follow_up_logs+activities+business_events合并显示 | ✅ | — | — |
| D14 | GPT+Tanya | Project Info保存/回显 | PRD 3.3折叠区 | ⚠️ 详情页「项目信息」Tab可编辑 | project_type/emirate/area等字段存在 | ⚠️ | 字段有但未按PRD折叠面板布局 | P2 |
| D15 | GPT+Tanya | Dashboard ownership/leaderboard Tanya可见 | Epic 5 | ⚠️ /dashboard存在 | — | ⚠️ | 需确认Tanya可见销售归属 | P1 |
| D16 | GPT+PRD | Workbench/Leads销售入口 | Epic 2 | ✅ /workbench已设为销售默认 | — | ✅ | — | — |
