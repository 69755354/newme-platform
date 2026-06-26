# CRM v3.1 PRD Burn-down

**Updated:** 2026-06-26
**Status:** Core PRD ready for sales rollout

---

## P0 — CLEARED ✅

| # | Item | Status |
|---|------|--------|
| 1 | /quotes Application Error (SSR 500) | Fixed — Next.js 16 RSC cache rebuild |
| 2 | /projects Application Error (SSR 500) | Fixed — same root cause |
| 3 | ErrorMonitor frontend 401 | Fixed — MONITORING_SECRET configured |
| 4 | SENTRY_AUTH_TOKEN empty/invalid | Fixed — token valid, API confirmed |
| 5 | RSC client manifest missing modules | Fixed — clean .next rebuild |
| 6 | audit_logs event_type column mismatch | Fixed — event_type→action, user_id→actor_id |

## P1 — CLEARED ✅

| # | Item | Status |
|---|------|--------|
| 1 | weekly-trends 12-week all zero | Fixed — operator role added to isManagement |
| 2 | check:smoke missing routes | Fixed — 14 routes in smoke list |
| 3 | error-monitor.py CHAT_ID wrong | Fixed — CRM PROJECT group |
| 4 | /tmp/hermes/errors directory missing | Fixed — created, write verified |
| 5 | Ads page Coming Soon | N/A — page already fully implemented |
| 6 | Pipeline funnel won/lost count | Fixed — current_milestone-based |

## P2 — BACKLOG (not blocking rollout)

| # | Item |
|---|------|
| 1 | Meta Ads API real spend integration |
| 2 | Finance/Payment advanced features |
| 3 | i18n full polish (some raw keys may remain) |
| 4 | Data quality: null quotation_value on old leads |
| 5 | browser-smoke CI integration (script exists) |
| 6 | check:logs false positive on service restart |
| 7 | 2 ghost profiles deactivated (0bdb28a1, 1cd94d17) |
| 8 | CSP warnings on headless browser (Meta Pixel, PostHog) — production browsers unaffected |

## P3 — FUTURE

| # | Item |
|---|------|
| 1 | Real sales feedback → hotfix loop |
| 2 | Dashboard/analytics UI refinement |
| 3 | Advanced reporting |
| 4 | Multi-tenant architecture |
