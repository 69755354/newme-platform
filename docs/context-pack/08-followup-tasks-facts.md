# 08 — Followup & Tasks Facts

Source: Production DB + code scan

## follow_up_logs Table
- Purpose: Historical follow-up records (what happened in the past)
- Columns: id, lead_id, user_id, type, content, no_answer, created_at
- Rows in production: 3
- Written by: lead detail page follow-up recording

## tasks Table
- Purpose: Future to-do items (what needs to happen)
- Columns: id, lead_id, title, due_at, completed_at, assignee_id
- Rows in production: 1
- Written by: auto_create_task trigger on follow_up_logs insert
- Read by: dashboard, workbench, check-overdue-followups cron

## next_followup_date on leads (legacy)
- Still written by: lead creation form, QuickCreateLeadDialog
- Still read by: follow-up-overdue API, sales-load dashboard, leads list filter
- NOT written by: lead detail page updateNextTask (writes tasks.due_at instead — in working tree)

## due_at on tasks
- Read by: dashboard (today's followups, risk pool count), workbench
- Written by: auto_create_task trigger, updateNextTask (working tree)
- CHECK constraint: due_at > now() — blocks setting followup to "today"

## Workbench (/api/workbench)
- Data source: tasks table + leads with no next_action
- Returns: inbox, tasks, overdue, progress arrays

## Overdue Detection (dual-source conflict in working tree)
| Component | Reads from |
|---|---|
| dashboard risk pool | tasks.due_at (working tree) |
| sales-load overdue | leads.next_followup_date (still old) |
| follow-up-overdue API | leads.next_followup_date (still old) |
| leads list filter | leads.next_followup_date (still old) |

## All files touching followup/tasks
- src/app/(dashboard)/leads/[id]/page.tsx — updateNextTask writes tasks
- src/app/(dashboard)/dashboard/page.tsx — reads tasks for today's followups
- src/app/api/workbench/route.ts — reads tasks
- src/app/api/cron/check-overdue-followups/route.ts — reads leads.next_followup_date
- src/app/api/dashboard/sales-load/route.ts — reads leads.next_followup_date
- src/app/(dashboard)/leads/page.tsx — filters by leads.next_followup_date
- src/components/QuickCreateLeadDialog.tsx — writes leads.next_followup_date
- src/app/api/leads/follow-up-overdue/route.ts — reads leads.next_followup_date
