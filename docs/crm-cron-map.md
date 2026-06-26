# CRM Cron Map

> 最后更新: 2026-06-27 | Sales Rollout GO

| # | 名称 | 频次 | 输出到 | 成功发TG | 失败发TG | Dedup | 脚本 |
|---|------|------|--------|:--:|:--:|:--:|------|
| 1 | CRM预警检查 | 每小时 (Dubai 9AM) | TG 情报群 | ✅ | — | 7d | crm-hourly-watchdog.py |
| 2 | CRM Daily Regression | 每日 10:00+22:00 | TG 情报群 | ✅ | ✅ | — | crm-regression.py |
| 3 | CRM Data Auto-Maintenance | 每日 8:00 | TG 情报群 | ✅ | ✅ | — | crm-data-maintenance.py |
| 4 | CRM Daily Ops Report 🆕 | 每日 14:00 UTC (18:00 Dubai) | CRM PROJECT 群 | ✅ | — | — | crm-daily-ops-report.py |
| 5 | CRM每日活动报告 | 每日 14:00 UTC | TG 情报群 | ✅ | — | — | (LLM agent) |
| 6 | CRM日间健康推送 | 每日 16:00+22:00 | TG 情报群 | ✅ | — | — | crm-dubai-health-announce.py |
| 7 | CRM每日提醒 | 每日 13:02 | local | ❌ | — | — | crm-daily-reminders.py |
| 8 | newme-health-check | 每15分钟 | 微信+TG 情报群 | ✅ | — | — | health-check.py |
| 9 | newme-error-monitor | 每15分钟 | 微信+TG 情报群 | ✅ | — | — | error-monitor.py |
| 10 | L2 部署回滚守卫 | 每30分钟 | local | ❌ | — | — | rollback-guard.py |

## 重叠识别

| 重叠对 | 说明 | 建议 |
|--------|------|------|
| #4 + #5 | 两个日报都输出到 TG (不同群) | ✅ 不冲突，目标群不同 |
| #5 + #6 | 活动报告 + 健康推送 时间接近 | ⚠️ 可观察是否内容重叠 |
| #1 + #9 | 预警检查 + 错误监控 都看错误 | ⚠️ 口径不同，暂不合并 |
| #2 + #3 + #6 | 回归+维护+健康 都在 8:00-10:00 | ⚠️ 早上信息密度高 |

**当前不合并，先观察首日运行。**
