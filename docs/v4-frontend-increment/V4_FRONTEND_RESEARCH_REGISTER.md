# NewMe V4 前端来源与竞品模式登记

状态：2026-08-03 研究锁；只记录本包实际使用的来源。每个官方来源的 canonical `source_id`、`accessed_at`、URL 与精确 locator 由 `contracts/research-source-registry.v1.json` 锁定；本页中的 `OFF` 不再是不可解析的泛标签。
原则：采纳工作模式与交互原理，不复制品牌视觉、页面布局或受版权保护资产

## 1. NewMe 与上游治理

| 来源 | 状态 | 本包用途 |
|---|---|---|
| [PR #256](https://github.com/69755354/newme-platform/pull/256) | 2026-08-03 锁定时 OPEN/Draft，head `8dbab488…`，Repository validation SUCCESS | V4 产品边界、V4 IDs、M0–M8、G0–G8、交付/迁移/事件/证据规则 |
| `C:\tmp\newme-v4-governance-f2bd657\docs\v4` | 5 个文件 Git blob 与 PR #256 head 远端树逐一一致 | 只读建立 FE 增量映射；不复制为新 canonical 文档 |
| `C:\tmp\newme-v4-governance-f2bd657\src` | 本次只读源扫描 | 当前路由、组件、token、导航、workbench、lead detail、event/API 兼容面 |
| `https://app.newme.ae/login` | 浏览器实际打开并截图；未通过登录审查完整 dashboard | 认证页可见视觉证据；不用于声称登录后运行状态 |

当前源码事实绑定本机工作树快照，不自动等价于 production release。截图只证明锁定时可见页面。

## 2. 用户提供的垂直来源

### Axon 房地产交付包

文件：`C:\Users\69755\Desktop\Axon_ClawTeams_Delivery_2026-07-27.zip`
上游登记 SHA-256：`3ABE9E8280FD88CD150477E71A9E70A790CAD128798F492639AB17D0EC812B08`

采用：

- 七类角色工作空间与角色语言；
- lead → match → viewing → offer → deal → commission/payroll；
- listing readiness、permit/Trakheesi/Makani、portal、A2A 等 UAE 房地产语义；
- Team Command/Worklist 的 owner、age、due、why、next action 和 drill-through；
- 规则建议可解释、AI 与确定业务事实分离。

不采用/未验证：

- Axon 运行栈、schema、UI 视觉、部署或“已完成”主张；
- 包内 self-report 的生产、测试、CI、备份和外部集成状态；
- 任何客户数据、图片或代码资产。

### International City OS 零售交付包

文件：`C:\Users\69755\Desktop\International_City_OS_ClawTeams_Handoff_2026.zip`
上游登记 SHA-256：`58D5A9ACB194CEA3CB1ABE1800653F53448BAAD4FA7409F754C2FB6B2AD5978C`

采用：

- company/region/store/warehouse/location、SKU、inventory movement、pricing/quotation、order、procurement、delivery/COD/finance；
- `ProductResolver → Inventory → PricingService → OfferPolicyEngine → OfferDraftService` 的确定顺序；
- 信息足够就继续、只缺一项就只问一项、保留已解析结果；
- L0–L4 风险级与人审边界；
- driver collected、handover、finance confirmed 分离；
- tenant/role/scope/audit/idempotency 的目标验收思路。

不采用/未验证：

- 包内 `CURRENT` 作为已部署/production 事实；
- 30 个 acceptance scenarios 作为已执行结果；
- 外部 POS/ERP/accounting/WhatsApp 等能力已可用的主张。

### Axon 远端仓库

URL：[AxonAIconsultancies/real-estate](https://github.com/AxonAIconsultancies/real-estate)

本次 `git ls-remote --heads` 在当前环境成功读取 `master@53d1fa06169a9179f13068f147cafb1d20f919b7` 与 `feature/department-workflows@34d89e60ab16c3dac4f2250e2b427e768ed700a6`。这与 #256 中“当前 connector 不可读”的快照冲突。

仍未验证：仓库许可证/所有权、交付包与某提交的对应关系、运行环境、生产数据、CI 与部署。因此 G0 完成前仍只复用 domain semantics。

## 3. 官方产品模式

### CRM / SaaS

| 官方来源 | 可解释模式 | NewMe 采用 | 不复制/不采用 |
|---|---|---|---|
| [Microsoft Dynamics 365 Sales work list](https://learn.microsoft.com/en-us/dynamics365/sales/prioritize-sales-pipeline-through-work-list) | 把到期/逾期活动按优先级放入 work list；记录显示 next action、priority、上下文；完成后从队列移除；支持 complete/skip/snooze | 统一 work queue、同屏上下文、主动作、处置、完成后推进 | Microsoft 布局、颜色、license 假设、预测分数为唯一排序 |
| [HubSpot guided actions](https://knowledge.hubspot.com/prospecting/customize-guided-actions) 与 [prospecting queue](https://knowledge.hubspot.com/prospecting/use-the-prospecting-queue) | 管理员控制哪些 guided action、触发时间与默认动作；任务/sequence/guided action 在同一执行页 | 策略版本、criteria/expiry、默认主动作、任务与建议统一 | HubSpot 视觉、固定 action catalog、把厂商预测当 NewMe 事实 |
| [Odoo Activities](https://www.odoo.com/documentation/18.0/applications/essentials/activities.html) | activity 绑定记录；完成后 Suggest/Trigger Next；due/overdue 语义跨视图一致 | Event→work item→next activity；统一截止状态；Done & Schedule Next 思路 | Odoo 界面、把 activity 与 domain event 混为一体 |
| [SAP Situation Handling](https://help.sap.com/docs/SAP_S4HANA_CLOUD/a630d57fc5004c6383e7a81efee7a8bb/516c8ecb7462453ca430a42481cc33ec.html) | 检测关键 situation、通知责任人、提供上下文和建议动作、监控生命周期 | 异常优先的 Team Command、责任/原因/动作/生命周期 | SAP Fiori 视觉、不可解释自动化、将通知视为事实完成 |
| [NetSuite Dashboards](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_N576403.html) 与 [Reminders](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N581945.html) | 角色化 center/dashboard；reminder count 可进入具体待办 | 角色范围和 actionable counts、下钻 | 任意 portlet 拼装和 KPI 墙；NewMe 首发不做无限 dashboard 定制 |

### 房地产

| 官方来源 | 可解释模式 | NewMe 采用 | 边界 |
|---|---|---|---|
| [Propertybase Action Plans](https://help.propertybase.com/hc/en-us/articles/115001625232-Using-Action-Plans) | 房地产重复流程由 task dependency、due、assignee、priority、reminder 组成模板 | Listing/viewing/offer 等阶段 checklist 与依赖、owner、due | 不复制 Salesforce/Propertybase UI 或默认模板 |
| [Propertybase homepage](https://help.propertybase.com/hc/en-us/articles/115002776232-Getting-Started-Series-The-Homepage) | lead-to-close，关系/任务、listing/property、offer/closing 和 dashboard 连续 | IA 使用垂直对象与完整商业链 | 不把不同 vertical 的 Offer 合并 |
| [Yardi CRM IQ](https://www.yardi.com/news/press-releases/yardi-releases-customer-centric-crm-iq/) | prospect/applicant/resident 全旅程、集中 customer view、角色 dashboard | Record workspace 的全旅程上下文与 portfolio drill-down | 新闻稿是产品陈述，不是独立效果证据；不采用视觉 |
| [MRI Agora Orchestrator](https://www.mrisoftware.com/ca/mri-agora-orchestrator/) | 依据 real-estate context 执行规则、清楚解释异常、可配置审批和 human review | 规则优先、异常解释、人审、写回权威系统 | 厂商“autonomous”营销不作为 NewMe 能力声明 |
| [AppFolio Leasing CRM update](https://www.appfolio.com/articles/2025-q2-product-update) | 多物业 inquiry 汇总到一个 guest card；统一 interaction journey | 跨 property 的单一客户上下文和防重复 | 产品效果与 AI 能力是厂商陈述；不直接采用 |

### 零售 / ERP

| 官方来源 | 可解释模式 | NewMe 采用 | 不复制/不采用 |
|---|---|---|---|
| [Dynamics 365 Commerce POS task management](https://learn.microsoft.com/en-us/dynamics365/commerce/task-mgmt-pos) 与 [task links](https://learn.microsoft.com/en-us/dynamics365/commerce/task-mgmt-create-lists) | My/Overdue/Open/Task Lists；任务可链接到完成它所需的具体操作 | 角色队列、异常 filter、work item 直达业务动作 | POS 命令栏和 Microsoft 视觉 |
| [Shopify POS smart grid](https://help.shopify.com/en/manual/sell-in-person/getting-started/smart-grid) | 常用资源/功能 tile 可按 location 用模板管理 | 位置/角色上下文下的有限快捷动作模板 | 任意个人拼装、用 tile 代替统一优先队列 |
| [Shopify POS staff roles](https://help.shopify.com/en/manual/sell-in-person/shopify-pos/staff-management/understanding-pos-staff-management) | location access、role permission、敏感操作 manager approval | location context、capability 与就地审批 | Shopify 的具体权限模型；服务端仍以 NewMe V4 为准 |
| [Shopify order routing](https://help.shopify.com/en/manual/fulfillment/setup/order-routing) | 规则按库存/位置/拆单等顺序决定履约来源 | 在 UI 显示确定 routing reason 和 location | Shopify routing 规则不直接成为 NewMe 规则 |

## 4. 官方无障碍标准

- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)：AA 目标、Focus Visible/Not Obscured、Dragging Movements、Target Size (Minimum) 等门禁。
- [Understanding Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)：等效 320 CSS px 下除必要二维内容外无信息/功能丢失和双向滚动。
- [WAI-ARIA APG Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)：focus move/trap/restore。
- [WAI-ARIA APG Table](https://www.w3.org/WAI/ARIA/apg/patterns/table/)：静态表格优先原生 table；交互 grid 只在确需时使用。
- [WAI-ARIA keyboard guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)：自定义复合控件必须实现对应键盘交互。

## 5. 选择结论

本包最终选择的是一个共同模式：**由确定事件和规则找到需处理的业务情况，在角色/组织/位置范围内形成去重队列，显示原因和上下文，给出一个安全主动作，成功事件确认后推进到下一状态。**

未选择：复制任一竞品视觉、先做大而全 dashboard、把 AI 分数作为唯一理由、让客户端绕过审批/授权、把提醒/点击当业务完成、用一个泛化 Offer/Payment/Task 状态机覆盖两个垂直。
