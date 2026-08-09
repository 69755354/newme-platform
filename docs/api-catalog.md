# API Catalog

**Total endpoints:** 103

| Method | Path | RBAC (from comments) | Source File |
|--------|------|----------------------|-------------|
| GET | `/api/activities` | — | `src/app/api/activities/route.ts` |
| GET | `/api/activity/daily-report` | admin, boss | `src/app/api/activity/daily-report/route.ts` |
| POST | `/api/admin/impersonate` | — | `src/app/api/admin/impersonate/route.ts` |
| GET | `/api/ads/leads` | — | `src/app/api/ads/leads/route.ts` |
| GET | `/api/alerts` | — | `src/app/api/alerts/route.ts` |
| GET | `/api/analytics/summary` | — | `src/app/api/analytics/summary/route.ts` |
| POST | `/api/auth/change-password` | — | `src/app/api/auth/change-password/route.ts` |
| POST | `/api/auth/dev-login` | public | `src/app/api/auth/dev-login/route.ts` |
| POST | `/api/auth/logout` | — | `src/app/api/auth/logout/route.ts` |
| GET | `/api/auth/me` | — | `src/app/api/auth/me/route.ts` |
| GET | `/api/command-center` | — | `src/app/api/command-center/route.ts` |
| GET | `/api/contracts` | — | `src/app/api/contracts/route.ts` |
| POST | `/api/contracts` | — | `src/app/api/contracts/route.ts` |
| PUT | `/api/contracts` | — | `src/app/api/contracts/route.ts` |
| GET | `/api/contracts/:id` | admin, boss | `src/app/api/contracts/[id]/route.ts` |
| POST | `/api/contracts/:id/approve` | admin, boss | `src/app/api/contracts/[id]/approve/route.ts` |
| POST | `/api/contracts/:id/confirm-upload` | — | `src/app/api/contracts/[id]/confirm-upload/route.ts` |
| POST | `/api/contracts/:id/remind-payment` | — | `src/app/api/contracts/[id]/remind-payment/route.ts` |
| POST | `/api/contracts/:id/revoke` | admin, boss | `src/app/api/contracts/[id]/revoke/route.ts` |
| POST | `/api/contracts/:id/upload-url` | admin, boss | `src/app/api/contracts/[id]/upload-url/route.ts` |
| GET | `/api/contracts/list` | — | `src/app/api/contracts/list/route.ts` |
| POST | `/api/cos/download-url` | — | `src/app/api/cos/download-url/route.ts` |
| GET | `/api/cron/check-alerts` | — | `src/app/api/cron/check-alerts/route.ts` |
| GET | `/api/cron/check-no-answer` | — | `src/app/api/cron/check-no-answer/route.ts` |
| POST | `/api/cron/check-no-answer` | — | `src/app/api/cron/check-no-answer/route.ts` |
| GET | `/api/cron/check-overdue-followups` | — | `src/app/api/cron/check-overdue-followups/route.ts` |
| GET | `/api/cron/check-overdue-installments` | — | `src/app/api/cron/check-overdue-installments/route.ts` |
| GET | `/api/cron/cleanup-notifications` | — | `src/app/api/cron/cleanup-notifications/route.ts` |
| GET | `/api/cron/daily-funnel-snapshot` | — | `src/app/api/cron/daily-funnel-snapshot/route.ts` |
| GET | `/api/cron/daily-reminder` | — | `src/app/api/cron/daily-reminder/route.ts` |
| POST | `/api/cron/daily-reminder` | — | `src/app/api/cron/daily-reminder/route.ts` |
| GET | `/api/dashboard/ads-roi` | — | `src/app/api/dashboard/ads-roi/route.ts` |
| POST | `/api/dashboard/ads-roi/import` | admin | `src/app/api/dashboard/ads-roi/import/route.ts` |
| GET | `/api/dashboard/lead-health` | — | `src/app/api/dashboard/lead-health/route.ts` |
| GET | `/api/dashboard/lead-sources` | admin, boss | `src/app/api/dashboard/lead-sources/route.ts` |
| GET | `/api/dashboard/payment-tracker` | — | `src/app/api/dashboard/payment-tracker/route.ts` |
| GET | `/api/dashboard/pipeline-funnel` | — | `src/app/api/dashboard/pipeline-funnel/route.ts` |
| GET | `/api/dashboard/quality` | — | `src/app/api/dashboard/quality/route.ts` |
| GET | `/api/dashboard/sales-load` | — | `src/app/api/dashboard/sales-load/route.ts` |
| POST | `/api/dashboard/sales-load/rebalance` | — | `src/app/api/dashboard/sales-load/rebalance/route.ts` |
| GET | `/api/dashboard/summary` | — | `src/app/api/dashboard/summary/route.ts` |
| GET | `/api/dashboard/team-ownership` | — | `src/app/api/dashboard/team-ownership/route.ts` |
| GET | `/api/dashboard/team-performance` | admin, boss | `src/app/api/dashboard/team-performance/route.ts` |
| GET | `/api/dashboard/weekly-review` | — | `src/app/api/dashboard/weekly-review/route.ts` |
| GET | `/api/dashboard/weekly-trends` | — | `src/app/api/dashboard/weekly-trends/route.ts` |
| POST | `/api/dev/setup` | public | `src/app/api/dev/setup/route.ts` |
| GET | `/api/follow-ups` | — | `src/app/api/follow-ups/route.ts` |
| GET | `/api/health` | public | `src/app/api/health/route.ts` |
| POST | `/api/hermes/generate-quote` | — | `src/app/api/hermes/generate-quote/route.ts` |
| POST | `/api/hermes/knx-design` | — | `src/app/api/hermes/knx-design/route.ts` |
| GET | `/api/hermes/knx-design/status` | — | `src/app/api/hermes/knx-design/status/route.ts` |
| DELETE | `/api/kpi/targets` | — | `src/app/api/kpi/targets/route.ts` |
| GET | `/api/kpi/targets` | — | `src/app/api/kpi/targets/route.ts` |
| POST | `/api/kpi/targets` | — | `src/app/api/kpi/targets/route.ts` |
| POST | `/api/leads/:id/events` | — | `src/app/api/leads/[id]/events/route.ts` |
| POST | `/api/leads/:id/follow-up` | — | `src/app/api/leads/[id]/follow-up/route.ts` |
| POST | `/api/leads/:id/milestone` | — | `src/app/api/leads/[id]/milestone/route.ts` |
| POST | `/api/leads/:id/quality` | — | `src/app/api/leads/[id]/quality/route.ts` |
| GET | `/api/leads/:id/timeline` | — | `src/app/api/leads/[id]/timeline/route.ts` |
| GET | `/api/leads/archive` | admin, boss | `src/app/api/leads/archive/route.ts` |
| POST | `/api/leads/archive` | admin, boss | `src/app/api/leads/archive/route.ts` |
| GET | `/api/leads/follow-up-overdue` | — | `src/app/api/leads/follow-up-overdue/route.ts` |
| POST | `/api/leads/import/confirm` | — | `src/app/api/leads/import/confirm/route.ts` |
| POST | `/api/leads/import/preview` | — | `src/app/api/leads/import/preview/route.ts` |
| GET | `/api/leads/list` | — | `src/app/api/leads/list/route.ts` |
| POST | `/api/leads/meta-capi` | public | `src/app/api/leads/meta-capi/route.ts` |
| GET | `/api/meta/oauth-callback` | public | `src/app/api/meta/oauth-callback/route.ts` |
| GET | `/api/metrics/daily` | — | `src/app/api/metrics/daily/route.ts` |
| GET | `/api/metrics/funnel` | — | `src/app/api/metrics/funnel/route.ts` |
| POST | `/api/monitoring/report` | public | `src/app/api/monitoring/report/route.ts` |
| GET | `/api/notifications` | — | `src/app/api/notifications/route.ts` |
| POST | `/api/notifications` | — | `src/app/api/notifications/route.ts` |
| PATCH | `/api/notifications/:id` | — | `src/app/api/notifications/[id]/route.ts` |
| POST | `/api/notifications/read-all` | — | `src/app/api/notifications/read-all/route.ts` |
| GET | `/api/notifications/unread-count` | — | `src/app/api/notifications/unread-count/route.ts` |
| POST | `/api/notify` | — | `src/app/api/notify/route.ts` |
| GET | `/api/payments` | — | `src/app/api/payments/route.ts` |
| POST | `/api/payments` | — | `src/app/api/payments/route.ts` |
| POST | `/api/payments/:id/allocate` | admin, boss | `src/app/api/payments/[id]/allocate/route.ts` |
| POST | `/api/payments/:id/confirm` | admin, boss | `src/app/api/payments/[id]/confirm/route.ts` |
| GET | `/api/payments/list` | — | `src/app/api/payments/list/route.ts` |
| GET | `/api/pipeline/list` | — | `src/app/api/pipeline/list/route.ts` |
| GET | `/api/products` | — | `src/app/api/products/route.ts` |
| POST | `/api/products/import` | — | `src/app/api/products/import/route.ts` |
| POST | `/api/quotations/:id/convert` | — | `src/app/api/quotations/[id]/convert/route.ts` |
| POST | `/api/quotations/calculate` | — | `src/app/api/quotations/calculate/route.ts` |
| GET | `/api/quotations/export` | — | `src/app/api/quotations/export/route.ts` |
| POST | `/api/quotations/generate` | — | `src/app/api/quotations/generate/route.ts` |
| GET | `/api/settings/data` | — | `src/app/api/settings/data/route.ts` |
| GET | `/api/tasks` | — | `src/app/api/tasks/route.ts` |
| POST | `/api/tasks` | — | `src/app/api/tasks/route.ts` |
| PATCH | `/api/tasks` | — | `src/app/api/tasks/route.ts` |
| GET | `/api/tasks/:id` | — | `src/app/api/tasks/[id]/route.ts` |
| PATCH | `/api/tasks/:id` | — | `src/app/api/tasks/[id]/route.ts` |
| GET | `/api/tasks/list` | — | `src/app/api/tasks/list/route.ts` |
| GET | `/api/team/list` | — | `src/app/api/team/list/route.ts` |
| GET | `/api/users` | — | `src/app/api/users/route.ts` |
| POST | `/api/users` | — | `src/app/api/users/route.ts` |
| DELETE | `/api/users/:id` | admin, boss | `src/app/api/users/[id]/route.ts` |
| GET | `/api/users/:id/password` | admin, boss | `src/app/api/users/[id]/password/route.ts` |
| PATCH | `/api/users/:id/password` | admin, boss | `src/app/api/users/[id]/password/route.ts` |
| GET | `/api/workbench` | — | `src/app/api/workbench/route.ts` |
| POST | `/api/workflow` | — | `src/app/api/workflow/route.ts` |
| PUT | `/api/workflow` | — | `src/app/api/workflow/route.ts` |
