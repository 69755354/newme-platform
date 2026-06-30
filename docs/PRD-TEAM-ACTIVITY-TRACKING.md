# PRD: 团队活动追踪 (Team Activity Tracking)

> 目标：CEO能看到每个员工每天在CRM里干了什么、停留了多久。
> 不是产品分析工具，是管理工具。4-6人团队规模。

---

## 1. 现状问题

### 1.1 Bug：user_id 全是 null
`business_events` 和 `activities` 表已有字段 `user_id`，但所有 INSERT 都没传值。

**涉及文件（已验证）：**
- `src/app/(dashboard)/leads/[id]/page.tsx` — stage变更、转移、加note时 INSERT activities/business_events 不带 user_id
- `src/app/(dashboard)/leads/page.tsx` — 批量操作
- `src/app/(dashboard)/leads/new/page.tsx` — 新建lead
- `src/app/api/activities/route.ts` — API层
- `src/app/api/hermes/generate-quote/route.ts` — 报价生成
- `src/app/api/quotations/generate/route.ts` — 报价生成
- `src/components/QuickCreateLeadDialog.tsx` — 快捷新建

**修复方式：** 在所有 INSERT 处加 `user_id: (await supabase.auth.getUser()).data.user?.id`

### 1.2 缺失：无会话时长追踪
Auth 层只记录 `last_sign_in_at`，无法知道用户在线多久、看了哪些页面。

---

## 2. 要追踪什么

| 维度 | 数据 | 来源 |
|------|------|------|
| 登录/登出 | 时间戳 | Auth 已有 + 补登出事件 |
| 在线时长 | 分钟级 | 新建 user_sessions 表 + heartbeat |
| 页面访问 | 哪个页面、停留多久 | 新建 page_views 表 |
| 业务操作 | stage变更、加note、转派、报价等 | **修现有 bug**，不是新建 |

## 3. 不追踪什么（红线）

- ❌ 不录屏、不截屏
- ❌ 不记录按键内容（只记录"在哪个页面"）
- ❌ 不追踪非工作时间
- ❌ 不上报到第三方
- ❌ 不存储 IP 地址（避免隐私问题）

---

## 4. 数据库 Schema

### 4.1 新建 `user_sessions` 表

```sql
CREATE TABLE user_sessions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  login_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  logout_at   TIMESTAMPTZ,            -- NULL = 仍在进行
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_min INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (COALESCE(logout_at, last_heartbeat_at) - login_at)) / 60
  ) STORED,
  user_agent  TEXT                     -- 仅存浏览器类型，不存完整UA
);

-- RLS: boss/admin 可看全部，sales 只看自己
CREATE POLICY "boss_admin_see_all" ON user_sessions FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss','admin')));
CREATE POLICY "sales_see_own" ON user_sessions FOR SELECT
  USING (user_id = auth.uid());

-- 索引
CREATE INDEX idx_sessions_user_date ON user_sessions (user_id, login_at DESC);
```

### 4.2 新建 `page_views` 表

```sql
CREATE TABLE page_views (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES user_sessions(id) ON DELETE SET NULL,
  path        TEXT NOT NULL,            -- e.g. "/leads/xxx", "/dashboard"
  entered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ,              -- NULL = 仍在看
  duration_sec INTEGER GENERATED ALWAYS AS (
    EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - entered_at))::INTEGER
  ) STORED
);

-- RLS: 同 user_sessions
CREATE POLICY "boss_admin_see_all_pv" ON page_views FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('boss','admin')));
CREATE POLICY "sales_see_own_pv" ON page_views FOR SELECT
  USING (user_id = auth.uid());

CREATE INDEX idx_pv_user_date ON page_views (user_id, entered_at DESC);
```

### 4.3 数据量估算

4-6人 × 每天 100次页面切换 × 30天 = ~18,000行/月。Supabase 免费额度 500MB 绰绰有余（每行 ~200B，月增 ~3.6MB）。

---

## 5. 前端实现方案

### 5.1 ActivityTracker 组件（全局挂载）

位置：`src/components/ActivityTracker.tsx`（client component）

在 `layout.tsx` 的 `{children}` 外层包一个 `<ActivityTracker />`。

**行为：**

```
登录时:
  → POST /api/activity/session  { action: "login" }
  → 返回 session_id
  → 存入 sessionStorage

路由切换时:
  → PATCH 上一条 page_view (设 left_at)
  → POST /api/activity/page-view { path, session_id }

每60秒:
  → POST /api/activity/heartbeat { session_id }
  → 更新 user_sessions.last_heartbeat_at

visibilitychange (切Tab/最小化):
  → hidden: 暂停 heartbeat，PATCH 当前 page_view 的 left_at
  → visible: 恢复 heartbeat，POST 新 page_view

beforeunload (关Tab/关浏览器):
  → navigator.sendBeacon() 发最终 heartbeat + 关闭 session
  → 不依赖 fetch（页面卸载时 fetch 会被取消）
```

### 5.2 API Routes

| 路由 | 方法 | 用途 |
|------|------|------|
| `/api/activity/session` | POST | 创建/关闭 session |
| `/api/activity/heartbeat` | POST | 更新 last_heartbeat_at |
| `/api/activity/page-view` | POST/PATCH | 记录/关闭页面访问 |
| `/api/activity/daily-report` | GET | CEO 查看某天全员活动汇总 |

所有 API 都从 cookie 读 user_id（复用现有 `verifyUser` 逻辑），不依赖前端传 user_id。

### 5.3 对现有代码的侵入

**改动清单：**

| 文件 | 改动 | 风险 |
|------|------|------|
| `src/app/layout.tsx` | import ActivityTracker，包在 children 外层 | 极低，纯加层 |
| `src/app/(dashboard)/leads/[id]/page.tsx` | 所有 `.insert({...})` 补 `user_id` | 低，只加字段 |
| `src/app/(dashboard)/leads/page.tsx` | 同上 | 低 |
| `src/app/(dashboard)/leads/new/page.tsx` | 同上 | 低 |
| `src/components/QuickCreateLeadDialog.tsx` | 同上 | 低 |
| `src/app/api/hermes/generate-quote/route.ts` | 同上 | 低 |
| `src/app/api/quotations/generate/route.ts` | 同上 | 低 |

**不动的文件：** 不改任何现有组件的 UI 逻辑、不改路由结构、不改 RLS 策略。

---

## 6. CEO 查看界面

### 6.1 位置
Team 页面 (`/team`) 新增一个 Tab："活动日志"

### 6.2 布局

```
┌─────────────────────────────────────────┐
│ 日期选择器: [Jun 11, 2026]              │
├─────────────────────────────────────────┤
│ 👤 Tanya (CEO)    在线 2h 15m           │
│ 09:30 登录                             │
│ 09:30-09:45 Dashboard (15m)             │
│ 09:45-10:20 Leads 列表 (35m)           │
│ 10:20-10:25 Lead #xxx 详情 (5m)        │
│   → Stage: new → contacted             │
│   → 加了note: "客户要求降价"            │
│ 10:25-11:45 Pipeline (1h20m)           │
│ 11:45 登出                             │
├─────────────────────────────────────────┤
│ 👤 Mohamed (Sales)  在线 45m            │
│ 14:00 登录                             │
│ ...                                    │
└─────────────────────────────────────────┘
```

### 6.3 权限
- boss / admin：看全员
- sales：只看自己
- operator：不可见此Tab

---

## 7. 实施顺序

| 阶段 | 内容 | 预计时间 |
|------|------|---------|
| P0 | 修 user_id null bug（现有7个文件） | 30min |
| P1 | 建2张表 + 4个API route | 1h |
| P2 | ActivityTracker 组件 + 挂载 | 1h |
| P3 | CEO 活动日志 Tab | 1.5h |
| P4 | 测试 + 验收 | 30min |

**总计：~4.5h**

---

## 8. 已知限制

1. **heartbeat 精度 60s** — 用户关浏览器不点登出时，session 结束时间有最多 1 分钟误差。对管理场景足够。
2. **不追踪 iframe / 外部跳转** — 用户跳出 CRM 域名后无法追踪。
3. **移动端浏览器限制** — iOS Safari 后台超过 30s 会冻结 JS，heartbeat 可能中断。移动端只记录前台时间。
4. **历史数据不可回溯** — 只有上线后的操作才有记录，之前的数据永远缺 user_id。

---

## 9. 验收标准

- [ ] Tanya 登录 → 做了 3 个操作 → 登出 → CEO 活动日志显示完整操作列表
- [ ] Faheem 切Tab 5 分钟后回来 → 在线时长不含离开的时间
- [ ] Mohamed 关浏览器直接走 → session 在 1 分钟内自动结束
- [ ] 所有新 INSERT 的 activities 和 business_events 都有 user_id
- [ ] Operator 角色看不到活动日志 Tab
