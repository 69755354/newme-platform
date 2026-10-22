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

### Direct access and coexistence are separate eligibility checks

Meta offers direct platform access without an additional access fee; delivered
API messages can still incur usage charges. Its October 1, 2026 pricing includes
1,000 free service messages per business phone number per month, with subsequent
service messages charged. Do not describe direct access as unlimited free usage.
See [official costs FAQ](https://whatsappbusiness.com/resources/faq/) and
[current pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).

Retaining the existing Business App requires the documented coexistence flow.
Its provider must already qualify as a Solution Partner or Tech Provider. Meta
documents an independent Tech Provider path without a Solution Partner, including
business verification and App Review for advanced WhatsApp permissions. A verified
business, a registered developer, a successful ordinary Cloud API test, or an
existing Conversions API app is not proof that this coexistence eligibility is met.
See [independent Tech Provider onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers).

## Configuration and rollout gates

1. Confirm the actual deployed OS commit and database project. Git main is not
   evidence of what production runs. Existing production Meta status routes
   returned 404 during the read-only audit.
2. Review and apply the new migration in a disposable full-schema staging
   environment first. On 2026-10-20 the production-derived application schema
   (public, auth, extensions, supabase_migrations; 41 public tables and
   13 views) was restored without customer/auth rows into a fresh, internal-only
   PostgreSQL 17.11 container using the CI-pinned official image. The exact-hash
   pilot migration and idempotent re-apply passed, producing 43 public tables.
   Catalog and behavioral checks verified RLS, revoked browser grants, the
   canonical statement-level current-session guard, subject-free service writes,
   rejection of identities without a current session, and denied service deletes.
   Full public database types were regenerated with Supabase CLI 2.108.0 and
   postgres-meta 0.96.1 against this schema. The existing PostgREST 14.5 client
   hint and migration fingerprint were retained. This also refreshes older type
   omissions in five existing tables and sixteen existing functions; it grants
   no new database permissions. Security advisors reported no errors, nine
   existing function search-path warnings and two informational no-policy
   notices for the intentionally server-only pilot tables. This validates the
   application schema, not the complete Supabase service stack or real phones.
   The release manifest schedules this optional provisioning in its later
   `deferred_contract` phase, after the existing money contract; the default-off
   application has no dependency on these tables. Existing financial phase
   gates and migration order remain in force. Keep the flag off until this later
   provisioning and both physical-phone acceptance checks have completed.
   Both late-created tables explicitly install the canonical statement-level
   current-session trigger, which must remain enabled through compatibility
   rollback. The runtime posture checks its table/function/event binding.
   Isolated checks reject inactive, banned, stale and forced-password-change
   identities on privileged zero-row writes, and detect a disabled trigger;
   identity-free service webhook writes and event-preserving re-apply still work.
   For an existing strict production release, first install the separately
   reviewed coordinator capability, then use its exact-hash WhatsApp plan and
   provision operations before the application switch. See
   [the guarded two-stage procedure](whatsapp-provisioning-release.md).
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
8. Only call the pilot live after webhook storage, the management view, both
   physical-phone flows and the [privacy lifecycle gates](whatsapp-privacy-operations.md)
   pass. Verify the deployed cleanup worker and fresh receipt before capture.

Application admission rejects events at or beyond 30 days and rechecks before
dispatch. The new database lifecycle is stricter: it rejects at 29 days, guards
commit time, physically purges with a safety margin and serializes verified
customer deletion against callback insertion. Its scheduled worker, alerts and
restore quarantine are described in [privacy operations](whatsapp-privacy-operations.md).
Keep actual channels disabled until the guarded release, privacy launch checks
and Meta advanced permissions are verified.

The management endpoint is active-session boss/admin only and returns no full
phone IDs, credentials or chat content. Both tables have RLS enabled and all
direct `anon`/`authenticated` privileges revoked. The webhook is the only event
writer. Storage failures return 503 for Meta retry; successful writes are
idempotent by `(channel_id, message_id)`. The UI withholds metrics above 1,000
events rather than silently treating an incomplete page as a full observation.

To stop capture, set `WHATSAPP_PILOT_ENABLED=false` or disable either channel.
Keep stored evidence for review; disabling does not delete facts or unregister
numbers. Remove an app/WABA subscription only after checking other consumers.

## CI image provenance refresh

The official `postgres:17.11-trixie` tag moved from index digest
`sha256:f4c66b820c6f974249089d3d16d86a3698eae11e8746eb6644b2271031e91232`
to `sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`.
On 2026-10-19, both index bodies, their Linux/amd64 manifests and configuration
blobs were read from Docker's official registry and checked against SHA256.
The official-images [source record](https://github.com/docker-library/official-images/blob/1b851c635e093e70beddd58d633ddaf5e307abfc/library/postgres)
maps this tag and platform to the same PostgreSQL [build recipe](https://github.com/docker-library/postgres/blob/2603e26e245e558218728ee14e0a42dcb020dc7f/17/trixie/Dockerfile)
as the old image. Both report PostgreSQL `17.11-1.pgdg13+2`; the Debian
`trixie-slim` base digest and build date changed. This establishes the source
and platform correspondence, not an application acceptance result.

The two CI service references and provenance lock now pin the verified new
index. The mutation test fixture uses that same pin so tag-only, unknown and
drifted digests still fail. The provenance verifier, exception policy and
workflow permissions are unchanged. Full CI must run again on the new commit;
earlier runs do not validate this refreshed runtime.
