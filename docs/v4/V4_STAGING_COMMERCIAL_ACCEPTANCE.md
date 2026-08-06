# V4 staging commercial acceptance record

Status: **accepted for the bounded V4 staging commercial slice**. This record
does not authorize production use, a production database action, or a
production deployment.

## Release binding

| Field | Verified value |
| --- | --- |
| Staging project ref | `bfsiibofuzoglziltgyd` |
| Current staging release | `a673bd1f3103e9cde6693daa12aa87a0ec0def38` |
| Direct application rollback release | `39a6ab228e15f18e99b116674d567dc186becada` |
| Release manifest | `git_sha=a673bd1f3103e9cde6693daa12aa87a0ec0def38` |
| Release health | `/api/health` returned `200` / `status=ok` |
| Protected production read-only health check | `127.0.0.1:3001/api/health` returned `status=ok` |

The release was built, checksum-verified and deployed through the staging
controller. No production application, production database, production secret
or production deployment action was performed.

## Migration evidence

The controlled `migrate-sam78` evidence for staging reports all 25 versioned
V4 migrations as `alreadyAppliedVersions`, `appliedVersions=[]` and
`history=verified`. The final release has no `supabase/migrations` or
`supabase/rollback` diff from that verified migration baseline, so no database
write was repeated for the final runner-only cleanup fix.

## CI and UAT evidence

The cleanup correction was merged by PR #376. Its exact pre-merge head
`77abe85d55d305acceacf254e7daa598c57d7b50` passed GitHub Actions run
`31102534969` (`Repository validation`), including database gates, typecheck,
repository tests and release hygiene. The merge commit is the deployed
canonical `a673bd1f3103e9cde6693daa12aa87a0ec0def38`.

The controller-run `uat-v4` report for the deployed release has `ok=true`,
`health=200`, and `cleanup.status=verified`. The report records the following
bounded staging outcomes:

| Scenario | Verified outcome |
| --- | --- |
| SAM-80 | tenant isolation and independent approval verified; report job queued |
| SAM-81 | listing publish-readiness verified; external publish remained disabled |
| SAM-82 | topology, SKU resolution, inventory ledger, pricing and RLS/ACL verified |
| SAM-83 | accepted order, procurement receipt, fulfilled delivery, reconciled finance and idempotent receipt verified |
| SAM-84 | L0/L1/L2=`200`, L3=`202`, L4=`403`; adapters disabled and route idempotency exercised |
| SAM-86 | health/readiness=`200`, release SHA matched, readiness latency=`58ms` |

All UAT-generated organizations, identities, memberships, shared-operation
records, real-estate records, retail records and finance records were removed
by exact generated IDs. The report records zero residue for every tracked
fixture collection. It neither truncates tables nor performs marker-wide or
tenant-wide deletion.

## Capacity and rollback record

Before final UAT, controller preflight required at least 15 GiB available and
at most 75% disk use. After final UAT and targeted retention cleanup, staging
had `16,616,800,256` bytes available at `73%` use. The cleanup retained only
the current and direct rollback releases, retained their SHA-bound UAT images,
and removed only individually verified non-current/non-previous releases and
zero-container-reference UAT image tags. Each removed release/image is
recoverable from its exact Git commit via the staging controller build action.

Root-only operational evidence is retained outside the repository at the
staging controller's acceptance, deployment and capacity records. It contains
no production credentials and this document intentionally contains no secret
material.
