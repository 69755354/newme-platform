# Core Workflow Remediation — Lead Detail & Tanya Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Lead Detail business workflow, implement Tanya's source and save requirements, and make L1/L2/L3 operational reporting default to Dubai “Today” with server-enforced visibility.

**Architecture:** Keep the existing Next.js App Router and Supabase pattern. Use a single server-authoritative definition of a complete contact, a server-owned contact creation path, and a database trigger for the idempotent `first_contact` milestone. Keep one review-range request feeding L1/L2/L3; enforce the caller's data scope in the API before returning rows.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase/Postgres, Node test runner, Playwright staging smoke.

## Global Constraints

- GitHub `main` is the source of truth; do not use a local or server worktree as release evidence.
- No direct production data update, migration, deploy, or rollback during implementation.
- Use Dubai/GST (UTC+4) for every Today and custom-date boundary.
- Do not hardcode Tanya, Ayana, Sam, names, emails, or UUIDs in application code.
- `boss`, `admin`, and `operator` receive the team review scope; `sales` receives only its own rows.
- A contact is complete only when `contact_time IS NOT NULL` and `btrim(contact_result) <> ''`.
- One complete contact plus assessed quality (`good`, `normal`, or `poor`) is the only gate for leaving `new`; three contacts remain a UI coaching target.
- Preserve existing `Meta Ads` records only through the explicit migration `meta_ads → ins`; no code fallback should retain it as a selectable source.
- Keep the existing top-level finance/KPI cards unchanged; the Today filter applies only to L1/L2/L3 review.
- Run the repository gates before each merge; no `--no-verify`, force push, reset, or direct production mutation.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx` | Source selection values shown in Lead Detail. |
| `src/lib/i18n/translations.ts` | Labels for `ins`, `fb`, and `show_room`; removal of selectable `meta_ads` label. |
| `src/app/api/leads/import/preview/route.ts` | Normalize Tanya workbook source variants to canonical values. |
| `src/app/api/leads/import/confirm/route.ts` | Revalidate canonical imported source before insertion. |
| `supabase/migrations/20260712000001_replace_meta_ads_source.sql` | One-way historical `meta_ads → ins` data migration. |
| `src/app/(dashboard)/leads/[id]/page.tsx` | Save text fields and Next Action on blur without duplicate Enter save. |
| `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts` | Replace client contact write with owned server request and surface readback failures. |
| `src/app/api/leads/[id]/contacts/route.ts` | Authorized structured-contact creation endpoint. |
| `src/app/api/leads/[id]/contacts/[contactId]/route.ts` | Existing authorized contact edit path; retain and verify readback. |
| `supabase/migrations/20260712000002_first_contact_milestone_link.sql` | Idempotent database milestone linkage for complete contact insert/update. |
| `src/app/api/leads/[id]/quality/route.ts` | Apply the same trimmed complete-contact rule before Quality changes. |
| `src/app/api/leads/[id]/stage/route.ts` | Apply the same trimmed complete-contact rule before stage changes. |
| `src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx` | Today/default/custom range controls and role-appropriate L1/L2/L3 rendering. |
| `src/app/(dashboard)/dashboard/page.tsx` | Own review range state and render the review for management and sales. |
| `src/app/api/dashboard/weekly-review/route.ts` | GST period bounds, custom range validation, role-scope filtering, owner attribution. |

## Task 1: Merge-ready import baseline (#5 then #7)

**Files:**
- Modify: PR #5 and PR #7 metadata/base branches only.
- Verify: `src/app/api/leads/import/preview/route.ts`, `src/app/api/leads/import/confirm/route.ts`, `supabase/migrations/20260712000000_add_lead_import_fingerprint.sql`.

**Interfaces:**
- Produces: import confirmation response containing `imported`, `skipped_duplicates`, `failed`, and `errors`.
- Consumes: the existing normalized workbook row contract.

- [ ] Mark PR #5 ready only after reviewing its CI result against current `main`.
- [ ] Merge PR #5 to `main`.
- [ ] Retarget PR #7 from `fix/crm-import-quality-and-headers` to `main`, resolve only import-route conflicts, and rerun CI.
- [ ] In staging, apply `20260712000000_add_lead_import_fingerprint.sql`.
- [ ] Run an import twice with the same fixture:
  ```text
  first response: imported > 0
  second response: imported = 0, skipped_duplicates = first imported
  total lead count delta after second import = 0
  ```
- [ ] Record pre/post lead count, both response payloads, and migration output.
- [ ] Commit/merge evidence: PR #5 then PR #7 only after their current-head CI is green.

## Task 2: Tanya source taxonomy and historical conversion

**Files:**
- Modify: `src/app/(dashboard)/leads/[id]/LeadCustomerProfile.tsx`
- Modify: `src/lib/i18n/translations.ts`
- Modify: `src/app/api/leads/import/preview/route.ts`
- Modify: `src/app/api/leads/import/confirm/route.ts`
- Create: `supabase/migrations/20260712000001_replace_meta_ads_source.sql`
- Test: `tests/security/lead-source-taxonomy.test.mjs`

**Interfaces:**
- Canonical persisted source values: `ins`, `fb`, `show_room`, `whatsapp`, `website`, `offline`, `referral`, `other`, `unknown`.
- Migration contract: all existing `leads.source = 'meta_ads'` become `'ins'`; no other source value changes.

- [ ] Write the failing taxonomy test:
  ```js
  assert.equal(sourceOptions.includes("meta_ads"), false);
  for (const value of ["ins", "fb", "show_room"]) {
    assert.ok(sourceOptions.includes(value));
  }
  ```
- [ ] Write the failing migration assertion that requires:
  ```sql
  UPDATE public.leads
  SET source = 'ins'
  WHERE source = 'meta_ads';
  ```
- [ ] Replace `meta_ads` in the selectable source list with `ins`, `fb`, and `show_room`; add bilingual labels.
- [ ] Extend workbook source normalization so `Instagram`/ `ins`, `Facebook`/ `fb`, and `Show room`/ `show_room` persist as the canonical values.
- [ ] Add the data migration; it must update only `source = 'meta_ads'` rows and reload PostgREST schema.
- [ ] Run the source tests and repository typecheck.
- [ ] In staging, record:
  ```text
  SELECT source, count(*) FROM leads
  WHERE source IN ('meta_ads', 'ins', 'fb', 'show_room')
  GROUP BY source;
  ```
  before and after migration. Expected postcondition: `meta_ads = 0`.

## Task 3: Lead Detail save/readback for Tanya fields

**Files:**
- Modify: `src/app/(dashboard)/leads/[id]/page.tsx`
- Modify: `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts`
- Test: `tests/security/lead-detail-save-contract.test.mjs`
- Staging test: `e2e/lead-detail-tanya-fields.spec.ts`

**Interfaces:**
- Text save fields: `emirate`, `area`, `customer_budget`.
- Next Action save target: current lead task `title`; when none exists, existing `createFollowUpTask` behavior creates one.
- A committed value must be returned from the database and survive refresh.

- [ ] Write the failing UI regression tests for blur commits:
  ```text
  edit Emirate → blur → reload → stored Emirate equals submitted value
  edit Area → blur → reload → stored Area equals submitted value
  edit Customer Budget → blur → reload → stored Budget equals submitted numeric value
  edit Next Action → blur → reload → task title equals submitted value
  ```
- [ ] Add one page-owned commit helper used by Enter and blur. It must compare the draft to the original value, call the existing mutation once, and ignore an unchanged or blank Next Action draft.
- [ ] Make text inline editing call that helper on blur and Enter; prevent the Enter key from firing a second blur save.
- [ ] Make Next Action use the same commit-on-blur behavior; preserve its existing creation behavior if there is no task.
- [ ] Keep `customer_budget` numeric: reject non-finite input before update and store a number or null, never a raw string.
- [ ] Run the focused test, typecheck, and lint.
- [ ] Run staging UI readback with a test lead, recording request status and database values before/after.

## Task 4: First Contact business closure before PR #3 merge

**Files:**
- Modify: `src/app/(dashboard)/leads/[id]/LeadSalesProcess.tsx`
- Modify: `src/app/(dashboard)/leads/[id]/LeadTimeline.tsx`
- Modify: `src/app/(dashboard)/leads/[id]/useLeadDetailMutations.ts`
- Create: `src/app/api/leads/[id]/contacts/route.ts`
- Modify: `src/app/api/leads/[id]/contacts/[contactId]/route.ts`
- Modify: `src/app/api/leads/[id]/quality/route.ts`
- Modify: `src/app/api/leads/[id]/stage/route.ts`
- Create: `supabase/migrations/20260712000002_first_contact_milestone_link.sql`
- Test: `tests/unit/first-contact-gate.test.mjs`
- Test: `tests/security/first-contact-hardening-static.test.mjs`
- Staging test: `e2e/lead-detail-first-contact.spec.ts`

**Interfaces:**
- `POST /api/leads/:id/contacts` accepts `{ contact_method, contact_time, contact_result, summary? }`.
- It returns the persisted contact row.
- A complete contact insert or edit creates exactly one `lead_milestones` `first_contact` row.
- Shared complete-contact predicate is equivalent to `contact_time IS NOT NULL AND btrim(contact_result) <> ''`.

- [ ] Extend the unit gate test with whitespace:
  ```js
  assert.equal(gate({ contactCount: 0, quality: "good" }).allowed, false);
  assert.equal(gate({ contactCount: 1, quality: "poor" }).allowed, true);
  ```
- [ ] Add server endpoint tests for unauthenticated, non-owner, owner, and admin/boss requests.
- [ ] Add a migration trigger that runs after contact insert or relevant update, checks the complete-contact predicate, and inserts `first_contact` only when it does not already exist for that lead.
- [ ] Route structured contact creation through the endpoint; remove the client-side direct `follow_up_logs` insert from the new-contact handler only.
- [ ] Use the same trimmed predicate in Quality and stage checks. Do not count `'   '` as a contact.
- [ ] Keep the Timeline edit entry point; after PATCH, refresh the returned contact and milestone state.
- [ ] Verify in staging:
  ```text
  no contact + no quality → stage blocked
  one complete contact + no quality → stage blocked
  quality + no complete contact → quality blocked and stage blocked
  one complete contact + good/normal/poor → stage allowed
  first and second contact both permit quality selection after the first complete contact
  repeat contact save → one first_contact milestone only
  edit contact → refresh shows persisted edit
  ```
- [ ] Rebase PR #3 onto current `main`, run all required checks, then merge only after this task's staging evidence passes.

## Task 5: Team review period, Today default, custom range, and scope

**Files:**
- Modify: `src/app/api/dashboard/weekly-review/route.ts`
- Modify: `src/app/(dashboard)/dashboard/_components/WeeklyReview.tsx`
- Modify: `src/app/(dashboard)/dashboard/page.tsx`
- Modify: PR #4 files after rebasing to current `main`.
- Test: `tests/unit/dashboard-review-period.test.mjs`
- Test: `tests/security/dashboard-review-scope.test.mjs`
- Staging test: `e2e/dashboard-review-scope.spec.ts`

**Interfaces:**
- Query: `range=today|this_week|last_week|this_month|custom`.
- Custom query: `start=YYYY-MM-DD&end=YYYY-MM-DD`, with end strictly after start.
- API response contains only caller-authorized L2/L3 rows.
- Team scope roles: `admin`, `boss`, `operator`; sales scope: current user only.

- [ ] Rebase and merge PR #4 before implementing Today so L2/L3 attribution is by Lead Owner/profile role rather than fixed UUIDs or action actor.
- [ ] Write failing GST period tests:
  ```text
  today begins 00:00 GST and ends next 00:00 GST
  custom start >= end returns HTTP 400
  custom dates never include events exactly at end
  ```
- [ ] Extend period parsing with `today` and validated `custom`; default the review UI to `today`.
- [ ] Add UI controls: Today, This week, Last week, This month, Custom. Custom exposes start/end date inputs and does not request data until both dates are valid.
- [ ] Keep range state in URL query parameters so reload and copied links preserve the selected range; no local-storage setting is added.
- [ ] For `sales`, apply the current user's owner ID to every L2/L3 query and return a personal L1 aggregate only. Never fetch all team rows then filter in the browser.
- [ ] For `admin`, `boss`, and `operator`, return all eligible sales rows. Tanya is covered by `boss`; Sam by `admin`; Ayana must be verified as `operator` during staging preflight.
- [ ] Render the review in both management and sales dashboard views, with role-appropriate labels and data.
- [ ] Verify in staging with four identities:
  ```text
  boss/admin/operator → full L1, all L2 sales rows, all authorized L3 rows
  sales → personal L1, exactly one own L2 row, only own L3 leads
  sales request modified with another owner ID → no additional data
  Today/Week/Month/Custom totals match direct database counts in GST
  ```

## Task 6: Controlled release sequence and evidence

**Files:**
- Modify: `TASKBOARD.md` only when each task state changes according to repository rules.
- Verify: PR #5, #7, revised #3, #4, #6 and the new Tanya/Dashboard PRs.

- [ ] Perform a staging preflight: read Ayana's `profiles.role`; expected `operator`. If it is not `operator`, stop before release and obtain an explicit role-configuration decision.
- [ ] Apply migrations in dependency order:
  ```text
  20260712000000_add_lead_import_fingerprint.sql
  20260712000001_replace_meta_ads_source.sql
  20260712000002_first_contact_milestone_link.sql
  ```
- [ ] Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:release`, and `npm run build` on every final merge head.
- [ ] Merge in controlled order:
  ```text
  #5 → #7 → revised #3 → #4 → #6 → Tanya source/save PR → Dashboard Today/scope PR
  ```
  Retarget any stacked or stale PR to current `main` and rerun CI before its merge.
- [ ] Run the staging matrix from Tasks 1–5 and attach commands, HTTP status, before/after counts, response excerpts, and error logs.
- [ ] Define a rollback commit before production release; production rollout remains a separate explicit approval.

## Self-Review

- Coverage: First Contact gates, milestone linkage, contact editing, Tanya source taxonomy, all four save/readback defects, Today/custom review ranges, role scope, PR dependency order, staging and rollback are each assigned to a task.
- No source code is changed by this plan branch.
- Ayana profile verification is an explicit preflight rather than a hardcoded exception.
