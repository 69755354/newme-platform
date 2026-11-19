# S25 WhatsApp coexistence history and contact sync

Meta lets the business request ONE sync of contacts and chat history (up to 180 days) within 24 hours of
coexistence onboarding (`tools/wa_coex_sync.sh contacts|history`). The results arrive on the existing webhook
(`/api/whatsapp/webhook`, alias `/api/meta/whatsapp-webhook`) as two fields. Before S25 the route answered 200 and
dropped them. Nothing here is customer data; the examples are fictional.

## What is stored

| Webhook field | Stored in | Notes |
|---|---|---|
| `history` | `whatsapp_message_events` with `backfilled = true` | direction (`inbound` customer, `outbound` staff = sender is the business number), event time from the payload, S21 text rules (text body up to 4096 characters, media and other kinds keep a marker only), one row per `(waba_id, message_id)` |
| `smb_app_state_sync` | `whatsapp_synced_contacts` (new, server-only) | name and canonical phone key; `action: remove` sets `removed_at` |

Both go through two service-role routines, `record_whatsapp_history_messages` and `record_whatsapp_synced_contacts`
(migration `20261119150000_whatsapp_history_backfill.sql`, additive only).

## What history never does

- No lead is created or changed, no `whatsapp_capi_events` row is queued, no click id is read or written, and nothing is
  sent to Meta. The parser (`src/lib/whatsapp-history.mjs`) never touches the live writer `record_whatsapp_ad_event`.
- No notification and no first-response or follow-up state: the monitor reads `backfilled = false` events only.
- The conversation row is created empty if missing; its timing columns, counts and `lead_id` are not changed.
- Idempotent: a replayed chunk, or a message the live path already stored, is skipped (`on conflict do nothing`). A message
  the live path stores later with the same id is a duplicate there too.
- Only approved enabled channels are read (same checks as the live parser). The 30 day live window and `accept_since` do not
  apply; times must be no older than 200 days and not in the future.

## Operation

- Switch: `WHATSAPP_HISTORY_SYNC_ENABLED=false` makes the route ignore both fields again (answer 200). Default on.
- A failed database write answers 503 so Meta retries the chunk; already stored rows are skipped. The body limit for this
  webhook is now 3 MiB (history chunks are larger than live messages); the signature is checked before parsing.
- Order for release: provisioning switch (`s25-db-plan` / `s25-db-provision`), then this application. The migration (version 20261119150000) sits
  between S21 and S23 on purpose, so the S23 and S24 switches still accept it as part of the live prefix. Provision it before the
  S23 and S24 migrations are applied; if those are applied first, renumber it after them and re-pin the switch.
- Known limit: when the next live message arrives, the existing writer recomputes the conversation counts and the lead's
  `wa_first_inbound_at` / `wa_first_reply_at` from ALL stored events, history included. That reflects the true first contact
  but is not a first-response alert (alerts use the monitor, which skips history).
- Payload shapes follow Meta's coexistence documentation (`history[].threads[].messages[]`, `state_sync[]`); the first real
  delivery should be checked in the logs (the route logs nothing, so check the Meta delivery status and the stored row counts).
