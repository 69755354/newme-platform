# Guarded CAPI event-type compatibility

Live acceptance of the website CAPI candidate found SQLSTATE 23514: the existing
`business_events.chk_event_type` check does not accept `meta_capi_lead_delivery`.
The candidate was recovered through the protected rollback coordinator. No
synthetic CRM lead or Graph conversion was created; the rejected fixture left
zero rows. Code-only checks did not establish this database compatibility.

This preparation adds `meta-capi-plan` and `meta-capi-provision` to the existing
root coordinator. It does not add an applied migration, alter the database,
connect a phone, grant a Meta permission or enable either scheduler.

The plan/apply path requires exact-main release-candidate CI and the shared
production lock. It verifies the current release's complete recorded strict
prefix, preserves every prior manifest field and posture predicate, permits only
one exact-hash migration plus its exact constraint predicate, and rejects an
unrecorded or recorded constraint mismatch. It retains the ordinary phase
applier's transaction and migration-history readback.

The reviewed SQL fixture adds only the CAPI event to the existing allowlist. It
keeps every old type, the existing NOT VALID posture, and a five-second lock
timeout. The check continues to reject unknown types on new writes. No row,
policy, privilege, credential or customer record is changed by the fixture.

Release sequence: bootstrap this reviewed coordinator with the unchanged
migration manifest; then separately review the identical SQL as a canonical
migration and append its exact posture predicate. Plan/apply it before deploying
that successor. Re-run live synthetic database acceptance and canonical release
acceptance before claiming completion. All previous failed receipts are retained.
