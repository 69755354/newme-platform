# Website lead delivery reliability

This candidate changes code only. Production deployment, database concurrency
acceptance and genuine customer attribution require separate receipts.

## Intake and recovery

- New website submissions derive separate UUIDv5 primary keys for the lead,
  follow-up task and delivery from the browser's `event_id`. The database's
  existing primary keys reject duplicate inserts, including across processes.
- An identical retry verifies the saved inquiry fingerprint. A changed inquiry
  with the same event ID returns 409 and does not overwrite CRM data. Verification
  tokens and tracking cookies may change between attempts; original attribution
  is retained. Existing random-ID leads are not rewritten
  or retroactively deduplicated by this change.
- A retry repairs a missing task or outbox record. Existing records are never
  upserted over sales edits. This is recoverable multi-step intake, not an atomic
  transaction: a crash can temporarily leave a lead before its task or outbox.
- Delivery acquisition uses one conditional database update on status, attempt
  count and prior lease ownership. Only its owner may finish the receipt. A
  crashed sender's 60-second lease can be recovered by a later retry.
- Retries preserve the original payload, `event_id` and `event_time`. Five attempts
  and a 24-hour maximum age bound ambiguous resend. Expired or invalid records
  require operator review. A network timeout cannot establish whether Meta
  accepted an event; this is at-least-once delivery with deduplication, not an
  exactly-once network guarantee.

## Acknowledgement and privacy

The sender requires successful HTTP, valid JSON, no error envelope and an integer
`events_received` equal to the batch size. This is API acknowledgement, not proof
of advertising attribution or dashboard reporting. Transport errors and response
bodies are not logged. Credentials use an Authorization header; redirects fail.

## Prepared retry operator

`node scripts/meta-capi-retry.mjs` is read-only by default. It reports aggregate
queue counts without contacts or payloads. In an approved server runtime,
`node scripts/meta-capi-retry.mjs --execute` processes at most 20 recent delivery
records sequentially, using the same conditional claim as the public route.
Exhausted attempts are excluded before the batch limit. Validation failures move
to a review-required status using a conditional update so later runs can advance
to newer records without replacing a concurrent sender's receipt.
Only the existing private Supabase and CAPI runtime configuration is used.

No timer/service is created, installed or enabled by this candidate. The existing
advertising timer remains off. This tool cannot repair a task/outbox that was
never created: an identical intake retry repairs those stages. Review exhausted
and old records before any manual resend; never regenerate their IDs or time.

## Validation boundaries

Behavior tests exercise duplicate/conflicting submissions, outbox recovery,
concurrent requests, failed-send replay, lease ownership and acknowledgement
failures using synthetic in-memory storage and mocked Graph responses. They do
not prove production PostgreSQL lock behavior, a live Meta send or customer
attribution. No real WhatsApp number is connected and no permission is expanded.

Code-review follow-up: the complete targeted suite now passes 37 synthetic checks.
The two additional regressions prove that 20 exhausted oldest deliveries cannot
block a newer eligible one, and that 20 invalid records move to review so a later
bounded batch can advance. This supplements the taskboard's earlier 35-check
code-only evidence; production deployment and live acceptance remain separate.
