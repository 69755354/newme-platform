# NewMe V4 前端追踪与验收矩阵

状态：Target；上游 V4 ID 来自 PR #256 final head `80f19cc67d26bb592ec8f440fdb965eb224f8b6a`，merge `715fa4bf4a97869077371b16c3094d8599d7e344`
最终上游复核：2026-08-04；current canonical `858a4ccb51697b4b4499252bfa3c22963381847e`

## 1. 追踪规则

每个实现 issue/PR 必须引用：FE ID、上游 V4 ID、screen/journey、work package、正/负验收、feature flag、release SHA 和证据位置。任何一列为空都不能把 Target 提升为 delivered。机器权威映射是 `contracts/v4-id-registry.v1.json` 与 `contracts/frontend-traceability.v1.json`：每个 FE row 必须逐项给出 exact ID、source path、canonical meaning；AC-01..47 必须逐项绑定 FE ID、screen、FE-WP 和 release gate。

来源简写：

- `NM-CUR`：2026-08-03 历史只读核对的 NewMe 源码/生产登录页；不作为 2026-08-04 runtime 声明；
- `V4`：PR #256 final head `80f19cc67d26bb592ec8f440fdb965eb224f8b6a` 已合并的 `docs/v4` 五文件基线；
- `AX`：Axon 用户交付包与可读远端引用，只作 domain/流程来源；
- `IC`：International City OS 用户交付包，只作 retail/control/acceptance 来源；
- `OFF`：本包研究登记中的官方产品/标准资料。

## 2. 需求追踪

| FE ID | 上游 V4 ID | 来源 | Screen/Journey | FE WP | 核心验收 |
|---|---|---|---|---|---|
| FE-001 | V4-PF-001/002、V4-MIG-001 | NM-CUR、V4 | S01–S10 | 01/03/04 | 旧路由/认证/语言继续可用；flag off 无数据变更 |
| FE-002 | V4-PF-001/002/003、V4-RT-001 | V4、IC | 全局 shell | 01 | 组织/垂直/位置切换 fail closed；无旧 context 残留 |
| FE-003 | V4-PF-009、V4-RE-003、V4-RT-009 | NM-CUR、AX、IC、OFF | S02/S03，J1/J2 | 02/03 | 角色默认进入正确队列；旧首页可回退 |
| FE-004 | V4-PF-009/012 | NM-CUR、V4、OFF | S02/S03 | 02 | tasks/alerts/approval 去重为 work item；无重复 active key |
| FE-005 | V4-AI-001/002 | AX、IC、OFF | S02/S03/S07 | 02 | why/evidence/priority/action/outcome/expiry/policy version 齐全 |
| FE-006 | V4-PF-009/012、V4-AI-002 | OFF、IC | S02/S04 | 02/07 | 完成/稍后/跳过/分配/审批均有处置事件与原因 |
| FE-007 | V4-PF-012、V4-AI-003、V4-OPS-002 | NM-CUR、V4 | 全部工作区 | 02 | 只有事实事件确认完成；重复/乱序/延迟安全 |
| FE-008 | V4-PF-009、V4-RE-006、V4-RT-009 | NM-CUR、AX、IC、OFF | S07–S24 | 04/05/06 | 记录摘要/行动/时间线一致，操作不丢上下文 |
| FE-009 | V4-RE-001..008 | AX、V4 | S11–S16，J3/J4 | 05 | 房地产全链正向、角色负向、幂等、终态和 cleanup |
| FE-010 | V4-RT-001..009 | IC、V4 | S17–S21，J5/J6 | 06 | 零售全链、location、actor separation、reconciliation |
| FE-011 | V4-AI-002、V4-RE-007、V4-RT-005/008 | IC、V4、OFF | S04/S15/S16/S21 | 07 | L3 影响/审批/等待可见；L4 无入口且服务端拒绝 |
| FE-012 | V4-PF-002/003、V4-AI-001 | V4、OFF | S05 | 01/07 | 搜索和动作不越 organization/vertical/location/capability |
| FE-013 | V4-PF-002/005、V4-RE-001、V4-RT-001 | NM-CUR、V4 | 全局 shell | 01 | 分组导航按 capability/entitlement 裁剪且可键盘使用 |
| FE-014 | V4-OPS-004 | NM-CUR、OFF-A11Y-003/004/005 | 全部 | 01 | token/组件 lint-review；无新增任意字号/状态色/同义组件 |
| FE-015 | V4-OPS-004 | NM-CUR、OFF | 全部 | 01/08 | 320 reflow；拖拽有替代；mobile 关键旅程完整 |
| FE-016 | V4-OPS-004 | OFF-A11Y-001..005、V4 | 全部 | 01/08 | WCAG 2.2 AA 目标的自动+人工关键旅程证据 |
| FE-017 | V4-PF-002/004/012、V4-INT-001 | NM-CUR、V4 | C01/全部 | 01/02 | 7 类状态有准确原因和恢复，不泄漏内部/跨租户信息 |
| FE-018 | V4-OPS-001/002/004、V4-PILOT-001..003 | V4、OFF | S02/S03/S23 | 02/08 | 指标绑定 context/policy/release，无 PII，可与事实事件核对 |
| FE-019 | V4-PF-002/010/011、V4-OPS-002 | V4、IC | 全部 | 01–08 | 敏感值、缓存、搜索、通知、导出均按能力/租户隔离 |
| FE-020 | V4-MIG-001、V4-OPS-001/003 | V4 | 全部 | 01–08 | flag/route/projection 回退可执行，不删事件/财务/审计事实 |
| FE-021 | V4-PF-009、V4-RT-009、V4-OPS-002 | AX、IC、OFF-CRM-005/006/007 | S03，J2 | 03/05/06 | 异常聚合可下钻到事实，dashboard 无授权绕过 |
| FE-022 | V4-AI-002、V4-OPS-002 | OFF、IC | S02/S03 | 02/08 | 建议反馈版本化、无 PII、不直接改事实/权限 |
| FE-023 | V4-PF-001/005/007 | V4 | S24 | 01/07 | organization provisioning 与 organization lifecycle、billing lifecycle 分离；所有转换有影响预览、审批、事件与回滚 |
| FE-024 | V4-PF-004 | V4 | S24 | 01/07 | platform_support session 有组织、scope、理由、审批、到期/撤销与缓存清除；平台角色不继承客户数据 |
| FE-025 | V4-PF-005/006/008 | V4 | S24 | 01/07/08 | plan、paid seat、quota、usage、invoice reference 并发/超额/对账 fail closed |

## 3. 验收场景

### A. Shell、上下文和导航

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-01 | 多组织用户切换 organization | 显示目标 membership/role/entitlement；旧队列/记录/缓存立即不可见；服务端重新验证 |
| AC-02 | 无 membership 的直接 URL | 返回 denied/not found 的安全状态；不泄漏对象名称、计数或所属组织 |
| AC-03 | 关闭 vertical entitlement | 导航和搜索无该垂直对象；直接 URL fail closed；显示能力未启用而非空数据 |
| AC-04 | 零售 location 切换 | 库存/订单范围重新加载，selection 清空；无权限位置不可选也不可直达 |
| AC-05 | flag off | 恢复旧 shell/route/component；认证、写入和现有业务数据未改变 |

### B. 工作队列与 NBA

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-06 | 同一 lead 同时逾期且有 alert | 相同 reason/dedupe window 只有一个 active item；原因可包含多个来源事件 |
| AC-07 | 工作项解释 | UI 显示 why now、due、priority、primary action、expected outcome、policy version 和证据入口 |
| AC-08 | 完成 L2 动作 | 带 idempotency/version；服务端事实成功且投影确认后才 completed；自动聚焦下一项 |
| AC-09 | 重复点击/刷新/超时重试 | 查询同一 idempotency 结果，不产生重复业务事件或重复终态 |
| AC-10 | Snooze | 必填 resume time/reason；到期恢复；处置历史可审计 |
| AC-11 | Skip/不相关 | 必填 reason；项按策略关闭/重建；反馈不改变底层业务事实 |
| AC-12 | 对象在另一会话已变化 | 建议撤回或返回 conflict；旧动作禁用；用户可刷新当前事实 |
| AC-13 | 投影延迟/离线 | 显示 stale/confirming；L2/L3 不显示本地成功；重连可核对结果 |

### C. 当前商业链

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-14 | 销售从队列记录 follow-up | lead/time/next action 保留；事件/任务更新；队列产生正确下一项 |
| AC-15 | Lead 详情推进阶段 | StageStepper、timeline、queue 一致；非法/终态变更被拒绝 |
| AC-16 | Quote/contract/payment 记录页 | 版本、状态、审批/确认、金额与下一步一致；无角色越权 |
| AC-17 | 错误恢复 | 输入保留、错误关联字段、request ID 可见；重试不重复写入 |

### D. 房地产

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-18 | Listing readiness 缺一个字段 | 只要求该字段；完成后重新评估；未满足前不显示可执行发布 |
| AC-19 | Listing readiness 缺多项 | 按 owner/due/evidence 展示 checklist；百分比不是唯一信息 |
| AC-20 | Matching | 过滤/排序原因可解释；接受/排除可审计；不可用 listing 不推荐 |
| AC-21 | Viewing 完成 | 出席/feedback 分开；未录 feedback 生成工作项；重复完成幂等 |
| AC-22 | Offer counter/accept | 完整谈判历史；过期/撤回/终态保护；接受只创建一次 deal |
| AC-23 | Commission/Payroll | broker/manager/finance 权限分离；split、审批、settlement 和终态可追溯 |
| AC-24 | Portal adapter 未启用/失败 | 未启用显示受限；失败生成异常并支持合规重试/reconciliation；不显示 Published |

### E. 零售

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-25 | SKU 歧义 | 只重问歧义行，其他行结果保留；未解决前不能进入价格/订单终态 |
| AC-26 | 报价确定链 | Resolver→Availability→Price→Policy→Draft 顺序可见；unknown/zero/negative fail closed |
| AC-27 | Discount approval | 超策略显示影响与审批，不允许猜阈值绕过；外发在批准后独立执行 |
| AC-28 | Quote→Order | 接受报价只转换一次；reservation 结果和下一 fulfilment 项可见 |
| AC-29 | Inventory movement/transfer | location、quantity、unit、reason、actor、idempotency 齐全；balance 可 reconciliation |
| AC-30 | Procurement/receiving | PR/PO/receipt actor 与审批准确；差异生成异常而非静默改库存 |
| AC-31 | Delivery/COD | collected、handover、finance confirmed 三事实分离；伪 receipt/signature 禁止 |
| AC-32 | Refund/reconciliation | 金额差异、分配、退款和关闭有独立授权与终态负向测试 |

### F. 风险、隐私和 Agent

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-33 | L3 动作 | 显示对象/影响/金额或数量/收件人/可逆性/审批；等待中不显示完成 |
| AC-34 | L4 动作 | UI 无执行入口；直接命令被服务端拒绝并审计；显示允许替代路径 |
| AC-35 | 搜索/通知/导出 | direct ID、模糊搜索、通知预览、导出均不跨组织/位置/能力泄漏 |
| AC-36 | AI 摘要/草稿 | 可追溯到结构化事实并标记 draft；不能新增理由、改优先级、自动外发/确认 |
| AC-37 | 分析事件 | 不含姓名/电话/邮箱/地址/文档/自由文本；绑定 experience/policy/release |

### G. 响应式、无障碍与视觉一致性

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-38 | 320 CSS px/400% zoom | 除必要二维组件外无页面级双向滚动；信息和功能不丢失 |
| AC-39 | Keyboard | 可完成 J1–J6；焦点顺序/可见/恢复正确；拖拽均有非拖拽替代 |
| AC-40 | Screen reader | 页面/区域/控件有名称；错误、审批、完成和自动推进适度播报 |
| AC-41 | Touch | 独立主控件移动端 44 px；无 hover-only；危险动作不邻近误触 |
| AC-42 | Theme/status | light/dark/auth 使用语义 token；同状态跨列表/详情/通知一致且非颜色单信号 |
| AC-43 | i18n/RTL | 中英文无硬编码混用；长文案不裁切；RTL shell/字段方向基础通过 |

### H. 发布与回滚

| AC | 场景 | 通过条件 |
|---|---|---|
| AC-44 | exact-release UAT | 记录 SHA、artifact、environment、organization/role/vertical、fixtures、结果与 cleanup |
| AC-45 | UI flag rollback | 切回旧体验；已成功命令仍可见；无重复写/数据删除/审计丢失 |
| AC-46 | Projection rollback | 切回前一策略/投影版本并重建/核对队列；业务事实不变 |
| AC-47 | Pilot metrics | 指标有基线、口径、分层和护栏；不把 flag cohort mix 当成产品效果 |

## 4. 证据矩阵

AC 的 Markdown 场景表用于阅读；机器可执行的完整 closure 以 `contracts/frontend-traceability.v1.json#acceptance` 为准。该数组精确包含 AC-01..47，且每项非空绑定 `fe_ids`、`screens`、`work_packages`、`release_gates`；validator 对缺项、未知引用和数量漂移 fail closed。

| 证据类 | 最小材料 |
|---|---|
| Source | 上游 PR/SHA、FE/V4 IDs、来源文件/官方 URL、事实状态 |
| UI | 同 viewport/state 的 before/after 截图；desktop/mobile；组件状态集 |
| Functional | API/contract、浏览器旅程、幂等/冲突/失败/恢复结果 |
| Tenant/security | organization A/B、direct ID/search/export/notification/worker negatives |
| Accessibility | automated report + keyboard/screen-reader manual record + zoom/reflow |
| Telemetry | domain event、work item、analytics event 的 correlation 和无 PII 检查 |
| Release | exact head CI、artifact/manifest/runtime、flag cohort、staging UAT、cleanup |
| Rollback | flag/route/projection 操作、前后状态核对、reconciliation、残留为 0 或获批 |

## 5. Release gate 映射

- G0：上游来源/所有权与本包 FE traceability。
- G1：AC-01..05、33..35 的租户/能力/上下文负向。
- G2：事件/route/projection 版本、幂等、conflict、迁移/回滚。
- G3：plan/entitlement/lifecycle 状态在 shell/disabled/denied 中准确体现。
- G4：AC-18..32 的垂直完整矩阵。
- G5：L0–L4、隐私、文件/外发/adapter 和 A11y 安全状态。
- G6：release provenance、性能、投影延迟、错误与回滚证据。
- G7：旧数据 adapter/quarantine/reconciliation 与 clone rehearsal。
- G8：真实授权 design partner 的 journey、支持、billing/exit 和指标证据。

## 6. 关闭规则

若上游 V4 ID、状态机、组织/能力或事件契约变化，先更新本矩阵再实现。找不到业务事实或服务端边界时，屏幕只能显示只读/未启用状态，不能通过前端假数据满足验收。
