# V4 staging commercial acceptance record

Status: **accepted for the bounded V4 staging commercial slice**. This record
does not authorize production use, a production database action, or a
production deployment.

## Release binding

| Field | Verified value |
| --- | --- |
| Staging project ref | `bfsiibofuzoglziltgyd` |
| Current staging release | `683e841e7b5c684b5cebdb05dbc17b7ae35c6929` |
| Direct application rollback release | `a673bd1f3103e9cde6693daa12aa87a0ec0def38` |
| Release manifest | `git_sha=683e841e7b5c684b5cebdb05dbc17b7ae35c6929` |
| Release health | `/api/health` returned `200` / `status=ok` |
| Protected production read-only health check | `127.0.0.1:3001/api/health` returned `status=ok` |

The release was built, checksum-verified and deployed through the staging
controller. No production application, production database, production secret
or production deployment action was performed.

## Migration evidence

The controlled `migrate-sam78` evidence for staging reports all 25 versioned
V4 migrations as `alreadyAppliedVersions`, `appliedVersions=[]` and
`history=verified`. The current release has no `supabase/migrations` or
`supabase/rollback` diff from that verified migration baseline, so no database
write was repeated for its UAT evidence-index-only release change.

## CI and UAT evidence

The cleanup correction was merged by PR #376. Its exact pre-merge head
`77abe85d55d305acceacf254e7daa598c57d7b50` passed GitHub Actions run
`31102534969` (`Repository validation`), including database gates, typecheck,
repository tests and release hygiene. PR #378 then recorded the immutable audit
index; its exact pre-merge head `a3d81fc85ee471f5cdf32c311f9628a8c32ffed5`
passed rerun attempt 2 of GitHub Actions run `31105064081`. Its merge commit,
`683e841e7b5c684b5cebdb05dbc17b7ae35c6929`, is the currently deployed staging
release.

The controller-run `uat-v4` report for the deployed release has `ok=true`,
`health=200`, and `cleanup.status=verified`. The report records the following
bounded staging outcomes:

| Scenario | Verified outcome |
| --- | --- |
| SAM-79 | plan/lifecycle, paid-seat limit, entitlements/usage, manual invoice reference and independent approval verified |
| SAM-80 | tenant isolation and independent approval verified; report job queued |
| SAM-81 | listing publish-readiness verified; external publish remained disabled |
| SAM-82 | topology, SKU resolution, inventory ledger, pricing and RLS/ACL verified |
| SAM-83 | accepted order, procurement receipt, fulfilled delivery, reconciled finance and idempotent receipt verified |
| SAM-84 | L0/L1/L2=`200`, L3=`202`, L4=`403`; adapters disabled and route idempotency exercised |
| SAM-86 | health/readiness=`200`, release SHA matched, readiness latency=`58ms` |

The current release passed two separate SHA-bound controller UAT reports:
`product-saas-final` (SAM-11/13/25/35/49/61/79 and customer exit) and
`v4-staging-acceptance` (SAM-80/81/82/83/84/86). Both reported `ok=true`,
HTTP 200 and `cleanup=verified`. All UAT-generated organizations, identities,
memberships, commercial, shared-operation, real-estate, retail and finance
records were removed by exact generated IDs. Both reports record zero residue
for every tracked fixture collection. Neither truncates tables nor performs
marker-wide or tenant-wide deletion.

## Capacity and rollback record

Before each build, deploy and UAT, controller preflight required at least 15
GiB available and at most 75% disk use. After the current product and V4 UAT
reports, staging had `16,393,138,176` bytes available at `73%` use. The
targeted retention cleanup retained the current and direct rollback releases,
retained their SHA-bound UAT images, and removed only individually verified
non-current/non-previous releases and zero-container-reference UAT image tags.
Each removed release/image is recoverable from its exact Git commit via the
staging controller build action.

Root-only operational evidence is retained outside the repository at the
staging controller's acceptance, deployment and capacity records. It contains
no production credentials and this document intentionally contains no secret
material.
