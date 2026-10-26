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
| `META_LEADGEN_PAGE_IDS` | comma-separated Page ids, e.g. `61582805446880` |

## Operator steps (need Sam's click in Meta)

1. Business Settings → System users → generate a token for the CRM app with
   the permissions above, assigned the NewMe Page; Leads Access Manager must
   allow the CRM app.
2. Put the settings in /etc/newme and deploy this release.
3. Dry run: `node scripts/meta-leads-pull.mjs --since-days 45` — expect Meta's
   count to match Ads Manager (24 form leads for 2026-09-26..10-25).
4. `--execute` once to backfill, then re-run the dry run: `missing` must be 0.
5. App → Webhooks → Page → subscribe `leadgen` with the callback
   `https://app.newme.ae/api/meta/leadgen-webhook`, and subscribe the Page to the
   app (`POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`).
6. Acceptance: submit one test lead with Meta's Lead Ads Testing Tool; it must
   appear in the CRM within a minute, exactly once, with ad/ad set/campaign ids.
7. Daily: the dry run is the reconciliation check (Meta count = CRM count per day).
