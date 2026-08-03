# NewMe V4 平台运营控制台与组织生命周期

状态：Target；本文件定义前端交付合同，不声称当前路由、API 或生产能力已实现。

## 1. 平台角色与最小权限

| 角色 | 可见范围 | 允许动作 | 必须拒绝 |
|---|---|---|---|
| `platform_owner` | 全部组织的最小运营摘要、计划、席位、配额、支持会话与审计 | 审批组织生命周期、计划/配额例外、创建/撤销支持会话 | 读取客户业务正文、绕过二次确认、删除审计事实 |
| `platform_ops` | 组织状态、健康、使用量和交付状态 | 执行已批准的 organization/billing 转换与恢复 | 支持冒充、查看敏感客户字段、关闭组织 |
| `platform_support` | 工单指定组织的脱敏摘要和获批 scope | 创建有理由、有审批、有最长时限的支持会话；提前撤销 | 无工单浏览、扩大 scope、延长超过政策、修改计划/席位 |
| `platform_auditor` | 只读组织状态、转换、支持会话、计划/席位/配额和审计事件 | 搜索、筛选、导出获批审计证据 | 任何业务或控制面写入、查看未获批 PII |

平台角色与组织内角色相互独立。canonical 组织角色来自上游 V4 capability model（`org_owner`、`org_admin`、`manager`、`sales_agent`、`operations`、`finance`、`specialist`、`viewer`、`portal_user`）；当前 NewMe 旧角色只能由显式兼容映射进入。平台身份不能自动获得组织业务角色；支持访问必须通过独立 support session 注入，服务端按 scope 和 expires_at 校验。

## 2. S24 控制台视图

S24 是一个屏幕，含四个可深链视图，不增加 S25：

| 视图 | 目标路由 | 主要内容 | 主动作 |
|---|---|---|---|
| Organizations | `/platform/organizations` | 状态、plan、trial/grace、席位、配额、release、owner | 发起获批状态转换 |
| Support sessions | `/platform/support-sessions` | 工单、scope、审批人、创建人、到期、撤销、最后活动 | 创建或立即撤销 |
| Plans and entitlements | `/platform/plans` | plan、计费席位、quota、overage policy、vertical/location entitlement | 提交变更和影响预览 |
| Audit | `/platform/audit` | actor、support session、organization、command、result、request/correlation、release | 只读筛选与合规导出 |

客户组织的 `/team` 与 `/settings` 仍属于 S24 的 organization 模式；平台视图必须要求平台角色，不能仅凭组织 admin 显示。

## 3. 生命周期状态机

组织生命周期与计费生命周期是两个独立状态机，禁止用“欠费”直接改写组织状态或用“组织关闭”伪造账单完成：

```text
organization: provisioning -> active -> read_only -> suspended -> export_only -> closed
billing:      trial -> active -> grace -> dunning -> suspended -> closed
```

### 3.1 Organization lifecycle

| 状态 | UI 能力 | 写入规则 | 恢复/退出 |
|---|---|---|---|
| `provisioning` | 显示 immutable organization ID、owner invitation、plan seed、region/timezone 和逐步检查 | 仅幂等 provisioning command；业务路由不可用 | 全部 gate 成功后 active；失败保留可恢复步骤 |
| `active` | 全部已购能力 | 按 capability、seat、quota | 可进入 read_only/suspended/export_only；grace 仅属于 billing lifecycle |
| `read_only` | 全部获授权历史只读、导出入口 | 所有业务写命令 denied；审计/导出任务除外 | 批准恢复 active 或进入 suspended |
| `suspended` | 仅状态、支持、付款/合同和导出申请 | 业务读写默认拒绝；最小恢复接口可用 | 批准恢复或进入 export_only |
| `export_only` | 仅授权导出任务、进度、校验和、保留期限 | 不允许业务写入 | 完成并验收后 closed；或批准恢复 |
| `closed` | 关闭证明、审计引用、保留/删除政策 | 永久拒绝客户业务会话 | 不提供前端自助恢复；独立合规流程 |

### 3.2 Billing lifecycle

| 状态 | 计费含义 | 组织状态投影规则 |
|---|---|---|
| `trial` | 限时试用、trial end 和转正条件 | 通常投影为 organization active；按 entitlement 限制 |
| `active` | 有效 subscription/invoice reference | 不改变组织状态 |
| `grace` | 到期后的获批宽限期 | 服务端策略决定是否保持 active；UI 显示期限和恢复动作 |
| `dunning` | 催收处理中 | 不直接赋予或删除客户数据权限；转换需政策事件 |
| `suspended` | 计费服务暂停 | 可触发获批的 organization read_only/suspended 转换，但必须是另一条命令/事件 |
| `closed` | subscription 关闭 | 不等同 organization closed；数据导出/保留/关闭单独验收 |

任何转换都必须显示当前状态、目标状态、原因、影响、可逆性、审批要求、effective_at 和 request token；结果只有服务端事件确认后才更新。

目标权限由服务端逐目标执行：`platform_owner` 可批准进入 `closed`；`platform_ops` 只能在非 `closed` 目标间执行获批转换；`platform_support` 和 `platform_auditor` 无生命周期写权限。任何角色（包括 `platform_owner`）都不能绕过独立审批；转换命令必须携带同一 `approval_id`、状态 `approved`、不同的申请人/批准人以及 `approval_event_id`，否则零副作用拒绝。组织与计费的 `closed` 必须分别审批，不能由一个转换联动完成。

## 4. 席位、配额和计划旅程

1. 在 Organizations 选择组织，读取服务端 plan、active paid seats、pending invitations、quota usage 和 entitlement version。
2. 输入目标 plan/seat/quota，界面展示即时影响、下个账期、overage、会被禁用的能力和受影响 location/vertical；不计算未由服务端返回的价格。
3. 提交 client `request_token`；服务端返回 canonical `idempotency_key`、approval/status 和 correlation ID。
4. 并发激活超席位、降低 plan 导致在用能力冲突、quota 已超限时 fail closed；不得静默停用用户或删除数据。
5. 事件投影确认后刷新 shell entitlement；旧上下文缓存全部失效。审计显示 before/after、actor、approver、policy/release。

## 5. 支持会话旅程

1. `platform_support` 输入工单号、组织、最小 capability scope、理由和预计时长；最长 4 小时是首发上限，具体政策由服务端版本返回。
2. `platform_support` 只能通过 `request_support_session` 生成独立 `support_session_request_id`/`approval_id`；不能直接创建或批准会话。
3. 与申请人不同的 `platform_owner` 或 `platform_ops` 通过独立 `approve_support_session` 端点批准；结果必须回传同一 `approval_id`、`requested_by_actor_id` 和 `approved_by_actor_id`，然后才创建会话。
4. 进入客户上下文时持续显示 support banner 和倒计时；所有读写事件绑定 support_session_id。
5. 到期、手动撤销、工单关闭或角色失效立即清除上下文、缓存和正在编辑的敏感草稿；下一请求必须 401/403。`platform_owner`/`platform_ops` 可撤销任意 active support session；`platform_support` 只能撤销 `requested_by_actor_id` 等于自己的 active session，不能撤销他人的会话。
6. `platform_auditor` 可核对申请、独立批准、进入、每次命令、退出/到期和残留为零；`platform_support` 无法删除该审计链。

## 6. 拒绝、超时与审计证据

| 场景 | 前端结果 | 零副作用证据 |
|---|---|---|
| 非平台角色直达平台路由 | C01 denied；不显示组织计数/名称 | API 403 + cache tag 无目标组织 |
| support session scope 不含动作 | 控件不显示；直接命令 403 | 无 domain event、无 entitlement change |
| session 到期时页面仍打开 | banner expired，表单锁定，清除数据并回登录/安全页 | 后续 API 401/403；缓存清除事件 |
| 并发 seat 激活超额 | conflict/QUOTA_EXCEEDED，显示服务端 current usage | 无 membership activation event |
| 生命周期版本冲突 | conflict，显示 current state/version，不自动重试 | 无 transition event |
| export 超时 | 显示 retryable 状态与 request/correlation；不声称完成 | 同 idempotency 查询，不创建第二 export |

每个 UAT 证据必须含 exact release SHA、actor role、organization fixture、before/after、request token、server idempotency key、event/audit IDs、denial status、timeout clock 和 cleanup。不得记录 token、cookie、客户正文或生产 PII。
