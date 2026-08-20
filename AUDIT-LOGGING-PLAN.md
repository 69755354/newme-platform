# NewMe CRM 监控审计体系 — 前因后果 + 开发计划

## 一、前因后果

### 1. 事故起点

CRM日报（crm-daily-report.py）每天18:00 Dubai推送到TG群，显示"今日登录人数：0"。但实际有人登录了。

### 2. 排查过程

**第一轮：查代码**
- 报告脚本查 RPC `get_team_activity`，读 `user_session_daily` 表
- `user_session_daily` 的数据来源是 `log_activity()` RPC
- 但 CRM 登录页（`src/app/login/page.tsx`）的登录流程是**裸调 Supabase Auth API**，没有调 `log_activity('login')`
- 所以 `user_session_daily` 一直是空的

**第一次修复**：在登录页加 `log_activity('login')` 调用 + 手动补当天数据给Ayana和SAM

**发现问题**：用户指出"默罕默德也登录了，你漏了"——手动patch不可靠，没去查完整数据源

**第二轮：反省方向**
- 用户问"别人都是怎么做的"
- 查行业标准 → 发现PostHog已经配好了但没用起来
- 查自有代码 → 发现 `proxy.ts` 中间件本来就在试图记页面访问，但表名写错了

**关键bug**：`src/proxy.ts` 第59行写 `audit_log`（少个s）：
```typescript
supabase.from("audit_log").insert({
    user_id: user.id,       // 列名不对，实际叫 actor_id
    event_type: "PAGE_VISIT",  // 列名不对，实际叫 action
    metadata: { page: pathname },  // 列名不对，实际叫 details
    ip_address: clientIp,
})
```
表不存在 + 列名不对 → 后台每天静默刷"Audit log error"，但数据一条没记进去。

同期 `audit_logs` 表（正确名字）里反而有 Supabase Auth 自动写入的 USER_SIGN_IN、USER_UPDATED 事件。

### 3. 最终修复

| 问题 | 修法 |
|---|---|
| 登录不记 | `auth.users` 建 DB trigger `on_user_login`，`last_sign_in_at` 变化时自动写 `user_session_daily` |
| proxy.ts 写错表 | `audit_log` → `audit_logs`，修正列名：`actor_id`、`action`、`details` |
| 登录页多余代码 | 移除 `log_activity('login')`（已由trigger替代）、移除未使用的 import |
| PostHog | 其实早就配了（capture_pageview/capture_exceptions/session_recording全开），之前被 audit_log 报错刷屏掩盖。**2026-08-20 已整体移除**——"全开"里就包括未打码的会话回放 |

### 4. 既有基础设施（之前不知道已经存在的）

- ~~**PostHog**：`.env.local` 有 key+host，`PHProvider` 在 root layout，`posthog.identify()` 登录后自动调用~~
  —— **2026-08-20 已不成立**：整套前端集成（provider、web-vitals 采集、分析用的会话身份缓存）已删除，
  key 早已在供应商侧失效。不要再按这一条假设前端有埋点。
- **error-monitor.py**：每15分钟查 Sentry API + journalctl，发现错误发TG DM
- **audit_logs** 表：有正确schema，Supabase Auth 自动在写（USER_SIGN_IN等）
- **activity_logs** 表：有完整 schema（tenant_id, user_id, action, entity_type, entity_id, details, page_path, duration_seconds）

---

## 二、与成熟CRM的差距

### Salesforce / Dynamics 365 的五层监控模型

| 层级 | 内容 | Salesforce | Dynamics 365 | 我们 |
|---|---|---|---|---|
| 1 | 登录追踪 | Login History（免费内置） | Azure AD 登录日志 | ✅ DB trigger |
| 2 | 业务审计（谁改了什么字段） | Field History Tracking（按对象配） | 3级审计（组织→实体→字段） | ❌ 完全没做 |
| 3 | 用户行为（页面访问、导航） | Event Monitoring（付费Shield） | App Insights 自动捕获 | ✅ PostHog / proxy → audit_logs |
| 4 | 性能监控（API延迟、慢查询） | Event Monitoring | App Insights 自动 | ❌ 未建立 |
| 5 | 实时告警 | Real-Time Event Monitoring | App Insights Alert | ⚠️ 15分钟轮询 |

---

## 三、开发计划

### Phase 1：审计日志接入（优先级最高）

目的：用户任何操作（创建/修改/删除客户、合同、报价）自动记入 `activity_logs`，可回溯谁在什么时候改了什么东西。

**方案**：Supabase DB trigger on `leads`/`contracts`/`quotes` 表
- 比代码层拦截更可靠（Salesforce Field History 也是DB级）
- 自动记录：操作类型（INSERT/UPDATE/DELETE）、旧值、新值、操作人、时间

**Trigger 函数设计**：
```sql
CREATE OR REPLACE FUNCTION public.log_entity_change()
RETURNS TRIGGER AS $$
DECLARE
  changes jsonb;
BEGIN
  -- 对 UPDATE：比较 OLD 和 NEW，只记变化的字段
  IF TG_OP = 'UPDATE' THEN
    -- 只记关注的关键字段
    -- （避免记无关字段：update_at、last_modified 等）
    changes := ...;
  END IF;

  INSERT INTO activity_logs (
    tenant_id, user_id, action, entity_type, entity_id,
    details, ip_address
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    COALESCE(NEW.updated_by, NEW.user_id, auth.uid()),
    lower(TG_OP),  -- 'insert' / 'update' / 'delete'
    TG_TABLE_NAME,  -- 表名，如 'leads'
    COALESCE(NEW.id, OLD.id),
    jsonb_build_object(
      'changes', changes,
      'old', row_to_json(OLD),
      'new', row_to_json(NEW)
    ),
    current_setting('request.headers')::json->>'x-forwarded-for'
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**注意事项**（Dynamics 365 经验教训）：
- 不能记所有字段 → `updated_at`、`last_active` 等内部字段会刷爆审计表
- 实体级别、字段级别开关 → 按业务需求配置
- 审计表需要定期归档/清理 → `audit_log_archived` 表（已存在）

### Phase 2：API 性能监控

- 在 Next.js API routes 里埋点，记到 PostHog 自定义事件
- 或接入 Sentry Performance 追踪
- 目的：哪条接口慢、哪个查询超时

### Phase 3：实时告警

- 升级 error-monitor.py 从轮询改为 webhook
- 或用 Supabase Database Webhook + TG bot 直接推送
- 目的：错误出现后秒级通知，不是15分钟

### Phase 4：安全增强

- 登录失败次数检测（连续失败N次后告警）
- 异常IP检测
- 批量导出告警（Salesforce 的"10分钟内导出5千条"规则）

---

## 四、技术债务

- `audit_logs` 表的 `actor_email` 字段一直是 null（insert时不传）
- `activity_logs` 的 `ip_address`、`user_agent`、`session_id` 字段从未填充
- `user_session_daily` 的 `total_duration_seconds` 一直为 0（没有logout事件来算时长）
- 没有 RLS 策略保护审计数据（理论上谁都能查 audit_logs）
