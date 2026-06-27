# 03 — API Facts

Source: Code scan of src/app/api/

## Summary
- 67 total API routes
- 55 require authentication (createServerSupabase)
- 21 use supabaseAdmin (service_role, bypasses RLS)
- 12 unauthenticated (cron jobs, health check, webhooks)

## Cron Job Routes
| Route | Method | Auth | Tables |
|---|---|---|---|
| /api/cron/check-alerts | GET | x-cron-secret header | leads, notifications |
| /api/cron/check-overdue-followups | GET | ?token= query | leads |
| /api/cron/check-overdue-installments | GET | x-cron-secret header | installment_plans |
| /api/cron/cleanup-notifications | POST | ?token= query | notifications |
All use supabaseAdmin.

## Dashboard API Routes
| Route | Method | Auth | Tables Read |
|---|---|---|---|
| /api/dashboard/pipeline-funnel | GET | auth | leads |
| /api/dashboard/sales-load | GET | auth | leads, profiles |
| /api/dashboard/weekly-trends | GET | auth | leads, contracts |
| /api/dashboard/lead-health | GET | auth | leads |
| /api/dashboard/ads-roi | GET | auth | leads, ad_spend |
| /api/dashboard/lead-sources | GET | auth | (new, untracked) |
| /api/dashboard/team-performance | GET | auth | (new, untracked) |

## Leads API Routes
| Route | Method | Auth | Tables Written | Tables Read |
|---|---|---|---|---|
| /api/leads | GET | auth | — | leads, profiles |
| /api/leads | POST | auth | leads | — |
| /api/leads/[id]/milestone | POST | auth | lead_milestones, leads | leads, lead_milestones |
| /api/leads/follow-up-overdue | GET | auth | — | leads |
| /api/leads/meta-capi | POST | none | leads | — |

## Contracts API Routes
| Route | Method | Auth |
|---|---|---|
| /api/contracts | GET, POST | auth |
| /api/contracts/[id] | GET, PUT | auth |
| /api/contracts/[id]/approve | POST | auth |
| /api/contracts/[id]/revoke | POST | auth |
| /api/contracts/[id]/upload-url | POST | auth |
| /api/contracts/[id]/confirm-upload | POST | auth |
| /api/contracts/[id]/remind-payment | POST | auth |

## Payments API Routes
| Route | Method | Auth |
|---|---|---|
| /api/payments | GET, POST | auth |
| /api/payments/[id]/allocate | POST | auth |
| /api/payments/[id]/confirm | POST | auth |

## Other API Routes
| Route | Method | Auth | Notes |
|---|---|---|---|
| /api/health | GET | none | Health check |
| /api/workbench | GET | auth | Sales workbench data |
| /api/workflow | POST | auth | Workflow engine |
| /api/command-center | GET | auth | CEO dashboard data |
| /api/hermes/generate-quote | POST | auth | Quote generation |
| /api/hermes/knx-design | POST | auth | KNX design |
| /api/hermes/knx-design/status | GET | auth | Design status |
| /api/quotations/[id]/convert | POST | auth | Quote → Contract |
| /api/notifications | GET | auth | User notifications |
| /api/notifications/[id] | PATCH | auth | Mark read |
| /api/notifications/read-all | PATCH | auth | Mark all read |
| /api/notifications/unread-count | GET | auth | Unread count |
| /api/users/[id]/password | PATCH | auth | Password change |
| /api/products/import | POST | auth | Product import |
| /api/monitoring/report | POST | none | Error report |
| /api/meta/oauth-callback | GET | none | Meta OAuth |
| /api/dev/setup | GET | none | Dev setup |

## API Routes Modified in Working Tree (NOT deployed)
- cron/check-alerts/route.ts (changed dedup window 24h→7d)
- cron/check-overdue-followups/route.ts (tasks-driven rewrite)
- dashboard/ads-roi/route.ts (stage→final_status)
- dashboard/lead-health/route.ts (stage→final_status)
- dashboard/pipeline-funnel/route.ts (stage→final_status + normalizeMilestone)
- dashboard/sales-load/route.ts (stage→final_status)
- dashboard/weekly-trends/route.ts (stage→final_status)
- leads/[id]/milestone/route.ts (dual-write fixes)
- leads/follow-up-overdue/route.ts (field selection)
- leads/meta-capi/route.ts (source change meta→meta_ads — REGRESSION)
- quotations/[id]/convert/route.ts (stage→final_status)
- workbench/route.ts (tasks-driven rewrite)
