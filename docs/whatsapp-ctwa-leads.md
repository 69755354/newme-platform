# Click-to-WhatsApp ad leads (OS fix S18)

A customer who taps a Meta "click to WhatsApp" ad and writes to the company number arrives at
`/api/whatsapp/webhook` (alias `/api/meta/whatsapp-webhook`). Signature: `WHATSAPP_APP_SECRET` or
`META_APP_SECRET`. Verification token: `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Channels come from the existing
`whatsapp_pilot_channels` allowlist.

- Stored: customer phone, message id/time/direction, WABA and number ids, and the ad referral
  (`ctwa_clid`, ad id, ad link, headline). Never stored: chat text, ad body text, media links, contact or history sync content.
- `record_whatsapp_ad_event()` (service role only) serialises per customer phone, so replays, reordering and concurrent
  deliveries give one lead. Existing active lead with the same phone: gets the click id once (never replaced). No match and an
  ad referral: new lead (`source=whatsapp`, `source_channel=whatsapp_ctwa`, no owner). No match, no referral: new lead with
  `source_channel=whatsapp_direct` unless `WHATSAPP_ORGANIC_LEADS_ENABLED=false`. Our own outbound message never creates a lead.
- Feedback: `whatsapp_capi_events` outbox, one row per (lead, event). LeadSubmitted when the click id is first attached;
  QualifiedLead at requirement_confirmed or later, or quality good/normal; Purchase when the contract becomes active
  (contract amount). Differs from the form funnel only in that `contacted` queues nothing.
- Sender: `node scripts/whatsapp-capi-send.mjs [--execute]`; sends only with `META_WA_DATASET_ID` and `META_CAPI_ACCESS_TOKEN`
  set, otherwise the queue only fills. Exit code 1 on failures, review-required or events that used all 5 attempts.
- Marketing export: `GET /api/leads/whatsapp-ads/export` (admin, boss, operator), `?format=json`, `?from=&to=`.
- Switches: `WHATSAPP_AD_LEADS_ENABLED=false` turns the whole ad path off.
