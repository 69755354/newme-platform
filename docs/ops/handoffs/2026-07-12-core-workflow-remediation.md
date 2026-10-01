# Hermes Handoff — Core Workflow Remediation

**Purpose:** This is the durable GitHub handoff packet for NewMe CRM work. It is the canonical entry point when a Codex session stops, is rate-limited, or is replaced.

**Status at 2026-07-12:** Planning and remote audit complete. No business-code changes, PR merges, production deployments, or production data mutations have been performed by this handoff branch.

## Read Order

1. Read this file completely.
2. Read [the implementation plan](../plans/2026-07-12-core-workflow-remediation.md).
3. Inspect the current GitHub state of `main` and PR #3–#7. Do not rely on any local/server worktree for release truth.
4. Read the newest checkpoint below.
5. Execute only the stated next action after re-checking its prerequisites.

## Confirmed Business Rules

### First Contact / Lead Detail

- Leaving `new`, including direct `won` or `lost`, requires at least one complete contact record and assessed Quality.
- Complete contact means `contact_time IS NOT NULL` and `btrim(contact_result) <> ''`.
- Quality must be `good`, `normal`, or `poor`.
- Three contacts are a coaching target only; they are never a hard stage gate.
- Quality becomes selectable after the first complete contact.
- Timeline contact records must have an authorized edit path, persisted readback, and a visible refreshed result.
- A complete contact insert or edit must create exactly one `first_contact` milestone. Repeated writes must not duplicate it.

### Tanya Operations

- Historical and future `meta_ads` values become `ins`.
- Selectable Lead sources: `ins`, `fb`, `show_room`, `whatsapp`, `website`, `offline`, `referral`, `other`, `unknown`.
- Emirate, Area, Customer Budget, and Next Action must persist on blur or Enter and survive refresh.
- Do not add a separate Showroom lead field; Show room is a source option.

### L1/L2/L3 Sales Review

- The review defaults to Dubai/GST Today.
- One shared range drives L1, L2, and L3: Today, This week, Last week, This month, Custom.
- The existing top finance/KPI cards are not changed by this review range.
- `boss`, `admin`, and `operator` see the team review; `sales` receive only personal L1/L2/L3 data from the API.
- Tanya is `boss`; Sam is `admin`. Before release, verify Ayana is `operator`; do not hardcode personal names or UUIDs.

## Remote PR Snapshot

| PR | Purpose | State | Required next condition |
|---|---|---|---|
| #5 | Excel headers and Quality/source preservation | Draft, Open, mergeable | Verify current CI then merge first |
| #7 | Workbook import idempotency | Draft, Open, stacked on #5 | Retarget to new `main`, rerun CI, staging migration/duplicate-import test |
| #3 | First Contact, contact editing, stage notes | Draft, Open, mergeable | Add missing milestone linkage, complete-contact consistency, behavior tests; rebase/rerun CI |
| #4 | Weekly review owner attribution / UUID removal | Draft, Open, mergeable | Merge before Today review feature |
| #6 | Archive preview and rollback safety | Draft, Open, mergeable | Merge last in the requested sequence |

Required existing-PR merge order:

```text
#5 → #7 → revised #3 → #4 → #6
```

## Known Findings That Must Not Be Lost

- PR #3 already moves the hard gate from three contacts to one complete contact plus Quality, and adds a Timeline edit endpoint.
- PR #3 is not ready unchanged: contact creation is client-side/sequential, does not create `first_contact` milestone, and Stage/Quality checks can count whitespace-only `contact_result` differently from the database trigger.
- Current `main` Lead Detail text fields save only on Enter; blur discards the draft. This explains Tanya's Emirate/Area/Budget and Next Action reports.
- Current `main` review API uses only `this_week`, `last_week`, and `this_month`; it needs Today/custom GST ranges.
- Current `main` weekly review hardcodes sales UUIDs. PR #4 removes that behavior and must precede the Today review work.
- Staging evidence exists historically for migrations but the exact linked database identity must always be recorded; never label an unverified database “staging” or “production.”

## Required Verification Matrix

Before any production release, obtain and record:

- Current `main` SHA and each merged PR SHA.
- GitHub CI results on each final merge head.
- Migration names and raw `supabase db push --linked` output, including linked-project identity.
- Lead counts before/after source migration and duplicate import.
- First Contact positive and negative UI/API/DB tests.
- Timeline edit/readback and milestone count.
- Lead Detail field save/refresh readback.
- Dashboard Today/Week/Month/Custom totals against GST database counts.
- Team-view versus sales-view authorization checks.
- System/app log errors and explicit rollback commit.

## Prohibited Actions

- No `git reset --hard`, `git clean`, force push, or `--no-verify`.
- No production deploy, migration, or data mutation without explicit release authorization.
- No hardcoded profile UUID/name authorization in code.
- No direct client-side bypass of stage/First Contact server and database gates.
- No claim that Draft PR CI proves staging or production business acceptance.

## Hermes Continuation Protocol

1. Post the exact current GitHub commit/PR/CI facts first.
2. Update the `## Checkpoints` section in this file in the same commit as any handoff-relevant change.
3. Use this exact checkpoint template:

```markdown
### YYYY-MM-DD HH:mm GST — <short task>
- GitHub main:
- Branch / PR:
- Changed files:
- Tests / CI:
- Staging evidence:
- Production action: none | exact action
- Decision:
- Next single action:
- Blocker:
```

4. If a task changes scope or a business rule, update the implementation plan and this handoff file before coding.
5. If work stops, leave the branch/PR untouched and append a checkpoint; do not summarize from memory in chat only.

## Checkpoints

### 2026-07-12 — Initial durable handoff
- GitHub main: remote default branch `main`; inspect latest SHA before any work.
- Branch / PR: `docs/core-workflow-remediation-plan-20260712`; documentation-only handoff PR pending creation.
- Changed files: documentation only.
- Tests / CI: remote CI previously observed green for Draft PR #3–#7; recheck every final head.
- Staging evidence: no new staging operation performed by this handoff branch.
- Production action: none.
- Decision: use the implementation plan and this file as the handoff source of truth.
- Next single action: inspect PR #5 current CI and its patch against current `main` before making it Ready.
- Blocker: no implementation authorization or staging credentials are contained in this document.


### 2026-07-12 23:10 GST — PR #5 controlled merge
- GitHub main: `1bc919995bb5ea4696294d64c15eb2c4632d2a77` (PR #5 merge commit).
- Branch / PR: PR #5 is merged; PR #7 remains Draft and stacked on the former PR #5 branch.
- Changed files: `src/app/api/leads/import/confirm/route.ts`, `src/app/api/leads/import/preview/route.ts`, `tests/security/lead-import-contract.test.mjs` via PR #5.
- Tests / CI: PR #5 head CI run `29160426946` completed with `success` before merge.
- Staging evidence: no staging migration or import performed in this checkpoint; #5 contains no migration.
- Production action: no deploy and no production data mutation.
- Decision: merge #5 first as required; #7 must be retargeted to current `main` and receive a fresh CI result before any merge.
- Next single action: retarget PR #7 to `main`, inspect its updated head, then wait for fresh CI.
- Blocker: staging credentials/project identity are still required before #7 migration acceptance.


### 2026-07-12 23:12 GST — PR #7 retargeted
- GitHub main: `1bc919995bb5ea4696294d64c15eb2c4632d2a77`.
- Branch / PR: PR #7 base changed from `fix/crm-import-quality-and-headers` to `main`; current head remains `2d891f1d2eef6554c5b9f8de3331abd0e75adb4e`.
- Changed files: PR metadata only; no business-code change.
- Tests / CI: old CI is insufficient after retarget; wait for new PR #7 CI.
- Staging evidence: pending; required because #7 includes `20260712000000_add_lead_import_fingerprint.sql`.
- Production action: none.
- Decision: do not merge #7 until fresh CI and staging idempotency acceptance are recorded.
- Next single action: revise PR #3 First Contact milestone linkage and complete-contact consistency while #7 CI runs.
- Blocker: staging credentials/project identity still unavailable for #7 acceptance.


## Checkpoint — 2026-07-13 First Contact continuation

- PR #5 is merged to `main` at `1bc919995bb5ea4696294d64c15eb2c4632d2a77`.
- PR #7 is retargeted to that `main`; its current head `2d891f1d2eef6554c5b9f8de3331abd0e75adb4e` passed CI run `29160900842`. Do **not** merge it before its staging migration and duplicate-import acceptance evidence exist.
- Revised PR #3 head is `9745b6ab55ac21030a81ed78099354920395f435`. It now has the server-owned contact-create route, a complete-contact milestone migration, shared trimmed contact checks, and the client structured-contact handler uses `POST /api/leads/:id/contacts` with refresh readback.
- PR #3 CI run `29203458423` is in progress at this checkpoint. Do not merge or deploy until it passes and the First Contact staging matrix is recorded.
- No production deployment, production migration, rollback, force push, reset, or local/server worktree has been used as release evidence.


## Checkpoint — 2026-07-13 CI and Tanya source taxonomy

- Revised PR #3 head `9745b6ab55ac21030a81ed78099354920395f435` passed full CI run `29203458423`, including Taskboard, schema, Supabase boundary, TypeScript, tests, and build. It remains Draft and cannot merge until the documented staging First Contact matrix passes.
- PR #7 current head `2d891f1d2eef6554c5b9f8de3331abd0e75adb4e` passed retargeted CI run `29160900842`; it remains blocked on staging migration and duplicate-import evidence.
- New Draft PR #9 (`fix/tanya-lead-source-taxonomy`) head `cf1efec26fda2acdf0c0f3b11df96a4a7bef4734` passed full CI run `29203884136`. It replaces selectable `meta_ads` with `ins`, `fb`, and `show_room`; normalizes these source aliases in both import endpoints; and includes `20260712000001_replace_meta_ads_source.sql` with only `meta_ads → ins`.
- PR #9 must remain Draft until the controlled merge order and staging source-count evidence are complete. No staging or production mutation was performed by Codex.


## Checkpoint — 2026-07-13 completed remote code gates

- PR #10 (`3f5c2df5a9be180ddad7497cfeca18f30be9d4d2`) passed full CI: Lead Detail Emirate, Area, Customer Budget, and Next Action now commit on blur or Enter and retain readback safeguards.
- PR #11 (`60638c3b692e8db8412583d92dc8ebfd8b54ee0a`) passed full CI run `29205761768`: GST Today is the review default; This week, Last week, This month, and valid Custom ranges are available; range state is preserved in the URL; sales receives owner-scoped L1/L2/L3 data from the server.
- Do not mark any remote PR as deployed or merge migration-bearing PRs until staging evidence is recorded. The remaining controlled order from current main is: #7, revised #3, #4, #6, #9, #10, then #11 after #4.
- The only remaining delivery gate that cannot be completed from GitHub alone is authenticated staging verification plus migration/role evidence. Required credentials or a configured staging environment are needed; no production operation has been attempted.
