# NewMe V4 前端事件与 Next-Best-Action 模型

状态：Target；基于已合并 #256 定义的 V4-PF-009、V4-PF-012、V4-AI-001..003 及各垂直状态机；不构成这些能力已实现声明
最终上游复核：2026-08-04；current canonical `858a4ccb51697b4b4499252bfa3c22963381847e`
原则：事件是事实，工作项是投影，建议是可解释策略结果，浏览器动作是命令意图

## 1. 模型边界

本模型不要求前端直接读取 outbox 或数据库事件表。前端消费经租户、能力、隐私和状态机过滤的投影 API；状态变更通过版本化命令端点执行。

四类对象必须分开：

| 对象 | 含义 | 可否被前端直接创建 |
|---|---|---|
| Domain Event | 已发生且不可变的业务事实 | 否；只由成功的服务端命令/集成产生 |
| Work Item | 从事件、当前状态、SLA 和规则投影出的待处理事项 | 否；由投影服务产生 |
| Recommendation | 对一个 work item 的建议动作、原因和预期结果 | 否；由版本化策略产生 |
| Command Intent | 用户选择的动作及输入 | 是；提交服务端验证，成功后才成为事实 |

现有 `business_events` 的 20 个事件类型可作为兼容输入，但不能直接充当 V4 跨垂直事件契约。迁移期通过 adapter 把既有事件映射到版本化命名；不得在浏览器中把旧字段改写为新终态。

## 2. 事件信封

```json
{
  "event_id": "uuid",
  "event_type": "real_estate.viewing.completed.v1",
  "occurred_at": "2026-08-03T08:00:00Z",
  "recorded_at": "2026-08-03T08:00:01Z",
  "organization_id": "uuid",
  "vertical_key": "real_estate",
  "location_id": null,
  "aggregate_type": "viewing",
  "aggregate_id": "uuid",
  "aggregate_version": 7,
  "actor": {
    "actor_type": "user",
    "actor_id": "uuid",
    "support_session_id": null
  },
  "source": {
    "channel": "web",
    "command": "complete_viewing",
    "adapter_key": null
  },
  "correlation_id": "uuid",
  "causation_id": "uuid",
  "idempotency_key": "server-canonical-key",
  "policy_version": "re-viewing-v3",
  "data_class": "internal",
  "payload": {},
  "schema_version": 1
}
```

约束：

- `organization_id`、actor、capability、vertical entitlement 由服务端权威上下文注入，客户端值不得覆盖。
- 同一 aggregate 的版本单调增加；版本冲突返回可恢复的 conflict，而不是最后写入者静默覆盖。
- 财务、库存、权限、审计和外发事件采用独立命令与更严格策略；不能由通用“更新记录”端点产生。
- payload 按事件类型使用确定 schema；不把客户 PII、token 或完整文件写入分析事件。
- event type 使用 `<domain>.<aggregate>.<past-tense-fact>.v<n>`；过去式强调事实已经发生。

## 3. 事件分类

### 3.1 共享平台事件

| 分类 | 示例 | 典型工作项 |
|---|---|---|
| 组织/成员 | `platform.membership.activated.v1`、`platform.organization.read_only_entered.v1` | 完成 onboarding、处理受限组织 |
| 任务/SLA | `workflow.task.due_soon.v1`、`workflow.task.overdue.v1` | 完成、重新分配、稍后处理 |
| 审批 | `workflow.approval.requested.v1`、`workflow.approval.decided.v1` | 审核影响、批准/拒绝 |
| 文件/证据 | `workflow.document.expiring.v1`、`workflow.file.scan_failed.v1` | 更新文件、处理安全异常 |
| 集成 | `integration.delivery.failed.v1`、`integration.reconciliation_mismatch.v1` | 重试、补充配置、人工核对 |
| 支持/安全 | `platform.support_session.expiring.v1`、`security.policy_denied.v1` | 结束支持、调查重复拒绝 |

### 3.2 房地产事件

| 业务段 | 事实事件示例 | 目标动作 |
|---|---|---|
| Party/compliance | `real_estate.party.document_expiring.v1` | 更新/验证文件 |
| Listing readiness | `real_estate.listing.readiness_blocked.v1` | 完成唯一缺项或查看 checklist |
| Matching | `real_estate.match.candidate_ranked.v1` | 审查理由、接受/排除匹配 |
| Viewing | `real_estate.viewing.requested.v1`、`real_estate.viewing.completed.v1` | 安排、记录出席/反馈 |
| Offer | `real_estate.offer.submitted.v1`、`real_estate.offer.countered.v1`、`real_estate.offer.accepted.v1`、`real_estate.offer.rejected.v1`、`real_estate.offer.withdrawn.v1`、`real_estate.offer.expiring.v1` | 审核、counter、接受/拒绝/撤回 |
| Deal | `real_estate.deal.created.v1`、`real_estate.deal.cancelled.v1`、`real_estate.deal.contract_reference_recorded.v1`、`real_estate.deal.payment_reference_recorded.v1`、`real_estate.deal.checklist_blocked.v1` | 完成合同/付款/交付证据 |
| Commission | `real_estate.commission.approval_requested.v1`、`real_estate.commission.settled.v1` | 经理/财务独立处理 |
| Publish | `real_estate.listing.publish_failed.v1` | 重试或修正适配器问题 |

### 3.3 零售事件

| 业务段 | 事实事件示例 | 目标动作 |
|---|---|---|
| Resolver | `retail.sku.ambiguity_detected.v1` | 只澄清歧义行 |
| Inventory | `retail.inventory.movement_recorded.v1`、`retail.inventory.stocktake_completed.v1`、`retail.inventory.reorder_suggested.v1`、`retail.inventory.negative_risk_detected.v1` | 审核 movement/replenishment/阻断销售 |
| Transfer | `retail.transfer.receipt_overdue.v1`、`retail.transfer.discrepancy_detected.v1` | 收货或核对差异 |
| Pricing | `retail.discount.approval_requested.v1` | 审批折扣 |
| Quotation | `retail.quotation.ready_for_send.v1`、`retail.quotation.sent.v1`、`retail.quotation.accepted.v1`、`retail.quotation.revised.v1`、`retail.quotation.expiring.v1` | 审核外发、修订、接受 |
| Order | `retail.order.created.v1`、`retail.order.reserved.v1`、`retail.order.ready_to_pick.v1`、`retail.order.picking_started.v1`、`retail.order.packed.v1`、`retail.order.fulfilled.v1`、`retail.order.reservation_failed.v1` | 处理缺货、拣货、履约 |
| Procurement | `retail.purchase_request.created.v1`、`retail.purchase_order.issued.v1`、`retail.receipt.posted.v1`、`retail.purchase_request.receipt_mismatch.v1` | 审批、PO、收货差异 |
| Delivery/COD | `retail.cod.cash_collected.v1`、`retail.cod.handover_recorded.v1` | 交接、财务确认 |
| Finance | `retail.finance.confirmed.v1`、`retail.reconciliation.completed.v1`、`retail.reconciliation.mismatch_detected.v1` | 调查、确认、分配、退款/关闭 |

AC-29–AC-32 的事实载荷不得简写：receipt 每行固定携带 `po_line_id`、`sku_id`、正数 `received_qty`、`unit`、`expected_qty`、精确 `variance` 和 over-receipt disposition；inventory movement 固定携带正数 `quantity`、`direction`、`reason_code` 与 `source_reference`；finance confirmation 固定携带正数 `amount_minor`、三位 `currency` 和非空 `reference`。超收只有 `approved_exception` 才可通过，非超收必须为 `not_applicable`。

事件名必须是 `contracts/event-key-registry.v1.json` 的完整 canonical key；禁止省略 domain/aggregate 的局部缩写。95 项事件/命令的严格 payload、source.command 配对和 work-item dispositions 由 `event-command-payload-registry.v1.json` 锁定；信封、Work Item、NBA、Command、Result、Error、stream 和平台读模型分别由 versioned JSON Schema 锁定。

## 4. Work Item 投影

```json
{
  "work_item_id": "uuid",
  "dedupe_key": "organization:policy:aggregate:reason",
  "organization_id": "uuid",
  "vertical_key": "retail",
  "location_id": "uuid",
  "owner_type": "user",
  "owner_id": "uuid",
  "queue": "my_work",
  "status": "ready",
  "priority_band": "P1",
  "title_key": "work.retail.cod_handover.title",
  "reason_code": "COD_HANDOVER_PENDING",
  "why_now": [
    "Cash was recorded by the assigned driver",
    "Finance confirmation is still missing",
    "Handover SLA expires in 3 hours"
  ],
  "source_event_ids": ["uuid"],
  "aggregate": {"type": "delivery", "id": "uuid", "version": 12},
  "due_at": "2026-08-03T11:00:00Z",
  "expires_at": null,
  "primary_action": "record_cash_handover",
  "allowed_dispositions": ["start", "snooze", "reassign"],
  "required_capabilities": ["retail.cod.handover"],
  "risk_level": "L2",
  "policy_version": "rt-cod-v2",
  "projection_version": 4,
  "updated_at": "2026-08-03T08:01:00Z"
}
```

### 生命周期

```text
candidate → ready → in_progress → completed
                  ├→ snoozed → ready
                  ├→ approval_pending → completed/rejected/ready
                  ├→ blocked → ready/withdrawn
                  ├→ skipped
                  └→ expired/withdrawn
```

规则：

- `completed` 只在成功命令对应的事实事件被投影后出现；点击按钮或 2xx 之外的客户端乐观状态不能完成工作项。
- `snoozed` 必须有 `resume_at` 和 reason；到期重新入队但保留处置历史。
- `skipped` 必须有 reason code；若底层风险仍存在，策略可按规定重新生成，但不得制造重复项。
- `withdrawn` 表示对象状态或规则已使工作不再适用，界面显示撤回原因。
- 同一 `dedupe_key` 在一个有效窗口内只有一个 active work item；来源事件可追加。
- work item 关闭不删除事件或审计记录。

## 5. Next-Best-Action 契约

```json
{
  "recommendation_id": "uuid",
  "work_item_id": "uuid",
  "strategy_key": "sales_daily_priority",
  "strategy_version": "5",
  "generated_at": "2026-08-03T08:01:00Z",
  "valid_until": "2026-08-03T12:00:00Z",
  "primary_action": {
    "command": "schedule_viewing",
    "label_key": "action.schedule_viewing",
    "risk_level": "L2",
    "required_inputs": ["slot", "property_id"],
    "expected_event": "real_estate.viewing.scheduled.v1",
    "expected_outcome_key": "outcome.viewing_scheduled"
  },
  "alternatives": ["call_lead", "snooze"],
  "explanation": {
    "reason_codes": ["LEAD_RESPONDED", "MATCH_ACCEPTED", "SLA_4H"],
    "evidence_refs": ["event:uuid", "record:match:uuid"],
    "human_summary_key": "nba.real_estate.schedule_viewing.why"
  },
  "guardrails": {
    "required_capabilities": ["real_estate.viewing.schedule"],
    "approval_required": false,
    "prohibited_when": ["lead.closed", "listing.unavailable"]
  }
}
```

### 5.1 排序方法

首发采用可解释的规则排序，不采用不可审计的单一 AI 分数。比较顺序是稳定的字典序：

1. **权限与适用性过滤**：租户、垂直、位置、角色、对象状态和能力不符合则不进入候选。
2. **安全/合规等级**：即将到期的合规、财务差异、库存风险和明确阻断优先。
3. **时间等级**：超期 > 今日到期 > SLA 即将到期 > 未来计划。
4. **流程解锁价值**：能解除多个下游阻塞或完成阶段 gate 的项优先。
5. **商业上下文**：只使用已批准、可解释的金额/概率/客户信号规则；显示具体原因。
6. **年龄与稳定 tie-break**：更早触发者优先，最后以 work item ID 保证稳定顺序。

`P0` 仅用于安全、合规、资金或关键服务中断；`P1` 为 SLA/审批/流程阻塞；`P2` 为正常推进；`P3` 为优化和准备。视觉严重性与队列顺序均显示文字标签，不能只用颜色。

### 5.2 建议生成原则

- 规则可使用当前事实和经批准的确定计算；LLM 可把结构化 reason codes 转成摘要，但不能新增不存在的原因或更改优先级。
- 建议必须可过期、可撤回、可反馈，并绑定策略版本。
- 若一个字段可解除阻塞，主动作直接收集该字段；不要重新打开完整表单。
- 若操作可能影响客户、资金、库存或终态，先展示影响预览。
- 建议不可用时，显示具体原因（权限不足、对象已变化、能力未启用、审批中），并提供安全下一步。

## 6. 风险与动作呈现

| 风险级 | 前端行为 | 服务端要求 |
|---|---|---|
| L0 | 直接读取；可缓存非敏感结果 | 租户/能力过滤仍生效 |
| L1 | 允许创建草稿、备注或计划；明确“未提交/未外发” | 归属、schema、审计 |
| L2 | 单一确认后提交；成功事件到达后完成 | policy、状态机、幂等、审计 |
| L3 | 显示影响、审批人、证据和等待状态；禁止伪装成即时完成 | 人工审批、actor separation、终态保护 |
| L4 | 不提供执行控件；显示政策解释和允许的替代路径 | 永久拒绝并审计尝试 |

高风险确认不使用模糊“确定吗”。必须包含：对象、动作、影响、金额/数量/收件人（适用时）、是否可逆、审批要求和幂等提交状态。

## 7. 页面更新与一致性

### 初次加载

1. 获取服务端已验证的 session、organization、membership、entitlement 和 capability 摘要。
2. 获取队列 projection，返回 `projection_version` 和 `as_of`。
3. 获取首个 work item 的受限 record context；不预取无权限对象。

### 命令执行

1. 前端生成 UUID `request_token`，通过 `X-NewMe-Request-Token` 携带 aggregate version 与 command payload；它只用于客户端 retry correlation，不是 canonical idempotency key。
2. 服务端在认证 organization/actor、command、aggregate 和 policy 后生成 canonical `idempotency_key`，返回 `accepted/completed/approval_pending/conflict/denied` 之一、request/correlation ID 与该 key；客户端不得提交或覆盖 canonical key。
3. `completed` 仍等待/核对投影事件；短暂延迟显示“已提交，正在确认”，不重复提交。
4. conflict 时展示服务器当前值与用户意图，允许刷新或重新提交安全字段。
5. projection 更新后，关闭/更新 work item 并聚焦下一项；保留可访问状态播报。

### 连接中断

- L0/L1 草稿可在明确本地状态下保留；L2/L3 不做离线成功声明。
- 重连后用服务端返回的 canonical idempotency key 查询结果；若提交响应未到达，只能以原 `request_token` 向同一命令端点安全重试并由服务端关联，避免重复 offer conversion、库存 movement、付款或客户外发。
- 旧投影只显示为“可能已更新”，主动作在重新验证前禁用。

## 8. 前端分析事件

分析事件不替代 domain event。最小集合：

| 事件 | 触发 | 关键非 PII 属性 |
|---|---|---|
| `work_item_exposed` | 工作项在可见区达到曝光阈值 | work type、priority、policy version、vertical、role、release SHA |
| `work_item_opened` | 用户打开工作项 | queue position、entry point |
| `recommendation_action_started` | 启动主/次动作 | action key、risk level |
| `recommendation_dispositioned` | snooze/skip/reassign/feedback | reason code，不含自由文本原文 |
| `command_result_received` | 收到命令结果 | result class、latency bucket、error code |
| `work_item_projection_completed` | 投影确认完成 | correlation ID hash、time-to-complete |
| `next_item_focused` | 自动/手动进入下一项 | transition source |
| `accessibility_recovery_used` | 使用替代操作或错误恢复 | component/pattern key |

关联使用不含原始 PII 的 work item/aggregate surrogate；数据保留、访问和删除遵守 #256 平台策略。

## 9. 典型策略配方

### 房地产：看房后跟进

触发：`real_estate.viewing.completed.v1` 且未记录 feedback。
过滤：当前 organization、listing/lead 有效、用户有 ownership/capability。
why now：看房已完成、反馈 SLA、offer 机会。
主动作：记录 feedback。
完成事件：`real_estate.viewing.feedback_recorded.v1`。
下一项：若有购买意向则生成 offer draft；否则安排后续或关闭原因。

### 房地产：Listing 发布阻断

触发：readiness 检查存在缺项。
去重：listing + missing requirement code。
主动作：若只有一项，直接补该字段/文件；多项时打开 checklist。
保护：adapter 未启用时不显示“发布”主动作。
完成：所有 gate 通过后产生 `real_estate.listing.ready.v1`，再生成独立发布项。

### 零售：低库存补货

触发：确定规则计算达到 reorder 条件。
why now：location、available、incoming、open demand、lead time、threshold。
主动作：创建 purchase request 草稿或审核 transfer 建议。
保护：未知/负数量、SKU 歧义、超审批金额 fail closed。
完成：PR/transfer request 成功事件；审批或执行成为下一项。

### 零售：COD 交接

触发：driver cash collected，尚无 handover。
主动作：记录 handover；Finance confirmation 不是该动作的副作用。
保护：金额差异必须显式记录；不能伪造 receipt/signature。
下一项：Finance 队列核对并独立确认。

## 10. 验收要点

- 同一对象同一 reason 在有效窗口只出现一个 active work item。
- 无权限或不同组织用户无法通过 URL、搜索、队列、通知、导出或 stale cache 获取工作项上下文。
- 每项均显示可人读原因和结构化 reason code；策略版本可追溯。
- L3 不会在前端按钮点击后直接显示业务完成；L4 无可执行入口。
- 完成、跳过、稍后、撤回、失效和冲突均有可审计处置。
- 投影延迟、重复提交、浏览器刷新、网络恢复不会造成重复业务事实。
- 房地产 Offer/Deal/Commission 与零售 Quotation/Order/COD 使用独立状态和动作名称。
