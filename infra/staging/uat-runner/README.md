# Staging UAT runner

This directory builds the isolated runtime for the versioned SAM-26 role,
SAM-70 XLSX abuse, and final Product/SaaS runners without adding Playwright,
Chromium, SheetJS, or runner-only dependencies to the Next.js standalone
release.

The staging-only build service must create a fresh temporary Docker build
context containing exactly these seven files from the exact checked-out SHA:

- `infra/staging/uat-runner/Dockerfile`
- `infra/staging/uat-runner/package.json`
- `infra/staging/uat-runner/package-lock.json`
- `infra/staging/uat-runner/run.sh`
- `scripts/verify-staging-sam26-roles.mjs`
- `scripts/verify-staging-sam70-xlsx.mjs`
- `scripts/uat/product-saas-final.mjs`

It then builds:

```bash
docker build --tag "newme-staging-uat:${SHA}" -f Dockerfile <temporary-context>
```

The repository-owned `/usr/local/sbin/newme-staging-control` accepts exactly one
of these actions plus one full 40-character SHA:

- `build <SHA>` starts the fixed staging build unit and builds this image from
  the five exact blobs at the canonical staging SHA.
- `deploy <SHA>` starts the fixed staging deploy unit and atomically records the
  direct immutable predecessor in root-only state.
- `uat <SHA>` runs that exact image with only the staging environment file and
  injects `SAM26_EXPECTED_RELEASE_SHA=<SHA>`.
- `uat-sam20 <SHA>` runs the fixed SAM-20 runner blob from the same current
  release SHA, passes its local read-only manifest path, and accepts only
  verified zero counts for all eight fixture classes.
- `uat-sam22 <SHA>` runs the fixed two-organization runner blob from the same
  current release SHA. It accepts only complete list/search/detail/export,
  import, webhook, cron, Dashboard and member-admin isolation evidence plus
  verified zero residue for every synthetic fixture class.
- `uat-sam27 <SHA>` runs the exact SAM-27 runner and integration-execution
  library blobs from the same current release SHA. It accepts only minimal
  health, explicitly disabled staging Meta routes, bounded synthetic retry,
  final-failure alert and audit evidence, and explicit N/A cleanup. It contacts
  loopback only and never calls the production Meta callback.
- `uat-sam54 <SHA>` drives the exact versioned alert state machine across its
  threshold, requires that transition to invoke the SHA-bound read-only
  diagnostic automatically, and stores only the validated, bounded result in
  root-only controller state.
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
  SAM-25, SAM-35, SAM-49, and SAM-61 evidence. SAM-25 must contain the exact
  Lead → Quotation → Contract → Payment → Project links, six zero-write
  negative cases, and zero residue for all eighteen cleanup classes. The
  validated, credential-free JSON operation record is atomically retained as
  root-only `0600` state at `last-uat-product-saas.json`.
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
lockfile version used by the final Product/SaaS runner. SheetJS is pinned to the same immutable
`xlsx-0.20.2.tgz` URL and integrity used by the application lockfile.
