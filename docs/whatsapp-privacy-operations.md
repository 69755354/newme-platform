# WhatsApp retention and customer deletion

The pilot records message-event metadata for response monitoring. It does not
copy message bodies, names, raw customer phone numbers, media or webhook payloads.

## Retention

Pilot events follow a 30-day retention policy. Scheduled cleanup begins on day
29, with a margin for recovery. A prolonged outage can delay physical deletion;
stopping new collection does not itself erase existing records. The settings
page shows the latest cleanup status so an administrator can follow up.

After fifteen minutes without successful cleanup, new collection is paused and
monitoring raises an alert. Already expired records also prevent new collection.
Existing records need cleanup to resume. No new messaging subscription is added.

## Handle a verified deletion request

1. Verify the customer's identity and deletion request through the company's
   normal support process.
2. As an owner or administrator, open Settings → WhatsApp → Retention and
   customer deletion.
3. Enter the customer's international WhatsApp number, including the country
   code, and confirm the verified request.
4. Check the receipt. If the response is interrupted, refresh receipts or retry
   the same request rather than assuming that deletion did not happen.

Deletion covers the customer's existing observer events across all pilot
channels. Old callback retries are suppressed so they cannot recreate those
erased events. A later enquiry may create a new record. Stopping future
collection is a separate opt-out decision.

Receipts contain an opaque request identifier, timestamps, status and a deleted
count. They do not show the customer's phone number. The server independently
checks the current administrator's authority before processing new or repeated
requests.

## Scope and recovery

This mechanism does not delete phone-app chats, separate CRM contracts or
transactions, email or other support correspondence. Those records need their
own handling. Backup copies require separate retention and recovery handling;
an observer-event receipt does not prove deletion from every external system.

Before restoring a backup, an operator must quarantine restored observer data
and keep collection disabled until the company's recovery checks are complete.
Application deletion is not a substitute for that recovery process.

Actual staff numbers remain disconnected until Meta approval and the company's
launch checks are complete. Passing development tests alone is not evidence of
production readiness or actual message collection.
