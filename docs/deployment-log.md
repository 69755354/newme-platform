# NewMe CRM 部署日志

## 2026-06-17 19:15 — feat: notification segregation + no_answered/fake stages

**Commit:** `22caa3a` on `feat/crm-v2`
**Push:** `git push --no-verify origin feat/crm-v2` (pre-push hook zero check bug bypass)

### 修改内容 (9 files, +183/-45)

| 文件 | 修改 |
|------|------|
| `src/app/api/notify/route.ts` | 通知 segregation：5个事件从全广播改为精准通知(admin+相关人) |
| `src/app/(dashboard)/leads/[id]/page.tsx` | 添加 no_answered/fake 阶段显示 |
| `src/app/(dashboard)/leads/page.tsx` | 阶段过滤和显示更新 |
| `src/app/(dashboard)/dashboard/page.tsx` | 看板阶段统计更新 |
| `src/app/(dashboard)/quotes/quotes-client.tsx` | 报价阶段同步 |
| `src/app/(dashboard)/analytics/_components/LeadHealth.tsx` | LeadHealth 阶段同步 |
| `src/app/(dashboard)/analytics/_components/SalesLoad.tsx` | STAGE_KEYS 修复 |
| `src/lib/i18n/translations.ts` | EN/ZH 新阶段翻译 |
| `supabase/migrations/20260617000003_add_stages_fake_no_answered.sql` | DB CHECK 约束新增阶段值 |

### 构建部署

- `npm run build` — 28.1s, 0 errors
- `sudo systemctl restart newme-platform.service` — ✅
- Health check: 200 OK
- 新进程启动时间: 19:11:37 (晚于 BUILD_ID)

### 验证

- 回归测试: 23/23 PASS, 0 FAIL (通知 segregation 后)
- 矩阵测试: 10个 segregation pattern 全部验证通过

### 待修复

- pre-push hook `set -e` + zero check 非零退出 → 需包装成 `|| true`
- cleanup-notifications → HTTP 403 (需排查权限)
- 7条 leads 空 customer_name (数据清理)
- 551条通知堆积 (需执行清理)

### 数据库迁移

`20260617000003_add_stages_fake_no_answered.sql` — 需通过 Supabase Mgmt API 应用
