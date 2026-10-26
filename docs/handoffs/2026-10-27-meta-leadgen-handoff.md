# NEWME Meta Lead Ads handoff — 2026-10-27

Public-repository edition. Server addresses, SSH details, local user paths, customer statistics, credentials and exact provider test identifiers are intentionally omitted. The operator retains the full private handoff, `NEWME_META_CC_HANDOFF_2026-10-27.md`, with those access coordinates and exact test IDs. Never request that credentials be pasted into an issue, PR, chat or this document.

## Current conclusion

**The real Facebook → webhook → isolated NewMe OS end-to-end test has NOT passed.** Do not report the integration as ready for production lead intake.

Latest update: **2026-10-27 02:32:45 Asia/Dubai** (2026-10-26 22:32:45 UTC). The user authorized token replacement and explicitly assigned subsequent retesting to CC.

**The expired retrieval token has now been replaced successfully in the running production service.** A fresh valid User token was exchanged server-side for a long-lived User token; the target Page token was then derived from it and independently verified:

- `type=PAGE`, `is_valid=true`, correct application and Page identity.
- `expires_at=0` (no fixed token expiration); all five required Page/lead permissions granted.
- `data_access_expires_at=1800829672`, currently **2027-01-25 02:27:52 Asia/Dubai**. No fixed token expiry does not mean irrevocable or maintenance-free authorization.
- The running process uses the new token; GET Page `subscribed_apps` succeeds and includes the intended app and `leadgen`.
- Only `META_LEADS_ACCESS_TOKEN` changed. All other protected configuration/runtime values and all existing Page, User and WhatsApp app subscriptions were compared before/after and remained unchanged.
- Same application SHA; service restarted to load the credential; service active and health HTTP 200. Temporary transport key and staged plaintext token were removed; protected rollback/audit evidence remains on the server (coordinates are in the private handoff).

**The restart means the previous postdeploy acceptance runtime bindings need revalidation. CC must not blindly merge/finalize #495 using the old acceptance digest.** No full acceptance, real lead fetch, test creation, callback simulation, CRM query or E2E retest was performed during this token-only operation; those are left to CC.

Historical diagnosis: the previous Page token expired at 02:00 Asia/Dubai and produced `190/463`. This was the **lead-retrieval access token**, not the webhook Verify token or App Secret. The prior verification GET succeeded; neither Verify token nor App Secret was replaced, and no subscription was resaved.

## Checklist against the proposed Customize use case procedure

| Step | Live finding | Completion boundary |
| --- | --- | --- |
| 0. Prepare the server | Service active, health HTTP 200; enabled flag/Verify token/App Secret/allowlist unchanged; running Page token replaced and verified valid with no fixed expiration | Token configuration fixed; protected acceptance must be revalidated after the restart |
| 1. Save Page callback | App subscriptions API reports Page active with the correct callback; Page UI shows saved URL; internal challenge GET succeeds; client certificate switch is OFF | Done; no reason to redo Verify and save |
| 2. Subscribe leadgen | App Page fields contain only `leadgen`, version `v26.0`; UI shows Subscribed | Done; User and WhatsApp subscriptions must not be edited |
| 3. Publish application | UI still says Unpublished; Publish disabled; review is in progress for existing WhatsApp/public_profile requests; Publish page lists App Review and Access verification requirements | NOT done. The exact relation to Pending test delivery is not proven |
| 4. Page subscription and E2E | Fresh Page `subscribed_apps` readback with the running long-lived token succeeds. Last official tracker observation before the rotation was Pending / Lead publish in progress | Page attachment freshly verified; real webhook E2E has NOT been retested or passed |

The official test tool also says “This app has no issues.” That diagnostic is not a successful webhook delivery receipt.

## Actual test evidence and data isolation

- A dedicated, unused test form was registered for permanent isolation before a single official Meta test lead was created. It was not attached to an advertisement.
- Use the exact existing Page/form/batch/lead identifiers from the private handoff. Do not create a new form or repeatedly delete/recreate the provider test.
- Test created at `2026-10-26T21:37:00Z`.
- A separate exact-test Graph → shared-storage probe at `21:43:45Z` produced one receipt with `origin=backfill`; repeating that probe returned isolated again and did not duplicate the receipt.
- Last database check **before the token rotation**, at approximately 02:18 Asia/Dubai, found **one backfill receipt, zero webhook receipts** for this test. The backfill receipt has `graph_fetched=true`.
- At that same pre-rotation check, exact-test counts were **0 in `leads` and 0 in `meta_crm_stage_events`**. CC must refresh them; no post-rotation CRM query was run here.
- Narrow ingress inspection found no callback POST after this test was created. Application processed-webhook logs since creation were empty. Do not attribute an older POST 200 to this test.
- Nginx timestamps use `+0800`; correlate them with UTC explicitly. Strip query strings and IPs before reporting logs; verification query strings may contain secrets.

Because the user explicitly required no mixing with real customers, the correct test acceptance is one isolated **webhook-origin** receipt with zero formal customer/conversion entries. “A test customer appears once in the real CRM customer list” is NOT the acceptance target for this dedicated isolated test.

## Next operator actions, in priority order

1. Read repository `AGENTS.md` and the current taskboard. Recheck production release and current GitHub state before taking over; another operator may have continued since this snapshot.
2. Token replacement is complete: do not generate or rotate it again without evidence. The private server audit records valid Page identity, expiry metadata, unchanged unrelated configuration/subscriptions, health and runtime readback. Recheck read-only if needed, and account for the data-access authorization deadline separately.
3. Use the protected coordinator to reconcile the credential-triggered restart and revalidate production acceptance. Do not alter immutable evidence or reuse the old digest blindly. Fetch the exact existing test lead and continue the user-assigned retest; preserve existing subscriptions and isolation.
4. Investigate genuine provider delivery using the official tracker, sanitized ingress and exact isolated receipt. The token expiry blocker is now fixed; it was **not proven to be the cause of the earlier Pending tracker state or the absence of ingress**. Do not conflate the two.
5. Inspect publication/review requirements without disturbing the existing WhatsApp review. Publishing, review withdrawal/resubmission or new security-sensitive grants need the appropriate user authorization and actual prerequisite checks. Do not assume publishing cannot affect the shared app.
6. Accept E2E only after a real provider callback produces an exact-test `origin=webhook`, `graph_fetched=true` receipt and the two formal table counts remain zero. Never manufacture a signed callback/receipt and label it Meta delivery.
7. After evidence is captured and cleanup is authorized, clean only this provider test and exact isolated receipts; retain permanent test-form registration. Do not roll back to code without test isolation while this provider test or delayed deliveries can still arrive.

## Deployed code and release closure

The production application release is:

```text
547f7cdda82b6693ddfe5e8862e3b2b1c3a6ea8c
candidate CI: 40403859500 — success
recorded PRE-ROTATION release status: acceptance_verified
recorded PRE-ROTATION acceptance journal: ready
PRE-ROTATION acceptance digest (not reusable without revalidation):
cb4e6ae6d0a53e84490b853cdaaa7dc93f5d3792cea9cced44e88474b76474b8
```

Standard protected production acceptance and attestation completed before token replacement. Temporary acceptance fixtures were cleaned with zero residue and KPI restoration verified. **That evidence predates the service restart and is not fresh acceptance of the current runtime; it also never proved Meta E2E.** No database migration/RLS changes were applied for the isolation implementation or the token replacement.

Relevant changes:

- [PR #492](https://github.com/69755354/newme-platform/pull/492): original lead intake; its earlier release was rolled back through the protected coordinator after a runtime/acceptance-baseline issue.
- [PR #493](https://github.com/69755354/newme-platform/pull/493): permanent dedicated-form test isolation shared by webhook and backfill, with explicit receipt origins and idempotency.
- [PR #494](https://github.com/69755354/newme-platform/pull/494): only the unassigned-lead-ratio gate became a visible persisted business warning, with user authorization. Other technical/security/integrity gates remain hard failures; customer assignments were not modified to pass the gate. Merged as the current production SHA above.
- [PR #495](https://github.com/69755354/newme-platform/pull/495): TASKBOARD-only technical acceptance closure. **Still OPEN at the latest GitHub check.** Branch head `f6cf81fe921230c6c04e5f25ece40968a17a9ed7`; base is the deployed SHA.
- [PR CI 40408331052](https://github.com/69755354/newme-platform/actions/runs/40408331052): success. Dispatch-only final-release checks are not evidence of final completion when skipped on a PR.
- A prematurely dispatched final run `40408250776` was cancelled and is **not valid final evidence**.

### Finalization is on hold until CC revalidates the changed runtime

1. Handle the runtime change through the protected acceptance workflow, obtain fresh valid canonical attestation, and update the pending closure PR's taskboard evidence/digest as required by repository rules. The previous #495 CI success does not prove its old acceptance digest remains valid after restart. Do not merge/finalize the stale closure as-is.
2. Recheck required checks and unchanged release ancestry, then merge through the protected PR flow. Use the **actual merged closure SHA**, not the pre-squash branch SHA. Verify it is the deployed release's single direct child, only changes TASKBOARD.md and carries the newly validated acceptance marker.
3. Dispatch and wait for the correct final workflow:

```sh
# Assign CLOSURE_SHA from the actual successful merge and ACCEPTANCE_DIGEST
# from the freshly validated canonical attestation. Do not reuse stale values.
gh workflow run ci.yml --repo 69755354/newme-platform --ref main \
  -f release_final=true \
  -f release_sha=547f7cdda82b6693ddfe5e8862e3b2b1c3a6ea8c \
  -f closure_sha="$CLOSURE_SHA" \
  -f acceptance_digest="$ACCEPTANCE_DIGEST"
```

4. Verify the exact workflow head/inputs and successful **Release-final taskboard completion**, then use the protected `newme-deploy finalize` command with the application SHA, accepted digest, actual closure SHA and successful final run ID. Re-read complete/healthy status afterward.
5. Do not deploy the closure SHA as the application, modify immutable acceptance evidence, or ignore a runtime-change invalidation. If credential work changes runtime, reconcile that through the coordinator before finalizing.

**This handoff document is on a separate documentation branch, not main. Do not merge it or another unrelated commit ahead of #495: that can break the required closure ancestry.** Reading a branch file requires no merge.

## Source entry points for the next operator

```text
src/app/api/meta/leadgen-webhook/route.ts
src/lib/meta-lead-ads.mjs
src/lib/meta-lead-test-isolation.mjs
scripts/meta-lead-test-control.mjs
scripts/meta-leads-pull.mjs
tests/security/meta-lead-ads.test.mjs
docs/meta-lead-ads-intake.md
scripts/crm-regression.py
tests/sam39-regression-harness.test.mjs
```

Isolation registry and receipts use existing `audit_logs`, actions `META_LEADGEN_TEST_FORM_REGISTERED` / `META_LEADGEN_TEST_RECEIVED`, target type `meta_leadgen_test`. The protected operator CLI supports `status`, `register`, `cleanup`; status is read-only, mutation requires explicit flags. Read it before use. It must retain permanent form registration after receipt cleanup. Receipt payloads are identifier-only, not contact answers.

The token-only operation changed one protected environment key and restarted the same release under the production coordinator lock, after checking no pending production transactions or acceptance fixtures. No WhatsApp/User configuration, application publication, test creation/deletion, permission expansion, PR merge, release finalization or E2E retest was performed. Retesting and fresh acceptance are explicitly assigned to CC.
