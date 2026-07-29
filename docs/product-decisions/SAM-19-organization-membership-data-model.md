# SAM-19：组织与成员关系数据库模型设计

| 项目 | 值 |
| --- | --- |
| Linear | SAM-19 |
| 文档状态 | 设计定案，待分阶段实施 |
| 设计基线 | `019a143a051b49f7a5d2e1e9f24f9a5f172643a6` |
| 上游决策 | [SAM-18：NewMe SaaS 产品边界与计费决策](./SAM-18-saas-product-boundary.md) |
| 本次范围 | 数据模型、归属矩阵、约束、迁移与回滚设计 |

> **事实边界：** 本文是数据库设计，不是 migration，也不证明任何组织隔离能力已经上线。本次不修改 schema、数据库、RLS、业务代码或部署状态。

## 1. 设计目标

SAM-19 将 SAM-18 的产品决策转换为可分阶段实施的数据边界：

1. 一个登录身份可以加入多个组织。
2. 平台身份与组织成员身份完全分离。
3. 业务数据必须有明确且不可伪造的组织归属。
4. 业务编号、导入幂等键和配置键按组织唯一。
5. 临时支持访问必须有工单、理由、范围、最长四小时的到期时间和先写审计。
6. 迁移过程中旧系统继续可用，每一阶段都有无损回滚路径。

本文不设计自动计费、账户结算或行业业务表；这些任务只能消费本文定义的组织与成员边界。

## 2. 现有 schema 核对

本节只记录仓库 migration 与生成类型可直接证明的事实，不代表 live 数据库状态。

| 当前事实 | 直接证据 | 设计影响 |
| --- | --- | --- |
| `profiles` 以 `auth.users.id` 为主键，一人一行，使用单值 `role` | [`20260601000000_init.sql`](../../supabase/migrations/20260601000000_init.sql)、[`20260605000000_newme_crm_v22_complete.sql`](../../supabase/migrations/20260605000000_newme_crm_v22_complete.sql)、[`database.ts`](../../src/types/database.ts) | `profiles` 只能保留为全局身份资料，组织角色迁移到 membership |
| 当前角色约束为 `admin/boss/sales/designer/operator/finance` | [`20260605000000_newme_crm_v22_complete.sql`](../../supabase/migrations/20260605000000_newme_crm_v22_complete.sql) | 按 SAM-18 映射到组织角色；迁移期不立即删除旧列 |
| `leads/customers/projects/quotations/contracts/payments` 等核心业务表没有 `org_id` | [`database.ts`](../../src/types/database.ts) | 必须先增量补列和回填，再切换 RLS |
| `sku`、`quote_no`、`contract_no` 当前为全局唯一 | [`20260604000003_create_products.sql`](../../supabase/migrations/20260604000003_create_products.sql)、[`20260605000000_newme_crm_v22_complete.sql`](../../supabase/migrations/20260605000000_newme_crm_v22_complete.sql) | 目标约束改为按组织唯一 |
| `activity_logs`、`user_session_daily` 使用 `tenant_id`，历史迁移含 zero UUID 默认 | [`20260612000003_activity_tracking.sql`](../../supabase/migrations/20260612000003_activity_tracking.sql)、[`20260701000007_fix_public_policies_and_log_activity.sql`](../../supabase/migrations/20260701000007_fix_public_policies_and_log_activity.sql) | 不复用 zero UUID；迁移为真实 `organization_id` |
| `contract_approvals` 与 `payment_allocations` 也含 `tenant_id` 默认 | [`20260612000000_contract_pipeline_v1.sql`](../../supabase/migrations/20260612000000_contract_pipeline_v1.sql) | 从父合同/付款确定真实组织后回填 |
| `audit_logs` 有 actor、target、details，但没有组织、支持会话和结果边界 | [`20260613000000_audit_logs.sql`](../../supabase/migrations/20260613000000_audit_logs.sql) | 新建不可变 `audit_events`，旧表只做兼容输入 |
| 现有 RLS 主要检查 `profiles.role` 或业务负责人 | 上述 migrations 与 [`database.ts`](../../src/types/database.ts) | 迁移期双轨；最终以 membership + organization 为授权事实源 |
| 仓库中没有 organization、membership、platform_staff 或 support_session 表 | [`database.ts`](../../src/types/database.ts) | 先新增基础表，不一次性改写业务表 |

## 3. 命名与不变量

### 3.1 统一命名

- 表名使用复数：`organizations`、`memberships`、`roles`、`membership_roles`、`platform_staff`、`platform_staff_roles`、`support_sessions`、`audit_events`。
- 新业务归属列统一为 `organization_id`；历史 `tenant_id` 只在迁移兼容期存在。
- 用户身份统一引用 `auth.users(id)`；`profiles(id)` 保留为可展示资料，不再承载租户归属。
- 所有主键使用 UUID；不得使用 zero UUID 表示“默认组织”或“未知组织”。

### 3.2 永久不变量

1. 每条组织业务记录必须且只能属于一个 organization。
2. 客户输入的 organization 标识不能单独作为授权依据。
3. 一个 `(organization_id, user_id)` 最多有一条 membership。
4. 一个用户可在多个 organization 分别拥有 membership 和角色。
5. 平台角色不自动产生任何组织业务权限。
6. 组织子记录不能引用另一组织的父记录。
7. audit event 只追加，不更新、不删除。
8. support session 没有有效审计、批准、范围或到期时间时必须拒绝访问。

## 4. 目标模型

### 4.1 `organizations`

组织是最小租户、数据、权限和审计边界。

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `id` | UUID PK | 稳定组织 ID |
| `slug` | TEXT NOT NULL | 人类可读路由键 |
| `name` | TEXT NOT NULL | 组织显示名 |
| `industry_key` | TEXT NOT NULL CHECK `real_estate/retail` | SAM-18 首期主行业 |
| `status` | TEXT NOT NULL CHECK `provisioning/active/read_only/suspended/closed` | 组织生命周期 |
| `data_region` | TEXT NOT NULL DEFAULT `uae` | 数据区域标记 |
| `timezone` | TEXT NOT NULL DEFAULT `Asia/Dubai` | 组织业务时区 |
| `created_by` | UUID NULL FK `auth.users` | 创建者；系统创建可为空 |
| `created_at` | TIMESTAMPTZ NOT NULL | 创建时间 |
| `updated_at` | TIMESTAMPTZ NOT NULL | 最近更新时间 |
| `closed_at` | TIMESTAMPTZ NULL | 关闭时间 |

约束与索引：

- 全局 `UNIQUE (lower(slug))`，避免路由歧义。
- `closed_at` 仅在 `status = 'closed'` 时允许非空。
- 首期不创建虚构的 `account_id` 外键；SAM-18 的商业 account 在结算模型确定后单独引入。

### 4.2 `memberships`

membership 表示“一个人以什么状态加入一个组织”，不直接保存多个角色。

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `id` | UUID PK | 稳定 membership ID |
| `organization_id` | UUID NOT NULL FK `organizations` ON DELETE RESTRICT | 所属组织 |
| `user_id` | UUID NOT NULL FK `auth.users` ON DELETE RESTRICT | 登录身份 |
| `status` | TEXT NOT NULL CHECK `invited/active/inactive/suspended` | 成员状态 |
| `invited_by_membership_id` | UUID NULL FK `memberships` | 邀请人 |
| `invited_at` | TIMESTAMPTZ NOT NULL | 邀请时间 |
| `accepted_at` | TIMESTAMPTZ NULL | 接受邀请时间 |
| `deactivated_at` | TIMESTAMPTZ NULL | 停用时间 |
| `recovery_deadline` | TIMESTAMPTZ NULL | SAM-18 的 90 天恢复边界 |
| `created_at` | TIMESTAMPTZ NOT NULL | 创建时间 |
| `updated_at` | TIMESTAMPTZ NOT NULL | 最近更新时间 |
| `version` | BIGINT NOT NULL DEFAULT 1 | 并发更新版本 |

约束与索引：

- `UNIQUE (organization_id, user_id)`。
- `active` 必须有 `accepted_at`。
- inactive/suspended membership 不产生业务权限，也不计付费席位。
- 停用不删除 membership；历史记录继续引用同一 `membership.id`。
- `invited_by_membership_id` 必须与被邀请 membership 属于同一 organization，使用复合外键或约束触发器保证。

### 4.3 `roles`

角色是版本化系统目录，不把权限 JSON 直接写进 membership。

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `id` | UUID PK | 稳定角色 ID |
| `scope` | TEXT NOT NULL CHECK `organization/platform` | 角色命名空间 |
| `key` | TEXT NOT NULL | 稳定机器键 |
| `display_name` | TEXT NOT NULL | 展示名 |
| `is_billable` | BOOLEAN NOT NULL | 是否计付费席位 |
| `is_system` | BOOLEAN NOT NULL DEFAULT true | 是否为系统角色 |
| `permissions_version` | INTEGER NOT NULL | 权限契约版本 |
| `created_at` | TIMESTAMPTZ NOT NULL | 创建时间 |
| `retired_at` | TIMESTAMPTZ NULL | 退役时间 |

约束：

- `UNIQUE (scope, key)`。
- organization scope 固定包含 SAM-18 的 `org_owner/org_admin/manager/sales_agent/operations/finance/specialist/viewer/portal_user`。
- platform scope 固定包含 `platform_owner/platform_ops/platform_support/platform_auditor`。
- 首期不支持组织自定义角色；未来增加时必须另行设计 permission inheritance。

### 4.4 `membership_roles`

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `membership_id` | UUID NOT NULL FK `memberships` ON DELETE RESTRICT | 组织成员 |
| `role_id` | UUID NOT NULL FK `roles` ON DELETE RESTRICT | organization scope 角色 |
| `granted_by_membership_id` | UUID NULL FK `memberships` | 授权人 |
| `granted_at` | TIMESTAMPTZ NOT NULL | 授权时间 |
| `revoked_at` | TIMESTAMPTZ NULL | 撤销时间 |

约束：

- 活跃授权 `UNIQUE (membership_id, role_id) WHERE revoked_at IS NULL`。
- 只能绑定 `roles.scope = 'organization'`。
- 授权人和目标 membership 必须属于同一 organization。
- 角色并集只在当前 membership 的 organization 内生效。

### 4.5 `platform_staff`

平台人员身份独立于 organization membership。

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `id` | UUID PK | 平台人员记录 |
| `user_id` | UUID NOT NULL UNIQUE FK `auth.users` ON DELETE RESTRICT | 登录身份 |
| `status` | TEXT NOT NULL CHECK `active/suspended/offboarded` | 平台人员状态 |
| `staff_ref` | TEXT NOT NULL UNIQUE | 非 PII 的内部人员引用 |
| `created_at` | TIMESTAMPTZ NOT NULL | 创建时间 |
| `updated_at` | TIMESTAMPTZ NOT NULL | 最近更新时间 |
| `offboarded_at` | TIMESTAMPTZ NULL | 离岗时间 |

`platform_staff` 本身不授权；角色通过 `platform_staff_roles` 分配。

### 4.6 `platform_staff_roles`

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `platform_staff_id` | UUID NOT NULL FK `platform_staff` ON DELETE RESTRICT | 平台人员 |
| `role_id` | UUID NOT NULL FK `roles` ON DELETE RESTRICT | platform scope 角色 |
| `granted_by_platform_staff_id` | UUID NULL FK `platform_staff` | 授权人 |
| `granted_at` | TIMESTAMPTZ NOT NULL | 授权时间 |
| `revoked_at` | TIMESTAMPTZ NULL | 撤销时间 |

只能绑定 `roles.scope = 'platform'`；活跃授权按 `(platform_staff_id, role_id)` 唯一。

### 4.7 `support_sessions`

support session 是 `platform_support` 访问指定组织的临时能力，不是 membership。

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `id` | UUID PK | 支持会话 |
| `organization_id` | UUID NOT NULL FK `organizations` ON DELETE RESTRICT | 唯一目标组织 |
| `platform_staff_id` | UUID NOT NULL FK `platform_staff` ON DELETE RESTRICT | 支持人员 |
| `ticket_ref` | TEXT NOT NULL | 外部工单引用 |
| `reason` | TEXT NOT NULL | 访问理由 |
| `scope` | JSONB NOT NULL | 允许的资源与动作白名单 |
| `status` | TEXT NOT NULL CHECK `requested/approved/active/expired/revoked/denied` | 会话状态 |
| `requested_at` | TIMESTAMPTZ NOT NULL | 申请时间 |
| `approved_by_platform_staff_id` | UUID NULL FK `platform_staff` | 批准人 |
| `approved_at` | TIMESTAMPTZ NULL | 批准时间 |
| `expires_at` | TIMESTAMPTZ NOT NULL | 到期时间 |
| `revoked_at` | TIMESTAMPTZ NULL | 撤销时间 |
| `session_token_hash` | TEXT NULL UNIQUE | 只保存不可逆 token hash |
| `created_at` | TIMESTAMPTZ NOT NULL | 创建时间 |

强制规则：

- `expires_at > requested_at` 且 `expires_at <= requested_at + interval '4 hours'`。
- 申请人必须有 active `platform_support` 角色。
- 批准人不能是申请人，且必须有 `platform_owner` 或 `platform_ops`。
- 只有 `status = active`、未过期、未撤销且 scope 命中的会话才可访问。
- 建立 active 会话前必须先成功写入 `audit_events`；审计失败则整个事务失败。

### 4.8 `audit_events`

`audit_events` 是新的不可变审计事实表；现有 `audit_logs` 与 `activity_logs` 在迁移期保留。

| 列 | 类型/约束 | 含义 |
| --- | --- | --- |
| `id` | UUID PK | 事件 ID |
| `organization_id` | UUID NULL FK `organizations` ON DELETE RESTRICT | 组织事件必填；纯平台事件可空 |
| `actor_user_id` | UUID NULL FK `auth.users` ON DELETE SET NULL | 发起身份 |
| `actor_membership_id` | UUID NULL FK `memberships` ON DELETE SET NULL | 组织内发起身份 |
| `actor_platform_staff_id` | UUID NULL FK `platform_staff` ON DELETE SET NULL | 平台发起身份 |
| `support_session_id` | UUID NULL FK `support_sessions` ON DELETE SET NULL | 临时支持上下文 |
| `action` | TEXT NOT NULL | 稳定动作键 |
| `target_type` | TEXT NOT NULL | 目标类型 |
| `target_id` | TEXT NULL | 目标标识，兼容非 UUID |
| `outcome` | TEXT NOT NULL CHECK `success/denied/failure` | 结果 |
| `reason` | TEXT NULL | 业务或拒绝理由 |
| `request_id` | TEXT NOT NULL | 请求关联 ID |
| `metadata` | JSONB NOT NULL DEFAULT `{}` | 受控扩展字段 |
| `ip_address` | INET NULL | 请求来源 |
| `user_agent` | TEXT NULL | 客户端信息 |
| `occurred_at` | TIMESTAMPTZ NOT NULL | 事件发生时间 |

约束与权限：

- 组织事件的 `actor_membership_id` 必须属于同一 `organization_id`。
- support session 事件的 organization 与 `support_sessions.organization_id` 必须一致。
- 应用角色没有 UPDATE/DELETE 权限；写入只允许受控 RPC 或受信服务。
- 敏感字段不写入 metadata；引用对象使用 ID 或不可逆摘要。
- 按 `(organization_id, occurred_at DESC)`、`request_id`、`support_session_id` 建索引。

## 5. 组织上下文与授权

### 5.1 请求上下文

1. 用户选择 organization。
2. 服务端用 `auth.uid()` 与 organization 查询 active membership。
3. 服务端从 membership_roles 计算组织角色。
4. RLS 同时检查记录的 `organization_id` 和 active membership。
5. 客户传入的 organization header、路径或 JWT claim 只能用于选择，不能跳过数据库 membership 校验。

平台支持访问走独立路径：验证 platform staff、platform role、active support session、scope 和过期时间，不创建临时 membership。

### 5.2 防止跨组织外键

只给子表增加 `organization_id` 仍不能阻止“组织 A 子记录引用组织 B 父记录”。目标 schema 对关键父表增加：

```text
UNIQUE (organization_id, id)
```

子表使用复合外键：

```text
(organization_id, parent_id)
  REFERENCES parent (organization_id, id)
```

该规则优先用于 Lead→Quotation→Contract→Payment→Project 链、文件、任务、导入和审计关联。

## 6. 核心实体 organization 归属矩阵

| 当前实体 | 目标归属 | organization 来源 | 目标约束/说明 |
| --- | --- | --- | --- |
| `profiles` | 全局身份 | 无 | 不新增 `organization_id`；通过 memberships 加入组织 |
| `leads` | 直接 | 写入时选定组织 | `organization_id NOT NULL`；所有后续链路的主要根 |
| `customers` | 直接 | 创建组织；迁移时由 lead/contract 推导 | 同组织去重；不做跨组织 unified profile |
| `products` | 直接 | 产品目录所属组织 | `UNIQUE (organization_id, sku)`，删除全局 SKU 唯一 |
| `pipeline_stages` | 直接 | 组织配置 | `UNIQUE (organization_id, stage_key)` |
| `kpi_targets` | 直接 | 目标所属组织 | 唯一键加入 `organization_id` |
| `ad_spend` | 直接 | 广告账户/活动所属组织 | 外部 campaign key 按组织唯一 |
| `quotations` | 直接 + Lead 复合 FK | 从 lead | `UNIQUE (organization_id, quote_no)` |
| `contracts` | 直接 + Lead/Quotation 复合 FK | 从 lead/quotation | `UNIQUE (organization_id, contract_no)` |
| `projects` | 直接 + Lead/Contract 复合 FK | 从 contract 或 lead | 所有关联父记录必须同组织 |
| `installment_plans` | 继承并固化 | 从 contract | `(organization_id, contract_id, seq)` 唯一 |
| `payments` | 继承并固化 | 从 contract | contract 与 installment 必须同组织 |
| `contract_approvals` | 继承并固化 | 从 contract | 替换 zero UUID `tenant_id` |
| `payment_allocations` | 继承并固化 | 从 payment/contract | payment 与 installment 必须同组织 |
| `chat_messages` | 继承并固化 | 从 lead | 外部消息 ID 是否跨组织唯一需按提供商规则单独确认 |
| `activities` | 直接 | 从唯一业务父记录或当前组织 | 多父关联中所有非空父记录必须同组织 |
| `business_events` | 继承并固化 | 从 lead | actor membership 必须在同组织 |
| `follow_up_logs`、`tasks` | 继承并固化 | 从 lead | assignee 必须是同组织 active membership |
| `lead_milestones`、`lead_workflow_stages` | 继承并固化 | 从 lead | 阶段 key 按 lead 唯一 |
| `lead_documents`、`lead_files`、`knx_designs` | 继承并固化 | 从 lead | storage path 也必须包含不可猜测的 organization 前缀 |
| `transfer_history` | 继承并固化 | 从 lead | from/to/actor 改为 membership 引用 |
| `lead_mutation_requests`、`lead_deletion_requests` | 继承并固化 | 从 lead/当前组织 | 幂等键加入 organization 与 actor membership |
| `notifications` | 直接 | 接收者 membership | 引用 `membership_id`，禁止只按全局 user 广播 |
| `user_features` | membership 范围 | 从 membership | `UNIQUE (membership_id, feature_key)` |
| `activity_logs`、`user_session_daily` | 直接 | 当前 active membership | `tenant_id` 迁移为 `organization_id`；禁止 zero UUID |
| `crm_daily_funnel_snapshot` | 直接 | 聚合任务的 organization | 日期、阶段等唯一键加入 organization |
| `lead_assignment_state` | 直接 | 分配池所属组织 | 每组织独立游标，不能跨组织轮转 |
| `audit_logs` | 兼容旧表 | 迁移期尽力补 organization | 新写入逐步切到 `audit_events` |
| `quotes` | 旧模型 | 从 lead/project | 只做兼容回填；不得与 `quotations` 同时扩展新能力 |

“继承并固化”表示写入时从父记录复制 organization，并用复合外键保证一致；不能信任客户端自行提供的值。

## 7. 按组织唯一约束

迁移后的最低约束集合：

| 域 | 唯一键 |
| --- | --- |
| 成员 | `(organization_id, user_id)` |
| 活跃成员角色 | `(membership_id, role_id) WHERE revoked_at IS NULL` |
| 产品 | `(organization_id, sku)` |
| 报价 | `(organization_id, quote_no)` |
| 合同 | `(organization_id, contract_no)` |
| 分期 | `(organization_id, contract_id, seq)` |
| 管道阶段 | `(organization_id, stage_key)` |
| KPI | 原唯一键前置 `organization_id` |
| 导入幂等 | `(organization_id, import_fingerprint)` |
| 变更幂等 | `(organization_id, actor_membership_id, operation, idempotency_key)` |
| 每日会话 | `(organization_id, membership_id, session_date)` |
| 外部集成键 | `(organization_id, provider, external_id)`，除非提供商明确保证全局唯一 |

全局唯一只保留真正的全局身份或路由，例如 `auth.users` 身份与 `organizations.slug`。

## 8. 一人多组织行为

- 用户登录后先取得其 active memberships，不把 `profiles.role` 当作全局权限。
- 每次业务请求只选择一个 organization context。
- 同一用户在组织 A 可为 `org_admin`，在组织 B 可为 `viewer`；两者不合并。
- 席位按 active membership 分别计算；同一组织多角色只计一次。
- 通知、偏好、Dashboard、任务和审计均按 membership/organization 读取。
- 停用组织 A membership 不撤销组织 B membership；平台停用或 auth 用户禁用才影响全部组织。

## 9. 分阶段迁移

每一阶段单独 migration、单独 CI、单独 staging 动态验收；不得把所有步骤放入一个发布。

### Phase 0：基线与预检

- 冻结当前 schema 快照、约束、RLS、函数、视图与数据量。
- 生成“表→组织来源”机器可读清单和无法推导 organization 的异常计数。
- 预检全局 `sku/quote_no/contract_no` 在未来默认组织内是否冲突。
- 不写数据库。

回滚：无写入，无需回滚。

### Phase 1：只新增身份边界

- 新建 organizations、memberships、roles、角色连接表、platform_staff、support_sessions、audit_events。
- 建立唯一的 Legacy organization，使用正常 UUID，不使用 zero UUID。
- 写入 SAM-18 系统角色目录。
- 新表先保持应用不可见；旧业务路径不变。

回滚：在确认没有业务引用前删除本阶段新表；旧系统不受影响。

### Phase 2：成员回填与双写

- 将现有 profiles 映射为 Legacy organization memberships。
- 按 SAM-18 映射旧角色：boss→org_owner、admin→org_admin、operator→operations、sales→sales_agent、finance→finance、designer→specialist。
- 先生成预览和计数，再写入；`org_owner` 必须人工复核。
- 应用成员变更同时写旧 `profiles.role/is_active` 与新 membership；读取仍以旧模型为主。

回滚：关闭双写开关并停止使用新 memberships；保留回填数据供排查，不改旧列。

### Phase 3：业务根表增量补列

- 先给 leads、customers、products、quotations、contracts、projects 等根表新增 nullable `organization_id`。
- 从明确父关系或 Legacy organization 分批回填。
- 对每表建立 `NOT VALID` 外键和一致性检查，再逐批 validate。
- 新写入必须同时写 organization；旧 RLS 仍保留。

回滚：关闭新列写入；保留列与回填值。若必须撤销约束，只删除新约束，不删除业务数据。

### Phase 4：子表、唯一键与复合外键

- 给子表补 organization，并从父记录回填。
- 建立 `(organization_id, id)` 父唯一键与复合外键。
- 先创建新的按组织唯一索引，再移除旧全局唯一约束。
- 将历史 `tenant_id` 映射到真实 organization；任何 zero UUID 行必须进入异常队列，不能自动视为有效组织。

回滚：恢复旧全局唯一约束前先验证没有跨组织重复；保留 organization 数据，不做反向清空。

### Phase 5：RLS 双轨与审计切换

- 新增 membership-aware RLS helper 和新策略，但通过功能开关控制。
- staging 同时比较旧授权结果与新授权结果，差异默认拒绝。
- 新审计写入 `audit_events`；必要时兼容写旧 audit_logs。
- support session 只在本阶段动态负向测试全部通过后启用。

回滚：关闭 membership RLS 与 support access 开关，回到旧策略；新审计数据只读保留。

### Phase 6：强制非空与新模型切流

- 所有异常清零后，将核心 `organization_id` 设为 NOT NULL。
- 组织请求只认 active membership。
- `viewer/portal_user`、跨组织直接 ID、导出、文件、任务、webhook、cron 和 API 完成动态负向测试。
- `profiles.role` 改为兼容影子列，不再作为新授权事实源。

回滚：切回旧授权开关；必要时暂时放宽 NOT NULL/新约束。禁止删除 organization 或 membership 数据。

### Phase 7：旧模型退役

- 至少一个稳定发布周期后，另开任务移除旧角色写入、zero UUID 兼容和旧 RLS。
- 删除旧列/表前必须完成备份、引用扫描、回滚演练和总控批准。
- 本阶段不得与 Phase 6 同一 PR 或同一部署。

回滚：使用 Phase 6 保留的兼容视图或影子列恢复旧读路径；结构删除必须有已验证备份。

## 10. 验收门

后续实现必须至少提供：

1. 新表 DDL 静态检查、权限检查和 down/forward rollback 证据。
2. 一人双组织、每组织不同角色的动态正向测试。
3. 组织 A 对组织 B 的列表、搜索、直接 ID、导出、文件、Dashboard、webhook、cron 和 API 负向测试。
4. 所有关键父子表的跨组织复合 FK 失败测试。
5. `sku/quote_no/contract_no/import_fingerprint/idempotency_key` 的“同组织冲突、跨组织允许”测试。
6. platform staff 没有 support session 时零组织访问；有效会话仅命中指定组织与 scope。
7. support session 超时、撤销、越权、审计失败时全部 fail closed。
8. audit_events 无 UPDATE/DELETE，且 request、actor、organization、结果可追踪。
9. zero UUID 计数为 0，核心 organization NULL 计数为 0。
10. 精确 commit、绿色 CI、staging migration、RLS/API/UAT、风险和回滚点齐全。

## 11. 明确不做

- 本文不执行任何 migration 或数据库写入。
- 不一次性给全部业务表加 NOT NULL 并重写 RLS。
- 不把 `profiles` 复制成每组织一行。
- 不用 JWT 自定义 claim 取代数据库 membership 校验。
- 不让 platform role 隐式继承 organization role。
- 不用 zero UUID、NULL 或“默认全局租户”绕过组织归属。
- 不在 SAM-19 中删除 `profiles.role`、旧 audit 表或历史 `tenant_id`。
- 不宣称组织隔离、支持会话或审计模型已经上线。

## 12. 风险与回滚原则

| 风险 | 控制 | 回滚点 |
| --- | --- | --- |
| 无法从父链确定历史记录组织 | 异常队列 + 人工确认，不自动猜测 | 保留 nullable 列与旧读路径 |
| 新旧角色结果不一致 | 双轨比较，差异拒绝并审计 | 关闭 membership 授权开关 |
| 全局唯一改为组织唯一时产生冲突 | 新索引先建、冲突报告先行 | 旧唯一约束保留到验证完成 |
| 复合 FK 发现历史跨组织关联 | NOT VALID 后逐批验证 | 不 validate，不删除原 FK |
| support access 扩大权限 | 独立身份、双人批准、4 小时、scope、先审计 | 全局关闭 support access |
| 大表回填锁表或延迟 | 小批量、可恢复游标、独立索引阶段 | 停止批次，旧列继续服务 |
| 新模型切流后需要回退 | 至少一个周期保留旧列和兼容写 | 功能开关切回旧模型 |

总原则：先加后切、先验证后约束、先保留后清理。任何回滚都优先切换读取与授权路径，不删除已经产生的组织或审计事实。
