# Meta ID registry export

One row per Meta identifier on a lead: forms carry a Meta `leadgen` id, click-to-WhatsApp leads carry a
`ctwa_clid`. Each row also has the ad it came from and the state of the feedback sent back to Meta.
No name, phone or email is ever included; `lead_ref` is `NM-` plus the first 12 hex characters of the lead id.
Archived leads are included. Nothing is written to the database and no migration is needed.

## Endpoint

`GET /api/export/meta-ids[?format=csv|json][&since=ISO-8601]` (CSV by default, UTF-8 with byte-order mark).

Columns: `lead_ref, source (form|whatsapp), meta_id_type (leadgen|ctwa_clid), meta_id, campaign_id, campaign_name,
adset_id, ad_id, ad_name, created_at (Dubai time, +04:00), stage, final_status, archived,
feedback_events, last_feedback_at`.

`feedback_events` looks like `LeadSubmitted:sent;QualifiedLead:queued`. Words: `sent` (delivered to Meta),
`queued` (waiting or sending), `failed` (will be retried), `manual` (needs a person). Form leads read
`meta_crm_stage_events`, WhatsApp leads read `whatsapp_capi_events`. More than 20,000 leads answers 413: add `since=`.

## Who can call it

1. A logged-in user with role admin, boss or operator (the marketing team).
2. A read-only token: environment variable `META_IDS_EXPORT_TOKEN` on the app (at least 32 characters). Send it as
   `Authorization: Bearer <token>` (preferred) or `?token=<token>`. Compared in constant time; 20 attempts per minute per
   source address, then 429. If the variable is unset or shorter than 32 characters the token method is off and
   every token request is 401. Rotate by changing the variable (and the matching server file below) and restarting the app.

The `?token=` form is needed by Google Sheets, and web servers log request addresses. Treat the token as read-only
but sensitive: it exposes ad ids and Meta lead ids. Never paste a real token into chat, a ticket or git.

## Google Sheet

In a new sheet, cell A1: `=IMPORTDATA("https://app.newme.ae/api/export/meta-ids?format=csv&token=<TOKEN>")`
(replace `<TOKEN>`). Google refreshes IMPORTDATA about hourly. Keep the sheet's sharing as narrow as the token.

## Daily copy on the NAS (templates only, nothing is installed by this repository)

Files: `infra/meta-ids/newme-meta-ids-export.sh|.service|.timer`, `infra/meta-ids/meta-ids-export.env.example`,
`infra/nas/newme-nas-upload.sh` (uploads one named file to a NAS sub-folder; same DSM FileStation method as
`newme-nas-push.sh`, account from `/etc/newme/nas-push.env`).

Install (as root, after the app release containing the endpoint is live and the token is set on the app):

1. `install -m 0755 infra/nas/newme-nas-upload.sh infra/meta-ids/newme-meta-ids-export.sh /usr/local/libexec/newme/`
2. `install -m 0600 infra/meta-ids/meta-ids-export.env.example /etc/newme/meta-ids-export.env`, then set
   `META_IDS_EXPORT_TOKEN=` to the same value as on the app.
3. `install -m 0644 infra/meta-ids/newme-meta-ids-export.service infra/meta-ids/newme-meta-ids-export.timer /etc/systemd/system/`
4. `systemctl daemon-reload && systemctl start newme-meta-ids-export.service` (test run; check `journalctl -u newme-meta-ids-export`
   and `/newme-os-backup/exports/meta-ids-YYYYMMDD.csv` on the NAS), then `systemctl enable --now newme-meta-ids-export.timer`.

The timer runs at 02:10 Dubai time. The script keeps dated copies in `/var/lib/newme-meta-ids/` (60 days) and fails
loudly (alert through `newme-backup-alert@`) on any HTTP error, unexpected content or NAS size mismatch.

## Rollback

`systemctl disable --now newme-meta-ids-export.timer`, remove the two unit files and the env file, `systemctl daemon-reload`.
To switch the endpoint's token method off, unset `META_IDS_EXPORT_TOKEN` on the app (logged-in access keeps working).
Files already on the NAS can be deleted by hand. The code change itself reverts with the normal release rollback.
