# SAM-18：NewMe SaaS 产品边界与计费决策

| 项目 | 值 |
| --- | --- |
| Linear | SAM-18 |
| 决策状态 | 已定案，待实施 |
| 决策日期 | 2026-07-30 |
| 文档基线 | `d901e3a7dce349935e2a5d2585de51246edd9bf9` |
| 首期行业 | 房地产/中介、零售 |

> **事实边界：** 本文记录产品决策和未来验收规则，不证明任何功能已经上线。除非另有对应代码、数据库、CI 与 staging 动态证据，本文提到的组织模型、角色、计费席位、套餐、停用恢复、行业模块和合规能力均视为**未实施**。

## 1. 决策目标

SAM-18 锁定首期 SaaS 的五个基础问题：

1. 平台角色与组织角色如何分离、旧角色如何映射。
2. 哪些用户计入付费席位，以及套餐、超额和欠费如何处理。
3. 房地产/中介与零售如何共享通用能力、同时保持行业和组织隔离。
4. 用户停用、恢复、历史记录和未完成工作如何处理。
5. 后续实现必须通过哪些可重复的权限、计费、隔离与合规验收。

本文是这些问题的单一产品决策源。具体 schema、API、RLS、界面和计费实现必须引用本文，但不得把本文当作上线证据。

## 2. 账户、组织与行业边界

### 2.1 层级定义

- `account` 是商业关系与订阅的父级，可持有一个或多个组织。
- `organization`（简称 `org`）是最小租户、权限、数据和审计边界。
- 首期每个组织必须且只能选择一个主行业：`real_estate` 或 `retail`。
- 同一客户同时经营两种行业时，必须建立两个相互隔离的组织。
- 同一登录身份可以受邀加入多个组织，但权限、付费席位和数据范围按组织分别计算。

### 2.2 强制隔离

两个组织之间不得自动共享：

- 业务数据、文件和编号序列；
- 角色、权限和成员状态；
- 导入任务、报表、Dashboard 和自动化；
- webhook、API 凭证、第三方集成和审计记录。

首期不提供跨组织、跨行业聚合报表。未来若引入账户级汇总，必须单独定义显式授权、审计和字段脱敏规则。

## 3. 角色模型

### 3.1 平台角色

平台角色属于 NewMe 平台运维域，组织管理员不能授予、撤销或提升：

| 平台角色 | 允许范围 | 强制限制 |
| --- | --- | --- |
| `platform_owner` | 平台级最终管理与紧急处置 | 高风险操作必须审计 |
| `platform_ops` | 平台配置、租户运行支持 | 不继承组织业务角色 |
| `platform_support` | 经批准的临时客户支持 | 必须绑定工单、原因、组织范围和到期时间，单次最长 4 小时 |
| `platform_auditor` | 平台审计只读 | 不得修改业务数据 |

任何跨组织支持访问必须先成功写入审计记录，再建立访问会话；审计写入失败时访问必须拒绝。平台角色本身不产生组织内业务权限，也不计入客户付费席位。

### 3.2 组织角色

| 组织角色 | 首期职责 |
| --- | --- |
| `org_owner` | 组织所有权、订阅与最高组织级管理 |
| `org_admin` | 成员、角色、组织配置和日常管理 |
| `manager` | 团队范围管理、分配与审批 |
| `sales_agent` | 线索、客户、报价和销售推进 |
| `operations` | 合同、项目、交付和运营流程 |
| `finance` | 收款、付款状态、财务确认和财务报表 |
| `specialist` | 行业专业工作，例如设计或商品专业处理 |
| `viewer` | 严格只读的内部观察者 |
| `portal_user` | 仅访问明确授权对象的外部协作者 |

一个成员可在同一组织内持有多个组织角色，权限取并集；该并集不得跨组织传播。

### 3.3 现有角色迁移映射

| 现有角色 | 目标组织角色 |
| --- | --- |
| `boss` | `org_owner` |
| `admin` | `org_admin` |
| `operator` | `operations` |
| `sales` | `sales_agent` |
| `finance` | `finance` |
| `designer` | `specialist` |

迁移必须提供逐成员预览、角色计数、异常清单和可回滚结果。`org_owner` 映射必须由组织所有者或获授权的平台人员复核，不能只凭旧枚举自动提升。

## 4. 付费席位

### 4.1 计费定义

付费席位是同时满足以下条件的组织成员：

1. 邀请已接受；
2. 状态为 active；
3. 可以执行组织内业务写操作；
4. 持有至少一个付费角色。

付费角色为：

- `org_owner`
- `org_admin`
- `manager`
- `sales_agent`
- `operations`
- `finance`
- `specialist`

`viewer` 和 `portal_user` 为免费角色，但必须由服务端权限和 RLS 保证不能写入、导出、调用管理 API 或进入管理界面，不能只靠隐藏按钮。

### 4.2 计数规则

- 同一人在同一组织持有多个付费角色，只计一个席位。
- 同一人加入多个组织，每个组织分别计一个席位。
- pending、inactive、suspended 成员不计费。
- 平台角色不计入客户组织席位。
- 服务账号、集成身份和自动化执行身份不是人类席位，必须使用独立身份类型和最小权限。
- 角色或状态变更后的席位数必须可确定性重算，并留下审计记录。

## 5. 套餐与超额

### 5.1 首期套餐

| 套餐 | 付费席位 | 组织数 | 首期能力 |
| --- | ---: | ---: | --- |
| Starter | 5 | 1 | 单行业、核心 CRM、导入、任务、基础 Dashboard、Quote→Contract→Payment→Project |
| Growth | 20 | 最多 3 | Starter + 自动化、集成、审计和高级报表 |
| Scale | 50 起 | 多组织 | Growth + SSO、扩展审计、批量导出、容量与 SLA |

免费 `viewer` 和 `portal_user` 受合理使用限制；具体数量和资源阈值由商业条款另行发布，不在代码中暗藏未声明上限。

### 5.2 超额规则

- 不允许静默产生席位超额费用。
- 达到席位上限时，现有 active 成员继续工作；新的付费成员激活和付费角色恢复必须被阻止。
- 客户可以购买 5 席位扩展包或升级套餐。
- 存储、自动化执行量和 API 用量在 80% 与 100% 发出提示。
- 达到资源上限后，只阻止新的高消耗操作；读取、导出客户数据和删除以释放容量必须保留。
- 首期允许经审计的人工套餐调整；在自动计费具有完整账单、失败恢复和对账证据前，不宣称自动计费已上线。

## 6. 停用、恢复与欠费

### 6.1 成员停用

- 停用后立即撤销现有会话和刷新令牌。
- 历史记录、业务归属和审计作者不得被重写或删除。
- 未完成工作必须重新分配，或由管理员显式接管；系统不得静默改写负责人。
- 释放的席位可立即复用。
- 当期不自动退款；下一计费周期按有效席位重算。

### 6.2 成员恢复

- 停用后 90 天内可恢复原成员关系，但恢复前必须重新确认角色。
- 超过 90 天必须重新邀请；旧审计和历史作者仍保留。
- 恢复若会超过席位上限，必须阻止并提示购买席位或升级套餐。

### 6.3 欠费处置

| 时间 | 产品行为 |
| --- | --- |
| 欠费后第 1–7 天 | 宽限期，正常使用并持续提醒 |
| 第 8–30 天 | 组织只读，`org_owner` 保留数据导出能力 |
| 第 31 天起 | 暂停登录 |
| 至少 90 天保留期后 | 仅在完成通知、可验证备份和导出批准后，才允许进入删除流程 |

欠费处置不能破坏审计、法定保留或客户导出权。实际账单条款和适用法律优先于本文的默认产品流程。

## 7. 通用 SaaS 能力

两个行业共享以下核心能力，但所有记录都必须落在明确的组织边界中：

- account、organization、membership、role、seat 和 audit；
- 客户与联系人、Lead、Pipeline；
- 任务、提醒、通知、文件和搜索；
- Quote、Contract、Payment、Project；
- 导入、导出、Dashboard、webhook 和第三方集成；
- UAE VAT 基础字段；
- 个人数据处理目的、访问范围和跨境处理标记；
- 结构化电子发票的数据与集成准备能力。

## 8. 行业模块

### 8.1 房地产/中介

首期行业对象与流程边界：

- property、listing；
- 业主、买家、租户；
- 经纪人与房源匹配；
- 委托、佣金和交易阶段；
- 房产文件与到期提醒；
- DLD/Trakheesi 执照、广告许可和 listing validation 的集成状态。

DLD/Trakheesi 结果必须区分成功、失败、超时和未验证。失败或超时不得被静默显示为有效。

### 8.2 零售

首期行业对象与流程边界：

- product、SKU、variant；
- inventory、store、location；
- supplier、purchase、order、return；
- pricing、VAT receipt/invoice；
- cashier、merchandiser 和 inventory 工作流。

### 8.3 跨行业隔离

- 房地产组织不得看到或调用零售对象、菜单、API 与导入模板。
- 零售组织不得看到或调用房地产对象、菜单、API 与导入模板。
- 通用对象必须带有非空 `org_id` 和明确行业上下文。
- `00000000-0000-0000-0000-000000000000` 不能作为组织缺失时的替代值。

## 9. UAE 产品约束

### 9.1 VAT

- 默认标准税率为 5%，但税率必须按管辖范围和生效日期配置。
- 免税和零税率场景必须显式建模，不能把所有交易强制为 5%。

### 9.2 个人数据保护

- 记录个人数据的处理目的。
- 服务端执行最小权限。
- 敏感导出、平台支持访问和跨境处理必须审计。
- 保留和删除规则必须可配置并可证明执行结果。

### 9.3 电子发票

- 产品目标是 eInvoicing-ready：支持结构化字段、状态、服务商和交换标识。
- 在取得官方端到端接入、测试和业务证据前，不得宣称符合、认证或已完成 UAE eInvoicing。

### 9.4 房地产监管集成

- 广告许可、执照和 listing validation 必须保存来源、请求时间、响应状态和可追踪标识。
- 外部服务不可用时必须 fail closed，不能把“未验证”转换为“有效”。

## 10. 实现验收规则

以下规则全部通过，才可把相应实现标记为完成：

1. **角色分离：** 平台角色与组织角色在数据模型、令牌、UI 和 API 中分离；组织管理员不能授予平台角色。
2. **租户键：** 所有租户业务对象使用非空 `org_id`，组织内唯一约束明确，禁止 zero UUID 占位。
3. **组织负向测试：** A/B 两组织分别验证列表、搜索、直接 ID、导出、文件、导入、Dashboard、webhook、定时任务和 API 不越界。
4. **行业负向测试：** 房地产与零售分别验证 UI、API、导入和直接 ID 不能访问另一行业对象。
5. **支持访问：** `platform_support` 必须按工单、原因、范围和不超过 4 小时的到期时间创建；审计失败即拒绝。
6. **席位确定性：** 相同成员、状态和角色输入始终产生相同席位数；多角色不重复计费，多组织分别计费。
7. **上限行为：** 达到席位上限时保留现有用户，阻止新激活和超限恢复，不静默计费。
8. **生命周期：** 动态验证会话撤销、历史保留、工作重分配、90 天恢复边界和欠费各阶段。
9. **免费角色：** `viewer` 与 `portal_user` 必须通过 API 与 RLS 动态负向测试证明不可写、不可导出、不可管理。
10. **合规声明：** VAT、PDPL、eInvoicing 与 DLD/Trakheesi 的每项对外声明必须附官方范围和动态证据；准备能力不能表述为认证。
11. **迁移：** 旧角色迁移提供预览、计数、异常、回滚，并在 staging 完成至少双组织 UAT。
12. **交付证据：** 每项实现必须具备 Linear ID、精确 commit、PR、绿色 CI、适用的 staging/API/DB/RLS/UAT 证据、风险和回滚点。

## 11. 当前未实施清单

截至本文基线，本文不证明以下能力已实现：

- account/org/membership 的目标 schema 与完整租户 RLS；
- 平台角色、组织角色和临时支持会话；
- 席位计数、套餐、超额、欠费和自动计费；
- 成员停用、恢复与工作重分配；
- 房地产和零售行业模块；
- 跨组织、跨行业动态隔离；
- UAE eInvoicing、DLD/Trakheesi 集成或 PDPL 合规认证。

每项能力只有在第 10 节的适用验收证据齐全后，才能从本清单移除。

## 12. 官方参考

以下资料是本决策的外部输入，不替代 NewMe 自己的合同、法律意见或实施验收：

### SaaS 角色与席位参考

- [HubSpot：Assign and manage seats](https://knowledge.hubspot.com/account-management/manage-seats) — 区分可编辑席位与免费、严格只读的 View-Only Seat。
- [monday.com：How to invite users to join an account](https://support.monday.com/hc/en-us/articles/360002430099-How-to-invite-users-to-join-an-account) — 区分 Member 与只读 Viewer。
- [Odoo：Pricing](https://www.odoo.com/pricing) — 区分后台付费用户与通过 portal 使用的外部免费用户。
- [Zoho CRM：Team users and licensing](https://help.zoho.com/portal/en/kb/crm/using-crm-for-everyone/team-module/articles/faqs-team-users-and-licensing) — 区分组织级普通用户与范围受限的 team user。
- [Zoho Accounts：External users](https://help.zoho.com/portal/en/kb/accounts/faqs-troubleshooting/faqs/organization/articles/external-users) — 说明组织成员与受限外部用户的边界。

### UAE 官方参考

- [UAE Ministry of Economy and Tourism：Trade Policy Review（含 SME 结构数据）](https://www.moet.gov.ae/documents/20121/432397/%25D8%25AA%25D9%2582%25D8%25B1%25D9%258A%25D8%25B1%2B%25D9%2585%25D8%25B1%25D8%25A7%25D8%25AC%25D8%25B9%25D8%25A9%2B%25D8%25A7%25D9%2584%25D8%25B3%25D9%258A%25D8%25A7%25D8%25B3%25D8%25A9%2B%25D8%25A7%25D9%2584%25D8%25AA%25D8%25AC%25D8%25A7%25D8%25B1%25D9%258A%25D8%25A9%2B%25D9%2584%25D9%2584%25D8%25AF%25D9%2588%25D9%2584%25D8%25A9%2B%25E2%2580%2593%2B%25D8%25AA%25D9%2582%25D8%25B1%25D9%258A%25D8%25B1%2B%25D8%25A7%25D9%2584%25D8%25AD%25D9%2583%25D9%2588%25D9%2585%25D8%25A9.pdf/01171b9b-d845-be6d-2e2b-a4ecf44aa7fa?download=true&t=1632634982531&version=1.1)。
- [UAE Federal Tax Authority：VAT FAQ](https://tax.gov.ae/en/faq.aspx?keyword=Does+VAT+apply+to+all+goods+and+services%3F) — 标准 5% 税率以及零税率、免税例外。
- [UAE Government：Data protection laws](https://u.ae/en/about-the-uae/digital-uae/data/data-protection-laws.) — 联邦个人数据保护框架及跨境传输要求。
- [UAE Ministry of Finance：eInvoicing](https://mof.gov.ae/en/about-us/initiatives/einvoicing/) — 官方电子发票范围、结构和实施资料。
- [Dubai Land Department：Real Estate Ad Permit](https://dubailand.gov.ae/en/eservices/real-estate-ad-permit/) — Trakheesi 广告许可流程。
- [Dubai Land Department：API Gateway](https://dubailand.gov.ae/en/eservices/api-gateway/) — Listing Validation API 与相关监管集成说明。

## 13. 变更控制

- 更改角色集合、计费席位、套餐上限、欠费阶段、首期行业或隔离原则，必须回到 SAM-18 或其明确的后续产品决策。
- 实现问题、字段命名和迁移脚本可以在后续工程任务中细化，但不得削弱本文的 fail-closed、审计和隔离要求。
- 若官方法规、商业条款或外部平台资料变化，应通过新决策记录修订，不静默改写历史依据。
