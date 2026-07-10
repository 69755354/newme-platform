# Architecture Map — 2026-07-11

## Scope
Re-verified `src/app/api`, `src/app/actions`, `src/lib`, `src/shared`, `supabase/migrations`, `scripts`, and `.github/workflows` after `origin/work` reset.

## Confirmed findings
| ID | P | Type | Evidence | Impact | Fix | Verification |
|---|---:|---|---|---|---|---|
| ARCH-001 | P1 | Architecture debt | `src/shared/hooks/usePipelineDragDrop.ts` is a Client Component hook and directly updates `quotations`, `leads`, `activities`, and `business_events`. | Critical stage mutations are split between browser and server actions. | Move drag/drop persistence to `src/app/actions/pipeline.ts` or route handler while preserving current semantics. | `npm run check:supabase-boundaries`; regression tests. |
| ARCH-002 | P1 | Architecture debt | `src/lib/supabase.ts` manually parses browser localStorage/cookies for Supabase sessions. | Auth/session behavior is hard to audit across SSR/client boundaries. | Prefer one server/client Supabase adapter pattern; defer refactor outside Phase 0. | Auth integration tests. |
| ARCH-003 | P2 | Fixed in this PR | `ecosystem.config.cjs` existed at repo root before this PR; production policy is systemd-only. | PM2 takeover ambiguity. | Archived under `docs/ops/deprecated/` and added `docs/ops/systemd-only.md`. | `find . -iname '*pm2*' -o -name 'ecosystem.config.*'`. |

## Dynamic validation risks
- Server Actions in `src/app/actions/*.ts` accept resource IDs and require dynamic unauthorized-user tests beyond static evidence.
- API route RLS reliance should be validated with disposable Supabase test DB before production promotion.
