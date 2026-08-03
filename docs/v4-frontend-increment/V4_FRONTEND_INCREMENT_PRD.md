# NewMe V4 前端渐进改造增量 PRD

状态：Target；依赖 PR #256，不构成实现声明
版本：2026-08-03
需求命名空间：`FE-001`–`FE-025`

## 1. 产品命题

NewMe V4 前端不是另起一套页面，而是把当前 NewMe 从“按模块找数据”渐进改造成“按事件完成工作”。用户进入系统后应立即知道：

1. 当前最该处理什么；
2. 为什么现在处理；
3. 需要哪些上下文和证据；
4. 哪个动作可安全执行；
5. 完成后业务进入哪个状态、产生什么后续动作。

目标体验公式：

`业务事实/事件 → 规则与权限 → 可解释的工作项 → 人执行或审批 → 新事件 → 下一阶段`

前端只负责呈现、采集意图和反馈结果。授权、租户边界、状态机、金额/库存/合规计算、幂等和审计继续由 #256 的平台与垂直服务负责。

## 2. 问题定义

### 已验证当前问题

- 管理端 11 个、销售端 8 个平铺导航入口要求用户先判断“去哪个模块”，再判断“做什么”。
- 销售工作台已有任务、逾期、提醒、进度和下一步字段，但分散在多张并列卡片；同一 lead 可能在多个槽位重复出现。
- 当前详情页已有下一步行动、跟进日期、里程碑和可追溯时间线，为渐进升级提供了可复用基础；缺口是统一优先级、解释、动作完成与自动推进契约。
- 页面已有 Card、Button、Badge、Table、Dialog、Tabs 等原语和统一滚动容器，但细小字号和局部状态色大量直接写在页面中，跨模块一致性依赖人工维护。
- 生产登录页为深色金色视觉，dashboard 根 token 默认是浅暖灰/石板色；缺少明确的主题与品牌层级规则。

### 上游目标带来的新要求

- 用户可属于多个组织，并在不同组织拥有不同能力；前端必须始终显示当前组织与垂直上下文。
- 房地产与零售共用平台服务，但业务对象和状态机不能混为一体。
- L2/L3/L4 动作需要明确区分可执行、需审批和禁止；隐藏按钮不能替代服务端拒绝。
- 外部适配器在未验证前必须显示为禁用或受限能力，不能用“即将发送/已发布”等文案误导。

## 3. 目标与非目标

### 3.1 目标

| ID | 目标 |
|---|---|
| O1 | 降低用户从进入系统到开始首个高价值动作的时间 |
| O2 | 提高当前阶段在 SLA 内一次完成的比例，并减少因缺字段、缺审批、缺证据造成的往返 |
| O3 | 让每个建议动作有可审计原因、来源事件、适用规则和预期推进 |
| O4 | 用同一 shell 和设计系统服务共享平台、房地产、零售，而不抹平垂直语义 |
| O5 | 保持现有业务可用；支持逐组织、逐角色、逐页面灰度和可执行回滚 |

### 3.2 非目标

- 不重写认证、租户、RLS、计费、状态机或事件基础设施；这些属于 #256 上游实现。
- 不把 Axon Express/Prisma 运行栈或 UI 复制进 NewMe。
- 不在首批切片提供任意工作流设计器、任意 dashboard 拼装器或无限主题定制。
- 不允许 AI 直接改变权限、财务确认、库存账、审计、客户外发或跨租户事实。
- 不声称 DLD、Trakheesi、Makani、房产门户、WhatsApp、支付或 UAE e-invoicing 已集成。
- 不删除现有路由或一次性迁移所有页面。

## 4. 用户与工作上下文

### 4.1 共享角色

| 角色 | 首要问题 | 首页重点 |
|---|---|---|
| 组织 Owner/Admin | 哪些风险、审批、收入或交付节点需要我决策？ | 跨团队异常、L3 审批、关键漏斗、组织健康 |
| Manager | 今天团队哪里卡住，应该分配、升级或干预什么？ | 超期、未分配、负载、阶段阻塞、审批队列 |
| Sales Agent | 下一位联系谁、为什么、用什么动作推进？ | 我的优先队列、客户上下文、跟进动作、日计划 |
| Operations/Specialist | 哪些交付或合规事项已具备条件，哪些缺证据？ | 就绪检查、依赖、到期、异常、交接 |
| Finance | 哪些金额或收付款事实等待独立确认？ | 待核对、差异、终态保护、审计证据 |
| Viewer/Auditor | 当前状态为何形成，证据在哪里？ | 只读时间线、规则原因、变更与导出 |

### 4.2 房地产工作上下文

明确使用：业主/房东、买方、租客、broker、property、unit、listing、permit、Trakheesi、Makani、viewing、property offer、deal、commission、A2A、payroll、publish readiness。

房地产主链：

`party/owner → property/unit → listing readiness → lead/match → viewing → offer/counter → deal → commission/payroll`

### 4.3 零售工作上下文

明确使用：company、region、store、warehouse、location、product、SKU、variant、inventory movement、quotation、order、PR、PO、receipt、delivery、COD、finance confirmation、reconciliation。

零售主链：

`catalog/SKU → availability → pricing/policy → quotation → order/reservation → procurement/fulfilment → delivery/COD → finance reconciliation`

## 5. 产品原则

1. **先行动，后分析。** 首页第一屏是可执行工作，不是 KPI 墙；分析用于解释与管理决策。
2. **一个工作项，一个明确主动作。** 次动作最多两个；更多操作进入菜单或记录页。
3. **原因必须可见。** 显示触发原因、截止时间、风险、相关记录和排序理由；预测分数不能成为唯一解释。
4. **完成即推进。** 完成动作后立即展示状态变化、生成的后续项和可撤销边界，避免用户再次寻找下一步。
5. **缺一项只问一项。** 若流程只缺一个必要字段，聚焦询问该字段并保留已解析信息；多项缺失时给清单和就绪度。
6. **审批在工作流中。** 不把审批藏在独立后台；触发 L3 动作时就地说明原因、审批人和等待状态。
7. **异常优先于普通状态。** 管理视图优先展示超期、冲突、缺证据和阻塞，不把正常项全部铺满。
8. **垂直术语不泛化。** 房产 Offer 与零售 Quotation/Order 分开；commission 与 COD/AR 分开。
9. **颜色是冗余信号。** 所有严重性、阶段和结果同时用文字/图标/结构表达。
10. **真实能力诚实呈现。** 未启用适配器显示“未启用/需配置”，不展示伪成功状态。

## 6. 前端需求

| ID | 需求 |
|---|---|
| FE-001 | 保留现有认证、语言、dashboard shell、UI 原语和业务路由；通过兼容层和 feature flag 渐进迁移 |
| FE-002 | shell 持续显示当前组织、垂直包、位置（零售适用）和角色；上下文切换先验证 membership/entitlement，再刷新投影 |
| FE-003 | 登录后默认进入角色化“今日工作”，管理者进入组织命令视图，销售进入个人工作队列；旧 `/dashboard`、`/workbench` 保留回退 |
| FE-004 | 把任务、提醒、逾期、审批、异常和规则建议归一为统一工作项；同一对象同一原因去重 |
| FE-005 | 每个建议包含 `why_now`、`evidence`、`priority_band`、`primary_action`、`expected_outcome`、`expires_at` 和策略版本 |
| FE-006 | 支持完成、开始、稍后、跳过、重新分配、请求审批；每种处置必须记录原因或事件，不能静默消失 |
| FE-007 | 页面通过事件投影更新计数、阶段、时间线和队列；前端不得从展示状态反推并直接写业务终态 |
| FE-008 | 记录工作区使用统一三段结构：对象摘要与阶段、当前行动区、时间线/关联数据；操作后保持上下文 |
| FE-009 | 房地产前端覆盖 listing readiness、lead matching、viewing、offer、deal、commission/payroll 的完整可见链路 |
| FE-010 | 零售前端覆盖 catalog/SKU、inventory、pricing/quotation、order、procurement、delivery/COD、finance 的完整可见链路 |
| FE-011 | L3 动作显示影响摘要、审批链、不可逆边界和审计信息；L4 动作不提供可执行入口并解释政策 |
| FE-012 | 提供全局搜索/命令入口，按当前组织、垂直和能力返回对象与允许动作；不跨上下文泄漏结果 |
| FE-013 | 导航从平铺模块改为“工作、客户/关系、垂直运营、财务、洞察、管理”分组；按 entitlement 与 capability 裁剪 |
| FE-014 | 建立可执行设计 token 与组件契约，页面不得新增任意字号、状态色、阴影、半径或同义组件 |
| FE-015 | 支持 320 CSS px reflow、平板和桌面；关键动作不依赖 hover 或拖拽，Kanban 提供非拖拽替代 |
| FE-016 | 以 WCAG 2.2 AA 为目标，覆盖键盘、焦点、对比度、名称/角色/状态、错误恢复、减弱动画、LTR/RTL |
| FE-017 | 加载、无数据、无权限、能力未启用、离线/失败、冲突和成功状态采用统一组件及恢复动作 |
| FE-018 | 采集从建议曝光到处理、结果和下一阶段的事件指标；分析口径绑定组织、角色、垂直、策略版本和 release SHA |
| FE-019 | 敏感值按能力遮蔽；搜索、导出、链接预览、通知和浏览器缓存遵守租户/角色/保留策略 |
| FE-020 | 每个迁移阶段有路由、组件、投影和数据契约回退；回滚不删除已写事件或财务/审计事实 |
| FE-021 | 管理命令视图支持按团队/位置/流程聚合异常并下钻到原始记录，不在 dashboard 直接绕过授权修改事实 |
| FE-022 | 用户可对建议标记“有帮助/不相关/信息错误”，反馈进入策略评估，不直接改变业务事实或权限 |
| FE-023 | 平台控制台区分 organization lifecycle（provisioning/active/read_only/suspended/export_only/closed）与 billing lifecycle（trial/active/grace/dunning/suspended/closed）；任何转换均由服务端状态机、审批与事件确认 |
| FE-024 | canonical 平台角色为 platform_owner/platform_ops/platform_support/platform_auditor；支持会话必须单组织、最小 scope、获批、自动到期/可撤销并清除上下文与缓存 |
| FE-025 | plan、subscription、paid-seat ledger、quota、usage event 与 invoice reference 在 S24 可见且可审计；并发席位激活、超额和对账不一致 fail closed |

## 7. 信息架构

### 7.1 全局 shell

- 左侧/移动端导航：分组入口、当前组织、垂直徽标。
- 顶栏：页面标题/面包屑、全局搜索、组织/位置切换、审批/通知、个人菜单。
- 主区：页面骨架统一为 `PageHeader → ContextBar → PrimaryWorkspace → SupportingInsights`。
- 右侧详情抽屉仅用于快速预览与低风险动作；复杂编辑、审批和完整时间线进入记录页。

### 7.2 导航树

```text
今日工作
├─ 我的队列
├─ 团队命令（manager+）
└─ 审批（有审批能力时）

关系与商业
├─ 线索/客户
├─ 报价
├─ 合同
└─ 收付款

房地产（entitlement: real_estate）
├─ 业主与物业
├─ 房源与发布就绪
├─ 匹配
├─ 看房
├─ Offer 与 Deal
└─ 佣金与 Payroll

零售（entitlement: retail）
├─ 商品与 SKU
├─ 库存与调拨
├─ 报价与订单
├─ 采购与收货
├─ 履约与配送
└─ COD 与对账

交付与运营
├─ 项目
├─ 任务
├─ 文件
└─ 集成状态

洞察
├─ 流程健康
├─ 业务绩效
└─ 审计/事件（有权限时）

管理
├─ 团队与能力
├─ 组织、位置与套餐
├─ 规则与通知
└─ 设置
```

导航不要求首期新增全部路由。第一阶段可把分组映射到现有 `/dashboard`、`/workbench`、`/leads`、`/quotes`、`/contracts`、`/payments`、`/products`、`/projects`、`/tasks`、`/analytics`、`/team` 和 `/settings`；新垂直路由只在对应后端切片达到验收门禁后启用。

## 8. 关键用户旅程

### J1 销售处理今日队列

1. 进入“今日工作”，系统展示当前组织和个人队列。
2. 顶部工作项说明：“跟进超期 2 天；上次联系后客户查看报价；建议电话确认预算”。
3. 用户在同屏查看联系人、最近活动、报价摘要和允许动作。
4. 用户完成电话并选择结果；若仅缺下一次时间，界面只询问时间。
5. 服务端记录事件并返回新状态；该项退出当前队列，下一条自动聚焦。
6. 若结果触发 viewing/quotation/approval，页面显示已生成的下一工作项。

成功标准：无需回到首页或另开多个模块即可完成一条工作并看到推进结果。

### J2 经理处理异常与分配

1. 进入团队命令视图，默认只显示超期、未分配、即将违约和待审批异常。
2. 按团队、位置、垂直或阶段筛选；每个聚合值可下钻到确定记录。
3. 经理打开异常，查看触发事件、当前 owner、已尝试动作和阻塞原因。
4. 对 L2 可重新分配；对 L3 提交或完成审批；系统记录理由。
5. 视图通过投影更新，异常关闭但保留历史。

### J3 房地产 listing 到发布就绪

1. Listing Ops 打开房源记录，看到 readiness checklist，而不是笼统完成百分比。
2. 系统列出缺失的 owner consent、permit/Trakheesi 字段、媒体或质量检查。
3. 每个缺项链接到直接完成动作；外部 portal adapter 未启用时明确显示受限。
4. checklist 全部通过后产生 `listing.ready` 事件并生成“申请/排队发布”动作。
5. 发布结果、重试和 reconciliation 回写时间线；失败生成异常工作项。

### J4 房地产 offer 到 deal/commission

1. Broker 在 lead/property 工作区发起 property offer 草稿。
2. 页面展示价格、有效期、对手方、缺失条件和当前授权。
3. 接受 offer 的动作使用幂等键，只允许一次 deal conversion。
4. Deal checklist、合同/付款引用和 commission split 在同一链路可见。
5. Finance confirmation 与 broker/manager 意图分离；终态变更显示不可逆边界。

### J5 零售报价到订单

1. 用户解析 SKU；若一个词对应多个 SKU，只要求澄清该歧义并保留其他已解析行。
2. 界面按确定顺序展示 availability、价格、VAT、折扣政策和审批要求。
3. 无库存、未知 SKU、零/负数量或超折扣策略在提交前明确阻断。
4. 报价外发属于 L3，确认收件人、版本、金额和审批。
5. 接受报价只转换一次订单，并显示 reservation/fulfilment 下一工作项。

### J6 零售 COD 对账

1. Driver 标记收款只产生“cash collected”事实，不等于 finance confirmed。
2. Cash handover 生成 Finance 队列项，展示订单、配送证据、金额和差异。
3. Finance 独立确认或记录 discrepancy；差异进入异常流程。
4. 终态显示 actor separation 和完整事件时间线。

## 9. 屏幕清单

状态说明：`迁移`=在现有路由渐进重构；`新增`=后端切片具备后启用；`保留`=首期保持现状但纳入 token/状态规范。

| Screen ID | 屏幕 | 路由建议 | 类型 | 核心输出 |
|---|---|---|---|---|
| S01 | 登录 | `/login` | 迁移 | 品牌一致、可访问错误、组织选择后的安全跳转 |
| S02 | 今日工作 | `/work`；旧 `/workbench` 回退 | 迁移 | 统一优先队列、上下文、主动作、自动推进 |
| S03 | 团队命令 | `/command`；旧 `/dashboard` 回退 | 迁移 | 异常、审批、团队负载、流程健康、下钻 |
| S04 | 审批中心 | `/approvals` | 新增 | L3 影响摘要、证据、决定、理由、审计 |
| S05 | 全局搜索/命令 | shell overlay | 新增 | 租户/能力内对象和允许动作 |
| S06 | Leads 列表 | `/leads` | 迁移 | worklist/list/Kanban 视图、保存筛选、批量低风险动作 |
| S07 | Lead 工作区 | `/leads/[id]` | 迁移 | 摘要、下一步、关系/商业上下文、时间线 |
| S08 | 报价列表/详情 | `/quotes`、`/quotations/[id]` | 迁移 | 版本、政策、审批、外发、转换 |
| S09 | 合同工作区 | `/contracts/[id]` | 迁移 | 状态、文件、批准、付款、提醒、撤销边界 |
| S10 | 付款工作区 | `/payments` | 迁移 | 待分配/确认、差异、角色分离 |
| S11 | 房产 parties/properties | `/real-estate/properties` | 新增 | owner/property/unit、合规状态、去重 |
| S12 | Listings 与 readiness | `/real-estate/listings` | 新增 | 清单、媒体/文件、发布队列、异常 |
| S13 | Matching | `/real-estate/matches` | 新增 | 确定过滤、排序原因、接受/排除 |
| S14 | Viewings | `/real-estate/viewings` | 新增 | 请求、安排、出席、反馈、跟进 |
| S15 | Property Offers/Deals | `/real-estate/deals` | 新增 | 谈判历史、单次转换、deal checklist |
| S16 | Commission/Payroll | `/real-estate/commissions` | 新增 | split、审批、结算、终态保护 |
| S17 | 商品/SKU | `/retail/catalog`；现 `/products` 迁移 | 迁移 | resolver、variant、单位、条码、歧义 |
| S18 | 库存工作区 | `/retail/inventory` | 新增 | location balance、movement、transfer、stocktake |
| S19 | 零售报价/订单 | `/retail/orders` | 新增 | 确定价格链、reservation、fulfilment、return |
| S20 | 采购/收货 | `/retail/procurement` | 新增 | PR/PO、审批、receiving、差异、replenishment |
| S21 | 配送/COD/对账 | `/retail/finance` | 新增 | 配送证据、cash handover、finance confirmation |
| S22 | 项目/任务 | `/projects`、`/tasks` | 迁移 | 阶段、责任、依赖、下一步、异常 |
| S23 | 洞察 | `/analytics` | 迁移 | 漏斗、阶段时间、异常、NBA 质量，不替代事实 |
| S24 | 组织与平台运营控制台 | `/team`、`/settings`；目标 `/platform/organizations`、`/platform/support-sessions`、`/platform/plans`、`/platform/audit` | 迁移+新增 | 组织 membership/capability/location；platform_owner/platform_ops/platform_support/platform_auditor；organization/billing lifecycle、plan、seat、quota、support session、audit |

屏幕总数固定为 24（S01–S24）。能力未启用、无权限、加载、空、失败、stale、conflict 和成功统一使用组件 `C01`；`C01` 不是屏幕，也不计入 screen count。当前源码 27 个 `page.tsx` 路由与屏幕/组件的逐一映射由 `contracts/screen-route-registry.v1.json` 锁定。

## 10. 响应式策略

### 320–479 CSS px

- 单列；导航为 modal sheet，打开后焦点限制在 sheet，关闭后回到触发按钮。
- 工作项显示原因、截止和一个主动作；证据与次动作折叠。
- 记录工作区按“行动—摘要—时间线”顺序堆叠；不隐藏任何必要信息。
- 表格提供卡片/定义列表替代；只有确需二维关系的库存矩阵、Kanban 才允许局部横向滚动。
- 拖拽不是唯一操作；阶段变更提供菜单/按钮。

### 480–767 CSS px

- 单列主区，可使用底部 action bar；筛选在 sheet 中。
- 列表项允许两行元数据，但主动作保持可见。

### 768–1199 CSS px

- 可折叠窄侧栏；worklist + 详情双栏，详情可覆盖为抽屉。
- 复杂记录页采用 5/7 或 4/8 分栏，不并排超过两个主要面板。

### ≥1200 CSS px

- 固定/可折叠侧栏；worklist 360–420 px，工作区弹性，辅助洞察 280–360 px。
- 最大内容宽度按任务决定；数据表不强制限制为营销页式窄容器。

### 200%/400% zoom

- 200% 时关键流程不丢功能；400%/等效 320 CSS px 时除明确二维例外外不产生双向页面滚动。
- sticky header/footer 不能遮挡焦点，用户放大后仍能看到错误与确认信息。

## 11. 可访问性与国际化

- 目标：WCAG 2.2 AA；自动检查只是门禁之一，关键旅程需键盘和读屏人工验证。
- 所有交互使用语义控件；图标按钮有可访问名称，状态变化通过 `aria-live` 适度播报。
- 焦点环统一且不被 sticky 区遮挡；Dialog/Sheet 打开、循环、关闭和焦点恢复遵循 WAI-ARIA APG。
- AA 最小点击目标 24×24 CSS px；NewMe 产品规范对独立主要控件采用 40 px 高，移动端采用 44 px 高，避免依赖例外。
- 文本、图标和边框对比度通过 token 验证；状态不只靠红/绿。
- 表格优先原生 `<table>`；只有确需复合键盘导航的高密度可编辑数据才采用 grid pattern。
- 中英文使用同一 key，不在组件内混合硬编码 fallback；日期按 Asia/Dubai 业务时区显示并保留绝对时间语义。
- Arabic-ready：布局和图标方向通过逻辑属性支持 RTL；数字、金额、SKU、电话、permit 等字段按内容方向处理。
- 验证错误与字段关联，聚焦首个错误并保留用户已输入内容；超时/冲突提供重试和刷新差异。
- 遵守 `prefers-reduced-motion`；队列自动推进使用短暂但可关闭的过渡，不抢夺读屏用户焦点。

## 12. 指标框架

首个 pilot 前先记录 2–4 周基线，再由产品/业务 Owner 确认目标值。本 PRD 不虚构无基线数值。

### 北极星指标

`Qualified Stage Advance Rate`：进入工作队列且被处理的 eligible work item 中，在定义窗口内产生有效下一阶段事件的比例。

该指标必须按垂直和工作项类型分别计算，不能把“关闭提醒”当作业务推进。

### 核心指标

| 指标 | 定义 |
|---|---|
| Time to First Valuable Action | 会话进入 `/work` 到首个成功 L1/L2 动作确认的时长 |
| Work Item Completion Rate | `completed / eligible exposed`，排除被策略撤销或对象失效的项 |
| SLA Completion Rate | 截止时间内产生成功动作事件的工作项占比 |
| Stage Advance Rate | 完成工作项后在归因窗口内产生合法阶段推进的比例 |
| One-pass Completion | 未因缺字段/冲突/权限失败而返工即完成的比例 |
| Recommendation Acceptance | 采取建议主动作的工作项 / 有效曝光工作项 |
| Snooze/Skip/Irrelevant Rate | 分别计算；必须带 reason code |
| Duplicate Work Rate | 同一 dedupe key 在有效窗口内重复出现的比例 |
| Approval Turnaround | 提交 L3 到批准/拒绝的时长，按类型和角色分层 |
| Exception Aging | 开放异常按严重性与垂直的 p50/p95 时长 |
| Accessibility Task Success | 键盘/读屏测试中的关键旅程完成率 |

### 护栏指标

- cross-organization data exposure：目标 0；任何一次为发布阻断。
- unauthorized action success：目标 0；UI 隐藏不计通过，必须验证服务端拒绝。
- incorrect terminal transition、duplicate financial/inventory mutation：目标 0。
- UI error rate、p95 首屏可交互时间、API/action failure、投影延迟、回滚率。
- 建议反馈中的“信息错误”率和规则版本回归。

## 13. 发布准则

前端切片只有同时满足以下条件才可从 Target 提升为 validated-staging：

1. 对应 #256 V4 ID 的后端/数据/授权契约已在确切 SHA 上存在；
2. 正常、无权限、跨组织、失效、重复、冲突、审批和回滚路径通过；
3. 关键桌面/移动/键盘/读屏旅程通过；
4. 指标事件与业务事件可关联，但不包含 PII/秘密；
5. 旧路由或旧组件回退在同一 release 上可执行；
6. staging UAT 记录组织、角色、垂直、release SHA、fixture 和 residue-zero cleanup。
