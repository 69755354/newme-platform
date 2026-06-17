# NewMe CRM RLS 安全审计（生产库验证版）

> 审计日期: 2026-06-15
> 数据来源: 生产 Supabase `pg_policies` 实查（非迁移文件）
> 验证方法: service_role/anon key 连通性测试 + with_check 逐条核对

## 已修复（本轮）

### P0-1 notifications INSERT 越权
- **漏洞**: `notifications_service_insert` with_check=`true`，任何登录用户能给任何人发通知
- **修复**: with_check → `user_id = auth.uid()`
- **影响**: 阻断跨用户通知注入；service_role 写入不受影响（绕过RLS）

### P0-2 transfer_history INSERT 无归属校验
- **漏洞**: `transfer_sales_insert` 只查 `get_my_role()='sales'`，不验证 lead 归属
- **修复**: with_check → `get_my_role()='sales' AND lead_id IN (SELECT id FROM leads WHERE assigned_to=auth.uid())`

### P0-3 quotations INSERT 无归属校验
- **漏洞**: 同上，sales 可在他人 lead 上创建报价
- **修复**: 同上模式，加 `lead_id IN (...)` 归属校验

### P0-4 quotes INSERT 无归属校验
- **漏洞/修复**: 同 quotations

## 已验证安全（澄清误报）

### profiles 角色提权 — ❌ 不存在
- `profiles_update_self` with_check 完整: `(id=auth.uid()) AND (已是admin/boss OR 新role=当前role)`
- 用户**无法**自改 role 提权，防护健全

### leads 幽灵 policy — ❌ 不存在
- 生产库无 `leads_auth ALL true` / `Allow all inserts` 等 policy
- 误报来源: 迁移文件历史残留被当作生产态

## 待观察（P1，非紧急）

### audit_logs INSERT 过宽
- `with_check: auth.uid() IS NOT NULL` — 任何登录用户可插审计记录
- 风险: 可伪造 actor_id（但应用层 API 路由用 service_role 写入，绕过此 policy）
- 建议: 若确认无客户端审计写入，可收紧；当前不阻塞（服务端写入不受影响）

## 连通性验证（全 PASS）

| 表 | anon读 | service_role读 | 结论 |
|---|---|---|---|
| leads | 0行 | ✅ | RLS拦截正常 |
| customers | 0行 | ✅ | 正常 |
| quotations | 0行 | ✅ | 正常 |
| audit_logs | 0行 | ✅ | 正常 |
| profiles | 0行 | ✅ | 正常 |

全部29表 RLS 已启用 🔒

## audit_log 表迁移（同轮完成）

- `log_auth_event()` 函数已改写 → INSERT 指向 `audit_logs`（复数）
- 101行历史数据迁移至 `audit_logs`（3→104行）
- 单数表归档为 `audit_log_archived_20260615`（可回滚）
- 触发器 `on_auth_event AFTER INSERT OR UPDATE ON auth.users` 正常工作
