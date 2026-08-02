# Staging commercial SaaS evidence — 2026-08-02

This record is evidence for the staging release only. It is not a production
release approval and does not claim that production was changed.

## Release binding

- Repository: `69755354/newme-platform`
- Canonical branch: `agent/saas-staging-isolation`
- Release and merge SHA: `784a0c888e8a8f6ac78301a756187375cff40aa8`
- Customer-export fix PR: <https://github.com/69755354/newme-platform/pull/250>
- PR head: `f3355b012d730782bb3ae28295fab4c1997b72b7`
- Same-head CI run: <https://github.com/69755354/newme-platform/actions/runs/30724136464>
- CI result: `completed/success`; the SAM-23 disposable PostgreSQL gate,
  database-type gate, TypeScript, repository tests, supply-chain gate and
  release-hygiene gate all succeeded.
- Staging artifact SHA-256:
  `9459cfb198b3aea436a9d96cf944e95bc12a7d45be4f8e563cb87d2b9bb6d207`
- UAT image revision label: exact release SHA.
- Deployed predecessor: `cde3fe9b066c23258407a30575b998cf80a25a1c`.
- `/opt/newme-staging/current`, its manifest, and the root-only deployment
  state all identify the exact release SHA. The deployment state is mode 0600
  and records `status=deployed`.

## Staging database binding

- Project ref: `bfsiibofuzoglziltgyd`.
- Migration version: `20260802074500`.
- Migration name: `fix_customer_export_notification_uuid`.
- Migration history statement count: 1.
- `notifications.related_id` is `uuid`.
- `organization_customer_snapshot(uuid)` contains zero legacy text/UUID
  comparisons and six UUID/UUID comparisons.
- Function owner remains `postgres`; ACL remains
  `{postgres=X/postgres,service_role=X/postgres}`; search path remains
  `pg_catalog, public, pg_temp`.
- The same-head SAM-23 disposable PostgreSQL gate performed a logical task
  backup, restored it into a separate database, verified the overdue-row and
  constraint contract, and removed the backup fixture. The successful CI step
  therefore supplies an executed backup/restore rehearsal without using
  production data.

## Dynamic staging results

All commands below were bound to the exact release SHA.

| Gate | Result | Cleanup boundary |
| --- | --- | --- |
| Six-role baseline (`uat`) | pass | runner cleanup passed |
| SAM-20 organization isolation | pass | `cleanup=verified` |
| SAM-21 current-schema reconciliation | post snapshot captured | read-only; see limitation below |
| SAM-22 two-organization isolation | pass | `cleanup=verified` |
| SAM-23 customer readiness | pass | `cleanup=verified` |
| SAM-27 retry/alert behavior | pass | `cleanup=not_applicable`, meta disabled |
| SAM-52 Sentry/Hermes boundary | pass | external integration blocked by staging contract; cleanup not applicable |
| SAM-54 alert-state diagnostics | pass | read-only; cleanup not applicable |
| SAM-70 XLSX abuse/import/export | pass | `cleanup=verified` |
| SAM-68 observability | pass | Sentry not applicable in staging; cleanup not applicable |
| Product/SaaS final | pass | `cleanup=verified`; all 23 tracked counts are zero |

The Product/SaaS report has `ok=true`, health 200, and run id
`f8b8d255-bf1a-47f0-a69d-bb9f121e5cf3`. Its result groups SAM-11, SAM-13,
SAM-25, SAM-35, SAM-49, SAM-61 and CUSTOMER-EXIT all have `status=pass`.
CUSTOMER-EXIT proved a deterministic export digest, organization closure,
zero active memberships, revoked support access, retained business data,
idempotent completion, and `data_deleted=false`.

The Product/SaaS cleanup verified zero residue in auth users, profiles,
organizations, memberships, support sessions, exit requests, platform staff,
membership roles, leads, audit logs, activity logs, activities, audit events,
daily sessions, quotations, contracts, payments, projects, installment plans,
contract approvals, payment allocations, pipeline notifications and all
lead-child tables.

## Evidence digests

All listed files are root-owned, mode 0600 on the staging host.

| Evidence | SHA-256 |
| --- | --- |
| `last-uat-product-saas.json` | `befa4d9dccd87f978774d960c6bb99514dff6ff28eee119a22d2f26db5a3487f` |
| `last-uat-sam23.json` | `b063cf4f27ea23619f2a72e37500dee177a1d6bc080e16a69be82c6a160115f5` |
| `last-uat-sam27.json` | `799400345fa54c0f56b3fca094c6e3cabd6f5834d5ac850d0adbada2a882513f` |
| `last-uat-sam52.json` | `f3dd6ea0588cda88c3453754fc0d65247de51e62a7809253889c182b3f82236a` |
| `last-uat-sam54.json` | `3ef47779c8d38499679124c5acac93650454f106e3e84174aa0e0268996ba38b` |
| `last-uat-sam68.json` | `a87fe5bd82fe29c20b0d27f679de1f565bcd9062e743e3141f383af606fa6cc3` |
| SAM-21 post snapshot | `5ddadeb9a59884f0bf5769a0248bb0bf0258779848743523377184bd73b254ba` |

## Explicit limitation

The live SAM-21 pre/post migration rehearsal cannot be recreated after the
shared staging database has already crossed the organization migrations: the
controller requires both snapshots to be captured under the same release SHA,
and no valid pre-migration snapshot exists for this SHA. A current read-only
post snapshot was captured after restoring the expired, least-privilege
`newme_staging_backup` credential. The role remains limited to
`pg_read_all_data`, connection limit 2, and expires at
`2026-08-03 12:00:00+00`. Disposable PostgreSQL migration and rollback gates
passed in CI; this is not represented as a live pre/post rehearsal.

## Operational state and rollback

- Staging health: `ok` after deployment and UAT.
- Production health was read only and remained `ok`; production release label
  remained `YD7pCg9kXDHSVb1nW_OEf`.
- No production deployment, database write, secret action or DNS action was
  performed.
- Application rollback is the direct immutable predecessor
  `cde3fe9b066c23258407a30575b998cf80a25a1c`.
- The customer-export database rollback is versioned and refuses environments
  other than staging or test.
- A later cleanup preflight proved the controller lock was free, no Docker
  containers existed, and the current release was still `784a0c88...`.
  Fourteen exact unused `newme-staging-uat` image tags were removed; the
  current `784a0c88...` image, direct predecessor `cde3fe9b...`, Playwright
  base image, immutable releases, and all evidence files were preserved.
  Dangling-image and builder-cache pruning completed. Production and staging
  health both remained `ok`.
- The integer filesystem display remained 46 GiB used of 59 GiB (81%); the
  displayed available space changed from 11 GiB to 12 GiB. Most reported image
  size was shared with the two preserved UAT images, so deleting tags did not
  produce the originally estimated multi-gigabyte reduction. No broader
  release or user-data deletion was performed.
