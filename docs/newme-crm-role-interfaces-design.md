# NewMe CRM 三套角色界面方案 — 基于"谁看到什么、能做什么"

> **文档状态**: 终稿 v1.0  
> **编写人**: 产品总监  
> **日期**: 2026-06-03  
> **基础数据模型**: v2.1（5层: Lead→Quotation→Contract→Project→Payment）

---

## 目录

1. [核心设计原则](#1-核心设计原则)
2. [角色 1：超级管理员/老板 SAM](#2-角色1超级管理员老板-sam)
3. [角色 2：运营/行政 Operator](#3-角色2运营行政-operator)
4. [角色 3：销售 Tanya](#4-角色3销售-tanya)
5. [噪音分析](#5-噪音分析)
6. [DDL 修正建议](#6-ddl-修正建议)
7. [实施优先级](#7-实施优先级)

---

## 1. 核心设计原则

### 1.1 三个角色 ≠ 三个 App

```
同一套 CRM → 同一代码库 → 角色决定：
  ├── 侧边栏菜单（哪些项目可见）
  ├── 页面内容（哪些数据可见）
  ├── 操作按钮（哪些按钮可用）
  └── 数据范围（哪几条记录可见）
```

### 1.2 NewMe 当前人员配置（影响权重）

| 角色 | 人名 | 实际人数 | 使用频率 | 关键约束 |
|------|------|---------|---------|---------|
| 超级管理员 | SAM | 1 | 每天看 2-3 次 Dashboard | 只看不操作，移动端友好 |
| 运营/行政 | (待招/可兼) | 0-1 | 每天持续使用 | 合同+回款+项目交付 |
| 销售 | Tanya | 1 | 全天高频 | 线索推进+活动记录 |

### 1.3 数据可见范围矩阵（核心）

| 数据域 | 老板 SAM | 运营 | 销售 Tanya |
|--------|---------|------|-----------|
| 所有人线索 | ✅ 全量 | ✅ 全量 | ❌ 仅自己 |
| 报价 | ✅ 全量 | ✅ 全量 | ❌ 仅自己的线索关联 |
| 合同 | ✅ 全量 | ✅ 全量 | ❌ 仅自己签约 |
| 分期计划 | ✅ 全量 | ✅ 全量 | ❌ 仅自己的合同关联 |
| 回款记录 | ✅ 全量 | ✅ 全量 | ❌ 仅自己的合同关联 |
| 项目交付 | ✅ 全量 | ✅ 全量 | ❌ 仅自己的项目 |
| 产品库 | ✅ 全量 | ✅ 全量 | ✅ 全量（只读） |
| 销售目标 | ✅ 全量 | ❌ | ✅ 仅自己 |
| 活动记录 | ✅ 全量 | ✅ 全量 | ❌ 仅自己的线索关联 |
| 用户/团队 | ✅ 全量 | ✅ 全量 | ❌ 仅自己 |

---

## 2. 角色 1：超级管理员/老板 SAM

### 2.1 角色画像

> **SAM**：每周看几次，大部分时间在手机上划一眼。不做数据录入。  
> **核心关注**：管道健康度、现金流入/流出、谁在偷懒、谁在丢单。  
> **偶尔操作**：分配线索给 Tanya、把某人线索转给别人、点进某人详情看。

### 2.2 侧边栏菜单

| # | 菜单项 | 图标 | 说明 |
|---|--------|------|------|
| 1 | **驾驶舱** 📊 | 仪表盘 | **默认首页** — 80% 需求在这里 |
| 2 | 线索管道 | 漏斗 | 全部线索的管道视图（只读） |
| 3 | 合同总览 | 文件 | 全部合同状态 |
| 4 | 回款看板 | 钱袋 | 现金流 + 逾期 |
| 5 | 项目交付 | 进度 | 全部项目进度 |
| 6 | 团队概况 | 人头 | 每个销售的数据卡片 |
| 7 | — | 分隔线 | — |
| 8 | 个人设置 | 齿轮 | 通知偏好 |

> **关键决定**：报价、产品库、活动记录不在老板侧边栏出现。老板不需要看报价细节，只需要知道"管道里有值的线索有多少"。

### 2.3 核心页面

#### 2.3.1 驾驶舱 Dashboard（默认首页）

**信息架构**（从上到下，一屏内看完）：

```
┌─────────────────────────────────────────┐
│ 🔝 关键指标行 (4 KPI Card)              │
│  ├── 管道总额 (所有活跃线索 quotation_value 之和)
│  ├── 本月签约额 (本月 contracts 合同金额)
│  ├── 本月回款 (本月 payments 实收)
│  └── 逾期金额 (overdue installment_plans 合计)
│
│ 🔴 预警区块                             │
│  ├── 红线线索: stage='pending_decision' 停留 >14天
│  ├── 红灯回收: leads.recovery_candidate = true
│  ├── 逾期分期: installment_plans.status='overdue'
│  └── 销售停摆: 某销售连续 N 天无活动
│
│ 📈 管道漏斗 (简版)                      │
│  ├── 9 阶段：各阶段线索数量 + 总金额
│  └── 本月新线索数 / 本月成交数 / 输单数
│
│ 👤 团队速览 (每人一行)                  │
│  ├── 名称 | 活跃线索 | 管道价值 | 本月签约 | 本月回款 | 最后活动
│  └── 点击 → 跳转到该销售详情
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `leads`: stage, quotation_value, assigned_to, recovery_candidate, last_contact_date
- `contracts`: sales_id, contract_amount, contract_date, status
- `installment_plans`: status, amount, due_date, contract_id
- `payments`: amount, payment_date, contract_id
- `activities`: user_id, created_at, type
- `v_sales_performance` 视图（已定义）

#### 2.3.2 线索管道（只读版）

```
┌─────────────────────────────────────────┐
│ 📋 过滤栏                                │
│  ├── 按销售: [全部 / Tanya / ...]
│  ├── 按阶段: [全部 / new / contacted / ...]
│  └── 按时间: [本周 / 本月 / 自定义]
│
│ 📊 Kanban 视图 (9 栏)                   │
│  ├── 每栏显示卡片: 客户名 | 金额 | 停留天数 | 负责人
│  ├── 拖拽操作: ❌ 不可拖拽（只读）
│  └── 点击卡片 → 看到线索详情页（只读）
│
│ ⚡ 快捷操作 (在详情页底部)              │
│  ├── [分配线索] → 选择销售
│  ├── [转移线索] → 选择目标销售
│  └── [查看活动] → 活动时间线
└─────────────────────────────────────────┘
```

**所需表/字段**：同上，外加 `profiles`（查看销售列表用于分配）

#### 2.3.3 回款看板

```
┌─────────────────────────────────────────┐
│ 💰 现金流概览                            │
│  ├── 本月应收: SUM(installment_plans.amount WHERE due_date IN 本月)
│  ├── 本月实收: SUM(payments.amount WHERE payment_date IN 本月)
│  ├── 本月逾期: SUM(installment_plans.amount WHERE status='overdue')
│  └── 回款率: 实收/应收
│
│ 📋 逾期清单                             │
│  ├── 每行: 合同号 | 客户 | 销售 | 分期描述 | 金额 | 逾期天数
│  └── [催款] 按钮 → 触发提醒（留给运营操作）
│
│ 📅 近期收款日历                         │
│  ├── 接下来 7 天到期的分期
│  └── 最近 7 天的收款记录
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `installment_plans`: status, amount, due_date, description, contract_id
- `payments`: amount, payment_date, contract_id, confirmed
- `contracts`: contract_no, party_a_name, sales_id
- `v_contract_payment_overview` 视图

### 2.4 关键操作权限矩阵

| 操作 | 老板 | 说明 |
|------|------|------|
| 查看 Dashboard | ✅ | 默认首页 |
| 查看全部线索 | ✅ | 只读 |
| 分配线索 | ✅ | 选择销售→更新 leads.assigned_to |
| 转移线索 | ✅ | 从一个销售转移到另一个 |
| 查看某人详情 | ✅ | 跳转到销售的个人业绩卡片 |
| 修改线索 | ❌ | 不改 |
| 创建报价/合同 | ❌ | 不改 |
| 登记回款 | ❌ | 不改 |
| 修改项目状态 | ❌ | 不改 |

---

## 3. 角色 2：运营/行政 Operator

### 3.1 角色画像

> **运营**：日常 CRM 操作的真正执行者。  
> **核心职责**：合同建档、分期设置、回款录入、项目交付状态跟踪。  
> **不负责**：线索推进、报价生成（那是销售的活）。

### 3.2 侧边栏菜单

| # | 菜单项 | 图标 | 说明 |
|---|--------|------|------|
| 1 | **待办工作台** | 待办 | **默认首页** — 待确认回款 + 待更新交付 |
| 2 | 合同管理 | 文件 | CRUD 全部合同 |
| 3 | 回款管理 | 钱袋 | 登记回款 + 查看分期 |
| 4 | 项目交付 | 进度 | 项目状态更新 + 里程碑管理 |
| 5 | 客户档案 | 通讯录 | 统一客户管理 |
| 6 | 产品库 | 箱子 | 企业管理产品目录 |
| 7 | — | 分隔线 | — |
| 8 | 个人设置 | 齿轮 | — |

> **关键决定**：
> - 运营**不看到**"线索管道"和"报价"菜单（那是销售的事）
> - 运营**不看到**"团队概况"和"销售目标"（那是老板的事）
> - 运营**看不到**任何销售业绩数据（总收入/总回款率等）

### 3.3 核心页面

#### 3.3.1 待办工作台（默认首页）

```
┌─────────────────────────────────────────┐
│ ⏰ 待确认回款                            │
│  ├── 最近 3 天登记、未确认的 payments
│  ├── 每行: 合同号 | 金额 | 日期 | 方式 | [确认] 按钮
│  └── 数量 badge
│
│ ⏳ 待更新交付                            │
│  ├── 里程碑到期但 status 仍为 pending 的
│  ├── 每行: 项目名 | 里程碑 | 预期日期 | 逾期天数 | [更新状态]
│  └── 数量 badge
│
│ 🔔 今日逾期提醒                          │
│  ├── 当天到期的分期（红色高亮）
│  └── 已逾期的分期
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `payments`: id, amount, payment_date, confirmed, contract_id, created_at
- `contracts`: contract_no, party_a_name
- `delivery_plans`: status, expected_date, milestone_name, contract_id
- `installment_plans`: status, due_date, amount, description, contract_id

#### 3.3.2 合同管理

```
┌─────────────────────────────────────────┐
│ 📋 合同列表                              │
│  ├── 过滤: 状态 / 日期 / 销售 / 客户
│  ├── 列表行: 合同号 | 客户 | 金额 | 状态 | 签约日期 | 销售
│  └── 每行右侧: [详情] [编辑] [上传PDF]
│
│ 📄 合同详情页                            │
│  ├── 基本信息：合同号 | 甲方乙方 | 金额 | 日期
│  ├── 关联报价（如果有）
│  ├── 分期计划列表（见下方）
│  ├── 交付计划列表
│  ├── 合同文件（PDF 预览/下载）
│  └── 操作栏:
│       ├── [新建合同] → 表单: lead_id, contract_amount, party_a, date, 分期设置
│       ├── [编辑合同] → 修改基本信息
│       ├── [上传合同文件] → 上传 PDF
│       ├── [添加分期] → 设置 installment_plans
│       └── [终止合同] → 填写终止原因
│
│ 📊 分期计划看板 (合同详情页内嵌)        │
│  ├── 进度条: 已收/总额
│  ├── 表格: 序号 | 描述 | 金额 | 到期日 | 状态 | 已收金额
│  └── 操作: [添加分期] [标记逾期] [取消]
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `contracts`: 全部字段
- `installment_plans`: 全部字段
- `delivery_plans`: 全部字段
- `quotations`: id, quote_no, total_amount, status
- `customers`: id, name, phone
- `profiles`: id, full_name（用于销售列表）

#### 3.3.3 回款管理

```
┌─────────────────────────────────────────┐
│ 💰 回款登记 (表单)                       │
│  ├── 选择合同 (搜索 contract_no)
│  ├── 选择分期 (可选，关联 installment_plan_id)
│  ├── 金额 | 付款日期 | 付款方式 | 参考号
│  └── [确认登记] → 自动触发分期状态更新
│
│ 📋 回款记录列表                          │
│  ├── 过滤: 日期 / 合同 / 方式 / 是否确认
│  ├── 每行: 日期 | 合同号 | 金额 | 方式 | 状态 | 登记人
│  └── 操作: [确认] [编辑] [删除]
│
│ 📊 回款统计                             │
│  ├── 本月回款总额 | 本月回款笔数
│  ├── 按付款方式分布（饼图简要）
│  └── 按合同回款进度（列表）
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `payments`: 全部字段
- `contracts`: id, contract_no, party_a_name
- `installment_plans`: id, seq, description, amount

#### 3.3.4 项目交付

```
┌─────────────────────────────────────────┐
│ 📋 项目列表                              │
│  ├── 过滤: 阶段 / 状态 / 销售 / 优先级
│  ├── 每行: 项目名 | 阶段 | 状态 | 预期完成日 | 客户 | 销售
│  └── [详情] → 项目详情页
│
│ 📊 项目详情页                            │
│  ├── 基本信息：名称 | 阶段 | 状态 | 地址 | 面积
│  ├── 里程碑进度条
│  ├── 里程碑列表：
│  │   每行: 里程碑名 | 阶段 | 预期日期 | 实际日期 | 状态
│  │   操作: [更新状态] [延后日期] [跳过]
│  ├── 文档列表：上传/查看 CAD PDF 照片
│  ├── 验收记录：查看/添加验收结果
│  └── [新建项目] [上传文档] [添加验收] [变更阶段]
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `projects`: 全部字段
- `project_milestones`: 全部字段
- `project_documents`: 全部字段
- `project_inspections`: 全部字段
- `contracts`: id, contract_no

### 3.4 关键操作权限矩阵

| 操作 | 运营 | 说明 |
|------|------|------|
| 查看全部合同 | ✅ | CRUD |
| 新建合同 | ✅ | 从 lead/quotation 生成 |
| 编辑合同 | ✅ | 基本信息 |
| 上传合同文件 | ✅ | 上传 PDF |
| 添加/修改分期 | ✅ | installments CRUD |
| 登记回款 | ✅ | payments INSERT |
| 确认回款 | ✅ | payments.confirmed = true |
| 查看项目 | ✅ | CRUD |
| 更新里程碑 | ✅ | milestone status |
| 上传文档 | ✅ | project_documents INSERT |
| 添加验收 | ✅ | inspections INSERT |
| 查看产品库 | ✅ | 只读 |
| 管理产品库 | ✅ | CRUD (仅运营可改) |
| 查看线索管道 | ❌ | 运营不参与销售 |
| 查看销售业绩 | ❌ | 这不是运营的职责 |
| 查看 Dashboard 大盘 | ❌ | 那是老板的 |

---

## 4. 角色 3：销售 Tanya

### 4.1 角色画像

> **Tanya**：一天到晚在外面见客户、聊 WhatsApp。手机端高频使用。  
> **核心需求**：今天该跟谁谈？我的管道怎么样？快速记一笔活动。  
> **不需要**：公司的财务数据、别人的线索、分期回款细节、产品库管理。  
> **关心**：每条线索的转化率、今天要 follow up 的优先级排序。

### 4.2 侧边栏菜单

| # | 菜单项 | 图标 | 说明 |
|---|--------|------|------|
| 1 | **今日待办** 📋 | 待办 | **默认首页** — 按优先级排序的跟进列表 |
| 2 | 我的管道 | 漏斗 | Kanban 视图（只看到自己线索） |
| 3 | 我的客户 | 通讯录 | 自己关联的 customers |
| 4 | 我的合同 | 文件 | 自己签约的合同（**只读**） |
| 5 | 我的业绩 | 奖杯 | 个人转化率 + 管道路径（**无金额**） |
| 6 | — | 分隔线 | — |
| 7 | 个人设置 | 齿轮 | 通知、签名等 |

> **关键决定**：
> - 销售**不看到**：产品库（不需要管理产品）、报价管理（只需在线索详情里操作）、回款管理、项目交付详情、团队概况、销售目标金额
> - 销售看到的合同是**只读**的，不能修改（那是运营的事）
> - 销售看到的业绩卡片**只显示转化率/数量，不显示金额**

### 4.3 核心页面

#### 4.3.1 今日待办（默认首页）

```
┌─────────────────────────────────────────┐
│ 📋 今日待跟进                            │
│  ├── 排序规则（SQL 逻辑）:
│  │    1. stage_changed_at 超过 3 天且 stage 在 negotiation 之前 → 置顶
│  │    2. last_contact_date 超过 2 天 → 次优先
│  │    3. recovery_candidate = true → 红色标记
│  │    4. 其余按 created_at DESC
│  │
│  ├── 每张卡片:
│  │   客户名 | 阶段 (标签显示) | 金额 (quotation_value) | 停留 X 天
│  │   最后联系: X 天前 | 优先级: HIGH/MEDIUM/LOW
│  │   └── [快速跟进] → 打开快速记录弹窗
│  │
│  └── 底部: "今天已跟进 X/N" 计数
│
│ ⏰ 今日计划                              │
│  ├── activities WHERE type IN ('task','meeting')
│  │     AND due_at = TODAY AND assigned_to = me
│  └── 每项: 类型图标 | 标题 | 时间 | 关联线索
│
│ ➕ 快速入口                              │
│  ├── [记录跟进] → 选线索 → 选类型 → 写备注 → 保存
│  └── [新建线索] → 录入基本信息 → 自动分配给自己
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `leads`: id, assigned_to, stage, quotation_value, customer_name, last_contact_date, stage_changed_at, recovery_candidate, created_at
- `activities`: id, type, due_at, assigned_to, lead_id, description, is_completed
- 优先级排序算法需要的字段全部在 leads 表中

#### 4.3.2 我的管道（Kanban 只读+可拖拽）

```
┌─────────────────────────────────────────┐
│ 📊 管道过滤                              │
│  ├── 视图切换: [Kanban] / [列表]         │
│  └── 搜索: 客户名
│
│ 🎯 Kanban 9 栏                           │
│  ├── new → contacted → requirement_confirmed →
│  │   solution_submitted → quotation_submitted →
│  │   negotiation → pending_decision → won / lost
│  │
│  ├── 每张卡片:
│  │   客户名 | 报价金额 (quotation_value) | 赢单概率 (win_probability)
│  │   停留天数 | 最后联系日期
│  │
│  ├── 可拖拽: 拖到下一阶段 → 自动:
│  │   ├── UPDATE leads.stage
│  │   ├── UPDATE leads.stage_changed_at = now()
│  │   └── INSERT INTO activities (type='stage_change', ...)
│  │
│  └── 点击卡片 → 线索详情页:
│      ├── 基本信息 (名称/电话/WhatsApp/地址/来源)
│      ├── 阶段历史 (stage_changed_at + business_events)
│      ├── 报价历史 (关联 quotations，可创建新报价)
│      ├── 活动时间线 (关联 activities)
│      └── 操作栏:
│           ├── [推进阶段] → 选择下一阶段
│           ├── [创建报价] → 跳转到报价编辑
│           ├── [记录活动] → 快速弹窗
│           ├── [标记成交] → stage='won' + 可选创建合同
│           └── [标记输单] → stage='lost' + 输单原因
│
│ 📊 管道统计 (页面顶部)                   │
│  ├── 活跃线索数 | 管道总金额 | 本月成交数
│  └── 本月转化率 (won / (won+lost) )
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `leads`: 全部字段（但过滤 `assigned_to = current_user`）
- `quotations`: id, quote_no, total_amount, status, lead_id (仅关联自己的 leads)
- `quotation_items`: quotation_id (通过 quotation 关联)
- `activities`: lead_id, type, created_at, description (仅关联自己的 leads)
- `business_events`: lead_id, event_type, description, created_at
- `customers`: name, phone, whatsapp, address (通过 lead 关联)

#### 4.3.3 我的业绩（转化率视角，无金额）

```
┌─────────────────────────────────────────┐
│ 📈 本月概览                              │
│  ├── 新线索: N 条
│  ├── 跟进次数: N 次
│  ├── 成交: N 单
│  ├── 输单: N 单
│  └── 转化率: N%
│
│ 📊 管道分布                              │
│  ├── 饼图/条形: 各阶段线索数量分布
│  ├── 阶段停留时间: 哪个阶段卡最久
│  └── 丢单分析: lost 原因分布
│
│ 📋 近期成交                              │
│  ├── 最近 5 条 won 的线索
│  └── 每行: 客户 | 成交日期 | 金额(只显示给你看)
│
│ 📋 近期输单                              │
│  ├── 最近 5 条 lost 的线索
│  └── 每行: 客户 | 丢单日期 | 丢单原因
└─────────────────────────────────────────┘
```

**所需表/字段**：
- `leads`: assigned_to, stage, won_lost_at, lost_reason, quotation_value
- `activities`: user_id, type, created_at

### 4.4 关键操作权限矩阵

| 操作 | 销售 | 说明 |
|------|------|------|
| 查看自己的线索 | ✅ | assigned_to = me |
| 推进阶段 | ✅ | 拖拽 Kanban 或点击[推进阶段] |
| 记录活动 | ✅ | activities INSERT |
| 创建报价 | ✅ | quotations INSERT (关联自己的 lead) |
| 标记成交/输单 | ✅ | leads.stage = 'won'/'lost' |
| 查看自己的报价 | ✅ | 通过自己的 leads 关联 |
| 查看自己的合同 | ✅ | 只读，sales_id = me |
| 查看自己的分期 | ✅ | 通过自己的 contract 关联（只读） |
| 查看自己的项目 | ✅ | 通过自己的 contract/project 关联（只读） |
| 看到别人的线索 | ❌ | RLS 禁止 |
| 看到回款金额汇总 | ❌ | 看不到总的现金流数据 |
| 看到别人业绩 | ❌ | 看不到其他 sales 的信息 |
| 看到产品库 | ❌ | 不需要管理产品 |
| 新建/修改合同 | ❌ | 那是运营的事 |
| 登记回款 | ❌ | 那是运营/财务的事 |
| 修改项目状态 | ❌ | 那是运营/项目经理的事 |
| 看到销售目标金额 | ❌ | 不在她的界面中出现 |
| 上传合同文件 | ❌ | 运营操作 |

---

## 5. 噪音分析

### 5.1 对销售 Tanya 是噪音的功能（当前方案中应移除或隐藏）

| # | 功能/数据 | 为什么是噪音 | 处理方式 |
|---|-----------|-------------|---------|
| 1 | **全量线索列表** | 她只关心自己的线索，看到 100 条别人的线索 → 分心 | RLS 过滤 + 菜单不显示"全部线索" |
| 2 | **合同金额分期详情** | 她不需要知道"首付 30% 尾款 70%"，只需要知道"这个单成了" | 合同详情隐藏分期细节，只显示状态 |
| 3 | **累计回款金额** | 她知道"回款了"就够了，公司总现金流不是销售职责 | 她的业绩页面隐藏金额，只显示数量和转化率 |
| 4 | **项目交付详细进度** | CAD 文档、验收清单、采购清单都不应该出现在销售界面 | 项目页面简化成"进行中/已交付"状态标签 |
| 5 | **产品库 CRUD** | 销售不需要管理 SKU / 成本价 / 产品规格 | 报价时从产品库选即可，不显示管理入口 |
| 6 | **销售目标金额** | 给她看"本月目标 500K" → 压力之外无生产力 | 只在老板侧可见 |
| 7 | **逾期回款清单** | 催款不是销售的职责 | 属于运营待办工作台 |
| 8 | **团队概况/其他人业绩** | 不知道别人成交了多少，专注自己 | 完全隐藏 |
| 9 | **报价版本链** | 报价 v1 → v2 → v3 的复杂版本追踪 | 只显示"最新报价" + "历史版本"可展开 |
| 10 | **business_events 审计日志** | 看到系统自动插入的大量事件噪音 | 活动时间线只显示人工操作的活动 |

### 5.2 对老板 SAM 是噪音的功能

| # | 功能/数据 | 为什么是噪音 | 处理方式 |
|---|-----------|-------------|---------|
| 1 | **报价明细行项目** | 老板不需要知道这个合同里是灯还是窗帘 | Dashboard 只聚合到合同金额级别 |
| 2 | **单个客户的活动时间线** | 老板不需要看 Tanya 和客户聊了什么 | 只在下钻到某人详情时才显示 |
| 3 | **产品 SKU / 成本价管理** | 老板知道大概毛利即可，不需要看每个产品的成本 | 完全不在老板界面出现 |
| 4 | **项目里程碑明细** | "CAD 设计确认→设备采购→现场安装" 太细 | Dashboard 只显示"项目总数/进行中/已完成" |
| 5 | **验收检查清单** | 老板不需要看 checklist 每一项 | 验收结果只聚合为 pass/fail 计数 |
| 6 | **分期计划明细** | "第 1 期 30% 第 2 期 30% 第 3 期 40%" 太细 | 只聚合为"已收/未收/逾期" |
| 7 | **报价版本管理** | 报价发了几个版本不重要 | 不出现 |
| 8 | **活动类型细分** | call/whatsapp/email/meeting 的类型不重要 | 只聚合为"跟进次数/最后跟进时间" |
| 9 | **线索来源/渠道** | 营销渠道数据在当前阶段不重要 | 不显示 |
| 10 | **交付计划表** | "布线检查→安装检查→系统调试" 运营层面的计划 | 不显示，老板只看项目整体进度 |

### 5.3 对运营是噪音的功能

| # | 功能/数据 | 处理方式 |
|---|-----------|---------|
| 1 | 线索管道 Kanban | 不出现 |
| 2 | 销售个人转化率 | 不出现 |
| 3 | 销售目标设定 | 不出现 |
| 4 | Dashboard 大盘数据 | 不出现 |
| 5 | 报价生成/编辑 | 不出现（这是销售的活） |
| 6 | 线索分配 | 不出现（这是老板的活） |

---

## 6. DDL 修正建议

现有 DDL 方案已做了一定的 RLS（Row Level Security）设计，但以下方面需要修正以完整支撑角色分权：

### 6.1 profile 角色枚举缺失"boss"角色

当前角色枚举：`'admin','sales','designer','operator','finance'`

**当前问题**：老板 SAM 在系统中应有一个明确的角色，而不是用 `admin` 冒充。`admin` 可以操作一切（CRUD），但老板是"只看不操作"。

**修正方案**：

```sql
-- 新增 boss 角色
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('boss','admin','sales','designer','operator','finance'));

-- 含义：
-- boss:    超级管理员，只看不操作（除分配线索）
-- admin:   系统管理员，可以操作一切
-- sales:   销售，仅操作自己的数据
-- operator: 运营，合同/回款/项目管理 CRUD
-- designer: 设计师，项目管理（未来）
-- finance: 财务，回款管理（当前可合并到 operator）
```

### 6.2 销售线索自动分配与回收逻辑

当前 DDL 定义了 `recovery_candidate` 和 `transfer_candidate` 标记，但：

**缺失**：自动分配逻辑（新线索 → 自动分配给唯一销售 Tanya）

```sql
-- 新增: 线索创建时自动分配给默认销售
-- 当前只有 1 个销售，新增线索应自动分配给她
CREATE OR REPLACE FUNCTION auto_assign_lead()
RETURNS TRIGGER AS $$
DECLARE
  v_default_sales_id UUID;
BEGIN
  -- 如果线索没有指定负责人，分配给唯一活跃销售
  IF NEW.assigned_to IS NULL THEN
    SELECT id INTO v_default_sales_id
    FROM profiles
    WHERE role = 'sales' AND is_active = true
    ORDER BY last_active_at DESC NULLS LAST
    LIMIT 1;

    NEW.assigned_to := v_default_sales_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_auto_assign ON leads;
CREATE TRIGGER trg_lead_auto_assign
  BEFORE INSERT ON leads
  FOR EACH ROW
  WHEN (NEW.assigned_to IS NULL)
  EXECUTE FUNCTION auto_assign_lead();
```

### 6.3 老板 RLS 策略缺失

当前 DDL 的 RLS 策略将 `admin` 和 `operator` 混在一起授予全部权限。拆分后：

```sql
-- boss 角色：全表 SELECT 权限 + leads UPDATE（仅分配/转移）
-- ========================================================

-- leads: boss 可 SELECT 全部，UPDATE 仅 assigned_to 字段
CREATE POLICY "leads_boss_select" ON leads FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
CREATE POLICY "leads_boss_update" ON leads FOR UPDATE
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- contracts: boss 可 SELECT 全部
CREATE POLICY "contracts_boss_select" ON contracts FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- payments: boss 可 SELECT 全部
CREATE POLICY "payments_boss_select" ON payments FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- installment_plans: boss 可 SELECT 全部
CREATE POLICY "installment_boss_select" ON installment_plans FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- projects: boss 可 SELECT 全部
CREATE POLICY "projects_boss_select" ON projects FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- sales_targets: boss 可 CRUD
CREATE POLICY "targets_boss_all" ON sales_targets FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- profiles: boss 可 SELECT 全部
CREATE POLICY "profiles_boss_select" ON profiles FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- activities: boss 可 SELECT 全部
CREATE POLICY "activities_boss_select" ON activities FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));

-- quotations: boss 可 SELECT 全部
CREATE POLICY "quotations_boss_select" ON quotations FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'boss'));
```

### 6.4 销售不可见金融数据的 RLS 强化

当前 DDL 允许销售 SELECT `contracts` 和 `payments`（仅自己的合同关联）。但需要确保：

```sql
-- 销售看到的 contracts: 只显示状态和合同号，不显示金额
-- 方案1: 创建销售专用视图（隐藏金额）
CREATE OR REPLACE VIEW v_sales_contracts AS
SELECT
  id, contract_no, contract_date, status,
  party_a_name, -- 不暴露 contract_amount
  lead_id, quotation_id, customer_id
FROM contracts
WHERE sales_id = auth.uid();

-- 方案2: 前端层面过滤（更简单，推荐）
-- 前端根据角色决定渲染哪些字段
```

**推荐方案**：前端角色判断 + API 层面控制。后端全部数据可用但前端根据 role 渲染不同模板。这是"界面方案"层面的控制，不需要修改 DDL 做金额隐藏。

### 6.5 销售业绩视图去金额化

当前 `v_sales_performance` 视图包含所有金额数据。需要为销售创建专用视图：

```sql
-- 销售专用业绩视图（只有数量和转化率，没有金额）
CREATE OR REPLACE VIEW v_sales_personal_stats AS
SELECT
  p.id AS user_id,
  p.full_name,
  COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost')) AS active_leads,
  COUNT(l.id) FILTER (WHERE l.stage = 'won') AS won_count,
  COUNT(l.id) FILTER (WHERE l.stage = 'lost') AS lost_count,
  CASE
    WHEN COUNT(l.id) FILTER (WHERE l.stage IN ('won','lost')) > 0
    THEN ROUND(
      COUNT(l.id) FILTER (WHERE l.stage = 'won')::DECIMAL
      / COUNT(l.id) FILTER (WHERE l.stage IN ('won','lost'))
      * 100, 1
    )
    ELSE 0
  END AS conversion_rate,
  -- 隐藏金额，只显示数量级标签
  CASE
    WHEN COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost')) = 0 THEN '无活跃线索'
    WHEN COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost')) <= 3 THEN '少量'
    WHEN COUNT(l.id) FILTER (WHERE l.stage NOT IN ('won','lost')) <= 10 THEN '中等'
    ELSE '大量'
  END AS pipeline_volume
FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
WHERE p.id = auth.uid()
GROUP BY p.id, p.full_name;

COMMENT ON VIEW v_sales_personal_stats IS '销售个人统计（无金额）：专供销售角色使用';
```

### 6.6 索引修正

增加角色分权查询所需的索引：

```sql
-- 老板 Dashboard 查询：按阶段聚合所有线索
CREATE INDEX IF NOT EXISTS idx_leads_stage_amount ON leads(stage) INCLUDE (quotation_value, assigned_to);

-- 老板 Dashboard：按月查看合同签约额
CREATE INDEX IF NOT EXISTS idx_contracts_date_amount ON contracts(contract_date) INCLUDE (contract_amount, sales_id);

-- 运营待办工作台：待确认回款查询
CREATE INDEX IF NOT EXISTS idx_payments_unconfirmed ON payments(confirmed, created_at DESC)
  WHERE confirmed = false;

-- 运营待办工作台：待交付里程碑
CREATE INDEX IF NOT EXISTS idx_delivery_pending ON delivery_plans(status, expected_date)
  WHERE status IN ('pending', 'in_progress');
```

---

## 7. 实施优先级

### 🥇 第一优先：销售 Tanya 的界面

**理由**：

1. **Tanya 是唯一每天使用的人**。1 个销售每天用 8 小时 vs 老板每天看 2 次。销售的效率直接影响收入。
2. **MVP 最核心流程**：线索推进 → 报价 → 成交 → 合同。这条链路必须先跑通。
3. **回报最快**：Tanya 今天用上今天的线索推进效率就提高了，直接影响本月业绩。
4. **人数决定**：当前只有 1 个销售，需要尽快让她用起来，验证产品价值。

**实施顺序**：

```
Sprint 1 (本周):
  ├── 今日待办页面（优先级排序算法）
  ├── 我的管道 Kanban（只读 + 拖拽推进阶段）
  ├── 快速跟进记录（activities 录入）
  ├── 线索详情页（基础信息 + 活动时间线）
  └── 标记成交/输单

Sprint 2 (下周):
  ├── 从线索创建报价（粗版：填写总金额）
  ├── 关联合同只读查看
  ├── 我的业绩（转化率 + 数量）
  └── 我的客户列表
```

### 🥈 第二优先：老板 SAM 的 Dashboard

**理由**：

1. **老板的反馈决定生死**。如果 SAM 每天看到 Dashboard 觉得有价值，他会持续支持 CRM 投入。
2. **Dashboard 是"卖"给老板的产品**。让老板看到"哦，原来 Tanya 这周成交了一个大单" → 他会推 Tanya 用。
3. **实现量小**：80% 数据来自已有的 `leads` + `contracts` + `payments` 聚合查询。不需要复杂交互。

**实施顺序**：

```
Sprint 3:
  ├── 关键指标 4 KPI Card（管道总额/本月签约/本月回款/逾期）
  ├── 预警区块（红线线索 + 逾期 + 回收标记）
  ├── 团队速览（每人一行数据）
  └── 线索分配/转移操作

Sprint 4:
  ├── 回款看板
  ├── 合同总览（只读）
  └── 移动端适配（老板最可能在手机上用）
```

### 🥉 第三优先：运营 Operator 的界面

**理由**：

1. **当前运营角色空缺或由老板兼任**。如果老板现在自己做运营的事（建合同、录回款），那可以先用简化版。
2. **运营界面功能最多、最复杂**（合同 CRUD + 分期管理 + 项目交付 + 回款登记 + 产品库）。开发量最大。
3. **依赖前置**：合同/付款/项目等后端触发器需要先就绪。

**实施顺序**：

```
Sprint 5:
  ├── 合同管理（CRUD + 上传 PDF）
  ├── 分期计划管理（按合同设置分期）
  ├── 回款登记（选择合同 → 登记金额）
  └── 待办工作台（待确认回款 + 待更新交付）

Sprint 6:
  ├── 项目交付管理（里程碑进度）
  ├── 项目文档上传
  ├── 验收管理
  ├── 产品库 CRUD
  └── 客户档案统一管理
```

### 实施路线图总览

```
Sprint 1-2: 🥇 销售界面      → Tanya 开始用
Sprint 3-4: 🥈 老板 Dashboard → SAM 看到价值
Sprint 5-6: 🥉 运营界面      → 全流程跑通
                    ↓
                 v2.1 发布 🚀
```

### 快速启动建议

考虑到 NewMe 当前只有 1 个老板 + 1 个销售：

1. **先做销售端**（Sprint 1-2）
2. **老板暂时用销售端的数据自己看**，不做专属 Dashboard
3. **运营功能由老板先兼任**：用最简单的合同录入表单（甚至直接 SQL INSERT）
4. **MVP 验证点**：Tanya 连续使用 1 周后，线索推进速度是否提升？

---

## 附录：各角色界面速查表

| 页面/功能 | 老板 SAM | 运营 | 销售 Tanya |
|-----------|---------|------|-----------|
| 驾驶舱 Dashboard | ✅ 首页 | ❌ | ❌ |
| 今日待办 | ❌ | ✅ 待办工作台 | ✅ 首页 |
| 线索管道(全部) | ✅ 只读 | ❌ | ❌ |
| 我的管道(个人) | ❌ | ❌ | ✅ Kanban+拖拽 |
| 快速线索创建 | ❌ | ❌ | ✅ |
| 线索详情 | ✅ 只读 | ❌ | ✅ 可操作 |
| 推进阶段 | ❌ | ❌ | ✅ |
| 创建报价 | ❌ | ❌ | ✅ |
| 标记成交/输单 | ❌ | ❌ | ✅ |
| 记录活动 | ❌ | ❌ | ✅ |
| 分配/转移线索 | ✅ | ❌ | ❌ |
| 合同管理(全部) | ✅ 只读 | ✅ CRUD | ❌ |
| 我的合同 | ❌ | ❌ | ✅ 只读 |
| 分期管理 | ❌ | ✅ CRUD | ❌ |
| 回款登记 | ❌ | ✅ | ❌ |
| 回款逾期看板 | ✅ 汇总 | ✅ 待办 | ❌ |
| 客户统一档案 | ❌ | ✅ | ❌ |
| 我的客户 | ❌ | ❌ | ✅ |
| 产品库管理 | ❌ | ✅ CRUD | ❌ |
| 项目交付(全部) | ✅ 只读 | ✅ CRUD | ❌ |
| 项目交付(个人) | ❌ | ❌ | ✅ 状态标签 |
| 团队概况 | ✅ | ❌ | ❌ |
| 销售目标设定 | ✅ | ❌ | ❌ |
| 我的业绩(含金额) | ❌ | ❌ | ✅ 数量+转化率 |
| 销售业绩(全量) | ✅ v_sales_performance | ❌ | ❌ |
