CC-04 completed: 11 P0 + 13 P1 + 11 P2
Verdict: NO-GO

Key P0:
- /api/cos/download-url: IDOR, any auth user gets any file
- /api/monitoring/report: fully unauthenticated, disk writes
- /api/auth/change-password: plaintext password in DB
- /api/users/[id]/password: admin can reset boss password
- /api/leads/[id]/milestone: IDOR, any user sets won/lost on any lead
- /api/leads/[id]/follow-up: IDOR, any user writes follow-up to any lead
- /api/quotations/generate: service_role writes to any lead_id
- /api/hermes/generate-quote: service_role IDOR
- /api/hermes/knx-design: unbounded background pipeline on any lead
- /api/cron/check-overdue-followups: cron secret in ?token= query param
- /api/activities: no authorization scoping

Minimum to GO: fix 7 items (password_hint, ownership checks on write paths, cos/download-url gate, monitoring auth, cron token→header, password reset audit, activities scope)
