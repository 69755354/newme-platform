# Meta Lead Ads (Instant Form) intake

## Why

Until now no code fetched Instant Form leads. The CRM's Meta token is `ads_read`
only (spend), so form leads reached the CRM only if someone exported a CSV and
imported it. Evidence on 2026-10-26: Meta reported 24 form leads (and 12
WhatsApp conversations) for the last 30 days on account 968615798111277; the
production CRM held 0 leads created in that window and 0 rows with
`meta_leadgen_id`. Without the leadgen id the Conversion Leads feedback
(`docs/meta-crm-lead-events.md`) can never fire.

## What this adds

- `POST /api/meta/leadgen-webhook` — realtime. Meta's Page webhook (`leadgen`
  field) sends only the leadgen id; the handler verifies the raw-body
  `X-Hub-Signature-256` with the App Secret, accepts only allowlisted page ids,
  fetches the lead from Graph (token in the `Authorization` header, never the
  URL), stores it idempotently by `meta_leadgen_id` and queues the CRM "Lead"
  event. Any failure returns 503 so Meta retries; replays are no-ops.
- `GET` on the same path answers Meta's subscription challenge.
- `scripts/meta-leads-pull.mjs` — backfill and reconciliation. Read-only by
  default: lists every form lead on the configured pages for the last
  `--since-days` (default 45, max 90) and prints, per day, Meta's count against
  the CRM's. `--execute` stores the missing ones once and queues their event.
  Output is aggregate counts only.
- Storage rule (`storeMetaLead`): an existing leadgen id is a duplicate; an
  untagged CRM lead with the same phone or email is tagged and only its empty
  attribution fields are filled (existing values are never overwritten);
  otherwise a new lead is inserted. The unique partial index is the race guard.
- Each stored lead carries form, ad, ad set and campaign ids and names, the
  platform (fb / ig → `fb` / `ins`), the lead's real creation time, and the raw
  form answers in `raw_import_data.meta_lead_form.answers` for qualification.

The route is disabled unless every setting below is present; with
`META_LEADGEN_ENABLED` unset it returns 503 and touches nothing.

## Settings (server-only, /etc/newme)

| Variable | Value |
| --- | --- |
| `META_LEADGEN_ENABLED` | `true` to accept deliveries |
| `META_LEADGEN_VERIFY_TOKEN` | random string, also entered in the App's webhook setup |
| `META_APP_SECRET` | the Meta App's secret (signature key) |
| `META_LEADS_ACCESS_TOKEN` | system-user or Page token with `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `ads_management` (Meta requires these for lead access) |
| `META_LEADGEN_PAGE_IDS` | comma-separated Page ids; NEWME Smart Home is `770232832850803` |

## Operator steps (need Sam's click in Meta)

Business 1499096268056690 owns one app, NEWME OS Messaging (2295611971276443),
and the Page NEWME Smart Home (770232832850803). Leads access on the Page is
the default (Page admins and connected CRMs), so no Leads Access change is needed.

1. Business Settings → System users → create "NewMe CRM Lead Intake"; assign the
   Page with lead access and the app; generate a token for NEWME OS Messaging
   with `leads_retrieval`, `pages_show_list`, `pages_read_engagement`,
   `pages_manage_metadata`. The token is shown once: it goes straight into
   /etc/newme as `META_LEADS_ACCESS_TOKEN`, never into chat or a ticket.
2. Deploy this release with `META_LEADGEN_PAGE_IDS=770232832850803`.
3. Dry run: `node scripts/meta-leads-pull.mjs --since-days 45` — Meta's count must
   match Ads Manager (24 form leads for 2026-09-26..10-25).
4. `--execute` once to backfill, then re-run the dry run: `missing` must be 0.
5. Until the webhook is subscribed, run `--execute` three times a day, Dubai time
   08:30, 13:00 and 18:00 (Sam's choice, 2026-10-26). Ad spend runs around the
   clock with its heaviest hours 20:00–01:00, so the morning run catches the
   overnight leads before sales starts. The pull reports `by_hour_dubai`; after
   the first backfill, move the three times to just after the real peaks.
   Keep one daily dry run permanently as the reconciliation check.
6. Realtime (optional, needs App dashboard access, i.e. a verified developer
   account): App → Webhooks → Page → subscribe `leadgen` with callback
   `https://app.newme.ae/api/meta/leadgen-webhook`, set `META_APP_SECRET`,
   `META_LEADGEN_VERIFY_TOKEN`, `META_LEADGEN_ENABLED=true`, and subscribe the Page
   (`POST /770232832850803/subscribed_apps?subscribed_fields=leadgen`).
7. Acceptance: one lead from Meta's Lead Ads Testing Tool appears in the CRM
   exactly once with ad / ad set / campaign ids.
8. Daily: the dry run is the reconciliation check (Meta count = CRM count per day).
# Isolated acceptance tests (candidate; not yet deployed)

Use a dedicated, unused test-only form, never a live campaign's form. The operator
must verify that the chosen Page owns it and it has no real submissions or ad use.
Form IDs are globally unique. Do not publish or attach this form to a real ad later.

Before creating any Meta test lead, deploy the isolation code through normal CI
and protected release gates, then use `scripts/meta-lead-test-control.mjs` with
`--page-id`, `--form-id`, and a fresh UUID v4 `--batch-id`. `--action register` is
read-only unless `--execute` is given and requires
`--dedicated-unused-form-confirmed`. Read back registration with `--action status`.
Do not supply credentials in arguments; use the protected server environment.

The permanent server-owned registration and minimal receipts use separate action
names in Supabase `audit_logs`, NOT `leads`, `customers`, business events, sales
tasks or the CRM conversion outbox. No schema change or public access grant is
needed. Every shared intake store checks the exact form registration before any
customer lookup. Lookup/write/readback errors fail closed. Missing form identity
also fails closed. Names containing "test" do not determine routing.

Now create one Facebook test lead. `--action status` must show its exact Lead ID
with origin `webhook`. A `backfill` receipt alone is NOT callback acceptance.
Confirm the exact Lead ID is absent from formal leads and the conversion outbox,
and retain the provider delivery status, callback time, and OS receipt as evidence.
This proves the isolated OS ingestion path, not creation of a real sales customer.

`--action cleanup` previews exact receipt IDs. Add `--execute` to delete only
those receipts and verify zero remaining. It NEVER deletes the registration or
any customer record. Keep registration permanently: late callbacks/backfills
remain isolated and can recreate minimal receipts (no answers/contact details).
Never run an older release or another importer lacking the isolation check while
test records remain retrievable from Meta; delete provider test leads first and
verify no outstanding delivery before such a rollback.
