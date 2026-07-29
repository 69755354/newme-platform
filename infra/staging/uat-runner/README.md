# Staging UAT runner

This directory builds the browser runtime for `scripts/verify-staging-sam26-roles.mjs` without adding Playwright or Chromium to the Next.js standalone release.

The staging-only build service must create a fresh temporary Docker build context containing exactly these five files from the exact checked-out SHA:

- `infra/staging/uat-runner/Dockerfile`
- `infra/staging/uat-runner/package.json`
- `infra/staging/uat-runner/package-lock.json`
- `infra/staging/uat-runner/run.sh`
- `scripts/verify-staging-sam26-roles.mjs`

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

The image tag, `package.json`, and lockfile deliberately pin Playwright `1.60.0` together.
