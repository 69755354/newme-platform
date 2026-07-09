# Build Log

> **Template for tracking each feature/deploy across its lifecycle.**
> Fill out one build log per feature branch / deploy.

---

## 📋 Metadata

| Field       | Value |
|-------------|-------|
| **Feature name** | *(e.g. "Lead import v2 — Excel upload with validation")* |
| **Branch**       | `feat/…` / `fix/…` / `hotfix/…` |
| **Date started** | YYYY-MM-DD |
| **Date shipped** | YYYY-MM-DD |
| **Author(s)**    | @handle |
| **Pull request** | *(link)* |
| **Deploy commit**| `abc1234` |

---

## 🎯 Summary

*One paragraph describing what this feature/fix does and why.*

---

## 📁 Files Changed

| File | Change | Notes |
|------|--------|-------|
| `src/app/api/leads/import/route.ts` | Added | POST handler for CSV uploads |
| `supabase/migrations/20260709_lead_import.sql` | Added | New `lead_imports` table |
| `src/lib/import-parser.ts` | Added | CSV/XLSX parser utility |
| `src/app/dashboard/leads/import/page.tsx` | Modified | Wired upload form |
| *(add rows)* | | |

---

## 🔌 New API Endpoints

| Method | Path | Description | Auth / RBAC |
|--------|------|-------------|-------------|
| POST | `/api/leads/import/preview` | Parse file, return preview rows | admin, boss |
| POST | `/api/leads/import/confirm` | Commit previewed rows as leads | admin, boss |
| *(add rows)* | | | |

---

## 🗄️ Database Changes

| Type | Object | Details |
|------|--------|---------|
| New table | `lead_imports` | `id, file_name, status, created_by, created_at` |
| New policy | `lead_imports — admin_all` | admin/boss can read/write |
| *(add rows)* | | |

---

## 🐛 Bugs → Cause → Fix

| # | Bug description | Root cause | Fix | Status |
|---|----------------|------------|-----|--------|
| 1 | *(e.g. Import fails for files > 5MB)* | Body-parser size limit was 4MB | Increased `bodyParser` limit to 10MB in `next.config.js` | ✅ Fixed |
| 2 | *(e.g. Duplicate phone numbers crash insert)* | Missing unique constraint on `phone` | Added upsert logic + unique index migration | ✅ Fixed |
| *(add rows)* | | | | |

---

## ✅ Acceptance Checklist

- [ ] All unit / integration tests pass
- [ ] Manual QA on staging — happy path + edge cases
- [ ] RBAC verified (correct roles can/cannot access)
- [ ] Migration applied cleanly (no drift)
- [ ] `scripts/deploy-sanity-check.py` passes
- [ ] TASKBOARD.md updated (if applicable)
- [ ] Build log filed in `docs/build-logs/YYYY-MM-DD-<feature-slug>.md`

---

## 📝 Notes / Post-mortem

*Anything that went well, went sideways, or should be remembered next time.*
