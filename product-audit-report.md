# NewMe CRM 产品总监审计报告

**审计日期**: 2026-06-02  
**审计范围**: 功能完整度、i18n覆盖、UX质量、数据正确性、业务流程闭环  
**审计方法**: 逐页面源码审查（11个页面 + 4个API路由 + i18n系统 + 品牌配置）

---

## 1 功能完整度（Function Completeness）

### 1.1 /dashboard — 驾驶舱

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| D-01 | 9阶段漏斗可视化 | ✅ PASS | 正确的9阶段条状图，可跳转 | dashboard/page.tsx:254-278 |
| D-02 | 6个KPI指标卡 | ✅ PASS | 管道金额、加权、本月成交、转化率、黄/红预警 | :177-184 |
| D-03 | 3个管理卡片 | ✅ PASS | Recovery/Transfer/Review | :186-190 |
| D-04 | 归因摘要 | ✅ PASS | 按来源平台汇总 | :306-335 |
| D-05 | 客户状态分布 | ✅ PASS | Hot/Warm/Cold/Dormant | :411-432 |
| D-06 | 概率分布 | ✅ PASS | 10/30/50/70/90 | :435-451 |
| D-07 | 阶段流失率 | ⚠️ WARN | 显示的是"留存率"而非"流失率"，标签混淆 | :280-302 |
| D-08 | 收入预测 | ❌ FAIL | 无任何月度/季度预测 | — |
| D-09 | 团队绩效 | ❌ FAIL | 无按负责人统计 | — |
| D-10 | 趋势图表 | ❌ FAIL | 全是静态快照，无时间趋势 | — |

### 1.2 /leads — 线索看板（Kanban）

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| L-01 | 9阶段Kanban列 | ✅ PASS | 7个活跃+Won+Lost | leads/page.tsx:365-613 |
| L-02 | 管道总览条 | ✅ PASS | 9阶段缩略条 | :278-295 |
| L-03 | 多重筛选 | ✅ PASS | 阶段/来源/状态/概率/预警/管理标记 | :298-357 |
| L-04 | 搜索功能 | ✅ PASS | 按名称/电话/区域 | :299-303 |
| L-05 | 行内阶段编辑 | ✅ PASS | 点击展开阶段选择器 | :487-497 |
| L-06 | 快速推进按钮 | ✅ PASS | 卡片上显示下一阶段箭头 | :464-469 |
| L-07 | 行内状态编辑 | ✅ PASS | 四色状态选择 | :544-556 |
| L-08 | 行内概率编辑 | ✅ PASS | 5级概率选择 | :530-541 |
| L-09 | 行内下一步行动编辑 | ✅ PASS | 输入框编辑 | :573-582 |
| L-10 | 行内跟进日期编辑 | ✅ PASS | Date picker | :585-594 |
| L-11 | 行内备注 | ✅ PASS | 快捷备注输入 | :597-605 |
| L-12 | 输单原因选择 | ✅ PASS | Lost阶段显示 | :519-524 |
| L-13 | 页面标题翻译错误 | ❌ FAIL | 使用 `t("pipeline.title")` 应为 `t("leads.title")` | :261 |
| L-14 | 无分页 | ⚠️ WARN | 仅limit 500 | :118 |
| L-15 | 无批量操作 | ❌ FAIL | 不能批量选择/编辑线索 | — |

### 1.3 /leads/[id] — 线索详情

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| LD-01 | 客户信息展示 | ✅ PASS | 姓名/电话/邮箱/位置/房产 | [id]/page.tsx:184-201 |
| LD-02 | 决策信息 | ✅ PASS | 决策人/竞争对手/决策日期/概率 | :255-318 |
| LD-03 | 跟进管理 | ✅ PASS | 最后联系/跟进次数/下次跟进/下一步 | :321-371 |
| LD-04 | 输单原因 | ✅ PASS | 7种原因选择，含时间戳 | :375-401 |
| LD-05 | 归因数据 | ✅ PASS | 19个归因字段 | :404-440 |
| LD-06 | 活动时间线 | ✅ PASS | 合并activities+events | :443-498 |
| LD-07 | 阶段/状态快速操作 | ✅ PASS | 右侧栏可切换阶段和状态 | :510-539 |
| LD-08 | 创建报价 | ✅ PASS | 按钮触发quote创建 | :543-547 |
| LD-09 | 主管管理 | ✅ PASS | Review/Recovery/Transfer标记 | :566-627 |
| LD-10 | AI摘要 | ✅ PASS | 显示ai_summary和tags | :237-252 |
| LD-11 | 基本字段编辑 | ❌ FAIL | 不能编辑客户名称、电话、邮箱、房产类型 | — |
| LD-12 | 删除线索 | ❌ FAIL | 无删除功能 | — |
| LD-13 | 标记为成交 | ❌ FAIL | 仅能标记输单，不能标记成交（需确认金额） | — |

### 1.4 /leads/new — 新建线索

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| LN-01 | 基本信息表单 | ✅ PASS | 姓名/电话/邮箱/位置/来源/备注 | new/page.tsx:60-129 |
| LN-02 | i18n覆盖 | ❌ FAIL | 全部中文硬编码 | :52-54,57,62,71,80,89,98-109 |
| LN-03 | 房产信息 | ❌ FAIL | 缺少property_type/size/budget_range/service_needs | — |
| LN-04 | 状态/概率 | ❌ FAIL | 不能预设 lead_status/win_probability | — |
| LN-05 | 跟进计划 | ❌ FAIL | 不能预设 next_action/next_followup_date | — |
| LN-06 | 归因字段 | ❌ FAIL | 不能填写广告归因数据 | — |

### 1.5 /pipeline — 管道分析

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| P-01 | 9阶段递进表格 | ✅ PASS | 数量/金额/概率/加权/热/停滞/recovery/transfer/review | pipeline/page.tsx:147-211 |
| P-02 | 流失分析 | ✅ PASS | 阶段间转化率和流失率 | :214-241 |
| P-03 | 概率分布 | ✅ PASS | 5级金额柱状图 | :244-271 |
| P-04 | 停滞分析 | ✅ PASS | 按阶段停滞分布 | :274-301 |
| P-05 | 汇总卡片 | ✅ PASS | Won/Lost/停滞/加权金额 | :128-143 |
| P-06 | 管道速度 | ❌ FAIL | 无阶段停留时间/速度分析 | — |
| P-07 | 预测功能 | ❌ FAIL | 无加权收入预测 | — |

### 1.6 /ads — 广告归因

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| A-01 | 4种归因视图 | ✅ PASS | Source/Campaign/Adset/Ad | ads/page.tsx:58-66 |
| A-02 | 5个汇总指标 | ✅ PASS | 总/有效/已报价/成交/金额 | :110-132 |
| A-03 | 归因表格 | ✅ PASS | 含有效率和转化率 | :154-198 |
| A-04 | 筛选/搜索 | ✅ PASS | 名称搜索 | :136-151 |
| A-05 | 日期范围筛选 | ❌ FAIL | 无时间维度筛选 | — |
| A-06 | 成本数据 | ❌ FAIL | 无广告花费 → 无法计算ROI | — |
| A-07 | Meta集成 | ❌ FAIL | Meta CAPI route有TODO未完成 | api/leads/meta-capi:40-41 |

### 1.7 占位页面

| # | 页面 | 状态 | 详情 |
|---|------|------|------|
| PL-01 | /messages | ❌ FAIL | 硬编码中文占位，无i18n |
| PL-02 | /projects | ❌ FAIL | 硬编码中文占位，无i18n |
| PL-03 | /quotes | ❌ FAIL | 硬编码中文占位，无i18n |

### 1.8 /login — 登录

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| LG-01 | 基础登录功能 | ✅ PASS | Email+密码验证 | login/page.tsx:20-61 |
| LG-02 | i18n覆盖 | ❌ FAIL | 全部中文硬编码 | :70-71,76,88,99,105 |
| LG-03 | 安全风险 | ⚠️ WARN | 直接REST API调用 + 明文保存session到localStorage | :26-53 |
| LG-04 | 无remember me | ⚠️ WARN | 无"记住我"功能 | — |

---

## 2 i18n 覆盖审计（Internationalization）

### 2.1 翻译字典覆盖

翻译字典位于 `src/lib/i18n/translations.ts`，共 430 行。

| # | 检查项 | 状态 | 详情 |
|---|--------|------|------|
| I-01 | en/zh 键值对称 | ✅ PASS | 所有en键在zh中存在 |
| I-02 | 翻译键命名规范 | ✅ PASS | 按模块分common/nav/dashboard/leads等 |
| I-03 | 参数插值支持 | ✅ PASS | `{n}` 模板字符串正确 |

### 2.2 页面i18n覆盖

| # | 页面 | 状态 | 行号 | 修复建议 |
|---|------|------|------|----------|
| I-10 | /dashboard | ✅ PASS | 全部使用 `t()` | — |
| I-11 | /leads（看板） | ⚠️ WARN | 混用 `t()` / `(t as any)()` / `lang === "zh"` 三元 | 统一用 `t()` |
| I-12 | /leads/[id] | ⚠️ WARN | 混用 `(t as any)()` 和 `lang === "zh"` | 统一用 `t()` |
| I-13 | **/leads/new** | ❌ FAIL | 全部硬编码中文 | 必须全部替换为 `t()` |
| I-14 | /pipeline | ✅ PASS | 基本用 `t()` | — |
| I-15 | /ads | ✅ PASS | 用 `t()` | — |
| I-16 | **/login** | ❌ FAIL | 全部硬编码中文 | 需要LanguageProvider包装 |
| I-17 | **Placeholder页** | ❌ FAIL | 硬编码中文 | 使用 `t()` |
| I-18 | **Root layout** | ❌ FAIL | `<html lang="zh">`固定 | 应根据 `lang` 动态设置 |
| I-19 | **Metadata** | ❌ FAIL | `title: "NewMe 业务平台"` 固定中文 | 应动态切换 |

### 2.3 具体i18n遗漏

| # | 位置 | 硬编码内容 | 行号 |
|---|------|-----------|------|
| I-30 | layout.tsx nav | "消息","项目","报价"（仅i18nNavItems数组） | :32-34 |
| I-31 | layout.tsx subtitle | `{t("common.loading") === "Loading..." ? "业务平台" : "CRM Platform"}` 错误逻辑 | :59 |
| I-32 | layout.tsx Suspense | "加载中..." | :89 |
| I-33 | leads/page.tsx filter | "全部阶段","全部来源","全部状态" | :306-317 |
| I-34 | leads/page.tsx | "管道总览" vs "Pipeline Overview" | :267 |
| I-35 | leads/page.tsx | "活跃 · 管道" vs " Active · Pipeline " | :262 |
| I-36 | leads/page.tsx | "条结果" vs " results" | :356 |
| I-37 | leads/page.tsx | "下一步行动 *必填" placeholder | :575 |
| I-38 | leads/page.tsx | "添加备注..." placeholder | :599 |
| I-39 | leads/page.tsx | "Recovery","Transfer" filter badges | :341-348 |
| I-40 | lead detail | "Recovery Candidate","Transfer Candidate" | [id]/page.tsx:581-582 |
| I-41 | lead detail | "Hold Since" | :603 |
| I-42 | lead detail | "Update Stage","Manager Section" | :511,569 |
| I-43 | lead detail | "Auto Rules"区块文字 | :618-623 |
| I-44 | login/page.tsx | "登录你的工作账号","登录"等全部文字 | 全文 |
| I-45 | new lead | 全部字段标签 | 全文 |

---

## 3 UX 质量审计

### 3.1 加载态

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| UX-01 | Loading文字 | ⚠️ WARN | 无Skeleton骨架屏，仅文字 |
| UX-02 | Suspense fallback | ❌ FAIL | layout.tsx:89 硬编码中文"加载中..." |
| UX-03 | 数据加载超时 | ❌ FAIL | 无超时/重试机制 |

### 3.2 空状态

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| UX-10 | kanban空列 | ✅ PASS | 显示`—`占位 |
| UX-11 | 无活动记录 | ✅ PASS | 显示"暂无活动记录" |
| UX-12 | 无搜索结果 | ✅ PASS | 显示"暂无结果" |
| UX-13 | 无预警 | ✅ PASS | 显示"暂无预警" |
| UX-14 | 无停滞线索 | ✅ PASS | 显示🎉 |
| UX-15 | **空状态视觉设计** | ❌ FAIL | 全是纯文字，无插图或引导CTA |

### 3.3 错误处理

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| UX-20 | Supabase查询异常 | ❌ FAIL | 所有页面无try-catch，查询失败静默吞掉 |
| UX-21 | 网络错误 | ❌ FAIL | 无任何错误提示toast |
| UX-22 | 表单验证 | ❌ FAIL | New Lead页无字段验证 |
| UX-23 | 错误边界 | ❌ FAIL | 无React Error Boundary |

### 3.4 交互细节

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| UX-30 | 行内编辑可点击区域 | ⚠️ WARN | 需要点到具体按钮，无双击编辑 |
| UX-31 | 阶段变更无确认 | ⚠️ WARN | 点击即变更，无二次确认 |
| UX-32 | 无Toast通知 | ⚠️ WARN | 操作后无成功/失败反馈 |
| UX-33 | Kanban水平滚动 | ✅ PASS | 移动端可滑动 |
| UX-34 | 响应式布局 | ✅ PASS | Grid自适应 |
| UX-35 | 移动端导航 | ✅ PASS | 汉堡菜单+遮罩层 |

### 3.5 无障碍/可访问性

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| UX-40 | 颜色对比度 | ✅ PASS | 暗色主题+铜色强调 |
| UX-41 | aria标签 | ❌ FAIL | 大量按钮无aria-label |
| UX-42 | 键盘导航 | ❌ FAIL | 行内编辑器键盘支持有限 |

---

## 4 数据正确性审计

### 4.1 数值计算

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| D-01 | 管道过滤正确 | ✅ PASS | 排除won/lost | dashboard:93 |
| D-02 | 加权计算正确 | ✅ PASS | `value * prob / 100` | :95 |
| D-03 | 本月成交正确 | ✅ PASS | 按月份过滤 | :98-99 |
| D-04 | 预警逻辑正确 | ✅ PASS | 7-14天黄, 14天+红 | :103-110 |
| D-05 | 高概率停滞正确 | ✅ PASS | >=70% + 14天 | :120-123 |
| D-06 | Pending停滞正确 | ✅ PASS | >30天 | :126-130 |
| D-07 | 流失率标签混淆 | ❌ FAIL | 显示的rate是"递进率"而非"流失率" | :292 |

### 4.2 阶段系统一致性

| # | 项目 | 状态 | 详情 | 行号 |
|---|------|------|------|------|
| D-10 | generate-quote API使用"quoted" | ❌ FAIL | 应为"quotation_submitted"，与9阶段不匹配 | api/hermes/generate-quote/route.ts:84 |
| D-11 | 页面标题错用 | ❌ FAIL | /leads页面标题用`t("pipeline.title")` | leads/page.tsx:261 |
| D-12 | 阶段常量重复定义 | ⚠️ WARN | dashboard/leads/pipeline/lead-detail各自定义STAGES | 多文件 |

### 4.3 数据完整性

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| D-20 | leads表limit 500 | ⚠️ WARN | 数据量增长后可能漏数据 |
| D-21 | Meta CAPI未完整实现 | ❌ FAIL | Supabase写入代码被注释 |
| D-22 | 线索总数266 vs 展示 | ⚠️ WARN | 所有页面取全部数据，无分页 |

---

## 5 业务流程闭环审计

### 5.1 线索生命周期

```
录入 → 跟进 → 需求确认 → 方案 → 报价 → 谈判 → 决策 → 成交/输单
```

| # | 环节 | 状态 | 详情 |
|---|------|------|------|
| B-01 | 线索录入 (New) | ⚠️ WARN | new/page.tsx表单缺失字段，已录入线索无法编辑基本信息 |
| B-02 | 已联系 (Contacted) | ✅ PASS | 可通过阶段变更推进 |
| B-03 | 需求确认 | ✅ PASS | 阶段推进可用 |
| B-04 | 方案提交 | ✅ PASS | 阶段推进可用 |
| B-05 | 报价提交 | ❌ FAIL | createQuote()插入空报价，generate-quote API用"quoted"而非"quotation_submitted" |
| B-06 | 谈判 | ✅ PASS | 阶段推进可用 |
| B-07 | 待决策 | ✅ PASS | 有hold_since时间跟踪 |
| B-08 | 成交 (Won) | ❌ FAIL | 无"标记为成交"功能，只能手动设阶段 |
| B-09 | 输单 (Lost) | ✅ PASS | 有lost_reason和lost_at |
| B-10 | 恢复/转移池 | ✅ PASS | Recovery/Transfer标记可用 |

### 5.2 关键断点

| # | 断点 | 严重度 | 详情 |
|---|------|--------|------|
| B-20 | 新建线索信息不全 | HIGH | 无法录入房产类型/面积/预算/服务需求 |
| B-21 | 线索信息无法编辑 | HIGH | 详情页不能编辑姓名/电话/邮箱/房产 |
| B-22 | 报价阶段不一致 | HIGH | 页面用"quotation_submitted"，API用"quoted" |
| B-23 | 无成交确认流程 | HIGH | Won阶段无金额确认/时间记录 |
| B-24 | 无线索删除/归档 | MEDIUM | 无法移除垃圾数据 |
| B-25 | 无批量操作 | MEDIUM | 无法批量推进/分配/标记 |
| B-26 | 占位页面无功能 | LOW | 消息/项目/报价页为空 |
| B-27 | 自动化规则在前端伪实现 | MEDIUM | Auto Rules块在详情页仅展示文案，无实际自动化执行 |

### 5.3 缺失的核心场景

| # | 场景 | 必要性 | 说明 |
|---|------|--------|------|
| B-30 | 月度收入预测 | 关键 | 管理者核心需求，当前无任何预测 |
| B-31 | 团队绩效看板 | 重要 | 按销售负责人统计跟进/成交 |
| B-32 | 报价单/合同 | 重要 | 占位页无实际功能 |
| B-33 | 项目管理 | 重要 | 成交后项目跟踪（占位页） |
| B-34 | 消息中心 | 一般 | WhatsApp集成（占位页） |
| B-35 | 活动自动化 | 重要 | 自动生成business_events逻辑在客户端实现，服务器端无保障 |

---

## 6 品牌与样式一致性

| # | 项目 | 状态 | 详情 |
|---|------|------|------|
| BR-01 | 暗底 #1E2328 | ✅ PASS | globals.css正确配置 |
| BR-02 | 铜色 #D4A373 | ✅ PASS | 完整色阶，primary使用铜色 |
| BR-03 | 酒红 #9B2D5E | ✅ PASS | wine色阶，destructive使用酒红 |
| BR-04 | 货币 AED | ✅ PASS | fmtAED函数统一格式化 |
| BR-05 | CSS类名动态拼接 | ⚠️ WARN | `bg-${color}-500/20` 模式在Tailwind v4中可能失效 |

---

## 7 优先级修复建议

### P0 — 业务正确性（立即修复）

1. **generate-quote API阶段错误**: `api/hermes/generate-quote/route.ts:84` — 将 `"quoted"` 改为 `"quotation_submitted"`
2. **Leads页面标题错误**: `leads/page.tsx:261` — 将 `t("pipeline.title")` 改为 `t("leads.title")`
3. **流失率显示混淆**: `dashboard/page.tsx:290-293` — 将主数字改为drop-off率(100-rate)而不是retention率(rate)
4. **阶段常量去重**: 将STAGES定义统一到共享文件中，避免4处重复定义

### P1 — i18n国际化（尽快修复）

1. **New Lead页面**: 全部字段标签替换为 `t()` 调用
2. **Login页面**: 用LanguageProvider包装，使用 `t()` 调用
3. **Root layout**: `<html lang="zh">` 改为动态 `lang` 属性
4. **Sidebar导航**: "消息"、"项目"、"报价" 硬编码改为 `t()` 调用
5. **全站 `(t as any)` 替换**: 统一为类型安全的 `t()` 调用

### P2 — 功能补齐（中期）

1. **New Lead表单完善**: 增加property_type/property_size_sqm/budget_range/service_needs/lead_status/win_probability字段
2. **线索详情可编辑**: 增加客户姓名/电话/邮箱/房产信息的行内编辑
3. **标记成交流程**: 增加Won阶段专用流程（确认金额、日期）
4. **删除线索**: 增加删除/归档功能
5. **错误边界**: 全局Error Boundary + Toast通知

### P3 — UX增强（长期）

1. **Skeleton骨架屏**: 替代纯文字Loading
2. **数据空状态插图**: 增加视觉引导
3. **收入预测仪表板**: 按阶段/时间的加权预测
4. **团队绩效视图**: 按owner统计
5. **日期范围筛选**: 广告归因/管道分析增加时间维度
6. **批量操作**: 批量阶段推进/状态变更
7. **自动化规则后端化**: Auto Rules从前端展示移到后端定时任务
