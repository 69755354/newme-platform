# SAM-23：首批客户就绪与通用模块交付边界合同

| 项目 | 值 |
| --- | --- |
| Linear | SAM-23 |
| 交付类型 | 仓库验收合同；不含运行时或数据库实施 |
| 审计日期 | 2026-07-30 |
| canonical commit | `a9a0ee860925031ce4dfd6ce781430a1619d4413` |
| canonical tree | `7a3cbc461fdabffd113ef2f5d5934e14e245af1f` |
| 当前判定 | **NO-GO：不得接入真实客户** |
| 首期行业 | 房地产/中介、零售 |

> **事实边界：** 本文把 SAM-23 的四项验收转换为可重复的工程与运营门禁。本文没有修改应用、schema、数据库、部署或 Linear 状态，也不证明任何能力已在 staging 或 production 上线。文中的 “required” 表示未来验收要求；“current” 只表示本页列出的 canonical commit 可直接证明的仓库事实。

## 1. 本次最小可验收单元

本次只交付以下两项：

1. 一份同时覆盖通用模块、席位、行业隔离和 10 家公司接入流程的单一验收合同。
2. 一项仓库测试，锁定证据基线、目标模块全集、当前 NO-GO 状态和禁止越级声明的边界。

本次明确不做：

- 不新增或修改 migration、RLS、API、UI、运行时配置或业务数据。
- 不执行 staging、production、server、数据库、部署或 secrets 操作。
- 不接手 SAM-21、SAM-22 的 staging UAT，也不接手 SAM-13 的用户管理与凭据轮换。
- 不把 SAM-23 标记为完成；后续工程单元仍须实现本合同列出的缺口。

## 2. 可审计证据基线

以下 SHA 是 canonical commit 中对应文件的 Git blob SHA-1。测试会重算这些文本 blob；任一来源变化后，本文必须与来源一起复核，不能沿用旧结论。

| 证据 | Blob SHA-1 | 可证明范围 |
| --- | --- | --- |
| `docs/product-decisions/SAM-18-saas-product-boundary.md` | `94a45599582885507ad789d190f237230fc57a60` | 产品、角色、席位、组织和行业边界决策；不证明实施 |
| `docs/product-decisions/SAM-19-organization-membership-data-model.md` | `f6d968456fa82034afca2679d012feaa9bec4560` | 目标数据模型、归属矩阵和分阶段迁移；不证明实施 |
| `supabase/migrations/20260730100000_sam20_lead_organization_isolation.sql` | `7371c83028e8ad23769c4469aa2977e805e2c629` | 组织、membership、支持会话、审计、Lead 组织键和 Lead 子表继承式边界 |
| `supabase/migrations/20260730110000_sam22_two_organization_isolation.sql` | `f0222d10d8653aa9e2c872f0e4cac2a70e7a0651` | 每组织导入幂等键与日报快照组织键 |
| `tests/security/sam20-lead-organization-isolation.test.mjs` | `d4ba0b9f6c1d908172334d6b878e38a814190a40` | SAM-20 静态组织边界合同 |
| `tests/security/sam22-two-organization-isolation.test.mjs` | `f762eaf243e482f51bb09aa825eeb0d0a1a22254` | SAM-22 静态双组织合同 |
| `src/types/database.ts` | `9de949e9e043951e620b83c27b29f4744327113a` | canonical 生成类型中可见的表、列和关系 |

依赖状态按 2026-07-30 读取结果记录如下：

| 依赖 | Linear 状态 | 仓库事实 | 本文处理 |
| --- | --- | --- | --- |
| SAM-18 | Done | 决策文档存在 | 作为产品边界事实源 |
| SAM-19 | Done | 数据模型文档存在 | 作为 schema 目标事实源 |
| SAM-20 | Done | Lead 组织隔离 migration/tests 已合并 | 只引用仓库与本地 disposable DB 证据 |
| SAM-21 | In Review | PR #212 已合并为 canonical `fdf442d…` | staging UAT 未执行；不代做、不宣称通过 |
| SAM-22 | In Review | PR #210 已合并，merge commit `e122dfc…` | staging UAT 未执行；不代做、不宣称通过 |
| SAM-13 | In Progress | 独立用户管理与凭据轮换范围 | 排除，不修改相关实现 |

## 3. SAM-23 四项验收的当前判定

| Linear 验收 | 当前可证明事实 | 判定 | 解除 NO-GO 所需证据 |
| --- | --- | --- | --- |
| 通用模块全部具有组织归属和隔离测试 | Lead、Lead 子表继承式边界和日报快照已有部分证据；报价、合同、回款、项目、任务、文件、报表尚未全部具有直接组织键与完整负向矩阵 | **未通过** | 第 4 节全部模块达到 Ready，数据库与 API/RLS 负向测试通过 |
| 席位计数与成员状态一致 | `memberships.status` 已存在；canonical 尚无 `roles`、`membership_roles` 和确定性付费席位计数实现 | **未通过** | 第 5 节的计数模型与用例全部动态通过 |
| 新公司初始化不需要复制代码或数据库 | `organizations` 支持多行；尚无完整、可重复、无代码/数据库复制的公司初始化流程和全模块模板证据 | **未通过** | 参数化初始化、幂等重跑、零手工 schema 分叉和回滚演练通过 |
| 形成 5–10 家公司接入、支持、备份和退出清单 | 本文第 7–8 节首次形成 10 个无 PII 的 cohort 槽位与统一清单 | **合同已形成；执行未通过** | 逐公司填写证据引用；不得仅勾选文字状态 |

因此，本合同合并后也不能把 SAM-23 或“首批客户就绪”判定为 Done/GO。

## 4. 通用模块组织隔离矩阵

### 4.1 判定口径

- **Ready**：直接、非空 `organization_id`；父子复合外键；组织内唯一键；membership-aware RLS；服务角色路径显式校验；列表、搜索、直接 ID、写入、导出、文件和后台任务负向测试齐全。
- **Partial**：存在父记录继承式 RLS、局部路由过滤或局部报表组织键，但未满足 Ready 全部条件。
- **Missing**：缺少直接组织归属或完整组织授权边界，不能用于第二家公司或真实客户。

### 4.2 目标模块全集

| 模块 | canonical 主要对象 | organization 来源（required） | 当前直接组织键 | 当前证据 | 当前状态 | Ready 前必须补齐 |
| --- | --- | --- | --- | --- | --- | --- |
| 报价 | `quotations` | 从 `leads` 固化；请求值不能覆盖 | 无 | 旧 `quote_no` 为全局唯一；表不在 SAM-20 子表循环 | **Missing** | `organization_id NOT NULL`、Lead 复合 FK、`(organization_id, quote_no)`、列表/详情/导出/转换负向测试 |
| 合同 | `contracts`、`contract_approvals` | 从 Lead/Quotation 固化 | 无 | 现有角色/负责人策略不等于组织隔离 | **Missing** | 组织键、父子复合 FK、组织内合同号、审批/上传/直接 ID/撤销负向测试 |
| 回款 | `installment_plans`、`payments`、`payment_allocations` | 从 Contract 固化 | 无 | 现有 Contract 销售归属策略不等于组织隔离 | **Missing** | 三层组织键、同组织分期/付款约束、记录/确认/分摊/报表负向测试 |
| 项目 | `projects` | 从 Contract 或 Lead 固化 | 无 | `lead_id`/`contract_id` 为可选链路，未形成直接组织边界 | **Missing** | 组织键、父链一致性、无父项目 fail closed、列表/直接 ID/文件负向测试 |
| 任务 | `tasks` | 从 Lead 固化 | 无 | SAM-20 对非空 `lead_id` 提供继承式 restrictive RLS 与 trigger | **Partial** | 直接组织键、Lead 复合 FK、同组织 assignee、搜索/直接 ID/后台任务负向测试 |
| 文件 | `lead_documents` 及 Contract/Quotation/Project 文件引用 | 从唯一业务父记录固化 | 无 | `lead_documents` 有 SAM-20 继承式边界；storage key 尚无强制组织前缀证据 | **Partial** | 直接组织键、父子复合 FK、不可猜测组织前缀、上传/下载/导出/直接 key 负向测试 |
| 报表 | `crm_daily_funnel_snapshot`、Dashboard、Analytics、daily report | 每个聚合任务显式选择一个组织 | 快照有；其余不完整 | SAM-22 快照和 Dashboard 已按组织；Analytics/daily report 尚无完整组织负向矩阵 | **Partial** | 所有查询、缓存键、cron/service-role 聚合显式组织化；跨组织聚合默认禁止 |

### 4.3 所有模块共同的负向测试

每个模块必须在同一 reviewed head 上执行以下矩阵，不能以一条 RLS 静态正则代替动态行为：

1. 组织 A 可以列表、读取、创建和更新自己的记录。
2. 组织 A 对组织 B 的列表、搜索、直接 ID、更新和删除均返回空结果或明确拒绝。
3. 组织 A 不能把子记录关联到组织 B 的父记录。
4. 缺少组织上下文、无效组织 UUID、inactive/suspended membership 全部 fail closed。
5. service-role 路径必须在绕过 RLS 前完成显式组织授权，并留下可核验审计。
6. 缓存键、导出文件、对象存储 key、webhook、cron 和异步任务均包含组织边界。
7. 同一登录身份加入 A/B 两组织时，一次请求只使用一个 active membership，角色和数据不合并。
8. rollback 必须拒绝 production，拒绝残留测试数据，并证明旧合同恢复。

## 5. 席位计数合同

### 5.1 唯一计算规则

一个 membership 计一个付费席位，当且仅当同时满足：

1. `membership.status = 'active'`；
2. `accepted_at IS NOT NULL`；
3. 至少有一个未撤销、organization scope、`is_billable = true` 的角色；
4. 该身份可以执行组织内业务写操作。

同一 membership 的多个付费角色只计一次；同一用户在两个组织的两个 active membership 分别计费。`invited`、`inactive`、`suspended`、`viewer`、`portal_user`、平台人员、服务账号和自动化身份不计人类付费席位。

### 5.2 当前缺口

canonical 已有 `memberships` 与状态，但生成类型没有 `roles`、`membership_roles`，也没有可确定性重算的席位函数、审计事件或套餐上限阻断。因此任何席位数字目前都只能是设计或人工报价输入，不能作为系统计费事实。

### 5.3 必须通过的确定性用例

| 用例 | 输入 | 期望席位变化 |
| --- | --- | ---: |
| S01 | 邀请未接受 + 付费角色 | 0 |
| S02 | active + 一个付费角色 | +1 |
| S03 | 同一 membership 再加第二个付费角色 | 0 |
| S04 | active viewer/portal_user | 0 |
| S05 | active → inactive/suspended | -1 |
| S06 | inactive → active，且未超套餐上限 | +1 |
| S07 | 恢复将超过套餐上限 | 0，操作被阻止 |
| S08 | 同一 user 在第二个组织 active + 付费角色 | 第二个组织 +1 |
| S09 | 平台支持会话访问组织 | 0 |
| S10 | 相同输入重复计算 | 结果和审计摘要完全一致 |

## 6. 共用平台层与行业交付边界

### 6.1 两行业共用平台层

以下能力只能有一套代码与一套 schema，通过 organization 和 industry context 参数化，不能为客户复制仓库或数据库：

- organization、membership、role、seat、audit、support session；
- 客户/联系人、Lead、Pipeline、任务、提醒、通知、文件、搜索；
- Quote、Contract、Payment、Project；
- 导入、导出、Dashboard、webhook、cron、第三方集成；
- UAE VAT 基础字段、个人数据处理目的和结构化电子发票准备字段。

### 6.2 房地产/中介附加包

目标对象为 property、listing、业主、买家、租户、经纪人匹配、委托、佣金、交易阶段、房产文件，以及 DLD/Trakheesi 状态。canonical 当前没有足以证明该行业包已经实施或通过监管集成测试的证据。

### 6.3 零售附加包

目标对象为 product、SKU、variant、inventory、store、location、supplier、purchase、order、return、VAT receipt/invoice、cashier 和 merchandiser 流程。仓库现有 `products` 表不能自动视为零售行业包：它尚无直接组织键，且没有 inventory/store/order/return 的完整行业隔离证据。

### 6.4 行业隔离强制门

`organizations.industry_key` 已存在，只证明组织记录可标记 `real_estate` 或 `retail`；它不证明菜单、API、导入模板或直接 ID 已按行业拒绝访问。Ready 前必须证明：

- 房地产组织不能列出、创建或直接访问零售对象。
- 零售组织不能列出、创建或直接访问房地产对象。
- 通用对象保存显式 industry context 或从 organization 可靠解析，不接受客户端伪造。
- 跨行业汇总默认禁止；若未来开放，必须有新的产品决策、显式授权、脱敏和审计。

## 7. 十家公司接入 cohort

下列 `P01`–`P10` 是无 PII 的验收槽位，不代表真实客户，也不授权创建真实账号或组织。实际接入时必须为每行附证据链接；文字勾选不能替代日志、测试或审计记录。

| 槽位 | 计划行业 | Provision | Membership/Seat | Module Isolation | Support | Backup/Restore | Export/Exit | 最终状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P01 | real_estate | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P02 | real_estate | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P03 | real_estate | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P04 | real_estate | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P05 | real_estate | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P06 | retail | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P07 | retail | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P08 | retail | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P09 | retail | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |
| P10 | retail | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | NO-GO |

## 8. 每家公司统一运营清单

### 8.1 接入前

- [ ] 已签署适用的商业、隐私、数据处理与支持条款；证据引用不含凭据。
- [ ] 套餐、付费席位上限、免费角色、用量与超额处理已书面确认。
- [ ] 行业为 `real_estate` 或 `retail`，且与计划启用的行业包一致。
- [ ] 数据区域、时区 `Asia/Dubai`、币种 AED、VAT 配置和数据保留期已确认。
- [ ] 导入源、数据所有者、字段映射、异常处理和回滚责任人已确认。

### 8.2 参数化开通

- [ ] 通过同一 reviewed release 的参数化流程创建唯一 organization；不用 zero UUID。
- [ ] 重跑相同幂等键不会复制 organization、membership 或基础配置。
- [ ] 不复制代码、仓库、schema、数据库、migration 历史或环境 secrets。
- [ ] 首位 org_owner 的身份与授权经过双人复核。
- [ ] 邀请、接受、角色和席位数与第 5 节用例一致。

### 8.3 组织与行业隔离

- [ ] 使用两个 synthetic organizations 完成第 4.3 节全矩阵。
- [ ] 使用房地产与零售 synthetic organizations 完成第 6.4 节行业负向测试。
- [ ] 文件 key、导出、缓存、webhook、cron、Dashboard 和后台任务没有跨组织结果。
- [ ] viewer/portal_user 不可写、不可管理、不可敏感导出。

### 8.4 支持

- [ ] 平台支持不创建临时 membership。
- [ ] support session 绑定工单、理由、唯一组织、最小 scope 和不超过 4 小时的到期时间。
- [ ] 访问前审计失败时拒绝；过期、撤销、跨 scope 和跨组织全部拒绝。
- [ ] 支持结束后会话撤销，审计包含 outcome 和 request reference。

### 8.5 备份与恢复

- [ ] 备份范围包含组织业务数据、必要配置、文件索引和不可变审计引用。
- [ ] 备份介质、加密、保留、访问权限和删除责任已记录。
- [ ] 使用 synthetic 数据完成按组织恢复演练；恢复到隔离目标，不覆盖另一组织。
- [ ] 恢复后记录数、金额汇总、父子关系摘要和文件归属摘要一致。
- [ ] 备份/恢复证据不导出 PII、凭据或原始客户附件。

### 8.6 导出、停用与退出

- [ ] org_owner 可在只读/欠费阶段导出获授权数据。
- [ ] 导出格式、字段字典、文件清单、校验摘要和生成时间可验证。
- [ ] 成员停用保留历史作者与业务归属；未完成工作需显式重分配。
- [ ] 退出前完成通知、法定/合同保留判断、可验证备份与客户确认。
- [ ] 删除流程在保留期后另行批准；不得由本清单自动触发。
- [ ] 退出后验证登录、API、支持会话和第三方凭据全部撤销，同时保留必要审计。

## 9. 分层 GO / NO-GO 门

| Gate | 最低证据 | 当前状态 |
| --- | --- | --- |
| G0 决策 | SAM-18/19 与本文一致，未实施项明确 | PASS |
| G1 仓库静态 | 目标 schema、API/RLS、行业边界、测试与 rollback 同 head | NO-GO |
| G2 disposable DB | migration apply、双组织正负向、席位、rollback、零残留 | NO-GO |
| G3 staging | current reviewed head 部署；两行业与双组织动态 UAT；备份/恢复/退出演练 | NO-GO |
| G4 首批客户 | 每个 P 槽位都有批准的证据引用、运营 owner 与回滚点 | NO-GO |
| G5 production | 另行总控批准的部署与上线验收 | 不在 SAM-23 本单元范围 |

只有 G0–G4 全部通过，才可把“首批客户就绪”从 NO-GO 改为 GO。仓库 merge、静态测试或本地 disposable DB 单独通过都不能替代 staging 与逐客户证据。

## 10. 后续最小工程单元

为避免一次性大迁移，后续 SAM-23 实施按以下独立单元推进；每项都需要 migration、rollback、生成类型、API/RLS、动态负向测试和同 head CI：

1. Quote → Contract → Installment → Payment 的组织键、组织内编号与复合外键。
2. Project、Task、Lead Document/File 的直接组织键、父链一致性和 storage key。
3. Analytics、daily report、Dashboard、cron、cache 与 service-role 路径的显式组织边界。
4. Roles、membership_roles、确定性席位计数、套餐上限与审计。
5. 参数化 organization 初始化、幂等重跑和无 schema/代码复制证明。
6. 房地产/零售行业上下文、菜单/API/导入/直接 ID 负向矩阵。
7. 经单独授权的 staging 双组织、双行业、备份恢复和退出 UAT。

这些单元不得与 SAM-21/22 的既有 staging 验收或 SAM-13 的用户管理范围混写。

## 11. 风险与回滚

| 风险 | 本单元控制 | 回滚 |
| --- | --- | --- |
| 把设计或本地测试写成上线事实 | 顶部事实边界、证据等级和 NO-GO 锁定测试 | revert 本文与测试 |
| 来源变化后文档继续引用旧结论 | blob SHA 重算门禁 | 更新来源审计与本文，不跳过测试 |
| “Partial” 被销售或实施当作 Ready | Ready 定义要求直接键、复合 FK、RLS、服务角色和动态负向矩阵同时满足 | 保持 G1–G4 NO-GO |
| cohort 表被误当真实客户清单 | 使用 P01–P10 synthetic 槽位，明确无 PII、无账号创建授权 | 删除实际客户信息；本文不得承载 PII |
| 后续大迁移难以回滚 | 第 10 节拆为独立 reviewed 单元 | 每单元独立 rollback；不删除组织或审计事实 |

本单元没有数据或环境变更，所以无需数据库回滚。代码回滚仅为 revert 本文、测试和 TASKBOARD 的 SAM-23 记录；不得借此回滚 SAM-20/21/22 已合并资产。
