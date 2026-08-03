# NewMe V4 前端渐进改造增量包

状态：规划增量；不构成已实现、已上线或可商用声明
证据锁定时间：2026-08-03（Asia/Shanghai）
目标仓库：`69755354/newme-platform`
上游事实基线：`715fa4bf4a97869077371b16c3094d8599d7e344`

## 1. 边界与依赖

本目录只定义 **V4 前端改造增量**。它不复制、不替代、不修订 `docs/v4/` 中的 V4 SaaS PRD、交付计划、追踪矩阵或执行 backlog，也不改变其 `V4-*` 需求、M0–M8 里程碑或 G0–G8 发布门禁。

本包的生效前提是：

1. 候选提交必须以 `715fa4bf4a97869077371b16c3094d8599d7e344` 为祖先，并保留下面列出的 `docs/v4/` blob；
2. 每个前端工作包引用上游 V4 ID、对应 Linear 工作包和确切实现基线；
3. UI 可见性不被当作授权，状态变更仍由 #256 定义的服务端、RLS、审批、幂等、审计与事件边界执行；
4. 本包与上游治理基线发生冲突时，以 `V4_REQUIREMENTS_TRACEABILITY.md` 的 ID 表为准；已知 PRD 标题冲突由机器 registry 显式登记，不在实现 PR 中静默改写。

本目录只包含规划文档、机器合同、校验器和测试；它没有业务实现、数据库迁移或运行时部署，因此状态仍是“规划增量”。本地 commit 也不等于已推送、已合并或已上线。

## 2. 上游事实锁

2026-08-03 锁定的上游 Git 事实：

| 项目 | 已验证事实 |
|---|---|
| canonical commit | `715fa4bf4a97869077371b16c3094d8599d7e344`；最终候选必须证明它是祖先 |
| 追踪矩阵 | tracked path `docs/v4/V4_REQUIREMENTS_TRACEABILITY.md`，blob `e1d83d0042381cef0eefdf5d3e080f97686c65a0` |
| V4 PRD | tracked path `docs/v4/V4_SAAS_PRD.md`，blob `13b11dce1c816a3e5ee2a3524f3591b61f9bb739` |
| 交付计划 | tracked path `docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md`，blob `16eb82e31aa485a033c7fe844fef3a9582eee5a1` |

| 上游文件 | Git blob SHA |
|---|---|
| `docs/v4/V4_SAAS_PRD.md` | `13b11dce1c816a3e5ee2a3524f3591b61f9bb739` |
| `docs/v4/V4_DELIVERY_OPERATIONS_PLAN.md` | `16eb82e31aa485a033c7fe844fef3a9582eee5a1` |
| `docs/v4/V4_REQUIREMENTS_TRACEABILITY.md` | `e1d83d0042381cef0eefdf5d3e080f97686c65a0` |

以上状态是锁定时快照；后续执行必须重新查询 PR 和 Linear，不能把本文件当作实时状态源。

## 3. 事实分类

本包沿用 #256 的证据边界：

- **已验证当前**：本次直接读取的仓库文件、浏览器页面、远端 Git 元数据或带哈希的用户材料。
- **来源主张**：Axon/International City 交付材料中的陈述，未自动提升为运行时事实。
- **目标**：本包要求的 V4 前端行为，尚未声称实现。
- **延期**：首批前端切片不实现的能力。

特别说明：#256 当前文本把 `AxonAIconsultancies/real-estate` 记为不可读。本次在当前执行环境中运行只读 `git ls-remote --heads` 成功返回：

- `master` → `53d1fa06169a9179f13068f147cafb1d20f919b7`
- `feature/department-workflows` → `34d89e60ab16c3dac4f2250e2b427e768ed700a6`

这只证明当前环境在 2026-08-03 能读取这两个远端分支引用；不证明代码所有权、许可证、部署状态、生产状态或某个交付包与远端提交等价。该差异应在 #256 的后续治理修订中处理，本包不修改上游文件。

## 4. 当前前端证据摘要

对 `C:\tmp\newme-v4-governance-f2bd657` 当前本机基线的只读扫描得到：

- 27 个 `page.tsx` 页面路由，其中 24 个位于 dashboard 路由组；
- 18 个 `src/components/ui/*.tsx` UI 原语；
- 24 个 dashboard 页面中 23 个引用 `DashboardScrollContainer`，`quotations/page.tsx` 未引用；
- `src/lib/nav.ts` 为管理角色提供 11 个平铺入口，为销售角色提供 8 个平铺入口；
- `text-[10px]`、`text-[11px]`、`text-[12px]` 在 `src/**/*.tsx` 中合计出现 259 次；
- 销售工作台把明日任务、Inbox、Tasks、Overdue、Progress、Alerts 分成并列信息槽；它已有 `next_action`、`next_followup_date`、任务、逾期和业务事件数据，但没有统一的“为何现在处理—主动作—完成后推进”队列；
- 当前 `business_events` 路由允许 20 个既有事件类型；该事实支持渐进接入，但不等于 #256 所需的跨垂直事件契约已经实现；
- 生产登录页已在 `https://app.newme.ae/login` 打开并截图。该页使用黑色背景、深色卡片和金色主动作，与 dashboard 根 token 的默认浅色背景是两个不同的视觉状态。

证据文件：

- [NewMe 生产登录页截图](evidence/newme-login-2026-08-03.jpg)
- [Axon Broker OS 当前首页截图](evidence/axon-broker-os-home-2026-08-03.jpg)

截图证明可见状态，不证明登录后的完整页面、数据真实性或后端能力。登录后页面的规划依据以当前源码和上游治理文档为主。

## 5. 文档清单

机器合同补充：`contracts/v4-id-registry.v1.json`、`frontend-traceability.v1.json`、`screen-route-registry.v1.json`、9 类 JSON Schema、`frontend-api-contract.v1.json`、95 项 event/command payload registry、`legacy-role-mapping.v1.json` 及带逐条 SHA-256 的官方来源登记元数据快照；该快照只锁定 source ID、标题、URL、locator 和访问日期，不声称保存或哈希网页正文。`V4_PLATFORM_OPERATIONS_AND_LIFECYCLE.md` 与 `V4_FRONTEND_NONFUNCTIONAL_GATES.md` 分别锁定平台控制台/生命周期和性能/A11y 证据门。`node scripts/check-v4-frontend-contracts.mjs` 是 fail-closed 一致性验证入口。

| 文档 | 用途 |
|---|---|
| `V4_FRONTEND_INCREMENT_PRD.md` | 产品目标、需求、IA、旅程、屏幕、响应式、可访问性和指标 |
| `V4_FRONTEND_EVENT_AND_NBA_MODEL.md` | 事件信封、投影、优先级、next-best-action、解释与审批边界 |
| `V4_FRONTEND_DESIGN_SYSTEM_AND_SCREENS.md` | 现状审查、设计系统、组件契约和关键屏幕规格 |
| `V4_FRONTEND_DELIVERY_PLAN.md` | 分阶段开发、Linear/Git 工作包、迁移、灰度和回滚 |
| `V4_FRONTEND_TRACEABILITY_AND_ACCEPTANCE.md` | 上游 ID 映射、验收矩阵和证据要求 |
| `V4_FRONTEND_RESEARCH_REGISTER.md` | 官方竞品资料、模式选择与不采用项 |

## 6. 工具与插件能力核对

本会话可调用 Product Design、内置浏览器和 Sites 能力。Product Design 用于现状审查与既有设计语言约束；浏览器用于打开并截图真实页面；Sites 没有启用，因为本任务不构建、不预览、不发布站点。

推荐插件清单中的 Figma、PostHog 等能力对本次只读研究与文档交付不是必要条件：现有源码和实际页面已提供足够设计证据，指标仅定义埋点契约而不查询生产分析。因此没有提出插件安装请求。

## 7. 决策摘要

1. 保留现有 Next.js 路由、认证、语言、基础 UI 原语和业务记录页面，先改“工作组织方式”，不重建空壳。
2. 把首页从 KPI/卡片集合改造成角色与组织范围内的统一工作队列；每项显示原因、时限、风险、主动作和完成后的阶段推进。
3. 用事件投影生成工作项和建议，不让浏览器直接决定授权、金额、库存、合规或终态。
4. 房地产与零售共享 shell、任务、审批、时间线和交互规范，但保留各自状态机和垂直术语。
5. 先统一 token、页面骨架和核心组件，再逐屏迁移；每个阶段可通过 feature flag 和路由级回退恢复旧体验。
