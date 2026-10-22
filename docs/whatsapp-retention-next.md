# WhatsApp retention: original admission plan

Update 2026-10-23: the database lifecycle, authenticated deletion UI, bounded
cleanup and monitoring are now implemented in the candidate and passed isolated
database behavior tests. See [privacy operations](whatsapp-privacy-operations.md)
and [guarded release](whatsapp-privacy-release.md) for the current implementation
and deployment gates. The text below preserves the earlier plan; it is not the
current implementation inventory. Live deployment is verified separately.

2026-10-22. Prepared from merged release `1f1b894655e98388d51efe49d33e038d7e467bb8`
in a separate local worktree. Not pushed, deployed or run against production.

## Implemented in this candidate

The webhook rejects events whose event-time age is 30 days or more. This applies
to both incoming messages and handset echoes, independently of the channel's
older `accept_since`. At the exact expiry boundary the event is rejected.
The same age predicate is rerun immediately before write dispatch, so a batch
that crosses the boundary during parsing does not submit its expired rows.
Expired retries receive the normal acknowledgement without a write; fresh
members of a mixed batch still proceed. Metadata fields and message content
exclusion are unchanged. No new database privileges or migrations are included.

This is a first admission control, not a retention/deletion implementation.
It does not delete existing rows, prevent replay after a customer deletion while
an event is still younger than 30 days, or enforce age during database/network
delay. All three need the next database transaction boundary. The server clock
also remains an application clock; the database must be authoritative at commit.

## Required next slice before actual-number capture

1. Add a new forward migration using the project's supported Supabase CLI flow;
   do not modify `20261019104004_whatsapp_pilot_events.sql` or its hash fixture.
   Add immutable collection/expiry facts and an expiry index. A conservative
   cutoff can use the earlier of event time and collection time plus 30 days,
   preventing the existing five-minute future-skew allowance from extending
   retention. Validate the exact boundary and clock semantics in isolated PG.
2. Move event admission to a fixed database routine/trigger that enforces
   expiry and customer deletion cutoffs atomically. A webhook's fresh read of
   a cutoff followed by a separate INSERT is insufficient: deletion and insert
   must serialize on the same customer key. Preserve metadata-only storage,
   exact channel/WABA checks, current-session statement guards and retry keys.
3. Implement an auditable deletion-request queue: request UUID, received/deadline
   timestamps, verified status, actor, completion status/counts and a minimal
   customer key. No customer phone, chat text or copied webhook body in audit
   records. Canonical phone-to-HMAC conversion must stay server-side; the UI's
   12-character reference is not a unique deletion key. The request's reach
   across both approved channels must be explicit.
4. Permit request registration only through a current active boss/admin session
   with same-origin bounded input. The database must independently authenticate
   the caller and role before all replay/early-return branches; do not trust an
   actor ID supplied by the browser or an identity-free service-role call.
5. Keep `service_role` without direct table DELETE. Use a narrowly privileged
   maintenance identity and fixed routines for expired rows and verified requests.
   No arbitrary table, SQL, customer selector or caller-chosen deletion cutoff.
   Revoke default PUBLIC function execution; pin schema/function ownership,
   search_path, permissions and runtime posture. Do not expose a generic DELETE
   endpoint or reuse the migration-owner credential in the web application.
6. Record a bounded deletion cutoff/tombstone atomically with deletion so old
   callbacks cannot resurrect rows. Retain only the minimum suppression metadata
   needed until the latest eligible old event has expired, then remove it.
   A request to stop future collection is distinct from deleting history;
   don't infer permanent opt-out from a historical deletion request.
7. Add a bounded scheduled cleanup and a minimal execution receipt (times,
   counts, oldest remaining expiry and status); monitor missed/failed runs.
   Schedule cleanup with a safety margin below 30 days. A daily sweep at
   age >30 days can retain data for nearly 31 days and cannot meet the stated
   maximum. Suppressing expired reads does not physically delete rows.
8. Verify actual provider backup/log retention and restoration procedures. A
   restored database must replay deletion cutoffs before collection/reads resume.
   Application-row removal alone is not proof that backup copies are deleted.

## Independent deployment requirement

`scripts/check-whatsapp-provisioning.mjs` admits only the exact existing observer
migration. The additional migration needs a separately reviewed canonical
release/provisioning plan with new exact hashes, migration history checks,
strict-phase compatibility and refusal tests. Do not broaden the old allowlist
or fabricate gate records. Do not run a new SQL file manually on production to
avoid this gate. Keep all actual channels disabled throughout preparation.

## Meaningful acceptance matrix

- Current candidate: one millisecond inside/exactly at/after 30 days; allowed
  and rejected future skew; malformed times/clocks; inbound and outbound; long-
  running channels; repeated expired delivery; mixed batch and boundary crossed
  during parsing; existing auth/signature/storage retry protections.
- Next DB slice: expiry during transaction delay; direct service-role DELETE
  still denied; revoked/sales/anonymous request attempts; duplicate request UUID;
  different customer unaffected; both channels; concurrent delete/insert in
  both orders; delayed callbacks before/at/after the deletion cutoff; future
  fresh enquiry allowed unless separately opted out; tombstone expiry cannot
  reopen replay; partial batch failure; cleanup outage and resume; restore.
- Full-schema isolated PostgreSQL tests and production readback are required
  separately. Mock tests do not prove database deletion or provider retention.

## Release claims

No automatic deletion, complete privacy compliance, real-number monitoring,
customer deletion completion, or production change is claimed by this work.
