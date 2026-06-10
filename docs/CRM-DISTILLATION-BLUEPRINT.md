# CRM Distillation Blueprint — 从 NewMe CRM 提炼通用架构

> **目的**: 基于 NewMe 智能家居 CRM (2026-06 完整版) 的实战经验，提炼出可复用于 **地产中介 CRM** 和 **零售 CRM** 的架构骨架。
> 所有坑、设计决策、数据模型均来自真实生产事故和迭代，不是理论推导。

---

## 一、技术栈选择（已验证）

| 层 | 选型 | 为什么 |
|---|---|---|
| 前端 | Next.js 15 (App Router) + TailwindCSS + shadcn/ui | SSR + CSR 混合，权限控制灵活 |
| 后端 | Next.js API Routes + Supabase (PostgreSQL 15) | 零运维数据库 + 实时订阅 + RLS 内置权限 |
| 认证 | Supabase Auth (JWT + cookie session) | 免搭建认证服务 |
| i18n | 自建 LanguageContext + translations.ts 单文件 | 轻量、可审计、无第三方依赖 |
| 部署 | systemd + nginx + Let's Encrypt | 单机足够，不需要 K8s |

**不选什么**：
- ❌ Prisma — Supabase client 直接用 REST/GraphQL 更轻
- ❌ Redux/Zustand — React state + URL params 足够
- ❌ 微前端 — CRM 不是淘宝，单体够了

---

## 二、核心数据模型（5 层管线）

```
Layer 1: Leads (线索/潜在客户)
Layer 2: Quotations (报价/方案)
Layer 3: Contracts (合同/签约)
Layer 4: Projects (交付/项目执行)
Layer 5: Payments (回款/分期)

辅助层:
- activities (活动日志 — 所有操作留痕)
- business_events (业务事件 — stage变更/分配/通知)
- products (产品目录 — 报价引用)
- notifications (消息通知)
- profiles (用户档案 — 角色权限)
```

### 跨行业映射

| 智能家居 | 地产中介 | 零售/批发 |
|---------|---------|---------|
| Lead = 业主线索 | Lead = 购房/租房客户 | Lead = 采购意向客户 |
| Quotation = 智能家居方案报价 | Quotation = 房源推荐+佣金方案 | Quotation = 批量采购报价 |
| Contract = 施工合同 | Contract = 佣金协议/委托合同 | Contract = 采购合同 |
| Project = 施工交付 | Project = 带看→成交→过户 | Project = 订单→发货→验收 |
| Payment = 分期回款 | Payment = 佣金结算 | Payment = 货款结算 |
| Products = KNX设备 | Products = 房源 | Products = 商品SKU |

### 必备字段设计规则

1. **所有 INSERT 必须带 user_id** — 否则审计追踪断裂
2. **lead_status（温度）用触发器自动推导，不让销售手填** — 基于 last_contact_date 自动计算 hot/warm/cold/dormant
3. **stage（阶段）手动推进，但需阶段机守卫** — 禁止跳步/回退（除非 admin/boss）
4. **金额字段用 NUMERIC 不用 FLOAT** — 避免精度丢失
5. **created_at / updated_at 必须有 BEFORE UPDATE 触发器** — 否则乐观锁失效

---

## 三、权限模型（2 组设计，已验证）

**核心教训：不要为每个角色设计独立导航。用户明确拒绝 3 角色导航。**

### 2 组模型

```
Management (admin + boss + operator):
  驾驶舱 → 线索管理 → 报价管理 → 合同管理 → 回款管理 → 项目管理 → 销售漏斗 → 团队管理

Sales (sales):
  我的工作台 → 我的线索 → 我的报价 → 我的合同 → 我的回款 → 我的项目 → 我的业绩
  (≤7 项，无分组，无折叠)
```

### RLS 设计清单（每个表都要过）

| 操作 | Sales | Admin/Boss |
|-----|-------|------------|
| SELECT | `assigned_to = current_user` | ALL |
| INSERT | 自己的 + 未分配的 | ALL |
| UPDATE | 自己的（受限字段） | ALL |
| DELETE | ❌ 禁止 | ALL |

**特别注意事项**：
- `activities` / `business_events` / `notifications` 等日志表需要 `INSERT WITH CHECK (true)` — 否则 stage 变更等操作会被 RLS 静默阻断
- `profiles` 表的 RLS 策略禁止直接 `SELECT FROM profiles`（会导致无限递归）— 用 `SECURITY DEFINER` 函数 `get_my_role()` 绕过
- `cmd=ALL` 的宽泛策略会覆盖所有细粒度策略（PostgreSQL OR 语义）— 必须先 DROP ALL 再建细粒度

---

## 四、i18n 系统设计（已踩过所有坑）

### 架构
```typescript
// 单文件翻译表 — 所有 key 在一个对象里
export const translations = {
  en: { leads: { title: "Lead Management", ... } },
  zh: { leads: { title: "线索管理", ... } }
} as const;

// Hook — 单参数 t(path: string)
export function useLanguage() {
  const [lang, setLang] = useState<"en"|"zh">("zh");
  const t = useCallback((key: string) => {
    return getByPath(translations[lang], key) || key;
  }, [lang]);
  return { t, lang, setLang };
}
```

### 致命坑清单（每个都会导致白屏）

1. **变量遮蔽**: `const t = someCalculation` 遮蔽了 `useLanguage()` 的 `t()` → 运行时崩溃
2. **Server Component 不能用 `t()`**: 只有 Client Component (`"use client"`) 能用 hook → 拆 Server+Client 双层架构
3. **`t()` 只接受 1 个参数**: 不支持插值 `{name}` → 用字符串拼接
4. **useCallback/useEffect 缺少 `language` 依赖**: 切语言后不刷新 → 加 `language` 到 deps
5. **key 不对称**: EN 有 ZH 没有或反过来 → 用 `eval()` 提取 leaf keys 做对称校验
6. **子组件没调 `useLanguage()`**: 父组件的 hook 不会流入子组件 → 每个用 `t()` 的组件都要自己调
7. **DB 枚举值没映射**: DB 存 `"call"` 但翻译 key 是 `nextActionCall` → 渲染原文

---

## 五、前端架构模式

### Server + Client 双层（所有交互页面必须）

```typescript
// page.tsx — Server Component (thin wrapper)
export default function QuotesPage() {
  return <QuotesClient />;
}

// quotes-client.tsx — "use client" (所有逻辑)
"use client";
export default function QuotesClient() {
  // 认证、数据获取、交互全部在这里
}
```

### 认证电路断路器

```typescript
// 防止 role 未加载时执行数据查询
const fetchLeads = useCallback(async () => {
  if (salesRole === null || currentUserId === null) return; // 断路器
  let q = supabase.from("leads").select("*");
  if (salesRole === "sales") q = q.eq("assigned_to", currentUserId);
  // ...
}, [supabase, salesRole, currentUserId, t]);
```

### 路由守卫 Hook

```typescript
// useRequireRole — 客户端权限检查
export function useRequireRole(allowedRoles: string[]) {
  // 返回 { loading, blocked }
  // ⚠️ 所有 hooks 必须在 if (loading) return 之前声明
  // ⚠️ allowedRoles 用 useRef 不用 deps（避免无限循环）
  // ⚠️ blocked=true 防止内容闪现
}
```

---

## 六、已验证的 50+ 坑索引

按严重程度排序，编号对应 crm-development skill 中的完整描述：

### P0 — 白屏/数据泄漏
- #34: useCallback 闭包过期 → 权限漂移
- #39: Hooks 在 early return 之后 → React #310 崩溃
- #43: activities 表缺 INSERT RLS → 所有写操作静默失败
- #48: INSERT 缺 user_id → 审计追踪断裂
- #10: RLS 无限递归（profiles 自引用）

### P1 — 功能失效
- #37: 乐观锁是空操作（updated_at 没有触发器）
- #38: 管线零自动化（数据进去不动）
- #28: 逻辑 `&&` 导致 null role 默认为 sales
- #29: 重复 auth useEffect 竞态

### P2 — UX 缺陷
- #41: 导航栏角色闪烁
- #36: i18n 覆盖盲区
- #42: DB 枚举值未映射翻译
- #19: 内部 ID 泄漏到界面
- #49: Headless Chrome 测试工具限制

---

## 七、跨行业适配清单

### 地产中介 CRM 额外需求
- [ ] 房源数据模型（小区/户型/面积/价格/状态）
- [ ] 带看记录表（link lead + property + date + feedback）
- [ ] 佣金计算引擎（成交价 × 佣金比例 × 分成规则）
- [ ] 过户进度跟踪（新 Layer 或 Project 子状态）
- [ ] 房源匹配推荐（lead 需求 vs 房源特征）

### 零售/批发 CRM 额外需求
- [ ] SKU/商品目录表（替代智能家居设备表）
- [ ] 库存关联（报价时查库存）
- [ ] 批量价格梯度（数量折扣、客户等级折扣）
- [ ] 订单物流跟踪（替代 Project 层）
- [ ] 复购周期提醒（基于历史采购频率）

### 通用扩展点（所有行业）
- [ ] Meta/Google Ads 集成 → 线索自动导入
- [ ] WhatsApp/微信消息集成 → 统一沟通记录
- [ ] 文件管理 → 合同/方案 PDF 存储
- [ ] 数据看板 → CEO 驾驶舱
- [ ] 多租户 → SaaS 化（Axon Platform 方向）

---

## 八、开发流程 SOP

### 1. 新 CRM 项目启动
1. 复制 newme-platform 代码库
2. 修改 translations.ts（行业术语）
3. 修改数据模型（跨行业映射表）
4. 修改侧边栏导航（2 组模型）
5. 修改 RLS 策略（按角色清单）
6. 跑 `verify-crm-fields.sh`

### 2. 每次功能开发
1. 加翻译 key → 先 grep 检查重复
2. 写 API route → 确认 user_id + verifyUser
3. 写前端组件 → Server+Client 双层
4. 写 RLS → 先 DROP cmd=ALL 的宽泛策略
5. 跑验证 → curl API + 数据库查询 + 全局 grep

### 3. 交付前检查
- [ ] `grep -rn 'const t =' src/app --include="*.tsx"` — 无变量遮蔽
- [ ] `npx tsc --noEmit` — 0 errors
- [ ] EN/ZH key 对称校验（eval 方法）
- [ ] 所有 INSERT 调用含 user_id
- [ ] activities 表有 INSERT RLS
- [ ] 浏览器切语言跑一遍所有页面
- [ ] Sales 角色数据隔离验证

---

## 九、文件资产清单

| 文件 | 用途 | 位置 |
|------|------|------|
| SKILL.md | 完整 52 条坑 + 代码模式 | ~/.hermes/skills/software-development/crm-development/ |
| references/ | 12 个参考文档（数据模型、i18n、RLS、管线自动化等） | 同上 /references/ |
| 5-layer ERD | 数据模型架构图 | ~/newme-platform/docs/newme-crm-5layer-erd.svg |
| 角色接口图 | 权限模型设计 | ~/newme-platform/docs/newme-crm-role-interfaces.svg |
| 系统架构图 | 全局架构 | ~/newme-platform/docs/newme-crm-architecture.svg |
| 迁移 SQL | v2.2 完整 DDL | ~/newme-platform/supabase/migrations/20260605000000_*.sql |
| 本文档 | 蒸馏蓝图 | ~/newme-platform/docs/CRM-DISTILLATION-BLUEPRINT.md |

---

*Generated: 2026-06-11 | Based on 10 days of NewMe CRM production development*
*Next: Apply to 地产中介 CRM (Axon Broker OS) and 零售 CRM (Axon Retail)*
