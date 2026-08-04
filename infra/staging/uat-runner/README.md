# Staging UAT runner

This directory builds the isolated runtime for the versioned SAM-26 role,
SAM-23 commercial-core, SAM-70 XLSX abuse, and final Product/SaaS runners
without adding Playwright, Chromium, SheetJS, or runner-only dependencies to
the Next.js standalone release.

The staging-only build service must create a fresh temporary Docker build
context containing exactly these nine files from the exact checked-out SHA:

- `infra/staging/uat-runner/Dockerfile`
- `infra/staging/uat-runner/package.json`
- `infra/staging/uat-runner/package-lock.json`
- `infra/staging/uat-runner/run.sh`
- `scripts/verify-staging-sam26-roles.mjs`
- `scripts/verify-staging-sam70-xlsx.mjs`
- `scripts/uat/sam23-organization-commercial-core.mjs`
- `scripts/uat/product-saas-final.mjs`
- `scripts/uat/sam78-staging-tenant-closure.mjs`

It then builds:

```bash
docker build --tag "newme-staging-uat:${SHA}" -f Dockerfile <temporary-context>
```

The repository-owned `/usr/local/sbin/newme-staging-control` accepts exactly one
of these actions plus one full 40-character SHA:

- `build <SHA>` starts the fixed staging build unit and builds this image from
  the eight exact blobs at the canonical staging SHA.
- `deploy <SHA>` starts the fixed staging deploy unit and atomically records the
  direct immutable predecessor in root-only state.
- `uat <SHA>` runs that exact image with only the staging environment file and
  injects `SAM26_EXPECTED_RELEASE_SHA=<SHA>`.
- `uat-sam20 <SHA>` runs the fixed SAM-20 runner blob from the same current
  release SHA, passes its local read-only manifest path, and accepts only
  verified zero counts for all eight fixture classes.
- `reconcile-sam21 <SHA>` runs the exact repository-owned read-only SQL against
  the fixed staging database host using the root-only
  `/etc/newme-staging/sam21-db.pgpass`. Call it once before and once after the
  separately approved SAM-20/SAM-22 migration window. It never applies or
  repairs migrations and refuses to overwrite either immutable snapshot.
- `uat-sam21 <SHA>` accepts only the exact pre/post reconciliation pair for the
  current release: aggregate metrics, owners, history and document digests
  must be preserved; every existing Lead and funnel snapshot must belong to
  the legacy organization; active memberships must match active profiles; and
  both exact migration-history rows and versioned rollback assets must be
  present. The production reconciliation remains explicitly unexecuted and
  read-only-ready.
- `uat-sam22 <SHA>` runs the fixed two-organization runner blob from the same
  current release SHA. It accepts only complete list/search/detail/export,
  import, webhook, cron, Dashboard and member-admin isolation evidence plus
  verified zero residue for every synthetic fixture class.
- `uat-sam23 <SHA>` runs the image-contained commercial-core runner against
  staging loopback only. It requires the exact release manifest, deterministic
  initialization and seats, two-organization commercial isolation, exact
  ID cleanup, marker/idempotency residue counts of zero, and atomically retains
  only the credential-free JSON evidence as root-only `0600` state.
- `uat-sam27 <SHA>` runs the exact SAM-27 runner and integration-execution
  library blobs from the same current release SHA. It accepts only minimal
  health, explicitly disabled staging Meta routes, bounded synthetic retry,
  final-failure alert and audit evidence, and explicit N/A cleanup. It contacts
  loopback only and never calls the production Meta callback.
- `uat-sam54 <SHA>` drives the exact versioned alert state machine across its
  threshold, requires that transition to invoke the SHA-bound read-only
  diagnostic automatically, and stores only the validated, bounded result in
  root-only controller state.
- `uat-sam52 <SHA>` runs the fixed SAM-52 synthetic alert-bridge contract from
  the same current release SHA. It verifies raw-body HMAC, strict schema,
  replay deduplication, bounded retry and redacted audit evidence without
  contacting Sentry, Hermes or a chat provider. Its evidence remains explicit
  NO-GO until the named external owners and credentials are authorized.
- `uat-sam68 <SHA>` runs the fixed SAM-68 observability runner blob from the
  same current release SHA. It accepts only a retired monitoring endpoint with
  no hostile-body persistence, authenticated readiness within three seconds,
  zero journald findings, staging-disabled Sentry, and explicit N/A cleanup.
- `uat-sam70 <SHA>` runs the exact image with the staging environment and
  read-only release manifest. It accepts only exact IDs/batches, the unique
  marker, all required abuse/ownership cases, and zero marker-scoped cleanup
  residue.
- `uat-product-saas <SHA>` runs the exact final Product/SaaS runner from the
  same image and read-only manifest. It accepts only passing SAM-11, SAM-13,
  SAM-25, SAM-35, SAM-49, SAM-61, and commercial customer-exit evidence.
  The customer-exit result must prove deterministic export, read-only freeze,
  two-person closure, access revocation, retained data, idempotent completion,
  and exact cleanup. SAM-25 must contain the exact
  Lead → Quotation → Contract → Payment → Project links, six zero-write
  negative cases, and zero residue for every declared cleanup class. The
  validated, credential-free JSON operation record is atomically retained as
  root-only `0600` state at `last-uat-product-saas.json`.
- `uat-sam78 <SHA>` runs the exact SAM-78 tenant-closure runner. It first
  requires the complete Product/SaaS lifecycle and cleanup result, then proves
  one identity with two active memberships can switch selected organizations
  without list, search, direct-ID or organization-row leakage. Only exact
  fixture IDs are deleted; both fixture organizations, memberships, leads and
  audit residue must be zero. The credential-free result is retained as
  root-only `0600` state at `last-uat-sam78.json`.
- `migrate-sam78 <SHA>` applies exactly migrations `20260803100000`,
  `20260803143000`, and `20260804153000` to the fixed staging project with the schema owner
  `postgres.bfsiibofuzoglziltgyd`. Before opening a database connection it
  verifies the SHA-bound build artifact checksum, root-only `0600` pgpass and
  Supabase CA, a root-only explicit platform-staff role mapping, and commit
  blobs for all three migrations, all three rollbacks, the live
  verifier, and the complete canonical migration-history manifest. It strips
  only each file's outer transaction boundary and applies all three migrations plus
  their exact `version`, `name`, and parsed `statements` rows in one bounded
  transaction. A nonblocking advisory lock, migration-history table lock,
  exact predecessor history, schema prestate, or live FK/RLS/ACL/backfill
  mismatch fails closed. Production and the SAM-21 read-only credential are
  never accepted.
- `rollback-sam78-db <SHA>` requires the exact applied history and live
  rollback prestate, executes both versioned rollback files in reverse order,
  removes their history rows, and verifies the exact canonical predecessor,
  restored policies/ACL, removed managed objects, preserved legacy rows, and
  disabled rollback FORCE RLS in the same bounded transaction. It never
  performs an application rollback and never guesses a partial database state.

Before the separately approved `migrate-sam78` window, an operator must install
three root-owned regular files with mode `0600`: the fixed staging-owner pgpass
at `/etc/newme-staging/staging-migration.pgpass`, the Supabase root certificate
at `/etc/newme-staging/supabase-root-2021-ca.crt`, and an approved JSON object
keyed by immutable `platform_staff.id` at
`/etc/newme-staging/sam78-platform-staff-role-mapping.json`. Mapping values are
limited to `platform_owner`, `platform_ops`, `platform_support`, or
`platform_auditor`; unresolved live rows abort the migration. The controller
records only the mapping checksum, never its contents.

- `rollback <oldSHA>` accepts only the recorded direct predecessor. It refuses
  an application-only rollback when the new release contains the SAM-20
  database contract and the predecessor does not; it never changes database
  migrations or policies.

Every action shares one lock, verifies the canonical branch and installed
controller blob, and rejects extra arguments. The canonical branch is the fixed
`agent/saas-staging-isolation` value and cannot be changed by environment.
Before an otherwise incompatible SAM-20 rollback, the controller uses only the
fixed staging Data API URL and service key to prove that all SAM-20 tables, the
context function, and `leads.organization_id` are absent. Success, network
failure, or an unknown PostgREST error keeps rollback denied. UAT and
compatibility probes never print captured output or mount production paths,
production environment files, source worktrees, or the Docker socket.

Use `--rm --init --ipc=host --read-only` plus writable tmpfs mounts for `/tmp` and `/runner/home`. The runner image is disposable: a failed build or failed UAT must not replace the live staging release.

The image tag, `package.json`, and lockfile deliberately pin Playwright
`1.60.0` together. Supabase JS is pinned to `2.106.2`, matching the application
lockfile version used by the SAM-23 and final Product/SaaS runners. SheetJS is
pinned to the same immutable `xlsx-0.20.2.tgz` URL and integrity used by the
application lockfile.
