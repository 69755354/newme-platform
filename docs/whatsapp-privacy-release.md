# WhatsApp privacy lifecycle: guarded release

The observer-only provisioning gate remains unchanged. A separate operation
admits only the reviewed `20261022194620_whatsapp_privacy_lifecycle.sql` hash
`a1a4a9d34fb56d81fa0a42c0d355b6370f05811c1b2b10e196aaacf8e391aeab`.
The review fixture is byte-identical SQL, not an alternative deployment path.

First merge the coordinator, the new policy gate, its refusal tests and fixture,
without adding a production migration. Run fresh protected manual CI on canonical
main, then bootstrap those control-plane assets using the existing
`contract_verified` claim and derived required IDs. Retain the current app.

Then merge the application release with the new migration as exactly one later
`deferred_contract` suffix. Run fresh protected manual CI on that exact main SHA.
The candidate must contain the live release; the complete live strict posture,
unchanged required set and deferred prefix, observer history, disabled channels,
new-object inventory and immutable SQL bytes are checked before any application:

    newme-deploy db-transition <main-sha> <successful-run-id> whatsapp-privacy-plan
    newme-deploy db-transition <main-sha> <successful-run-id> whatsapp-privacy-provision

Use the normal coordinator application deployment with `contract_verified` after
provisioning succeeds. Never apply this SQL manually to production or fabricate
a gate record. Existing release locking, exact main/CI checks and phase applier
remain in force. Provisioning does not enable capture or connect either phone.

The 2026-10-23 isolated PostgreSQL 17.11 full-schema run applied this migration
twice and passed twelve groups of behavior tests, including two real concurrent
sessions in both orders, old-event replay, narrow ACLs, disabled/stale/banned
sessions, physical expiry, a 5001-row backlog, transaction-age crossing, durable
pending work and restore quarantine. This is staging evidence, not a production
completion claim. Production requires scheduler receipt, auth/UI and full release
acceptance checks before the Taskboard-only closure and coordinator finalization.
