# WhatsApp intake and follow-up pilot

This draft adds an opt-in, metadata-only observer inside Settings → WhatsApp.
It does not enable any production numbers or change employee roles, lead
ownership, CRM milestones or existing manual contact records. Runtime channel
configuration belongs outside this public repository.

The first pilot uses one intake number and one follow-up number. Each number
needs its own completed coexistence onboarding and verified incoming-message /
handset-echo test. Connecting the intake number alone does not complete the pilot.

## What the draft measures

- Official `messages` incoming events and `smb_message_echoes` handset sends.
- Event time, message counts, pending incoming bursts, and observed response
  intervals on the **same number**, over a seven-day observation window.
- A stable keyed customer reference across both numbers. Raw customer phone
  numbers, contact names, message bodies, attachments and webhook payloads are
  never persisted by this feature.

This is event evidence, not an employee attendance or performance verdict.
Shared devices do not identify the human sender. Missing echoes can reflect
unsupported companion devices or interrupted delivery. Groups and voice/video
calls are outside coverage. Status/read receipts never count as salesperson
replies. Same-second sends do not establish reply order. Window-boundary
conversations are partial observations, not lifetime first-response measurements.

Cross-number handoff still requires the existing OS assignment/transfer record.
The intake receipt timestamp is not a salesperson's assignment timestamp. This
draft does not infer a handoff, automatically attach a message to a lead, or
change a lead's first-contact/quality milestone.

## External prerequisites

Use the official Business App **coexistence** flow so the existing phone apps
can remain in use. The current Meta guide requires an eligible Solution Partner
or Tech Provider, functioning webhooks, session logging and Embedded Signup v4.
The guide states v2/v3 were discontinued on 2026-10-15. Check eligibility in the
actual account before assuming a new developer app can perform onboarding.

An authorized Facebook developer/app administrator is needed. An Instagram
business login alone may leave app creation disabled. The official WhatsApp
Business Tools MCP is a development/configuration assistant; it is not a
production message collector. Its OAuth login does not replace the webhook or
the two independent phone onboarding flows.

Before any live onboarding, show the owner the exact app, business, numbers,
permissions and terms for confirmation. Each phone holder completes the
WhatsApp confirmation/code/QR flow. Coexistence can unlink companion devices
and changes some app features. Do not run destructive registration/migration
commands against an existing Business App number as an onboarding shortcut.
History/contact sharing is a separate choice and is not part of this pilot.

Official references checked 2026-10-19:

- [Business App coexistence](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)
- [WhatsApp Business Tools MCP](https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)

## Configuration and rollout gates

1. Confirm the actual deployed OS commit and database project. Git main is not
   evidence of what production runs. Existing production Meta status routes
   returned 404 during the read-only audit.
2. Review and apply the new migration in a disposable full-schema staging
   environment first. The draft's SQL has been executed in isolated PostgreSQL
   with minimal `profiles`/roles and grant/constraint checks; that is not a full
   Supabase replay. Pilot table types were derived from that isolated schema;
   regenerate the full database types against the approved staging schema and
   run advisors before merge/deployment. Docker was unavailable locally.
   The release manifest schedules this optional provisioning in its later
   `deferred_contract` phase, after the existing money contract; the default-off
   application has no dependency on these tables. Existing financial phase
   gates and migration order remain in force. Keep the flag off until this later
   provisioning and both physical-phone acceptance checks have completed.
3. Add exactly the two approved channel rows, initially **disabled**. Verify each
   `owner_profile_id`, `waba_id`, `phone_number_id` and canonical digit-only
   `business_phone` from current authoritative records. Do not reuse an old
   account ID or infer the follow-up number's ID from the intake number.
4. Configure server-only `WHATSAPP_APP_SECRET`,
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `WHATSAPP_PILOT_CONTACT_SALT`, and
   `WHATSAPP_PILOT_ENABLED=true`. Keep values in the runtime secret manager,
   never `NEXT_PUBLIC_*`, source control, browser storage or logs. The contact
   salt must stay stable across both channels; rotating it breaks correlation.
   No Graph sending token is required by this observer.
5. Confirm the live callback `/api/whatsapp/webhook` serves the verification
   challenge and verifies `X-Hub-Signature-256` over the unmodified bytes. Only
   this exact path bypasses OS browser-session middleware. Sibling routes do not.
6. Subscribe the correct app/WABA to `messages` and `smb_message_echoes` using
   the official coexistence process. Request no history import for this pilot.
   At launch set each channel's `accept_since` to launch time and enable it.
   Channel rows plus the global flag are independent opt-in gates.
7. With permission, use a company test customer number to send a fresh inquiry
   to intake, record the transfer in OS, then have the follow-up holder send a
   real reply from the phone. Test **incoming and outgoing** for both numbers,
   the shared customer reference, delivery retry deduplication and event order.
   A missing event is a coverage failure to investigate, not staff misconduct.
8. Only call the pilot live after webhook storage, the management view and both
   physical-phone flows pass. Validate retention and retrieval needs with the
   owner; this draft has no automatic deletion or history backfill job.

The management endpoint is active-session boss/admin only and returns no full
phone IDs, credentials or chat content. Both tables have RLS enabled and all
direct `anon`/`authenticated` privileges revoked. The webhook is the only event
writer. Storage failures return 503 for Meta retry; successful writes are
idempotent by `(channel_id, message_id)`. The UI withholds metrics above 1,000
events rather than silently treating an incomplete page as a full observation.

To stop capture, set `WHATSAPP_PILOT_ENABLED=false` or disable either channel.
Keep stored evidence for review; disabling does not delete facts or unregister
numbers. Remove an app/WABA subscription only after checking other consumers.
