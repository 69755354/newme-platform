# WhatsApp privacy lifecycle: guarded release

The observer-only provisioning gate remains unchanged. A separate operation
admits only the reviewed `20261022194620_whatsapp_privacy_lifecycle.sql` hash
`8b0a7d9fde56398884d0274f44cf3091c9664d9d2b64c241c4efb4e87ff608c4`.
The review fixture is byte-identical SQL, not an alternative deployment path.

First merge the coordinator, the new policy gate, its refusal tests and fixture,
without adding a production migration. Run fresh protected manual CI on canonical
main, then bootstrap those control-plane assets using the existing
`contract_verified` claim and derived required IDs. Retain the current app.

The coordinator capability was bootstrapped from `38fae1272622a6fdf76acf69ad2503f75f671c24`
with successful protected CI `39855358493`; the application remained on its prior
release. The candidate's reviewed SQL now also puts the canonical session assertion
first in each public security-definer entry. Its immutable hash, fixture and body
posture predicates change together. The installed coordinator validates the
candidate policy under fresh exact-main CI; its operations and the observer-only
allowlist remain unchanged.

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
