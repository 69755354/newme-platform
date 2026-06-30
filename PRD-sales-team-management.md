# PRD：销售团队管理模块

| 项目 | 内容 |
|------|------|
| **文档状态** | 初稿 v2.0（增量更新） |
| **编写人** | 产品总监 |
| **编写日期** | 2026-06-03 |
| **涉及系统** | NewMe CRM |
| **目标版本** | CRM v2.1 |

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [功能全景图](#2-功能全景图)
3. [核心用户故事](#3-核心用户故事)
4. [功能详细规格](#4-功能详细规格)
5. [优先级排序](#5-优先级排序)
6. [数据模型设计](#6-数据模型设计)
7. [与现有功能的集成方案](#7-与现有功能的集成方案)
8. [里程碑计划](#8-里程碑计划)
9. [附录：权限矩阵](#9-附录权限矩阵)
10. [关键设计决策记录](#10-关键设计决策记录)

---

## 1. 背景与目标

### 1.1 背景

NewMe CRM 已完成 Leads + Pipeline + Dashboard 基础版建设，但**销售团队管理功能完全空缺**。当前系统状态：

- leads 表已有 `assigned_to`、`owner`、`sales_manager` 三个归属字段指向 profiles 表
- 现有用户：`admin@newme.ae`（超级管理员）、`tanya@newme.ae`（销售）
- 9 阶段销售漏斗已定义并投入使用
- 已有 `business_events` 表可支持操作审计
- 已有 `sales_performance_v2` 视图但不被前端消费
- **回款管理为零** — 无收款记录、无分期、无应收/已收对比
- **合同管理为零** — 无合同存档、无付款计划、无交付计划
- **销售目标为零** — 无月度/季度目标设定和完成率跟踪
- **团队管理界面为零** — 无法以管理视角查看全团队销售漏斗

### 1.2 业务目标

1. **责任到人** — 每条线索有明确归属，销售行为可追溯、可考核
2. **管理可见性** — 老板/行政可查看全团队销售漏斗、业绩排名、风险预警
3. **回款闭环** — 从签约合同到回款全覆盖，掌握每笔应收与逾期
4. **合同驱动回款** — 合同是回款的"根"，签约金额→分阶段付款计划→自动生成待收记录→实收勾对→逾期检测
5. **目标驱动** — 设置销售目标定期考核，驱动业绩增长

### 1.3 角色定义（v2.0 精简版）

| 角色 | 英文标识 | 说明 | 当前存在 |
|------|---------|------|---------|
| 超级管理员 | `admin` | 系统拥有者，所有操作权限（包括审批合同、调配Lead、管理成员） | ✅ 已有 |
| 行政 | `operator` | 线索调配、管理合同草稿、登记收款、运营管理 | ❌ 新建 |
| 普通销售 | `sales` | 查看/跟进归属自己的线索/合同/回款 | ✅ 已有 |
| 财务 | `finance` | 登记收款、查看所有合同回款数据 | ❌ 新建 |

> **v2.0 变更**：去掉了「销售经理」角色。当前公司规模小不需要中间管理层，4 角色（admin/operator/sales/finance）覆盖所有职责。

---

## 2. 功能全景图

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             销售团队管理模块 v2.0                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  🔧 团队管理基础                                                                  │
│  ├── 销售成员管理   — 添加/编辑/停用/激活成员                                      │
│  ├── 角色权限管理   — 4种角色及其权限矩阵（v2.0: 移除manager）                      │
│  └── 团队组织视图   — 列表查看团队成员及状态                                        │
│                                                                                   │
│  📋 Lead 归属管理                                                                 │
│  ├── Lead 分配     — 新建线索自动/手动分配销售                                     │
│  ├── Lead 转交     — 将线索从一销售转给另一销售                                    │
│  ├── 批量调配      — 批量选择线索并重新分配归属                                    │
│  ├── 归属历史追溯  — 查看每次归属变更的完整记录                                    │
│  └── 无人认领池    — 未分配线索统一管理                                            │
│                                                                                   │
│  👁️ 按销售的漏斗视图                                                              │
│  ├── 我的漏斗      — 普通销售只看自己的线索管道                                    │
│  ├── 团队漏斗      — admin/operator 查看全团队各成员管道对比                        │
│  ├── 成员筛选      — 按销售成员筛选其负责的线索和管道                              │
│  └── 管道风险标记  — 高停滞/高逾期线索高亮                                        │
│                                                                                   │
│  📄 合同管理 ★NEW★                                                              │
│  ├── 合同创建      — 从 Won Lead 发起签约，录入合同信息                            │
│  ├── 电子合同存档  — PDF上传 + 元数据存储                                          │
│  ├── 付款计划      — 分阶段金额+到期日（驱动回款闭环）                              │
│  ├── 交付计划      — 里程碑+到期日                                                 │
│  ├── 合同状态流转  — draft → active → completed / terminated                      │
│  ├── 合同审批预留  — 字段预埋，当前 draft 直接生效                                 │
│  └── 合同列表      — 全部合同查看、筛选、搜索                                      │
│                                                                                   │
│  💰 回款管理（合同联动版 ★REVISED★）                                              │
│  ├── 收款登记      — 关联合同+某期付款计划                                         │
│  ├── 自动对账      — 实收 vs 计划应收                                              │
│  ├── 分期状态更新  — 某期 paid → 检查下期 → 全部 paid → 合同标记 completed         │
│  └── 逾期检测      — 付款计划到期未收自动标记                                      │
│                                                                                   │
│  📊 统计与看板 ★REVISED★                                                         │
│  ├── 合同仪表盘    — 签约总额、待收总额、已收总额、逾期总额（4大指标卡片）           │
│  ├── 分销售统计    — 签约额、回款额、回款率、逾期笔数排名表                         │
│  ├── 达标/未达标预警 — 销售回款率 < 60% → 警告标记                                │
│  ├── 超期统计      — 逾期回款列表 + 交付延期列表                                   │
│  └── 趋势图表      — 月度签约/回款趋势                                             │
│                                                                                   │
│  🎯 销售目标与考核                                                                │
│  ├── 目标设定      — 给每位销售设定月度/季度目标金额                                │
│  ├── 完成率追踪    — 实时更新完成进度百分比（基于签约额）                            │
│  ├── 目标看板      — 按人/按时间维度展示目标 vs 实际                                │
│  └── 考核历史      — 过往月份/季度的目标完成记录                                   │
│                                                                                   │
│  ⚙️ 系统配置                                                                     │
│  ├── 角色管理      — 角色定义与权限配置                                            │
│  ├── 目标模板      — 预设目标模板（如新人/资深不同标准）                            │
│  └── 通知配置      — 逾期/转交/分配通知规则                                        │
│                                                                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心用户故事

### 3.1 超级管理员（老板）

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| US-ADM-01 | 作为老板，我希望**查看全团队成员的销售业绩排名**，以便快速了解谁在贡献业绩、谁需要辅导 | P0 |
| US-ADM-02 | 作为老板，我希望**随时查看公司整体回款状况**（应收总额、已收总额、逾期金额），以便掌握现金流 | P0 |
| US-ADM-03 | 作为老板，我希望**为每位销售设定月度/季度目标**，并随时查看完成率，以便考核驱动 | P1 |
| US-ADM-04 | 作为老板，我希望**将重要线索直接分配给指定销售**，以便确保 VIP 客户得到最优跟进 | P0 |
| US-ADM-05 | 作为老板，我希望**查看某条线索的完整归属变更历史**，以便追溯责任 | P1 |
| US-ADM-06 | 作为老板，我希望**停用已离职或不再担任销售的成员**，以保持团队名单准确 | P1 |
| US-ADM-07 | 作为老板，我希望**查看按销售维度过滤的管道视图**，以便对比各成员的项目推进情况 | P0 |
| **US-ADM-08** | **作为老板，我希望在 Won Lead 后快速创建合同，上传 PDF 存档并设定分期付款计划，以便锁定回款节奏和交付承诺** | **P0** |
| **US-ADM-09** | **作为老板，我希望在 Dashboard 一眼看到签约总额、待收总额、已收总额、逾期总额四个核心指标，以便随时掌握公司财务健康度** | **P0** |
| **US-ADM-10** | **作为老板，我希望查看按销售的签约额/回款额/回款率排名，并看到回款率低于 60% 的预警标记，以便识别风险销售** | **P0** |
| **US-ADM-11** | **作为老板，我希望查看所有逾期的付款计划和延期的交付计划，以便及时催收和推动交付** | **P0** |

### 3.2 行政

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| US-OPS-01 | 作为行政，我希望能**查看所有未分配的线索池**，并将其分配给合适的销售 | P0 |
| US-OPS-02 | 作为行政，我希望能**批量选择多条线索并重新分配**给另一个销售，以提高调配效率 | P0 |
| US-OPS-03 | 作为行政，我希望能**将某销售的线索转交给另一销售**（附上转交原因），以便在人员变动时平稳过渡 | P0 |
| US-OPS-04 | 作为行政，我希望能**查看每笔收款记录**并登记新增收款 | P1 |
| US-OPS-05 | 作为行政，我希望能**添加/编辑/停用销售成员**，以维护团队组织架构 | P1 |
| US-OPS-06 | 作为行政，我希望能**查看团队漏斗总览**，了解各成员工作量是否均衡 | P1 |
| **US-OPS-07** | **作为行政，我希望能创建合同草稿（从 Won Lead 发起）、上传 PDF 并存档、查看合同列表** | **P0** |
| **US-OPS-08** | **作为行政，我希望能为合同设定付款计划和交付计划，设置各期金额和到期日** | **P0** |
| **US-OPS-09** | **作为行政，我希望能查看逾期付款清单和交付延期清单，以便跟进** | **P1** |

### 3.3 普通销售

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| US-SAL-01 | 作为销售，我希望**只看到分配给我的线索**，不被别人线索干扰 | P0 |
| US-SAL-02 | 作为销售，我希望**看到我自己的销售漏斗**（各阶段数量 + 金额），以便管理自己的管道 | P0 |
| US-SAL-03 | 作为销售，我希望**看到我个人的业绩数据**（成交额、转化率、回款率），以便了解自己的表现 | P1 |
| US-SAL-04 | 作为销售，我希望**看我的月度/季度目标和当前完成率**，以便知道离目标还差多少 | P1 |
| US-SAL-05 | 作为销售，我希望**查看我的回款记录**（已收/未收/逾期），以便追款不遗漏 | P1 |
| US-SAL-06 | 作为销售，我希望能**看到分配给自己的新线索提醒**，以便及时跟进 | P2 |
| **US-SAL-07** | **作为销售，我希望看到我名下所有合同列表（仅自己签约的），以及每份合同的付款计划和当前回款状态** | **P1** |
| **US-SAL-08** | **作为销售，我希望看到我的签约总额、已收总额、待收总额、逾期笔数等个人业绩数据** | **P1** |

### 3.4 财务

| ID | 用户故事 | 优先级 |
|----|---------|--------|
| US-FIN-01 | 作为财务，我希望**登记每笔收款**（关联合同 + 某期付款计划），以便系统自动更新回款状态 | P0 |
| US-FIN-02 | 作为财务，我希望**查看所有未收款列表**（含逾期标记），以便催款工作 | P0 |
| US-FIN-03 | 作为财务，我希望**查看各销售的回款率统计**，以便评估销售的回款能力 | P1 |
| US-FIN-04 | 作为财务，我希望能**设置分期计划**（如 30% 首付、40% 中期、30% 尾款），以便管理大额合同的分期收款 | P1 |
| **US-FIN-05** | **作为财务，我希望查看所有合同列表，含签约金额、付款计划、已收金额、未收金额和逾期状态** | **P0** |
| **US-FIN-06** | **作为财务，我希望一笔收款可以精确对账到某份合同的某一期付款计划，系统自动判断该期是否已结清** | **P0** |
| **US-FIN-07** | **作为财务，我希望看到全局回款看板：待收总额、逾期总额、各销售回款率排名** | **P1** |

---

## 4. 功能详细规格

### 4.1 销售成员管理

#### 功能描述
系统支持超级管理员/行政对销售团队成员进行完整生命周期管理。

#### 验收标准

| # | 验收标准 | 优先级 |
|---|---------|--------|
| AC-MEM-01 | 管理员可在「设置 → 团队管理」页面查看所有成员列表，包含：头像、姓名、电话、角色、状态（激活/停用）、最后活跃时间 | P1 |
| AC-MEM-02 | 管理员可添加新成员：从已有 Supabase Auth 用户中选择并分配角色（admin/operator/sales/finance），添加到销售团队中 | P1 |
| AC-MEM-03 | 管理员可编辑成员的以下信息：角色（选项为 admin/operator/sales/finance，不再有 manager） | P1 |
| AC-MEM-04 | 管理员可停用成员：停用后该成员无法登录系统，其归属的线索保留但标记为"待重新分配" | P1 |
| AC-MEM-05 | 管理员可重新激活已停用成员 | P2 |
| AC-MEM-06 | 停用成员时系统提示"该成员名下 N 条活跃线索将进入待分配池"，提供"立即重新分配"或"稍后处理"选项 | P1 |
| AC-MEM-07 | 成员列表支持按角色/状态筛选，按姓名搜索 | P1 |
| AC-MEM-08 | 角色枚举值从 5 种简化为 4 种：admin/operator/sales/finance，去掉 manager | P1 |

### 4.2 Lead 归属与调配

#### 功能描述
系统的 Lead 归属性管理是销售团队管理的基石，支持分配、转交、批量操作和归属审计。

#### 验收标准

**分配**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| ASG-01 | 新建 Lead 时，可选择"分配给"下拉框列出所有激活状态的销售 | P0 |
| ASG-02 | 新建 Lead 时若不指定归属，自动进入"未分配池"（Unassigned Pool） | P0 |
| ASG-03 | 在 Lead 详情页可修改"assigned_to"字段，修改后触发业务事件记录 | P0 |
| ASG-04 | 「未分配池」视图展示所有 `assigned_to IS NULL` 且 `disqualified_candidate = false` 的线索，支持按时间/来源排序 | P0 |
| ASG-05 | 从「未分配池」可选中单条或批量选中，通过弹窗选择目标销售完成分配 | P0 |

**转交**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| ASG-06 | 管理员/行政在 Lead 详情页可操作"转交"：选择目标销售 + 填写转交原因（必填） | P0 |
| ASG-07 | 转交时系统自动记录转交历史：原归属人、目标归属人、转交人、转交时间、转交原因 | P0 |
| ASG-08 | 转交后目标销售收到系统通知（系统内 + 可选通知渠道） | P2 |

**批量调配**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| ASG-09 | 在 Lead 列表视图/看板视图，支持勾选多条线索 → 「批量分配」→ 选择目标销售 → 确认 | P0 |
| ASG-10 | 批量调配时显示本次操作影响的线索数量，确认前提示"将 N 条线索分配给 [销售姓名]" | P0 |
| ASG-11 | 批量调配后所有被操作的线索生成各自的归属变更事件记录 | P1 |

**归属历史追溯**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| ASG-12 | Lead 详情页新增「归属历史」Tab 或时间轴条目，展示该条线索的每次归属变更记录 | P1 |
| ASG-13 | 归属历史显示：时间、原归属人、新归属人、操作人、转交原因 | P1 |
| ASG-14 | 归属历史使用已有 `business_events` 表，event_type = 'owner_change' 或 'assignment_change' | P1 |

### 4.3 按销售的漏斗视图

#### 功能描述
不同角色看到不同范围的销售漏斗。这是"责任到人"的核心可视化体现。

#### 验收标准

**我的漏斗（普通销售视角）**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| FNL-01 | 普通销售登录后，「Pipeline」页面默认只显示 `assigned_to = 当前用户` 的线索 | P0 |
| FNL-02 | 漏斗各阶段卡片上的数字（线索数量、金额合计）仅统计当前用户的线索 | P0 |
| FNL-03 | 系统右上角显示已分配的线索总数 vs 未完成待办数 | P2 |

**团队漏斗（admin/operator 视角）**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| FNL-04 | 管理员/行政在「Pipeline」页面顶部有"成员筛选器"，可选择"全部"或任意一名销售 | P0 |
| FNL-05 | 选择"全部"时展示全团队所有非成交/非输单线索，阶段统计汇总全团队数据 | P0 |
| FNL-06 | 选择某位销售时，漏斗数据仅展示该销售负责的线索，等同于"以该销售的视角看管道" | P0 |
| FNL-07 | 成员筛选器显示每个销售的激活状态图标（在线/停用），方便区分 | P2 |
| FNL-08 | 漏斗看板卡片上显示负责人头像/姓名缩写 | P1 |

> **v2.0 变更**：去掉经理角色相关描述，团队漏斗仅 admin/operator 可查看。

**风险标记**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| FNL-09 | 管道视图中，超过 14 天未推进的线索卡片增加"⚠️"标记 | P1 |
| FNL-10 | 管道视图中，金额 >50K AED 且停滞 >21 天的线索卡片增加红色边框 | P2 |

### 4.4 合同管理（★NEW★ — 核心模块）

#### 功能描述
合同是回款闭环的锚点。从 Won Lead 签约到合同创建、电子合同存档、分阶段付款计划、交付计划的全流程管理。合同驱动的回款闭环流程：

```
Won Lead → 创建合同（含付款计划 + 交付计划）
                   ↓
          付款计划 → 自动生成待收记录
                   ↓
          财务登记收款（关联某期付款计划）
                   ↓
          自动对账：实收 vs 计划应收
                   ↓
          某期 paid → 检查下期 → 全部 paid → 合同标记 completed
```

#### 数据模型
新建 `contracts` 表 + `installment_plans` 表 + `delivery_plans` 表（详细设计见第 6 节）。

#### 验收标准

**合同创建与基本信息**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| CON-01 | Won 阶段的 Lead 详情页增加「创建合同」按钮，点击进入合同创建表单 | P0 |
| CON-02 | 合同表单包含：签约日期、客户名称（自动带出 Lead 客户名）、关联 Won Lead（只读）、合同金额（AED）、双方信息（甲方名称/联系方式、乙方名称/联系方式）、备注 | P0 |
| CON-03 | 合同编号自动生成，格式：CT-{YYYYMMDD}-{4位序号}（如 CT-20260603-0001） | P0 |
| CON-04 | 合同从 Won Lead 创建时，自动将 Lead 的 quotation_value 填入合同金额，允许手动修改 | P0 |
| CON-05 | 合同创建后显示在「合同列表」页面，支持按状态/签约日期/销售筛选 | P0 |
| CON-06 | 合同默认状态为 `draft`，创建后自动变为 `active`（当前跳过审批，直接生效） | P0 |

**电子合同存档**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| CON-07 | 合同详情页支持上传 PDF 文件（电子合同扫描件），单文件最大 50MB | P0 |
| CON-08 | 上传后显示文件名、上传人、上传时间；支持替换和下载 | P0 |
| CON-09 | 上传的 PDF 存储在 Supabase Storage，`contracts` 表记录 file_url 和 file_metadata（文件大小、类型、上传时间） | P0 |
| CON-10 | 预留 `extracted_fields` JSON 字段，未来用于 AI 提取关键信息（签约金额、付款条款等） | P1 |

**付款计划**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| CON-11 | 合同创建时 / 创建后可设置付款计划：分期数（1-12 期）+ 每期金额 + 每期到期日 | P0 |
| CON-12 | 分期金额之和必须等于合同金额，系统自动校验并提示（如果不相等则无法保存） | P0 |
| CON-13 | 每期付款计划自动生成一条 `installment_plans` 记录，初始状态为 `pending` | P0 |
| CON-14 | 付款计划支持修改：可调整分期金额和到期日（已 paid 的期次不可修改） | P1 |
| CON-15 | 付款计划列表在合同详情页以表格展示：期次、金额、到期日、状态（pending/paid/overdue）、操作 | P0 |

**交付计划**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| CON-16 | 合同创建时可设置交付计划：里程碑名称 + 预计完成日期（如"设计确认"、"安装调试"、"验收交付"） | P1 |
| CON-17 | 每个交付里程碑可设置状态：pending / in_progress / completed / delayed | P1 |
| CON-18 | 交付计划列表在合同详情页展示：里程碑名、预计完成日、实际完成日、状态 | P1 |
| CON-19 | 超过预计完成日期 3 天仍未完成的里程碑自动标记为 `delayed`（红色标记） | P1 |

**合同状态流转**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| CON-20 | 合同状态包含：`draft`（草稿）、`active`（生效）、`completed`（已完成）、`terminated`（终止） | P0 |
| CON-21 | 当前版本：`draft` 创建后自动转为 `active`，暂时跳过审批环节，状态机直接走 draft → active → completed/terminated | P0 |
| CON-22 | `active` → `completed` 的触发条件：该合同关联的所有付款计划状态均为 `paid` | P0 |
| CON-23 | 管理员可手动将合同标记为 `terminated`（需填写终止原因），终止后不可再登记收款 | P1 |

**合同审批预留**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| CON-24 | contracts 表预留 `approval_status` 字段：`none` / `pending` / `approved` / `rejected`，当前默认 `none` | P1 |
| CON-25 | 预埋 `approved_by`（UUID 关联 profiles）和 `approved_at` 字段，为未来审批流程准备 | P1 |
| CON-26 | 预埋 `version` 字段（整数），为未来合同版本管理预留 | P2 |

#### 合同状态机

```
                    ┌──────────┐
                    │  draft   │ ← 新建合同（暂未使用，当前自动跳过）
                    └────┬─────┘
                         │ 自动生效（当前跳过审批）
                         ▼
                    ┌──────────┐          ┌──────────────┐
                    │  active  │ ←──────→ │  terminated  │
                    └────┬─────┘          └──────────────┘
                         │ 所有分期已 paid
                         ▼
                    ┌──────────┐
                    │completed │
                    └──────────┘
```

### 4.5 回款管理（合同联动版 ★REVISED★）

#### 功能描述
重新设计的回款管理，从"关联 Lead 的独立收款"升级为"关联合同付款计划的精确对账"。

**核心变化**：
- 旧版：收款直接关联 Lead，分期计划用 payments 表 installment_seq 标记
- 新版：收款关联合同(contract_id) + 某期付款计划(installment_plan_id)，分期归属独立的 `installment_plans` 表
- 自动对账：实收金额 vs 计划应收金额，分期状态自动更新
- 收款可部分支付：一笔收款可能覆盖某期的部分金额（如分多次付清一期）

#### 数据模型
`payments` 表增加 `contract_id` 和 `installment_plan_id` 外键关联，去掉旧的直接关联 lead_id 的单一模式（保留 lead_id 做下钻兼容）。

#### 验收标准

**收款登记（合同联动版）**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| PAY-01 | 合同详情页新增「回款」Tab，展示该合同的所有收款记录和付款计划进度 | P0 |
| PAY-02 | 收款登记表单变更：必选合同 → 自动带出该合同的付款计划列表 → 选择对应期次 → 填写金额（AED）、收款日期、收款方式（bank_transfer/cash/cheque/card/other）、备注 | P0 |
| PAY-03 | 收款金额可以小于或等于该期付款计划金额（支持分次付清一期） | P0 |
| PAY-04 | 收款记录关联 `contract_id` + `installment_plan_id`，同时保留 `lead_id` 用于 CRM 下钻 | P0 |

**自动对账**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| PAY-05 | 当某期 `installment_plans` 的累计收款金额 ≥ 该期计划金额时，该期状态自动变为 `paid` | P0 |
| PAY-06 | 该期变为 `paid` 后，系统自动检查该合同所有分期是否全部 `paid` → 全部 paid 则合同状态自动变为 `completed` | P0 |
| PAY-07 | 系统自动计算每份合同的已收总额 = SUM(该合同所有 payments.amount) | P0 |
| PAY-08 | 未收总额 = 合同金额 - 已收总额 | P0 |
| PAY-09 | 回款率 = (已收总额 / 合同金额) × 100%，精确到小数点后 1 位 | P0 |

**逾期检测**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| PAY-10 | 系统每日自动检测：`installment_plans` 中 `status = 'pending'` 且 `due_date < CURRENT_DATE` 的期次 → 自动标记为 `overdue` | P0 |
| PAY-11 | 逾期标记时记录逾期天数 = CURRENT_DATE - due_date | P0 |
| PAY-12 | 合同详情页付款计划列表中，逾期期次用红色字体高亮显示，并标注逾期天数 | P0 |
| PAY-13 | 逾期催收：Dashboard 展示所有逾期期次清单，按逾期天数降序排列 | P0 |

### 4.6 统计与看板（★REVISED★）

#### 功能描述
重新设计 Dashboard 的统计体系，以合同为核心数据源，构建全局统计 + 分销售统计 + 预警体系的完整看板。

#### 仪表盘布局（自上而下）

```
┌────────────────────────────────────────────────────────────┐
│  📊 顶部指标卡片（4 个核心指标）                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │ 签约总额  │ │ 已收总额  │ │ 待收总额  │ │ 逾期总额  │      │
│  │ 2,350,000│ │ 980,000  │ │1,370,000 │ │ 320,000  │      │
│  │ 本月+15% ↑│ │ 本月+8% ↑│ │          │ │ ⚠️ 注意   │      │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘      │
├────────────────────────────────────────────────────────────┤
│  📋 销售业绩排名表                                          │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐       │
│  │ 销售  │签约额│回款额│回款率│逾期笔│达标 │排名  │       │
│  ├──────┼──────┼──────┼──────┼──────┼──────┼──────┤       │
│  │ 张三  │ 800K │ 560K │ 70%  │  1   │ ✅   │ 🥇   │       │
│  │ 李四  │ 450K │ 180K │ 40%  │  3   │ ⚠️   │ 🥈   │       │
│  │ 王五  │ 350K │ 300K │ 85.7%│  0   │ ✅   │ 🥉   │       │
│  │ ...   │      │      │      │      │      │      │       │
│  └──────┴──────┴──────┴──────┴──────┴──────┴──────┘       │
├────────────────────────────────────────────────────────────┤
│  ⚠️ 逾期预警清单                                           │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┐       │
│  │ 客户  │ 销售  │合同额│逾期期│逾期金│逾期天│ 操作  │       │
│  ├──────┼──────┼──────┼──────┼──────┼──────┼──────┤       │
│  │客户A  │ 李四  │ 200K │ 第2期 │100K  │ 45天 │登记收│       │
│  │客户B  │ 张三  │ 150K │ 尾款 │ 75K  │ 12天 │登记收│       │
│  │ ...  │      │      │      │      │      │      │       │
│  └──────┴──────┴──────┴──────┴──────┴──────┴──────┘       │
├────────────────────────────────────────────────────────────┤
│  🔴 交付延期预警                                            │
│  ┌──────┬──────┬──────┬──────┬──────┬──────┐              │
│  │ 客户  │ 销售  │里程碑│预计日│延期天│ 状态  │              │
│  ├──────┼──────┼──────┼──────┼──────┼──────┤              │
│  │客户A  │ 李四  │安装  │05-20 │ 14天 │delayed│             │
│  │客户C  │ 王五  │验收  │06-01 │  2天 │delayed│             │
│  │ ...  │      │      │      │      │      │              │
│  └──────┴──────┴──────┴──────┴──────┴──────┘              │
└────────────────────────────────────────────────────────────┘
```

#### 验收标准

**顶部指标卡片**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| DSH-01 | Dashboard 顶部展示 4 个核心指标卡片：签约总额、已收总额、待收总额、逾期总额 | P0 |
| DSH-02 | 签约总额 = 所有 `status = 'active'` 或 `'completed'` 的合同金额之和 | P0 |
| DSH-03 | 已收总额 = 所有 `payments` 表中 `confirmed = true` 的收款金额之和 | P0 |
| DSH-04 | 待收总额 = 所有 `installment_plans` 中 `status IN ('pending','overdue')` 的计划金额之和 | P0 |
| DSH-05 | 逾期总额 = 所有 `installment_plans` 中 `status = 'overdue'` 的计划金额之和 | P0 |
| DSH-06 | 销售视角下（普通销售登录），顶部指标卡片仅显示该销售名下的合同数据 | P0 |

**销售业绩排名表**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| DSH-07 | 排名表展示所有销售成员（admin/operator 可见全部，sales 仅见自己，finance 可见全部财务数据） | P0 |
| DSH-08 | 每行展示：排名序号、销售姓名、签约总额、回款总额、回款率、逾期笔数、达标标记 | P0 |
| DSH-09 | 默认按回款率降序排列，支持切换为按签约额或逾期笔数排序 | P1 |
| DSH-10 | 回款率列显示进度条（<60% 红色 / 60%-80% 黄色 / >80% 绿色） | P1 |
| DSH-11 | 点击某行可下钻查看该销售的详细合同列表和付款计划 | P1 |

**达标/未达标预警**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| DSH-12 | 当某销售的回款率 < 60% 时，该行显示 ⚠️ 标记，并使用红色背景高亮 | P0 |
| DSH-13 | 当某销售逾期笔数 ≥ 3 笔时，该行显示 🔴 标记（严重预警） | P1 |
| DSH-14 | 管理员/admin 可在排名表上方看到汇总警告：如"N 位销售回款率低于 60%""M 笔逾期待处理" | P1 |
| DSH-15 | 目标完成预警：距离月度目标完成率 < 50% 的销售，在排名表标记 🎯 未达标 | P2 |

**逾期清单**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| DSH-16 | 「逾期回款」区域列出所有 `status = 'overdue'` 的付款计划，按逾期天数降序排列 | P0 |
| DSH-17 | 每行显示：客户名称、销售姓名、合同金额、逾期期次、逾期金额、逾期天数 | P0 |
| DSH-18 | 逾期天数 > 30 天使用红色加粗标记；7-30 天使用橙色标记；<7 天使用黄色标记 | P1 |
| DSH-19 | 每行提供「登记收款」快捷按钮，可直接跳转到该合同的收款登记页面 | P1 |

**交付延期清单**

| # | 验收标准 | 优先级 |
|---|---------|--------|
| DSH-20 | 「交付延期」区域列出所有 `status = 'delayed'` 的交付里程碑，按延期天数降序排列 | P1 |
| DSH-21 | 每行显示：客户名称、销售姓名、里程碑名称、预计完成日期、延期天数、当前状态 | P1 |

### 4.7 销售目标与考核

#### 功能描述
支持设定月度/季度销售目标并跟踪完成进度。

#### 数据模型
新建 `sales_targets` 表（详细设计见第 6 节）。

#### 验收标准

| # | 验收标准 | 优先级 |
|---|---------|--------|
| TGT-01 | 管理员可在「目标管理」页为每位销售设定月度目标：选择月份 + 选择销售 + 目标金额（AED） | P1 |
| TGT-02 | 支持批量设定：选择模板（如新人 200K、资深 500K）→ 应用到多位销售 | P2 |
| TGT-03 | 目标设定后，系统自动计算完成率 = 当月该销售签约的合同金额总和（contracts signed_date 属于当月）/ 目标金额 × 100% | P1 |
| TGT-04 | 每位销售的个人中心展示：本月目标、已完成、完成率、距目标差额 | P1 |
| TGT-05 | 目标完成率进度条展示：<50% 红色、50%-80% 黄色、>80% 绿色 | P1 |
| TGT-06 | 支持季度目标设定：每季度初可设定季度目标，系统将季度目标均摊到月度 | P2 |
| TGT-07 | 目标管理历史页面展示过往月份的完成记录，支持按销售筛选 | P2 |
| TGT-08 | 当某位销售当月完成率超过 100% 时，系统在 Dashboard 推送祝贺通知 | P2 |

### 4.8 权限模型（v2.0 更新版）

#### 功能描述
基于角色的访问控制（RBAC），精确控制每个角色可访问的功能和数据范围。

| 功能 | 超级管理员 | 行政 | 普通销售 | 财务 |
|------|-----------|------|---------|------|
| 查看所有线索 | ✅ | ✅ | ❌ 仅自己 | ❌ |
| 分配/转交线索 | ✅ | ✅ | ❌ | ❌ |
| 批量调配线索 | ✅ | ✅ | ❌ | ❌ |
| 查看团队漏斗 | ✅ | ✅ | ❌ | ❌ |
| 查看个人漏斗 | ✅ | ✅ | ✅ | ❌ |
| 查看团队业绩排名 | ✅ | ✅ | ❌ | ✅ 仅财务相关 |
| 管理销售成员 | ✅ | ✅ | ❌ | ❌ |
| 创建合同（草稿） | ✅ | ✅ | ❌ | ❌ |
| 审批合同 | ✅ | ❌（当前自动生效） | ❌ | ❌ |
| 上传电子合同 PDF | ✅ | ✅ | ❌ | ❌ |
| 查看所有合同 | ✅ | ✅ | ❌ 仅自己签约 | ✅ |
| 登记收款 | ✅ | ✅ | ❌ | ✅ |
| 查看回款报表 | ✅ | ✅ | ✅ 仅自己 | ✅ |
| 设定付款计划 | ✅ | ✅ | ❌ | ✅ |
| 设定交付计划 | ✅ | ✅ | ❌ | ❌ |
| 设定销售目标 | ✅ | ❌ | ❌ | ❌ |
| 查看归属历史 | ✅ | ✅ | ✅ 仅自己 | ❌ |
| 管理角色权限 | ✅ | ❌ | ❌ | ❌ |
| 查看 Dashboard 全局指标 | ✅ | ✅ | ❌ 仅自己 | ✅ |
| 查看逾期清单 | ✅ | ✅ | ❌ 仅自己 | ✅ |
| 查看交付延期清单 | ✅ | ✅ | ❌ 仅自己 | ❌ |

---

## 5. 优先级排序

### P0 — 核心必不可少（无此功能则模块无价值）

| 编号 | 功能 | 权重理由 |
|------|------|---------|
| P0-1 | **Lead 分配与转交** — 单条分配 + 转交 + 未分配池 | 老板原话"调配leads归属"，这是责任到人的基础 |
| P0-2 | **按销售的漏斗视图** — 团队漏斗 + 成员筛选 | 老板原话"by销售的销售漏斗管理"，核心管理需求 |
| P0-3 | **合同创建 + 电子合同存档** — 从 Won Lead 创建合同、上传 PDF、基本元数据 | 合同是回款的"根"，无合同则回款无锚点 |
| P0-4 | **付款计划 + 自动生成待收记录** — 分阶段 + 到期日 + 自动生成待收款 → 逾期检测 | 驱动回款闭环的核心机制 |
| P0-5 | **收款登记（合同联动）** — 关联合同+付款计划 + 自动对账 | 财务日常操作，回款闭环的执行环节 |
| P0-6 | **Dashboard 顶部 4 指标卡片** — 签约总额/已收总额/待收总额/逾期总额 | 老板每日必看，公司管理层核心监控 |
| P0-7 | **Dashboard 逾期回款清单** — 逾期列表 + 按天排序 | 现金流预警，业务影响直接 |
| P0-8 | **销售业绩排名表** — 按销售展示签约额/回款额/回款率/逾期笔数 | 团队管理驾驶舱核心 |
| P0-9 | **达标/未达标预警** — 回款率 < 60% 标记 | 风险识别，管理干预触发点 |

**P0 完工标准**: 管理员/行政可以分配和转交 Lead、看到团队漏斗、从 Won Lead 创建合同（含付款计划）、上传 PDF、登记回款（关联分期）、自动检测逾期、Dashboard 展示 4 指标 + 排名表 + 逾期清单 + 达标预警。

### P1 — 重要增值（提升管理效率）

| 编号 | 功能 | 权重理由 |
|------|------|---------|
| P1-1 | **批量调配** — 批量选择 + 批量分配 | 行政效率关键操作 |
| P1-2 | **归属历史追溯** — business_events 消费 + 详情页展示 | 审计和责任追溯需求 |
| P1-3 | **销售成员管理** — CRUD + 停用/激活 | 团队管理基础 |
| P1-4 | **销售目标设定与完成率** — 月度目标 + 进度追踪 | 考核驱动的核心工具 |
| P1-5 | **交付计划** — 里程碑设定 + 延期自动检测 | 交付管理闭环、客户满意度 |
| P1-6 | **交付延期清单 Dashboard** — 延期里程碑列表 | 交付预警 |
| P1-7 | **合同审批字段预埋** — approval_status / approved_by / approved_at | 为未来审批流程预留，数据结构先行 |
| P1-8 | **风险标记** — 停滞线索高亮 + 超期标记 | 预警能力扩展 |
| P1-9 | **漏斗转化率展示** — 各阶段转化百分比 | 管理分析深度 |
| P1-10 | **回款率进度条（排名表中）** — 颜色标记 <60% / 60-80% / >80% | 可视化增强 |

### P2 — 锦上添花（有更好，无亦可）

| 编号 | 功能 | 权重理由 |
|------|------|---------|
| P2-1 | **系统通知** — 新线索分配通知、转交通知、逾期通知 | 提升协同体验 |
| P2-2 | **季度目标 + 考核历史** | 长期考核机制 |
| P2-3 | **业绩趋势图** — 6个月签约/回款趋势 | 深度分析 |
| P2-4 | **批量目标模板** | 团队扩张时有用 |
| P2-5 | **合同版本管理** | 复杂场景预留 |
| P2-6 | **AI 合同提取（方案B）** — 从 PDF 自动提取签约金额、付款条款 | 效率提升，第二期再做 |

---

## 6. 数据模型设计

### 6.1 扩展 profiles 表（v2.0 角色精简）

```sql
-- 角色枚举从 5 种简化为 4 种（去掉 manager）
ALTER TABLE profiles 
  DROP CONSTRAINT IF EXISTS profiles_role_check,
  ADD CONSTRAINT profiles_role_check 
    CHECK (role IN ('admin','sales','designer','operator','finance'));

-- 新增字段（不变）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS 
  manager_id UUID REFERENCES profiles(id);         -- 直属上级（当前可能不用）
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS 
  is_active BOOLEAN DEFAULT true;                  -- 激活状态
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS 
  last_active_at TIMESTAMPTZ;                      -- 最后活跃时间
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS 
  joined_at TIMESTAMPTZ DEFAULT now();             -- 加入团队时间
```

### 6.2 新建 contracts 表（★NEW★）

```sql
CREATE TABLE contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  lead_title      TEXT,                           -- Won Lead 的标题（冗余快照）
  sales_id        UUID REFERENCES profiles(id),   -- 签约销售（冗余，便于统计）
  
  -- 核心字段
  contract_no     TEXT NOT NULL UNIQUE,            -- 合同编号 CT-YYYYMMDD-XXXX
  contract_date   DATE NOT NULL,                   -- 签约日期
  contract_amount DECIMAL(12,2) NOT NULL CHECK (contract_amount > 0),
  currency        TEXT DEFAULT 'AED',
  
  -- 双方信息
  party_a_name    TEXT NOT NULL,                   -- 甲方（客户）名称
  party_a_contact TEXT,                            -- 甲方联系方式
  party_b_name    TEXT NOT NULL DEFAULT 'NewMe Smart Home',  -- 乙方名称
  party_b_contact TEXT,                            -- 乙方联系方式
  
  -- 电子合同存档
  file_url        TEXT,                            -- PDF 文件存储 URL
  file_metadata   JSONB,                           -- {filename, size, type, uploaded_at}
  extracted_fields JSONB,                          -- 预留：AI 提取字段 {amount, payment_terms, ...}
  
  -- 状态
  status          TEXT NOT NULL DEFAULT 'draft' 
                    CHECK (status IN ('draft','active','completed','terminated')),
  
  -- 审批预留字段
  approval_status TEXT DEFAULT 'none' 
                    CHECK (approval_status IN ('none','pending','approved','rejected')),
  approved_by     UUID REFERENCES profiles(id),
  approved_at     TIMESTAMPTZ,
  
  -- 版本预留
  version         INTEGER DEFAULT 1,
  
  -- 备注
  notes           TEXT,
  terminated_reason TEXT,                         -- 终止原因（terminated 时必填）
  
  -- 元数据
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 索引
CREATE INDEX idx_contracts_lead ON contracts(lead_id);
CREATE INDEX idx_contracts_sales ON contracts(sales_id);
CREATE INDEX idx_contracts_status ON contracts(status);
CREATE INDEX idx_contracts_date ON contracts(contract_date);
CREATE INDEX idx_contracts_no ON contracts(contract_no);
CREATE INDEX idx_contracts_overdue ON contracts(id) 
  WHERE status IN ('active','completed');

-- RLS
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

-- admin/operator 全部权限
CREATE POLICY "contracts_admin_operator_all" ON contracts FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

-- sales 只读自己签约的合同
CREATE POLICY "contracts_sales_see" ON contracts FOR SELECT
  USING (sales_id = auth.uid());

-- finance 只读所有合同（不可修改）
CREATE POLICY "contracts_finance_see" ON contracts FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
```

### 6.3 新建 installment_plans 表（★NEW★）

```sql
CREATE TABLE installment_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  
  -- 分期信息
  seq             INTEGER NOT NULL,               -- 第几期（1-based）
  amount          DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  due_date        DATE NOT NULL,                  -- 到期日
  description     TEXT,                           -- 如"首付款"、"中期款"、"尾款"
  
  -- 状态
  status          TEXT NOT NULL DEFAULT 'pending' 
                    CHECK (status IN ('pending','paid','overdue','cancelled')),
  
  -- 累计实收
  paid_amount     DECIMAL(12,2) DEFAULT 0,        -- 已收金额累计（支持分次付清）
  
  -- 元数据
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  
  -- 唯一约束
  UNIQUE (contract_id, seq)
);

-- 索引
CREATE INDEX idx_installment_contract ON installment_plans(contract_id);
CREATE INDEX idx_installment_status ON installment_plans(status);
CREATE INDEX idx_installment_due ON installment_plans(due_date) 
  WHERE status = 'pending';

-- RLS
ALTER TABLE installment_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "installment_admin_operator_all" ON installment_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator','finance')));

CREATE POLICY "installment_sales_see" ON installment_plans FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM contracts c WHERE c.id = installment_plans.contract_id AND c.sales_id = auth.uid()
  ));
```

### 6.4 新建 delivery_plans 表（★NEW★）

```sql
CREATE TABLE delivery_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  
  -- 里程碑信息
  milestone_name  TEXT NOT NULL,                   -- 里程碑名称（如"设计确认"）
  description     TEXT,                            -- 详细描述
  expected_date   DATE NOT NULL,                   -- 预计完成日期
  actual_date     DATE,                            -- 实际完成日期
  
  -- 状态
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','in_progress','completed','delayed')),
  
  -- 元数据
  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  
  -- 唯一约束
  UNIQUE (contract_id, milestone_name)
);

-- 索引
CREATE INDEX idx_delivery_contract ON delivery_plans(contract_id);
CREATE INDEX idx_delivery_status ON delivery_plans(status);
CREATE INDEX idx_delivery_delayed ON delivery_plans(expected_date, status)
  WHERE status IN ('pending','delayed');

-- RLS
ALTER TABLE delivery_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "delivery_admin_operator_all" ON delivery_plans FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator')));

CREATE POLICY "delivery_sales_see" ON delivery_plans FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM contracts c WHERE c.id = delivery_plans.contract_id AND c.sales_id = auth.uid()
  ));

CREATE POLICY "delivery_finance_see" ON delivery_plans FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'finance'));
```

### 6.5 新建 payments 表（★REVISED★ — 合同联动版）

```sql
CREATE TABLE payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- 关联（新增合同关联）
  contract_id         UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  installment_plan_id UUID REFERENCES installment_plans(id),
  lead_id             UUID REFERENCES leads(id),  -- 保留用于 CRM 下钻兼容
  
  -- 金额
  amount              DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  currency            TEXT DEFAULT 'AED',
  
  -- 时间
  payment_date        DATE NOT NULL,
  
  -- 分类
  payment_method      TEXT CHECK (payment_method IN 
                        ('bank_transfer','cash','cheque','card','other')),
  
  -- 确认状态
  confirmed           BOOLEAN DEFAULT true,       -- 是否已确认到账
  
  -- 备注
  notes               TEXT,
  
  -- 元数据
  created_by          UUID REFERENCES profiles(id),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- 索引
CREATE INDEX idx_payments_contract ON payments(contract_id);
CREATE INDEX idx_payments_installment ON payments(installment_plan_id);
CREATE INDEX idx_payments_lead ON payments(lead_id);
CREATE INDEX idx_payments_date ON payments(payment_date);

-- RLS
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payments_admin_operator_finance_all" ON payments FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','operator','finance')));

CREATE POLICY "payments_sales_see" ON payments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM contracts c WHERE c.id = payments.contract_id AND c.sales_id = auth.uid()
  ));
```

### 6.6 新建 sales_targets 表（不变）

```sql
CREATE TABLE sales_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- 归属
  user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  set_by          UUID NOT NULL REFERENCES profiles(id),   -- 目标设定人
  
  -- 周期
  period_type     TEXT NOT NULL CHECK (period_type IN ('monthly','quarterly')),
  period_start    DATE NOT NULL,          -- 如 2026-01-01
  period_end      DATE NOT NULL,          -- 如 2026-01-31
  
  -- 金额
  target_amount   DECIMAL(12,2) NOT NULL CHECK (target_amount > 0),
  
  -- 元数据
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  
  -- 唯一约束：同一用户同一周期只能有一个目标
  UNIQUE (user_id, period_type, period_start)
);

-- 索引
CREATE INDEX idx_targets_user ON sales_targets(user_id);
CREATE INDEX idx_targets_period ON sales_targets(period_start, period_end);
CREATE INDEX idx_targets_type ON sales_targets(period_type);

-- RLS
ALTER TABLE sales_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "targets_admin_all" ON sales_targets FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "targets_self_see" ON sales_targets FOR SELECT
  USING (user_id = auth.uid());
```

### 6.7 新建 v_sales_performance 视图（增强版 — 含合同统计）

```sql
-- 替代现有 sales_performance / sales_performance_v2
-- v2.0: 增加合同相关指标（签约额、回款额、回款率、逾期统计）
CREATE OR REPLACE VIEW v_sales_performance AS
WITH sales_contracts AS (
  SELECT 
    c.sales_id,
    COUNT(c.id) AS contract_count,
    COALESCE(SUM(c.contract_amount), 0) AS total_contract_amount,
    COALESCE(SUM(c.contract_amount) FILTER (
      WHERE DATE_TRUNC('month', c.contract_date) = DATE_TRUNC('month', CURRENT_DATE)
    ), 0) AS monthly_contract_amount,
    COALESCE(SUM(c.contract_amount) FILTER (
      WHERE c.contract_date >= DATE_TRUNC('quarter', CURRENT_DATE)
    ), 0) AS quarterly_contract_amount
  FROM contracts c
  WHERE c.status IN ('active', 'completed')
  GROUP BY c.sales_id
),
sales_payments AS (
  SELECT 
    c.sales_id,
    COUNT(p.id) AS payment_count,
    COALESCE(SUM(p.amount), 0) AS total_paid_amount,
    COUNT(p.id) FILTER (
      WHERE DATE_TRUNC('month', p.payment_date) = DATE_TRUNC('month', CURRENT_DATE)
    ) AS monthly_payment_count,
    COALESCE(SUM(p.amount) FILTER (
      WHERE DATE_TRUNC('month', p.payment_date) = DATE_TRUNC('month', CURRENT_DATE)
    ), 0) AS monthly_paid_amount
  FROM payments p
  JOIN contracts c ON c.id = p.contract_id
  WHERE p.confirmed = true
  GROUP BY c.sales_id
),
sales_overdue AS (
  SELECT 
    c.sales_id,
    COUNT(ip.id) AS overdue_count,
    COALESCE(SUM(ip.amount), 0) AS overdue_amount
  FROM installment_plans ip
  JOIN contracts c ON c.id = ip.contract_id
  WHERE ip.status = 'overdue'
  GROUP BY c.sales_id
)
SELECT 
  p.id AS user_id,
  p.full_name,
  p.role,
  p.is_active,
  
  -- Pipeline 指标（原有，从 leads 表统计）
  COUNT(l.id) FILTER (WHERE l.funnel_stage NOT IN ('won','lost') AND l.disqualified_candidate = false) AS active_leads,
  COALESCE(SUM(l.quotation_value) FILTER (WHERE l.funnel_stage NOT IN ('won','lost') AND l.disqualified_candidate = false), 0) AS pipeline_value,
  COALESCE(SUM(l.quotation_value * COALESCE(l.win_probability, 0) / 100.0) FILTER (WHERE l.funnel_stage NOT IN ('won','lost') AND l.disqualified_candidate = false), 0) AS weighted_pipeline,
  
  -- 成交指标（原有）
  COUNT(l.id) FILTER (WHERE l.funnel_stage = 'won' AND DATE_TRUNC('month', l.updated_at) = DATE_TRUNC('month', CURRENT_DATE)) AS won_count_month,
  COALESCE(SUM(l.quotation_value) FILTER (WHERE l.funnel_stage = 'won' AND DATE_TRUNC('month', l.updated_at) = DATE_TRUNC('month', CURRENT_DATE)), 0) AS won_amount_month,
  
  -- 合同指标（★新增）
  COALESCE(sc.contract_count, 0) AS contract_count,
  COALESCE(sc.total_contract_amount, 0) AS total_contract_amount,
  COALESCE(sc.monthly_contract_amount, 0) AS monthly_contract_amount,
  COALESCE(sc.quarterly_contract_amount, 0) AS quarterly_contract_amount,
  
  -- 回款指标（★新增 — 合同联动）
  COALESCE(sp.total_paid_amount, 0) AS total_paid_amount,
  COALESCE(sp.monthly_paid_amount, 0) AS monthly_paid_amount,
  
  -- 回款率计算
  CASE 
    WHEN COALESCE(sc.total_contract_amount, 0) > 0 
    THEN ROUND(COALESCE(sp.total_paid_amount, 0) / sc.total_contract_amount * 100, 1)
    ELSE 0
  END AS payment_rate,
  
  -- 逾期指标（★新增）
  COALESCE(so.overdue_count, 0) AS overdue_count,
  COALESCE(so.overdue_amount, 0) AS overdue_amount,
  
  -- 达标标记（回款率 >= 60%）
  CASE 
    WHEN COALESCE(sc.total_contract_amount, 0) > 0 
      AND COALESCE(sp.total_paid_amount, 0) / sc.total_contract_amount >= 0.6
    THEN true
    ELSE false
  END AS is_on_target,
  
  -- 转化率（原有）
  CASE 
    WHEN COUNT(l.id) FILTER (WHERE l.funnel_stage IN ('won','lost')) > 0 
    THEN ROUND(
      COUNT(l.id) FILTER (WHERE l.funnel_stage = 'won')::DECIMAL / 
      COUNT(l.id) FILTER (WHERE l.funnel_stage IN ('won','lost')) * 100, 1
    )
    ELSE 0
  END AS conversion_rate,
  
  -- 活跃度指标（原有）
  COUNT(l.id) FILTER (WHERE l.last_contact_date >= CURRENT_DATE - INTERVAL '3 days') AS recently_contacted,
  COUNT(l.id) FILTER (WHERE l.funnel_stage NOT IN ('won','lost') AND (l.last_contact_date IS NULL OR l.last_contact_date < CURRENT_DATE - INTERVAL '7 days')) AS stale_leads

FROM profiles p
LEFT JOIN leads l ON l.assigned_to = p.id
LEFT JOIN sales_contracts sc ON sc.sales_id = p.id
LEFT JOIN sales_payments sp ON sp.sales_id = p.id
LEFT JOIN sales_overdue so ON so.sales_id = p.id
WHERE p.role IN ('sales')
GROUP BY p.id, p.full_name, p.role, p.is_active, 
         sc.contract_count, sc.total_contract_amount, sc.monthly_contract_amount, sc.quarterly_contract_amount,
         sp.total_paid_amount, sp.monthly_paid_amount,
         so.overdue_count, so.overdue_amount;

COMMENT ON VIEW v_sales_performance IS '销售业绩汇总视图（v2.0）：含管道、合同、回款、逾期、达标标记';
```

### 6.8 扩展 business_events 事件类型

```sql
-- 新增事件类型（v2.0 增加合同相关事件）
ALTER TABLE business_events 
  DROP CONSTRAINT IF EXISTS chk_event_type;
ALTER TABLE business_events 
  ADD CONSTRAINT chk_event_type 
  CHECK (event_type IN (
    'stage_change', 'status_change', 'probability_change', 'owner_change',
    'assignment_change',  -- 归属分配
    'transfer',           -- 转交
    'contact_made', 'contact_scheduled', 'quotation_sent', 'quotation_approved',
    'quotation_rejected', 'won', 'lost', 'recovery_candidate', 'transfer_candidate',
    'sales_manager_review', 'hold', 'unhold', 'competitor_added', 'decision_made',
    'payment_recorded',   -- 收款登记
    'payment_overdue',    -- 逾期标记
    'target_set',         -- 目标设定
    'contract_created',   -- ★新增：合同创建
    'contract_activated', -- ★新增：合同生效
    'contract_completed', -- ★新增：合同完成
    'contract_terminated',-- ★新增：合同终止
    'installment_paid',   -- ★新增：分期已付
    'installment_overdue',-- ★新增：分期逾期
    'delivery_milestone'  -- ★新增：交付里程碑变更
  ));
```

### 6.9 逾期检测和自动状态更新（计划任务）

```sql
-- 每日运行的逾期检测 SQL
-- 将到期未付的分期标记为 overdue
UPDATE installment_plans
SET status = 'overdue', updated_at = now()
WHERE status = 'pending'
  AND due_date < CURRENT_DATE;

-- 分期变为 paid 的条件：累计收款 >= 计划金额
-- 在收款登记时触发更新
CREATE OR REPLACE FUNCTION update_installment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_plan_amount DECIMAL(12,2);
  v_contract_id UUID;
BEGIN
  -- 获取分期计划信息
  SELECT ip.amount, ip.contract_id INTO v_plan_amount, v_contract_id
  FROM installment_plans ip
  WHERE ip.id = NEW.installment_plan_id;
  
  -- 更新分期累计收款金额
  UPDATE installment_plans
  SET paid_amount = (
    SELECT COALESCE(SUM(amount), 0)
    FROM payments
    WHERE installment_plan_id = NEW.installment_plan_id
      AND confirmed = true
  )
  WHERE id = NEW.installment_plan_id;
  
  -- 如果累计收款 >= 计划金额，标记为 paid
  UPDATE installment_plans
  SET status = 'paid', updated_at = now()
  WHERE id = NEW.installment_plan_id
    AND status = 'pending'
    AND paid_amount >= v_plan_amount;
  
  -- 检查合同是否全部分期已 paid
  IF NOT EXISTS (
    SELECT 1 FROM installment_plans
    WHERE contract_id = v_contract_id
      AND status NOT IN ('paid', 'cancelled')
  ) THEN
    UPDATE contracts
    SET status = 'completed', updated_at = now()
    WHERE id = v_contract_id
      AND status = 'active';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 在收款登记后触发
CREATE TRIGGER trg_payment_after_insert
  AFTER INSERT ON payments
  FOR EACH ROW
  WHEN (NEW.confirmed = true AND NEW.installment_plan_id IS NOT NULL)
  EXECUTE FUNCTION update_installment_status();

-- 交付里程碑延期检测
UPDATE delivery_plans
SET status = 'delayed', updated_at = now()
WHERE status IN ('pending', 'in_progress')
  AND expected_date < CURRENT_DATE - INTERVAL '3 days';
```

---

## 7. 与现有功能的集成方案

### 7.1 Leads 页面集成

| 当前 Leads 页面 | 集成改动 |
|----------------|---------|
| Kanban 看板视图 | 每个卡片增加负责人头像/姓名；管理员看板增加成员筛选器（默认"全部"） |
| 列表视图 | 增加「负责人」列；支持按负责人筛选 |
| 新建 Lead 表单 | 「分配给」下拉框（必选或可选）；新建后触发 `assignment_change` 事件 |
| Lead 详情页 | 增加「归属历史」Tab + 「合同」Tab（Won 阶段才显示）；增加「转交」按钮 |
| 批量操作 | 增加「批量分配」选项 |
| Won 阶段 Lead | 增加「创建合同」按钮（引导到合同创建页面） |

### 7.2 Pipeline 页面集成

| 当前 Pipeline 页面 | 集成改动 |
|-------------------|---------|
| 漏斗阶段列 | 不变，数据范围根据角色/筛选器动态变化 |
| 顶部工具栏 | 增加「成员筛选器」下拉框（仅 admin/operator 可见） |
| 卡片信息 | 增加负责人标签；停滞线索增加标记 |
| 总计行 | 底部汇总根据当前筛选动态计算 |

### 7.3 Dashboard 页面集成（★REVISED★）

| 当前 Dashboard 区域 | 集成改动 |
|--------------------|---------|
| 顶部指标卡片 | 改为 4 个合同驱动指标：签约总额、已收总额、待收总额、逾期总额（替换旧指标） |
| 中部区域 | 增加「销售业绩排名表」（签约额/回款额/回款率/逾期笔数/达标标记） |
| 逾期预警区域 | 增加「逾期回款清单」+「交付延期清单」两个独立板块 |
| 底部区域 | 增加「目标完成率」进度条（团队总览 + 个人明细） |
| 新增 | 增加「达标预警」汇总行（N 位销售回款率低于 60%） |

### 7.4 导航侧栏集成

| 当前侧栏 | 集成改动 |
|---------|---------|
| Leads / Pipeline / Dashboard | 不变 |
| 新增「合同管理」菜单项 | 子菜单：全部合同 / 我的合同（sales 仅见自己） |
| 新增「团队管理」菜单项 | 子菜单：成员管理 / 目标管理 / 回款报表（仅 admin/operator 可见） |

### 7.5 Supabase RLS 策略更新（v2.0）

```sql
-- contracts 表 RLS（上文已给出）

-- installment_plans 表 RLS（上文已给出）

-- delivery_plans 表 RLS（上文已给出）

-- payments 表 RLS（v2.0 更新版，上文已给出）

-- sales_targets 表 RLS（v2.0 更新 — 去掉 manager 角色）
CREATE POLICY "targets_admin_all" ON sales_targets FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- 增强 leads 表的 RLS（v2.0：去掉 manager 相关策略）
CREATE POLICY "operator_all_leads" ON leads FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'operator'));
```

### 7.6 前端导航配置（v2.0 更新版）

```typescript
// 按角色动态显示导航菜单（v2.0: 去掉 manager，增加 contract 相关）
const NAV_ITEMS = {
  common: [
    { label: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
    { label: 'Pipeline', path: '/pipeline', icon: TrendingUp },
    { label: 'Leads', path: '/leads', icon: Users },
  ],
  contracts: [
    { label: '全部合同', path: '/contracts', icon: FileText, roles: ['admin','operator','finance'] },
    { label: '我的合同', path: '/my-contracts', icon: FileText, roles: ['sales'] },
  ],
  salesTeam: [
    { label: '团队管理', path: '/team', icon: UserCog, roles: ['admin','operator'] },
    { label: '销售业绩', path: '/team/performance', icon: BarChart3, roles: ['admin','operator'] },
    { label: '目标管理', path: '/team/targets', icon: Target, roles: ['admin'] },
    { label: '回款报表', path: '/team/payments', icon: DollarSign, roles: ['admin','operator','finance'] },
  ],
  my: [
    { label: '我的业绩', path: '/my-performance', icon: User, roles: ['sales'] },
    { label: '我的目标', path: '/my-targets', icon: Target, roles: ['sales'] },
    { label: '我的回款', path: '/my-payments', icon: DollarSign, roles: ['sales'] },
  ],
};
```

---

## 8. 里程碑计划

### 📅 Sprint 1（本周 — 两周）: P0 核心功能（合同驱动回款闭环）

| 任务 | 预估工时 | 交付物 |
|------|---------|--------|
| Lead 单条分配 + 未分配池 UI | 2 天 | 新建/编辑 Lead 可选分配销售 + 未分配池页面 |
| Lead 转交功能 | 1 天 | 详情页转交按钮+弹窗+记录事件 |
| 团队漏斗视图 + 成员筛选器 | 2 天 | Pipeline 页面增加筛选器，按角色控制范围 |
| **合同 CRUD + 状态机** | **2 天** | **contracts 表 + 合同创建表单 + 合同列表 + PDF 上传** |
| **付款计划 + 自动待收** | **2 天** | **installment_plans 表 + 分期设置 UI + 自动生成待收记录** |
| **收款登记（合同联动）** | **1.5 天** | **payments 表（v2.0版）+ 关联分期 + 自动对账逻辑** |
| Dashboard 顶部 4 指标卡片 | 1 天 | 签约总额/已收总额/待收总额/逾期总额卡片 |
| 逾期回款 Dashboard 清单 | 1 天 | 逾期列表组件（按天排序） |
| 销售业绩排名表（含达标预警） | 2 天 | 排名表 + 回款率 < 60% 标记 |

**Sprint 1 交付后管理价值**: 管理员可以分配Lead→看到团队漏斗→从Won Lead创建合同→设定付款计划→财务登记收款→自动对账→逾期检测→Dashboard完整看板。

### 📅 Sprint 2（第 3-4 周）: P1 增强功能

| 任务 | 预估工时 | 交付物 |
|------|---------|--------|
| 批量分配功能 | 1 天 | 列表/看板勾选 + 批量分配弹窗 |
| 归属历史追溯 | 1 天 | 详情页归属历史Tab，消费 business_events |
| 销售成员管理页面 | 1.5 天 | 成员列表 + 新增/编辑/停用/激活 |
| 销售目标设定 + 完成率 | 2 天 | sales_targets 表 + 目标管理页面 + 进度展示 |
| **交付计划 + 延期检测** | **1.5 天** | **delivery_plans 表 + 里程碑设置 + 自动延期标记 + Dashboard 延期清单** |
| **合同审批字段预埋** | **0.5 天** | **approval_status + approved_by + approved_at 字段 + 前端预留** |
| 风险标记（停滞高亮） | 0.5 天 | 管道卡片的超期提示标记 |
| 漏斗转化率展示 | 1 天 | 阶段间转化百分比计算 + 展示 |

### 📅 Sprint 3（第 5-6 周）: P2 及其他

| 任务 | 预估工时 | 交付物 |
|------|---------|--------|
| 系统通知（新线索/转交/逾期通知） | 2 天 | 站内通知 + 可选通知渠道 |
| 季度目标 + 考核历史 | 1 天 | 季度目标设定 + 历史页面 |
| 业绩趋势图 | 1 天 | 6 个月签约/回款折线图 |
| 批量目标模板 | 0.5 天 | 预设目标模板 + 批量应用 |
| 合同版本管理 | 1 天 | version 字段 + 版本历史 |
| AI 合同提取（方案B） | 2 天 | PDF 自动提取签约金额、付款条款 |
| 财务专用报表增强 | 1 天 | 财务专用回款报表页面 |

---

## 9. 附录：权限矩阵

### 完整权限矩阵（v2.0 — 4 角色）

| 操作 | admin | operator | sales | finance |
|------|-------|---------|-------|---------|
| 查看所有 Lead | ✅ | ✅ | ❌ 仅自己 | ❌ |
| 创建 Lead | ✅ | ✅ | ✅ | ❌ |
| 编辑 Lead | ✅ | ✅ | ✅ 仅自己 | ❌ |
| 删除 Lead | ✅ | ❌ | ❌ | ❌ |
| 分配 Lead | ✅ | ✅ | ❌ | ❌ |
| 转交 Lead | ✅ | ✅ | ❌ | ❌ |
| 批量调配 Lead | ✅ | ✅ | ❌ | ❌ |
| 查看归属历史 | ✅ | ✅ | ✅ 仅自己 | ❌ |
| 查看团队漏斗 | ✅ | ✅ | ❌ | ❌ |
| 查看个人漏斗 | ✅ | ✅ | ✅ | ❌ |
| **创建合同** | **✅** | **✅** | **❌** | **❌** |
| **上传合同 PDF** | **✅** | **✅** | **❌** | **❌** |
| **查看所有合同** | **✅** | **✅** | **❌ 仅自己签约** | **✅** |
| **设定付款计划** | **✅** | **✅** | **❌** | **✅** |
| **设定交付计划** | **✅** | **✅** | **❌** | **❌** |
| **终止合同** | **✅** | **❌** | **❌** | **❌** |
| 登记收款 | ✅ | ✅ | ❌ | ✅ |
| 查看回款报表 | ✅ | ✅ | ✅ 仅自己 | ✅ |
| **查看逾期清单** | **✅** | **✅** | **❌ 仅自己** | **✅** |
| **查看交付延期清单** | **✅** | **✅** | **❌ 仅自己** | **❌** |
| 查看团队业绩排名 | ✅ | ✅ | ❌ | ✅ |
| 查看个人业绩 | ✅ | ✅ | ✅ | ✅ |
| 设定销售目标 | ✅ | ❌ | ❌ | ❌ |
| 管理成员 | ✅ | ✅ | ❌ | ❌ |
| 角色/权限配置 | ✅ | ❌ | ❌ | ❌ |

### 数据范围矩阵（v2.0）

| 角色 | Leads 数据范围 | 合同数据范围 | 回款数据范围 | 业绩数据范围 |
|------|---------------|-------------|-------------|-------------|
| admin | 全部 | 全部 | 全部 | 全部 |
| operator | 全部 | 全部 | 全部 | 全部 |
| sales | 仅 `assigned_to = 自己` | 仅 `sales_id = 自己` | 仅关联自己的合同 | 仅自己 |
| finance | ❌ 不能看 Leads | 全部（只读） | 全部 | 仅回款相关 |

---

## 10. 关键设计决策记录

| 决策 ID | 决策 | 选项 | 选择理由 |
|---------|------|------|---------|
| D-001 | **去掉了销售经理(manager)角色，简化为4角色** | 保留 manager vs 去掉 | 当前公司规模小，不需要中间管理层。老板直管团队，admin + operator 覆盖所有管理职能 |
| D-002 | **合同是回款的锚点，回款关联合同而非 Lead** | 关联 Lead vs 关联合同 | Lead 只表示销售机会，合同代表法律约束力的签约，付款计划和金额在合同中定义。合同→分期→收款，一条链路更清晰 |
| D-003 | **电子合同先用方案A（手工录入+PDF上传）** | 方案A vs 方案B（AI提取） | 快速上线优先。预埋 extracted_fields 字段，未来切方案B时数据结构不变 |
| D-004 | **合同审批暂不实现，当前 draft→active 自动生效** | 立即审批 vs 跳过 | 当前审批流程简单、人员少。预埋 approval_status/approved_by/approved_at 字段，未来插入审批不破坏数据 |
| D-005 | **付款计划独立建表 installment_plans，不用 payments 表字段标记** | 独立表 vs 复用 payments | 独立表更清晰：分期是计划概念，收款是执行概念。一笔收款可以分次付清一期（累计 paid_amount） |
| D-006 | **收款金额可以小于分期计划金额（支持分次付清）** | 严格等于 vs 可小于 | 实际业务中常见分多次付清一期（如部分银行转账 + 部分现金），所以用累计 paid_amount 判断 |
| D-007 | **回款率 < 60% 作为达标/未达标预警阈值** | 50% vs 60% vs 70% | 参考行业惯例。60% 是"及格线"，低于此意味着过半款项尚未收回，现金流风险较大 |
| D-008 | **交付计划独立 contract 层面，不绑定分期** | 绑定分期 vs 独立 | 交付里程碑与付款计划可以不同步（如完成交付后才收到尾款），两者独立管理更灵活 |
| D-009 | **行政(operator)可以管理合同草稿但不能终止合同** | 全部权限 vs 有限权限 | 终止合同涉及法律风险，仅 admin 可操作；operator 可以创建和管理 active 状态的合同 |

---

> **文档版本记录**
>
> | 版本 | 日期 | 修改人 | 修改内容 |
> |------|------|--------|---------|
> | v1.0 | 2026-06-03 | 产品总监 | 初始版本（含 manager 角色，独立回款管理） |
> | **v2.0** | **2026-06-03** | **产品总监** | **增量更新：1) 去掉了经理角色，简化为4角色；2) 新增合同管理模块（电子合同存档+付款计划+交付计划+审批预留）；3) 回款管理重新设计为合同联动版；4) 新增完整统计看板（4指标卡片+排名表+逾期清单+交付延期清单+达标预警）；5) 数据模型新增 contracts/installment_plans/delivery_plans 表，重构 payments 表** |
