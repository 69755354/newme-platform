# CRM v2 总任务书 — CRM项目总监

> 来源：2026-06-18 全盘调研结果
> 执行方：GLM 5.2 (Coding Plan)
> 监督方：DeepSeek Reasoner (CRM项目总监)
> 验收标准：50轮多方法测试全PASS

---

## 当前状态快照

| 项目 | 状态 |
|------|------|
| 分支 | feat/crm-v2 |
| 提交 | 22caa3a (2026-06-17) |
| 服务 | Next.js 16.2.6, port 3001, 运行中 |
| DB | Supabase, 41 migrations, 已应用 |
| 未提交修改 | 35+ 文件已修改未提交 |
| 运行构建 | 约 2026-06-18 04:49 启动，不含未提交修改 |

---

## 🔴 P0 — 致命问题（必须修复，否则不可交付）

### P0-1. RLS缺失：3张表完全开放
**文件**: 需在 Supabase SQL 编辑器执行或通过迁移文件
**描述**: `contract_approvals`, `payment_allocations`, `marketing_campaigns` 3张表没有启用 Row Level Security。任何认证用户甚至匿名用户可读写。
**修复**:
```sql
ALTER TABLE contract_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_campaigns ENABLE ROW LEVEL SECURITY;
-- 加上匹配现有模式的策略 (admin_all, sales_select, sales_insert, sales_update)
```
**验证**: 用匿名SQL客户端尝试读取这3张表，应被拒绝

---

### P0-2. notifications INSERT 策略对 public 开放
**文件**: Supabase 策略
**描述**: `notifications_service_insert` 策略的 `WITH_CHECK = true` 允许任何人（包括匿名）向任意用户插入通知。攻击者可伪造系统通知。
**修复**:
```sql
DROP POLICY IF EXISTS notifications_service_insert ON notifications;
CREATE POLICY notifications_service_insert ON notifications
  FOR INSERT TO authenticated
  WITH CHECK (true);
```
**验证**: 未登录状态下 POST /api/notifications 应返回 401

---

### P0-3. Meta CAPI Webhook 认证绕过
**文件**: `src/app/api/leads/meta-capi/route.ts`
**描述**: 第26-33行，`if (webhookSecret)` 条件判断，当环境变量未设置时整个认证被跳过。攻击者可无认证注入伪造线索。
**修复**: 去掉条件判断，webhook secret 设为必填，未配置时返回 503

---

### P0-4. stage vs funnel_stage 双列并存
**文件**: 数据库迁移 + `src/app/(dashboard)/leads/` 相关页面
**描述**: leads 表同时有 `stage` (8值原始列) 和 `funnel_stage` (11值新列)。leads page 读的是 `stage` 不是 `funnel_stage`。两套体系造成数据碎片化。
**修复步骤**:
1. 写迁移文件合并 stage → funnel_stage
2. 将 `funnel_stage` 改为 NOT NULL
3. 彻底删除 `stage` 列（先确认前端全部改用 funnel_stage）
4. 更新前端代码所有 `stage` 引用为 `funnel_stage`
5. 更新 CHECK 约束（当前约束不含 `fake` 和 `no_answered`？检查最新迁移）

---

### P0-5. 35+ 文件已修改未部署
**描述**: `git status` 显示大量未提交修改（路由、组件、API、迁移）。当前运行的服务是旧构建，未包含这些修改。
**修复**:
1. 验证所有修改是否有冲突/依赖
2. `git add -A && git commit -m "fix: batch deploy $(date +%Y%m%d)"`
3. `npm run build` 确保通过
4. `sudo systemctl restart newme-platform.service`
5. 验证新进程启动时间晚于构建时间

---

### P0-6. Git 构建状态问题
**描述**: `.next/BUILD_ID` 文件缺失，上次 `npm run build` 被中断。当前服务可能是从 `.next.bak/` 目录跑的老构建。
**修复**: 完成所有代码修改后执行完整构建

---

### P0-7. i18n P0 Key 缺失 (13处)
**文件**: `src/lib/i18n/translations.ts`
**描述**: 以下翻译 key 代码中使用但翻译文件中未定义，用户直接看到 key 名：
- `common.loadFailed` (4处: AdsROI, PaymentTracker, PipelineFunnel, WeeklyTrends)
- `leads.nextActionRequired` (leads/page.tsx:951)
- `leads.addNote` (leads/page.tsx:975)
- `leads.createFailed` (QuickCreateLeadDialog.tsx:80)
- `leads.region` (QuickCreateLeadDialog.tsx:166)
- `leads.notesPlaceholder` (QuickCreateLeadDialog.tsx:179)
- `quotes.calc.area` → 应为 `quotes.calc.areaSqm` (2处)
- `quotes.calc.property` → 应为 `quotes.calc.propertyType` (2处)
- `leads.title` 误用 `pipeline.title` (leads/page.tsx:261)

---

## 🟡 P1 — 高优先级（MVP 必须包含）

### P1-1. 无 URL 路由守卫中间件
**文件**: 新增 `src/middleware.ts`
**描述**: 9个页面无硬路由守卫，销售可直接访问 `/analytics`, `/ads`, `/team`, `/settings` 等页面（虽然有角色判断但页面本身可渲染）。
**修复**: 用 Supabase SSR 中间件实现路由守卫，匹配权限矩阵

---

### P1-2. Lead 详情页无法编辑基本信息
**文件**: `src/app/(dashboard)/leads/[id]/page.tsx`
**描述**: 客户名称、电话、邮箱、物业类型等基本字段为只读，无法编辑。

---

### P1-3. Kanban 无分页
**文件**: `src/app/(dashboard)/leads/page.tsx`
**描述**: 仅 limit 200，无游标分页。数据量超过500时前端性能退化。

---

### P1-4. 无收入预测
**文件**: `src/app/(dashboard)/dashboard/page.tsx`
**描述**: Dashboard 无月度/季度收入预测。老板核心需求："这个月能签多少？"

---

### P1-5. 无团队绩效视图
**文件**: `src/app/(dashboard)/analytics/`
**描述**: 无按销售的签约额/回款额/回款率排名，无法识别风险销售。

---

### P1-6. Dashboard 无趋势图表
**文件**: `src/app/(dashboard)/dashboard/page.tsx`
**描述**: 全是静态快照，无时间趋势线、无每周新增趋势、无可视化改善。

---

### P1-7. activities 表可能仍为空
**文件**: Supabase + 前端时间轴
**描述**: 需要检查 `activities` 表是否有数据。如果为空，时间轴功能无法工作。
**修复**: 现有数据缺乏活动记录无法回填，但新操作必须写入

---

### P1-8. 合同流程自动化缺失
**文件**: Won Lead → 创建合同流程
**描述**: Lead 标为 Won 后无自动创建合同、无付款计划创建流程。合同模块有基础 API 但 UI 流程不全。

---

### P1-9. CRM首页登录后重定向问题
**文件**: `src/app/login/page.tsx`
**描述**: 登录后使用 `router.push()` 重定向，无服务器端验证，可能在某些场景下失效（曾修复过cookie编码问题）

---

## 🟠 P2 — 中优先级（可交付前修复）

### P2-1. 老 audit 报告中的 P1 项待验证
- Product audit: 品牌红色号 `#E5007E` 在CRM中用为主色（用户判断"花里胡哨"）
- 流失率标签显示为"留存率"（dashboard page 标签混淆）
- pipeline page 存在但无侧边栏链接

### P2-2. ~270 冗余 i18n key 未清理
**文件**: `src/lib/i18n/translations.ts`
**描述**: 定义了但未被任何代码引用的翻译 key，增加维护成本

### P2-3. 15 处硬编码文本应走 i18n
**文件**: 多处页面
**描述**: 非翻译化的硬编码中/英文

### P2-4. 无测试覆盖
**描述**: 除 `test-matrix.md` 描述性文档外，无自动化测试（单元/E2E）

### P2-5. 游戏页面残留
**文件**: `src/app/(dashboard)/games/`
**描述**: CRM 中存在掼蛋游戏页面，产品交付前应移除或隐藏

---

## 执行顺序（GLM 5.2）

### Batch 1: 安全底线
1. P0-1: 3张表启用RLS + 添加策略
2. P0-2: notifications 修复
3. P0-3: Meta CAPI webhook 修复
4. P1-1: 添加路由守卫 middleware

### Batch 2: 数据修复
5. P0-4: 合并 stage/funnel_stage 系统
6. P0-7: 修复13处 i18n P0 key
7. P1-2: Lead详情页字段可编辑

### Batch 3: 功能补齐
8. P1-4: Dashboard 收入预测
9. P1-5: 团队绩效视图
10. P1-6: 趋势图表
11. P1-8: 合同流程自动化

### Batch 4: 部署与交付
12. P0-5 + P0-6: 提交代码、构建、部署
13. P1-3: 分页
14. P2: 低优先级修复

---

## 验收标准（50轮测试）

每轮测试覆盖以下维度。GLM 5.2 执行测试，每次报告 PASS/FAIL。

### 测试类别（每类10轮，共50轮）

**A. 安全检查（10轮）**
- 匿名用户访问各页面 → 重定向到登录
- sales 用户访问 admin 页面 → 403 或重定向
- 未登录 API 调用 → 401
- RLS 数据隔离：sales 看不到其他销售的 lead
- notifications 不可被匿名插入
- 3张表 RLS 生效
- Webhook 无 secret 时拒绝请求
- XSS 注入测试（lead name字段）
- SQL注入尝试
- Cookie 安全属性检查

**B. 功能测试（10轮）**
- 登录流程：正确/错误密码
- Lead CRUD：创建/编辑/删除/查看
- 阶段流转：每个阶段前进/限制后退/不允许跳过
- Won/Lost 终态行为
- 搜索/筛选/排序
- 批量操作
- 合同创建流程
- 报价创建流程
- Dashboard 指标计算准确性
- i18n 切换所有文字更新

**C. 数据完整性（10轮）**
- lead 创建后字段完整性检查
- stage 变更后相关字段自动更新
- 活动日志记录
- 通知生成
- dashboard 聚合计算
- 金额计算（AED 格式）
- 日期/时间处理
- 数据库约束验证
- 外键关系一致性
- 级联操作正确性

**D. 用户体验（10轮）**
- 页面加载时间 < 3秒
- 表单验证提示
- 空状态展示
- 错误状态展示
- 加载状态展示
- 移动端适配
- 暗色主题一致性
- 按钮/链接可点击区域
- 后退按钮行为
- 浏览器刷新后状态保持

**E. 边界与异常（10轮）**
- 空数据页面
- 超长输入（1000+字符）
- 特殊字符输入（emoji, HTML标签, SQL语法）
- 并发操作（两个用户同时编辑同一条 lead）
- 网络断开重连
- 快速重复点击
- 浏览器回退后重新提交
- 多语言混合输入
- 日期/时间边界值
- 大量数据（1000+ leads）性能

### 通过标准
- 每轮测试: 全部 PASS 无 FAIL
- 任何 FAIL → 记录具体复现步骤 → 修复 → 该轮重跑
- 50轮全部 PASS → 可交付
