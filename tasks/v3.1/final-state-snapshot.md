# CRM v3.1 Final State Snapshot

**Captured:** 2026-06-26 23:45 WITA

---

## Git

- **Commit:** `1d3f31a` (latest on main)
- **Branch:** main
- **Remote:** github.com/69755354/newme-platform.git

## Migrations (latest 15)

```
20260624143000  fix_auth_login_trigger
20260624130000  add_default_next_action
20260624095205  fix_p0_won_trigger_perms
20260624000004  add_approval_status
20260624000003  fix_trg_lead_won.sql
20260624000002  fix_won_lost_migration.sql
20260624000001  fix_milestone_order.sql
20260624000000  next_quote_no_rpc.sql
20260623040000  crm_v3_phase_b_fields.sql
20260623030000  crm_v3_stage_to_milestone_mapping.sql
20260623021000  add_no_answer_flag.sql
20260623020002  crm_v3_rls_policies
20260623020001  crm_v3_new_tables
20260623020000  crm_v3_leads_extensions.sql
20260623000001  auth_login_trigger
```

## Row Counts

| Table | Rows |
|-------|------|
| leads | 74 |
| contracts | 1 |
| quotations | 2 |
| installment_plans | 0 |
| projects | 0 |
| profiles | 12 |
| activities | 123 |
| follow_up_logs | (verified, exact count via DB) |

## Environment Keys

| Key | Status |
|-----|--------|
| NEXT_PUBLIC_SUPABASE_URL | SET |
| SUPABASE_SERVICE_ROLE_KEY | SET |
| NEXT_PUBLIC_SENTRY_DSN | SET |
| SENTRY_AUTH_TOKEN | SET |
| MONITORING_SECRET | SET |
| NEXT_PUBLIC_POSTHOG_KEY | SET |
| CRON_SECRET | SET |
| DEV_EMAIL | SET |
| TELEGRAM_BOT_TOKEN | MISSING (in system env for cron) |

## Verification Summary

| Check | Result |
|-------|--------|
| build | PASS |
| check:release | PASS (schema+route+smoke+logs) |
| browser-smoke (14 pages, logged in) | 14/14 PASS |
| won→contract→installments→project | PASS (end-to-end verified) |
| Analytics DB cross-check | PASS (all KPIs match) |
| weekly-trends | PASS (3 weeks non-zero) |
| Monitoring chain | PASS (report endpoint 200, errors dir writable) |
| Journal (current process) | CLEAN (0 errors) |
| Sentry (current process) | CLEAN (0 new issues) |
| Test data | ROLLED BACK |
| Ghost profiles | DEACTIVATED (2) |

## Deployed Files (business code only)

| File | Change |
|------|--------|
| `scripts/check-smoke.sh` | 7→14 routes |
| `scripts/check-browser-smoke.ts` | NEW: Playwright login smoke |
| `src/app/api/dashboard/weekly-trends/route.ts` | +operator role |
| `src/app/api/quotations/[id]/convert/route.ts` | +project auto-create |
| `src/proxy.ts` | audit_logs field fix |
