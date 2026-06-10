# NewMe CRM v2.3 — 联合总监总方案与实施计划

> **文档类型**: Multi-Director Total Workflow Plan  
> **版本**: 2026-06-05  
> **参与总监**: Product Director / Architecture Director / Design Director / UX Director  
> **状态**: 方案完成，待用户确认实施

---

## 📊 一、现状盘点（截至 2026-06-05）

### ✅ 已完成（今天 + 昨天）

| # | 模块 | 具体内容 | 状态 |
|---|------|----------|------|
| 1 | **认证系统** | Dev mode 免登录 (`NEXT_PUBLIC_DEV_MODE=true`) | ✅ 已部署 |
| 2 | **认证系统** | proxy.ts + layout.tsx dev mode 鉴权绕过 | ✅ 已部署 |
| 3 | **认证系统** | 密码修改功能（admin/boss 重置他人密码） | ✅ 已部署 |
| 4 | **用户管理** | 用户 CRUD API (`/api/users/*`) | ✅ 已部署 |
| 5 | **用户管理** | 团队页面（角色管理、manager 分配） | ✅ 已部署 |
| 6 | **线索管理** | 批量转移、活动流、lead_status 自动触发器 | ✅ 已部署 |
| 7 | **线索管理** | 登录超时修复、销售漏斗进度条 | ✅ 已部署 |
| 8 | **线索管理** | Lead 详情页 trace timeline（全生命周期追踪） | ✅ 已部署 |
| 9 | **报价引擎** | 10 大类 47+ 设备目录 (`device-catalog.ts`) | ✅ 已部署 |
| 10 | **报价引擎** | 报价计算引擎（设备+服务+税） | ✅ 已部署 |
| 11 | **报价引擎** | 报价生成 API (`/api/quotations/generate`) | ✅ 已部署 |
| 12 | **报价页面** | 报价列表页 (36KB, 搜索/筛选/状态管理) | ✅ 已部署 |
| 13 | **报价页面** | 报价计算器 + 报价向导组件 | ✅ 已部署 |
| 14 | **合同管理** | 合同创建页（分期计划自动生成） | ✅ 已部署 |
| 15 | **合同管理** | 合同列表页 | ✅ 已部署 |
| 16 | **回款管理** | 付款记录+确认+分期状态联动 | ✅ 已部署 |
| 17 | **产品管理** | 产品 SKU 表页面 | ✅ 已部署 |
| 18 | **KPI 管理** | 月度目标设置+完成率计算 | ✅ 已部署 |
| 19 | **驾驶舱** | L1 财务卡片重构（完成率主视觉） | ✅ 已部署 |
| 20 | **驾驶舱** | L2 市场情报（品牌铜色统一） | ✅ 已部署 |
| 21 | **驾驶舱** | L3 销售排行（时间比例着色） | ✅ 已部署 |
| 22 | **驾驶舱** | L4 今日待办一行摘要 | ✅ 已部署 |
| 23 | **数据库** | 5 新表+RLS+触发器+4 视图 | ✅ 已部署 |
| 24 | **导航栏** | 10 项 → 6 项核心精简 | ✅ 已部署 |
| 25 | **KNX 设计** | Hermes KNX 设计面板（Lead 详情内嵌） | ✅ 已部署 |
| 26 | **Meta Ads** | OAuth 回调+归因字段 | ✅ 已部署 |

### 🔴 待做（Today's pending）

| # | 模块 | 优先级 | 预估工时 |
|---|------|--------|----------|
| A | **报价页 L1/L2 重构** | 🔴 高 | 4h |
| B | **工作流管理**（5 阶段+超时通知） | 🔴 高 | 6h |
| C | **COS 下载集成**（报价/PPT 下载） | 🔴 高 | 2h |
| D | **驾驶舱 Top 5 Actions** | 🟡 中 | 1h |
| E | **视觉一致性审查** | 🟡 中 | 2h |

---

## 🏗️ 二、多总监分析

### 2.1 Product Director 分析

**核心判断**: CRM v2.2 已具备完整的数据模型（quotes→contracts→payments），报价引擎 47 设备覆盖齐全。当前缺失的是**销售操作用户体验**——报价页太简陋、没有工作流引导、没有 actionable 的任务驱动。

**优先级排序**:
1. **报价 L1/L2 重构** — 销售每天用，影响最大
2. **工作流管理** — 减少丢单，管理刚需
3. **COS 下载** — 报价→交付闭环的关键
4. **Top 5 Actions** — 驾驶舱变成 actionable hub
5. **视觉一致性** — 品牌感知，锦上添花

**依赖关系**:
```
报价 L1/L2 (A) → 独立，无依赖
工作流管理 (B) → 依赖 activities 表已有字段（due_at, priority）+ 新建 lead_workflow_stages 表
COS 下载 (C) → 依赖 quotations 表 pdf_url/ppt_url 字段
Top 5 Actions (D) → 依赖 A+B 完成后，驾驶舱才有 actionable 数据
视觉一致性 (E) → 可并行，但建议 A/B 完成后统一审查
```

### 2.2 Architecture Director 分析

**数据库新增**:

```sql
-- 工作流阶段表（内嵌于 Lead 详情）
CREATE TABLE lead_workflow_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,  -- 'requirement','design','quotation','negotiation','handover'
  status TEXT DEFAULT 'pending',  -- 'pending','in_progress','completed','skipped'
  assigned_to UUID REFERENCES profiles(id),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,  -- 24h from started_at
  notified_24h BOOLEAN DEFAULT false,
  notified_48h BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (lead_id, stage_key)
);
```

**API 新增**:
- `POST /api/workflow/start-stage` — 开始阶段（自动计算 deadline）
- `POST /api/workflow/complete-stage` — 完成阶段
- `POST /api/cos/download-url` — 生成 COS 预签名下载 URL
- `GET /api/dashboard/top-actions` — 获取当前用户 top 5 待办

**Cron 任务**:
- 每 1h 检测超时工作流 → 发送通知（24h/48h两级）

**数据流不变**:
```
TG 图纸需求 → Hermes KNX 链 → COS 存储 → CRM auto-sync → 报价页展示
                                                          → 下载按钮(COS pre-signed URL)
```

### 2.3 Design Director 分析

**品牌体系（已确立，不动）**:
- Primary: 铜色 `#D4A373`（仅用于重点元素）
- Neutral: 80% 灰阶体系（gray-800/900 底，gray-300/400/500 文字）
- Success: 翠绿 `#22C55E`
- Warning: 琥珀 `#F59E0B`  
- Danger: 玫瑰 `#EF4444`
- 单视觉焦点原则：每页只有一个突出的铜色元素

**报价 L1 改造方向**（参考 lovable.app）:
- 当前：简单表格，信息密度低
- 目标：rich table — 报价编号 | 客户 | 项目类型 | 总金额 | 状态视觉 | 有效期 | 操作
- 状态用 pill + 颜色（不用文字标签列）
- 搜索改为 real-time filter

**报价 L2 改造方向**:
- Summary bar 顶行：Subtotal → Discount → Services → Tax → **Total**（铜色突出）
- Line Items 按 category 折叠分组（参考 lovable 的 collapsible sections）
- 两个下载按钮：📥 Quote XLS / 📊 Design PPT（仅当 COS 文件存在时显示）

**工作流 UI**:
- 水平 5 步进度条（类似 Shopify 订单追踪）
- 每步有：阶段名 | 负责人 | 截止时间 | 状态指示
- 超过 deadline 红色闪烁 + 通知标志
- 点击展开该阶段的详细操作面板

### 2.4 UX Director 分析

**当前痛点**:
1. 销售打开报价页 → 只能看到列表 → 不知道下一步做什么
2. Lead 详情页 trace timeline 是只读的 → 没有 "现在该做什么" 引导
3. 驾驶舱 L4 太简略 → "一行摘要" 失去了 actionable 信息

**解决方案**:
1. **报价页增加 "New Quote" 主 CTA**（铜色按钮，首屏可见）→ 已部分完成（对话框模式）
2. **报价 L2 增加快速操作**：Send to Client / Mark Accepted / Create Contract → 状态流转一键
3. **Lead 详情内嵌工作流进度条**（替换静态 trace timeline 为 actionable workflow）
4. **驾驶舱 Top 5 Actions**：混合 overdue tasks + uncontacted leads + pending quotes

---

## 📋 三、实施计划

### Phase 1: 报价 L1 重构（4h）

| 文件 | 改动 |
|------|------|
| `quotes-client.tsx` | 重写表格为 rich table（lovable 风格） |
| 新增 `quote-detail-dialog.tsx` | L2 详情弹窗（Summary bar + Line Items + COS 下载） |

**L1 表格列**:
```
Quote No | Customer | Project Type | Total (AED) | Status | Valid Until | Actions
```

**L2 Detail Dialog**:
```
┌─ Summary Bar ───────────────────────────────────────┐
│  Subtotal   Discount   Services   Tax   TOTAL (AED)  │
│  280,000    -14,000    +42,000    +15,400  ║323,400  │
└─────────────────────────────────────────────────────┘
┌─ Line Items (by category, collapsible) ─────────────┐
│ ▼ KNX Infrastructure (4 items) ......... AED 8,000   │
│   - KNX IP Router ×2 ......... 2,800 ×2 = 5,600     │
│   - KNX PSU 640mA ×1 ......... 1,200 ×1 = 1,200     │
│ ▶ Lighting Control (6 items) ......... AED 52,000    │
│ ▶ Shading Control (3 items) .......... AED 18,000    │
└─────────────────────────────────────────────────────┘
┌─ Documents ─────────────────────────────────────────┐
│  [📥 Download Quote XLS]  [📊 Download Design PPT]   │
└─────────────────────────────────────────────────────┘
```

### Phase 2: 工作流管理（6h）

| 步骤 | 内容 |
|------|------|
| 2.1 | 创建 `lead_workflow_stages` 表（migration） |
| 2.2 | 创建 API：start-stage / complete-stage |
| 2.3 | `lead-workflow.tsx` 组件（5 步进度条，内嵌 Lead 详情） |
| 2.4 | Cron 任务：超时检测 + 通知触发 |
| 2.5 | 通知机制：Hermes → TG/WeChat 推送给销售 + Tanya |

**5 阶段定义**:
```
阶段 1: 需求确认 (Requirement)     → 24h deadline, 权重 20%
阶段 2: 方案设计 (Design)          → 48h deadline, 权重 30%  
阶段 3: 报价输出 (Quotation)        → 24h deadline, 权重 50%
阶段 4: 商务谈判 (Negotiation)      → 48h deadline, 权重 60%
阶段 5: 合同交付 (Handover)         → 72h deadline, 权重 80%
```

**UI 内嵌位置**: Lead 详情页，替换现有静态 trace timeline 为交互式 workflow progress

### Phase 3: COS 下载集成（2h）

| 步骤 | 内容 |
|------|------|
| 3.1 | 创建 `/api/cos/download-url` — 返回预签名 URL |
| 3.2 | 报价 L2 Dialog 增加下载按钮 |
| 3.3 | Quotations 表 `pdf_url`/`ppt_url` 字段 → COS key 映射 |

### Phase 4: Top 5 Actions（1h）

驾驶舱新增一个卡片，从多个数据源聚合：
- Overdue workflow stages (按 deadline 排序)
- Leads with no activity in 48h
- Pending quotes (draft → need action)
- Upcoming payment due dates

### Phase 5: 视觉一致性（2h）

全站审查 + 统一：
- 所有 Card 背景色统一为 `bg-gray-900/60`
- 所有 Border 统一为 `border-gray-700/50`
- 状态 Badge 统一为 4 色体系
- 铜色仅在 CTA、重点数据使用
- 按钮层级：Primary(铜) / Secondary(灰) / Ghost(透明)

---

## 🎯 四、验收标准

| 模块 | 验收项 |
|------|--------|
| 报价 L1 | 表格显示报价编号/客户/项目类型/总金额/状态/有效期，搜索即时过滤 |
| 报价 L2 | Summary bar 正确计算，Line Items 按 category 分组可折叠，COS 下载按钮可用 |
| 工作流 | 5 步可推进，deadline 倒计时显示，24h/48h 超时触发通知 |
| COS 下载 | 预签名 URL 生成正确，浏览器下载成功 |
| Top 5 | 显示混合来源的 5 个最高优先级待办，可点击跳转 |
| 视觉 | 全站卡片/按钮/Badge/边框颜色统一到规范 |

---

## 📝 五、技术注意事项

1. **COS SDK**: 使用 `cos-python-sdk-v5` 或直接构造预签名 URL（已有凭证）
2. **通知链路**: Cron → Hermes agent → `send_message(telegram/tanya)` + `send_message(weixin/sam)`
3. **工作流 deadline**: 用 Supabase `pg_cron` 或 Hermes cronjob 每 1h 扫描
4. **L1 表格**: 保持现有 client-side 搜索逻辑，不引入 server-side pagination（数据量小）
5. **所有新增用 migration 文件**，不放 `schema.sql` 直接改
6. **构建后 deploy 前** 必须跑 `npm run build` 确认无 TS 错误

---

*End of Plan. 用户确认后按 Phase 1→5 顺序实施。*
