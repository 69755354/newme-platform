# 09 — Dashboard & Analytics Facts

Source: Production code + API routes

## Dashboard (/dashboard)
- Data sources: /api/dashboard/pipeline-funnel, /api/dashboard/sales-load, /api/dashboard/weekly-trends, /api/dashboard/lead-health, /api/dashboard/ads-roi
- Active leads calculation: leads WHERE final_status IS NULL (in working tree) / WHERE stage NOT IN ('won','lost') (current production)
- Won calculation: leads WHERE final_status = 'won' (working tree) / WHERE stage = 'won' (production)
- Lost calculation: leads WHERE final_status = 'lost'

## Sales Leaderboard
- Query: leads grouped by assigned_to
- Role filter: only counts leads assigned to role=sales users
- Tanya (boss) NOT counted (correct: boss doesn't own leads)
- Missing: if boss does own leads, they won't appear

## Analytics Pages
- /analytics — main analytics dashboard
- Components: SalesLoad, WeeklyTrends, LeadHealth, LeadSources (new/untracked), TeamPerformance (new/untracked)

## React #310 Error Info
- Symptom: ResponsiveContainer from recharts throws #310 error
- Affected: SalesLoad.tsx, WeeklyTrends.tsx
- Working tree fix: added minWidth={0} minHeight={0} to ResponsiveContainer

## Dashboard API Routes (all GET)
| Route | Tables Read | Auth |
|---|---|---|
| /api/dashboard/pipeline-funnel | leads | createServerSupabase |
| /api/dashboard/sales-load | leads, profiles | createServerSupabase |
| /api/dashboard/weekly-trends | leads, contracts | createServerSupabase |
| /api/dashboard/lead-health | leads | createServerSupabase |
| /api/dashboard/ads-roi | leads, ad_spend | createServerSupabase |
| /api/dashboard/lead-sources | (new, untracked) | — |
| /api/dashboard/team-performance | (new, untracked) | — |
