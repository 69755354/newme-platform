# Lead Detail 三栏重构方案

## 目标
将 `src/app/(dashboard)/leads/[id]/page.tsx` (1924行) 从当前"Tab堆叠+右侧栏"布局重构为 PRD v3.2 定义的三栏布局。

## PRD 规格 (v3ui导航页面结构prd.txt 第491-558行)

### 左栏：Customer Profile
1. Name
2. Phone
3. WhatsApp (用phone字段，显示为可点击WhatsApp链接)
4. Email
5. Source
6. Project Type
7. Project Status
8. Emirate
9. Area
10. Budget
11. Expected Sign Date
12. Owner (assigned_to + reassign下拉)

### 中栏：Sales Process
1. Current Milestone (7-step checklist)
2. Next Required Action (nextTask)
3. Missing Required Fields (根据stage判断必填字段)
4. Stage Progress (stage badge + progress bar)
5. Quote Link (quotation_value + 跳转报价)
6. Contract Link (如果won)
7. Payment Link (如果有合同)

### 右栏：Timeline
1. Lead Created
2. First Contact
3. Follow-up Notes (follow_up_logs)
4. Stage Changes
5. Quote Sent
6. Documents Uploaded (暂用占位)
7. Won / Lost
8. Contract Created
9. Payment Recorded
+ WhatsApp Chat Bubbles (chat_messages)
+ Add Note 输入框

### 底部折叠 (保留现有renderFoldingPanel)
1. Notes (已有addNote)
2. Documents (占位 Coming Soon)
3. Quotes (已有QuoteCalculator)
4. Tasks (显示该lead的所有tasks列表)
5. Activity Logs (activities + business_events)

### 强制规则 (阶段推进前验证 — 本次先实现显示，不阻断)
- Missing Required Fields 面板显示当前stage缺少哪些必填字段

## 文件拆分方案

### 新建文件
```
src/app/(dashboard)/leads/[id]/
├── page.tsx                    # 主页面: 数据获取 + 状态 + 布局框架
├── types.ts                    # Lead/Activity/Task等接口 + STAGES/STAGE_COLORS
├── utils.ts                    # fmtAED, daysSince, projectDraftFromLead
├── LeadCustomerProfile.tsx     # 左栏: Customer Profile
├── LeadSalesProcess.tsx        # 中栏: Sales Process
├── LeadTimeline.tsx            # 右栏: Timeline + Add Note + WhatsApp
├── LeadFoldingPanel.tsx        # 底部折叠面板 (重构自renderFoldingPanel)
├── LeadContractsPanel.tsx      # 已存在, 保留
```

### page.tsx 职责 (精简后)
1. 数据获取 (fetchData)
2. 所有状态 (useState)
3. 所有事件处理器 (updateField, addNote, toggleMilestone, handleWon, etc.)
4. 传递 props 给子组件
5. 渲染布局框架:
```
<div className="max-w-7xl space-y-6">
  {/* Header: back button + name + status badge + delete */}
  <header>...</header>
  
  {/* Three-column grid */}
  <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
    <aside className="lg:col-span-3 space-y-4">
      <LeadCustomerProfile ... />
    </aside>
    <main className="lg:col-span-5 space-y-4">
      <LeadSalesProcess ... />
    </main>
    <aside className="lg:col-span-4 space-y-4">
      <LeadTimeline ... />
    </aside>
  </div>
  
  {/* Bottom folding panels */}
  <LeadFoldingPanel ... />
</div>
```

### 布局响应式
- Desktop: 3栏 (3/5/4 比例)
- Tablet: 2栏 (左栏折叠到中栏上方, 右栏占满)
- Mobile: 单栏堆叠

## 中栏 Sales Process 详细规格

### Current Milestone (复用LeadTimelineAndMilestones的milestones逻辑)
- 7-step checklist, 已完成/未完成/锁定状态
- 点击可toggle

### Next Required Action
- 显示nextTask (title + due_at)
- 逾期标红
- 可编辑(inline edit)
- 无task时显示"Set next follow-up"

### Missing Required Fields (新面板)
根据当前stage判断:
- `new` → customer_name 必填
- `contacted` → customer_name, phone 必填
- `requirement_confirmed` → customer_name, phone, project_type, project_status, location 必填
- `solution_submitted` → 上面 + ai_summary/smart_requirements
- `quotation_submitted` → 上面 + quotation_value > 0
- `won` → 上面 + 合同存在 (从leadTrace判断)
- `lost` → lost_reason 必填

每个缺失字段显示为红色warning，可点击直接编辑(复用renderInlineEdit)。

### Stage Progress
- Stage badge (带颜色)
- 阶段切换按钮组 (复用现有STAGES数组)
- Won/Lost 按钮

### Quote Link
- 显示 quotation_value
- "Create Quote" 按钮 → 打开QuoteCalculator
- 如果已有quotation, 显示链接

### Contract Link
- 仅在 final_status === "won" 时显示
- "Create Contract" 按钮
- 如果已有合同 (leadTrace), 显示合同信息

### Payment Link
- 仅在 leadTrace 有 payment_id 时显示
- 显示支付金额和状态

## 右栏 Timeline 详细规格

### Add Note (顶部)
- Textarea + Send 按钮
- 复用现有 addNote 逻辑

### WhatsApp Chat (如有chatMessages)
- 复用现有chat bubbles渲染

### Activity Feed
- 合并 activities + events + followUpLogs
- 按时间倒序
- 复用现有时间线条目渲染

## 底部折叠面板

保留现有6个panel结构，但:
- 添加 "Tasks" panel: 显示该lead的所有tasks (不仅是nextTask)
- "Documents" 保持 Coming Soon
- "Drawings" 保持 Coming Soon

## 删除项
- 移除Tab系统 (TABS数组 + activeTab状态 + tab bar)
- TabOverview/TabDetails/TabWorkflow/TabTimeline/TabTrace 函数全部移除
- 其内容重新分配到三栏中:
  - TabOverview → 分散到中栏(Stage Progress/Actions)和左栏(基本信息)
  - TabDetails → 左栏CustomerProfile + 折叠面板
  - TabWorkflow → 中栏Milestones
  - TabTimeline → 右栏Timeline
  - TabTrace → 中栏Quote/Contract/Payment Links

## 不变项
- LeadContractsPanel.tsx — 保持
- KnxDesignPanel — 保持 (放到底部折叠或中栏底部)
- QuoteCalculator — 保持
- LeadWorkflow — 不再需要(被Milestones替代)，但保留文件

## 注意事项
1. 不要改变任何API调用逻辑，只是重组UI
2. 不要改变任何状态管理逻辑，只是移动渲染位置
3. 所有inline edit功能保持正常工作
4. i18n key保持使用，新增的文案也需要i18n
5. 所有supabase操作保持原样
6. 保持暗色主题配色
