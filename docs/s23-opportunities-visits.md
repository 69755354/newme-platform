# S23 - Opportunities and visit reports (parity gaps G5 and G6)

Status: design for review. Nothing here is deployed. Production is not touched by this document or by the
branch that carries it. Source of the gaps: `OS-PARITY-20261119.md` (items 20, 21, 23, 24, 25).

## Purpose

The sales Drive workbook keeps two things that the OS has no table for:

* **Opportunities** (the Projects sheet): one row per deal being worked for an existing customer.
* **Visit reports** (the Visit Report sheet): one row per planned or held customer visit, with a plan, an approval,
  an actual result and a review.

The end state decided by Sam is that everybody works inside the OS and Drive is retired. These two tables, their
pages and the lead-page cards are the first block of that parity work. The existing `public.projects` table is the
post-contract delivery project; it is not changed and the two concepts keep separate names.

## Scope and safety

* Additive only: two new business tables, one small configuration table, two functions for the workflow and one
  for the overdue scan. No existing table or function is altered.
* The overdue reminder route exists but answers "Disabled" until `VISIT_OVERDUE_ALERTS_ENABLED=true`; no timer
  is installed by this change.
* This feature does not send Meta feedback and does not write to `whatsapp_capi_events` or `meta_*` tables. Lead stage
  and Meta feedback stay owned by the lead flow; an opportunity stage change never moves the lead.
* No notification is created by creating or editing a record. The only notifications are the overdue reminders
  (existing types `warning` and `reminder`, related type `lead`), created by the disabled-by-default route.
* The interface labels Show room, FB and ins stay in English in both languages; nothing in this change translates them.

## Data model

### `public.opportunity_stages` (configuration)

| column | notes |
|---|---|
| `key` text primary key | lowercase snake case, 2 to 40 characters |
| `label_en`, `label_zh` text | display names |
| `sort_order` integer | display order |
| `requires_quote` boolean | when true an opportunity in this stage must carry a quote amount and a quote link |
| `is_closed` boolean | won, lost and on hold end active work |
| `active` boolean | an inactive stage cannot be chosen for new changes; existing rows keep their value |

Initial values are the union of the stages the OS already uses and the three confirmed from the Drive sheet:
`quotation_sent` (Quotation sent), `negotiation` (Negotiation), `won` (Won), `lost` (Lost), `on_hold` (On hold).
One pre-quote stage, `new` (New), is added because an opportunity is created when the requirement is confirmed
and the quote does not exist yet; without it the quote rule could never be satisfied on creation. The three stages
quotation sent, negotiation and won require the quote. The set is data, not a column check, so operators with the
right role can change it later without a migration.

### `public.opportunities`

| column | notes |
|---|---|
| `id` uuid primary key, `opp_no` identity | `opp_no` gives the short display number (O0001 style) |
| `lead_id` uuid not null | references `leads(id)`; one lead may have many opportunities |
| `name` text not null | 1 to 200 characters; unique per lead ignoring case among non-archived rows (the Duplicate project rule) |
| `confirmed_requirement` text not null | 1 to 4000 characters |
| `stage` text not null default `new` | references `opportunity_stages(key)` |
| `quote_amount_aed` numeric(14,2) | zero or more, below 10 billion |
| `decision_target` date | between 2020-01-01 and 2100-12-31 |
| `quotation_link` text | https address, up to 2000 characters |
| `closed_reason` text | optional note for lost or on hold |
| `owner_id`, `created_by` uuid | `profiles(id)`; the owner is the lead's sales owner unless a manager sets another |
| `created_at`, `updated_at`, `archived`, `archived_at` | rows are archived, never deleted |

Rules enforced in the database (not only in the form):

1. Stage must exist in `opportunity_stages` (foreign key) and be active when it changes.
2. When the stage requires a quote, `quote_amount_aed` and `quotation_link` must both be present (trigger reads the
   stage table, so the rule follows the configuration).
3. Amount, date, text length and link format checks as listed above.
4. Unique `(lead_id, lower(name))` among non-archived rows.
5. Unique `(id, lead_id)` so that a visit can only point at an opportunity of its own lead.

### `public.visit_reports`

| column | notes |
|---|---|
| `id` uuid primary key, `visit_no` identity | |
| `lead_id` uuid not null; `opportunity_id` uuid null | composite foreign key `(opportunity_id, lead_id)` to opportunities, so the opportunity must belong to the same lead |
| `planned_at` timestamptz not null | unique per lead among non-archived rows (the Lead/time key from the sheet) |
| `location`, `person_to_meet` text | up to 300 characters |
| `purpose` text not null | 1 to 2000 characters |
| `plan_approval` text | `pending` (default), `approved`, `rejected` |
| `plan_approved_by`, `plan_approved_at`, `plan_note` | set by the approval step only |
| `actual_start`, `actual_finish` timestamptz | finish not before start |
| `result` text, `next_action` text, `next_followup_date` date, `evidence_link` text | result up to 4000 characters; link must be https |
| `submitted_at` timestamptz | set when the report is handed in; requires an approved plan, both actual times and a result |
| `report_due_at` timestamptz | filled by trigger: 09:30 Dubai time on the next working day after the planned day |
| `review_status` text | `pending` (default), `accepted`, `needs_fix` |
| `reviewed_by`, `reviewed_at`, `review_notes`, `action_done` | set by the review step only |
| `owner_id`, `created_by`, `created_at`, `updated_at`, `archived` | |

The working calendar is Monday to Friday in Dubai (Saturday and Sunday do not count). A configurable holiday
table is a follow-up; the function `public.next_working_day_0930(timestamptz)` is the single place to extend.

### Status (derived, never stored)

`public.visit_report_status(plan_approval, submitted_at, review_status, report_due_at, now)` returns one of:

| status | when |
|---|---|
| `reviewed` | review_status is `accepted` |
| `completed` | submitted and not yet accepted (includes `needs_fix`, shown with its own badge) |
| `overdue` | not submitted, plan not rejected, and now is later than `report_due_at` |
| `approved` | plan approved, not submitted, not yet due |
| `planned` | everything else (plan pending or rejected) |

Order of evaluation is the order of the table. The same rule is written once in SQL and once in
`src/lib/visit-status.mjs`; a test runs both against one list of cases.

### Flow

planned (sales writes the plan) -> approved (operator, boss or admin approves or rejects) -> completed (sales
fills the actual times, result, next action, evidence and submits) -> reviewed (operator, boss or admin accepts or
asks for a fix; a fix reopens editing and the report is submitted again). A rejected plan can be edited and sent
again; editing a plan resets approval to `pending`. Submitting writes the next action and next follow-up date to
the visit only; it does not change the lead (the follow-up panel work, gap G4, will connect them).

## Row-level security

Row-level security is enabled on all three tables. Browsers never write: `insert`, `update` and `delete` are revoked
from every client role, writes go through the server (service role) after the role check, and the two workflow
steps are database functions that re-check the actor's role. Reads from a client session:

* `admin`, `boss`, `operator`: every row. admin and boss are equal; nothing in this change restricts admin below boss.
* `sales`: only rows whose lead is theirs (`public.is_my_lead(lead_id)`), plus rows they own.
* `designer`, `finance`: no rows.
* `opportunity_stages`: readable by every signed-in active user.
* Every policy wraps the session check as `(select public.session_token_is_current())`, as the repository rule requires.

## API and screens

* `GET/POST /api/opportunities`, `GET/PATCH /api/opportunities/{id}`; `GET/POST /api/visits`,
  `GET/PATCH /api/visits/{id}`, `POST /api/visits/{id}/approve`, `POST /api/visits/{id}/review`,
  `POST /api/visits/{id}/submit`. Creating is idempotent without a client key: a retried request that repeats the same name (opportunity) or the
  same lead and planned time (visit) with the same content returns the existing row (`duplicate: true`), a
  different request with the same key is a 409 conflict. Role checks run before any service-role query.
* `GET /api/cron/check-visit-overdue`: disabled unless `VISIT_OVERDUE_ALERTS_ENABLED=true`; calls
  `public.flag_overdue_visit_reports()`, which writes one `warning` notification per recipient per visit
  (`event_key = visit-overdue:<id>`), so running it again changes nothing.
* Lead detail page: an Opportunities card and a Visits card (list plus a small create form).
* `/opportunities` and `/visits`: simple lists with a stage or status filter.
* Strings exist in both English and Chinese files, in a separate block at the end of each language.

## Mapping from the Drive sheets (column names only)

Projects sheet to `opportunities`: Customer -> `lead_id` (picked from existing leads only); Project name -> `name`;
Confirmed requirement -> `confirmed_requirement`; Stage -> `stage`; Quote amount -> `quote_amount_aed`;
Decision target date -> `decision_target`; Quotation / file link -> `quotation_link`; Project check (formula) ->
database rules 2 to 4 above; Duplicate project (formula) -> the unique name rule.

Visit Report sheet to `visit_reports`: Lead/time key -> unique `(lead_id, planned_at)`; Planned time -> `planned_at`;
Location -> `location`; Person to meet -> `person_to_meet`; Purpose -> `purpose`; Plan approval -> `plan_approval`
with `plan_approved_by` and `plan_approved_at`; Actual start / Actual finish -> `actual_start` / `actual_finish`;
Result -> `result`; Next action -> `next_action`; Next follow-up date -> `next_followup_date`; Evidence link ->
`evidence_link`; Review status / Reviewer / Reviewed at / Review notes / Action done -> `review_status`,
`reviewed_by`, `reviewed_at`, `review_notes`, `action_done`; Report due (formula) -> `report_due_at`;
Completeness and Status (formulas) -> `visit_report_status()`; Overdue incomplete -> the `overdue` status.

## Rollout order

1. Merge the application pull request. The new pages and routes call the new tables; until the batch is provisioned
   the lead-page cards and lists show an "unavailable" state instead of failing (the routes map a missing table to
   a 503 with a stable code).
2. Merge the switch pull request ("Provisioning switch for the S23 database batch").
3. Release both together; run `newme-deploy db-transition <sha> <run> s23-db-plan`, review the plan, then
   `s23-db-provision`. The migration is additive and safe to run twice.
4. Leave `VISIT_OVERDUE_ALERTS_ENABLED` unset until the visit pages have been used for a few days; then set it and
   install the timer in a later change.

Rollback: stop using the pages; the tables are inert without them. A manual undo of the schema is written at the
end of the migration file and is only for an empty test database.
