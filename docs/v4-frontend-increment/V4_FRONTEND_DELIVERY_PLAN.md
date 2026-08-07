# NewMe V4 前端渐进改造开发与发布计划

状态：建议计划；不代表运行时 UI 已实现或发布
治理基线：[PR #256](https://github.com/69755354/newme-platform/pull/256) final head `80f19cc67d26bb592ec8f440fdb965eb224f8b6a` 已合并为 `715fa4bf4a97869077371b16c3094d8599d7e344`
最终上游复核：2026-08-04；current canonical `agent/saas-staging-isolation@858a4ccb51697b4b4499252bfa3c22963381847e`

## 1. 交付约束

1. 延续 #256 的 M0–M8、G0–G8 和 SAM-77..88，不创建一套竞争的前端里程碑。
2. 前端以端到端用户结果切片，不按“先组件、后页面、最后接接口”拆成不可验收的孤岛。
3. 一个切片包含必要的 schema/API/policy、UI、测试、遥测、feature flag、staging UAT 和回滚；前端 PR 不声称未合并的后端能力。
4. 只有一个活动 integration PR 进入同一依赖链；独立的房地产与零售切片可在共享契约稳定后并行。
5. 旧路由和旧体验保持可回退，直到新体验在确切 release 上完成 UAT 和观察窗口。
6. 本计划不授权生产变更、Linear 写入、Git push 或 PR 创建。

## 2. 分阶段计划

### F0 — 上游与度量锁定

上游：SAM-77 / PR #256。
输出：本增量包评审、FE ID 映射、现状事件/页面基线、指标字典、feature flag 命名、设计 QA 清单。
退出：

- #256 final head `80f19cc67d26bb592ec8f440fdb965eb224f8b6a` 已合并，13/13 首审意见实质关闭，且 current canonical `858a4ccb51697b4b4499252bfa3c22963381847e` 保留其治理祖先；
- Axon 可读性差异在上游登记，所有权/许可证仍未验证则只复用 domain semantics；
- FE-001..022 均映射到 V4 ID、工作包和验收；
- 不把当前源码/截图提升为生产能力声明。

### F1 — Shell 与设计系统收敛

上游：SAM-78 的 membership/capability/context 契约；不依赖新垂直业务写入。
范围：ContextSwitcher、GroupedNav、PageHeader、ContextBar、typography/status/spacing token、统一 loading/empty/error/denied/disabled、现有页面兼容适配。
迁移：先在 `/settings`、`/team` 等低风险页面验证，再迁移 `/dashboard`/`/workbench` shell。
退出：

- 现有 27 个页面路由可在新旧 shell 下打开；
- 当前组织/角色/垂直显示准确，切换后没有旧 context 数据残留；
- 320 px、200%/400% zoom、键盘和焦点门禁通过；
- 关闭 `v4_shell` 可恢复旧 shell，不影响业务数据。

### F2 — 统一工作队列与当前销售切片

上游：SAM-78 完整租户隔离、SAM-80 任务/审批/事件投影的可用子集。
范围：把现有 `/api/workbench` 的 inbox/tasks/overdue/alerts/next action 经兼容投影归一；新增 WorkQueue、WorkItem、ActionPanel、CompletionReceipt；旧 `/workbench` 保留。

首批动作只覆盖当前已具备服务端状态机/幂等/授权的安全流程：

- 打开 lead 上下文；
- 记录/安排 follow-up；
- 完成/稍后处理任务；
- 在现有安全端点上推进允许的 lead 阶段；
- 无权限、冲突和失败恢复。

退出：

- 同一 lead/reason 去重；完成后由投影确认并自动进入下一项；
- `why_now`、due、risk、主动作和策略版本可见；
- L2 重复点击/刷新不产生重复事件；
- 新旧队列指标可对照，关闭 `work_queue_v1` 回到旧工作台。

### F3 — 现有商业记录工作区

上游：SAM-79、SAM-80 的相关商业/共享服务契约。
范围：渐进迁移 `/leads/[id]`、`/quotes`、`/quotations/[id]`、`/contracts/[id]`、`/payments`、`/projects`、`/tasks`；统一 RecordHeader、StageStepper、NextActionCard、EventTimeline、ApprovalPanel。

退出：

- Lead → quote → contract → payment/project 的当前可用路径不回归；
- 每个状态变更显示影响、结果和下一步；
- 详情与 work queue 使用同一 work item/事件投影；
- 旧页面组件可通过 route/component flag 恢复。

### F4 — 房地产商业切片

上游：SAM-81；发布适配器部分另依赖 SAM-84。
顺序：

1. Parties/properties/listing readiness；
2. lead/matching；
3. viewing；
4. property offer/counter/accept；
5. deal checklist；
6. commission approval/payroll；
7. publish queue 仅在 adapter gate 完成后启用。

退出：一个组织在 staging 完成 owner/listing → lead/match → viewing → offer → deal → commission 的正向、角色负向、跨组织、幂等、终态、导出和 cleanup 矩阵。UI 只声称通过的子链。

### F5 — 零售商业切片

上游：SAM-82、SAM-83。
顺序：

1. location context、catalog/SKU resolver；
2. inventory balances/movements/transfer/stocktake；
3. pricing/VAT/discount/quotation；
4. order/reservation/fulfilment/return；
5. PR/PO/receiving/replenishment；
6. delivery/COD/handover/finance reconciliation。

退出：一个组织在至少两个 location 范围内完成确定业务链；歧义只重问缺项；inventory/finance actor separation、幂等和 reconciliation 通过。

### F6 — 审批、受控 Agent 与适配器体验

上游：SAM-84。
范围：Approval Center、L0–L4 ActionPanel、建议反馈、adapter capability 状态、重试/reconciliation；AI 只生成结构化事实的摘要/草稿。

退出：spoofed tenant/actor、过期建议、replay、重复外发、L4 尝试和审批 actor separation 通过；未启用适配器无伪成功文案。

### F7 — 运营、迁移与 pilot

上游：SAM-85、SAM-86、SAM-87、SAM-88。
范围：性能预算、投影延迟与错误监控、无障碍回归、exact-SHA staging、canary、回滚、设计伙伴指标基线。

退出：确切 release 的桌面/移动/键盘/读屏 UAT、SLO/告警、迁移/回滚、residue-zero cleanup 和 pilot 证据完成。未经 G8 的垂直不得在营销中声称商用可用。

## 3. 建议的 Linear 工作包

不建议创建第二个前端项目。以下条目应作为现有 SAM issue 的 sub-issue、linked issue 或 bounded PR slice；创建前由总控检查 Linear 实时状态和重复项。

| FE WP | 建议标题 | 上游父项 | 直接依赖 | 独立验收结果 |
|---|---|---|---|---|
| FE-WP-00 | V4 frontend increment contract and baseline | SAM-77 | PR #256 | FE ID、事实边界、指标与验收锁定 |
| FE-WP-01 | Converge shell, context and design tokens | SAM-78 | membership/context contract | 新旧 shell 可切换，组织上下文和 A11y 通过 |
| FE-WP-02 | Project unified work items and explainable NBA | SAM-80 | SAM-78、outbox/task projection | 统一队列、去重、why now、处置审计 |
| FE-WP-03 | Migrate current sales workbench end to end | SAM-80 | FE-WP-01/02 | 当前销售动作完成并自动推进，旧工作台可回退 |
| FE-WP-04 | Unify lead, quote, contract and payment workspaces | SAM-79/80 | FE-WP-01/02/03 | 当前商业链记录页一致且无回归 |
| FE-WP-05 | Deliver real-estate operational workspaces | SAM-81 | SAM-79/80、FE-WP-01/02 | 房地产商业切片 UI 与 G4 证据 |
| FE-WP-06 | Deliver retail catalog-to-finance workspaces | SAM-82/83 | SAM-79/80、FE-WP-01/02 | 零售商业切片 UI 与 G4 证据 |
| FE-WP-07 | Surface approvals, agents and adapters safely | SAM-84 | FE-WP-05/06 | L0–L4、审批、外发与 adapter 状态 |
| FE-WP-08 | Prove frontend release, accessibility and pilot metrics | SAM-86/87/88 | 各 claimed vertical | 性能、A11y、canary/rollback、指标基线 |

FE-WP-01 同时交付 S24 平台控制面壳层与 C01 状态组件；FE-WP-07 交付 `platform_owner`/`platform_ops`/`platform_support`/`platform_auditor` 的服务端能力绑定、support session 和双生命周期审批；FE-WP-08 用 `V4_FRONTEND_NONFUNCTIONAL_GATES.md` 的暂定性能预算、浏览器/规模矩阵和可执行 A11y 模板形成 exact-release 证据。任何工作包不得自行改写 `contracts/v4-id-registry.v1.json` 的 canonical meaning。

每个 Linear 条目建议字段：

- `V4 IDs` 与 `FE IDs`；
- 当前事实、目标和非目标；
- exact base/head；
- capability/tenant/data/event contract；
- 正向、负向、幂等、冲突、A11y、响应式、遥测、cleanup；
- feature flag、迁移、观察和回滚；
- 证据链接与 release SHA。

状态只能在证据存在后更新；本计划不建议把“设计完成”或“PR green”标记为业务切片 Done。

## 4. 建议的 Git/PR 工作方式

### 分支

- #256 已合并；后续前端切片必须从执行时重新查询的 `agent/saas-staging-isolation` exact SHA 建立 `codex/v4-fe-<slice>` 短期分支。
- 本次文档修订使用 `858a4ccb51697b4b4499252bfa3c22963381847e` 作为 exact base；不能默认以 production `main` 为目标。
- 一个分支只承载一个可独立验收/回滚的 FE-WP 子切片。

### PR 契约

每个实现 PR 必须包含：

1. parent SAM、V4 IDs、FE IDs 和上游 PR/SHA；
2. 用户结果、明确非目标、受影响路由/组件/契约；
3. current vs target 截图，使用同 viewport 与同状态；
4. tenant/capability/record ownership/vertical/location 边界；
5. event/work item/command schema 与策略版本；
6. desktop/mobile/keyboard/screen-reader 正向和负向证据；
7. feature flag、迁移顺序、旧体验共存和可执行回滚；
8. exact-head CI 与需要时的 exact-release staging UAT/cleanup。

### 推荐 PR 切片

- PR-A：token、shared components、状态组件和 shell flag；不改业务写入。
- PR-B：work item projection contract + queue read path + telemetry；动作先只读/打开记录。
- PR-C：一个当前销售动作的 end-to-end command/event/queue completion。
- PR-D：当前记录工作区一条完整商业链。
- 后续：每个垂直按完整状态机子链拆分，不把 schema、API、UI、测试拆成互相不可用的 PR。

## 5. 数据与事件迁移

### 5.1 原则

- 不做前端双写。旧/新视图可以双读对照，但业务命令只有一个权威服务端路径。
- 现有 `business_events`、tasks、`next_action`、`next_followup_date` 通过服务端 adapter 投影为 work item；不在浏览器回填 canonical event。
- 新事件使用 schema version 和策略 version；投影可从 checkpoint 重建。
- 未知组织归属、重复全局 ID、事件缺 actor 或不一致终态进入 quarantine，不在 UI 猜测修复。

### 5.2 Feature flags

建议 flag 均由服务端按 organization/user/role/vertical 评估，客户端 flag 不是授权：

| Flag | 范围 | 回退 |
|---|---|---|
| `v4_shell` | 新 shell/context/nav | 旧 DashboardLayout |
| `work_queue_v1` | 统一个人队列 | 旧 `/workbench` |
| `command_center_v1` | 异常优先管理视图 | 旧 `/dashboard` |
| `record_workspace_v1` | 统一记录页组件 | 旧详情组件 |
| `real_estate_ui_v1` | 房地产 pack UI | 路由不可见/CapabilityState |
| `retail_ui_v1` | 零售 pack UI | 路由不可见/现 `/products` |
| `approval_center_v1` | 审批中心 | 旧记录内审批或禁用 |

### 5.3 路由迁移

1. 新路径先以链接方式进入，保留旧路径；不在第一步永久 redirect。
2. query/filter/bookmark 有显式映射；无法映射时回到安全列表并说明。
3. 新体验稳定后，旧路径可 server-side redirect 到新路径；至少一个 release 保留 reverse mapping。
4. 删除旧组件/路由是独立清理 PR，必须先证明无活动 flag cohort、无旧链接流量和回滚依赖。

### 5.4 分析迁移

- 旧/new 事件同时带 `experience_version`、release SHA、policy/projection version。
- 比较只在同一组织/角色/垂直/cohort 内进行；不把 rollout mix 当成业务变化。
- PII、电话号码、邮箱、地址、文档和自由文本不进入分析属性。

## 6. 灰度与回滚

### 灰度顺序

1. internal synthetic organization；
2. 一个已授权 design-partner organization 的单一角色；
3. 同组织完整角色链；
4. 第二个组织验证隔离；
5. 逐垂直扩大 cohort；
6. 达到 G8 后再做商业开放决定。

### 触发回滚的前端阈值类型

具体数值在 pilot 基线后批准；以下事件不等待统计显著性，立即停止 cohort：

- 任何跨组织/跨能力数据暴露或未授权动作成功；
- 重复 financial/inventory/offer conversion 或错误终态；
- work queue 与 record state 系统性不一致；
- L3 被展示为无审批完成，或 L4 出现可执行入口；
- 关键旅程无法使用键盘/移动端完成；
- 新体验错误率/延迟超过已批准的 rollback threshold。

### 回滚步骤

1. 冻结扩容，记录 release SHA、flag cohort、组织、事件与告警时间。
2. 关闭具体 UI flag，恢复旧 shell/route/component；不删除新事件。
3. 停止有问题的 projection/strategy 版本并切回前一稳定版本；命令端点按后端兼容决策处理。
4. 对已接受命令按 idempotency/correlation 查询结果，禁止盲目重放。
5. 核对队列、业务状态、审批、库存/金额和 audit；生成 reconciliation 清单。
6. 清理 synthetic fixtures，保留允许的聚合证据；客户事实按恢复计划处理。
7. 修复后用相同 case 与 cohort 重新验证，不把 UI 回退等同于数据回滚。

## 7. 测试矩阵

每个可变更屏幕至少覆盖：

- 组织 A/B、单/多 membership、active/inactive、role/capability allow/deny；
- vertical entitlement on/off、零售 location allow/deny；
- loading、empty、filtered empty、denied、disabled、stale、offline、500、conflict；
- primary action 成功、失败、重复、超时、刷新、back navigation；
- work item completed/snoozed/skipped/withdrawn/expired/approval pending；
- 320/375/768/1024/1440 viewport、200%/400% zoom；
- keyboard only、焦点顺序/恢复、读屏名称/状态、reduced motion；
- 中文、英文、长文案、RTL 基础；
- analytics/domain-event 关联、无 PII、release SHA；
- flag on/off 和回滚后旧体验。

## 8. 风险登记

| 风险 | 影响 | 最小控制 |
|---|---|---|
| #256 合并后 `docs/v4`、V4 ID 或 canonical SHA 漂移 | 本包映射失效 | 实现前重新锁定上游 SHA/blob；通过独立文档 PR 更新，不静默改写实现 |
| Axon ownership/license 未验证 | 不可复用代码/资产 | 只用 domain semantics；完成 G0 前不导入代码/媒体 |
| 现有事件缺统一 tenant/actor/schema | work item 错归属/不可审计 | 服务端 compatibility adapter、quarantine、负向测试 |
| 队列把多个列表简单合并 | 重复和噪音更严重 | dedupe key、reason、expiry、策略版本与反馈 |
| 页面先于后端状态机 | 伪完成/危险动作 | capability gate；缺契约时只读或 disabled |
| 设计系统改造范围膨胀 | 延误业务切片 | 先收敛核心 token/组件；按使用屏幕迁移 |
| 旧/新体验长期并存 | 双重维护和指标污染 | cohort/version 埋点、退役门禁和独立清理 PR |
| 小屏/键盘作为后补 | 关键旅程不可用 | 每个 PR 同步验收，不留最终 hardening |
| 建议策略偏差 | 用户失信或错误优先级 | 可解释规则、反馈、版本化、分层指标、人工 override |
| 投影延迟 | UI 显示旧状态并重复提交 | stale state、幂等查询、禁止离线 L2/L3 成功 |

## 9. 完成定义

一个 FE-WP 只有在业务结果、服务端边界、UI、A11y/响应式、遥测、flag、迁移、回滚、exact-head CI、需要的 staging UAT 与 cleanup 全部有证据时才完成。设计稿完成、组件合并、单页截图或绿 CI 均不能单独关闭工作包。
