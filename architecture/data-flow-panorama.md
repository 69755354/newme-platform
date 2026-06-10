# NewMe CRM — 数据流全景与集成架构设计

> **Architecture Director Analysis**
> 日期: 2026-06-04 | 受众: SAM | 状态: 分析方案稿

---

## 1. 数据流全景图

### 1.1 核心数据主线

```mermaid
graph TD
    subgraph "数据源层 Sources"
        META[Meta Ads<br/>Facebook/Instagram] -->|Lead Form| CAPI
        WA[WhatsApp<br/>客户咨询] -->|Msg| HERMES
        WX[微信 WeChat<br/>工程协作] -->|方案讨论| HUMAN
        TG[Telegram<br/>SAM控制] -->|指令| HERMES
        FS[飞书 Feishu<br/>Tanya权限] -->|文件| HERMES
        CAD[CAD图纸<br/>DWG/DXF] -->|文件| HERMES
    end

    subgraph "接入层 Ingestion"
        CAPI[Meta CAPI<br/>Webhook] -->|POST /api/leads/meta-capi| CRM
        HERMES[Hermes Agent<br/>AI大脑] -->|API调用| CRM
        HUMAN[人工录入<br/>SAM/Tanya] -->|UI操作| CRM
    end

    subgraph "存储层 Storage (Supabase)"
        CRM[Next.js CRM<br/>app.newme.ae]
        CRM --> LEADS[(leads表)]
        CRM --> QUOTES[(quotations表)]
        CRM --> CONTRACTS[(contracts)]
        CRM --> PAYMENTS[(payments)]
        CRM --> PROJECTS[(projects)]
        CRM --> ACTIVITIES[(activities)]
        CRM --> EVENTS[(business_events)]
        CRM --> PROFILES[(profiles)]
        CRM --> CUSTOMERS[(customers)]
        CRM --> PRODUCTS[(products)]
    end

    subgraph "计算引擎 Compute"
        QE[Quotation Engine<br/>34设备 | 7分类] -->|calculateQuotation| CRM
        KNX[KNX设计规则<br/>~/.hermes/knowledge] --> HERMES
        COS[COS对象存储<br/>ap-singapore] -->|CAD/PDF/PPT| HERMES
    end

    subgraph "输出层 Output"
        CRM -->|报价单| EXPORT[CSV导出]
        CRM -->|合同| HUMAN
        HERMES -->|方案PPT| COS
        HERMES -->|WhatsApp回复| WA
        HERMES -->|Telegram报告| TG
    end

    subgraph "投流管道 Meta Ads Pipeline"
        META -->|用户填表| LFI[Lead Form Instant]
        LFI -->|数据回传| CAPI
        CAPI -->|创建Lead| LEADS
        LEADS -->|stage: new| HERMES
        HERMES -->|跟进| WA
        HERMES -->|报价| QE
        QE -->|结果| LEADS
        LEADS -->|stage: quoted| HERMES
        HERMES -->|签单| CONTRACTS
        CONTRACTS -->|首付| PAYMENTS
        PAYMENTS -->|施工| PROJECTS
    end
```

### 1.2 14张表数据血缘

| 表 | 写入者 | 读取者 | 核心字段 | 增长模式 |
|---|---|---|---|---|
| **leads** | CAPI webhook, Hermes, 人工 | QE, Hermes, UI | source, stage, customer_name, phone, devices_json | 线性增长, 每客户1-N条 |
| **quotations** | QE, Hermes | 导出, UI | lead_id, total_amount, devices_json, status | 每lead多版本 |
| **quotes** (legacy) | QE fallback | 兼容 | 同quotations, 精简 | 逐步废弃 |
| **contracts** | 人工/Hermes | UI, payments | lead_id, total, status | 低频, 约10% lead转化 |
| **installment_plans** | 人工 | payments | contract_id, schedule | 低频 |
| **payments** | 人工/支付网关 | UI, reporting | contract_id, amount, status | 每月数次 |
| **projects** | 人工 | UI | lead_id, status, milestones | 低频, 每个合同1条 |
| **activities** | CRM API, Hermes | UI feed | lead_id, type, content, ai_generated | 高频, 每次操作一条 |
| **business_events** | CRM API, Hermes | 审计/报告 | lead_id, event_type, event_data | 高频, 业务事件 |
| **profiles** | 注册 | RLS, auth | role (admin/sales) | 极低频 |
| **chat_messages** | Hermes Gateway | UI | lead_id, role, content | 高频 |
| **transfer_history** | CRM | 审计 | lead_id, from/to | 低频 |
| **customers** | 人工/同步 | UI, reporting | 客户主数据 | 线性 |
| **products** | 人工 | QE, UI | 设备目录 | 低频更新 |

---

## 2. 数据存储分层策略

### 热/温/冷三层模型

| 层级 | 存储 | 数据 | 访问频率 | 保留策略 |
|---|---|---|---|---|
| **热 (Hot)** | Supabase PostgreSQL | leads (active), quotations (draft), 近30天activities | 实时 (秒级) | 索引优化, RLS保护 |
| **温 (Warm)** | Supabase PostgreSQL | contracts, payments, projects, 30-365天数据 | 日常 (分钟/小时级) | 归档标记 `archived=true` |
| **冷 (Cold)** | COS (JSON dump) | >1年的完整快照, 已结案项目 | 审计/追溯 (月级) | 季度导出至COS, 原地清理 |

### 备份策略

1. **Supabase 自动备份** — Pro plan 自带 PITR (7天), 启用 daily backup
2. **定时导出至 COS** — cron job 每日导出关键表 (leads, quotations, contracts, payments) 至 newme-1302961787 bucket
3. **SQLite 本地冷备** — Hermes Agent 本地 SQLite 缓存会话数据, 防止网关崩溃丢失
4. **增量 vs 全量** — 每日全量导出 (小数据量阶段), 月度增量 (数据量>50万行后)

### 增长预测

- **当前**: 0 leads, 0 payments (空系统)
- **3个月预测**: 200-500 leads, 50-100 quotations, 10-20 contracts
- **12个月预测**: 2000-5000 leads, 500-1000 quotations, 100-200 contracts
- **瓶颈**: Supabase free tier 500MB → 升 Pro ($25/mo) 8GB → 升 Team ($599/mo) 32GB
- **建议**: 从 Pro 起步, 无需担心冷备策略直至 >5000 leads

---

## 3. WhatsApp 集成方案

### 架构: Meta Business API + Hermes Gateway Webhook

```
WhatsApp <-> Meta Cloud API <-> Hermes Gateway (whatsapp.py) <-> CRM API
                                  ↓
                            Supabase (chat_messages)
                                  ↓
                            Hermes Agent (AI 分析/回复)
```

### 可行性评估

| 组件 | 状态 | 备注 |
|---|---|---|
| **Hermes Gateway whatsapp.py** | ✅ 已存在 1282行 | 支持 Meta Business API + whatsapp-web.js + Baileys |
| **Meta Cloud API** | ✅ 可行 | WhatsApp Business Account 需认证, API 免费, 消息按量计费 |
| **Webhook 接收** | ✅ 直接 | Meta 发送消息到 Hermes Gateway, 自动路由 |
| **消息 → CRM 数据** | ⚡ 需开发 | webhook 解析 + lead 创建/更新 + chat_messages 存储 |
| **CRM → WhatsApp 回复** | ⚡ 需开发 | 通过 Meta API 发送模板消息/文本 |

### 实现路径

```
Step 1: 配置 Meta Business Account + WhatsApp Business API
        → 获取 PHONE_NUMBER_ID, ACCESS_TOKEN
        → 设置 Webhook URL: https://hermes-gw.newme.ae/whatsapp-webhook

Step 2: Hermes Gateway 配置
        ┌─────────────────────────────────────┐
        │ platform: whatsapp                  │
        │ backend: meta_api                   │
        │ phone_number_id: "xxxxx"            │
        │ access_token: "EAAx..."             │
        │ webhook_verify_token: "newme_2026"  │
        └─────────────────────────────────────┘

Step 3: Webhook 消息处理 Pipeline
        收到消息 → 识别客户(phone lookup) → 写入 chat_messages
        → Hermes Agent 分析意图 → 如果是咨询报价 → 调用 QE
        → 回复模板消息 → 更新 lead activities

Step 4: 模板消息配置 (预审)
        - welcome_intro: 欢迎 + 公司介绍
        - quote_summary: 报价摘要 + 预约链接
        - payment_reminder: 付款提醒
        - project_update: 施工进度通知
```

### 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| Meta Business 审核周期 (2-4周) | 中 | 提前提交, 用 whatsapp-web.js 过渡 |
| 模板消息被拒 | 低 | 用纯文本 + 按钮替代, 避免营销用语 |
| 24h 会话窗口限制 | 中 | 用模板消息延展, 或标记客户主动咨询 |
| 隐私合规 (UAE PDPL) | 中 | 存储客户同意记录, 提供 opt-out |

---

## 4. 报价引擎与 WeChat 协作流程对接

### 核心约束

> **WeChat 不能直连 API** — 中国工程团队用微信, 无法集成 API

### 设计原则: "人在回路中, 系统做重活"

### 协作流程

```
                    ┌──────────────────────┐
                    │  Hermes Agent 生成    │
                    │  初始报价方案          │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │  报价 PDF/Excel       │
                    │  上传 COS → 生成链接   │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │  Telegram 通知 SAM    │ ← 系统到人
                    │  "报价已生成, 链接:.."  │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │  SAM 转发到 WeChat    │ ← 人到人
                    │  工程团队审阅           │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │  工程团队 WeChat 回复   │
                    │  修改意见 → SAM 录入    │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │  SAM 在 CRM 录入      │
                    │  修改意见 + 版本迭代    │
                    └──────────┬───────────┘
                               ↓
                    ┌──────────────────────┐
                    │  Hermes Agent 按      │
                    │  意见修改报价(版本2)    │
                    └──────────────────────┘
```

### 关键设计决策

| 决策 | 方案 | 理由 |
|---|---|---|
| 报价载体 | COS 链接 (PDF/Excel) + CRM 内 JSON | 既支持微信转发, 又支持系统分析 |
| 修改意见录入 | CRM UI 对话框 + Telegram 快捷录入 | 降低 SAM 操作成本 |
| 版本控制 | quotations 表 version 字段 | 每次修改递增 version |
| 协作记录 | activities 表 type='wechat_review' | 可审计, 可追溯 |
| 最终确认 | CRM 内 "工程确认" 按钮 → 生成正式版 | 避免不确定版本流出 |

### 改进建议: 半自动化 WeChat 桥

虽然不能直连 WeChat API, 但可以通过 **Telegram → Hermes → SAM → WeChat** 链路优化:

1. **报价摘要自动生成** — Hermes Agent 生成中文/英文双语报价摘要, SAM 可直接复制转发
2. **修改意见结构化** — SAM 在 Telegram 输入 `@modify_quote <id> 修改: 客厅减少2路DALI`, 系统自动执行
3. **差异对比** — 版本间自动 diff, SAM 转发前就知道改了什么

---

## 5. Meta Ads → CAPI → Leads 完整管道

### 端到端数据流

```
Meta Ads Manager
    │
    ├── Facebook/Instagram Lead Form
    │   └── 用户填写: 姓名, 电话, 邮箱, 户型, 区域, service_needs
    │       ↓
    │   Meta 服务器端事件 (Server-Side Event)
    │       ↓
    ├── Meta CAPI (Conversions API) ← 我们 POST 事件回传
    │   └── 回传: Lead, ViewContent, AddToCart, Purchase
    │       ↓
    └── Meta 自动分配规则 (Lead CRM Setup)
        └── Webhook → https://app.newme.ae/api/leads/meta-capi
            ↓ (已实现, 见 route.ts)
    Supabase leads 表
            ↓
    Hermes Agent 自动跟进 (2分钟内)
            ├── 分析: 判断需求优先级
            ├── 生成: WhatsApp 欢迎消息模板
            └── 通知: Telegram 通知 SAM
            ↓
    人工/SAM 确认跟进策略
            ↓
    Quotation Engine 生成报价
            ↓
    WhatsApp 发送报价 → 签约 → 付款 → 施工
```

### 数据字段映射

| Meta Form 字段 | CRM leads 字段 | 类型 | 备注 |
|---|---|---|---|
| full_name | customer_name | text | 必填 |
| phone_number | phone | text | 唯一标识, 去重 key |
| email | email | text | 可选, 辅助去重 |
| property_type | property_type | text | villa/apartment |
| property_size | property_size_sqm | number | 面积 |
| service_needs | service_needs | jsonb[] | 多选: curtain, hvac, cctv... |
| location | location | text | 区域 |
| campaign_name | meta_campaign | text | 广告系列 |
| ad_id | meta_ad_id | text | 广告 ID |
| creative_id | meta_creative_id | text | 创意 ID |
| fbc (Facebook Click) | meta_click_id | text | 归因 |
| (自动) | source | text | "meta" / "instagram" |
| (自动) | stage | text | "new" |
| (自动) | lead_status | text | "hot" |

### 归因与回传

```
Meta Ads 发布
    ↓
用户点击广告 → fbclid / fbc
    ↓
用户填写 Lead Form → CRM 创建 lead (存 meta_click_id)
    ↓
Hermes Agent 发送 CAPI 回传:
    ├── event_name: "Lead"       → 告知 Meta 获得线索
    ├── event_name: "ViewContent" → 报价发送时触发
    └── event_name: "Purchase"   → 合同签约时触发
        ↓
Meta 学习模型优化 → 提高相似用户出价效率
```

---

## 6. 技术风险与优先级矩阵

### 优先级: 不做会死 (P0) vs 可以等 (P2)

| # | 事项 | 优先级 | 理由 | 预计工时 |
|---|---|---|---|---|
| 1 | **WhatsApp Business API 审核 + 接入** | **P0** | 客户沟通主通道, 无此则客户无法跟进 | 1-2周 |
| 2 | **Meta CAPI 回传完整事件** | **P0** | 投流拉通闭环, 无回传则广告模型不学习 | 3天 |
| 3 | **Lead 自动分配 + 跟进** | **P0** | 从 "收到lead → 人工操作" 到 "收到lead → 自动回复" | 1周 |
| 4 | **报价版本管理 (version 字段 + diff)** | **P1** | WeChat协作需要版本迭代 | 3天 |
| 5 | **Telegram 快捷操作 (报价修改/审批)** | **P1** | SAM 移动办公体验 | 5天 |
| 6 | **合同管理 UI** | **P1** | 签约流程必须走通 | 1周 |
| 7 | **付款追踪 + installments** | **P1** | 收入确认依赖 | 1周 |
| 8 | **COS 冷备自动化** | **P2** | 当前数据量为0, 无需担心 | 2天 |
| 9 | **WhatsApp 模板消息预审** | **P2** | 文字回复可用, 模板非必要 | 1周 |
| 10 | **PWA 离线支持** | **P2** | 体验优化 | 3天 |
| 11 | **飞书恢复后集成** | **P2** | 本月限流, 下月再看 | - |
| 12 | **WeChat 机器人 (如果未来 API 开放)** | **P3** | 当前不可行 | - |

### 技术债务与架构风险

| 风险 | 等级 | 说明 | 建议 |
|---|---|---|---|
| **quotes 与 quotations 双表** | 中 | legacy quotes 表仍在写, 与 quotations 功能重复 | 2周后剪掉 quotes 表, 统一用 quotations |
| **Hermes Gateway 外网暴露** | 高 | Webhook 需公网可达 | 加 nginx 反向代理 + Cloudflare WAF |
| **Supabase 单点故障** | 中 | 全系统依赖 Supabase | 开启 PITR + 监控 uptime |
| **Meta CAPI webhook 无认证** | 低 | 当前有 Bearer token, 但需确认 | 已实现, 确认即可 |
| **quotation-engine 硬编码价格** | 中 | 价格在源码中, 改价需部署 | 建议后续迁移到数据库 products 表 |
| **没有支付网关集成** | 低 | payments 表为空 | 后续集成 Stripe/PayTabs |

---

## 7. 总结架构原则

> **"一条水流" 架构**
>
> 所有数据从源头到终点, 路径清晰可追踪, 没有断点或手动搬运

### 关键心智模型

1. **Supabase 是唯一真相源** — 所有系统状态以 Supabase 为准, Hermes 只是计算层
2. **Hermes Agent 是胶水层** — 不存业务数据, 负责翻译、分析、触发
3. **COS 是文件层** — CAD, PPT, PDF 等非结构化数据全部走 COS
4. **Telegram 是 SAM 控制面板** — 不在 CRM UI 重复造轮子, 快捷操作走 Telegram
5. **WeChat 是人工环节** — 系统创造好的 "半成品", 人工在微信完成最终审阅

### 推荐启动 Sprint

```
Sprint 1 (7天) : WhatsApp 接入 + Meta CAPI 回传闭环
Sprint 2 (7天) : Lead 自动跟进 + 报价版本迭代
Sprint 3 (7天) : 合同+付款流程 + Telegram 快捷操作
Sprint 4 (7天) : COS 冷备 + 模板消息 + 遗留表清理
```
