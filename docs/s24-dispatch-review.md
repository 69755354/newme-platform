# S24 - Lead dispatch states, phone review and duplicate review (parity gaps G2 and G3)

Status: design for review. Nothing here is deployed. Production is not touched by this document or by the
branch that carries it. Source of the gaps: `OS-PARITY-20261119.md` (items 5, 6, 8, 9, 11 and sections G2, G3).

## Purpose

In the Drive workbook the administrator works the Lead Allocation sheet: every new lead gets a Dispatch status
(Delivered, Missing intake data, Review phone, Unassigned, Duplicate review, Duplicate - not dispatched,
Excluded - test), a Routing note, a Review decision with Review notes, and a Duplicate of pointer. The OS only
refuses a duplicate when a person types a new lead in; leads that arrive from the Meta form, WhatsApp or an
import are never checked. The end state decided by Sam is that everybody works inside the OS and Drive is
retired, so this batch gives the administrator the same decisions inside the OS.

## Scope and safety

* Additive only: three new tables and eight new routines. No existing table, column, policy, trigger or function
  is changed. No column is added to `public.leads`; the leads table and its write path are not touched.
* The dispatch state is a separate row per lead (`public.lead_dispatch_state`). It is derived data plus the
  administrator's decisions. Deleting the table would lose decisions but never a lead.
* This feature does not send Meta feedback and does not write to `whatsapp_capi_events` or any `meta_*` table.
  A dispatch state never changes the lead stage, the owner, the quality fields or the follow-up fields.
* Nothing here assigns or reassigns a lead. Assignment keeps going through the existing assignment route; the
  dispatch state only reports it. The batch creates no notification.
* No hook is added to the lead creation route, the assignment route or the WhatsApp webhook. New and changed leads
  are picked up by a bounded sweep (see "Keeping the state current"). The application cannot run the whole-table
  backfill: that is a script run by the release gate, not in the application.
* The interface labels Show room, FB and ins stay in English in both languages; nothing in this change translates them.

## The seven states

| state (stored) | label | meaning |
|---|---|---|
| `delivered` | Delivered | complete, phone fine, no open duplicate, has a sales owner: nothing left for the administrator |
| `unassigned` | Unassigned | complete and clean but nobody owns the lead yet |
| `missing_intake_data` | Missing intake data | a required field is empty; `missing_fields` lists which |
| `review_phone` | Review phone | the number cannot be read as a phone number, or looks wrong (see below) |
| `duplicate_review` | Duplicate review | an older lead has the same phone, e-mail or Meta lead id and nobody has decided yet |
| `duplicate_not_dispatched` | Duplicate - not dispatched | the administrator decided the lead is a duplicate (or invalid); it is not worked as a new lead |
| `excluded_test` | Excluded - test | a test record; never dispatched and left out of the dispatch counts |

### Transitions and who may cause them

| from | to | caused by |
|---|---|---|
| (none) | any state | evaluation (`evaluate_lead_dispatch`), run by the sweep or by a decision |
| `missing_intake_data` | next state in order | the field is filled in (evaluation) or an administrator releases it with a written reason (`release_missing`) |
| `review_phone` | next state in order | the number is corrected (evaluation) or an administrator confirms the number (`confirm_phone`) |
| `duplicate_review` | `duplicate_not_dispatched` | administrator resolves the review as `merged` or `invalid` |
| `duplicate_review` | next state in order | administrator resolves the review as `kept_separate`, or the candidate disappears (number edited) |
| `duplicate_not_dispatched` | `duplicate_review` | administrator reopens the review (`reopen_duplicate_review`) |
| any | `excluded_test` | administrator marks the lead as a test (`mark_test`), or the name or e-mail matches the test pattern |
| `excluded_test` | next state in order | administrator says "not a test" (`unmark_test`), which also stops the automatic pattern from applying |
| `unassigned` | `delivered` | somebody assigns the lead (evaluation sees the owner) |
| `delivered` | `unassigned` | the owner is removed |

"Next state in order" means the evaluation order below is run again; the state is never set by hand to a value
the rules would not produce, except `duplicate_not_dispatched` (the duplicate decision) and `excluded_test`
(the test mark), which are decisions.

## Automatic evaluation

`public.evaluate_lead_dispatch(lead_id)` reads the lead and writes (or keeps) its state row. Same input gives the
same state; running it twice changes nothing but the evaluation time. It never touches the lead.

Evaluation order (the first rule that applies wins):

1. Archived lead: no state is written and the function answers `skipped`. Archived leads do not take part in
   duplicate matching either.
2. `excluded_test`: the administrator marked it (`test_mark = manual`), or `test_mark` is empty and the customer
   name starts with a test word (test, testing, demo, qa, or the Chinese word for test) or the e-mail ends with a
   reserved test domain.
3. `duplicate_not_dispatched`: a duplicate review of this lead is resolved as `merged` or `invalid`.
4. `missing_intake_data`: the customer name has fewer than two characters, or there is neither a phone nor an
   e-mail, or the lead has no receive time (`first_touch_at`, else `created_at`), or no source. Skipped when the
   administrator released the lead (`release_reason` present).
5. `review_phone`: a phone is present and `dispatch_phone_flag` is not `ok`: `invalid` (cannot be normalised by the
   same rules as `src/lib/lead-contact.mjs`) or `suspect` (six or more equal digits in a row, or an ascending or
   descending run of nine digits). Skipped when the same normalised number was confirmed by an administrator
   (`phone_confirmed_norm`); a different number is reviewed again.
6. `duplicate_review`: an open duplicate review exists, or evaluation finds an older, non-archived, non-test lead
   with the same normalised phone, the same e-mail (case-insensitive) or the same Meta lead id (today the leads table also holds that id unique, so this match is a second line of defence), and the pair has
   not already been decided as `kept_separate`. Only the newer lead of a pair is flagged, so the original is never
   put in the queue by its own duplicate. A new pending review is created in the same transaction.
7. `unassigned`: the lead has no owner.
8. `delivered`.

`routing_note` is a short system sentence naming the reason (for example "missing: customer_name"). It is
rewritten on every evaluation and never edited by people; `admin_note` is the administrator's free text.

Segment (B2B or B2C) is not a required field in this version: the OS lead has no such column and adding one to
the leads table is outside this batch. It is listed as an open question for the owner.

## Phone check

`public.dispatch_phone_norm(text)` returns the E.164 form or null. It mirrors `normalizePhone` in
`src/lib/lead-contact.mjs` (UAE rules: mobile 5XXXXXXXX, landline 8 digits, stray trunk zero removed; other
countries kept when they have 8 to 15 digits). `public.dispatch_phone_flag(text)` returns `empty`, `invalid`,
`suspect` or `ok`. A test in the repository runs both implementations on the same list of numbers.

## Duplicate review

One row per reviewed lead in `public.duplicate_reviews`.

| column | notes |
|---|---|
| `lead_id` | the newer lead, the one in question |
| `duplicate_of_lead_id` | the original, the oldest of the matching leads; never the lead itself |
| `candidate_ids` | every matching lead id found at the time |
| `matched_on` | any of `phone`, `email`, `meta_leadgen_id` |
| `decision` | `pending` (default), `merged`, `kept_separate`, `invalid` |
| `notes` | required (at least 5 characters) for `invalid` and for `kept_separate` |
| `decided_by`, `decided_at` | stamped by the routine when the decision is not `pending` |

The three decisions, in plain words:

* `merged` ("it is the same customer"): the lead is linked to the original through `duplicate_of_lead_id` and
  becomes Duplicate - not dispatched. Nothing is copied or deleted in this version: the administrator moves any
  useful information by hand and the link keeps the history. A field-level merge is a later step.
* `kept_separate` ("two different customers"): the pair is remembered, so it is never flagged again; the lead moves on.
* `invalid` ("not a real lead"): needs a written reason; the lead becomes Duplicate - not dispatched.

Rules in the database: at most one `pending` review per lead; `decision` other than `pending` needs `decided_by`
and `decided_at`; the original must differ from the lead. `resolve_duplicate_review(review_id, actor, decision,
notes)` checks the actor role, locks the review, writes the decision and re-evaluates the lead in one transaction;
deciding the same thing twice changes nothing. `reopen_duplicate_review(review_id, actor, reason)` sets a decided
review back to `pending` and writes an event. No lead is archived, merged or deleted by any decision.

## Other administrator decisions

`public.dispatch_decide(lead_id, actor, action, reason)`:

| action | effect | reason |
|---|---|---|
| `confirm_phone` | stores the current normalised number as confirmed | optional note |
| `release_missing` | lets a lead with missing data move on (the Drive "initial hand-over" exception) | required, at least 10 characters |
| `revoke_release` | removes the release | optional |
| `mark_test` | `test_mark = manual` | required |
| `unmark_test` | `test_mark = not_test` | required |
| `note` | writes `admin_note` only | the note |
| `reevaluate` | runs the evaluation again | none |

Each routine re-checks that the actor is an active admin, boss or operator, inside the routine.

## Data model

### `public.lead_dispatch_state`

One row per lead (`lead_id` primary key, references `leads`, removed with the lead). Columns: `status` (the seven
values, check constraint), `missing_fields` text array, `phone_norm`, `phone_flag`, `phone_confirmed_norm`,
`test_mark` (null, `manual`, `not_test`), `release_reason`, `release_by`, `release_at`, `routing_note`,
`admin_note`, `decided_by`, `decided_at`, `evaluated_at`, `created_at`, `updated_at`. A release needs a reason of
at least 10 characters (check constraint). Index on `status` for the queue.

### `public.duplicate_reviews`

As above. Unique index on `lead_id` where `decision = 'pending'`; index on `duplicate_of_lead_id`.

### `public.lead_dispatch_events`

Append-only history: `lead_id`, `kind` (`status`, `decision`, `duplicate`), `from_status`, `to_status`, `actor`
(null for the system), `note`, `created_at`. Written only by the routines, one row per status change and per
decision. Nobody can update or delete rows through the clients.

## Row-level security

Row-level security is enabled on all three tables. Browsers never write: `insert`, `update` and `delete` are
revoked from every client role, and the service role has no write grant either; every write goes through the
routines, which run with a pinned search path, check the actor, and are callable by the service role only.
Reads from a client session:

* admin, boss and operator: every row. admin and boss are equal; nothing in this change restricts admin below boss.
* sales may read only their own leads' state: only the state of leads that are theirs (`public.is_my_lead(lead_id)`), read only. They get no row of
  `duplicate_reviews` or `lead_dispatch_events`, because those name other customers' leads.
* designer and finance: no rows.
* Every policy wraps the session check as `(select public.session_token_is_current())`, as the repository rule requires.

## API and screens

* `GET /api/dispatch/queue?status=...` (admin, boss, operator): leads grouped by state with counts, newest first,
  page size 50, only the fields the administrator needs (no free-text notes of the customer).
* `GET /api/dispatch/{leadId}`: the state of one lead (staff: any lead; sales: their own lead only, without the
  duplicate details).
* `POST /api/dispatch/{leadId}/decide`: one of the actions above.
* `POST /api/dispatch/refresh`: evaluates the leads created or changed in the last seven days that have no state
  or a stale one, at most 100 per call. It is not a backfill.
* `GET /api/duplicates` (pending by default), `GET /api/duplicates/{id}` (both leads side by side),
  `POST /api/duplicates/{id}/resolve`, `POST /api/duplicates/{id}/reopen`.
* `GET /api/cron/dispatch-sweep`: answers Disabled unless `DISPATCH_SWEEP_ENABLED=true`; calls
  `sweep_lead_dispatch`. No timer is installed by this change.
* Page `/dispatch`: the administrator workbench, one tab per state with a count, a row per lead, a one-click panel
  for the allowed actions. Lead detail page: a small dispatch label next to the stage.
* Role checks run before any service-role query. A missing table (batch not provisioned yet) is a 503 with a
  stable code and the pages show an "unavailable" state instead of failing.
* Strings exist in both English and Chinese files, in a separate block at the end of each language.

## Keeping the state current

* New leads from the Meta form, WhatsApp, the website and imports are all just rows in `public.leads`; one
  evaluation covers them all. WhatsApp leads created by the S18 routine therefore enter the same judgement as soon
  as they are swept; nothing in the WhatsApp webhook or in the S21 follow-up monitor changes.
* `sweep_lead_dispatch(since, limit)` evaluates (a) leads created since `since` that have no state and (b) state
  rows whose lead changed after the last evaluation (for example a new owner or a corrected number). The
  `refresh` route and the disabled cron route call it with a seven-day window and a small limit.
* The first fill of the whole table (every existing lead) is a backfill: `scripts/s24-dispatch-backfill.sql` runs
  the same sweep in batches with a pause between them, dry-run by default, and is executed by the release gate
  after the migration is provisioned. It is not in the application and no button starts it.
* A lead that was released or decided keeps its decision when the sweep runs again.

## Mapping from the Drive sheet (column names only)

Dispatch status -> `lead_dispatch_state.status`; Routing note -> `routing_note` and `admin_note`; Missing intake
data -> `missing_fields`; Review phone and Review decision / Review notes for the phone -> `phone_flag`,
`phone_confirmed_norm`, and the decision events; Duplicate review, Duplicate of, Review decision, Review notes ->
`duplicate_reviews`; Excluded-test / Test record -> `test_mark` and `excluded_test`.

## Rollout order

1. Merge the application pull request. Until the batch is provisioned the pages and the lead-page label show
   "unavailable" and the routes answer 503 with a stable code.
2. Merge the switch pull request ("Provisioning switch for the S24 database batch").
3. Release both together; run `newme-deploy db-transition <sha> <run> s24-db-plan`, review the plan, then
   `s24-db-provision`. The migration is additive and safe to run twice. Its version is later than the S21 and S23
   batches, so those applications are released first.
4. After provisioning, the gate runs the backfill script (dry-run first) and the administrator opens `/dispatch`.
5. Leave `DISPATCH_SWEEP_ENABLED` unset until the workbench has been used for a few days.

Rollback: stop using the pages; the tables are inert without them and the sweep route stays disabled. A manual
undo of the schema is written at the end of the migration file and is only for an empty test database.

## Open questions for the owner

* Is the B2B or B2C segment still wanted as a required field, and where should it live?
* Should a `merged` decision later copy fields from the duplicate into the original, or stay a link?
* Should the sweep run on a timer once the workbench is in daily use?
