# WhatsApp privacy operations

The pilot stores event metadata, never message bodies, customer names, raw phone
numbers, media or copied webhook payloads. A protected stable HMAC salt produces
the same customer reference on both channels. Do not rotate it while events or
suppression records remain: disable capture and erase observer history first,
or the new salt will no longer locate old references for customer deletion.

## Retention and worker

Each event expires at the earlier of event/collection time plus 30 days. The
database rejects event ages of 29 days or more and future skew above five
minutes, controls collection/expiry timestamps, and checks the age again at
transaction commit. Cleanup begins at 29 days, leaving a one-day operational
margin. Each run removes at most 5000 events and processes at most 20 pending
requests; the worker drains up to five batches before reporting a backlog.

The managed root cron invokes the fixed cleanup RPC every five minutes. The
server runtime credential is read from the existing protected store. It cannot
directly delete, update or truncate events; the fixed routine runs as a separate
NOLOGIN, NOINHERIT, NOBYPASSRLS role without CRM access. The worker writes only
times/counts to a root-only receipt under `/run`. The independent dependency
probe reports a missing/stale successful receipt through the existing alert
channel. Database admission stops after 15 minutes without successful cleanup,
and whenever already expired rows exist. No new subscription is involved.

## Verified customer requests

The owner/admin verifies the requester outside the deletion form, then uses
Settings → WhatsApp → Retention and customer deletion. Enter the international
customer phone and confirm the verified request. The server derives the customer
key; the browser cannot supply an actor, hash or cutoff. The database independently
checks an active current owner/admin session before new and repeated requests.

Deletion covers the customer's existing events on all pilot channels. One
transaction records a bounded suppression cutoff and removes the rows; insertion
and deletion take the same lock. Old callbacks cannot resurrect erased events.
The request UUID is bound to its actor/customer and retries return the same
receipt. If the response is interrupted, refresh receipts or retry the same ID;
do not assume failure means nothing happened. Fresh later enquiries can produce
new records. A request to stop future collection needs a separate opt-out decision.

Receipts contain a request UUID, timestamps, status and deleted count. Phone/key
values are excluded from the management response. Internal request and replay
suppression records expire after their bounded 30-day handling window. Email or
support correspondence and separate CRM/accounting records need their own review;
an event-deletion receipt does not prove those other records were erased.

## Restore quarantine

Before any database restore, disable capture and stop the application/cleanup
worker until the restored database has been quarantined. Reapply the approved
schema if the backup predates this migration. As a database operator, execute
`whatsapp_privacy.reset_after_restore()` before restarting application traffic.
It erases all restored observer history and pending/suppression metadata, disables
every channel, advances `accept_since` five minutes beyond the reset and invalidates
the maintenance heartbeat. This deliberately gives up pilot history to prevent
restoring deleted customers. The app and cleanup role cannot call this routine.
Verify zero events/disabled channels, resume cleanup and verify a fresh receipt;
re-enable capture only after the normal launch checks and a fresh launch cutoff.

Restore is an operator-controlled process; application deletion cannot remove a
row from an isolated provider backup. Provider backup/log rotation must be read
from the actual account configuration before real-number launch. No unverified
provider retention duration or complete privacy-compliance claim is made here.

Read-only account observation on 2026-10-23: Supabase project
`vfopmpxlhwzpxqegayew` shows the Free plan and explicitly states that scheduled
project backups are not included. No paid upgrade was enabled. This does not
establish whether separate exports, host backups or provider internal copies
exist. Verify those separately before enabling actual-number collection.

## Acceptance

`tests/database/whatsapp-privacy.py` refuses non-test database targets. In CI it
uses a clone of the already verified full-schema history replay. The 2026-10-23
isolated PG17.11 run passed twelve behavior groups, including actual concurrent
sessions, a 5001-row expiry backlog, commit-age crossing, session/ACL refusals,
cross-channel deletion, idempotency, pending-work recovery and restore quarantine.
Generated public database types came from that migrated isolated schema.

Production readiness additionally requires the reviewed migration/phase posture,
managed cron, a real successful scheduler receipt, administrator UI/auth checks,
zero enabled actual channels and the repository's canonical release acceptance.
