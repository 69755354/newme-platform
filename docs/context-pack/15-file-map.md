# 15 — File Map (High-Risk Files)

Source: Working tree diff + production sensitivity analysis

## Core Business Logic
| File | Purpose | Recent Change | Tables Read | Tables Write | Risk |
|---|---|---|---|---|---|
| src/lib/milestones.ts | Milestone validation + stage derivation | ✅ Modified (+24/-?) | — | — | HIGH — controls workflow rules |
| src/proxy.ts | Next.js middleware | ✅ Modified (−12) | — | — | HIGH — auth bypass surface |
| src/lib/supabase-server.ts | Server-side Supabase client | Recent commit | — | — | HIGH — token refresh logic |
| src/lib/supabase-admin.ts | service_role client singleton | No recent change | — | — | CRITICAL — bypasses RLS |

## Lead State Management
| File | Purpose | Recent Change | Risk |
|---|---|---|---|
| src/app/api/leads/[id]/milestone/route.ts | Milestone completion + dual-write | ✅ Modified (+38/−?) | HIGH — writes final_status + stage |
| src/app/(dashboard)/leads/[id]/page.tsx | Lead detail with updateStage/updateNextTask | ✅ Modified (+71/−?) | HIGH — main user interaction point |
| src/app/(dashboard)/leads/new/page.tsx | Create lead form | ✅ Modified (−1) | MEDIUM |
| src/components/QuickCreateLeadDialog.tsx | Quick create dialog | ✅ Modified (−1) | MEDIUM |

## Dashboard & Analytics
| File | Purpose | Recent Change | Risk |
|---|---|---|---|
| src/app/(dashboard)/dashboard/page.tsx | Main dashboard | ✅ Modified (+98/−?) | HIGH — active/won/lost calculation |
| src/app/api/dashboard/sales-load/route.ts | Sales leaderboard | ✅ Modified | MEDIUM |
| src/app/api/dashboard/pipeline-funnel/route.ts | Pipeline counts | ✅ Modified | MEDIUM |

## Auth & Security
| File | Purpose | Recent Change | Risk |
|---|---|---|---|
| supabase/migrations/20260623000001_auth_login_trigger.sql | Auth login trigger (BROKE PROD) | Untracked | CRITICAL |
| supabase/migrations/20260624143000_fix_auth_login_trigger.sql | Fix for above | Untracked | CRITICAL |
| supabase/migrations/20260623020002_crm_v3_rls_policies.sql | New RLS policies | Untracked (duplicate) | HIGH |

## Followup & Tasks
| File | Purpose | Recent Change | Risk |
|---|---|---|---|
| src/app/api/workbench/route.ts | Workbench data (reads tasks) | ✅ Modified | HIGH — dual-source |
| src/app/api/cron/check-overdue-followups/route.ts | Overdue check (reads leads) | ✅ Modified | HIGH |
| src/app/api/leads/follow-up-overdue/route.ts | Overdue API (reads leads) | ✅ Modified | MEDIUM |

## Scope Creep Items
| File | Purpose | Status |
|---|---|---|
| src/app/(dashboard)/analytics/_components/LeadSources.tsx | New analytics component | Untracked, NOT requested |
| src/app/(dashboard)/analytics/_components/TeamPerformance.tsx | New analytics component | Untracked, NOT requested |
| src/app/api/dashboard/lead-sources/route.ts | New API route | Untracked, NOT requested |
| src/app/api/dashboard/team-performance/route.ts | New API route | Untracked, NOT requested |
