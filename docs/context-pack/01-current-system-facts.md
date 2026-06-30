# 01 — Current System Facts

## Branch & Commit
- Branch: main
- Commit: 1b1e054 — `[GLM-CP] fix: Phase A P0 security — auth guards, mandatory secrets, service_role cleanup`
- Date: 2026-06-24

## Deploy
- URL: https://app.newme.ae
- Nginx proxy: 443 → localhost:3001
- Build ID: sNQoiVCSyTRQqQVgmciDz
- Service: active (systemctl is-active = active)

## Working Tree Status (UNSTAGED, NOT deployed)
- 28 files changed
- +347 insertions, −220 deletions
- Core: stage→final_status migration + tasks-driven followup
- Pending review — NOT in production

## Migration Files (supabase/migrations/)
- 20260613020000_fix_alerts_and_constraints.sql
- 20260613220000_rls_auto_protection.sql
- 20260623000001_auth_login_trigger.sql
- 20260623020000_crm_v3_leads_extensions.sql
- 20260623020000_crm_v3_new_tables.sql
- 20260623020000_crm_v3_rls_policies.sql
- 20260623020001_crm_v3_new_tables.sql (DUPLICATE of 20260623020000)
- 20260623020002_crm_v3_rls_policies.sql (DUPLICATE of 20260623020000)
- 20260623021000_add_no_answer_flag.sql
- 20260623030000_crm_v3_stage_to_milestone_mapping.sql
- 20260623040000_crm_v3_phase_b_fields.sql
- 20260624000000_next_quote_no_rpc.sql
- 20260624000001_fix_milestone_order.sql
- 20260624000002_fix_won_lost_migration.sql
- 20260624000003_fix_trg_lead_won.sql
- 20260624000004_add_approval_status.sql
- 20260624095205_fix_p0_won_trigger_perms.sql
- 20260624130000_add_default_next_action.sql
- 20260624143000_fix_auth_login_trigger.sql
- rollback_crm_v3.sql

## Production Data Counts (2026-06-24)
| Table | Rows |
|---|---|
| leads | 69 |
| profiles | 9 |
| tasks | 1 |
| follow_up_logs | 3 |
| lead_milestones | 84 |
| contracts | 0 |
| installment_plans | 0 |
| projects | 0 |
| customers | 0 |
| quotations | 2 |
| business_events | 163 |
| activities | 117 |
| notifications | 151 |

## Active Employees
| Email | Name | Role |
|---|---|---|
| dev@newme.ae | Dev User | admin |
| ayana@newme.ae | Ayana | admin |
| mohamed@newme.ae | Mohamed | sales |
| faheem@newme.ae | Faheem | sales |
| tanya@newme.ae | Tanya | boss |
| admin@newme.ae | SAM | admin |

## Leads Distribution
### By stage
- contacted: 28
- fake: 19
- no_answered: 7
- lost: 7
- requirement_confirmed: 3
- quotation_submitted: 2
- solution_submitted: 2
- negotiation: 1

### By final_status
- null (active): 61
- lost: 8

### By source
- meta_ads: 35
- other: 31
- whatsapp: 2
- offline: 1

## Known Active Bugs
1. Analytics React #310 — ResponsiveContainer rendering error in SalesLoad/WeeklyTrends
2. Activity tracking pipeline broken — 1 record in 7 days (activity_logs table)
3. Quick Create Lead — missing tasks table write
4. Leads counter shows 0 on dashboard (race condition)
5. req_confirmed returns 400 via milestone API (app vs DB layer mismatch)
6. Dashboard Sales Leaderboard missing Tanya (boss role excluded)
