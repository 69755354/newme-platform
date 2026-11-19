# S21 WhatsApp conversation text and follow-up monitor v1 (design)

Status: design for the first version. Nothing here is customer data; every example is fictional.
Owner decision (2026-11-19): customer chat text may be read by the CRM for lead field extraction,
follow-up monitoring and, later, script evaluation. There is no consent gate in this design.
The text must still never reach the public repository, logs, Sentry or any outside service.

## 1. What is stored

- `whatsapp_message_events.body` (text, max 4096 characters) and `body_kind`:
  `text` (body kept), `media` (image, video, audio, document, sticker, location, contacts: marker
  only, no media link, no caption), `other` (reaction, button and similar: marker only).
- Only text messages carry a body. Everything else keeps `body` null. Media links are never stored.
- The table stays server-only (RLS on, no grants to anon or authenticated). The CRM reads text
  through server code that checks the lead owner or an admin, boss or operator role.
- Retention: `retention_days` (default 0 = keep, long term). A positive value makes a future
  maintenance job null out `body` after that many days; the metrics below never need the text.

## 2. Metrics and definitions

All times are stored in UTC and evaluated in the configured time zone (default Asia/Dubai).

| Metric | Definition |
|---|---|
| First inbound | earliest inbound message over all conversations linked to the lead (a customer may write to two business numbers) |
| First reply | earliest outbound message after the first inbound, over all linked conversations |
| First response minutes | minutes between first inbound and first reply, whole minutes, null while no reply |
| Contact event | our outbound messages, merged: messages within `contact_merge_minutes` (default 30) of the previous outbound message of the same lead count as one contact |
| Contact count (5 working days) | contact events inside the window that starts at the lead's first inbound day and covers 5 working days |
| Working calendar | Monday to Friday in Dubai, configurable weekend and holiday list; the window skips non-working days |
| Last outbound | latest outbound message time over all linked conversations |

`first_response_minutes` is stored as raw minutes. The state rules measure elapsed time with non-working days removed (a Friday evening message is not overdue on Saturday), and silence rules apply to the new and contacted stages only; later stages keep the first-response rule alone. Working hours inside a day are not used in v1.

## 3. Follow-up status

States: `normal`, `at_risk`, `overdue`. Evaluated per lead, only for open leads that have at least one
WhatsApp conversation. A lead that is archived, won, lost or marked invalid or duplicate is not
evaluated and keeps its last state (no new notes, no notifications).

Default thresholds (all configurable constants in `src/lib/followup-monitor.mjs`):

| Rule | at_risk | overdue |
|---|---|---|
| First response (customer wrote, nobody replied yet or replied late) | more than 60 minutes | more than 240 minutes |
| New or contacted stage, no outbound message | 24 hours since last outbound (or since first inbound when none) | 48 hours |

The worst rule wins. A first reply that came late stays a recorded fact (first response minutes) but
the state recovers to `normal` once a fresh outbound message exists and no rule is open.

Abandon risk (`abandon_risk` boolean, separate from the state): at most 2 contact events in the
5-working-day window and more than 48 hours since the last outbound.

## 4. State machine and idempotency

`lead_followup_state` holds one row per lead: state, `state_since`, first inbound and reply,
first response minutes, contact count, last outbound, abandon risk. The cron job computes the new
state from the stored events and calls `upsert_lead_followup_state(...)`.

- The function writes the row and reports whether the state changed (`changed`, `previous_state`).
- A system note (activities row) and a notification are written only when the state changes, and the
  recovery to `normal` is written too. The same lead and state never produces a second note,
  because the cron only writes a note when the function says `changed` and the activity key contains
  `lead_id:state:state_since`.
- Abandon risk changes are noted the same way (on first becoming true, and when it clears).
- Re-running the cron any number of times in a row is a no-op.

## 5. Notifications

Recipients: the lead owner (`assigned_to`) and users with the operator role (and not the test accounts).
Types reuse the existing allowed values: `warning` for `overdue` and abandon risk, `reminder` for
`at_risk` and for recovery. No new notification type is added. One notification per recipient per
state change; never repeated while the state is unchanged. The cron processes at most 200 changes per run.

## 6. System note wording

Chinese and English, two lines, for example:
`[系统] 客户 10:05 来信，11:40 才首次回复（超过 1 小时） / [System] Customer wrote at 10:05, first reply only at 11:40 (over 1 hour).`
Times are shown in the configured time zone.

## 7. Field extraction v1 (rules only, no external API)

`src/lib/whatsapp-field-extract.mjs` reads inbound text (Arabic digits and English/Chinese keywords)
and returns candidate fields, each with the source message id and a confidence value:
property type, area in square metres (sqft converted), budget in AED, number of rooms or bedrooms,
under renovation (yes or no), next step (call, visit, quote request). Results are written to the lead
as a note draft ("[Draft] suggested fields"), never straight into lead columns. A person confirms.
Confidence: 0.9 explicit unit and keyword, 0.6 keyword only, below 0.5 dropped. No model calls.

## 8. Rollout

Database: one additive migration (columns, one table, one function, replaced writer). Application:
the webhook stores text only when the S21 columns exist; the cron route `/api/cron/check-whatsapp-followups` answers Disabled until `WHATSAPP_FOLLOWUP_MONITOR_ENABLED=true`, and its timer (hourly 09:30-19:30 Dubai, marked `after-flag`) is installed by the operator. Rollback: stop the cron entry; the new columns and table are unused by older code.
