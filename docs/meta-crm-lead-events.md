# Meta CRM lead-stage feedback (Conversion Leads)

Sends each CRM stage change of a **native Meta Instant Form lead** back to Meta so
delivery can optimise for qualified leads, not just form fills. Candidate only:
nothing here is deployed, the schema is not applied and no event has been sent.

## Flow

1. A Meta lead arrives with its `leadgen_id` (`POST /api/leads/meta-capi` as
   `custom_data.leadgen_id`, or an import workbook column `Meta Lead ID`/`leadgen_id`).
   It is validated (`normalizeLeadgenId`) and stored in `leads.meta_leadgen_id`.
2. On each stage change (`PATCH /api/leads/[id]/stage`) and on arrival ("Lead"), one
   row per (lead, stage) is queued in `meta_crm_stage_events`. Queueing never fails
   the user's action and is skipped for leads without a Meta id.
3. `node scripts/meta-crm-events-send.mjs` (read-only by default; `--execute` sends)
   posts at most 50 queued events, with a lease and compare-and-set, using the
   server-side `META_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN`. Events older than 7 days
   go to `review_required` and are never sent. Output is aggregate counts only.

Payload per event: `event_name`, `event_time` (transition moment, after lead
creation), `action_source: "system_generated"`, `user_data.lead_id`,
`custom_data.lead_event_source: "crm"`.

| CRM stage | Meta event |
| --- | --- |
| new | Lead |
| contacted | Contacted |
| requirement_confirmed | **Qualified** (optimisation target) |
| solution_submitted | Solution Submitted |
| quotation_submitted | Quoted |
| negotiation | Negotiation |
| pending_decision | Pending Decision |
| won | Won |
| lost | Lost |

## Not yet done (needs an authorised operator)

- **Schema.** Provided by PR #485 (`20261025180000_meta_crm_lead_stage_events.sql`,
  gate `meta-crm-plan`/`meta-crm-provision`); see `docs/meta-crm-provisioning.md`.
  Apply it before deploying this code.
- Until the schema exists the code is inert: stage changes are unaffected, a lead
  carrying a Meta id is still stored (without the id), and no event is queued.
- Stage events are derived from the committed RPC result; idempotent replays never
  queue a stage. Workbooks without a Meta id keep their previous import fingerprint.
- **Dataset.** The sender reuses `META_PIXEL_ID`; confirm it is the dataset the CRM
  integration is configured on in Events Manager (`4476894535908766`).
- **Live acceptance.** Use Meta's test-event flow with one real form lead before
  trusting it. Leads created before the schema have no `leadgen_id` and cannot be sent.
- No timer is installed. The existing advertising timer stays off.
