# NewMe CRM Core Workflow Production Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Task name:** `CRM-CORE-WORKFLOW-PRODUCTION-CLOSEOUT-v1`

**Goal:** Deliver and verify the complete production Lead workflow: truthful first-contact handling, all seven milestones, reliable Lead mutations, imports, archive safety, dashboard time/role semantics, and source naming.

**Architecture:** Business rules are authoritative on the server and database. The Lead Detail UI is a sales operating surface: it shows guidance separately from actions and never advances a stage automatically. Production has one Supabase project (`vfopmpxlhwzpxqegayew`); every database change is production-grade, audited, reversible where feasible, and tested with uniquely named UAT fixtures that are archived at the end.

**Tech Stack:** Next.js App Router, React, TypeScript, Supabase/PostgREST, SQL migrations, Node test runner, Playwright, GitHub Actions.

## Global Constraints

- Production app: `https://app.newme.ae`; production Supabase: `vfopmpxlhwzpxqegayew`; there is no staging database.
- Do not modify production data except uniquely prefixed UAT fixtures. Archive test Leads at completion; never delete customer Leads during UAT.
- Do not use client-side `supabase.from(...).delete()` or new client-side direct business mutations. Server APIs own authorization, audit and cache invalidation.
- No merge, deployment, migration or production write without all required tests, CI and production evidence.
- Do not bypass hooks, CI, deployment gates, coding-auth, RLS, migration history, or branch protection.
- No force push, reset hard, broad archive/delete, name-based archive/delete, or direct SQL data repair.
- All Lead source storage values are exactly `ins`, `fb`, `show_room`. User-visible values are exactly `ins`, `FB`, `Show room`. No visible `Instagram` or `Meta Ads` remains.
- Managers: boss/admin/operator see all allowed aggregate data. Sales sees only owned Leads; this must be server-enforced.
- Quality may be assessed after the first complete contact, but is not a mandatory immediate action. It is mandatory only when a user explicitly requests stage advancement from `new`.
- One complete contact + a selected quality unlocks advancement. Three contacts are coaching guidance only. Conditions unlock advancement; they never auto-advance.
- Every milestone advancement from 1 through 7 requires a non-whitespace stage note. Timeline must record one event with actor, time, old/new milestone and note.
- Contact time must not be later than the server current time. This validation exists in browser and API; API is authoritative.
- Use `t()` keys that exist in both Chinese and English. Never use `t() || fallback`.

---

## Delivery Order and Handshake Gates

The implementing worker may work only one task at a time. At every **HANDSHAKE** stop, report the exact commit, changed files, test output, CI link/status, migration status, UAT fixture IDs, observed response bodies and runtime logs. Do not start the next task until Codex reviews and returns `GO`.

1. Task 0 — import idempotency production blocker.
2. Task 1 — server-owned Lead deletion and cache invalidation.
3. Task 2 — universal milestone contract and contact-time validation.
4. **HANDSHAKE A** — code/DB review before UI redesign.
5. Task 3 — First Contact A2 sales-operating-surface UI.
6. Task 4 — Dashboard, source and authorization closeout verification/fixes.
7. **HANDSHAKE B** — CI and isolated UAT review.
8. Task 5 — controlled production deploy and full UAT evidence.

## Task 0: Repair Import Idempotency Constraint

**Purpose:** Make the current import confirmation API compatible with the production unique constraint so a repeated workbook is skipped rather than failing.

**Files:**

- Create: `supabase/migrations/20260714000004_fix_import_fingerprint_conflict_target.sql`
- Modify: `tests/security/lead-import-idempotency.test.mjs`
- Preserve: `src/app/api/leads/import/confirm/route.ts`

**Root cause already reproduced in production:** `upsert(..., { onConflict: "import_fingerprint" })` fails because `leads_import_fingerprint_unique` is a partial unique index (`WHERE import_fingerprint IS NOT NULL`), which PostgREST cannot infer as an `ON CONFLICT` target.

- [ ] Write a failing test that reads the new migration and requires both:

```js
assert.ok(migration.includes("DROP INDEX IF EXISTS public.leads_import_fingerprint_unique"));
assert.ok(migration.includes("CREATE UNIQUE INDEX leads_import_fingerprint_unique"));
assert.equal(migration.includes("WHERE import_fingerprint IS NOT NULL"), false);
```

- [ ] Run `node --test tests/security/lead-import-idempotency.test.mjs`; expected: failure because migration is absent.
- [ ] Create the migration:

```sql
BEGIN;
DROP INDEX IF EXISTS public.leads_import_fingerprint_unique;
CREATE UNIQUE INDEX leads_import_fingerprint_unique ON public.leads (import_fingerprint);
NOTIFY pgrst, 'reload schema';
COMMIT;
```

- [ ] Explain in the PR that PostgreSQL unique indexes allow multiple `NULL` values; no legacy row is rewritten.
- [ ] Run: targeted test, `npm test`, `npm run typecheck`, `npm run lint:baseline`, `git diff --check`.
- [ ] Open a narrowly scoped PR, wait for green CI, then stop for **HANDSHAKE A0**.

**Production UAT after deployment:** submit one uniquely named synthetic workbook row with legacy source `Meta Ads`, quality `0.8`, a historical contact date and a country. Verify: preview shows `ins`/`good`; first confirmation imports 1; second confirmation returns `imported=0, skipped_duplicates=1`; country and first-contact date remain in `raw_import_data`; exact imported ID can be previewed by exact owner, archived, restored and finally archived as fixture cleanup.

## Task 1: Make Lead Deletion Immediate and Consistent

**Purpose:** A successful deletion must disappear immediately from the acting user's list and never be restored by the 30-second list cache.

**Files:**

- Modify: `src/lib/api-cache.ts`
- Create: `src/app/api/leads/[id]/route.ts`
- Modify: `src/app/(dashboard)/leads/_hooks/useLeadMutations.ts`
- Modify: `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts`
- Create: `tests/security/lead-delete-cache-contract.test.mjs`

**Contract:** `DELETE /api/leads/:id` authenticates, loads `id,assigned_to`, allows `admin`/`boss` or `sales` owner only, rejects `operator` and non-owner sales with 403, deletes under user RLS, verifies exactly one deleted row, then clears cache prefixes. Return `{ id }` only after success.

- [ ] Write failing static/contract tests for:
  - `deleteCacheByPrefix(prefix)` uses `startsWith`.
  - delete API checks auth, assignment and roles before deleting.
  - client files contain no `supabase.from("leads").delete()`.
  - list handler optimistically removes the exact ID before the authoritative refresh.
  - invalidation happens only after delete success for: `leads-list:`, `pipeline:list:`, `workbench:`, `dashboard-summary:`, `team-ownership:`, `analytics-summary:`.
- [ ] Implement `deleteCacheByPrefix(prefix: string): void` in `api-cache.ts`.
- [ ] Implement the server DELETE route. Do not add a service-role delete; use the authenticated server client so RLS remains a second boundary.
- [ ] In list UI: call the API, remove only the returned ID from local state, then call the existing refresh.
- [ ] In detail UI: call the same API and navigate only after success.
- [ ] Run targeted test, full tests, typecheck, lint baseline and diff check.
- [ ] Stop for **HANDSHAKE A1**.

## Task 2: Universal Milestone Contract and Contact Time Guard

**Purpose:** Eliminate inconsistent milestone advances, blank notes, future contact records and non-actionable write failures.

**Files to inspect before editing:**

- `src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx`
- `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts`
- `src/app/api/leads/[id]/contacts/route.ts`
- the existing milestone route/mutation used by `LeadSalesProcess.tsx`
- `src/app/api/leads/[id]/stage/route.ts`
- all migrations containing `milestone`, `activities`, `business_events`, `current_milestone`, `stage` or triggers
- relevant tests in `tests/security/` and `tests/unit/`

**Before coding:** Produce the factual 1–7 matrix from current code/database: milestone identifier, displayed label, entry action, server route, required fields, transition written, activities/business events written, DB trigger/constraint, and current failure mode. Include the exact root cause for “图纸收集 → 需求确认” before changing it.

**Universal transition interface:**

```ts
type AdvanceMilestoneRequest = {
  leadId: string;
  fromMilestone: string;
  toMilestone: string;
  note: string;
  idempotencyKey: string;
};
```

The server trims `note`, rejects empty notes with 400, validates the allowed next milestone, records the milestone/timeline/audit result atomically, and returns the stored result. It must not mutate the Lead when validation fails.

- [ ] Write RED tests: blank note rejected for every transition; duplicate key produces one event; failed figure-collection transition leaves milestone unchanged and retains client draft; valid transition produces one Timeline event containing note.
- [ ] Trace and fix the exact figure-collection write error; do not replace it with a broad catch or a client-only success toast.
- [ ] Add future contact time tests:

```js
assert.equal(createContact("2099-01-01T00:00:00Z").status, 400);
assert.match(error, /cannot be in the future/i);
```

- [ ] Browser: set `max` on the datetime input to current client time and show `联系时间不能晚于当前时间`.
- [ ] API: compare parsed contact time to server `new Date()` and reject future values. Apply the same rule to contact editing.
- [ ] Preserve drafts after API errors; disable a submit button while its request is in flight.
- [ ] Run full tests, add/execute an API integration test per milestone, and stop for **HANDSHAKE A2**.

## Task 3: First Contact A2 Sales Operating Surface

**Purpose:** Make the real action obvious without pressuring salespeople to invent a quality rating.

**Files:**

- Modify: `src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx`
- Modify only required strings in: `src/lib/i18n/translations.ts`
- Modify relevant mutation/state file only if required by Task 2 interface
- Test: First Contact UI/static tests in `tests/security/` or existing matching test file

**Required UI structure:**

1. Header: `初次接触`, a non-clickable status badge, `1/7`.
2. Guide block, muted: `目标：记录首次真实联系；质量可在信息足够时再评估。`
3. Action block, strongest visual hierarchy:
   - with no complete contact: full-width `＋ 添加首次联系记录`.
   - with contact: secondary `＋ 继续添加联系记录`.
4. Optional quality block: `可选操作：线索质量` with `优质 / 一般 / 较差`; disabled until first complete contact. Label: `可在首次联系后填写；推进前必须完成。`
5. Guidance-only block: `建议完成 3 次有效联系，帮助后续跟进（N/3）`.
6. Bottom advancement button. It does not auto-advance. When clicked without quality it explains that quality is required for advancement; it must not mark the lead completed.
7. Advancement opens the universal required-note dialog from Task 2.

- [ ] Remove an interactive checkbox as a stage/milestone advancement control. A completed icon is display-only.
- [ ] Write tests for contact-first flow, quality optional-before-advance, one-contact-plus-quality unlock, three-contacts-without-quality block, and no automatic stage change.
- [ ] Verify all exact i18n keys in English and Chinese; do not add raw fallback text.
- [ ] Stop for **HANDSHAKE B1**.

## Task 4: Remaining Product Contracts

**Purpose:** Close outstanding requirements from Tanya's workflow without mixing them into milestone rules.

**4A Sources**

- Verify every selector/header/detail/timeline/import path stores only `ins`, `fb`, `show_room` and displays `ins`, `FB`, `Show room`.
- Read-only data check: legacy `meta_ads` count must be zero. Do not alter other source data.

**4B Dashboard**

- Default period is Today; choices Today, This Week, Last Week, This Month, Custom.
- L1/L2/L3 share exactly the selected period and inclusive end date.
- L3 uses readable sales language, never raw database enums.
- Boss/admin/operator server responses contain allowed roster detail; sales API is server-filtered to assigned leads.
- Financial cards retain their intended independent financial period semantics.

**4C Import and Archive**

- Workbook headers and quality preservation are tested with the actual user-provided workbook after a read-only preview.
- Same workbook confirmation twice must not increase Lead count on the second run.
- Archive preview requires exact `owner_id`; archive submits only immutable approved IDs; restore uses returned batch ID; no name matching.

- [ ] Add one test per contract that fails against a known bad behavior.
- [ ] Run role matrix with Tanya (boss), Sam (admin), Ayana (operator) and one sales account. Use test fixtures only for writes.
- [ ] Stop for **HANDSHAKE B2**.

## Task 5: Production Release and Evidence

**Preconditions:** Every earlier handshake is `GO`; all PR checks pass; migration review signed off; rollback target identified.

- [ ] Merge only reviewed PR heads with their task manifest/review files.
- [ ] Deploy through `scripts/deploy.sh`; do not use manual build/restart shortcuts.
- [ ] Record production HEAD, BUILD_ID, deploy evidence JSON, systemd state, disk/online BUILD_ID equality and journal error count.
- [ ] Run authenticated UAT with uniquely prefixed Leads. Required matrix:
  - no contact cannot advance;
  - quality only cannot advance;
  - one complete contact plus quality unlocks but does not auto-advance;
  - future contact time rejected in UI and API;
  - every milestone transition without note rejected;
  - every 1–7 transition with note works and writes readable Timeline content once;
  - duplicate click/retry does not duplicate contacts, milestones or events;
  - contact edit, Project Info and Next Required Action survive refresh;
  - delete disappears immediately after success;
  - import/duplicate import/archive/restore all meet Task 0;
  - role and Dashboard matrix meets Task 4.
- [ ] Archive every UAT fixture by exact ID and record the archive batch.
- [ ] Run smoke, log scan, typecheck/test/build evidence, then stop for final Codex release decision.

## Explicitly Forbidden for Hermes

- Do not choose or reinterpret business rules.
- Do not mark a milestone complete automatically.
- Do not make quality immediately mandatory after first contact.
- Do not implement only front-end validation for a server/business rule.
- Do not broaden a PR outside the current task's file list.
- Do not change `TASKBOARD.md`, `SPEC.md`, deployment scripts, coding-auth scripts, RLS policies or production data unless the task specifically requires it and Codex returns written `GO`.
- Do not merge, deploy, apply migration, clear stashes, drop backups, force push, reset or use `--no-verify` without a specific Codex release instruction.

## Required Report Format for Each Handshake

```text
Task:
Commit / PR:
Exact changed files:
RED test evidence:
GREEN test evidence:
Full test/typecheck/lint/build:
CI URL and status:
Migration status (if any):
UAT fixture IDs / archive batch:
Observed API responses:
Runtime logs / errors:
Known risks:
Requested Codex decision: GO / NO-GO
```

## Plan Self-Review

- Covers every reported workflow defect, source requirement, dashboard requirement, import/archive requirement, deployment and evidence requirement.
- Separates independent subsystems into reviewable tasks and prohibits unreviewed production actions.
- Every task has files, contracts, tests and an explicit handshake.
