# NewMe V4 前端设计系统与关键屏幕规格

状态：Target；基于已合并 PR #256 的治理契约；在现有 NewMe 视觉与组件基础上收敛，不建立第二套 UI 栈
最终上游复核：2026-08-04；current canonical `858a4ccb51697b4b4499252bfa3c22963381847e`

## 1. 当前设计事实

### 可复用基础

- 字体：本机 `Geist-Variable.woff2` 与 `GeistMono-Variable.woff2`，通过 `next/font/local` 加载。
- 图标：`lucide-react`；`components.json` 也声明 `lucide`。
- 组件：18 个 `src/components/ui/*.tsx` 原语，覆盖 Avatar、Badge、Button、Card、Collapsible、Dialog、Dropdown、Error State、Input、Label、Select、Separator、Sheet、Skeleton、Table、Tabs、Textarea、Tooltip。
- 主题：CSS variables 已定义 light/dark；light 的背景/前景是 `#F5F3EF` / `#1E1B18`，surface 为白色，primary 为 `#4A5568`；dark 使用深石板背景和 `#D4A373` 金铜色 primary。
- 圆角：根 token `--radius: 0.75rem`，已有派生 scale。
- 布局：dashboard shell、sidebar、topbar、统一滚动容器与响应式 sheet 已存在。
- 语言：已有 `LanguageProvider` 与大量中英文 key。

### 需要收敛的事实

- 管理/销售导航是无分组平铺列表；没有持续可见的组织、垂直和位置上下文。
- 24 个 dashboard 页面中 23 个使用统一滚动容器，但旧 `quotations/page.tsx` 未使用。
- `text-[10px]`/`[11px]`/`[12px]` 在 TSX 中合计 259 次，说明辅助字号缺少可控语义层。
- 至少 3 个文件各自定义名为 `StatCard` 的本地组件；KPI/状态卡样式仍由页面独立维护。
- 登录页硬编码黑/灰/金视觉，dashboard 默认 light token；需要明确“认证壳层”与“应用壳层”关系。
- 现有工作台数据丰富但并列卡片过多，信息重复且缺少统一主动作。

## 2. 设计方向

三个关键词：**安静、确定、专业**。

- 安静：减少同时竞争的彩色卡片和 KPI；让重要异常获得视觉权重。
- 确定：状态、下一步、截止、影响和结果语言明确；不使用含糊 AI 魔法文案。
- 专业：保留暖灰、石板、金铜的 NewMe 资产，用材质和排版层级表达高级感，不用装饰性渐变或房地产图库堆砌。

垂直感来自术语、字段、状态机、工作动作和证据，不靠给房地产/零售各发明一套颜色或图标主题。

## 3. Token 合约

### 3.1 颜色

保留现有 root token 数值，新增语义别名，页面只引用语义：

| 语义 | 映射原则 | 用途 |
|---|---|---|
| `canvas` | `background` | 应用背景 |
| `surface` | `card` | 主面板、表格、工作项 |
| `surface-subtle` | `muted`/`secondary` | 次级分区、hover |
| `text-primary` | `foreground` | 主要文字 |
| `text-secondary` | `muted-foreground` | 辅助文字 |
| `action-primary` | light 用当前 slate primary；dark/auth 可用现有 gold primary | 主动作 |
| `brand-accent` | 现有 copper/gold token | 品牌点缀、选中强调；不表示成功 |
| `status-info` | 统一信息 token | 普通提示 |
| `status-success` | 统一成功 token | 已完成/健康 |
| `status-warning` | 统一警告 token | 即将到期/需注意 |
| `status-danger` | `destructive` 族 | 阻断/失败/高风险 |
| `focus-ring` | `ring` | 键盘焦点 |

规则：

- 每个状态组件同时显示文字或图标；色彩是辅助信号。
- 图表使用当前 `chart-1..5`，并验证相邻系列可区分；同一语义跨页面颜色不变。
- 房地产和零售不各自硬编码主色，避免切换垂直后像不同产品。
- 登录页可保留 dark auth shell，但 Button、Input、Error、Focus 使用同一语义 token；不再在页面写 `bg-black`、`gray-950` 等孤立值。

### 3.2 字体

字体家族保持 Geist Sans；数据 ID、SKU、permit、金额对齐可用 Geist Mono。

| Token | 建议尺寸/行高 | 用途 |
|---|---|---|
| `display` | 32/40，600 | 极少使用的关键数字/空状态 |
| `title-lg` | 24/32，600 | 页面标题 |
| `title-md` | 20/28，600 | 工作区/记录标题 |
| `title-sm` | 16/24，600 | 面板标题 |
| `body` | 14/22，400 | 默认正文、表格、表单 |
| `body-strong` | 14/22，600 | 重点正文 |
| `label` | 13/18，500 | 字段/控件标签 |
| `meta` | 12/18，400/500 | 时间、ID、辅助信息 |

不新增 10/11 px 产品文字。若法律/打印等特殊场景确需更小字号，必须有单独验收与放大策略。

### 3.3 间距、尺寸与密度

- 基础单位 4 px；允许 4、8、12、16、20、24、32、40、48、64。
- 页面边距：mobile 16；tablet 20；desktop 24；高密度数据区内部仍使用 12/16。
- 独立控件桌面最小高度 40 px、移动端 44 px；图标按钮可视框与点击框分离。
- panel 间距 16；页面 section 间距 24；主标题到底部内容 20–24。
- 提供 `comfortable` 与 `compact` 两种经设计系统验证的密度；默认 comfortable。compact 只用于数据表/队列且不缩小点击目标和字号。

### 3.4 圆角、边框与阴影

- 沿用 `--radius` 派生 scale；输入、按钮、卡片不得写任意 `rounded-[x]`。
- 默认 surface 用 1 px border；静态面板不同时堆 border 与重阴影。
- 阴影仅表达层级：popover/dialog > sticky bar > surface；工作项优先级不用阴影表示。

### 3.5 动画

- 反馈 120–180 ms，布局展开 180–240 ms；不使用持续漂浮或大幅位移。
- 队列完成后先播报结果，再移动到下一项；`prefers-reduced-motion` 下取消位移。
- loading skeleton 与最终结构同形，避免大幅 layout shift。

## 4. 核心组件契约

### 4.1 Shell 与导航

| 组件 | 必备内容 | 行为 |
|---|---|---|
| `AppShell` | Sidebar、Topbar、scroll boundary、toast/live region | 保留现有 shell，统一页面 inset |
| `ContextSwitcher` | 组织、垂直、位置、角色摘要 | 切换前验证；切换后清空旧投影与缓存；移动端使用 Dialog/Sheet |
| `GroupedNav` | 分组、active、badge、disabled reason | entitlement/capability 裁剪；不显示无权限数据计数 |
| `GlobalCommand` | 搜索、最近项、允许动作 | 结果限当前 context；键盘打开/关闭和焦点恢复 |
| `PageHeader` | 标题、说明、breadcrumb、最多一个 primary CTA | mobile 自动换行；CTA 语义一致 |
| `ContextBar` | 保存的筛选、范围、as-of、刷新状态 | 不把筛选藏在图表内部 |

### 4.2 工作与行动

| 组件 | 必备字段 | 状态 |
|---|---|---|
| `WorkQueue` | 队列标题、总数、过滤、排序解释、项目列表 | loading/empty/error/stale |
| `WorkItem` | title、record、priority、why now、due、owner、primary action | ready/in progress/snoozed/blocked/approval pending |
| `ActionPanel` | action label、required inputs、impact、result | L1/L2/L3/L4 变体 |
| `ReasonList` | reason code 对应人话、evidence link、policy version | 预测/规则来源清楚 |
| `DispositionMenu` | snooze/skip/reassign/feedback | 强制 reason；危险动作不放入普通菜单 |
| `CompletionReceipt` | 成功事件、状态变化、生成的下一项、request ID | 可复制审计引用，不含秘密 |
| `ApprovalPanel` | requester、impact、evidence、approvers、decision reason | actor separation、过期、撤回 |

`WorkItem` 卡片默认只显示一个实心主动作，最多两个文字/outline 次动作。点击卡片打开记录上下文；主动作不能依赖卡片点击的隐含行为。

### 4.3 记录与状态

| 组件 | 用途 | 约束 |
|---|---|---|
| `RecordHeader` | 名称、类型、owner、阶段、关键金额/时间 | 不放超过 3 个主要动作 |
| `StageStepper` | 当前阶段、已完成、阻塞、下一 gate | 与服务端状态机一致；不允许任意拖动 |
| `NextActionCard` | 当前必要行动、原因、截止、CTA | 详情页首屏；与队列同一 work item |
| `ReadinessChecklist` | 必填项、证据、状态、责任人 | 显示具体缺项，不只给百分比 |
| `EventTimeline` | 事实、actor、time、source、correlation | 事实与评论/草稿视觉区分 |
| `RelatedRecords` | lead/listing/viewing/offer/deal 或 quote/order/delivery | 使用垂直术语，不显示泛化“对象” |
| `DomainStatusChip` | canonical state + readable label | 文案和颜色映射集中维护 |
| `Money`/`Quantity` | currency/unit、precision、negative/unknown | 不能把 `0`、unknown、null 混为一类 |

### 4.4 数据与反馈

- `DataTable`：原生 table 优先；列显隐、排序、筛选与空状态一致；行级动作可键盘访问。
- `ResponsiveRecordList`：320 px 下替代宽表；保留同一信息和动作。
- `FilterBar`：显示 active filter chips 和清除；超过首行的条件进入 sheet。
- `EmptyState`：区分“真正无数据”“筛选无结果”“无权限”“能力未启用”“数据加载失败”。
- `ErrorState`：error code、用户可执行恢复、request ID；不向用户暴露内部堆栈。
- `StaleState`：显示 as-of 和重新验证按钮；高风险动作禁用。
- `Toast`：只用于短期反馈；审批、失败和需要继续处理的结果同时落在页面中。

## 5. 页面骨架

### 5.1 今日工作 S02

Desktop：

```text
PageHeader + ContextBar
┌─────────────────┬─────────────────────────────┬───────────────┐
│ WorkQueue       │ Record/Action Workspace     │ Context       │
│ 360–420         │ flexible                    │ 280–360       │
│ priority list   │ why + inputs + result       │ timeline/data │
└─────────────────┴─────────────────────────────┴───────────────┘
```

Tablet：队列 320–360 + 主工作区；Context 进入 tab/drawer。
Mobile：队列 → 工作项详情 → 完成回到下一项；顶部持续显示 context，底部固定主动作。

第一屏顺序：

1. 当前组织/垂直/日期与队列健康；
2. 当前 work item 的 title、why now、due、risk；
3. 主动作和必要输入；
4. 最近相关事件/关键商业上下文；
5. 次动作和反馈。

禁止：并排展示 Inbox、Tasks、Overdue、Alerts 四个互相重复列表；这些成为过滤器/队列原因。

### 5.2 团队命令 S03

顶区只展示 3–5 个决策级指标：开放 P0/P1、SLA 超期、待审批、流程阻塞、数据/集成异常。每个指标必须可下钻且显示 as-of。

主区：

- 左：异常/审批 worklist，可按团队、owner、位置、垂直、阶段筛选。
- 中：选择项的原因、影响、历史和处置。
- 下/右：流程健康趋势与负载，用于解释而非直接改终态。

正常进行中的所有记录不默认铺满；需要时进入 pipeline/analytics。

### 5.3 Lead 工作区 S07

- `RecordHeader`：客户、owner、质量/阶段、关键预算/物业偏好、最后联系。
- `NextActionCard`：复用队列 work item；缺下一步时明确阻断。
- `StageStepper`：当前、已完成、下一 gate。
- Tabs：Overview、Activity、Commercial、Documents；移动端顺序保持行动优先。
- 现有 timeline、milestones、quote calculator 和 contract shortcut 按 capability 复用，不另建重复页面。

### 5.4 Listing readiness S12

- 顶部：listing/property 区分、owner、sale/rent、availability、price、permit 字段状态。
- 核心：readiness checklist 分组为 ownership/consent、regulatory data、media、quality、publication adapter。
- 每个缺项有 owner、due、证据和一个直接动作。
- adapter 未启用显示 `CapabilityState`，不显示伪发布按钮。
- 时间线区分 readiness 事实、人工评论、外部发布尝试与 reconciliation。

### 5.5 Property offer/deal S15

- Offer negotiation timeline 与 Deal checklist 分区；接受 offer 后不可继续使用旧 offer 编辑控件。
- 影响预览包含价格、有效期、对手方、property/listing、条件和预期转换。
- deal conversion 显示 idempotency/processing 状态；刷新不会重复生成。
- commission 只展示当前 capability 可见字段；Finance confirmation 单独工作项。

### 5.6 Inventory S18

- ContextBar 强制显示 store/warehouse/location；切换后清空选择。
- 顶部只展示可行动异常：low stock、blocked、in transit overdue、count discrepancy。
- 表格列明确 `on_hand / reserved / blocked / damaged / in_transit / available`；unknown 不显示为 0。
- movement history 是事实；调整库存通过专用 ActionPanel，显示 reason、quantity、unit、location 和 approval。
- mobile 用 SKU 卡片与详情；stocktake/transfer 提供扫码友好 44 px 控件。

### 5.7 零售报价/订单 S19

- 行项目逐步显示 Resolver → Availability → Price → Policy → Draft 结果；失败定位到具体行。
- SKU 歧义用 inline resolution panel，只重问歧义行。
- 折扣超过策略显示审批，而不是让用户反复改数值猜阈值。
- 外发前确认收件人、版本、金额、VAT、有效期；AI 草稿标记“draft”。
- quote accepted → order 只执行一次，完成 receipt 显示 order ID 与下一 fulfilment 项。

### 5.8 COD/Finance S21

- 三个事实并列但不可合并：Driver collected、Handover recorded、Finance confirmed。
- 每一步显示 actor、time、amount、evidence、差异。
- 高风险按钮使用 `ApprovalPanel/ImpactReview`；取消/退款/关闭显示终态保护。

## 6. 状态与文案规范

### 状态文案

使用已发生/待处理的确定语言：

- `Awaiting finance confirmation`，不写 `Payment done`，除非 finance fact 已确认。
- `Ready to request publication`，不写 `Published`，除非 adapter 返回并完成 reconciliation。
- `Draft prepared`，不写 `Sent`，除非外发事件存在。
- `Inventory unavailable` 与 `Inventory unknown` 分开。

### 主动作命名

动词 + 业务对象：`Schedule viewing`、`Record feedback`、`Request approval`、`Confirm cash handover`。避免 `Continue`、`Process`、`Submit` 等脱离上下文的词。

### 原因结构

按“事实—风险/机会—截止”排列，例如：

> Offer 将在 4 小时后到期；卖方已 counter；当前金额仍在你的审批范围内。

LLM 生成摘要时，界面仍能展开结构化 reason codes 与 evidence refs。

## 7. 响应式与无障碍组件验收

| 模式 | 必测 |
|---|---|
| Sidebar/Sheet | 320 px reflow、focus trap、Escape、焦点返回、背景 inert |
| WorkQueue | 键盘选择、当前项播报、排序说明、自动推进不抢焦点 |
| WorkItem | 24 px AA target 最低、主要控件 40/44 px、非颜色严重性 |
| Dialog/Approval | 初始焦点、Tab 循环、标题/描述、取消、不可逆信息 |
| Kanban | 拖拽等价单指/键盘动作；状态变更有确认和结果 |
| Table | 语义 header、caption/名称、行操作焦点顺序、mobile 替代 |
| Timeline | 事实/评论可区分、时间有机器可读值、连续加载可访问 |
| Toast/Live | 不重复播报；关键结果页面内持久存在 |
| Charts | 有文本摘要/表格、非颜色区分、tooltip 可键盘访问或有替代 |
| Bilingual/RTL | 文案扩展、逻辑 padding/margin、图标方向、数字字段方向 |

## 8. 设计 QA 清单

- 同一 viewport/状态下对照当前页面和迁移页面；记录改动而不是凭记忆判断。
- 页面只有一个视觉主动作；多个实心按钮视为失败。
- PageHeader、panel 标题、字段标签、meta 字号只用 token。
- 同一状态在列表、详情、时间线、通知中使用同一 label/icon/color。
- 没有裁切、双重滚动、sticky 遮挡、焦点不可见或 320 px 页面级横滚。
- skeleton 与最终布局一致；empty/error/denied/disabled 均有安全恢复路径。
- 金额、数量、日期、ID、SKU、permit 和电话格式明确；null/unknown/0 不混淆。
- 任何外部适配器或 AI 文案都不夸大实际执行结果。
