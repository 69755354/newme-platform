# CRM 上线回滚预案 / Runbook

> 最后更新: 2026-06-26 | 适用版本: v3.1+ | 维护人: Hermes

---

## 1. 全站 500 — 回滚上一版本

```bash
# 症状: curl http://localhost:3001/api/health → 500 或 502
#      所有页面白屏/500

# Step 1: 确认问题范围
journalctl -u newme-platform.service --since "5 min ago" --no-pager | tail -30

# Step 2: 回滚到上一个正常版本
cd ~/newme-platform
LAST_GOOD=$(git log --oneline -20 | grep -v 'UNSAFE\|WIP' | head -2 | tail -1 | awk '{print $1}')
git stash                     # 保存未提交改动
git checkout $LAST_GOOD       # 切换到上一个正常提交

# Step 3: 重建 + 重启
rm -rf .next && npm run build && sudo systemctl restart newme-platform.service

# Step 4: 验证
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health
# 期望: 200

# Step 5: 回切到 main 准备修复
git checkout main && git stash pop
```

---

## 2. 登录失败 — 查 auth/session

```bash
# 症状: 用户无法登录，返回 400/401/「登录失败」

# Step 1: 查 Supabase Auth 状态
curl -s https://vfopmpxlhwzpxqegayew.supabase.co/auth/v1/health

# Step 2: 查用户 session
# 用 service_role key 查 auth.users
curl -s "https://vfopmpxlhwzpxqegayew.supabase.co/auth/v1/admin/users?limit=5" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq '.users[].email'

# Step 3: 查中间件 proxy auth
journalctl -u newme-platform.service --since "30 min ago" --no-pager \
  | grep -i 'proxy auth\|auth check\|cookie\|session'

# Step 4: 常见原因
# - Cookie chunking (token 过大,分块读取失败): 清浏览器 cookie + 重新登录
# - Token 过期 (>1h): 用户登出重新登录
# - proxy.ts JWT 解析失败: 检查 journalctl "Proxy auth check error"
# - Supabase Auth 服务宕机: 检查 Supabase Status Dashboard
```

---

## 3. 保存失败 — 查哪个 log

```bash
# 症状: 用户点击保存显示「Save failed」无详细信息

# Step 1: 查 journald 实时日志
journalctl -u newme-platform.service --since "5 min ago" --no-pager \
  | grep -iE 'save|error|constraint|violation|400|403|500'

# Step 2: 查 DB trigger 错误
# 用 Management API 查最近的 trigger error
# 常见: lost_reason columns missing, contracts.approval_status missing

# Step 3: 查 RLS policy 问题
# 用用户 token 测试 (非 service_role)
# 如果 service_role 可以但用户不行 → RLS policy 问题

# Step 4: 常见根因
# - DB CHECK constraint violation (UI enum ≠ DB constraint)
# - Trigger phantom column (引用不存在的列)
# - RLS policy 拒绝 (auth.jwt() role 不匹配)
# - 必填字段为空 (如 next_action)

# Step 5: 恢复 — 如果不是代码问题，先修数据
# 不要直接改代码——先定位是哪一层拦的
```

---

## 4. 合同重复 / 数据污染 — 定位 affected rows

```bash
# 症状: 同一 lead 有多个 contract / 重复 lead / 数据异常

# Step 1: 查重复合同
python3 -c "
import urllib.request, json
URL='https://vfopmpxlhwzpxqegayew.supabase.co'
# ... (use crm-daily-ops-report.py pattern)
# SELECT lead_id, COUNT(*) FROM contracts GROUP BY lead_id HAVING COUNT(*) > 1
"

# Step 2: 验证 DB unique index
# contracts 表应该有: idx_contracts_one_active_per_lead
# WHERE status NOT IN ('archived','cancelled','terminated')

# Step 3: 如果有重复
# - 确认哪个是有效的 (check created_at, status)
# - 手动归档/删除重复的 (用 PostgREST DELETE)
# - DELETE /rest/v1/contracts?id=eq.{duplicate_id}
```

---

## 5. 告警刷屏 — 暂停 cron

```bash
# 症状: Telegram 群被 cron job 消息刷屏

# Step 1: 列出所有 cron jobs
# (在 TG 中对 bot 说: "列出所有 cron jobs")
# 或者查看: ~/.hermes/logs/cron/

# Step 2: 暂停问题 job
# (在 TG 中对 bot 说: "暂停 cron job <job_id>")

# Step 3: 排查刷屏原因
# 通常原因:
# - 通知 dedup 失效 → 每小时重复发送
# - 数据变更触发大量告警
# - cron script bug → 循环发送

# Step 4: 恢复 — 修好脚本后 resume
```

---

## 快速诊断命令速查

| 场景 | 命令 |
|------|------|
| 服务是否在跑 | `systemctl status newme-platform.service` |
| Health check | `curl -s http://localhost:3001/api/health` |
| 最近错误 | `journalctl -u newme-platform.service --since "10 min ago" -q --no-pager \| grep -i error` |
| DB 是否可达 | `curl -s "https://vfopmpxlhwzpxqegayew.supabase.co/rest/v1/" -H "apikey: $ANON_KEY"` |
| Sentry 新错误 | `curl -s "https://sentry.io/api/0/organizations/newme-o4/issues/?query=is:unresolved&statsPeriod=1h" -H "Authorization: Bearer $SENTRY_AUTH_TOKEN"` |
| 重启服务 | `sudo systemctl restart newme-platform.service` |

---

## 升级联系人

- Tanya (boss) — TG CRM PROJECT 群
- Hermes (AI ops) — TG @newwme_1_bot
